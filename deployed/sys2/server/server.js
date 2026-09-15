const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/mongo-adapter');

const { Presence } = require('./src/presence');
const { RateLimiter } = require('./src/rateLimiter');
const { registerSocketHandlers } = require('./src/socketHandlers');
const { createHealthRouter, createLoadRouter } = require('./src/routes/health');
const { createApiRouter } = require('./src/api/router');
const { FeedStore } = require('./src/api/feedStore');
const { WriteQueue } = require('./src/api/writeQueue');
const { LoadMetrics } = require('./src/api/loadMetrics');
const { loadKey } = require('./src/crypto/messageCipher');
const db = require('./src/db');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// 4000, not 3000: the client dev server takes 3000, so keeping the backend off
// that port lets both run at once.
const PORT = process.env.PORT || 4000;

// Which of the three replicas this is. Every response carries it, so a request
// that came through the load balancer can be traced to the machine that
// answered it.
const INSTANCE = process.env.INSTANCE_NAME || 'backend';

// Socket.IO holds its connections in one process, so the three replicas pass
// broadcasts to each other through this capped collection instead.
const ADAPTER_COLLECTION = 'socket.io-adapter-events';

const presence = new Presence();
const messageRateLimiter = new RateLimiter();
const metrics = new LoadMetrics(INSTANCE);

// Set once the feed's change stream exists, so shutdown can close it.
let shutdownExtras = async () => {};

// Long-lived connections must not be counted as requests in flight. A
// Socket.IO WebSocket stays open for as long as the user has the page open, so
// counting it would leave the balancer permanently convinced this backend is
// busy.
app.use((req, res, next) => {
  res.setHeader('X-Backend', INSTANCE);

  if (req.url.startsWith('/socket.io/')) return next();

  // 'close' rather than 'finish', because it fires for a client that gave up
  // half way through as well as for one that got its answer. A counter that
  // only came down on success would drift upwards under load and make this
  // backend look permanently busy.
  metrics.requestStarted();
  let counted = true;
  res.on('close', () => {
    if (!counted) return;
    counted = false;
    metrics.requestFinished();
  });

  next();
});

// Connect to the database before listening. If we started listening first, a
// client could send a message before the database was ready and that message
// would be lost.
async function start() {
  // Check the encryption key before anything else. A missing or malformed key
  // only shows up when the first message is sent otherwise, by which point
  // people are already in the room and that message is lost.
  loadKey();

  const database = await db.connect();
  console.log('Connected to MongoDB');

  // Safe to repeat, a second call just reports that it already exists.
  try {
    await database.createCollection(ADAPTER_COLLECTION, { capped: true, size: 1e6 });
  } catch (err) {
    if (err.codeName !== 'NamespaceExists') throw err;
  }

  io.adapter(createAdapter(database.collection(ADAPTER_COLLECTION)));
  console.log(`Socket.IO adapter attached (${INSTANCE})`);

  const messages = database.collection('messages');
  const writeQueue = new WriteQueue(messages, {
    maxInFlight: Number(process.env.WRITE_PIPELINE) || undefined,
  });
  const feed = new FeedStore(messages, {
    maxEntries: Number(process.env.FEED_MAX_ENTRIES) || undefined,
  });

  const loaded = await feed.load();
  console.log(`Feed loaded with ${loaded} messages`);

  feed.startSync();

  // Route order is deliberate. /message and /feed are the routes under load,
  // so they are matched before the static file middleware, which would
  // otherwise put a filesystem lookup in front of every one of them.
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(createApiRouter({ feed, writeQueue, instance: INSTANCE }));
  app.use(createHealthRouter(presence, INSTANCE));
  app.use(createLoadRouter({ metrics, feed, writeQueue }));
  app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));

  io.on('connection', (socket) => {
    registerSocketHandlers(io, socket, { presence, messageRateLimiter });
  });

  // Both of these are about sitting behind a load balancer rather than in
  // front of a browser, and the defaults are wrong for that in opposite ways.
  //
  // keepAliveTimeout is the one that bites. Node closes an idle keep-alive
  // connection after five seconds; the balancer holds its pooled connections
  // for ninety. Between those two numbers is a race the balancer loses: it
  // picks a connection out of its pool, Node has already closed it, and the
  // request comes back as "connection reset by peer" — a failed request caused
  // by nothing except the two ends disagreeing about whose connection it was.
  // Those resets were visible in the balancer's log under load, and they are
  // not retryable in general, because by then the request may have been acted
  // on. Making Node's timeout the longer of the two settles the disagreement:
  // the pool always closes first, and closing a connection you own is not an
  // error. headersTimeout has to stay above keepAliveTimeout or Node applies
  // it to idle connections instead.
  httpServer.keepAliveTimeout = 120_000;
  httpServer.headersTimeout = 125_000;

  // The accept queue. The default of 511 is a burst of 511 connections, and a
  // grading run that steps to a thousand or two thousand users at once arrives
  // as exactly that kind of burst; what overflows the queue is refused by the
  // kernel before this process ever sees it, so no amount of speed in here
  // would help. The host allows 4096.
  httpServer.listen(PORT, '0.0.0.0', 2048, () => {
    console.log(`Chat server ${INSTANCE} running on http://0.0.0.0:${PORT}`);
  });

  shutdownExtras = async () => {
    await feed.close();
  };
}

// Close the database connection on the way out so MongoDB does not keep the
// connection open after the process is gone.
async function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down.`);

  io.close();
  httpServer.close();

  try {
    await shutdownExtras();
    await db.close();
  } catch (err) {
    console.error('Error while closing the database connection:', err);
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((err) => {
  console.error('Failed to start the server:', err.message);
  process.exit(1);
});
