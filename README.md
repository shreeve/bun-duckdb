# duckdb-bun

[![npm version](https://img.shields.io/npm/v/duckdb-bun.svg)](https://www.npmjs.com/package/duckdb-bun)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun ≥1.0](https://img.shields.io/badge/Bun-%E2%89%A51.0-black?logo=bun)](https://bun.sh)
[![DuckDB](https://img.shields.io/badge/DuckDB-%E2%89%A51.0-yellow?logo=duckdb)](https://duckdb.org)
[![CI](https://github.com/shreeve/duckdb-bun/actions/workflows/test.yml/badge.svg)](https://github.com/shreeve/duckdb-bun/actions/workflows/test.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-3178C6?logo=typescript)](./lib/duckdb.d.ts)

> Efficient DuckDB driver for Bun, using pure FFI

A Bun-native binding to DuckDB's modern C API. No native modules. No
node-gyp. No N-API marshaling. The driver dlopens `libduckdb` directly
through `bun:ffi` and uses DuckDB's chunk-based result API for
column-store reads with minimal overhead.

```bash
bun add duckdb-bun
brew install duckdb        # or: apt install libduckdb-dev
```

```js
import { open } from 'duckdb-bun';

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

For large result sets, stream row-by-row without materializing in memory:

```js
await using db = open(':memory:');            // async dispose: waits for iterator cleanup

for await (const row of db.iterate('SELECT * FROM big_table')) {
  if (row.id > 10_000) break;                 // break / throw cleanly disposes the stream
}
```

For HTTP servers and interactive workloads, run DuckDB on a Worker thread
via the `duckdb-bun/async` subpath. Identical API surface, but every
query runs off the main event loop, so the loop stays responsive:

```js
import { open } from 'duckdb-bun/async';      // note: /async subpath

await using db = open(':memory:');            // sync proxy; worker spawns lazily

await db.exec('CREATE TABLE users (id INT, name VARCHAR)');
const rows = await db.all('SELECT * FROM users');

// While a heavy query runs, the main event loop stays free:
const big = db.get('SELECT count(*) FROM range(1500000) a, range(80) b WHERE (a.range + b.range) % 7 = 0');
const t = setInterval(() => console.log('tick'), 100);   // these still fire on time
await big;
clearInterval(t);
```

See [`examples/async.mjs`](./examples/async.mjs) for the full surface.

> **Cancellation note (v0.5.x):** `AbortSignal` per-query cancellation
> is planned for v0.6.0 on the async subpath only. The architecture is
> proven (main thread calls `duckdb_interrupt` on the worker's
> connection handle while the worker is blocked in FFI; interrupt
> latency ~2ms). Until v0.6, the safety valve for hung queries is
> `db.close({ timeout: ms })`, which terminates the whole Worker —
> not a per-request primitive. The synchronous `duckdb-bun` API will
> **not** get `AbortSignal` (sync FFI blocks the JS thread that would
> receive the event); use `duckdb-bun/async` if you need cancellation.

## Why

### Which package should I use?

| You're on... | You want... | Use |
|---|---|---|
| **Bun** | Embedded DuckDB, zero install friction | **`duckdb-bun`** (this package) |
| **Bun** | A query builder layered on top | `duckdb-bun` + Kysely/Drizzle (when those add support) |
| **Bun** | Multi-tenant DuckDB via HTTP | `duckdb-bun` + a thin HTTP wrapper, or [duckdb-harbor] (separate project) |
| **Node** | Embedded DuckDB | [`@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api) (official) |
| **Browser** | DuckDB in WebAssembly | [`@duckdb/duckdb-wasm`](https://www.npmjs.com/package/@duckdb/duckdb-wasm) |

[duckdb-harbor]: https://github.com/shreeve/duckdb-harbor

### Why this over alternatives on Bun

| Option | Problem on Bun |
|---|---|
| `@duckdb/node-api` (official, N-API) | Native build required (node-gyp install dance), value-by-value marshaling overhead, verbose API designed for Node |
| `@duckdb/duckdb-wasm` | Browser-only — full DuckDB inside a 6 MB Wasm module is overkill for server-side Bun |
| `node-duckdb` (older) | Abandoned, last release before the chunk API |

`duckdb-bun` is built around four properties Bun developers actually want:

- **Pure FFI, no native build.** `bun add duckdb-bun` installs a
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
bun add duckdb-bun
```

You also need `libduckdb` (the DuckDB shared library) installed
somewhere `duckdb-bun` can find it. Common locations checked
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

Override with `DUCKDB_LIB_PATH=/your/path/libduckdb.so` (on Windows:
`$env:DUCKDB_LIB_PATH = "C:\path\to\duckdb.dll"`).

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

```powershell
# Windows: no package manager — download the release zip and point
# duckdb-bun at it via $env:DUCKDB_LIB_PATH.
#
#   https://github.com/duckdb/duckdb/releases  →  libduckdb-windows-amd64.zip
#
# Extract somewhere, then either:
#   - put the directory on PATH so Windows's DLL loader finds duckdb.dll, or
#   - set $env:DUCKDB_LIB_PATH = "C:\path\to\duckdb.dll" (preferred).
```

### FFI shim — what's it for

The driver depends on one tiny C wrapper (`lib/duckdb-shim.c`, ~30
lines) around three DuckDB functions that take a 48-byte struct by
value — something Bun's FFI can't currently do directly on most
platforms. See [AGENTS.md § FFI Bug 2](./AGENTS.md#bug-2-struct-by-value-passing-is-impossible)
for details.

**For npm users (the common case):** the shim is **pre-built and
shipped in the package** for the four major platforms. `bun add
duckdb-bun` is everything you need to install — no `make` step, no
toolchain dependency.

| Platform | Shim shipped? |
|---|---|
| **Linux x86_64** | ✅ `lib/libduckdb-shim-linux-x64.so` |
| **Linux arm64** | ✅ `lib/libduckdb-shim-linux-arm64.so` |
| **macOS arm64 (Apple Silicon)** | ✅ `lib/libduckdb-shim-darwin-arm64.dylib` (also has a non-shim fallback that works on this platform) |
| **macOS x86_64 (Intel)** | ✅ `lib/libduckdb-shim-darwin-x64.dylib` |
| **Windows x86_64** | ✅ `lib/libduckdb-shim-win32-x64.dll` (since v0.6.0) |

The pre-built shims are produced per-platform by the [release
workflow](./.github/workflows/release.yml) and bundled into the npm
tarball before publish.

**For source-clone / contributor use:** build a local untagged shim
once with the included Makefile.

```bash
# In a clone of the repo
make -C lib                       # → lib/libduckdb-shim.{so,dylib}

# Or platform-tagged (matches what CI ships):
make -C lib TAGGED=1              # → lib/libduckdb-shim-{platform}-{arch}.{so,dylib}
```

The driver's `findShimLibrary()` searches in priority order: the
`$DUCKDB_SHIM_PATH` env override, then the platform-tagged shim,
then the untagged shim, then any shim next to `libduckdb` itself.
Override the search with `DUCKDB_SHIM_PATH=/path/to/libduckdb-shim.so`.

## Quick start

```js
import { open, version } from 'duckdb-bun';

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
> Note: FFI calls themselves are synchronous — long-running queries
> still block the Bun event loop. Use `duckdb-bun/async` (Worker-
> backed; same API) when event-loop responsiveness matters.

## TypeScript

Type declarations ship with the package — `import` works in TS without
extra setup, and `db.query<T>(sql)` lets you narrow the row shape:

```ts
import { open, type QueryResult, type Statement } from 'duckdb-bun';

interface User { id: number; name: string }

using db = open(':memory:');
await db.exec('CREATE TABLE users (id INT, name VARCHAR)');
await db.run('INSERT INTO users VALUES (?, ?), (?, ?)',
             [1, 'Alice', 2, 'Bob']);

const rows: QueryResult<User> = await db.all<User>(
  'SELECT * FROM users ORDER BY id',
);

rows[0].id;        // number
rows[0].name;      // string
rows.columns;      // ColumnInfo[]
rows.rowsChanged;  // bigint

using stmt: Statement<User> = await db.prepare<User>(
  'SELECT * FROM users WHERE id = ?',
);
const alice = await stmt.get([1]);   // User | undefined
```

The defaults are loose (`Row = Record<string, unknown>`) so untyped
calls work without ceremony — tighten only when you know the shape.

## API reference

### `open(path, opts?) → Database`

Opens (or creates) a DuckDB database at `path`. Pass `':memory:'` for
an in-memory database.

```js
const db = open(':memory:');
const db = open('analytics.duckdb');
const db = open('analytics.duckdb', { readOnly: true });
const db = open(':memory:', { threads: 4, memoryLimit: '2GB' });
```

`opts` (v0.5+) is an optional `OpenOptions` bag:

| Field | Type | Notes |
|---|---|---|
| `readOnly` | `boolean` | Sugar for `accessMode: 'READ_ONLY'` |
| `accessMode` | `'AUTOMATIC' \| 'READ_ONLY' \| 'READ_WRITE'` | Maps to DuckDB's `access_mode` |
| `threads` | `number` | Positive integer |
| `memoryLimit` | `string` | e.g. `'1GB'`, `'512MB'`, `'80%'` |
| `tempDirectory` | `string` | DuckDB's `temp_directory` |
| `config` | `Record<string, string\|number\|boolean\|bigint>` | Escape hatch for any DuckDB config key not exposed above |

Typed options and `config` setting the same DuckDB key with different
values throw `DuckDBError`; matching values are allowed. Throws if
DuckDB rejects the path or the config.

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
| `db.iterate(sql, params?)` | `AsyncIterableIterator<T>` | Stream rows row-by-row. Sugar that lazy-prepares a temp Statement on first `.next()`; closed in `finally`. *(v0.3+)* |
| `db.chunks(sql, params?)` | `AsyncIterableIterator<RowChunk<T>>` | Stream chunk-by-chunk; each yield is `{ rows, chunkIndex, rowOffset }` (DuckDB vector ≈ 2048 rows). *(v0.5+)* |
| `db.transaction(fn)` | `Promise<R>` | BEGIN before, COMMIT after success, ROLLBACK + rethrow on throw. `fn` receives a scoped `TxnHandle` that throws on use after the callback returns (v0.5+). |
| `db.pragma(name, value?)` | `Promise<Row \| undefined>` | `PRAGMA name` (get) or `PRAGMA name=value` (set). Strict identifier validation. *(v0.5+)* |
| `db.installExtension(name)` | `Promise<void>` | `INSTALL <name>` with identifier validation. *(v0.5+)* |
| `db.loadExtension(name)` | `Promise<void>` | `LOAD <name>` with identifier validation. *(v0.5+)* |
| `db.checkpoint(opts?)` | `Promise<void>` | `CHECKPOINT` / `FORCE CHECKPOINT` / `CHECKPOINT <db>`. Flushes WAL on file-backed DBs. *(v0.5.1+)* |
| `db.connect()` | `Connection` | A fresh, independent Connection. |
| `db.close()` | `Promise<void>` | Closes the database and the implicit Connection. Idempotent. Async as of v0.3 (the public handle still nulls out synchronously so `db.close(); db.handle === null` continues to hold). |
| `db[Symbol.dispose]()` | `void` | Fires `close().catch(...)` — fire-and-forget. Enables `using db = open(...)`. |
| `db[Symbol.asyncDispose]()` | `Promise<void>` | Awaits `close()`. Enables `await using db = open(...)`. Preferred for streaming. *(v0.3+)* |

### `Connection`

`Connection` exposes the same shortcut methods as `Database`, plus the
underlying lifecycle and bulk-insert primitives. Multiple Connections
on one Database run independently — use them for parallelism.

| Method | Returns | Description |
|---|---|---|
| `conn.query(sql, params?)` | `Promise<QueryResult<T>>` | Execute. One-shot for no params; prepare+execute+destroy if params given. |
| `conn.all/get/run/exec/prepare/transaction` | (same as `Database`) | Shortcuts mirror `Database`. |
| `conn.iterate(sql, params?)` | `AsyncIterableIterator<T>` | Stream rows. Sugar over `prepare(sql).iterate(params)`; lazy temp Statement. *(v0.3+)* |
| `conn.chunks(sql, params?)` | `AsyncIterableIterator<RowChunk<T>>` | Stream chunk-by-chunk. *(v0.5+)* |
| `conn.pragma(name, value?)` | `Promise<Row \| undefined>` | `PRAGMA` get/set. *(v0.5+)* |
| `conn.installExtension(name)` | `Promise<void>` | `INSTALL <name>`. *(v0.5+)* |
| `conn.loadExtension(name)` | `Promise<void>` | `LOAD <name>`. *(v0.5+)* |
| `conn.checkpoint(opts?)` | `Promise<void>` | `CHECKPOINT` / `FORCE CHECKPOINT` / named. *(v0.5.1+)* |
| `conn.append(table, columns, rows)` | `Promise<{ rows: number }>` | Bulk insert via DuckDB's Appender API. Fastest path for loading many rows. See [`examples/appender.mjs`](./examples/appender.mjs). |
| `conn.executeBatchPrepared(sql, batches)` | `Promise<{ rows: number }>` | Advanced: execute one prepared statement multiple times with batched parameter sets. |
| `conn.countStatements(sql)` | `number` (sync) | Parses `sql`; returns the number of statements without executing. Throws on parse failure. |
| `conn.close()` | `Promise<void>` | Closes the connection. Idempotent. Async as of v0.3 (cancels active iterators before destroy; public handle nulls out synchronously). |
| `conn[Symbol.dispose]()` | `void` | Fires `close().catch(...)` — fire-and-forget. |
| `conn[Symbol.asyncDispose]()` | `Promise<void>` | Awaits `close()`. *(v0.3+)* |
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
| `stmt.iterate(params?)` | `AsyncIterableIterator<T>` | Bind + execute, then stream rows one at a time. Holds the owning Connection's lock for the iterator's lifetime — concurrent ops on that Connection queue. Use multiple `db.connect()` for parallel streams. *(v0.3+)* |
| `stmt.chunks(params?)` | `AsyncIterableIterator<RowChunk<T>>` | Same lock/lifecycle as `iterate`, but yields per-DuckDB-vector chunks of rows. Useful for batch processing. *(v0.5+)* |
| `stmt.close()` | `Promise<void>` | Free the prepared handle. Idempotent. Async as of v0.3 (cancels any active iterator before destroy; `.closed` still flips synchronously). |
| `stmt[Symbol.dispose]()` | `void` | Fires `close().catch(...)` — fire-and-forget. |
| `stmt[Symbol.asyncDispose]()` | `Promise<void>` | Awaits `close()`. *(v0.3+)* |
| `stmt.closed` | `boolean` | True after close. Subsequent calls throw `DuckDBClosedError`. |

Parameters are positional **arrays** — `[1, 'foo']`, not
`(1, 'foo')`. This avoids ambiguity with DuckDB `LIST` values.

### Errors

All driver errors extend `DuckDBError`. Specific subclasses identify
common failure modes:

| Class | When it's thrown |
|---|---|
| `DuckDBError` | Generic driver error (DuckDB returned an error message) |
| `DuckDBClosedError` | Use of a closed Database / Connection / Statement |
| `DuckDBPrepareError` | `prepare()` failed (typically a SQL syntax error) |
| `DuckDBTransactionError` | Nested transactions (DuckDB does not yet support `SAVEPOINT`) or using a `TxnHandle` after its callback returned |
| `DuckDBWorkerCrashedError` | (`duckdb-bun/async` only) Worker exited unexpectedly. All pending request promises reject with this; future calls on any proxy from that Database reject with `DuckDBClosedError`. |

```js
import { DuckDBError, DuckDBClosedError } from 'duckdb-bun';

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

What you get back from a query, by DuckDB column type. The contract is
geared toward "values stay JSON-safe by default; precision-sensitive
types fall back to strings".

| DuckDB type | JavaScript value | Notes |
|---|---|---|
| `BOOLEAN` | `boolean` | |
| `TINYINT`, `SMALLINT`, `INTEGER` | `number` | always safe (32-bit) |
| `UTINYINT`, `USMALLINT`, `UINTEGER` | `number` | always safe (32-bit) |
| `BIGINT`, `UBIGINT` | `number` | **lossy above `2^53`** — see "Precision" below |
| `HUGEINT`, `UHUGEINT` | `string` | decimal string, full precision |
| `FLOAT`, `DOUBLE` | `number` | |
| `DECIMAL` | `string` | decimal string, full precision |
| `VARCHAR`, `CHAR` | `string` | UTF-8 |
| `BLOB` | `Uint8Array` | raw bytes, copied out of DuckDB-owned memory |
| `DATE` | `string` | `"YYYY-MM-DD"` |
| `TIME`, `TIME_NS`, `TIME_TZ` | `string` | ISO-ish formatted time (TZ includes `+HH:MM`) |
| `TIMESTAMP`, `TIMESTAMP_S`, `TIMESTAMP_MS`, `TIMESTAMP_TZ` | `Date` | UTC |
| `TIMESTAMP_NS` | `Date` | truncated to millisecond precision |
| `INTERVAL` | `string` | e.g. `"3 months 2 days 1.5 seconds"` |
| `UUID` | `string` | canonical 8-4-4-4-12 form |
| `ENUM` | `string` | dictionary lookup |
| `LIST`, `ARRAY` | `Array` | |
| `STRUCT` | `object` | plain `{}` |
| `MAP` | `object` | plain `{}` (keys stringified) — *not* a `Map` |
| `NULL` | `null` | |
| `BIT`, `UNION` | `null` | not yet decoded — surfaces as `null` |

**Precision.** `BIGINT`/`UBIGINT` are returned as `number` so they fit
naturally into JSON and arithmetic. Values beyond `2^53` lose precision.
If you need full precision, cast to `HUGEINT`/`DECIMAL` in SQL or read
the raw integer via a `VARCHAR` cast. A future opt-in mode (planned)
will let you elect `bigint` returns for `BIGINT`/`UBIGINT` and `string`
returns for `DECIMAL`/large integers from a single config.

`DUCKDB_TYPE` is exported as a frozen object mapping type names to
DuckDB's internal integer IDs, useful when introspecting `result.columns`.

### Parameter binding

Use `?` placeholders. Values are mapped to DuckDB types automatically:

| JS value | Bound as |
|---|---|
| `null`, `undefined` | `NULL` |
| `boolean` | `BOOLEAN` |
| `number` (integer) | `BIGINT` (`duckdb_bind_int64`) |
| `number` (non-integer) | `DOUBLE` |
| `bigint` | `BIGINT` |
| `string` | `VARCHAR` |
| `Uint8Array`, `ArrayBuffer` | `BLOB` (`duckdb_bind_blob`, byte-exact) |
| `Date` | `VARCHAR` ISO-8601 string (use `CAST(? AS TIMESTAMP)` for the typed form) |
| anything else | stringified via `String(value)` and bound as `VARCHAR` |

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
  truly off-thread interface, use `duckdb-bun/async` (Worker-backed;
  same API surface, ~25% latency tax on small queries, but the main
  event loop stays responsive).

## Examples

- [`examples/basic.mjs`](./examples/basic.mjs) — `using db = open(...)`, db.exec/run/all/get, parameters
- [`examples/prepared.mjs`](./examples/prepared.mjs) — prepared statements, transactions, real timings
- [`examples/appender.mjs`](./examples/appender.mjs) — 100k bulk insert via the Appender API
- [`examples/iterate.mjs`](./examples/iterate.mjs) — streaming with `stmt.iterate()` / `conn.iterate()` / `db.iterate()`, early-break cleanup, parallel streams across two Connections *(v0.3+)*
- [`examples/async.mjs`](./examples/async.mjs) — `duckdb-bun/async` Worker-backed subpath: same API, event loop stays responsive during heavy queries *(v0.4+)*

## Roadmap

For a full release-by-release history (including breaking changes,
benchmarks, and design notes), see [CHANGELOG.md](./CHANGELOG.md).

### Shipped

- **v0.2** — `Database` / `Connection` / `Statement` classes; shortcut
  methods (`query`/`all`/`get`/`run`/`exec`/`prepare`/`transaction`);
  `Symbol.dispose`; TypeScript declarations; named error classes;
  pre-built shim binaries for Linux x64 / Linux arm64 / macOS x64 /
  macOS arm64.
- **v0.3** — `Statement.iterate(params?)` for streaming large result
  sets; `Connection.iterate(sql, params?)` and `Database.iterate(sql,
  params?)` sugar (lazy-prepare); **per-Connection locks** (replaces
  the older process-global lock); `[Symbol.asyncDispose]`; async
  `close()` (soft-breaking — public handles still null synchronously).
- **v0.4** — `duckdb-bun/async` Worker-backed subpath. Identical API,
  every DuckDB call runs in a Worker so the main event loop stays
  responsive. Pull-based per-chunk streaming with configurable
  `prefetch`. Streaming `AsyncAppender` with proxy-side batching.
- **v0.5** — Core-polish release. `open(path, opts?)` with `OpenOptions`
  (`readOnly` / `accessMode` / `threads` / `memoryLimit` / `config` escape
  hatch). `pragma` / `installExtension` / `loadExtension` helpers
  with strict identifier validation. `chunks()` chunk-by-chunk
  streaming on Statement / Connection / Database. `TxnHandle` —
  scoped transaction handle that throws on use after callback.
- **v0.5.1** — `checkpoint(opts?)` helper (CHECKPOINT /
  `FORCE CHECKPOINT` / named).
- **v0.6.0** — Windows x86_64 support. Pre-built shim DLL (MSVC build
  via `lib/build.ps1`), cross-platform path handling, `windows-latest`
  CI job, `findDuckDBLibrary` Windows paths, `DUCKDB_LIB_PATH` env
  override. Bun 1.1+ required on Windows.

### Planned

- **v0.7** — `AbortSignal` per-query cancellation on the async subpath
  (architecture proven: main thread calls `duckdb_interrupt` on the
  worker's connection handle while the worker is blocked in FFI).
  The sync subpath will not get `AbortSignal` — sync FFI blocks the
  JS thread that would receive the abort event.
- **v1.0** — API freeze. Optional companion packages
  (`duckdb-bun-kysely`, `duckdb-bun-drizzle`).

### Likely later

- Configurable type conversion — opt-in `BIGINT → bigint` mode for
  users hitting values >2^53 (snowflake IDs, nanosecond timestamps,
  hashes). Currently `BIGINT → number` (documented sharp edge); users
  can `CAST(? AS HUGEINT)` or `CAST(? AS VARCHAR)` for full precision
  today.
- Nested transactions via `SAVEPOINT`. Blocked on upstream DuckDB:
  v1.5.2's parser does not yet accept `SAVEPOINT`. `tx.transaction()`
  is reserved on the API surface so it becomes a non-breaking add
  when upstream lands it.

### Explicitly not planned

- Query builder, ORMs, models / repositories / Active Record
- Migrations
- Schema introspection beyond what DuckDB's `PRAGMA show_tables` /
  `DESCRIBE` already gives you
- Connection pooling — DuckDB is in-process, pooling is the wrong
  shape

The driver stays a driver. Higher layers belong in separate packages.

## Building from source

```bash
git clone https://github.com/shreeve/duckdb-bun
cd duckdb-bun
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

- **Bun:** ≥ 1.1 (Bun added Windows support in 1.1; 1.0 still works on
  Linux/macOS but the package now declares 1.1 as the minimum so the
  npm metadata matches reality)
- **DuckDB:** any modern release with the chunk API (≥ v0.10
  recommended; tested against v1.5.x)
- **Platforms (shipped shims):** macOS arm64, macOS x64, Linux x64,
  Linux arm64, Windows x64
- **Windows arm64:** not shipped — compile-only support isn't
  enough for a native/FFI package and we can't currently runtime-test
  on Windows arm64 in CI. Open an issue if you'd use it.

## Related

- [DuckDB](https://duckdb.org/) — the database
- [DuckDB C API docs](https://duckdb.org/docs/api/c/overview)
- [Bun FFI docs](https://bun.sh/docs/api/ffi)

## License

MIT © Steve Shreeve
