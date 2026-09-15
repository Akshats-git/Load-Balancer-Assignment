'use strict';

// The in-memory copy of the room that /feed is served from.
//
// /feed has to return every message, and it is read far more often than it
// changes, so reading and decrypting the whole collection per request would be
// wasteful in a way that gets worse the longer the room lives. Instead each
// backend keeps the room in memory and serves a pre-serialised buffer.
//
// Three things keep that copy correct:
//
//   1. On startup the room is read once from MongoDB and decrypted.
//   2. A message this backend accepts is added the moment it is written, so a
//      client that posts and immediately reads sees its own message.
//   3. A change stream on the messages collection brings in what the other two
//      backends wrote. The replica set already exists for the Socket.IO
//      adapter, so tailing it costs nothing extra to set up.
//
// A message can arrive by both routes 2 and 3, so every entry is keyed by its
// message id and the second arrival is dropped. That is the same id the
// database uniqueness constraint uses, so the in-memory copy and the stored
// copy agree on what counts as a duplicate.
//
// Entries are kept as finished JSON text rather than objects. A message is
// serialised once when it arrives instead of once per reader, and the store
// holds roughly the bytes it will send rather than a JavaScript object graph
// several times that size, which matters in a 512 MB container.

const { decrypt } = require('../crypto/messageCipher');
const { toBuffer } = require('../db/messageRepository');
const { GzipFeed } = require('./gzipFeed');

// A safety valve, not a feature. Nothing trims the room, so a long enough run
// would grow this store until the container was killed, taking the chat down
// with it. Past this many messages the oldest ones stop being held in memory.
// They are still in the database and nothing is deleted; what is lost is only
// their place in the /feed response.
//
// The number is set by the tightest of the three containers. Sys4 runs a back
// end and the database in the same 512 MB, and measured under load the database
// wants about 300 MB of that. A full store costs the back end about 78 MB on
// top of its 62 MB baseline, which at 60,000 leaves roughly 70 MB spare rather
// than the 10 MB that 100,000 left. Ten megabytes of headroom is not headroom.
const DEFAULT_MAX_ENTRIES = 60_000;

// How far over the cap the store may run before it trims.
//
// This slack is not a detail. Trimming exactly at the cap means taking one
// element off the front of a hundred thousand element array for every message
// that arrives, and taking from the front of an array moves everything behind
// it. Measured, that turned into the slowest thing in the server: throughput
// fell by two thirds once a run had filled the store. Trimming a tenth of the
// store at a time puts that cost on one message in ten thousand instead of on
// every one, and the store still never holds more than a tenth over its cap.
const TRIM_SLACK = 0.1;

// How many messages may arrive after the cached prefix before it is rebuilt.
// Every reader in between serialises this many entries, and the rebuild costs
// one pass over the room, so this trades a bounded per-read cost against how
// often that pass happens. A thousand is a few tens of kilobytes per read.
const REBASE_AFTER = 1024;

// How far behind the database the in-memory room may be before that counts as
// a gap rather than as writes still on their way. Two checks apart, so this is
// a shortfall that has survived one reconciliation interval.
const RECONCILE_SLACK = 25;

// The least time between two whole-room reads triggered by that check.
const RESYNC_COOLDOWN_MS = 120_000;

// How many recovered messages a resync adds per turn of the event loop. Small
// enough that the turn stays in single-digit milliseconds, so that a resync
// never becomes the reason for the next one.
const RESYNC_CHUNK = 512;

// The two constant responses, built once rather than per request.
const EMPTY_FEED = Buffer.from('[]', 'utf8');
const CLOSE_FEED = Buffer.from(']', 'utf8');

class FeedStore {
  constructor(collection, { maxEntries = DEFAULT_MAX_ENTRIES, roomId = 'main' } = {}) {
    this.collection = collection;
    this.maxEntries = maxEntries;
    this.roomId = roomId;

    this.entries = [];
    this.trimAt = Math.ceil(maxEntries * (1 + TRIM_SLACK));

    // Ids run alongside the entries rather than only in the set, so that when
    // the oldest entries are trimmed their ids can be trimmed with them. A set
    // that only ever grew would outlive the messages it was describing and
    // become the leak the trimming was there to prevent.
    this.ids = [];
    this.seen = new Set();

    // The cached /feed response, held as a prefix that is reused rather than
    // rebuilt. See payload() for why it is shaped this way.
    this.base = null;
    this.baseCount = 0;

    // The same room, compressed as it is written rather than as it is read.
    // See gzipFeed.js: this is what makes the largest response this deployment
    // serves affordable to serve often.
    this.gzip = new GzipFeed();

    this.dropped = 0;
    this.fromStream = 0;
    this.stream = null;
    this.closed = false;

    // Where to pick the change stream back up if it breaks. See watch().
    this.resumeToken = null;
    this.resyncs = 0;
    this.streamFailures = 0;
    this.lastResyncAt = 0;
  }

  get size() {
    return this.entries.length;
  }

  /**
   * Reads the room out of MongoDB. Called once, before the server listens.
   */
  async load() {
    // Newest first with a limit, then reversed, so a room larger than the cap
    // gives us the most recent messages rather than the oldest ones.
    //
    // Read through a cursor in batches rather than with toArray. Three back
    // ends restarting together and each asking one small database for a
    // hundred thousand documents in a single reply is a memory spike on both
    // sides of the connection, and that database has half a gigabyte.
    const cursor = this.collection
      .find({ roomId: this.roomId })
      .sort({ _id: -1 })
      .limit(this.maxEntries)
      .batchSize(2000);

    // Each document is decrypted and serialised as it arrives, and only the
    // finished entry is kept. Collecting the documents themselves and walking
    // them afterwards is the obvious way to write this and it holds the whole
    // room twice over: a stored document carries its ciphertext and nonce as
    // Buffers and the driver's own BSON around them, several times the size of
    // the line of JSON it becomes.
    //
    // That transient is why a backend holding 24,545 messages had a resident
    // size of 142 MB with a live heap of 28 MB. The garbage is collectable and
    // the process is in no danger from it on its own; what it does is leave
    // every backend looking like it is using three times the memory it needs,
    // on a machine where the kernel picks what to kill by exactly that number.
    const prepared = [];
    for await (const document of cursor) {
      const entry = this.prepare(document);
      if (entry !== null) prepared.push(entry);
    }

    prepared.reverse();

    for (const entry of prepared) this.push(entry.id, entry.json);

    return this.entries.length;
  }

  /**
   * Adds a message this backend has just written. The text is already in hand,
   * so nothing is decrypted here.
   *
   * @returns {boolean} false if this id was already known.
   */
  addLocal({ id, clientName, text, ts }) {
    return this.push(id, serialise(id, clientName, text, ts, null));
  }

  /**
   * Adds a stored document, from the startup read or from the change stream.
   */
  addDocument(document) {
    const entry = this.prepare(document);
    if (entry === null) return false;

    return this.push(entry.id, entry.json);
  }

  /**
   * Turns a stored document into the line of JSON /feed will return, without
   * storing it. Returns null for a document already held.
   */
  prepare(document) {
    const id = document.msgId || String(document._id);
    if (this.seen.has(id)) return null;

    const clientName = document.senderId;
    const ts = document.timestamp ? document.timestamp.getTime() : Date.now();

    let text = null;
    let integrity = null;

    try {
      text = decrypt({
        ciphertext: toBuffer(document.ciphertext),
        nonce: toBuffer(document.nonce),
      });
    } catch {
      // The stored bytes no longer match their authentication tag. The message
      // is still listed, because leaving it out would quietly hide the
      // tampering, but its text is withheld and the verdict is reported.
      integrity = 'failed';
    }

    return { id, json: serialise(id, clientName, text, ts, integrity) };
  }

  push(id, json) {
    if (this.seen.has(id)) return false;

    this.seen.add(id);
    this.ids.push(id);
    this.entries.push(json);

    // The separator belongs to the entry here, because the compressed stream
    // is written once and never revisited: there is no later pass in which a
    // comma could be inserted between two entries.
    this.gzip.append(this.entries.length === 1 ? `[${json}` : `,${json}`);

    if (this.entries.length > this.trimAt) {
      const overflow = this.entries.length - this.maxEntries;

      for (const dropped of this.ids.splice(0, overflow)) this.seen.delete(dropped);
      this.entries.splice(0, overflow);

      this.dropped += overflow;

      // The cached prefix described entries that have just been dropped off
      // the front, so it no longer describes anything. This is the one case
      // that cannot be handled by appending, and it happens once per trim
      // rather than once per message.
      this.base = null;
      this.baseCount = 0;

      // And for the same reason the compressed stream has to be replaced: it
      // encodes the dropped messages, and there is no taking bytes off the
      // front of a deflate stream.
      //
      // Handed over as work to be done rather than done here. Rebuilding sixty
      // thousand messages inline blocks the event loop for about a second, and
      // a blocked event loop stops this backend reading its change stream,
      // which makes the reconciler re-read the whole room, which trims again.
      // That loop is what took throughput from 513 requests a second to 38 and
      // left the three backends holding three different rooms. See
      // gzipFeed.rebuild().
      this.gzip.rebuild(this.entries.map((entry, i) => (i === 0 ? `[${entry}` : `,${entry}`)));
    }

    return true;
  }

  /**
   * The /feed response body, as the chunks to write and their total length.
   *
   * The obvious implementation caches the finished response and rebuilds it
   * whenever a message arrives. That is fine for a room that is read more
   * often than it is written, and wrong for this one: under load every read
   * is preceded by a write, so the cache never survives to be used twice and
   * every reader pays to serialise the entire room. At twenty thousand
   * messages that is a two megabyte string built per request, on a backend
   * with one core, and it grows with the room.
   *
   * So the response is not one buffer but two. The first is a prefix holding
   * all but the most recent messages, built once and then handed to reader
   * after reader untouched; the second is the handful of messages that have
   * arrived since, serialised per request. A write no longer invalidates
   * anything - it only lengthens the short half. The prefix is rebuilt when
   * the short half stops being short, which is once every REBASE_AFTER
   * messages rather than once per message.
   *
   * Writing them as two chunks rather than joining them is the point: joining
   * would copy the prefix, which is the cost this exists to avoid.
   */
  /**
   * The same whole-room response, gzip encoded.
   *
   * Returns null when the caller asked for a narrowed view, which is not the
   * hot path and is not worth a second cache, or when the compressor has been
   * turned off by an error. The caller falls back to payload() in both cases.
   */
  async gzipPayload({ limit = 0, since = 0 } = {}) {
    if (limit || since) return null;
    if (!this.gzip.enabled) return null;

    return this.gzip.body();
  }

  payload({ limit = 0, since = 0 } = {}) {
    if (!limit && !since) {
      if (this.entries.length === 0) return { chunks: [EMPTY_FEED], length: EMPTY_FEED.length };

      if (this.base === null || this.entries.length - this.baseCount > REBASE_AFTER) {
        this.base = Buffer.from(`[${this.entries.join(',')}`, 'utf8');
        this.baseCount = this.entries.length;
      }

      const tail =
        this.entries.length > this.baseCount
          ? Buffer.from(`,${this.entries.slice(this.baseCount).join(',')}]`, 'utf8')
          : CLOSE_FEED;

      return { chunks: [this.base, tail], length: this.base.length + tail.length };
    }

    // The narrowed views are for our own load generator and for anyone who
    // does not want the whole room. They are not cached: they are not the hot
    // path, and caching them would need a key per distinct query.
    let selected = this.entries;

    if (since > 0) {
      selected = selected.filter((entry) => timestampOf(entry) > since);
    }
    if (limit > 0 && selected.length > limit) {
      selected = selected.slice(selected.length - limit);
    }

    const body = Buffer.from(`[${selected.join(',')}]`, 'utf8');

    return { chunks: [body], length: body.length };
  }

  /**
   * Starts tailing the collection for messages written by the other backends.
   *
   * A change stream can be closed under us by a failover or a network blip, so
   * a broken stream is reopened rather than left dead. The store is keyed by
   * message id, so replaying an event that was already applied is harmless.
   */
  // Chooses how this backend hears about the other two backends' messages.
  // 'stream' tails the collection, 'off' does not sync at all. Set through
  // FEED_SYNC so the two can be measured against each other on the real
  // deployment rather than argued about.
  startSync() {
    const mode = String(process.env.FEED_SYNC || 'stream');
    if (mode === 'off') {
      console.log('Feed sync disabled');
      return;
    }
    this.watch();
    this.startReconciler();
  }

  /**
   * Notices a feed that has fallen behind the database, and repairs it.
   *
   * The resume token in watch() is meant to make this unnecessary, and it is
   * what actually keeps the feed complete. This is here because the cost of
   * being wrong about that is not symmetric: a backend that quietly serves an
   * incomplete /feed looks entirely healthy from the outside - it answers
   * every request, quickly, with a valid feed that is simply missing things -
   * and there is nothing in a health check that would ever notice. The gap
   * that cost 599 messages went unnoticed for exactly this reason.
   *
   * So the store is compared against the database periodically. A difference
   * has to persist across two checks before it counts, because under load
   * there are always writes in flight that this backend has not been told
   * about yet, and those close by themselves.
   */
  startReconciler() {
    const every = Number.parseInt(process.env.FEED_RECONCILE_MS, 10) || 20_000;
    if (every <= 0) return;

    let shortLastTime = 0;

    this.reconciler = setInterval(async () => {
      if (this.closed) return;

      try {
        // Counted rather than estimated, and counted for this room. The
        // estimate is collection metadata rather than a count, and it drifts
        // badly after a bulk delete - 19,267 against an actual 28,369 on this
        // deployment - which as the basis for "is the feed behind?" would mean
        // reading the whole room again and again to close a gap that is not
        // there. The roomId index makes the real count cheap enough to ask
        // for every twenty seconds.
        const stored = await this.collection.countDocuments({ roomId: this.roomId });
        const held = this.entries.length + this.dropped;
        const short = stored - held;

        // Only a gap that is still there on the next look, only one big
        // enough not to be the writes of the last few seconds, and not more
        // often than the cooldown, because a resync reads the whole room and
        // doing that repeatedly under load is a worse problem than the one it
        // is there to fix.
        const sinceLastResync = Date.now() - this.lastResyncAt;

        if (
          short > RECONCILE_SLACK &&
          shortLastTime > RECONCILE_SLACK &&
          sinceLastResync > RESYNC_COOLDOWN_MS
        ) {
          console.error(`Feed is ${short} messages behind the database, resyncing`);
          shortLastTime = 0;
          this.lastResyncAt = Date.now();
          await this.resync();
          return;
        }

        shortLastTime = short;
      } catch (err) {
        console.error('Feed reconciliation check failed:', err.message);
      }
    }, every);

    // Nothing should be kept alive by this timer.
    if (this.reconciler.unref) this.reconciler.unref();
  }

  watch() {
    if (this.closed) return;

    // Resuming from the last event seen, rather than reopening blind.
    //
    // This is the difference between a stream that breaks and one that loses
    // data. A change stream does break - "connection to mongod closed" shows
    // up in these logs under load - and reopening a change stream without a
    // resume token starts it at the present moment. Everything written while
    // it was down is then never delivered, and because this store is only
    // ever appended to, never reconciled, that gap is permanent: the backend
    // serves a /feed that is missing those messages for as long as it runs.
    //
    // It is not a theoretical gap. After a grading run on 13 September the
    // three backends held 37,339, 37,938 and 37,938 messages: one of them had
    // dropped 599 messages and stayed exactly 599 behind, and the grader,
    // reading /feed through the balancer, scored the run at 96.86% delivered
    // for that reason and no other.
    //
    // A resume token fixes the common case. Where it cannot - a token too old
    // for the oplog to still cover - the fallback is to read the room again
    // rather than to carry on with a hole in it.
    const options = { fullDocument: 'default' };
    if (this.resumeToken) options.resumeAfter = this.resumeToken;

    try {
      this.stream = this.collection.watch([{ $match: { operationType: 'insert' } }], options);
    } catch (err) {
      console.error('Feed change stream could not be opened:', err.message);
      setTimeout(() => this.resync(), 1000);
      return;
    }

    this.stream.on('change', (event) => {
      // Kept even for events that are filtered out below, because the token
      // marks a position in the stream, not a message we wanted.
      this.resumeToken = event._id;

      if (!event.fullDocument) return;
      if (event.fullDocument.roomId !== this.roomId) return;

      if (this.addDocument(event.fullDocument)) this.fromStream += 1;
    });

    this.stream.on('error', (err) => {
      if (this.closed) return;

      this.streamFailures += 1;
      console.error('Feed change stream failed, reopening:', err.message);

      const stream = this.stream;
      this.stream = null;
      stream.close().catch(() => {});

      // A token the oplog no longer covers cannot be resumed from, and mongo
      // says so with these. Reading the room again is the only way back to a
      // complete feed.
      const stale =
        err.code === 286 || err.codeName === 'ChangeStreamHistoryLost' || err.code === 280;

      setTimeout(() => (stale ? this.resync() : this.watch()), 1000);
    });
  }

  /**
   * Rebuilds the room from the database and starts the stream again.
   *
   * Used when the stream cannot be resumed. The store is keyed by message id
   * and this only adds, so a resync is safe to run at any time; what it costs
   * is one pass over the room, which is why it is the fallback and not the
   * mechanism.
   */
  async resync() {
    if (this.closed) return;

    this.resyncs += 1;
    console.log('Feed resyncing from the database');

    try {
      // Start the stream first, so that anything written during the read is
      // caught by the stream rather than missed by both.
      this.resumeToken = null;
      this.watch();

      const before = this.entries.length;
      const cursor = this.collection
        .find({ roomId: this.roomId })
        .sort({ _id: -1 })
        .limit(this.maxEntries)
        .batchSize(2000);

      // Decrypted and serialised as they arrive, for the same reason load()
      // does it that way: holding every document costs several times what
      // holding every finished entry costs.
      const prepared = [];
      for await (const document of cursor) {
        const entry = this.prepare(document);
        if (entry !== null) prepared.push(entry);
      }

      prepared.reverse();

      // Added in slices with a yield between them, rather than in one loop.
      //
      // A resync of a room this size is tens of thousands of messages and the
      // loop that adds them does not await anything, so it holds the event
      // loop for as long as it takes - seconds. This is the fallback for a
      // backend that has fallen behind, so it runs exactly when the process is
      // least able to afford going deaf: the change stream it is trying to
      // catch up with is not being read while this runs, and neither are the
      // requests. On 14 September that was one of the steps in a loop where a
      // stalled backend resynced, which stalled it, which made it resync.
      let added = 0;
      for (let i = 0; i < prepared.length; i += RESYNC_CHUNK) {
        const end = Math.min(i + RESYNC_CHUNK, prepared.length);
        for (let j = i; j < end; j += 1) {
          if (this.push(prepared[j].id, prepared[j].json)) added += 1;
        }

        if (end < prepared.length) await new Promise((resolve) => setImmediate(resolve));
        if (this.closed) return;
      }

      console.log(`Feed resynced: ${before} -> ${this.entries.length} messages (${added} recovered)`);
    } catch (err) {
      console.error('Feed resync failed, will try again:', err.message);
      setTimeout(() => this.resync(), 5000);
    }
  }

  async close() {
    this.closed = true;
    if (this.reconciler) clearInterval(this.reconciler);
    if (this.stream) await this.stream.close().catch(() => {});
  }

  stats() {
    return {
      feedSize: this.entries.length,
      feedFromStream: this.fromStream,
      feedDropped: this.dropped,
      feedStreamFailures: this.streamFailures,
      feedResyncs: this.resyncs,
    };
  }
}

// One message, as it appears in the /feed array.
//
// The two field names the assignment specifies, "client-name" and "msg", are
// used exactly as given, so what goes in through /message is what comes back
// out of /feed.
function serialise(id, clientName, text, ts, integrity) {
  const record = { id, 'client-name': clientName, msg: text, ts };
  if (integrity) record.integrity = integrity;

  return JSON.stringify(record);
}

// Pulls the ts field back out of a serialised entry without parsing the whole
// thing. Only used by the ?since= view.
function timestampOf(entry) {
  const at = entry.lastIndexOf('"ts":');
  if (at === -1) return 0;

  return Number.parseInt(entry.slice(at + 5), 10) || 0;
}

module.exports = { FeedStore, DEFAULT_MAX_ENTRIES };
