const { MongoClient } = require('mongodb');

const DEFAULT_DB_NAME = 'csd_group_chat';

let client = null;
let db = null;

// Reads the connection string from the environment.
// There is no default on purpose: a wrong default would quietly write messages
// to the wrong place instead of telling us something is missing.
function readUri() {
  const uri = String(process.env.MONGODB_URI || '').trim();

  if (!uri) {
    throw new Error(
      'MONGODB_URI is not set. Copy server/.env.example to server/.env and put your ' +
        'MongoDB connection string in it. See README.md for the setup steps.'
    );
  }

  return uri;
}

// Opens the connection and prepares the collections.
// Call this once at startup, before the server starts accepting clients.
async function connect() {
  if (db) return db;

  const uri = readUri();
  const dbName = String(process.env.MONGODB_DB_NAME || '').trim() || DEFAULT_DB_NAME;

  client = new MongoClient(uri, {
    // Give up after 10 seconds instead of hanging, so a wrong address or a
    // database that is not running shows up as an error right away.
    serverSelectionTimeoutMS: 10000,
    // Three back ends share one mongod on a single core inside a 512 MB
    // container, and every connection costs that container memory it does not
    // have. Sixteen each was enough to help push mongod to 442 MB and get it
    // OOM-killed mid-run. Six each is plenty, because writes are batched before
    // they reach here: a back end doing five hundred inserts a second sends
    // them as a handful of bulk writes, not five hundred.
    maxPoolSize: Number(process.env.MONGODB_POOL_SIZE) || 6,
    minPoolSize: 1,

    // Acknowledge a write once the primary holds it, rather than once it has
    // been flushed to the journal.
    //
    // This is the single largest source of latency in the whole deployment and
    // it is not the application's work at all, it is waiting. MongoDB 5.0 and
    // later default to w:"majority", and on a replica set majority implies the
    // journal, so every write waits for the next journal commit. WiredTiger
    // commits the journal every 100 ms, so an insert costs on average half of
    // that whatever else is going on. Measured against this mongod, over
    // thirty inserts each:
    //
    //   driver default (w:majority)   p50 25.0 ms   mean 47.6 ms
    //   { w: 1, j: true }             p50 33.8 ms   mean 33.7 ms
    //   { w: 1, j: false }            p50  4.0 ms   mean  5.2 ms
    //
    // and because the write queue only keeps a few bulk writes in flight at a
    // time, that per-batch wait is also what sets how fast the queue drains,
    // so it showed up multiplied in the response times under load rather than
    // as a flat 25 ms.
    //
    // What is given up is a 100 ms window: if mongod is killed outright, the
    // writes acknowledged in that window and not yet journalled are lost. This
    // is a single-node replica set, so w:"majority" is one node and buys no
    // replication either way; the whole cost of the default here is the
    // journal wait. Everything else about persistence is unchanged - messages
    // are still stored in MongoDB on disk, still uniquely indexed by msgId,
    // and a 200 still means the database has the message, not that it has been
    // queued somewhere.
    writeConcern: { w: 1, j: false },
  });

  await client.connect();
  db = client.db(dbName);

  await createIndexes(db);

  return db;
}

// Indexes we rely on. Creating them is safe to repeat: MongoDB ignores the
// call if the index already exists.
async function createIndexes(database) {
  const messages = database.collection('messages');

  // History is always read for one room, oldest first, so index both fields
  // together in that order.
  await messages.createIndex({ roomId: 1, _id: 1 });

  // Every message carries a unique id of its own, and this index is what makes
  // "no duplicates" a property of the database rather than a promise made by
  // the application. A retried request, a reconnecting client or a request the
  // load balancer replays onto a second backend all arrive carrying the same
  // id, and the second write is refused with a duplicate key error.
  //
  // The filter is there because messages written before this field existed
  // have no msgId. Without it they would all count as the same null key and
  // only the first of them could survive.
  await messages.createIndex(
    { msgId: 1 },
    {
      unique: true,
      name: 'msgId_unique',
      partialFilterExpression: { msgId: { $type: 'string' } },
    }
  );
}

// Returns the open database. Throws if connect() has not finished yet, which
// means we would otherwise be reading from nothing.
function getDb() {
  if (!db) {
    throw new Error('Database is not connected yet. Call connect() first.');
  }

  return db;
}

async function close() {
  if (!client) return;

  await client.close();
  client = null;
  db = null;
}

module.exports = { connect, getDb, close, DEFAULT_DB_NAME };
