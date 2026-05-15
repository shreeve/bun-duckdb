// Prepared statement usage: prepare once, execute many times.
//
// For repeated queries with different parameter values, prepared
// statements skip the per-call SQL parse/plan and significantly
// outperform calling db.run(sql, params) in a loop.
//
// For *bulk insert* of many rows, see examples/appender.mjs which
// is faster still (skips SQL entirely).
//
// Run:
//   bun examples/prepared.mjs

import { open } from '../lib/duckdb.mjs';

using db = open(':memory:');

await db.exec(`
  CREATE TABLE events (
    id        INT,
    type      VARCHAR,
    timestamp TIMESTAMP,
    payload   VARCHAR
  )
`);

// INSERT 10,000 rows via prepared statement
{
  using stmt = await db.prepare(
    'INSERT INTO events VALUES (?, ?, ?, ?)'
  );
  const t0 = Date.now();
  for (let i = 0; i < 10_000; i++) {
    await stmt.run([
      i,
      i % 2 === 0 ? 'click' : 'view',
      new Date(Date.now() + i * 1000),
      `payload-${i}`,
    ]);
  }
  console.log(`prepared INSERTs: 10000 rows in ${Date.now() - t0}ms`);
}

// SELECT with prepared statement, reusing across calls
{
  using stmt = await db.prepare(
    'SELECT COUNT(*) AS n FROM events WHERE type = ?'
  );
  const clicks = await stmt.get(['click']);
  const views  = await stmt.get(['view']);
  console.log(`clicks: ${clicks.n}, views: ${views.n}`);
}

// Transactions — atomic units of work
const result = await db.transaction(async (tx) => {
  await tx.run('UPDATE events SET payload = ? WHERE id < ?', ['updated', 100]);
  await tx.run('DELETE FROM events WHERE id >= ?', [9_900]);
  const after = await tx.get('SELECT COUNT(*) AS n FROM events');
  return after.n;
});
console.log(`after transaction: ${result} rows`);

// using db = ...  → db.close() runs automatically when this scope exits
