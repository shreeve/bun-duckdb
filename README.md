# bun-duckdb

> Efficient DuckDB driver for Bun, using pure FFI

A Bun-native binding to DuckDB's modern C API. No native modules. No
node-gyp. No N-API marshaling. The driver dlopens `libduckdb` directly
through `bun:ffi` and uses DuckDB's chunk-based result API for
column-store reads with minimal overhead.

```js
import { open } from 'bun-duckdb';

using db = open(':memory:');                     // closes automatically

await db.exec('CREATE TABLE users (id INT, name VARCHAR)');
await db.run('INSERT INTO users VALUES (?, ?), (?, ?)',
             [1, 'Alice', 2, 'Bob']);

const rows = await db.all('SELECT * FROM users ORDER BY id');
//   → [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]

const one = await db.get('SELECT * FROM users WHERE id = ?', [1]);
//   → { id: 1, name: 'Alice' }
```

For repeated execution, use prepared statements:

```js
using stmt = await db.prepare('INSERT INTO users VALUES (?, ?)');
for (const [id, name] of users) await stmt.run([id, name]);
```

For atomic units of work, use transactions:

```js
await db.transaction(async (tx) => {
  await tx.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [100, 'A']);
  await tx.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [100, 'B']);
});  // BEGIN before, COMMIT after; ROLLBACK + rethrow on any throw
```

## Why

| Existing option | Problem |
|---|---|
| `@duckdb/node-api` (official, N-API) | Native build required, value-by-value marshaling overhead, verbose API |
| `@duckdb/duckdb-wasm` | Browser-only |
| `node-duckdb` (older) | Abandoned |

`bun-duckdb` is built around four properties Bun developers actually want:

- **Pure FFI, no native build.** `bun add bun-duckdb` installs a
  ~50 KB JS file. No `gyp` step, no platform binaries to compile. The
  only native dependency is `libduckdb` itself, which you install once
  via your package manager (`brew install duckdb`,
  `apt install libduckdb-dev`, etc.).
- **Modern chunk-based API.** Each `query()` reads results as
  vector-batched chunks (typically 2048 rows per chunk) directly from
  DuckDB's column store via `Bun.ffi.read`, avoiding the per-value
  N-API roundtrips that make older Node bindings slow.
- **Bun-native, not a Node compatibility shim.** Uses `bun:ffi`
  directly. No emulation layer, no Node FFI quirks.
- **Working on Linux x86_64.** Bun's FFI has two real bugs that bite
  any C library wrapper: opaque-handle-as-`'ptr'` arguments get
  corrupted (segfault at `0xFFFFFFFFFFFFFFFF`), and structs-by-value
  cannot be passed at all on the SysV AMD64 ABI. This driver works
  around both — handles flow as `'u64'`/BigInt, and a tiny C shim
  wraps the three by-value DuckDB functions. Hard-won knowledge that
  isn't documented anywhere else publicly. See
  [AGENTS.md](./AGENTS.md) for the full story.

## Install

```bash
bun add bun-duckdb
```

You also need `libduckdb` (the DuckDB shared library) installed
somewhere `bun-duckdb` can find it. Common locations checked
automatically:

```
macOS:    /opt/homebrew/lib/libduckdb.dylib
          /usr/local/lib/libduckdb.dylib
          /usr/lib/libduckdb.dylib

Linux:    /usr/lib/libduckdb.so
          /usr/local/lib/libduckdb.so
          /usr/lib/x86_64-linux-gnu/libduckdb.so
          /usr/lib/aarch64-linux-gnu/libduckdb.so

Windows:  C:\Program Files\DuckDB\duckdb.dll
          duckdb.dll  (in PATH)
```

Override with `DUCKDB_LIB_PATH=/your/path/libduckdb.so`.

### Installing libduckdb

```bash
# macOS
brew install duckdb

# Debian/Ubuntu
sudo apt install libduckdb-dev

# Fedora/RHEL
sudo dnf install libduckdb

# Or download a release directly:
#   https://github.com/duckdb/duckdb/releases
```

### Linux x86_64: build the FFI shim

On Linux x86_64 only, you must also build a tiny C shim
(`libduckdb-shim.so`) once. This works around a Bun FFI limitation —
see [AGENTS.md § FFI Bug 2](./AGENTS.md#bug-2-struct-by-value-passing-is-impossible).

```bash
cd node_modules/bun-duckdb/lib
make            # produces libduckdb-shim.so next to libduckdb.so search paths
sudo make install   # optional: installs to /usr/local/lib/
```

Override the shim location with `DUCKDB_SHIM_PATH=/your/path/libduckdb-shim.so`.

On macOS arm64 the shim is built as `libduckdb-shim.dylib` but the
driver also has a non-shim fallback that happens to work on that
platform — building the shim is recommended but not required.

## Quick start

```js
import { open, version } from 'bun-duckdb';

console.log(version());  // → DuckDB version string

const db = open(':memory:');     // or open('mydata.duckdb') for on-disk
const conn = db.connect();

// Simple query, no parameters
const a = await conn.query('SELECT 42 AS answer');

// Parameterized query — '?' placeholders
const b = await conn.query('SELECT ? + ? AS sum', [3, 4]);

// DDL + DML
await conn.query('CREATE TABLE users (id INTEGER, name VARCHAR)');
const ins = await conn.query(
  'INSERT INTO users VALUES (?, ?), (?, ?)',
  [1, 'Alice', 2, 'Bob'],
);
console.log(`inserted ${ins.rowsChanged} rows`);

const rows = await conn.query('SELECT * FROM users ORDER BY id');
for (const row of rows) {
  console.log(row);  // { id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }
}

conn.close();
db.close();
```

For bulk insert see [`examples/appender.mjs`](./examples/appender.mjs).

> **Note: `conn.query()` returns a Promise.** The driver serializes
> FFI calls through an internal async lock to keep concurrent calls
> on a single Connection safe. The return value is awaitable.
> A future version may also expose a sync API to match
> `better-sqlite3` / `bun:sqlite` conventions — see Roadmap.

## API reference

### `open(path) → Database`

Opens (or creates) a DuckDB database at `path`. Pass `':memory:'` for
an in-memory database.

```js
const db = open(':memory:');
const db = open('analytics.duckdb');
```

Throws if DuckDB rejects the path.

### `version() → string`

Returns the version of the loaded `libduckdb` (e.g. `'v1.5.2'`).

### `Database`

A `Database` lazily creates one default `Connection` on first use of
the shortcut methods (`query`, `all`, `get`, `run`, `exec`, `prepare`,
`transaction`). For parallelism or scoped lifetimes, call
`db.connect()` for an independent `Connection`.

| Method | Returns | Description |
|---|---|---|
| `db.query(sql, params?)` | `Promise<QueryResult<T>>` | Execute via the implicit Connection. |
| `db.all(sql, params?)` | `Promise<QueryResult<T>>` | Alias of `query`. |
| `db.get(sql, params?)` | `Promise<T \| undefined>` | First row, or undefined. |
| `db.run(sql, params?)` | `Promise<{ rowsChanged }>` | Execute for side effects (DML/DDL). |
| `db.exec(sql)` | `Promise<void>` | Fire-and-forget multi-statement; no params, no rows. |
| `db.prepare(sql)` | `Promise<Statement<T>>` | Returns a reusable `Statement`. Caller closes it. |
| `db.transaction(fn)` | `Promise<R>` | BEGIN before, COMMIT after success, ROLLBACK + rethrow on throw. |
| `db.connect()` | `Connection` | A fresh, independent Connection. |
| `db.close()` | `void` (sync) | Closes the database and the implicit Connection. Idempotent. |
| `db[Symbol.dispose]()` | `void` | Same as `close()`. Enables `using db = open(...)`. |

### `Connection`

`Connection` exposes the same shortcut methods as `Database`, plus the
underlying lifecycle and bulk-insert primitives. Multiple Connections
on one Database run independently — use them for parallelism.

| Method | Returns | Description |
|---|---|---|
| `conn.query(sql, params?)` | `Promise<QueryResult<T>>` | Execute. Internally one-shot for no params; prepared+execute+destroy if params given. |
| `conn.all/get/run/exec/prepare/transaction` | (same as `Database`) | Shortcuts mirror `Database`. |
| `conn.append(table, columns, rows)` | `Promise<{ rows: number }>` | Bulk insert via DuckDB's Appender API. Fastest path for loading many rows. See [`examples/appender.mjs`](./examples/appender.mjs). |
| `conn.executeBatchPrepared(sql, batches)` | `Promise<{ rows: number }>` | Advanced: execute one prepared statement multiple times with batched parameter sets. |
| `conn.countStatements(sql)` | `number` (sync) | Parses `sql`; returns the number of statements without executing. Throws on parse failure. |
| `conn.close()` | `void` (sync) | Closes the connection. Idempotent. |
| `conn[Symbol.dispose]()` | `void` | Same as `close()`. |
| `conn.handle` | `bigint \| null` | Internal: handle to the underlying `duckdb_connection`. |

### `Statement`

A reusable prepared statement. Created via `db.prepare(sql)` or
`conn.prepare(sql)`. Holds the prepared handle until `close()` is
called. Reuse the same statement across many executions for
significant savings vs `query(sql, params)` which re-prepares each
time.

```js
using stmt = await db.prepare('INSERT INTO t (id, name) VALUES (?, ?)');
for (const [id, name] of rows) await stmt.run([id, name]);
```

| Method | Returns | Description |
|---|---|---|
| `stmt.all(params?)` | `Promise<QueryResult<T>>` | Bind, execute, return all rows. |
| `stmt.get(params?)` | `Promise<T \| undefined>` | First row, or undefined. |
| `stmt.run(params?)` | `Promise<{ rowsChanged }>` | Execute for side effects. |
| `stmt.close()` | `void` (sync) | Free the prepared handle. Idempotent. |
| `stmt[Symbol.dispose]()` | `void` | Same as `close()`. |
| `stmt.closed` | `boolean` | True after close. Subsequent calls throw `DuckDBClosedError`. |

Parameters are positional **arrays** — `[1, 'foo']`, not
`(1, 'foo')`. This avoids ambiguity with DuckDB `LIST` values.

### Errors

All driver errors extend `DuckDBError`. Specific subclasses identify
common failure modes:

| Class | When it's thrown |
|---|---|
| `DuckDBError` | Generic driver error (DuckDB returned an error message) |
| `DuckDBClosedError` | Use of a closed Database/Connection/Statement |
| `DuckDBPrepareError` | `prepare()` failed (typically a SQL syntax error) |
| `DuckDBTransactionError` | Nested transactions (planned for v0.3 via SAVEPOINT) |

```js
import { DuckDBError, DuckDBClosedError } from 'bun-duckdb';

try {
  await stmt.run([1]);
} catch (e) {
  if (e instanceof DuckDBClosedError) {
    // Statement was closed before this call
  } else if (e instanceof DuckDBError) {
    // Other DuckDB-side failure
  }
}
```

### Result shape

`conn.query()` resolves to an **Array of row objects** with two
extra properties attached:

```js
const rows = await conn.query('SELECT id, name FROM users');

rows               // [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]
rows.length        // 2
rows[0]            // { id: 1, name: 'Alice' }

rows.columns       // [
                   //   { name: 'id',   type: 4, typeName: 'INTEGER' },
                   //   { name: 'name', type: 25, typeName: 'VARCHAR' },
                   // ]

rows.rowsChanged   // 0n  (BigInt; non-zero only for DML)
```

The array IS the rows — no nested `rows` property. Iterate directly,
spread into `[...rows]`, etc. Treat `.columns` and `.rowsChanged` as
metadata on the side.

For INSERT/UPDATE/DELETE the array is empty and `.rowsChanged` is
the number of affected rows (as `BigInt` — DuckDB returns this as
`uint64`, which is wider than `Number.MAX_SAFE_INTEGER`).

### Type mapping

| DuckDB type | JavaScript value |
|---|---|
| `BOOLEAN` | `boolean` |
| `TINYINT`, `SMALLINT`, `INTEGER` | `number` |
| `UTINYINT`, `USMALLINT`, `UINTEGER` | `number` |
| `BIGINT`, `UBIGINT` | `bigint` |
| `HUGEINT`, `UHUGEINT` | `bigint` (when in safe range; may overflow for very large values) |
| `FLOAT`, `DOUBLE` | `number` |
| `DECIMAL` | `number` (precision-aware; very large values may lose precision — see Roadmap for upcoming `string` mode) |
| `VARCHAR`, `CHAR` | `string` |
| `BLOB` | `Uint8Array` |
| `DATE` | `Date` (UTC midnight) |
| `TIME`, `TIME_TZ`, `TIME_NS` | `string` (ISO time) |
| `TIMESTAMP`, `TIMESTAMP_TZ`, `TIMESTAMP_MS`, `TIMESTAMP_SEC` | `Date` |
| `TIMESTAMP_NS` | `Date` (truncated to millisecond precision) |
| `INTERVAL` | `{ months, days, micros }` |
| `UUID` | `string` (canonical 8-4-4-4-12 form) |
| `LIST`, `ARRAY` | `Array` |
| `STRUCT` | object |
| `MAP` | `Map` |
| `ENUM` | `string` |
| `NULL` | `null` |

`DUCKDB_TYPE` is exported as a frozen object mapping type names to
DuckDB's internal integer IDs, useful when introspecting `result.columns`.

### Parameter binding

Use `?` placeholders. Values are mapped to DuckDB types automatically:

| JS value | Bound as |
|---|---|
| `null`, `undefined` | `NULL` |
| `boolean` | `BOOLEAN` |
| Integer `number` (and within int32 range) | `INTEGER` |
| Other `number` | `DOUBLE` |
| `bigint` | `BIGINT` |
| `string` | `VARCHAR` |
| `Uint8Array` / `ArrayBuffer` | `BLOB` |
| `Date` | `TIMESTAMP` |

For typed parameters beyond what auto-detection picks, use explicit
SQL casts: `'SELECT CAST(? AS UINTEGER)'`.

## Performance notes

- **Chunk-based reading.** Result vectors are read directly via
  `Bun.ffi.read.u8/i32/u64/...` against the chunk's underlying memory.
  This avoids per-value N-API/FFI overhead — the driver crosses the
  FFI boundary once per chunk (typically 2048 rows), not once per
  value.
- **Appender is dramatically faster than parameterized INSERT.** For
  loading thousands+ rows, use `conn.append(...)` instead of looping
  on `INSERT VALUES (?, ?, ...)`.
  - On a 2024 M-series Mac: **100,000 rows inserted in ~46ms**
    (TIMESTAMP + INTEGER + DOUBLE columns) via Appender vs many
    seconds for the equivalent loop of single-row INSERTs.
- **Internal serialization lock.** Concurrent calls into a single
  `Connection` are serialized through a JS-level promise lock to
  match DuckDB's per-connection threading model. Use multiple
  `Connection`s (`db.connect()` returns a fresh one each time) for
  parallelism.
- **FFI calls are synchronous, the public API is async.** Each
  `query()` returns a Promise that resolves once the (synchronous)
  FFI work completes. The Promise interface is the serialization
  mechanism, not a true off-thread runner — long-running analytical
  queries still block the Bun event loop while they execute. For a
  truly off-thread interface, use a Web Worker today, or wait for
  the forthcoming `bun-duckdb/async` subpath. See Roadmap.

## Examples

- [`examples/basic.mjs`](./examples/basic.mjs) — `using db = open(...)`, db.exec/run/all/get, parameters
- [`examples/prepared.mjs`](./examples/prepared.mjs) — prepared statements, transactions, real timings
- [`examples/appender.mjs`](./examples/appender.mjs) — 100k bulk insert via the Appender API

## Roadmap

### v0.2.0 — shipped (current release)

- [x] `db.query/all/get/run/exec` shortcuts on `Database` (lazy
      implicit `Connection`)
- [x] `db.prepare(sql)` and `conn.prepare(sql)` returning a reusable
      `Statement` with `.all/get/run/close`
- [x] `db.transaction(fn)` helper — BEGIN, COMMIT, ROLLBACK on throw
- [x] `Symbol.dispose` on `Database`, `Connection`, `Statement` for
      `using db = open(...)` / `using stmt = await db.prepare(...)`
- [x] TypeScript declarations (`lib/duckdb.d.ts`) shipped, generic
      row types via `db.query<T>(sql)`
- [x] Named error classes: `DuckDBError`, `DuckDBClosedError`,
      `DuckDBPrepareError`, `DuckDBTransactionError`

### v0.3.0 — planned

- [ ] `Statement.iterate(params?)` returning `AsyncIterable<T>` for
      streaming large result sets without materialization
- [ ] `conn.chunks(sql, params?)` exposing raw chunk iteration for
      maximum efficiency on multi-million-row results
- [ ] Nested transactions via `SAVEPOINT` (currently throws
      `DuckDBTransactionError`)
- [ ] `db.installExtension(name)` / `db.loadExtension(name)` thin
      helpers (equivalent to SQL but discoverable from the docs)
- [ ] Configurable type conversion — opt-in `DECIMAL → string` mode
      to preserve precision past 15 digits

### v0.4.0 — `bun-duckdb/async` (Worker-backed)

- [ ] `import { open } from 'bun-duckdb/async'` — same API surface
      but runs DuckDB in a Worker so analytical queries don't block
      the main event loop
- [ ] `AbortSignal` support backed by `duckdb_interrupt()`

### v1.0.0 — stable API

- API freeze
- Comprehensive docs site
- Optional companion packages: `bun-duckdb-kysely` (dialect),
  `bun-duckdb-drizzle` (adapter)

### Explicitly not planned

- Query builder
- Models / repositories / Active Record
- Migrations
- Schema introspection beyond what DuckDB's `PRAGMA show_tables` /
  `DESCRIBE` already gives you
- Connection pooling — DuckDB is in-process, pooling is the wrong
  shape

The driver stays a driver. Higher layers belong in separate packages.

## Building from source

```bash
git clone https://github.com/shreeve/bun-duckdb
cd bun-duckdb
bun install                  # no deps actually, just for lockfile
bun test                     # requires libduckdb installed
make -C lib                  # builds libduckdb-shim for current platform
```

## Testing

```bash
bun test
```

Tests are skipped automatically if `libduckdb` is not installed (the
import fails and the test suite no-ops with `describe.skip`).

## Compatibility

- **Bun:** ≥ 1.0
- **DuckDB:** any modern release with the chunk API (≥ v0.10
  recommended; tested against v1.5.x)
- **Platforms:** macOS arm64, macOS x64, Linux x64 (with shim),
  Linux arm64, Windows x64 (libduckdb required on PATH or via
  `DUCKDB_LIB_PATH`)

## Related

- [DuckDB](https://duckdb.org/) — the database
- [DuckDB C API docs](https://duckdb.org/docs/api/c/overview)
- [Bun FFI docs](https://bun.sh/docs/api/ffi)

## License

MIT © Steve Shreeve
