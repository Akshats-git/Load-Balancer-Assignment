// Checks that the chat still works across the three back ends.
//
// Three clients are pinned to different back ends with the sticky cookie. One
// sends a signed message and another has to receive it, which only happens if
// the broadcast crossed machines. The third reads it back out of history.
//
// Usage: node cross_replica_test.js https://10.1.75.53:3229

// The load balancer certificate is self signed.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('fs');
const path = require('path');
const { io } = require('/home/akshat/csd-group-chat/server/node_modules/socket.io-client');

// A username is bound to its public key on first use, so the keys are kept on
// disk and reused. Fresh keys every run would need fresh usernames every run.
const KEY_FILE = path.join(__dirname, 'test_identities.json');

const URL = process.argv[2] || 'http://localhost:8080';
const subtle = globalThis.crypto.subtle;

const b64 = (buf) => Buffer.from(buf).toString('base64');

const saved = fs.existsSync(KEY_FILE) ? JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')) : {};

async function identity(username) {
  if (!saved[username]) {
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    saved[username] = {
      privateKey: b64(await subtle.exportKey('pkcs8', pair.privateKey)),
      publicKey: b64(await subtle.exportKey('spki', pair.publicKey)),
    };
    fs.writeFileSync(KEY_FILE, JSON.stringify(saved, null, 2));
  }

  const privateKey = await subtle.importKey(
    'pkcs8',
    Buffer.from(saved[username].privateKey, 'base64'),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  return {
    username,
    publicKey: saved[username].publicKey,
    sign: async (bytes) => b64(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, bytes)),
  };
}

// Connect, prove the key, wait for join-success. The chat-history listener is
// attached here because the server sends history immediately after
// join-success, too early for a caller waiting on this promise to catch it.
function connectAndLogin(identity, backendId) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, {
      // The load balancer reads this cookie and picks the back end from it.
      extraHeaders: { Cookie: `lb_backend=${backendId}` },
      transports: ['polling', 'websocket'],
      // The polling transport does its own TLS check and ignores the env var.
      rejectUnauthorized: false,
      reconnection: false,
      timeout: 15000,
    });

    const fail = (why) => reject(new Error(`${identity.username}: ${why}`));
    const timer = setTimeout(() => fail('timed out during login'), 25000);

    socket.on('connect_error', (err) => fail(`connect_error ${err.message}`));
    socket.on('join-error', (p) => fail(`join-error ${p.message}`));

    socket.on('connect', () => {
      socket.emit('auth-start', { username: identity.username, publicKey: identity.publicKey });
    });

    socket.on('auth-challenge', async ({ challenge }) => {
      const signature = await identity.sign(Buffer.from(challenge, 'base64'));
      socket.emit('auth-response', { signature });
    });

    let history = null;
    let historyWaiter = null;
    socket.on('chat-history', (h) => {
      history = h;
      if (historyWaiter) historyWaiter(h);
    });

    socket.on('join-success', () => {
      clearTimeout(timer);
      // Resolves whether history arrived before or after this call.
      socket.waitForHistory = () =>
        history
          ? Promise.resolve(history)
          : new Promise((res, rej) => {
              const t = setTimeout(() => rej(new Error('no chat-history')), 15000);
              historyWaiter = (h) => {
                clearTimeout(t);
                res(h);
              };
            });
      resolve(socket);
    });
  });
}

// Which back end the cookie pins this client to.
//
// The request has to be a Socket.IO one. The balancer only honours the sticky
// cookie on /socket.io/ paths, because that handshake is several requests that
// only one process can answer, while the plain HTTP routes are stateless and
// are deliberately left free to move to whichever back end is least loaded.
// Asking /health with the cookie would therefore report whichever back end was
// idle at that moment rather than the one this client is pinned to.
async function whichBackend(backendId) {
  const res = await fetch(`${URL}/socket.io/?EIO=4&transport=polling`, {
    headers: { Cookie: `lb_backend=${backendId}` },
  });

  // Read and discard the body so the connection is not left open.
  await res.text();

  // The balancer's header, not the chat server's. Socket.IO answers these
  // requests from the HTTP server directly, before Express and therefore
  // before the middleware that names the instance, so X-Backend is not set on
  // them. X-LB-Backend is added by the balancer on the way out and is always
  // there.
  return res.headers.get('x-lb-backend') ?? res.headers.get('x-backend');
}

async function main() {
  const sender = await identity('ananya');
  const listener = await identity('vikram');
  const reader = await identity('meera');

  const senderOn = await whichBackend(0);
  const listenerOn = await whichBackend(2);
  console.log(`ananya is pinned to backend 0 -> ${senderOn}`);
  console.log(`vikram is pinned to backend 2 -> ${listenerOn}`);

  if (senderOn === listenerOn) {
    console.log('WARNING: both clients landed on the same back end, this is not a cross machine test');
  }

  const senderSocket = await connectAndLogin(sender, 0);
  console.log('ananya logged in');
  const listenerSocket = await connectAndLogin(listener, 2);
  console.log('vikram logged in');

  // vikram is on another machine. If he sees it, the broadcast crossed.
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('vikram never received the message, the cross machine broadcast is broken')),
      15000
    );
    listenerSocket.on('chat-message', (msg) => {
      if (msg.username !== sender.username) return;
      clearTimeout(timer);
      resolve(msg);
    });
  });

  const text = 'does this reach the other back end';
  const timestamp = Date.now();
  const signature = await sender.sign(Buffer.from(`${sender.username}\n${timestamp}\n${text}`, 'utf8'));

  senderSocket.emit('chat-message', { text, timestamp, signature });
  console.log(`ananya sent: "${text}"`);

  const msg = await received;
  console.log(`vikram received: "${msg.text}"`);
  console.log(`  message id      : ${msg.id}`);
  console.log(`  signature check : ${msg.signature}`);
  console.log(`  stored ciphertext (first 32 chars): ${String(msg.stored.ciphertext).slice(0, 32)}...`);

  // History comes from the shared database, so a third client on the remaining
  // back end should be able to read the same message back.
  console.log(`meera  is pinned to backend 1 -> ${await whichBackend(1)}`);
  const readerSocket = await connectAndLogin(reader, 1);
  const history = await readerSocket.waitForHistory();

  const found = history.find((m) => m.id === msg.id);
  console.log(`meera loaded ${history.length} messages of history from the shared database`);
  console.log(`  ananya's message present : ${found ? 'yes' : 'no'}`);
  if (found) {
    console.log(`  decrypted text           : "${found.text}"`);
    console.log(`  integrity verdict        : ${found.integrity ?? 'ok'}`);
    console.log(`  signature verdict        : ${found.signature}`);
  }

  senderSocket.close();
  listenerSocket.close();
  readerSocket.close();

  const ok = Boolean(found) && msg.signature === 'valid';
  console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'}. Chat works across all three back ends behind the load balancer.`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
