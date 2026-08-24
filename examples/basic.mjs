// Basic usage: open an in-memory database, run a query, close.
//
// Uses the v0.2 Database shortcuts (db.exec/db.run/db.all/db.get) and
// `using` syntax so cleanup happens automatically.
//
// Run:
//   bun examples/basic.mjs

import { open, version } from '../lib/duckdb.ts';

console.log(`DuckDB ${version()}`);

using db = open(':memory:');

await db.exec('CREATE TABLE users (id INT, name VARCHAR)');

const ins = await db.run('INSERT INTO users VALUES (?, ?), (?, ?)',
                         [1, 'Alice', 2, 'Bob']);
console.log(`inserted ${ins.rowsChanged} rows`);

// Get all rows. The result IS an Array; .columns and .rowsChanged are
// attached as side properties.
const rows = await db.all('SELECT * FROM users ORDER BY id');
for (const row of rows) {
  console.log(row);                 // { id: 1, name: 'Alice' }, etc.
}
console.log(`columns:`, rows.columns);

// Get a single row, or undefined if no rows match
const one = await db.get('SELECT * FROM users WHERE id = ?', [1]);
console.log(`one:`, one);

const none = await db.get('SELECT * FROM users WHERE id = ?', [99]);
console.log(`none:`, none);          // undefined

// db.close() runs automatically when the `using` scope exits.
