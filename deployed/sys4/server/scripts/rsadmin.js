#!/usr/bin/env node
'use strict';

// Small replica-set helper for the lab containers.
//
// The MongoDB tarball we install ships mongod but not mongosh, so the few
// administrative commands this deployment needs are issued through the Node
// driver instead. It is run on whichever container hosts mongod.
//
//   node rsadmin.js init <host:port>   initiate single-node replica set rs0
//   node rsadmin.js status             print the replica set state
//   node rsadmin.js counts             print document counts per collection
//   node rsadmin.js cache              print the cache size the server really has
//
// directConnection is essential: before rs.initiate() there is no replica set
// to discover, so a normal connection would spin looking for a primary.

const { MongoClient } = require('mongodb');

const SET_NAME = 'rs0';
const DB_NAME = process.env.MONGODB_DB_NAME || 'csd_group_chat';
const HOST = process.env.MONGO_HOST || '127.0.0.1:27017';

async function main() {
  const [command, argument] = process.argv.slice(2);
  const client = new MongoClient(`mongodb://${HOST}/?directConnection=true`, {
    serverSelectionTimeoutMS: 8000,
  });

  await client.connect();
  const admin = client.db('admin');

  try {
    if (command === 'init') {
      const member = argument || HOST;
      const result = await admin.command({
        replSetInitiate: {
          _id: SET_NAME,
          members: [{ _id: 0, host: member }],
        },
      });
      console.log(JSON.stringify(result));

      // Election takes a moment. Wait for it so the caller knows the set is
      // usable rather than merely configured.
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const state = await admin.command({ hello: 1 });
        if (state.isWritablePrimary) {
          console.log(`PRIMARY after ${i + 1}s: ${state.me}`);
          return;
        }
      }
      throw new Error('replica set did not elect a primary within 30s');
    }

    if (command === 'status') {
      const state = await admin.command({ replSetGetStatus: 1 });
      console.log(`set: ${state.set}`);
      for (const member of state.members) {
        console.log(`  ${member.name}  ${member.stateStr}`);
      }
      return;
    }

    if (command === 'cache') {
      // The configured cache size is not always the one that was asked for, so
      // read it back from the running server rather than from the command line.
      const status = await admin.command({ serverStatus: 1 });
      const cache = status.wiredTiger.cache;
      const configured = cache['maximum bytes configured'];
      const inUse = cache['bytes currently in the cache'];

      console.log(`  cache configured: ${(configured / 1048576).toFixed(0)} MB`);
      console.log(`  cache in use    : ${(inUse / 1048576).toFixed(0)} MB`);
      console.log(`  connections     : ${status.connections.current} of ${status.connections.available}`);
      console.log(`  resident        : ${status.mem.resident} MB`);
      return;
    }

    if (command === 'counts') {
      const db = client.db(DB_NAME);
      for (const { name } of await db.listCollections().toArray()) {
        console.log(`  ${name}: ${await db.collection(name).countDocuments()}`);
      }
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
