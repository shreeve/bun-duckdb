// Async subpath — DuckDB on a Worker thread.
//
// `duckdb-bun/async` exposes the same API as the main package but runs
// every DuckDB call inside a Worker, keeping the Bun event loop free
// for HTTP / interactive workloads.
//
// Run:
//   bun examples/async.mjs

import { open } from '../lib/async/index.ts';

// `await using` is the right dispose pattern — the worker takes a few
// ms to drain on close, and we want to wait for that before the script
// exits.
await using db = open(':memory:');

console.log('opened (proxy only; worker spawns lazily on first awaited op)');
console.log('db.id before any op:', db.id);

const r = await db.get('SELECT 42 AS n');
console.log('SELECT 42 →', r);
console.log('db.id after first op:', db.id);

// All the v0.3 main-thread shortcuts work identically.
await db.exec('CREATE TABLE users (id INT, name VARCHAR)');
await db.run('INSERT INTO users VALUES (?, ?), (?, ?)',
             [1, 'Alice', 2, 'Bob']);

// Iteration runs over a pull-based per-chunk protocol. Each `iterNext`
// roundtrip carries one DuckDB vector (~2048 rows); the wrapper drains
// the chunk locally and yields rows one at a time. Prefetch (default 1)
// keeps one chunk in-flight while you process the previous.
for await (const row of db.iterate('SELECT * FROM users ORDER BY id')) {
  console.log('row:', row);
}

// Transactions allocate a fresh dedicated Connection on the worker so
// the callback's ops serialize on it without competing with other
// queries. The user's callback runs on the main thread; each op
// round-trips. Nested transactions throw DuckDBTransactionError on the
// proxy side without a worker roundtrip.
const got = await db.transaction(async (tx) => {
  await tx.exec('INSERT INTO users VALUES (3, \'Carol\')');
  await tx.exec('INSERT INTO users VALUES (4, \'Dan\')');
  return await tx.get('SELECT COUNT(*) AS n FROM users');
});
console.log('after transaction, count =', Number(got.n));

// Bulk insert — streaming appender. appendRow() is sync (matches the
// main-thread API); rows are batched (default 1000) and sent to the
// worker, which writes them to DuckDB via the Appender FFI. flush() /
// close() drain the buffer and surface any per-batch errors.
{
  using conn = db.connect();
  await conn.exec('CREATE TABLE measurements (ts TIMESTAMP, v DOUBLE)');
  const app = await conn.append('measurements', ['ts', 'v']);
  const t0 = Date.now();
  for (let i = 0; i < 100_000; i++) {
    app.appendRow([new Date(Date.now() + i), Math.random()]);
  }
  await app.close();
  console.log(`appender: 100k rows in ${Date.now() - t0}ms`);
  const c = await conn.get('SELECT COUNT(*) AS n FROM measurements');
  console.log('row count:', Number(c.n));
}

// Why use the async subpath: a long-running query no longer blocks
// other work on the main thread. Force a heavy join so DuckDB actually
// spends measurable CPU; meanwhile fire timers that prove the loop is
// free.
{
  const SQL = `
    SELECT count(*) AS n
    FROM range(200000) a, range(200) b
    WHERE (a.range + b.range) % 7 = 0
  `;
  const big = db.get(SQL);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  const r = await big;
  clearInterval(timer);
  console.log(
    `big query result: ${Number(r.n)} rows; main-thread ticks during ` +
    `query (5ms interval): ${ticks}`,
  );
}
