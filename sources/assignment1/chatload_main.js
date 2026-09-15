// Load generator for the chat workload.
//
// Runs on the local system and drives the load balancer on Sys1. One request
// here is a full chat session opening, which is what a real user does:
//
//   connect over WebSocket
//     -> auth-start     username and public key
//     <- auth-challenge
//     -> auth-response  ECDSA signature over the challenge
//     <- join-success
//     <- chat-history   every stored message decrypted and checked
//
// The last step is the slow one. The server decrypts and verifies the
// signature on up to 100 stored messages before it can reply, so this workload
// measures the backends rather than the network.
//
// It connects with the websocket transport only. Socket.IO normally opens with
// a few HTTP polls that one process has to answer, which round robin would
// break. A websocket connection is a single request, so each session lands on
// one backend and the split stays even.
//
// Output matches the Go HTTP load generator so both can go in one table.

// The load balancer uses a self signed certificate. Node rejects it by default.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('fs');
const { io } = require('/home/akshat/csd-group-chat/server/node_modules/socket.io-client');

const subtle = globalThis.crypto.subtle;
const b64 = (buf) => Buffer.from(buf).toString('base64');

function parseArgs() {
  const args = {
    url: '',
    requests: 600,
    concurrency: 30,
    timeout: 30000,
    experiment: 'run',
    out: '',
    csv: '',
  };

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^-+/, '');
    const value = argv[i + 1];
    if (!(key in args)) {
      console.error(`unknown flag: ${argv[i]}`);
      process.exit(1);
    }
    args[key] = typeof args[key] === 'number' ? Number(value) : value;
  }

  if (!args.url) {
    console.error('need -url');
    process.exit(1);
  }

  return args;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  let i = Math.floor((p / 100) * sorted.length);
  if (i >= sorted.length) i = sorted.length - 1;
  return Math.round(sorted[i] * 1000) / 1000;
}

// One keypair signs for every session. The server binds a username to a key on
// first use, not the other way round, so many usernames can share one keypair.
// That keeps the generator from burning its own CPU on key generation.
async function makeSigner() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);

  return {
    publicKey: b64(await subtle.exportKey('spki', pair.publicKey)),
    sign: async (bytes) =>
      b64(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes)),
  };
}

// One session. Resolves with how long it took, or rejects on any failure.
function runSession(url, signer, username, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    let socket;
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) socket.close();
      if (err) reject(err);
      else resolve(Number(process.hrtime.bigint() - started) / 1e6);
    };

    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);

    socket = io(url, {
      transports: ['websocket'],
      rejectUnauthorized: false,
      upgrade: false,
      reconnection: false,
      timeout: timeoutMs,
      forceNew: true,
    });

    socket.on('connect_error', (err) => finish(new Error(`connect: ${err.message}`)));
    socket.on('join-error', (p) => finish(new Error(`join: ${p && p.message}`)));

    socket.on('connect', () => {
      socket.emit('auth-start', { username, publicKey: signer.publicKey });
    });

    socket.on('auth-challenge', async ({ challenge }) => {
      try {
        socket.emit('auth-response', { signature: await signer.sign(Buffer.from(challenge, 'base64')) });
      } catch (err) {
        finish(err);
      }
    });

    // chat-history is the last thing sent for a join, so this means it is open.
    socket.on('chat-history', () => finish(null));
  });
}

async function main() {
  const args = parseArgs();
  const signer = await makeSigner();
  const stamp = Math.random().toString(36).slice(2, 7);

  let issued = 0;
  let success = 0;
  const failures = new Map();
  const latencies = [];

  const started = Date.now();

  // Workers pull sessions off a shared counter, same shape as the Go generator.
  const worker = async () => {
    for (;;) {
      const n = issued++;
      if (n >= args.requests) return;

      try {
        latencies.push(await runSession(args.url, signer, `lg-${stamp}-${n}`, args.timeout));
        success++;
      } catch (err) {
        failures.set(err.message, (failures.get(err.message) || 0) + 1);
      }
    }
  };

  await Promise.all(Array.from({ length: args.concurrency }, worker));

  const elapsed = (Date.now() - started) / 1000;
  const failed = args.requests - success;
  latencies.sort((a, b) => a - b);

  const result = {
    experiment: args.experiment,
    requests: args.requests,
    concurrency: args.concurrency,
    successful: success,
    failed,
    throughput_rps: Math.round((success / elapsed) * 100) / 100,
    dropout_percent: Math.round((failed / args.requests) * 10000) / 100,
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    p99_ms: percentile(latencies, 99),
    elapsed_seconds: Math.round(elapsed * 1000) / 1000,
  };

  console.log(JSON.stringify(result, null, 2));

  if (failures.size > 0) {
    console.log('failure reasons:');
    for (const [reason, count] of failures) console.log(`  ${count} x ${reason}`);
  }

  if (args.out) fs.writeFileSync(args.out, JSON.stringify(result, null, 2) + '\n');

  if (args.csv) {
    const header =
      'experiment,requests,concurrency,successful,failed,throughput_rps,dropout_percent,p50_ms,p95_ms,p99_ms,elapsed_seconds\n';
    if (!fs.existsSync(args.csv)) fs.writeFileSync(args.csv, header);
    fs.appendFileSync(
      args.csv,
      [
        result.experiment,
        result.requests,
        result.concurrency,
        result.successful,
        result.failed,
        result.throughput_rps.toFixed(2),
        result.dropout_percent.toFixed(2),
        result.p50_ms.toFixed(2),
        result.p95_ms.toFixed(2),
        result.p99_ms.toFixed(2),
        result.elapsed_seconds.toFixed(3),
      ].join(',') + '\n'
    );
  }
}

main().catch((err) => {
  console.error('load generator failed:', err.message);
  process.exit(1);
});
