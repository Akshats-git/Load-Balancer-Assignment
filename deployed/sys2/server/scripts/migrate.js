#!/usr/bin/env node
'use strict';

// Copies the chat collections from one mongod to another.
//
// Used once, to move the database off Sys1. Sys1 also hosts an unrelated
// service and its 512 MB cgroup had already OOM-killed mongod, so the database
// now lives on Sys4 where there is room for it.
//
//   node migrate.js <source host:port> <target host:port>
//
// Only the collections that hold real state are copied. The Socket.IO adapter
// collection is a capped broadcast channel that both servers recreate on
// startup, so copying it would move nothing but stale events.
//
// Documents are read and written through the driver without going via JSON, so
// Binary fields (ciphertext, nonce, signature, public key) keep their types
// instead of turning into strings. Writes are unordered and duplicate _id
// errors are ignored, which makes the copy safe to run twice.

const { MongoClient } = require('mongodb');

const DB_NAME = process.env.MONGODB_DB_NAME || 'csd_group_chat';
const COLLECTIONS = ['messages', 'senders'];
const BATCH = 500;

function open(hostPort) {
  return new MongoClient(`mongodb://${hostPort}/?directConnection=true`, {
    serverSelectionTimeoutMS: 8000,
  });
}

async function copyCollection(source, target, name) {
  const cursor = source.collection(name).find({});
  const destination = target.collection(name);

  let read = 0;
  let written = 0;
  let skipped = 0;
  let batch = [];

  async function flush() {
    if (batch.length === 0) return;

    try {
      const result = await destination.insertMany(batch, { ordered: false });
      written += result.insertedCount;
    } catch (err) {
      // A duplicate _id means that document is already there, which is the
      // expected outcome of a second run. Anything else is a real failure.
      const duplicates = (err.writeErrors || []).filter((e) => e.code === 11000);
      if (duplicates.length !== (err.writeErrors || []).length) throw err;

      written += err.result ? err.result.insertedCount : 0;
      skipped += duplicates.length;
    }

    batch = [];
  }

  for await (const document of cursor) {
    read += 1;
    batch.push(document);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  console.log(`  ${name}: read ${read}, inserted ${written}, already present ${skipped}`);
}

async function main() {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    console.error('usage: migrate.js <source host:port> <target host:port>');
    process.exit(1);
  }

  const sourceClient = open(from);
  const targetClient = open(to);

  await sourceClient.connect();
  await targetClient.connect();

  console.log(`copying ${DB_NAME} from ${from} to ${to}`);

  try {
    for (const name of COLLECTIONS) {
      await copyCollection(sourceClient.db(DB_NAME), targetClient.db(DB_NAME), name);
    }
  } finally {
    await sourceClient.close();
    await targetClient.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
