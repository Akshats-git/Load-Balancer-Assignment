'use strict';

// A gzip-encoded /feed, compressed once per message rather than once per read.
//
// /feed returns the whole room, so its response grows for as long as the room
// does. That is what the route is specified to do, and it is also the single
// most expensive thing this deployment moves: measured on 14 September, with
// only 12,000 messages in the room, a /feed response was 3.3 MB and thirty
// concurrent readers got 13 requests a second at a median of 1,985 ms, with
// every container's CPU under 8% and the load balancer's under 45%. Nothing
// was working hard; the bytes were the whole cost.
//
// Compressing them is worth about 5x on this content. The difficulty is that
// compressing the response per request is far more expensive than sending it
// uncompressed: gzip on these containers runs at 73 MB/s at level 1 and
// 16 MB/s at level 6, so one 3.3 MB response costs 45 ms or 207 ms of the one
// core the backend has, and both numbers grow with the room exactly the way
// the problem does.
//
// So the room is compressed incrementally instead, as messages arrive, and
// each message is compressed exactly once no matter how many readers see it.
// One deflate stream is kept open for the life of the room; a message is
// written into it and the stream is flushed to a byte boundary, and what has
// come out so far is the compressed body of every message so far. At level 6
// that costs about 7 microseconds per message, and a read costs nothing but
// writing out bytes that already exist.
//
// The response is a single ordinary gzip member, not several concatenated
// ones. That distinction matters: concatenated members are legal and Go,
// Python, Node and browsers all read them, but curl does not, and a /feed that
// some clients silently mis-read is worse than an uncompressed one. Keeping
// one member means the closing "]" cannot go through the shared deflate stream
// - writing it would end the stream for the next message too. It is carried
// instead in a final uncompressed stored block appended after the compressed
// bytes, which is valid deflate and needs no compression state:
//
//   1f 8b 08 00 00 00 00 00 00 ff   gzip header
//   <deflate bytes so far>          every message, Z_SYNC_FLUSH aligned
//   01 01 00 fe ff 5d               final stored block holding "]"
//   <crc32> <isize>                 gzip trailer, little endian
//
// Verified byte-identical against curl, wget, Go's net/http, Python requests,
// Python urllib and Node's fetch.
//
// The one thing a single append-only stream cannot do is forget its beginning,
// and the store does forget its beginning: past its cap it drops the oldest
// messages. There is no way to take bytes off the front of a deflate stream,
// so that needs a new one built from what is left - which is the whole room,
// and doing it in one go blocks the event loop for about a second.
//
// That second is not merely slow, it is destructive, and it took a run to
// find out how. A blocked event loop stops the backend reading its MongoDB
// change stream, so it falls behind; the reconciler then sees a feed short of
// the database and re-reads the entire room, sixty thousand documents, from a
// database with one core and three backends doing the same thing; those
// documents push the store back over its cap, which trims, which rebuilds,
// which blocks the loop again. Throughput went from 513 requests a second to
// 38, the three backends ended up holding three different rooms, and mongod
// stopped answering. See rebuild() for what replaces it.

const zlib = require('zlib');

const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff]);

// BFINAL=1, BTYPE=00 (stored), LEN=1, NLEN=~1, then "]". A stored block has to
// start on a byte boundary, which is precisely what Z_SYNC_FLUSH leaves the
// stream on.
const CLOSING_BLOCK = Buffer.from([0x01, 0x01, 0x00, 0xfe, 0xff, 0x5d]);
const CLOSING_BYTE = Buffer.from(']', 'utf8');

const GZIP_TRAILER_BYTES = 8;

// Level 6 rather than 1. The cost is paid per message and not per reader, so
// the thing to optimise is the ratio: level 1 gives 3.9x on this content and
// level 6 gives 5.2x, and the difference in compression time is 7 microseconds
// a message against 2.
const DEFAULT_LEVEL = 6;

// Where a generation's output accumulator starts. It doubles from here, so
// this only sets how many growths an empty room needs to reach a full one.
const INITIAL_OUTPUT_BYTES = 64 << 10;

// How many messages a rebuild compresses per turn of the event loop. At level
// 6 and about 300 bytes a message this is roughly five milliseconds of work,
// which is the point: a rebuild is meant to be invisible to everything else
// the process is doing, not fast.
const REBUILD_CHUNK = 256;

// One deflate stream and everything that describes what has gone into it.
//
// There are two of these during a rebuild - the one still answering readers
// and the one being built to replace it - which is the only reason this is a
// class of its own rather than fields on GzipFeed.
class Generation {
  constructor(level) {
    this.stream = zlib.createDeflateRaw({ level });
    this.output = Buffer.allocUnsafe(INITIAL_OUTPUT_BYTES);
    this.compressedBytes = 0;

    this.crc = 0;
    this.plainBytes = 0;
    this.count = 0;

    this.pending = [];
    this.flushing = null;
    this.failed = false;

    this.stream.on('error', () => { this.failed = true; });
    this.stream.on('data', (chunk) => this.collect(chunk));
  }

  // The compressor's output is accumulated into one buffer that grows by
  // doubling, rather than into a list of the chunks it emitted.
  //
  // The list is the obvious shape and it is the wrong one here. Output comes
  // out in whatever pieces deflate happens to produce - a few hundred bytes
  // per flush, so a few hundred bytes per message - and a room of sixty
  // thousand messages would be sixty thousand of them. They would then be
  // sixty thousand separate writes on every single read of /feed, which trades
  // the bandwidth this class saves for a syscall storm. One buffer is one
  // write, and appending to it costs a copy of the new bytes only.
  collect(chunk) {
    const needed = this.compressedBytes + chunk.length;

    if (needed > this.output.length) {
      let size = this.output.length * 2;
      while (size < needed) size *= 2;

      const grown = Buffer.allocUnsafe(size);
      this.output.copy(grown, 0, 0, this.compressedBytes);
      this.output = grown;
    }

    chunk.copy(this.output, this.compressedBytes);
    this.compressedBytes += chunk.length;
  }

  // Queued as bytes rather than written straight into the stream, so that a
  // burst of arrivals is compressed as one chunk instead of one call each.
  append(text) {
    const buffer = Buffer.from(text, 'utf8');

    this.pending.push(buffer);
    this.crc = zlib.crc32(buffer, this.crc);
    this.plainBytes += buffer.length;
    this.count += 1;
  }

  // Pushes everything appended since the last flush through the compressor and
  // resolves once its output has been emitted.
  //
  // Serialised on a single promise because the deflate stream is one piece of
  // shared state and two concurrent readers must not interleave writes into
  // it. A reader that arrives during someone else's flush waits for it and
  // then checks again, which is also how it picks up messages that arrived
  // while it was waiting.
  async flush() {
    while (!this.failed && (this.pending.length > 0 || this.flushing)) {
      if (this.flushing) {
        await this.flushing;
        continue;
      }

      const chunk = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
      this.pending = [];

      this.flushing = new Promise((resolve) => {
        this.stream.write(chunk);
        this.stream.flush(zlib.constants.Z_SYNC_FLUSH, resolve);
      });

      try {
        await this.flushing;
      } finally {
        this.flushing = null;
      }
    }
  }

  // The chunks to write and their total length.
  //
  // The compressed bytes are handed back as a view of the accumulator rather
  // than a copy, for the same reason the uncompressed path hands back a prefix
  // and a tail: copying them would copy the whole room per reader, which is
  // the cost this class exists to avoid. They are only ever appended to, so a
  // view taken now stays valid while this response is written - and a growth
  // replaces the buffer rather than mutating it, so the old view survives that
  // too.
  body() {
    const trailer = Buffer.alloc(GZIP_TRAILER_BYTES);

    // The "]" is part of the content even though it is carried uncompressed,
    // so it counts in both the checksum and the length.
    trailer.writeUInt32LE(zlib.crc32(CLOSING_BYTE, this.crc) >>> 0, 0);
    trailer.writeUInt32LE((this.plainBytes + CLOSING_BYTE.length) >>> 0, 4);

    const chunks = [
      GZIP_HEADER,
      this.output.subarray(0, this.compressedBytes),
      CLOSING_BLOCK,
      trailer,
    ];

    return {
      chunks,
      length:
        GZIP_HEADER.length + this.compressedBytes + CLOSING_BLOCK.length + GZIP_TRAILER_BYTES,
    };
  }

  destroy() {
    if (!this.stream) return;
    this.stream.removeAllListeners('data');
    this.stream.removeAllListeners('error');
    this.stream.destroy();
    this.stream = null;
    this.output = null;
  }
}

class GzipFeed {
  constructor({ level = DEFAULT_LEVEL, chunkSize = REBUILD_CHUNK } = {}) {
    this.level = level;
    this.chunkSize = chunkSize;
    this.enabled = true;
    this.rebuilds = 0;

    this.live = new Generation(level);

    // Set only while a replacement is being built. See rebuild().
    this.building = null;
    this.carry = null;
    this.snapshot = null;
    this.cursor = 0;
  }

  get count() {
    return this.live.count;
  }

  append(text) {
    if (!this.enabled) return;

    this.live.append(text);

    // A rebuild is compressing a snapshot taken before this message existed,
    // so the message is held here and written into the replacement once that
    // snapshot has been consumed. Without this the replacement would be
    // missing everything that arrived while it was being built.
    if (this.carry !== null) this.carry.push(text);

    if (this.live.failed) this.disable('the compressor reported an error');
  }

  /**
   * Replaces the stream with one built from `texts`, a few hundred messages
   * per turn of the event loop, while the stream it replaces goes on answering
   * readers.
   *
   * Called when the store drops its oldest messages, which a deflate stream
   * cannot represent - there is no taking bytes off the front of one.
   *
   * What readers see during the rebuild is the old stream, which holds every
   * message the store still has plus the ones it has just dropped. That is a
   * longer feed than the store would give, never a shorter one: every message
   * in it was really sent and is really in the database, and no message is
   * missing or repeated. Trading a few thousand messages of extra history for
   * a second of blocked event loop is the whole point, because that second is
   * what took the deployment down.
   *
   * @param {string[]} texts every retained entry, separator included, in order
   */
  rebuild(texts) {
    if (!this.enabled) return;

    // A rebuild already running is abandoned rather than queued: its snapshot
    // describes a room that has since been trimmed again, so finishing it
    // would only produce something that needs replacing.
    if (this.building) {
      this.building.destroy();
      this.building = null;
    }

    this.rebuilds += 1;

    this.building = new Generation(this.level);
    this.snapshot = texts;
    this.cursor = 0;
    this.carry = [];

    setImmediate(() => this.step());
  }

  step() {
    if (!this.enabled || this.building === null) return;

    const end = Math.min(this.cursor + this.chunkSize, this.snapshot.length);
    for (let i = this.cursor; i < end; i += 1) this.building.append(this.snapshot[i]);
    this.cursor = end;

    if (this.building.failed) {
      this.disable('the replacement compressor reported an error');
      return;
    }

    if (this.cursor < this.snapshot.length) {
      setImmediate(() => this.step());
      return;
    }

    // The snapshot is compressed. Everything that arrived while it was being
    // compressed goes in behind it, and then the replacement is the live one.
    for (const text of this.carry) this.building.append(text);

    const replaced = this.live;

    this.live = this.building;
    this.building = null;
    this.snapshot = null;
    this.carry = null;
    this.cursor = 0;

    replaced.destroy();
  }

  disable(reason) {
    // A compressor that has failed is not worth limping along with: /feed is
    // still correct without it, only larger.
    console.error(`gzip feed disabled, sending /feed uncompressed: ${reason}`);
    this.enabled = false;

    if (this.building) this.building.destroy();
    this.building = null;
    this.snapshot = null;
    this.carry = null;
  }

  /**
   * The gzip body for the room as this compressor holds it. Null once the
   * compressor has been turned off, in which case the caller sends the
   * uncompressed body instead.
   */
  async body() {
    if (!this.enabled) return null;

    const generation = this.live;
    await generation.flush();

    if (generation.failed) {
      this.disable('the compressor failed while flushing');
      return null;
    }

    // A rebuild that finished during the flush swapped the generation under
    // us. The one flushed above is still complete and consistent - it is only
    // longer - so it is the one answered from, rather than reaching for a
    // replacement that has not been flushed.
    return generation.body();
  }

  stats() {
    return {
      enabled: this.enabled,
      entries: this.live.count,
      plainBytes: this.live.plainBytes,
      compressedBytes: this.live.compressedBytes,
      ratio: this.live.compressedBytes
        ? Math.round((this.live.plainBytes / this.live.compressedBytes) * 100) / 100
        : 0,
      rebuilds: this.rebuilds,
      rebuilding: this.building !== null,
    };
  }

  destroy() {
    this.enabled = false;
    this.live.destroy();
    if (this.building) this.building.destroy();
    this.building = null;
    this.snapshot = null;
    this.carry = null;
  }
}

module.exports = { GzipFeed, REBUILD_CHUNK };
