// Bulk insert via DuckDB's Appender API — the fastest path for loading
// many rows. Skips SQL parsing per row and writes directly into the
// column-store format DuckDB uses internally.
//
// Run:
//   bun examples/appender.mjs

import { open } from '../lib/duckdb.mjs';

const db = open(':memory:');
const conn = db.connect();

await conn.query(`
  CREATE TABLE measurements (
    ts        TIMESTAMP,
    sensor_id INTEGER,
    value     DOUBLE
  )
`);

// Generate 100k rows
const rows = [];
for (let i = 0; i < 100_000; i++) {
  rows.push([new Date(Date.now() + i), i % 10, Math.random()]);
}

// One Appender call inserts all of them
const before = Date.now();
const result = await conn.append(
  'measurements',
  ['ts', 'sensor_id', 'value'],
  rows,
);
const elapsed = Date.now() - before;

console.log(`Inserted ${result.rows} rows in ${elapsed}ms`);

// Verify (query() returns the rows array directly)
const count = await conn.query('SELECT COUNT(*) AS n FROM measurements');
console.log(count);             // [{ n: 100000n }]

conn.close();
db.close();
