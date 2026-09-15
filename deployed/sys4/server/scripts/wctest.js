const { MongoClient } = require('mongodb');
(async () => {
  const c = new MongoClient('mongodb://172.17.0.33:27017/?directConnection=true');
  await c.connect();
  const db = c.db('csd_group_chat');
  console.log('server default wc:', JSON.stringify(await db.admin().command({ getDefaultRWConcern: 1 })));
  const col = db.collection('wc_probe');
  await col.deleteMany({});
  for (const wc of [undefined, { w: 1, j: false }, { w: 1, j: true }, { w: 'majority' }]) {
    const t = [];
    for (let i = 0; i < 30; i++) {
      const s = process.hrtime.bigint();
      await col.insertOne({ i, wc: JSON.stringify(wc), pad: 'x'.repeat(200) }, wc ? { writeConcern: wc } : {});
      t.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
    t.sort((a, b) => a - b);
    console.log(JSON.stringify(wc ?? 'driver-default').padEnd(28), 'p50=', t[15].toFixed(2), 'ms  mean=', (t.reduce((a,b)=>a+b)/t.length).toFixed(2));
  }
  await col.drop();
  await c.close();
})().catch(e => { console.error(e); process.exit(1); });
