#!/usr/bin/env node
'use strict';

// Housekeeping for the chat database.
//
//   node cleanup.js stats             collection sizes, cheaply
//   node cleanup.js purge-loadtest    delete messages this project's load
//                                     generators produced
//   node cleanup.js indexes           list the indexes on messages
//
// purge-loadtest exists because a load test leaves its traffic in the room,
// and /feed returns the whole room. Left in place, a few hundred thousand
// generated messages would be shipped on every read for the rest of the
// deployment's life, which is both slow and dishonest about what the room
// contains.
//
// It only removes messages that came in over HTTP, which are the ones the load
// generators sent. Messages from the browser chat carry a signature and no
// source field, and are left alone.
//
// Deleting from the database is only half of it. Each back end serves /feed
// from its own in-memory copy of the room, and that copy is built from inserts,
// so it will keep returning messages this has deleted until the back end is
// restarted. Restart them afterwards, or the feed and the database will
// disagree about what the room contains.

const { MongoClient } = require('mongodb');

const DB_NAME = process.env.MONGODB_DB_NAME || 'csd_group_chat';
const HOST = process.env.MONGO_HOST || '127.0.0.1:27017';

async function main() {
  const command = process.argv[2];

  const client = new MongoClient(`mongodb://${HOST}/?directConnection=true`, {
    serverSelectionTimeoutMS: 10000,
  });

  await client.connect();
  const db = client.db(DB_NAME);
  const messages = db.collection('messages');

  try {
    if (command === 'stats') {
      // Estimated, not counted. countDocuments scans, and on a saturated
      // single core with a few hundred thousand documents that scan is slower
      // than anything this command is worth.
      for (const { name } of await db.listCollections().toArray()) {
        console.log(`  ${name}: ~${await db.collection(name).estimatedDocumentCount()}`);
      }

      console.log(`  messages over HTTP: ${await messages.countDocuments({ source: 'http' })}`);
      return;
    }

    if (command === 'indexes') {
      for (const index of await messages.indexes()) {
        console.log(`  ${index.name}: ${JSON.stringify(index.key)}${index.unique ? ' unique' : ''}`);
      }
      return;
    }

    if (command === 'purge-loadtest') {
      // Counted, not estimated. The estimate is collection metadata and goes
      // stale after exactly the kind of bulk delete this command performs, so
      // reporting it here once claimed this had emptied a collection that
      // still held every signed message in it.
      const before = await messages.countDocuments({});
      const result = await messages.deleteMany({ source: 'http' });
      const after = await messages.countDocuments({});

      console.log(`  deleted ${result.deletedCount} generated messages`);
      console.log(`  messages: ${before} -> ${after}`);
      console.log('  restart the back ends: their in-memory feed still holds these');
      return;
    }

    throw new Error(`unknown command: ${command}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
