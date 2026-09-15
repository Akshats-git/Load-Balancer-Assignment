// Fills the room with a backlog of messages before the experiments run.
//
// History is capped at 100 messages and every one of them is decrypted and has
// its signature checked on login, so seeding more than 100 makes each login do
// the full amount of work. An empty room would make that step free.
//
// Messages are written the way the server writes them, signed over the
// canonical bytes and encrypted with the deployment key.

const path = require('path');
const SERVER = path.join(process.env.HOME, 'chat', 'server');

const db = require(path.join(SERVER, 'src/db'));
const { saveMessage } = require(path.join(SERVER, 'src/db/messageRepository'));
const { registerSender } = require(path.join(SERVER, 'src/db/senderRepository'));
const { encrypt, loadKey } = require(path.join(SERVER, 'src/crypto/messageCipher'));
const { buildCanonicalBytes } = require(path.join(SERVER, 'src/crypto/canonical'));

const ROOM_ID = 'main';
const subtle = globalThis.crypto.subtle;
const b64 = (b) => Buffer.from(b).toString('base64');

const CHAT = [
  ['aarav', 'anyone started the load balancer lab yet'],
  ['priya', 'started last night, my sys1 container kept dying'],
  ['rohit', 'mine too, the 512 mb limit is tight'],
  ['aarav', 'what did you do about it'],
  ['priya', 'capped the wiredtiger cache at 0.25 gb'],
  ['rohit', 'that fixed it for me as well'],
  ['sneha', 'which port are you all using for the lb'],
  ['aarav', '3000 inside, it shows up as 32nn outside'],
  ['karan', 'took me an hour to work that rule out'],
  ['sneha', 'same, i was trying 8080 and nothing came through'],
  ['priya', 'the ppt says it on slide 6'],
  ['karan', 'of course it does'],
  ['rohit', 'is anyone writing the proxy in go'],
  ['aarav', 'yes, httputil.ReverseProxy, it is about 40 lines'],
  ['sneha', 'good, i was going to write raw sockets'],
  ['priya', 'please do not do that'],
  ['rohit', 'round robin is just an index and a mutex'],
  ['aarav', 'and one goroutine for the health checks'],
  ['karan', 'how often are you polling'],
  ['aarav', 'every 2 seconds'],
  ['priya', 'mine is every 5, 2 felt aggressive'],
  ['rohit', '2 is fine, the check is a memory read'],
  ['sneha', 'do you mark a backend down on the first failure'],
  ['aarav', 'no, three in a row'],
  ['sneha', 'why three'],
  ['aarav', 'one slow reply is not a dead server'],
  ['karan', 'that makes sense'],
  ['priya', 'my failover test kept flapping before i did that'],
  ['rohit', 'same here'],
  ['sneha', 'the chat back end was harder than the proxy honestly'],
  ['aarav', 'because of socket.io'],
  ['sneha', 'yes'],
  ['priya', 'what broke for you'],
  ['sneha', 'messages did not cross machines'],
  ['rohit', 'socket.io keeps the connections in one process'],
  ['aarav', 'you need the mongo adapter'],
  ['sneha', 'found it, @socket.io/mongo-adapter'],
  ['karan', 'does that need a replica set'],
  ['aarav', 'yes, it tails a capped collection with a change stream'],
  ['karan', 'and change streams need an oplog'],
  ['priya', 'which a standalone mongod does not have'],
  ['sneha', 'so single node replica set it is'],
  ['rohit', 'rs.initiate once and you are done'],
  ['karan', 'took me a while to accept that'],
  ['aarav', 'the other thing is the handshake'],
  ['priya', 'the polling handshake'],
  ['aarav', 'yes, several requests and only one process knows the session'],
  ['sneha', 'so round robin breaks the login'],
  ['rohit', 'cookie stickiness fixes it'],
  ['aarav', 'lb_backend cookie, set on the first request'],
  ['karan', 'does that not ruin the load spread'],
  ['aarav', 'the load generator has no cookie jar so it still round robins'],
  ['priya', 'clean'],
  ['sneha', 'my websocket clients are one request each anyway'],
  ['rohit', 'right, the split stays even'],
  ['karan', 'what are you all measuring'],
  ['priya', 'throughput, dropout and the latency percentiles'],
  ['aarav', 'same'],
  ['rohit', 'are you measuring /health'],
  ['aarav', 'i tried, it tells you nothing'],
  ['rohit', 'why not'],
  ['aarav', 'the back end answers it in microseconds'],
  ['priya', 'so the proxy becomes the bottleneck'],
  ['aarav', 'exactly, adding back ends changes nothing'],
  ['sneha', 'what did you measure instead'],
  ['aarav', 'a full login with the history load included'],
  ['sneha', 'that is real work'],
  ['priya', 'how much work'],
  ['aarav', '100 messages decrypted and verified per login'],
  ['karan', 'on one vcpu that must hurt'],
  ['aarav', 'it does, that is the point'],
  ['rohit', 'did it scale'],
  ['aarav', 'three times faster with three back ends'],
  ['priya', 'nice'],
  ['sneha', 'p50 dropped a lot for me too'],
  ['rohit', 'mine went from about 3.5 s to 1.3 s'],
  ['karan', 'that is a big drop'],
  ['priya', 'zero failures either way'],
  ['aarav', 'same here'],
  ['sneha', 'did anyone see the tail get worse'],
  ['aarav', 'on the /health run yes'],
  ['sneha', 'p99 doubled for me'],
  ['aarav', 'three connection pools and three health checks on one vcpu'],
  ['rohit', 'makes sense'],
  ['karan', 'so the tail is the cost of spreading out'],
  ['priya', 'only when there is no other bottleneck'],
  ['sneha', 'right'],
  ['rohit', 'how are you seeding the room'],
  ['aarav', 'a script that writes signed and encrypted messages'],
  ['priya', 'not plain inserts'],
  ['aarav', 'no, they have to verify like live ones'],
  ['sneha', 'otherwise the history load is free'],
  ['karan', 'and the experiment measures nothing'],
  ['rohit', 'how many are you seeding'],
  ['aarav', '120, history caps at 100'],
  ['priya', 'so every login does the full 100'],
  ['sneha', 'smart'],
  ['karan', 'is your site on https'],
  ['aarav', 'it has to be'],
  ['karan', 'why'],
  ['aarav', 'webcrypto only works on a secure origin'],
  ['priya', 'browsers refuse it otherwise'],
  ['karan', 'self signed cert then'],
  ['aarav', 'yes, you click through the warning once'],
  ['sneha', 'openssl req -x509, one line'],
  ['rohit', 'does the proxy talk https to the back ends too'],
  ['aarav', 'no, plain http inside the bridge network'],
  ['rohit', 'fine'],
  ['priya', 'did anyone hit the idle connection limit in go'],
  ['aarav', 'yes, that one cost me an evening'],
  ['priya', 'the default transport keeps two idle conns per host'],
  ['aarav', 'so almost every request opens a new tcp connection'],
  ['rohit', 'what were you seeing'],
  ['aarav', 'proxy stuck at 443 rps, back ends could do 1244'],
  ['sneha', 'what fixed it'],
  ['aarav', 'MaxIdleConnsPerHost 256'],
  ['priya', 'it went up to 674 after that'],
  ['karan', 'worth putting in the report'],
  ['aarav', 'it is already in mine'],
  ['sneha', 'submitting tonight, good luck everyone'],
];

async function main() {
  loadKey();
  await db.connect();

  // One keypair signs for everyone. A username is bound to a key on first use,
  // not the other way round, so several usernames can share one key.
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64(await subtle.exportKey('spki', pair.publicKey));

  for (const name of new Set(CHAT.map(([who]) => who))) {
    await registerSender(name, publicKey);
  }

  for (let i = 0; i < CHAT.length; i++) {
    const [username, text] = CHAT[i];
    // Spread over the last two hours so it reads like a conversation.
    const clientTimestamp = Date.now() - (CHAT.length - i) * 60_000;

    const signature = Buffer.from(
      await subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        buildCanonicalBytes(username, clientTimestamp, text)
      )
    );

    const { ciphertext, nonce } = encrypt(text);

    await saveMessage({
      roomId: ROOM_ID,
      senderId: username,
      ciphertext,
      nonce,
      signature,
      senderPublicKey: Buffer.from(publicKey, 'base64'),
      timestamp: new Date(clientTimestamp),
      clientTimestamp,
    });
  }

  console.log(`seeded ${CHAT.length} signed and encrypted messages into room "${ROOM_ID}"`);
  await db.close();
}

main().catch((e) => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
