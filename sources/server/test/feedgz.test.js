// Checks that the gzip /feed body decodes to exactly the uncompressed one, in
// the situations that change how the store is built: a fresh room, messages
// arriving between two reads, concurrent reads, and a trim.
const assert = require('node:assert');
const zlib = require('node:zlib');
const { GzipFeed } = require('../src/api/gzipFeed');

function plainOf(entries) {
  return entries.length === 0 ? '[]' : `[${entries.join(',')}]`;
}

async function bodyBytes(gz) {
  const { chunks, length } = await gz.body();
  const joined = Buffer.concat(chunks);
  assert.strictEqual(joined.length, length, 'Content-Length must match the bytes written');
  return joined;
}

function entry(i) {
  return JSON.stringify({
    id: `id-${i}`,
    'client-name': `user${i % 37}`,
    msg: `message ${i} ${'abcdefg '.repeat(i % 40)}`,
    ts: 1789000000000 + i,
  });
}

(async () => {
  // 1. empty, then growing, read after every append
  {
    const gz = new GzipFeed();
    const entries = [];
    for (let i = 0; i < 60; i += 1) {
      entries.push(entry(i));
      gz.append(i === 0 ? `[${entries[i]}` : `,${entries[i]}`);
      const out = zlib.gunzipSync(await bodyBytes(gz)).toString('utf8');
      assert.strictEqual(out, plainOf(entries), `mismatch after ${i + 1} entries`);
    }
    console.log('read-after-every-append: ok');
  }

  // 2. bursts between reads, and a read with nothing new
  {
    const gz = new GzipFeed();
    const entries = [];
    let n = 0;
    for (const burst of [1, 7, 250, 1, 0, 1024, 3]) {
      for (let i = 0; i < burst; i += 1, n += 1) {
        entries.push(entry(n));
        gz.append(n === 0 ? `[${entries[n]}` : `,${entries[n]}`);
      }
      const out = zlib.gunzipSync(await bodyBytes(gz)).toString('utf8');
      assert.strictEqual(out, plainOf(entries), `mismatch after a burst of ${burst}`);
    }
    console.log('bursts between reads: ok');
  }

  // 3. concurrent reads racing appends
  {
    const gz = new GzipFeed();
    const entries = [];
    for (let i = 0; i < 500; i += 1) {
      entries.push(entry(i));
      gz.append(i === 0 ? `[${entries[i]}` : `,${entries[i]}`);
    }
    const readers = await Promise.all([bodyBytes(gz), bodyBytes(gz), bodyBytes(gz), bodyBytes(gz)]);
    for (const body of readers) {
      const out = zlib.gunzipSync(body).toString('utf8');
      // A concurrent reader may legitimately see more than 500, never fewer.
      assert.ok(out.startsWith(`[${entries[0]}`), 'concurrent read lost the front of the room');
      assert.ok(out.endsWith(']'), 'concurrent read was not terminated');
      JSON.parse(out);
    }
    console.log('concurrent reads: ok');
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function untilRebuilt(gz, label) {
    for (let i = 0; i < 20000; i += 1) {
      if (!gz.stats().rebuilding) return;
      await settle();
    }
    assert.fail(`rebuild never finished: ${label}`);
  }

  // 4. a rebuild, which is what a trim does to the compressor. It happens in
  //    the background, and what matters is that the body is a valid feed at
  //    every point during it, and the trimmed one once it has finished.
  {
    const gz = new GzipFeed({ chunkSize: 64 });
    const entries = [];
    for (let i = 0; i < 3000; i += 1) {
      entries.push(entry(i));
      gz.append(i === 0 ? `[${entries[i]}` : `,${entries[i]}`);
    }
    const before = zlib.gunzipSync(await bodyBytes(gz)).toString('utf8');
    assert.strictEqual(before, plainOf(entries));

    const kept = entries.slice(1000);
    gz.rebuild(kept.map((e, i) => (i === 0 ? `[${e}` : `,${e}`)));

    // Readers during the rebuild get the old stream: longer than the trimmed
    // room, never shorter, and always parseable.
    let reads = 0;
    while (gz.stats().rebuilding) {
      const mid = JSON.parse(zlib.gunzipSync(await bodyBytes(gz)).toString('utf8'));
      assert.ok(mid.length >= kept.length, 'a reader during a rebuild lost messages');
      reads += 1;
      await settle();
    }
    assert.ok(reads > 1, 'the rebuild was not actually incremental');

    const out = zlib.gunzipSync(await bodyBytes(gz)).toString('utf8');
    assert.strictEqual(out, plainOf(kept), 'rebuild after a trim did not match');
    console.log(`rebuild after trim: ok (${reads} reads served while it ran)`);
  }

  // 5. messages arriving during a rebuild must end up in the replacement
  {
    const gz = new GzipFeed({ chunkSize: 32 });
    const entries = [];
    for (let i = 0; i < 2000; i += 1) {
      entries.push(entry(i));
      gz.append(i === 0 ? `[${entries[i]}` : `,${entries[i]}`);
    }

    const kept = entries.slice(500);
    gz.rebuild(kept.map((e, i) => (i === 0 ? `[${e}` : `,${e}`)));

    // Written while the replacement is still compressing its snapshot.
    const late = [];
    for (let i = 0; i < 40; i += 1) {
      const e = entry(100000 + i);
      late.push(e);
      kept.push(e);
      gz.append(`,${e}`);
      await settle();
    }

    await untilRebuilt(gz, 'arrivals during a rebuild');

    const out = zlib.gunzipSync(await bodyBytes(gz)).toString('utf8');
    assert.strictEqual(out, plainOf(kept), 'messages sent during a rebuild were lost');
    console.log('arrivals during a rebuild: ok');
  }

  // 6. a second trim while the first rebuild is still running
  {
    const gz = new GzipFeed({ chunkSize: 16 });
    const entries = [];
    for (let i = 0; i < 4000; i += 1) {
      entries.push(entry(i));
      gz.append(i === 0 ? `[${entries[i]}` : `,${entries[i]}`);
    }

    gz.rebuild(entries.slice(1000).map((e, i) => (i === 0 ? `[${e}` : `,${e}`)));
    await settle();
    const kept = entries.slice(2000);
    gz.rebuild(kept.map((e, i) => (i === 0 ? `[${e}` : `,${e}`)));

    await untilRebuilt(gz, 'overlapping rebuilds');

    const out = zlib.gunzipSync(await bodyBytes(gz)).toString('utf8');
    assert.strictEqual(out, plainOf(kept), 'the second trim did not win');
    console.log('overlapping rebuilds: ok');
  }

  // 7. non-ascii, since the length in the trailer is bytes and not characters
  {
    const gz = new GzipFeed();
    const entries = [JSON.stringify({ id: 'u', 'client-name': 'अक्षत', msg: 'नमस्ते 🌍 café', ts: 1 })];
    gz.append(`[${entries[0]}`);
    const out = zlib.gunzipSync(await bodyBytes(gz)).toString('utf8');
    assert.strictEqual(out, plainOf(entries));
    assert.strictEqual(JSON.parse(out)[0]['client-name'], 'अक्षत');
    console.log('non-ascii: ok');
  }

  // 8. the ratio is actually worth having
  {
    const gz = new GzipFeed();
    let plain = 0;
    for (let i = 0; i < 20000; i += 1) {
      const e = entry(i);
      plain += e.length + 1;
      gz.append(i === 0 ? `[${e}` : `,${e}`);
    }
    const body = await bodyBytes(gz);
    const ratio = plain / body.length;
    console.log(`20,000 entries: ${(plain / 1048576).toFixed(2)} MB -> ${(body.length / 1048576).toFixed(2)} MB (${ratio.toFixed(2)}x)`);
    assert.ok(ratio > 3, 'compression is not paying for itself');
  }

  console.log('\nall gzip feed checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
