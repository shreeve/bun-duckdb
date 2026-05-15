// Streaming results via Statement.iterate() — v0.3+.
//
// For large result sets (more than a few thousand rows), iterate() lets
// you process rows as they come off the wire, without materializing the
// full result in memory. Each chunk is fetched and decoded lazily; the
// consumer drives the pace.
//
// Run:
//   bun examples/iterate.mjs

import { open } from '../lib/duckdb.mjs';

// `await using` (Symbol.asyncDispose) is the recommended dispose pattern
// for the streaming era — it waits for iterator cleanup before db.close()
// returns. Plain `using` (Symbol.dispose) still works but is fire-and-
// forget.
await using db = open(':memory:');

// Set up some data.
await db.exec('CREATE TABLE events (id INT, type VARCHAR, payload VARCHAR)');
{
  using conn = db.connect();
  const rows = [];
  for (let i = 0; i < 10_000; i++) {
    rows.push([i, i % 2 === 0 ? 'click' : 'view', `payload-${i}`]);
  }
  await conn.append('events', ['id', 'type', 'payload'], rows);
}

// --- Pattern 1: Statement.iterate ----------------------------------------
//
// Reusable iteration: prepare once, iterate many times (re-bind params).

{
  using stmt = await db.prepare('SELECT id, payload FROM events WHERE type = ? ORDER BY id');
  let clickCount = 0;
  for await (const row of stmt.iterate(['click'])) {
    clickCount++;
    if (clickCount >= 3) break;        // early `break` releases the lock
  }
  console.log(`saw ${clickCount} click rows (stopped early)`);
}

// --- Pattern 2: Database.iterate sugar -----------------------------------
//
// One-shot iteration. The temp Statement is prepared lazily on first
// .next() and closed in `finally`, so abandoning the iterator before
// consuming is zero-cost.

{
  let total = 0n;
  for await (const row of db.iterate('SELECT id FROM events WHERE id < 100')) {
    total += BigInt(row.id);
  }
  console.log(`sum of ids 0..99 = ${total}`);
}

// --- Pattern 3: Connection.iterate, parallel streams ---------------------
//
// Each Connection has its own lock, so two connections can stream
// independently. The default Database connection holds the global
// implicit conn; for parallelism call db.connect() to get a fresh one.

{
  using a = db.connect();
  using b = db.connect();
  const [clickCount, viewCount] = await Promise.all([
    countWhere(a, 'click'),
    countWhere(b, 'view'),
  ]);
  console.log(`clicks=${clickCount}, views=${viewCount}`);
}

async function countWhere(conn, type) {
  let n = 0;
  for await (const _row of conn.iterate('SELECT id FROM events WHERE type = ?', [type])) {
    n++;
  }
  return n;
}
