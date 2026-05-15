/**
 * DuckDB Pure Bun FFI Wrapper
 *
 * Direct FFI bindings to DuckDB's C API using the modern chunk-based API.
 * No deprecated per-value functions. No Zig, no npm package.
 *
 * Usage:
 *   import { open } from './duckdb.mjs';
 *
 *   const db = open(':memory:');
 *   const conn = db.connect();
 *   const rows = await conn.query('SELECT 42 as num');
 *   conn.close();
 *   db.close();
 */

import { dlopen, ptr, CString, read as ffiRead } from 'bun:ffi';
import { platform, arch } from 'process';
import { existsSync, realpathSync } from 'fs';

// ==============================================================================
// Find DuckDB Library
// ==============================================================================

function findDuckDBLibrary() {
  const candidates = [];

  if (platform === 'darwin') {
    candidates.push(
      '/opt/homebrew/lib/libduckdb.dylib',
      '/usr/local/lib/libduckdb.dylib',
      '/usr/lib/libduckdb.dylib',
    );
  } else if (platform === 'linux') {
    candidates.push(
      '/usr/lib/libduckdb.so',
      '/usr/local/lib/libduckdb.so',
      '/usr/lib/x86_64-linux-gnu/libduckdb.so',
      '/usr/lib/aarch64-linux-gnu/libduckdb.so',
    );
  } else if (platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\DuckDB\\duckdb.dll',
      'duckdb.dll',
    );
  }

  if (process.env.DUCKDB_LIB_PATH) {
    candidates.unshift(process.env.DUCKDB_LIB_PATH);
  }

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  throw new Error(
    `Could not find DuckDB library. Tried:\n${candidates.join('\n')}\n\n` +
    `Install DuckDB or set DUCKDB_LIB_PATH environment variable.`
  );
}

const libPath = findDuckDBLibrary();

// ==============================================================================
// Load DuckDB C API
// ==============================================================================
//
// Bun FFI on Linux x64 has two bugs:
//   1. Passing a JS number as a 'ptr' argument corrupts the value — use 'u64' + BigInt
//   2. Cannot pass structs by value (e.g. 48-byte duckdb_result) — needs C shim
//
// All opaque handles (database, connection, stmt, chunk, vector, logical_type)
// are declared as 'u64' args and stored as BigInt. Buffer pointers (where we pass
// ptr(buf)) remain 'ptr'. String-returning functions remain 'ptr' returns.
//

const lib = dlopen(libPath, {
  // Database lifecycle
  duckdb_open:    { args: ['ptr', 'ptr'], returns: 'i32' },
  // open_ext takes a config + out_error pointer; needed for OpenOptions
  // (DuckDB threads, memory_limit, access_mode, etc. configured before
  // duckdb_open). v0.5+.
  duckdb_open_ext: { args: ['ptr', 'ptr', 'u64', 'ptr'], returns: 'i32' },
  duckdb_close:   { args: ['ptr'], returns: 'void' },

  // Config (v0.5+): used with duckdb_open_ext to set startup options.
  duckdb_create_config:   { args: ['ptr'], returns: 'i32' },
  duckdb_set_config:      { args: ['u64', 'ptr', 'ptr'], returns: 'i32' },
  duckdb_destroy_config:  { args: ['ptr'], returns: 'void' },

  // Connection lifecycle
  duckdb_connect:    { args: ['u64', 'ptr'], returns: 'i32' },
  duckdb_disconnect: { args: ['ptr'], returns: 'void' },

  // Query execution
  duckdb_query:          { args: ['u64', 'ptr', 'ptr'], returns: 'i32' },
  duckdb_destroy_result: { args: ['ptr'], returns: 'void' },

  // Affected-row count for DML (INSERT/UPDATE/DELETE).
  // Takes a duckdb_result* (declared as 'u64' per Bug 1 — pass BigInt(ptr(buf))
  // even though it's morally a pointer) and returns idx_t. Must be called
  // AFTER duckdb_query succeeds and BEFORE duckdb_destroy_result.
  duckdb_rows_changed:   { args: ['u64'], returns: 'u64' },

  // Statement extraction — used by /ddb/exec to enforce single-statement
  // input. duckdb_extract_statements(conn, sql, out_handle*) returns the
  // statement count (0 on failure), and duckdb_destroy_extracted frees the
  // out handle. Both pointer params declared 'u64' per the Bug 1 convention.
  duckdb_extract_statements:        { args: ['u64', 'ptr', 'ptr'], returns: 'u64' },
  duckdb_extract_statements_error:  { args: ['u64'], returns: 'ptr' },
  duckdb_destroy_extracted:         { args: ['ptr'], returns: 'void' },

  // Prepared statements
  duckdb_prepare:          { args: ['u64', 'ptr', 'ptr'], returns: 'i32' },
  duckdb_prepare_error:    { args: ['u64'], returns: 'ptr' },
  duckdb_destroy_prepare:  { args: ['ptr'], returns: 'void' },
  duckdb_bind_null:        { args: ['u64', 'u64'], returns: 'i32' },
  duckdb_bind_boolean:     { args: ['u64', 'u64', 'bool'], returns: 'i32' },
  duckdb_bind_int32:       { args: ['u64', 'u64', 'i32'], returns: 'i32' },
  duckdb_bind_int64:       { args: ['u64', 'u64', 'i64'], returns: 'i32' },
  duckdb_bind_double:      { args: ['u64', 'u64', 'f64'], returns: 'i32' },
  duckdb_bind_varchar:     { args: ['u64', 'u64', 'ptr'], returns: 'i32' },
  // duckdb_bind_blob(stmt, idx, data, length) — binds raw bytes as BLOB.
  // `data` is a buffer pointer; `length` is a size_t (idx_t, u64).
  duckdb_bind_blob:        { args: ['u64', 'u64', 'ptr', 'u64'], returns: 'i32' },
  duckdb_execute_prepared: { args: ['u64', 'ptr'], returns: 'i32' },
  duckdb_clear_bindings:   { args: ['u64'], returns: 'i32' },

  // Appender API
  duckdb_appender_create:        { args: ['u64', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
  duckdb_appender_error:         { args: ['u64'], returns: 'ptr' },
  duckdb_appender_flush:         { args: ['u64'], returns: 'i32' },
  duckdb_appender_close:         { args: ['u64'], returns: 'i32' },
  duckdb_appender_destroy:       { args: ['ptr'], returns: 'i32' },
  duckdb_appender_end_row:       { args: ['u64'], returns: 'i32' },
  duckdb_append_bool:            { args: ['u64', 'bool'], returns: 'i32' },
  duckdb_append_int32:           { args: ['u64', 'i32'], returns: 'i32' },
  duckdb_append_int64:           { args: ['u64', 'i64'], returns: 'i32' },
  duckdb_append_double:          { args: ['u64', 'f64'], returns: 'i32' },
  duckdb_append_varchar:         { args: ['u64', 'ptr'], returns: 'i32' },
  // duckdb_append_blob(appender, data, length) — append raw bytes as BLOB.
  duckdb_append_blob:            { args: ['u64', 'ptr', 'u64'], returns: 'i32' },
  duckdb_append_null:            { args: ['u64'], returns: 'i32' },
  duckdb_appender_add_column:    { args: ['u64', 'ptr'], returns: 'i32' },
  duckdb_appender_clear_columns: { args: ['u64'], returns: 'i32' },

  // Result inspection (result is always ptr(buf), not a handle)
  duckdb_column_count:  { args: ['ptr'], returns: 'u64' },
  duckdb_column_name:   { args: ['ptr', 'u64'], returns: 'ptr' },
  duckdb_column_type:   { args: ['ptr', 'u64'], returns: 'i32' },
  duckdb_result_error:  { args: ['ptr'], returns: 'ptr' },

  // Chunk-based API (handles as u64)
  duckdb_data_chunk_get_size:     { args: ['u64'], returns: 'u64' },
  duckdb_data_chunk_get_vector:   { args: ['u64', 'u64'], returns: 'u64' },
  duckdb_vector_get_data:         { args: ['u64'], returns: 'u64' },
  duckdb_vector_get_validity:     { args: ['u64'], returns: 'u64' },
  duckdb_destroy_data_chunk:      { args: ['ptr'], returns: 'void' },

  // Logical type introspection (handles as u64)
  duckdb_column_logical_type:     { args: ['ptr', 'u64'], returns: 'u64' },
  duckdb_destroy_logical_type:    { args: ['ptr'], returns: 'void' },
  duckdb_get_type_id:             { args: ['u64'], returns: 'i32' },
  duckdb_decimal_width:           { args: ['u64'], returns: 'u8' },
  duckdb_decimal_scale:           { args: ['u64'], returns: 'u8' },
  duckdb_decimal_internal_type:   { args: ['u64'], returns: 'i32' },
  duckdb_enum_internal_type:      { args: ['u64'], returns: 'i32' },
  duckdb_enum_dictionary_size:    { args: ['u64'], returns: 'u32' },
  duckdb_enum_dictionary_value:   { args: ['u64', 'u64'], returns: 'ptr' },

  // Nested type vector access (handles as u64)
  duckdb_list_vector_get_child:   { args: ['u64'], returns: 'u64' },
  duckdb_list_vector_get_size:    { args: ['u64'], returns: 'u64' },
  duckdb_struct_vector_get_child: { args: ['u64', 'u64'], returns: 'u64' },
  duckdb_struct_type_child_count: { args: ['u64'], returns: 'u64' },
  duckdb_struct_type_child_name:  { args: ['u64', 'u64'], returns: 'ptr' },
  duckdb_struct_type_child_type:  { args: ['u64', 'u64'], returns: 'u64' },
  duckdb_list_type_child_type:    { args: ['u64'], returns: 'u64' },
  duckdb_array_vector_get_child:  { args: ['u64'], returns: 'u64' },
  duckdb_array_type_child_type:   { args: ['u64'], returns: 'u64' },
  duckdb_array_type_array_size:   { args: ['u64'], returns: 'u64' },

  // Memory
  duckdb_free: { args: ['u64'], returns: 'void' },

  // Library info
  duckdb_library_version: { args: [], returns: 'ptr' },
}).symbols;

// Load shim for duckdb_fetch_chunk (takes duckdb_result by value — 48-byte struct
// that Bun FFI cannot marshal). The shim accepts duckdb_result* instead.
//
// Lookup priority:
//   1. $DUCKDB_SHIM_PATH (explicit override; useful for tests / unusual layouts)
//   2. Platform-tagged shim shipped in the npm package, e.g.
//        libduckdb-shim-linux-x64.so
//        libduckdb-shim-darwin-arm64.dylib
//      Built per-platform by .github/workflows/release.yml and bundled into the
//      tarball before publish, so `bun add duckdb-bun` users get a working
//      shim without running `make`.
//   3. Untagged shim next to the driver — what `make -C lib` produces locally
//      for contributors and source-clone users
//   4. Untagged shim next to libduckdb.{so,dylib} — historical install
//      location for users who copied the shim into the system lib dir
function findShimLibrary() {
  const ext = platform === 'darwin' ? 'dylib' : 'so';
  const taggedName = `libduckdb-shim-${platform}-${arch}.${ext}`;
  const untaggedName = `libduckdb-shim.${ext}`;

  const realLibPath = realpathSync(libPath);
  const realLibDir = realLibPath.replace(/\/[^/]+$/, '');
  const symLibDir = libPath.replace(/\/[^/]+$/, '');
  const driverDir = new URL('.', import.meta.url).pathname;

  const candidates = [
    process.env.DUCKDB_SHIM_PATH,            // explicit override
    `${driverDir}/${taggedName}`,            // shipped prebuilt next to driver
    `${driverDir}/${untaggedName}`,          // local `make` output next to driver
    `${realLibDir}/${untaggedName}`,         // historical: next to real libduckdb
    `${symLibDir}/${untaggedName}`,          // historical: next to symlinked libduckdb
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

const shimPath = findShimLibrary();
const shim = shimPath ? dlopen(shimPath, {
  shim_fetch_chunk: { args: ['ptr'], returns: 'u64' },
}).symbols : null;

// Fetch chunk: use shim (pointer-based) or fall back to direct call (macOS ARM64)
const fetchChunk = shim
  ? (rp) => shim.shim_fetch_chunk(rp)
  : (() => {
      const fn = dlopen(libPath, {
        duckdb_fetch_chunk: { args: ['ptr'], returns: 'u64' },
      }).symbols.duckdb_fetch_chunk;
      return (rp) => fn(rp);
    })();

// ==============================================================================
// DuckDB Type Constants
// ==============================================================================

const DUCKDB_TYPE = {
  INVALID: 0,
  BOOLEAN: 1,
  TINYINT: 2,
  SMALLINT: 3,
  INTEGER: 4,
  BIGINT: 5,
  UTINYINT: 6,
  USMALLINT: 7,
  UINTEGER: 8,
  UBIGINT: 9,
  FLOAT: 10,
  DOUBLE: 11,
  TIMESTAMP: 12,
  DATE: 13,
  TIME: 14,
  INTERVAL: 15,
  HUGEINT: 16,
  VARCHAR: 17,
  BLOB: 18,
  DECIMAL: 19,
  TIMESTAMP_S: 20,
  TIMESTAMP_MS: 21,
  TIMESTAMP_NS: 22,
  ENUM: 23,
  LIST: 24,
  STRUCT: 25,
  MAP: 26,
  UUID: 27,
  UNION: 28,
  BIT: 29,
  TIME_TZ: 30,
  TIMESTAMP_TZ: 31,
  UHUGEINT: 32,
  ARRAY: 33,
  TIME_NS: 39,
};

export { DUCKDB_TYPE };

// ==============================================================================
// Error classes
//
// All driver-level errors extend DuckDBError so callers can `instanceof`-check
// without inspecting message strings. Specific subclasses identify the most
// common failure modes (use-after-close, prepare-time error, bind-time error)
// for finer-grained handling.
// ==============================================================================

export class DuckDBError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DuckDBError';
  }
}

export class DuckDBClosedError extends DuckDBError {
  constructor(what = 'resource') {
    super(`${what} is closed`);
    this.name = 'DuckDBClosedError';
  }
}

export class DuckDBPrepareError extends DuckDBError {
  constructor(message) {
    super(message);
    this.name = 'DuckDBPrepareError';
  }
}

export class DuckDBTransactionError extends DuckDBError {
  constructor(message) {
    super(message);
    this.name = 'DuckDBTransactionError';
  }
}

// ==============================================================================
// Helper Functions
// ==============================================================================

// ==============================================================================
// AsyncMutex — promise-chain mutex for serializing FFI calls
//
// Each Connection owns one of these (per-connection lock; replaces the
// process-global lock that existed prior to v0.3.0). Two patterns:
//
//   withLock(fn): one-shot critical section. fn is a sync function; its
//   return value (which may be a Promise) is the return value of withLock.
//   The lock is released when fn() returns, NOT when the returned Promise
//   resolves. Use only for callbacks that don't `await` inside.
//
//   acquire(): lifetime lock. Returns a `release()` callback the caller
//   MUST invoke exactly once (use try/finally). Used by Statement.iterate()
//   which holds the lock across `yield` points.
//
// Per GPT-5.5's design feedback: state checks belong inside withLock's
// callback (not before queueing), because close() may flip state while
// a query is waiting in the queue.
// ==============================================================================

class AsyncMutex {
  #tail = Promise.resolve();

  withLock(fn) {
    const prev = this.#tail;
    let resolve;
    this.#tail = new Promise(r => { resolve = r; });
    return prev.then(() => {
      try { return fn(); }
      finally { resolve(); }
    });
  }

  async acquire() {
    const prev = this.#tail;
    let resolve;
    this.#tail = new Promise(r => { resolve = r; });
    await prev;
    return resolve; // caller invokes this to release
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toCString(str) {
  return encoder.encode(str + '\0');
}

function fromCString(p) {
  if (!p) return null;
  return new CString(p).toString();
}

function allocPtr() {
  return new Uint8Array(8);
}

function readHandle(buf) {
  return new DataView(buf.buffer).getBigUint64(0, true);
}

// Read a duckdb_string_t (16 bytes) as a Uint8Array of bytes.
//
// DuckDB's string_t layout:
//   bytes  0..3   uint32_t length
//   bytes  4..15  if length <= 12: inline data (12 bytes)
//                 else: bytes 4..7 are a 4-byte prefix, bytes 8..15 are
//                       a pointer to the actual data on the heap.
//
// We always copy out of DuckDB-owned memory so the returned Uint8Array
// is safe to retain across chunk destruction.
function readBytes(dataPtr, row) {
  if (!dataPtr) return null;
  const offset = row * 16;
  const length = ffiRead.u32(dataPtr, offset);
  const bytes = new Uint8Array(length);
  if (length <= 12) {
    for (let i = 0; i < length; i++) {
      bytes[i] = ffiRead.u8(dataPtr, offset + 4 + i);
    }
  } else {
    const strPtr = ffiRead.ptr(dataPtr, offset + 8);
    if (!strPtr) return null;
    for (let i = 0; i < length; i++) {
      bytes[i] = ffiRead.u8(strPtr, i);
    }
  }
  return bytes;
}

// Read a duckdb_string_t as a UTF-8 string. For BLOB (binary data) use
// readBytes() instead — TextDecoder will replace invalid UTF-8 with
// U+FFFD and corrupt the bytes.
function readString(dataPtr, row) {
  const bytes = readBytes(dataPtr, row);
  return bytes === null ? null : decoder.decode(bytes);
}

// Check if a row is valid (not NULL) in a validity mask
function isValid(validityPtr, row) {
  if (!validityPtr) return true;  // NULL validity = all valid
  const entryIdx = Math.floor(row / 64);
  const bitIdx = row % 64;
  const entry = ffiRead.u64(validityPtr, entryIdx * 8);
  return (entry & (1n << BigInt(bitIdx))) !== 0n;
}

// ==============================================================================
// OpenOptions normalization (v0.5+)
//
// Convert the user-facing OpenOptions shape (hybrid typed + escape
// hatch) into a Map<string,string> ready for duckdb_set_config. Typed
// options ergonomically map to well-known DuckDB config keys; the
// `config` field is a passthrough for keys we haven't typed.
//
// Conflict detection: if a typed option and a `config` entry both set
// the same DuckDB key (e.g. readOnly: true + config.access_mode:
// 'READ_WRITE'), throw rather than silently picking one. Per GPT-5.5's
// review: "avoid 'why did my DB open read-write?' bugs".
// ==============================================================================

// Maps typed OpenOptions fields → DuckDB config keys + value renderer.
const TYPED_OPTION_MAP = {
  accessMode:    { key: 'access_mode',     render: (v) => String(v) },
  threads:       { key: 'threads',         render: (v) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw new DuckDBError(`Invalid threads option: ${v} (must be positive integer)`);
    }
    return String(v);
  } },
  memoryLimit:   { key: 'memory_limit',    render: (v) => {
    if (typeof v !== 'string' || v.length === 0) {
      throw new DuckDBError(`Invalid memoryLimit option: ${JSON.stringify(v)} (expected non-empty string)`);
    }
    return v;
  } },
  tempDirectory: { key: 'temp_directory',  render: (v) => {
    if (typeof v !== 'string' || v.length === 0) {
      throw new DuckDBError(`Invalid tempDirectory option: ${JSON.stringify(v)}`);
    }
    return v;
  } },
};

function normalizeOpenOptions(opts) {
  // Map<duckdbKey, value>. Keep insertion order so error messages name
  // the first occurrence on a conflict.
  const out = new Map();

  // 1. readOnly is sugar for access_mode=READ_ONLY.
  if (opts.readOnly !== undefined) {
    if (typeof opts.readOnly !== 'boolean') {
      throw new DuckDBError(`readOnly must be boolean, got ${typeof opts.readOnly}`);
    }
    if (opts.readOnly) out.set('access_mode', 'READ_ONLY');
    else if (opts.accessMode === undefined) {
      // explicit readOnly:false with no other accessMode = READ_WRITE
      out.set('access_mode', 'READ_WRITE');
    }
  }

  // 2. Other typed options.
  for (const [field, { key, render }] of Object.entries(TYPED_OPTION_MAP)) {
    if (opts[field] === undefined) continue;
    const rendered = render(opts[field]);
    if (out.has(key) && out.get(key) !== rendered) {
      throw new DuckDBError(
        `OpenOptions conflict: ${field}=${JSON.stringify(opts[field])} ` +
        `conflicts with another typed option setting "${key}"="${out.get(key)}"`
      );
    }
    out.set(key, rendered);
  }

  // 3. Raw config escape hatch — last so we can detect conflicts with typed.
  if (opts.config !== undefined) {
    if (typeof opts.config !== 'object' || opts.config === null) {
      throw new DuckDBError(`OpenOptions.config must be an object`);
    }
    for (const [rawKey, rawVal] of Object.entries(opts.config)) {
      if (typeof rawKey !== 'string' || rawKey.length === 0) {
        throw new DuckDBError(`OpenOptions.config key must be a non-empty string`);
      }
      let rendered;
      if (typeof rawVal === 'boolean')      rendered = rawVal ? 'true' : 'false';
      else if (typeof rawVal === 'number')  rendered = String(rawVal);
      else if (typeof rawVal === 'bigint')  rendered = rawVal.toString();
      else if (typeof rawVal === 'string')  rendered = rawVal;
      else throw new DuckDBError(`OpenOptions.config["${rawKey}"] has unsupported value type ${typeof rawVal}`);

      if (out.has(rawKey) && out.get(rawKey) !== rendered) {
        throw new DuckDBError(
          `OpenOptions conflict: config["${rawKey}"]=${JSON.stringify(rawVal)} ` +
          `conflicts with a typed option setting "${rawKey}"="${out.get(rawKey)}"`
        );
      }
      out.set(rawKey, rendered);
    }
  }

  return out;
}

// ==============================================================================
// Internal SQL escaping helpers (v0.5+)
//
// PRAGMA and extension helpers generate SQL from user input; these
// helpers keep that generation injection-safe. They are deliberately
// NOT exported — if we expose them publicly we'd have to support them
// forever. Use them only inside the driver.
// ==============================================================================

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Throws if name isn't a simple identifier (letter/underscore start, then word chars). */
function assertSimpleIdentifier(name, label = 'identifier') {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new DuckDBError(`Invalid ${label}: ${JSON.stringify(name)}`);
  }
  return name;
}

// ==============================================================================
// Transaction scope handle (v0.5+)
//
// `db.transaction(fn)` and `tx.transaction(fn)` pass `fn` a TxnHandle —
// the same read/write methods as Connection, but with two guarantees:
//
//   - Using the handle after its callback has returned/thrown throws
//     DuckDBTransactionError. This catches the common bug where a user
//     stashes `tx` somewhere and uses it long after the transaction
//     committed.
//   - The handle carries its own scope identity so nested transactions
//     can be tracked even with multiple sibling proxies in flight.
//
// Implementation: a Proxy-free wrapper object exposing the same async
// methods Connection has. We intentionally don't use a Proxy because
// the explicit list is short and the call-site cost of a Proxy is
// nonzero for every awaited method.
// ==============================================================================

function makeTxnHandle(conn, scope) {
  function assertActive(label) {
    if (scope.closed) {
      throw new DuckDBTransactionError(
        `Cannot ${label}(): the transaction callback has already ` +
        `returned/thrown; the transaction handle is no longer usable.`,
      );
    }
  }
  return {
    async query(sql, params)   { assertActive('query');   return conn.query(sql, params); },
    async all(sql, params)     { assertActive('all');     return conn.all(sql, params); },
    async get(sql, params)     { assertActive('get');     return conn.get(sql, params); },
    async run(sql, params)     { assertActive('run');     return conn.run(sql, params); },
    async exec(sql)            { assertActive('exec');    return conn.exec(sql); },
    async prepare(sql)         { assertActive('prepare'); return conn.prepare(sql); },
    iterate(sql, params)       { assertActive('iterate'); return conn.iterate(sql, params); },
    chunks(sql, params)        { assertActive('chunks');  return conn.chunks(sql, params); },
    async pragma(name, value)  {
      assertActive('pragma');
      if (arguments.length < 2) return conn.pragma(name);
      return conn.pragma(name, value);
    },
    async installExtension(n)  { assertActive('installExtension'); return conn.installExtension(n); },
    async loadExtension(n)     { assertActive('loadExtension');    return conn.loadExtension(n); },
    async checkpoint(opts)     { assertActive('checkpoint');       return conn.checkpoint(opts); },
    async append(table, cols, rows) {
      assertActive('append'); return conn.append(table, cols, rows);
    },
    async executeBatchPrepared(sql, paramSets) {
      assertActive('executeBatchPrepared'); return conn.executeBatchPrepared(sql, paramSets);
    },
    // Nested transactions: throw with the upstream-blocker message
    // regardless of handle state. Kept as a method (not removed) so
    // future SAVEPOINT support is a non-breaking addition and so
    // typings remain stable. Per GPT-5.5: "remove from the public
    // type but keep runtime throwing if accessed? I would not do
    // that. Keep docs/types/runtime aligned."
    async transaction(_fn) {
      throw new DuckDBTransactionError(
        'Nested transactions are not supported because DuckDB v1.5.2 ' +
        'does not currently parse SAVEPOINT. This will be revisited ' +
        'when upstream DuckDB adds SAVEPOINT support.',
      );
    },
  };
}

/** Render a JS scalar as a SQL literal. Supports string/number/boolean/null/undefined. */
function quoteSqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DuckDBError(`Cannot bind non-finite number as SQL literal: ${value}`);
    }
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    // Single-quote with embedded ' doubled.
    return `'${value.replace(/'/g, "''")}'`;
  }
  throw new DuckDBError(`Cannot bind ${typeof value} as SQL literal`);
}

// Format a hugeint (16 bytes: lower uint64 at offset 0, upper int64 at offset 8) as UUID
function readUUID(dataPtr, row) {
  if (!dataPtr) return null;
  const offset = row * 16;
  const lower = ffiRead.u64(dataPtr, offset);
  const upper = ffiRead.i64(dataPtr, offset + 8);

  // DuckDB stores UUID as hugeint with XOR on the upper bits
  // Upper 64 bits have sign bit flipped for sorting
  const mask64 = (1n << 64n) - 1n;
  const hi = (BigInt(upper) ^ (1n << 63n)) & mask64;
  const lo = BigInt(lower) & mask64;

  const hex = ((hi << 64n) | lo).toString(16).padStart(32, '0');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// ==============================================================================
// Database Class
// ==============================================================================

class Database {
  #ptrBuf = null;
  #handle = null;
  #state = 'open';        // 'open' | 'closing' | 'closed'
  #closePromise = null;

  constructor(path, opts = undefined) {
    this.#ptrBuf = allocPtr();
    const pathBytes = path && path !== ':memory:' ? toCString(path) : null;
    const pathArg = pathBytes ? ptr(pathBytes) : null;

    if (opts && Object.keys(opts).length > 0) {
      // Build a duckdb_config, pass through duckdb_open_ext.
      const configMap = normalizeOpenOptions(opts);
      const cfgBuf = allocPtr();
      const cr = lib.duckdb_create_config(ptr(cfgBuf));
      if (cr !== 0) throw new DuckDBError('duckdb_create_config failed');
      const cfgHandle = readHandle(cfgBuf);
      try {
        for (const [key, value] of configMap) {
          const kBytes = toCString(key);
          const vBytes = toCString(String(value));
          const sr = lib.duckdb_set_config(cfgHandle, ptr(kBytes), ptr(vBytes));
          if (sr !== 0) {
            throw new DuckDBError(`Failed to set DuckDB config "${key}"="${value}"`);
          }
        }
        const errBuf = allocPtr();
        const result = lib.duckdb_open_ext(pathArg, ptr(this.#ptrBuf), cfgHandle, ptr(errBuf));
        if (result !== 0) {
          const errPtr = readHandle(errBuf);
          let msg = 'Failed to open database';
          if (errPtr) {
            const cstr = fromCString(Number(errPtr));
            if (cstr) msg = `Failed to open database: ${cstr}`;
            lib.duckdb_free(errPtr);
          }
          throw new DuckDBError(msg);
        }
      } finally {
        lib.duckdb_destroy_config(ptr(cfgBuf));
      }
    } else {
      const result = lib.duckdb_open(pathArg, ptr(this.#ptrBuf));
      if (result !== 0) throw new DuckDBError('Failed to open database');
    }
    this.#handle = readHandle(this.#ptrBuf);
  }

  get handle() { return this.#handle; }
  get ptrBuf() { return this.#ptrBuf; }
  get _state() { return this.#state; }
  _isOpen() { return this.#state === 'open'; }

  connect() {
    if (this.#state !== 'open') throw new DuckDBClosedError('Database');
    return new Connection(this);
  }

  // close() is async as of v0.3.0 — it must coordinate with active
  // iterators on child connections. The public handle is nulled out
  // synchronously so the v0.2-era contract `db.close(); db.handle === null`
  // still holds without awaiting; the FFI destroy happens behind the
  // returned Promise.
  //
  // Idempotent via #closePromise; calling close() twice returns the same
  // promise. Symbol.dispose calls this fire-and-forget with .catch();
  // Symbol.asyncDispose awaits it. Streaming users should prefer
  // `await using db = open(...)`.
  async close() {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state === 'closed') return;
    this.#state = 'closing';

    // Snapshot for the async tail. Null out public handles immediately
    // so v0.2 sync-after-close consumers see "closed" without awaiting.
    const ptrBuf = this.#ptrBuf;
    this.#ptrBuf = null;
    this.#handle = null;

    // Detach the lazy implicit Connection so it can be closed in the
    // async tail; the slot is wired below (Object.defineProperty), so we
    // read it through `this[DEFAULT_CONN]` lazily here.
    this.#closePromise = (async () => {
      const defaultConn = this[DEFAULT_CONN];
      if (defaultConn) {
        this[DEFAULT_CONN] = null;
        try { await defaultConn.close(); } catch { /* swallow */ }
      }
      if (ptrBuf) {
        lib.duckdb_close(ptr(ptrBuf));
      }
      this.#state = 'closed';
    })();
    return this.#closePromise;
  }

  [Symbol.dispose]() { this.close().catch(() => { /* fire-and-forget */ }); }
  [Symbol.asyncDispose]() { return this.close(); }
}

// ==============================================================================
// Connection Class
// ==============================================================================

class Connection {
  #ptrBuf = null;
  #handle = null;
  #db = null;
  #state = 'open';           // 'open' | 'closing' | 'closed'
  #mutex = new AsyncMutex();
  #closePromise = null;
  #activeIterator = null;    // wrapper for the in-flight Statement.iterate(), if any
  #statements = new Set();

  constructor(db) {
    this.#db = db;
    this.#ptrBuf = allocPtr();
    const result = lib.duckdb_connect(db.handle, ptr(this.#ptrBuf));
    if (result !== 0) throw new Error('Failed to create connection');
    this.#handle = readHandle(this.#ptrBuf);
  }

  get handle() { return this.#handle; }
  get ptrBuf() { return this.#ptrBuf; }
  get _state() { return this.#state; }
  _isOpen() { return this.#state === 'open'; }

  // Lock primitives. Per-Connection (replaces process-global lock).
  withLock(fn) { return this.#mutex.withLock(fn); }
  acquireLock() { return this.#mutex.acquire(); }

  // Track outstanding Statements so close() can free their prepared handles
  // before disconnect. A leaked Statement after Connection.close() would
  // either crash on next use or quietly leak the prepared handle in DuckDB.
  _trackStatement(stmt) { this.#statements?.add(stmt); }
  _untrackStatement(stmt) { this.#statements?.delete(stmt); }

  // Statement.iterate() registers/unregisters here so Connection.close() can
  // cancel the in-flight iterator before destroying its own handle.
  _setActiveIterator(it) { this.#activeIterator = it; }
  _clearActiveIterator(it) {
    if (this.#activeIterator === it) this.#activeIterator = null;
  }

  /**
   * Execute a SQL query and return results as array of objects
   * @param {string} sql - SQL query
   * @param {any[]} params - Optional parameters for prepared statement
   * @returns {Promise<object[]>} Array of row objects
   */
  query(sql, params = []) {
    return this.withLock(() => {
      // Closed-state check INSIDE the lock — close() may have flipped the
      // state while this call was waiting in the mutex queue.
      if (this.#state !== 'open') throw new DuckDBClosedError('Connection');
      if (params.length > 0) return this.#queryPrepared(sql, params);
      return this.#querySimple(sql);
    });
  }

  #querySimple(sql) {
    const resultPtr = new Uint8Array(64);  // duckdb_result struct is ~48 bytes
    const sqlBytes = toCString(sql);
    const status = lib.duckdb_query(this.#handle, ptr(sqlBytes), ptr(resultPtr));

    const rp = ptr(resultPtr);
    if (status !== 0) {
      const errorPtr = lib.duckdb_result_error(rp);
      const error = errorPtr ? fromCString(errorPtr) : 'Query failed';
      lib.duckdb_destroy_result(rp);
      throw new Error(error);
    }

    // Capture affected-row count BEFORE destroy — the result must still be
    // alive. duckdb_rows_changed is meaningful for DML; for SELECT it returns
    // the rowcount of the result set, which is not what we want, so we only
    // surface it as `rowsChanged` and let callers decide based on whether
    // there were columns. Stored as BigInt to avoid 2^53 precision loss on
    // huge bulk operations.
    //
    // Bug 1 workaround: even though this is morally a pointer arg, we pass
    // it as a BigInt-valued u64 to match the dlopen declaration.
    const rowsChanged = lib.duckdb_rows_changed(BigInt(rp));

    try {
      const rows = this.#extractChunks(resultPtr);
      rows.rowsChanged = rowsChanged;
      return rows;
    } finally {
      lib.duckdb_destroy_result(rp);
    }
  }

  #queryPrepared(sql, params) {
    const stmtPtr = allocPtr();
    const sqlBytes = toCString(sql);

    const prepStatus = lib.duckdb_prepare(this.#handle, ptr(sqlBytes), ptr(stmtPtr));
    if (prepStatus !== 0) {
      const stmtHandle = readHandle(stmtPtr);
      if (stmtHandle) {
        const errPtr = lib.duckdb_prepare_error(stmtHandle);
        const errMsg = errPtr ? fromCString(errPtr) : 'Failed to prepare statement';
        lib.duckdb_destroy_prepare(ptr(stmtPtr));
        throw new DuckDBPrepareError(errMsg);
      }
      throw new DuckDBPrepareError('Failed to prepare statement');
    }

    const stmtHandle = readHandle(stmtPtr);

    try {
      // Delegate the bind+execute+extract work to the shared helper so
      // Statement (which holds an already-prepared handle) and the legacy
      // one-shot query path share one canonical execution code path.
      return this._executePreparedSync(stmtHandle, params);
    } finally {
      lib.duckdb_destroy_prepare(ptr(stmtPtr));
    }
  }

  /**
   * Synchronously bind params, execute a prepared statement, extract rows.
   * Assumes the caller already holds the FFI lock (via withLock). Used by
   * #queryPrepared (one-shot) and Statement (reused). Public-but-underscored
   * because Statement needs to call it across class boundaries.
   *
   * @param {bigint} stmtHandle - already-prepared statement handle
   * @param {any[]} params      - JS values to bind
   * @returns {Array & { columns, rowsChanged }}
   */
  _executePreparedSync(stmtHandle, params) {
    if (params && params.length > 0) {
      // Statement is reused; clear previous bindings to avoid leakage.
      lib.duckdb_clear_bindings(stmtHandle);
      this._bindParams(stmtHandle, params);
    }

    const resultPtr = new Uint8Array(64);  // duckdb_result struct is ~48 bytes
    const execStatus = lib.duckdb_execute_prepared(stmtHandle, ptr(resultPtr));

    const rp = ptr(resultPtr);
    // Honor BOTH the status code AND the error pointer. A non-zero status
    // is the canonical "failure" signal; checking only result_error misses
    // failures that didn't populate an error string (rare but real for
    // execution-time failures vs. parse errors).
    const errorPtr = lib.duckdb_result_error(rp);
    if (execStatus !== 0 || errorPtr) {
      const error = errorPtr ? fromCString(errorPtr) : 'Prepared execution failed';
      lib.duckdb_destroy_result(rp);
      throw new DuckDBError(error);
    }

    // Capture before destroy (see #querySimple).
    const rowsChanged = lib.duckdb_rows_changed(BigInt(rp));

    try {
      const rows = this.#extractChunks(resultPtr);
      rows.rowsChanged = rowsChanged;
      return rows;
    } finally {
      lib.duckdb_destroy_result(rp);
    }
  }

  // ---------------------------------------------------------------------------
  // Modern chunk-based result extraction
  //
  // Uses duckdb_fetch_chunk + duckdb_vector_get_data to read values directly
  // from DuckDB's columnar memory. No deprecated duckdb_value_* functions.
  //
  // Type-mapping contract (authoritative — the README/AGENTS tables are
  // derived from this). When updating either side, update this comment too.
  //
  //   BOOLEAN                         → boolean
  //   TINYINT/SMALLINT/INTEGER        → number
  //   UTINYINT/USMALLINT/UINTEGER     → number
  //   BIGINT/UBIGINT                  → number (lossy above 2^53)
  //   HUGEINT/UHUGEINT                → string (decimal, preserves precision)
  //   FLOAT/DOUBLE                    → number
  //   DECIMAL                         → string (decimal, preserves precision)
  //   VARCHAR                         → string
  //   BLOB                            → Uint8Array (raw bytes, copy)
  //   DATE                            → string ("YYYY-MM-DD")
  //   TIME/TIME_NS/TIME_TZ            → string (formatted ISO-ish time)
  //   TIMESTAMP/TIMESTAMP_{S,MS,NS}   → Date (UTC; NS truncated to ms)
  //   TIMESTAMP_TZ                    → Date (UTC)
  //   INTERVAL                        → string ("3 months 2 days 1.5 seconds")
  //   UUID                            → string (canonical 8-4-4-4-12)
  //   ENUM                            → string (dictionary lookup)
  //   LIST/ARRAY                      → Array
  //   STRUCT                          → object (plain {})
  //   MAP                             → object (plain {}, key stringified)
  //   BIT/UNION                       → null (not yet implemented)
  //   NULL (validity bit clear)       → null
  // ---------------------------------------------------------------------------

  // Decode the column metadata for a result. Pure data, no row decoding.
  // Shared by the materializing extract path and the streaming iterate path.
  _decodeColumnsMetadata(resultPtr) {
    const rp = ptr(resultPtr);
    const colCount = Number(lib.duckdb_column_count(rp));

    const columns = [];
    for (let c = 0; c < colCount; c++) {
      const namePtr = lib.duckdb_column_name(rp, BigInt(c));
      const type = lib.duckdb_column_type(rp, BigInt(c));
      const col = {
        name: fromCString(namePtr) || `col${c}`,
        type,
        typeName: this._typeName(type)
      };

      // Get logical type metadata for complex types
      if (type === DUCKDB_TYPE.DECIMAL || type === DUCKDB_TYPE.ENUM ||
          type === DUCKDB_TYPE.LIST || type === DUCKDB_TYPE.STRUCT ||
          type === DUCKDB_TYPE.MAP || type === DUCKDB_TYPE.ARRAY) {
        const logType = lib.duckdb_column_logical_type(rp, BigInt(c));
        if (logType) {
          if (type === DUCKDB_TYPE.DECIMAL) {
            col.decimalWidth = lib.duckdb_decimal_width(logType);
            col.decimalScale = lib.duckdb_decimal_scale(logType);
            col.decimalInternalType = lib.duckdb_decimal_internal_type(logType);
            // Inline precision into typeName so downstream consumers
            // (serializer, catalog schema JSON) get the full DECIMAL(W,S)
            // string without having to look up width/scale separately.
            col.typeName = `DECIMAL(${col.decimalWidth},${col.decimalScale})`;
          } else if (type === DUCKDB_TYPE.ENUM) {
            col.enumInternalType = lib.duckdb_enum_internal_type(logType);
            const dictSize = lib.duckdb_enum_dictionary_size(logType);
            col.enumDict = [];
            for (let d = 0; d < dictSize; d++) {
              const vp = lib.duckdb_enum_dictionary_value(logType, BigInt(d));
              col.enumDict.push(fromCString(vp));
              if (vp) lib.duckdb_free(BigInt(vp));
            }
          } else if (type === DUCKDB_TYPE.LIST) {
            const childLogType = lib.duckdb_list_type_child_type(logType);
            if (childLogType) {
              col.childType = lib.duckdb_get_type_id(childLogType);
              const ltBuf2 = allocPtr();
              new DataView(ltBuf2.buffer).setBigUint64(0, BigInt(childLogType), true);
              lib.duckdb_destroy_logical_type(ptr(ltBuf2));
            }
          } else if (type === DUCKDB_TYPE.STRUCT) {
            const childCount = Number(lib.duckdb_struct_type_child_count(logType));
            col.structChildren = [];
            for (let i = 0; i < childCount; i++) {
              const np = lib.duckdb_struct_type_child_name(logType, BigInt(i));
              const ct = lib.duckdb_struct_type_child_type(logType, BigInt(i));
              const childType = ct ? lib.duckdb_get_type_id(ct) : DUCKDB_TYPE.VARCHAR;
              col.structChildren.push({ name: fromCString(np) || `f${i}`, type: childType });
              if (np) lib.duckdb_free(BigInt(np));
              if (ct) {
                const ltBuf2 = allocPtr();
                new DataView(ltBuf2.buffer).setBigUint64(0, BigInt(ct), true);
                lib.duckdb_destroy_logical_type(ptr(ltBuf2));
              }
            }
          } else if (type === DUCKDB_TYPE.MAP) {
            const keyLogType = lib.duckdb_list_type_child_type(logType); // MAP child is STRUCT
            if (keyLogType) {
              // MAP's child is a STRUCT with key (0) and value (1)
              const keyType = lib.duckdb_struct_type_child_type(keyLogType, 0n);
              const valType = lib.duckdb_struct_type_child_type(keyLogType, 1n);
              col.keyType = keyType ? lib.duckdb_get_type_id(keyType) : DUCKDB_TYPE.VARCHAR;
              col.valueType = valType ? lib.duckdb_get_type_id(valType) : DUCKDB_TYPE.VARCHAR;
              if (keyType) {
                const b = allocPtr(); new DataView(b.buffer).setBigUint64(0, BigInt(keyType), true);
                lib.duckdb_destroy_logical_type(ptr(b));
              }
              if (valType) {
                const b = allocPtr(); new DataView(b.buffer).setBigUint64(0, BigInt(valType), true);
                lib.duckdb_destroy_logical_type(ptr(b));
              }
              const b = allocPtr(); new DataView(b.buffer).setBigUint64(0, BigInt(keyLogType), true);
              lib.duckdb_destroy_logical_type(ptr(b));
            }
          } else if (type === DUCKDB_TYPE.ARRAY) {
            col.arraySize = Number(lib.duckdb_array_type_array_size(logType));
            const childLogType = lib.duckdb_array_type_child_type(logType);
            if (childLogType) {
              col.childType = lib.duckdb_get_type_id(childLogType);
              const ltBuf2 = allocPtr();
              new DataView(ltBuf2.buffer).setBigUint64(0, BigInt(childLogType), true);
              lib.duckdb_destroy_logical_type(ptr(ltBuf2));
            }
          }
          const ltBuf = allocPtr();
          new DataView(ltBuf.buffer).setBigUint64(0, BigInt(logType), true);
          lib.duckdb_destroy_logical_type(ptr(ltBuf));
        }
      }

      columns.push(col);
    }
    return columns;
  }

  // Decode all rows from a single chunk into an array of row objects.
  // Caller is responsible for destroying the chunk after this returns.
  _decodeChunkRows(chunk, columns) {
    const chunkSize = Number(lib.duckdb_data_chunk_get_size(chunk));
    if (chunkSize === 0) return [];

    const colVec = [];
    const colData = [];
    const colValidity = [];
    for (let c = 0; c < columns.length; c++) {
      const vec = lib.duckdb_data_chunk_get_vector(chunk, BigInt(c));
      colVec.push(vec);
      const dp = vec ? lib.duckdb_vector_get_data(vec) : 0n;
      colData.push(Number(dp));
      const vp = vec ? lib.duckdb_vector_get_validity(vec) : 0n;
      colValidity.push(Number(vp));
    }

    const rows = new Array(chunkSize);
    for (let r = 0; r < chunkSize; r++) {
      const row = {};
      for (let c = 0; c < columns.length; c++) {
        const col = columns[c];
        row[col.name] = isValid(colValidity[c], r)
          ? this._readValue(colData[c], r, col.type, col, colVec[c])
          : null;
      }
      rows[r] = row;
    }
    return rows;
  }

  // Materializing chunk-by-chunk extraction. Used by the .all/.get/.run
  // path (where the caller wants the whole result as an array). The
  // streaming path (Statement.iterate) uses the same column decode + row
  // decode helpers but yields rows one at a time.
  #extractChunks(resultPtr) {
    const rp = ptr(resultPtr);
    const columns = this._decodeColumnsMetadata(resultPtr);

    const rows = [];
    const chunkBuf = allocPtr();

    while (true) {
      const chunk = fetchChunk(rp);
      if (!chunk) break;
      try {
        const decoded = this._decodeChunkRows(chunk, columns);
        if (decoded.length === 0) break;
        for (const r of decoded) rows.push(r);
      } finally {
        new DataView(chunkBuf.buffer).setBigUint64(0, BigInt(chunk), true);
        lib.duckdb_destroy_data_chunk(ptr(chunkBuf));
      }
    }

    rows.columns = columns;
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Read a single value from raw vector memory at a given row index.
  // This is the core type dispatch — reads directly from DuckDB's columnar
  // memory layout without any deprecated per-value API calls.
  // ---------------------------------------------------------------------------

  // col = column metadata (includes decimalScale, enumDict, etc.)
  // vec = vector handle (for nested type child access)
  _readValue(dataPtr, row, type, col, vec) {
    switch (type) {
      case DUCKDB_TYPE.BOOLEAN:
        return ffiRead.u8(dataPtr, row) !== 0;

      case DUCKDB_TYPE.TINYINT:
        return ffiRead.i8(dataPtr, row);
      case DUCKDB_TYPE.SMALLINT:
        return ffiRead.i16(dataPtr, row * 2);
      case DUCKDB_TYPE.INTEGER:
        return ffiRead.i32(dataPtr, row * 4);
      case DUCKDB_TYPE.UTINYINT:
        return ffiRead.u8(dataPtr, row);
      case DUCKDB_TYPE.USMALLINT:
        return ffiRead.u16(dataPtr, row * 2);
      case DUCKDB_TYPE.UINTEGER:
        return ffiRead.u32(dataPtr, row * 4);

      case DUCKDB_TYPE.BIGINT:
        return Number(ffiRead.i64(dataPtr, row * 8));
      case DUCKDB_TYPE.UBIGINT:
        return Number(ffiRead.u64(dataPtr, row * 8));

      case DUCKDB_TYPE.FLOAT:
        return ffiRead.f32(dataPtr, row * 4);
      case DUCKDB_TYPE.DOUBLE:
        return ffiRead.f64(dataPtr, row * 8);

      case DUCKDB_TYPE.HUGEINT: {
        const lo = ffiRead.u64(dataPtr, row * 16);
        const hi = ffiRead.i64(dataPtr, row * 16 + 8);
        const value = (BigInt(hi) << 64n) | BigInt(lo);
        return value.toString();
      }

      case DUCKDB_TYPE.UHUGEINT: {
        const lo = ffiRead.u64(dataPtr, row * 16);
        const hi = ffiRead.u64(dataPtr, row * 16 + 8);
        const value = (BigInt(hi) << 64n) | BigInt(lo);
        return value.toString();
      }

      case DUCKDB_TYPE.DECIMAL: {
        // Read based on internal type, divide by 10^scale, return as string
        const scale = col?.decimalScale || 0;
        const internalType = col?.decimalInternalType || DUCKDB_TYPE.DOUBLE;
        let raw;
        switch (internalType) {
          case DUCKDB_TYPE.SMALLINT:
            raw = BigInt(ffiRead.i16(dataPtr, row * 2)); break;
          case DUCKDB_TYPE.INTEGER:
            raw = BigInt(ffiRead.i32(dataPtr, row * 4)); break;
          case DUCKDB_TYPE.BIGINT:
            raw = ffiRead.i64(dataPtr, row * 8); break;
          case DUCKDB_TYPE.HUGEINT: {
            const lo = ffiRead.u64(dataPtr, row * 16);
            const hi = ffiRead.i64(dataPtr, row * 16 + 8);
            raw = (BigInt(hi) << 64n) | BigInt(lo);
            break;
          }
          default:
            return ffiRead.f64(dataPtr, row * 8);
        }
        if (scale === 0) return raw.toString();
        const divisor = 10n ** BigInt(scale);
        const sign = raw < 0n ? '-' : '';
        const abs = raw < 0n ? -raw : raw;
        const intPart = abs / divisor;
        const fracPart = abs % divisor;
        return `${sign}${intPart}.${fracPart.toString().padStart(scale, '0')}`;
      }

      case DUCKDB_TYPE.DATE: {
        const days = ffiRead.i32(dataPtr, row * 4);
        const ms = days * 86400000;
        const d = new Date(ms);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
      }

      case DUCKDB_TYPE.TIMESTAMP:
      case DUCKDB_TYPE.TIMESTAMP_S:
      case DUCKDB_TYPE.TIMESTAMP_MS:
      case DUCKDB_TYPE.TIMESTAMP_NS:
      case DUCKDB_TYPE.TIMESTAMP_TZ: {
        const micros = ffiRead.i64(dataPtr, row * 8);
        return new Date(Number(micros / 1000n));
      }

      case DUCKDB_TYPE.TIME: {
        const us = Number(ffiRead.i64(dataPtr, row * 8));
        const totalSec = Math.floor(us / 1000000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const frac = us % 1000000;
        return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` +
               (frac > 0 ? `.${String(frac).padStart(6,'0').replace(/0+$/, '')}` : '');
      }

      case DUCKDB_TYPE.TIME_NS: {
        const ns = ffiRead.i64(dataPtr, row * 8);
        const totalUs = Number(ns / 1000n);
        const subUs = Number(ns % 1000n);
        const totalSec = Math.floor(totalUs / 1000000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const fracUs = totalUs % 1000000;
        const fracNs = fracUs * 1000 + subUs;
        return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` +
               (fracNs > 0 ? `.${String(fracNs).padStart(9,'0').replace(/0+$/, '')}` : '');
      }

      case DUCKDB_TYPE.TIME_TZ: {
        // Stored as uint64: upper 40 bits = microseconds, lower 24 bits = offset + 86399
        const bits = ffiRead.u64(dataPtr, row * 8);
        const us = Number(bits >> 24n);
        const offsetSec = Number(bits & 0xFFFFFFn) - 86399;
        const totalSec = Math.floor(us / 1000000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const frac = us % 1000000;
        const absOff = Math.abs(offsetSec);
        const offH = Math.floor(absOff / 3600);
        const offM = Math.floor((absOff % 3600) / 60);
        const sign = offsetSec >= 0 ? '+' : '-';
        return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` +
               (frac > 0 ? `.${String(frac).padStart(6,'0').replace(/0+$/, '')}` : '') +
               `${sign}${String(offH).padStart(2,'0')}:${String(offM).padStart(2,'0')}`;
      }

      case DUCKDB_TYPE.UUID:
        return readUUID(dataPtr, row);

      case DUCKDB_TYPE.VARCHAR:
        return readString(dataPtr, row);

      case DUCKDB_TYPE.BLOB:
        // Binary data: return raw bytes. Going through TextDecoder would
        // corrupt non-UTF-8 sequences (replaced with U+FFFD). The returned
        // Uint8Array is a fresh copy and safe to retain after chunk
        // destruction (see readBytes).
        return readBytes(dataPtr, row);

      case DUCKDB_TYPE.INTERVAL: {
        const months = ffiRead.i32(dataPtr, row * 16);
        const days = ffiRead.i32(dataPtr, row * 16 + 4);
        const micros = Number(ffiRead.i64(dataPtr, row * 16 + 8));
        const parts = [];
        if (months) parts.push(`${months} month${months !== 1 ? 's' : ''}`);
        if (days) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
        if (micros) {
          const secs = micros / 1000000;
          parts.push(`${secs} second${secs !== 1 ? 's' : ''}`);
        }
        return parts.join(' ') || '0 seconds';
      }

      case DUCKDB_TYPE.ENUM: {
        // Read integer index, look up string from pre-built dictionary
        const dict = col?.enumDict;
        if (!dict) return null;
        const enumType = col?.enumInternalType || DUCKDB_TYPE.UTINYINT;
        let idx;
        switch (enumType) {
          case DUCKDB_TYPE.UTINYINT:  idx = ffiRead.u8(dataPtr, row); break;
          case DUCKDB_TYPE.USMALLINT: idx = ffiRead.u16(dataPtr, row * 2); break;
          case DUCKDB_TYPE.UINTEGER:  idx = ffiRead.u32(dataPtr, row * 4); break;
          default:                    idx = ffiRead.u32(dataPtr, row * 4); break;
        }
        return dict[idx] ?? null;
      }

      case DUCKDB_TYPE.LIST: {
        if (!vec) return null;
        const entryOffset = row * 16;
        const listOffset = Number(ffiRead.u64(dataPtr, entryOffset));
        const listLength = Number(ffiRead.u64(dataPtr, entryOffset + 8));
        const childVec = lib.duckdb_list_vector_get_child(vec);
        const childData = Number(lib.duckdb_vector_get_data(childVec));
        const childValidity = Number(lib.duckdb_vector_get_validity(childVec));
        const childType = col?.childType || DUCKDB_TYPE.VARCHAR;
        const result = [];
        for (let i = 0; i < listLength; i++) {
          const childRow = listOffset + i;
          if (!isValid(childValidity, childRow)) {
            result.push(null);
          } else {
            result.push(this._readValue(childData, childRow, childType, null, childVec));
          }
        }
        return result;
      }

      case DUCKDB_TYPE.STRUCT: {
        if (!vec) return null;
        const obj = {};
        const childCount = col?.structChildren?.length || 0;
        for (let i = 0; i < childCount; i++) {
          const child = col.structChildren[i];
          const childVec = lib.duckdb_struct_vector_get_child(vec, BigInt(i));
          const childData = Number(lib.duckdb_vector_get_data(childVec));
          const childValidity = Number(lib.duckdb_vector_get_validity(childVec));
          if (!isValid(childValidity, row)) {
            obj[child.name] = null;
          } else {
            obj[child.name] = this._readValue(childData, row, child.type, null, childVec);
          }
        }
        return obj;
      }

      case DUCKDB_TYPE.MAP: {
        if (!vec) return null;
        const entryOffset = row * 16;
        const listOffset = Number(ffiRead.u64(dataPtr, entryOffset));
        const listLength = Number(ffiRead.u64(dataPtr, entryOffset + 8));
        const childVec = lib.duckdb_list_vector_get_child(vec);
        const keyVec = lib.duckdb_struct_vector_get_child(childVec, 0n);
        const valVec = lib.duckdb_struct_vector_get_child(childVec, 1n);
        const keyData = Number(lib.duckdb_vector_get_data(keyVec));
        const valData = Number(lib.duckdb_vector_get_data(valVec));
        const keyValidity = Number(lib.duckdb_vector_get_validity(keyVec));
        const valValidity = Number(lib.duckdb_vector_get_validity(valVec));
        const keyType = col?.keyType || DUCKDB_TYPE.VARCHAR;
        const valType = col?.valueType || DUCKDB_TYPE.VARCHAR;
        const obj = {};
        for (let i = 0; i < listLength; i++) {
          const childRow = listOffset + i;
          const k = isValid(keyValidity, childRow)
            ? this._readValue(keyData, childRow, keyType, null, keyVec) : null;
          const v = isValid(valValidity, childRow)
            ? this._readValue(valData, childRow, valType, null, valVec) : null;
          if (k !== null) obj[String(k)] = v;
        }
        return obj;
      }

      case DUCKDB_TYPE.ARRAY: {
        if (!vec) return null;
        const arraySize = col?.arraySize || 0;
        const childVec = lib.duckdb_array_vector_get_child(vec);
        const childData = Number(lib.duckdb_vector_get_data(childVec));
        const childValidity = Number(lib.duckdb_vector_get_validity(childVec));
        const childType = col?.childType || DUCKDB_TYPE.VARCHAR;
        const baseIdx = row * arraySize;
        const result = [];
        for (let i = 0; i < arraySize; i++) {
          const childRow = baseIdx + i;
          if (!isValid(childValidity, childRow)) {
            result.push(null);
          } else {
            result.push(this._readValue(childData, childRow, childType, null, childVec));
          }
        }
        return result;
      }

      case DUCKDB_TYPE.UNION:
      case DUCKDB_TYPE.BIT:
        return null; // Rarely used types

      default:
        try { return readString(dataPtr, row); }
        catch { return null; }
    }
  }

  _typeName(type) {
    for (const [name, value] of Object.entries(DUCKDB_TYPE)) {
      if (value === type) return name;
    }
    return 'UNKNOWN';
  }

  _bindParams(stmtHandle, params) {
    for (let i = 0; i < params.length; i++) {
      const paramIdx = BigInt(i + 1);
      const value = params[i];

      if (value === null || value === undefined) {
        lib.duckdb_bind_null(stmtHandle, paramIdx);
      } else if (typeof value === 'boolean') {
        lib.duckdb_bind_boolean(stmtHandle, paramIdx, value);
      } else if (typeof value === 'number') {
        if (Number.isInteger(value)) {
          lib.duckdb_bind_int64(stmtHandle, paramIdx, BigInt(value));
        } else {
          lib.duckdb_bind_double(stmtHandle, paramIdx, value);
        }
      } else if (typeof value === 'bigint') {
        lib.duckdb_bind_int64(stmtHandle, paramIdx, value);
      } else if (value instanceof Date) {
        const strBytes = toCString(value.toISOString());
        lib.duckdb_bind_varchar(stmtHandle, paramIdx, ptr(strBytes));
      } else if (value instanceof Uint8Array) {
        lib.duckdb_bind_blob(stmtHandle, paramIdx, ptr(value), BigInt(value.byteLength));
      } else if (value instanceof ArrayBuffer) {
        const view = new Uint8Array(value);
        lib.duckdb_bind_blob(stmtHandle, paramIdx, ptr(view), BigInt(view.byteLength));
      } else {
        const strBytes = toCString(String(value));
        lib.duckdb_bind_varchar(stmtHandle, paramIdx, ptr(strBytes));
      }
    }
  }

  #appendValue(appenderHandle, value) {
    if (value === null || value === undefined) {
      lib.duckdb_append_null(appenderHandle);
    } else if (typeof value === 'boolean') {
      lib.duckdb_append_bool(appenderHandle, value);
    } else if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        lib.duckdb_append_int64(appenderHandle, BigInt(value));
      } else {
        lib.duckdb_append_double(appenderHandle, value);
      }
    } else if (typeof value === 'bigint') {
      lib.duckdb_append_int64(appenderHandle, value);
    } else if (value instanceof Date) {
      const strBytes = toCString(value.toISOString());
      lib.duckdb_append_varchar(appenderHandle, ptr(strBytes));
    } else if (value instanceof Uint8Array) {
      lib.duckdb_append_blob(appenderHandle, ptr(value), BigInt(value.byteLength));
    } else if (value instanceof ArrayBuffer) {
      const view = new Uint8Array(value);
      lib.duckdb_append_blob(appenderHandle, ptr(view), BigInt(view.byteLength));
    } else {
      const strBytes = toCString(String(value));
      lib.duckdb_append_varchar(appenderHandle, ptr(strBytes));
    }
  }

  /**
   * Bulk insert rows using the DuckDB Appender API (fastest path)
   * @param {string} table - Table name
   * @param {string[]} columns - Column names
   * @param {any[][]} rows - Array of value arrays (positional, matching columns)
   * @returns {Promise<{rows: number}>}
   */
  append(table, columns, rows) {
    return this.withLock(() => {
      if (this.#state !== 'open') throw new DuckDBClosedError('Connection');
      const appenderPtr = allocPtr();
      const tableBytes = toCString(table);

      const status = lib.duckdb_appender_create(this.#handle, null, ptr(tableBytes), ptr(appenderPtr));
      if (status !== 0) {
        const handle = readHandle(appenderPtr);
        if (handle) {
          const errPtr = lib.duckdb_appender_error(handle);
          const errMsg = errPtr ? fromCString(errPtr) : 'Failed to create appender';
          lib.duckdb_appender_destroy(ptr(appenderPtr));
          throw new Error(errMsg);
        }
        throw new Error('Failed to create appender');
      }

      const appenderHandle = readHandle(appenderPtr);

      try {
        if (columns && columns.length > 0) {
          lib.duckdb_appender_clear_columns(appenderHandle);
          for (const col of columns) {
            const colBytes = toCString(col);
            const addStatus = lib.duckdb_appender_add_column(appenderHandle, ptr(colBytes));
            if (addStatus !== 0) {
              const errPtr = lib.duckdb_appender_error(appenderHandle);
              throw new Error(errPtr ? fromCString(errPtr) : `Failed to add column: ${col}`);
            }
          }
        }

        for (const row of rows) {
          for (const value of row) {
            this.#appendValue(appenderHandle, value);
          }
          lib.duckdb_appender_end_row(appenderHandle);
        }

        const flushStatus = lib.duckdb_appender_flush(appenderHandle);
        if (flushStatus !== 0) {
          const errPtr = lib.duckdb_appender_error(appenderHandle);
          const errMsg = errPtr ? fromCString(errPtr) : 'Appender flush failed';
          throw new Error(errMsg);
        }

        return { rows: rows.length };
      } finally {
        lib.duckdb_appender_destroy(ptr(appenderPtr));
      }
    });
  }

  /**
   * Execute a prepared statement multiple times with different param sets.
   * One prepare + N executes + one destroy — much cheaper than calling
   * `conn.query(sql, params)` in a loop, which re-prepares every iteration.
   *
   * No rows are materialized; the return value is `{ rows: N }` where N
   * is the number of param sets executed. For row-returning batch use,
   * prefer Statement.all/get in a loop (each call materializes rows).
   *
   * @param {string} sql        - SQL with `?` placeholders
   * @param {any[][]} paramSets - Array of param arrays, one per execution
   * @returns {Promise<{rows: number}>}
   */
  executeBatchPrepared(sql, paramSets) {
    return this.withLock(() => {
      if (this.#state !== 'open') throw new DuckDBClosedError('Connection');
      const stmtPtr = allocPtr();
      const sqlBytes = toCString(sql);

      const prepStatus = lib.duckdb_prepare(this.#handle, ptr(sqlBytes), ptr(stmtPtr));
      if (prepStatus !== 0) {
        const stmtHandle = readHandle(stmtPtr);
        if (stmtHandle) {
          const errPtr = lib.duckdb_prepare_error(stmtHandle);
          const errMsg = errPtr ? fromCString(errPtr) : 'Failed to prepare statement';
          lib.duckdb_destroy_prepare(ptr(stmtPtr));
          throw new Error(errMsg);
        }
        throw new Error('Failed to prepare statement');
      }

      const stmtHandle = readHandle(stmtPtr);
      let totalRows = 0;

      try {
        for (const params of paramSets) {
          this._bindParams(stmtHandle, params);

          const resultPtr = new Uint8Array(64);
          lib.duckdb_execute_prepared(stmtHandle, ptr(resultPtr));

          const rp = ptr(resultPtr);
          const errorPtr = lib.duckdb_result_error(rp);
          if (errorPtr) {
            const error = fromCString(errorPtr);
            lib.duckdb_destroy_result(rp);
            throw new Error(error);
          }

          lib.duckdb_destroy_result(rp);
          lib.duckdb_clear_bindings(stmtHandle);
          totalRows++;
        }

        return { rows: totalRows };
      } finally {
        lib.duckdb_destroy_prepare(ptr(stmtPtr));
      }
    });
  }

  /**
   * Back-compat alias for executeBatchPrepared(). The method was originally
   * named queryBatch() in v0.1; the documented public name is now
   * executeBatchPrepared (clearer about what it does — no rows are returned).
   * This alias is retained so any pre-existing callers keep working; new
   * code should prefer executeBatchPrepared.
   */
  queryBatch(sql, paramSets) {
    return this.executeBatchPrepared(sql, paramSets);
  }

  /**
   * Parse a SQL string and return the number of statements it contains.
   * Used by /ddb/exec to refuse multi-statement input authoritatively
   * (a leading-keyword regex isn't enough — DuckDB's parser would happily
   * execute `INSERT ...; DROP TABLE ...;` if asked).
   *
   * Returns 0 on parse failure. Callers MUST treat 0 as "could not be
   * validated" and refuse to execute the body — proceeding to conn.query
   * on a 0-count would let an unparseable body bypass the single-statement
   * check entirely. The /ddb/exec endpoint enforces `count == 1`.
   *
   * Throws on FFI lifecycle failures (also fail-closed).
   */
  countStatements(sql) {
    const handlePtr = allocPtr();
    const sqlBytes = toCString(sql);
    const count = lib.duckdb_extract_statements(this.#handle, ptr(sqlBytes), ptr(handlePtr));
    // Always free the handle, even when count == 0. Surface the parser's
    // error message via duckdb_extract_statements_error if the caller asks
    // (it's stored on the extracted-statements handle).
    try {
      const n = Number(count);
      if (n === 0) {
        const handle = readHandle(handlePtr);
        if (handle) {
          const errPtr = lib.duckdb_extract_statements_error(handle);
          if (errPtr) {
            const msg = fromCString(errPtr);
            // Throw with the parser's actual error message so /ddb/exec's
            // fail-closed catch returns something diagnostic instead of
            // an opaque "0 statements" message.
            throw new Error(msg || 'duckdb_extract_statements failed');
          }
        }
      }
      return n;
    } finally {
      lib.duckdb_destroy_extracted(ptr(handlePtr));
    }
  }

  // ===========================================================================
  // Shortcut methods (v0.2)
  //
  // These mirror better-sqlite3 / bun:sqlite conventions but stay async because
  // every FFI call goes through withLock for serialization.
  // ===========================================================================

  /** Alias for query(). Returns the full QueryResult. */
  all(sql, params) {
    return this.query(sql, params);
  }

  /** Returns the first row, or undefined if no rows. */
  async get(sql, params) {
    const rows = await this.query(sql, params);
    return rows.length > 0 ? rows[0] : undefined;
  }

  /** Executes sql for its side effects. Returns { rowsChanged }. */
  async run(sql, params) {
    const rows = await this.query(sql, params);
    return { rowsChanged: rows.rowsChanged };
  }

  /** Fire-and-forget multi-statement execution. No params, no rows returned. */
  async exec(sql) {
    await this.query(sql);
  }

  /**
   * Run `PRAGMA name` (get-form) or `PRAGMA name=value` (set-form).
   * Strict identifier validation + SQL-literal escaping — safe to
   * pass user input.
   *
   * Get-form: `PRAGMA <name>`. Returns the first **row object** from
   * the result (or `undefined` if empty). Useful for the pragma-as-
   * function pattern: `db.pragma('version')` →
   * `{ library_version: 'v1.5.2', source_id: ..., codename: ... }`.
   *
   * Set-form: `PRAGMA <name>=<value>`. Returns `undefined`.
   *
   * **Note:** DuckDB distinguishes PRAGMAs (function-like queries:
   * `database_size`, `version`, `table_info(...)`) from runtime
   * **settings** (`threads`, `memory_limit`). PRAGMA set-form
   * (`PRAGMA threads=2`) works for settings, but PRAGMA get-form
   * does NOT — DuckDB exposes setting reads via `current_setting()`.
   * For settings, use:
   *
   *     await db.pragma('threads', 2);                       // set
   *     await db.get("SELECT current_setting('threads')");   // get
   *
   * Or pass settings to `open(path, { threads, memoryLimit, ... })`
   * for startup-wide config.
   *
   * @param {string} name - PRAGMA name (must match identifier regex)
   * @param {string|number|boolean|bigint|null|undefined} [value]
   * @returns {Promise<object|undefined>} first row, or undefined
   */
  async pragma(name, value) {
    assertSimpleIdentifier(name, 'PRAGMA name');
    let sql;
    if (arguments.length < 2) {
      sql = `PRAGMA ${name}`;
    } else {
      sql = `PRAGMA ${name}=${quoteSqlLiteral(value)}`;
    }
    const rows = await this.query(sql);
    return rows.length > 0 ? rows[0] : undefined;
  }

  /**
   * Install a DuckDB extension. Wraps `INSTALL <name>` with strict
   * identifier validation so user-provided names can't inject SQL.
   *
   * @param {string} name - extension name (must match identifier regex)
   */
  async installExtension(name) {
    assertSimpleIdentifier(name, 'extension name');
    await this.exec(`INSTALL ${name}`);
  }

  /**
   * Load a DuckDB extension. Wraps `LOAD <name>` with strict
   * identifier validation. Extensions are connection-scoped in
   * DuckDB; loading on one Connection doesn't load on siblings.
   *
   * @param {string} name - extension name
   */
  async loadExtension(name) {
    assertSimpleIdentifier(name, 'extension name');
    await this.exec(`LOAD ${name}`);
  }

  /**
   * Flush the WAL to disk via DuckDB's `CHECKPOINT` statement.
   *
   * Useful for durability guarantees on file-backed databases (e.g.
   * before process exit). For in-memory databases CHECKPOINT is a
   * no-op but doesn't error.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.force=false] - emit `FORCE CHECKPOINT`,
   *   which checkpoints even with active transactions present (they
   *   are first ABORTed). Without `force`, an active transaction
   *   anywhere in the database can cause the checkpoint to fail.
   * @param {string} [opts.database] - target a specific attached
   *   database by name (DuckDB supports `ATTACH '...' AS aux`).
   *   Strictly validated as an identifier (no SQL injection).
   * @returns {Promise<void>}
   */
  async checkpoint(opts = {}) {
    const force = opts && opts.force === true;
    let sql = force ? 'FORCE CHECKPOINT' : 'CHECKPOINT';
    if (opts && opts.database !== undefined) {
      assertSimpleIdentifier(opts.database, 'database name');
      sql += ` ${opts.database}`;
    }
    await this.exec(sql);
  }

  /**
   * Stream rows from a SQL query. Sugar around `prepare(sql).iterate(params)`
   * that owns the prepared statement's lifecycle so the consumer doesn't
   * have to. Prepares LAZILY on first `.next()`, so abandoning the iterator
   * without iterating doesn't allocate any FFI resources.
   *
   * The temporary Statement is closed in the iterator's `finally`, even on
   * early `break` / `.return()` / `.throw()`.
   *
   * @param {string} sql
   * @param {any[]} params
   * @returns {AsyncIterableIterator<object>}
   */
  iterate(sql, params = []) {
    if (this.#state !== 'open') throw new DuckDBClosedError('Connection');
    const conn = this;
    return (async function* () {
      const stmt = await conn.prepare(sql);
      try {
        for await (const row of stmt.iterate(params)) yield row;
      } finally {
        try { await stmt.close(); } catch { /* swallow */ }
      }
    })();
  }

  /**
   * Chunk-by-chunk streaming sugar. Same lazy-prepare semantics as
   * iterate(): the temp Statement is allocated on first .next() and
   * closed in `finally` regardless of how iteration terminates.
   *
   * Yields `{ rows: Row[], chunkIndex: number, rowOffset: number }`
   * — useful for batch-style processing where per-row yield overhead
   * matters.
   *
   * @param {string} sql
   * @param {any[]} params
   * @returns {AsyncIterableIterator<{rows: object[], chunkIndex: number, rowOffset: number}>}
   */
  chunks(sql, params = []) {
    if (this.#state !== 'open') throw new DuckDBClosedError('Connection');
    const conn = this;
    return (async function* () {
      const stmt = await conn.prepare(sql);
      try {
        for await (const chunk of stmt.chunks(params)) yield chunk;
      } finally {
        try { await stmt.close(); } catch { /* swallow */ }
      }
    })();
  }

  /**
   * Prepare an SQL statement for repeated execution. The returned Statement
   * holds the prepared handle until close() is called; reuse it via .all/get/run.
   * Falls under withLock to serialize with other in-flight queries on this conn.
   *
   * `async function` so the closed-state check rejects rather than throwing
   * synchronously (consistent with the rest of the async surface).
   *
   * @returns {Promise<Statement>}
   */
  async prepare(sql) {
    if (this.#state !== 'open') throw new DuckDBClosedError('Connection');
    return this.withLock(() => {
      if (this.#state !== 'open') throw new DuckDBClosedError('Connection');
      const stmtPtr = allocPtr();
      const sqlBytes = toCString(sql);
      const status = lib.duckdb_prepare(this.#handle, ptr(sqlBytes), ptr(stmtPtr));
      if (status !== 0) {
        const stmtHandle = readHandle(stmtPtr);
        if (stmtHandle) {
          const errPtr = lib.duckdb_prepare_error(stmtHandle);
          const msg = errPtr ? fromCString(errPtr) : 'Failed to prepare statement';
          lib.duckdb_destroy_prepare(ptr(stmtPtr));
          throw new DuckDBPrepareError(msg);
        }
        throw new DuckDBPrepareError('Failed to prepare statement');
      }
      const stmtHandle = readHandle(stmtPtr);
      return new Statement(this, stmtHandle, stmtPtr);
    });
  }

  // Per-Connection transaction state (v0.5+).
  // SAVEPOINT-based nested transactions were planned for v0.5, but
  // DuckDB v1.5.2 (our pinned version) doesn't support SAVEPOINT —
  // it's an open upstream feature request. Until upstream lands it,
  // nested transactions throw DuckDBTransactionError (same as v0.4).
  //
  // What v0.5 DOES improve: the callback now receives a scoped
  // TxnHandle (not the raw Connection). Using the handle after the
  // callback returns throws DuckDBTransactionError. This catches the
  // common "user stashed tx somewhere and used it later" bug.
  #inTransaction = false;

  /**
   * Run fn() inside a transaction. BEGIN before, COMMIT after success,
   * ROLLBACK + rethrow on any throw. fn receives a scoped TxnHandle
   * that mirrors the Connection's read/write methods but is marked
   * inactive after the callback returns — using it after that throws
   * DuckDBTransactionError.
   *
   * Nested transactions are NOT supported (DuckDB v1.5.2 doesn't
   * support SAVEPOINT). Calling `tx.transaction(...)` inside the
   * callback throws DuckDBTransactionError. This will be revisited
   * when upstream DuckDB adds SAVEPOINT support.
   *
   * @template R
   * @param {(tx: TxnHandle) => Promise<R>} fn
   * @returns {Promise<R>}
   */
  async transaction(fn) {
    if (this.#inTransaction) {
      throw new DuckDBTransactionError(
        'Nested transactions are not supported because DuckDB v1.5.2 ' +
        'does not currently parse SAVEPOINT. This will be revisited ' +
        'when upstream DuckDB adds SAVEPOINT support.',
      );
    }
    this.#inTransaction = true;
    const scope = { closed: false, isNested: false };
    const txHandle = makeTxnHandle(this, scope);
    try {
      await this.query('BEGIN');
      let result;
      try {
        result = await fn(txHandle);
      } catch (err) {
        scope.closed = true;
        try { await this.query('ROLLBACK'); } catch { /* swallow */ }
        throw err;
      }
      scope.closed = true;
      await this.query('COMMIT');
      return result;
    } finally {
      // Defensive: if anything blew up between BEGIN's resolve and
      // scope.closed being set, make sure the handle is dead.
      scope.closed = true;
      this.#inTransaction = false;
    }
  }

  // close() is async as of v0.3.0. Coordinates with the in-flight
  // Statement.iterate() (if any) by cancelling it via .return() — that
  // forces the paused generator to run its finally and release the
  // connection lock. Only THEN do we acquire the lock for FFI destroy,
  // so any queries queued behind the iterator wake up, see state ==
  // 'closing' inside their critical section, and abort cleanly with
  // DuckDBClosedError before any FFI call.
  //
  // The public handle/ptrBuf are nulled synchronously so the v0.2-era
  // contract `conn.close(); conn.handle === null` still holds without
  // awaiting.
  //
  // Idempotent via #closePromise.
  async close() {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state === 'closed') return;
    this.#state = 'closing';

    const ptrBuf = this.#ptrBuf;
    this.#ptrBuf = null;
    this.#handle = null;

    // Snapshot child resources before async work.
    const activeIt = this.#activeIterator;
    this.#activeIterator = null;

    // Kick off Statement.close() on each tracked child synchronously
    // (without await). This flips each Statement's #state to 'closing'
    // immediately so the v0.2-era contract `conn.close(); stmt.closed
    // === true` still holds with the sync getter. Capture the promises
    // to await in the async tail before we destroy the connection.
    const stmtPromises = [];
    for (const stmt of this.#statements) {
      stmtPromises.push(stmt.close().catch(() => { /* swallow */ }));
    }
    this.#statements.clear();

    this.#closePromise = (async () => {
      // 1. Cancel any active iterator. Its finally block destroys its
      //    own result + chunk handles and releases the lock.
      if (activeIt) {
        try { await activeIt.return(); } catch { /* swallow */ }
      }
      // 2. Wait for all child Statement.close() to finish their async
      //    cleanup before we disconnect.
      for (const p of stmtPromises) await p;
      // 3. Acquire the lock for the FFI disconnect. Any queries queued
      //    behind the iterator (or behind any in-flight FFI call) will
      //    run before us; they re-check #state inside their callback
      //    and reject with DuckDBClosedError, then the queue drains
      //    and we get the lock.
      await this.withLock(() => {
        if (ptrBuf) {
          lib.duckdb_disconnect(ptr(ptrBuf));
        }
        this.#state = 'closed';
      });
    })();
    return this.#closePromise;
  }

  [Symbol.dispose]() { this.close().catch(() => { /* fire-and-forget */ }); }
  [Symbol.asyncDispose]() { return this.close(); }
}

// ==============================================================================
// Statement Class (v0.2)
//
// Holds a prepared statement handle for repeated execution. Created via
// `Connection.prepare(sql)` or `Database.prepare(sql)` (which delegates to
// the implicit Connection). Methods serialize through the Connection's
// FFI lock, so concurrent .all/.get/.run calls on a single Statement are
// safe (they run sequentially).
//
// Lifecycle: explicit close() required. Idempotent. Using a closed Statement
// throws DuckDBClosedError. The owning Connection holds a strong ref via
// the closure that wraps it, so it doesn't get GC'd while statements live.
// ==============================================================================

class Statement {
  #conn = null;
  #handle = null;
  #stmtPtr = null;
  #state = 'open';           // 'open' | 'closing' | 'closed'
  #closePromise = null;
  #activeIterator = null;    // wrapper for in-flight iterate(), if any

  constructor(conn, handle, stmtPtr) {
    this.#conn = conn;
    this.#handle = handle;
    this.#stmtPtr = stmtPtr;
    conn._trackStatement?.(this);
  }

  // .closed is read synchronously by tests immediately after .close().
  // It must flip to true the moment close() is called, even though the
  // FFI destroy happens in the async tail.
  get closed() { return this.#state !== 'open'; }
  get _state() { return this.#state; }

  /**
   * Execute and return all rows as QueryResult.
   *
   * `async function` so the closed-state checks throw via Promise rejection
   * (matching what users expect from `await stmt.all(...)`).
   */
  async all(params = []) {
    if (this.#state !== 'open') throw new DuckDBClosedError('Statement');
    if (!this.#conn || !this.#conn._isOpen()) {
      throw new DuckDBClosedError('Connection (statement\'s owning connection)');
    }
    if (this.#activeIterator) {
      throw new DuckDBError('Statement is iterating; consume or close the iterator first');
    }
    const handle = this.#handle;
    const conn = this.#conn;
    return conn.withLock(() => {
      // Recheck inside the lock — both close() and conn.close() can have
      // flipped state while we waited in the mutex queue.
      if (this.#state !== 'open' || !conn._isOpen()) {
        throw new DuckDBClosedError('Statement');
      }
      return conn._executePreparedSync(handle, params);
    });
  }

  /** Execute and return first row, or undefined. */
  async get(params = []) {
    const rows = await this.all(params);
    return rows.length > 0 ? rows[0] : undefined;
  }

  /** Execute for side effects. Returns { rowsChanged }. */
  async run(params = []) {
    const rows = await this.all(params);
    return { rowsChanged: rows.rowsChanged };
  }

  /**
   * Stream rows one at a time without materializing the full result set
   * in memory. Holds the owning Connection's lock for the iterator's
   * entire lifetime — concurrent queries on the same Connection will
   * queue behind the iterator until the consumer breaks/returns/closes.
   * For parallelism, use multiple `db.connect()` connections.
   *
   * Synchronous gates (closed checks, already-iterating check, register
   * #activeIterator) run inside `iterate()` itself; the actual FFI work
   * happens inside an inner async generator returned via a wrapper. The
   * wrapper handles the pre-start `.return()` case where the consumer
   * abandons the iterator without ever calling `.next()`.
   *
   * @param {any[]} params - positional bind parameters
   * @returns {AsyncIterableIterator<object>}
   */
  iterate(params = []) {
    if (this.#state !== 'open') throw new DuckDBClosedError('Statement');
    if (!this.#conn || !this.#conn._isOpen()) {
      throw new DuckDBClosedError('Connection (statement\'s owning connection)');
    }
    if (this.#activeIterator) {
      throw new DuckDBError('Statement is already iterating');
    }

    const self = this;
    const conn = this.#conn;
    const handle = this.#handle;
    // ref.wrapper is filled below after the wrapper is constructed.
    // The generator reads it from its finally block to clear the
    // Connection's #activeIterator slot by identity (so a stale
    // generator can't clobber a freshly-started iterator's slot).
    const ref = { wrapper: null };
    const gen = this.#iterateImpl(handle, conn, params, ref);

    let started  = false;
    let finished = false;

    const wrapper = {
      [Symbol.asyncIterator]() { return wrapper; },

      async next(...args) {
        if (finished) return { value: undefined, done: true };
        started = true;
        try {
          return await gen.next(...args);
        } catch (err) {
          finished = true;
          throw err;
        }
      },

      async return(value) {
        if (finished) return { value, done: true };
        finished = true;
        if (!started) {
          // Generator body never executed — no lock acquired, no
          // result/chunk to destroy. Clear our state, then dispose the
          // generator object so future .next() returns done.
          self.#activeIterator = null;
          conn._clearActiveIterator?.(wrapper);
          try { await gen.return(value); } catch { /* never started */ }
          return { value, done: true };
        }
        return gen.return(value);
      },

      async throw(err) {
        if (finished) throw err;
        finished = true;
        if (!started) {
          self.#activeIterator = null;
          conn._clearActiveIterator?.(wrapper);
        }
        started = true;
        return gen.throw(err);
      },
    };

    this.#activeIterator = wrapper;
    conn._setActiveIterator(wrapper);
    ref.wrapper = wrapper;
    return wrapper;
  }

  /**
   * Stream the result set chunk-by-chunk rather than row-by-row.
   *
   * Mirrors `iterate()`'s lifecycle exactly: holds the owning
   * Connection's lock for the iterator's lifetime, registers as the
   * Connection's active iterator, cleans up on break / throw /
   * explicit `.return()` / `close()`. The only difference is the
   * yield shape — `iterate()` yields rows, `chunks()` yields
   * `{ rows: Row[], chunkIndex: number, rowOffset: number }` so
   * callers doing batch-style processing don't pay the per-yield
   * loop cost.
   *
   * Concurrent iteration (either `iterate` or `chunks`) on the same
   * Statement throws `DuckDBError`.
   *
   * @param {any[]} params - positional bind parameters
   * @returns {AsyncIterableIterator<{rows: object[], chunkIndex: number, rowOffset: number}>}
   */
  chunks(params = []) {
    if (this.#state !== 'open') throw new DuckDBClosedError('Statement');
    if (!this.#conn || !this.#conn._isOpen()) {
      throw new DuckDBClosedError('Connection (statement\'s owning connection)');
    }
    if (this.#activeIterator) {
      throw new DuckDBError('Statement is already iterating');
    }

    const conn = this.#conn;
    const handle = this.#handle;
    const ref = { wrapper: null };
    const gen = this.#chunksImpl(handle, conn, params, ref);

    let started  = false;
    let finished = false;
    const self = this;

    const wrapper = {
      [Symbol.asyncIterator]() { return wrapper; },
      async next(...args) {
        if (finished) return { value: undefined, done: true };
        started = true;
        try { return await gen.next(...args); }
        catch (err) { finished = true; throw err; }
      },
      async return(value) {
        if (finished) return { value, done: true };
        finished = true;
        if (!started) {
          self.#activeIterator = null;
          conn._clearActiveIterator?.(wrapper);
          try { await gen.return(value); } catch {}
          return { value, done: true };
        }
        return gen.return(value);
      },
      async throw(err) {
        if (finished) throw err;
        finished = true;
        if (!started) {
          self.#activeIterator = null;
          conn._clearActiveIterator?.(wrapper);
        }
        started = true;
        return gen.throw(err);
      },
    };
    this.#activeIterator = wrapper;
    conn._setActiveIterator(wrapper);
    ref.wrapper = wrapper;
    return wrapper;
  }

  async *#chunksImpl(handle, conn, params, ref) {
    let release = null;
    let resultPtr = null;
    let rp = 0;
    try {
      release = await conn.acquireLock();
      if (this.#state !== 'open' || !conn._isOpen()) return;
      if (params && params.length > 0) {
        lib.duckdb_clear_bindings(handle);
        conn._bindParams(handle, params);
      }
      resultPtr = new Uint8Array(64);
      const status = lib.duckdb_execute_prepared(handle, ptr(resultPtr));
      rp = ptr(resultPtr);
      const errPtr = lib.duckdb_result_error(rp);
      if (status !== 0 || errPtr) {
        throw new DuckDBError(errPtr ? fromCString(errPtr) : 'Prepared execution failed');
      }
      const columns = conn._decodeColumnsMetadata(resultPtr);
      const chunkBuf = allocPtr();
      let chunkIndex = 0;
      let rowOffset = 0;
      while (true) {
        if (this.#state !== 'open' || !conn._isOpen()) break;
        const chunk = fetchChunk(rp);
        if (!chunk) break;
        try {
          const chunkSize = Number(lib.duckdb_data_chunk_get_size(chunk));
          if (chunkSize === 0) break;
          const rows = conn._decodeChunkRows(chunk, columns);
          // Attach .columns for convenience — same shape as QueryResult.
          rows.columns = columns;
          yield { rows, chunkIndex, rowOffset };
          chunkIndex++;
          rowOffset += chunkSize;
        } finally {
          new DataView(chunkBuf.buffer).setBigUint64(0, BigInt(chunk), true);
          lib.duckdb_destroy_data_chunk(ptr(chunkBuf));
        }
      }
    } finally {
      try { if (rp) lib.duckdb_destroy_result(rp); } catch {}
      this.#activeIterator = null;
      if (ref && ref.wrapper) conn._clearActiveIterator?.(ref.wrapper);
      if (release) { try { release(); } catch {} }
    }
  }

  // The real iteration. Holds the connection lock from before bind until
  // the generator's finally runs (chunk destroy → result destroy → release).
  // Any helper called from here is the _xUnlocked variant (already inside
  // the lock); calling a withLock-wrapped method would deadlock.
  async *#iterateImpl(handle, conn, params, ref) {
    let release = null;
    let resultPtr = null;
    let rp = 0;

    try {
      release = await conn.acquireLock();

      // Post-acquire recheck (per §3 close protocol).
      if (this.#state !== 'open' || !conn._isOpen()) return;

      // Bind + execute (sync FFI under the lock).
      if (params && params.length > 0) {
        lib.duckdb_clear_bindings(handle);
        conn._bindParams(handle, params);
      }
      resultPtr = new Uint8Array(64);
      const status = lib.duckdb_execute_prepared(handle, ptr(resultPtr));
      rp = ptr(resultPtr);
      const errPtr = lib.duckdb_result_error(rp);
      if (status !== 0 || errPtr) {
        const msg = errPtr ? fromCString(errPtr) : 'Prepared execution failed';
        throw new DuckDBError(msg);
      }

      const columns = conn._decodeColumnsMetadata(resultPtr);
      const chunkBuf = allocPtr();

      while (true) {
        // Cooperative cancellation point: close() may have set state
        // (but in that case it's already calling our .return()).
        if (this.#state !== 'open' || !conn._isOpen()) break;

        const chunk = fetchChunk(rp);
        if (!chunk) break;
        try {
          const chunkSize = Number(lib.duckdb_data_chunk_get_size(chunk));
          if (chunkSize === 0) break;
          const rows = conn._decodeChunkRows(chunk, columns);
          for (const row of rows) yield row;
        } finally {
          new DataView(chunkBuf.buffer).setBigUint64(0, BigInt(chunk), true);
          lib.duckdb_destroy_data_chunk(ptr(chunkBuf));
        }
      }
    } finally {
      // Destroy result BEFORE releasing the lock (still need DuckDB state).
      // Wrap each cleanup step so one failure can't skip the others —
      // releasing the lock is non-negotiable, otherwise the connection
      // is bricked for the rest of its life.
      try {
        if (rp) lib.duckdb_destroy_result(rp);
      } catch { /* swallow */ }
      this.#activeIterator = null;
      if (ref && ref.wrapper) conn._clearActiveIterator?.(ref.wrapper);
      if (release) {
        try { release(); } catch { /* swallow */ }
      }
    }
  }

  async close() {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state !== 'open') return;
    this.#state = 'closing';

    const stmtPtr = this.#stmtPtr;
    this.#stmtPtr = null;
    this.#handle = null;
    const conn = this.#conn;
    this.#conn = null;

    const activeIt = this.#activeIterator;
    this.#activeIterator = null;

    this.#closePromise = (async () => {
      // 1. Cancel active iterator (releases lock, destroys result).
      if (activeIt) {
        try { await activeIt.return(); } catch { /* swallow */ }
      }
      // 2. Destroy the prepared handle under conn lock if conn still alive.
      //    If conn is already closing/closed, the prepared handle was
      //    freed by duckdb_disconnect — destroying it would be a use-
      //    after-free.
      if (conn && conn._isOpen() && stmtPtr) {
        try {
          await conn.withLock(() => {
            if (!conn._isOpen()) return; // raced with conn close
            lib.duckdb_destroy_prepare(ptr(stmtPtr));
          });
          conn._untrackStatement?.(this);
        } catch { /* swallow */ }
      }
      this.#state = 'closed';
    })();
    return this.#closePromise;
  }

  [Symbol.dispose]() { this.close().catch(() => { /* fire-and-forget */ }); }
  [Symbol.asyncDispose]() { return this.close(); }
}

// ==============================================================================
// Database extensions (v0.2 shortcuts + transaction + lazy implicit Connection)
//
// Added to Database.prototype below the class definition because the
// implementation references Connection (defined after Database in this file).
// They delegate to a lazy default Connection created on first use, closed when
// db.close() is called.
//
// Default connection is stored on a Symbol-keyed slot so user code can't
// accidentally collide with or mutate it. Always check `this.handle` before
// returning the cached connection so a closed Database can't silently serve
// queries through a still-cached (but invalid) implicit connection.
// ==============================================================================

const DEFAULT_CONN = Symbol('duckdb-bun.defaultConn');

function _defaultConn() {
  if (!this.handle) throw new DuckDBClosedError('Database');
  if (!this[DEFAULT_CONN]) {
    this[DEFAULT_CONN] = this.connect();
  }
  return this[DEFAULT_CONN];
}

// All shortcut methods route through _defaultConn() so the closed-state check
// fires before any FFI call. Methods are `async function` so a sync throw
// from _defaultConn (closed Database) becomes a rejected Promise — matching
// what users expect from `await db.all(...)`.
Object.defineProperties(Database.prototype, {
  _defaultConn: { value: _defaultConn, enumerable: false, configurable: true, writable: true },
  query:       { value: async function (sql, params) { return _defaultConn.call(this).query(sql, params); }, enumerable: false, configurable: true, writable: true },
  all:         { value: async function (sql, params) { return _defaultConn.call(this).all(sql, params); },   enumerable: false, configurable: true, writable: true },
  get:         { value: async function (sql, params) { return _defaultConn.call(this).get(sql, params); },   enumerable: false, configurable: true, writable: true },
  run:         { value: async function (sql, params) { return _defaultConn.call(this).run(sql, params); },   enumerable: false, configurable: true, writable: true },
  exec:        { value: async function (sql)         { return _defaultConn.call(this).exec(sql); },          enumerable: false, configurable: true, writable: true },
  prepare:     { value: async function (sql)         { return _defaultConn.call(this).prepare(sql); },       enumerable: false, configurable: true, writable: true },
  transaction: { value: async function (fn)          { return _defaultConn.call(this).transaction(fn); },    enumerable: false, configurable: true, writable: true },
  // iterate is sync (returns an AsyncIterable). The closed-state check
  // and #defaultConn allocation happen synchronously here; the actual
  // prepare + execute is lazy inside the generator (see Connection#iterate).
  iterate: {
    value: function (sql, params) {
      const conn = _defaultConn.call(this);
      return conn.iterate(sql, params);
    },
    enumerable: false, configurable: true, writable: true,
  },
  chunks: {
    value: function (sql, params) {
      const conn = _defaultConn.call(this);
      return conn.chunks(sql, params);
    },
    enumerable: false, configurable: true, writable: true,
  },
  pragma: {
    value: async function (name, value) {
      const conn = _defaultConn.call(this);
      if (arguments.length < 2) return conn.pragma(name);
      return conn.pragma(name, value);
    },
    enumerable: false, configurable: true, writable: true,
  },
  installExtension: {
    value: async function (name) {
      const conn = _defaultConn.call(this);
      return conn.installExtension(name);
    },
    enumerable: false, configurable: true, writable: true,
  },
  loadExtension: {
    value: async function (name) {
      const conn = _defaultConn.call(this);
      return conn.loadExtension(name);
    },
    enumerable: false, configurable: true, writable: true,
  },
  checkpoint: {
    value: async function (opts) {
      const conn = _defaultConn.call(this);
      return conn.checkpoint(opts);
    },
    enumerable: false, configurable: true, writable: true,
  },
});

// NOTE: As of v0.3.0, Database.close() and Symbol.dispose / asyncDispose
// are declared directly on the class body (above). The class's close()
// already handles the lazy implicit Connection in its async tail, so the
// v0.2-era prototype.close wrapper is no longer needed.

// ==============================================================================
// Public API
// ==============================================================================

/**
 * Open (or create) a DuckDB database at `path`.
 *
 * @param {string} path - file path, or ':memory:' for in-memory
 * @param {object} [opts] - optional configuration (v0.5+):
 *   - readOnly?: boolean — sugar for access_mode: 'READ_ONLY'
 *   - accessMode?: 'AUTOMATIC' | 'READ_ONLY' | 'READ_WRITE'
 *   - threads?: number — positive integer
 *   - memoryLimit?: string — e.g. '1GB', '512MB', '80%'
 *   - tempDirectory?: string
 *   - config?: Record<string, string|number|boolean|bigint> — escape
 *     hatch for any DuckDB config key not exposed as a typed field
 */
export function open(path, opts) {
  return new Database(path, opts);
}

export function version() {
  const versionPtr = lib.duckdb_library_version();
  return fromCString(versionPtr);
}

export { Database, Connection, Statement };
