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
import { platform } from 'process';
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
  duckdb_close:   { args: ['ptr'], returns: 'void' },

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
function findShimLibrary() {
  const realLibPath = realpathSync(libPath);
  const dir = realLibPath.replace(/\/[^/]+$/, '');
  const symDir = libPath.replace(/\/[^/]+$/, '');
  const ext = platform === 'darwin' ? 'dylib' : 'so';
  const candidates = [
    `${dir}/libduckdb-shim.${ext}`,
    `${symDir}/libduckdb-shim.${ext}`,
    new URL('./libduckdb-shim.' + ext, import.meta.url).pathname,
  ];
  if (process.env.DUCKDB_SHIM_PATH) candidates.unshift(process.env.DUCKDB_SHIM_PATH);
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

// Async mutex to serialize FFI calls
let ffiLock = Promise.resolve();
function withLock(fn) {
  const prev = ffiLock;
  let resolve;
  ffiLock = new Promise(r => resolve = r);
  return prev.then(() => {
    try { return fn(); }
    finally { resolve(); }
  });
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

// Read a duckdb_string_t (16 bytes) from a data pointer at a given row offset
function readString(dataPtr, row) {
  if (!dataPtr) return null;
  const offset = row * 16;  // duckdb_string_t is 16 bytes
  const length = ffiRead.u32(dataPtr, offset);

  if (length <= 12) {
    // Inlined: bytes 4-15 contain the string data
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      bytes[i] = ffiRead.u8(dataPtr, offset + 4 + i);
    }
    return decoder.decode(bytes);
  } else {
    // Pointer: bytes 4-7 are prefix, bytes 8-15 are pointer to string data
    const strPtr = ffiRead.ptr(dataPtr, offset + 8);
    if (!strPtr) return null;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      bytes[i] = ffiRead.u8(strPtr, i);
    }
    return decoder.decode(bytes);
  }
}

// Check if a row is valid (not NULL) in a validity mask
function isValid(validityPtr, row) {
  if (!validityPtr) return true;  // NULL validity = all valid
  const entryIdx = Math.floor(row / 64);
  const bitIdx = row % 64;
  const entry = ffiRead.u64(validityPtr, entryIdx * 8);
  return (entry & (1n << BigInt(bitIdx))) !== 0n;
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

  constructor(path) {
    this.#ptrBuf = allocPtr();
    const pathBytes = path && path !== ':memory:' ? toCString(path) : null;
    const result = lib.duckdb_open(pathBytes ? ptr(pathBytes) : null, ptr(this.#ptrBuf));
    if (result !== 0) throw new Error('Failed to open database');
    this.#handle = readHandle(this.#ptrBuf);
  }

  get handle() { return this.#handle; }
  get ptrBuf() { return this.#ptrBuf; }

  connect() { return new Connection(this); }

  close() {
    if (this.#ptrBuf) {
      lib.duckdb_close(ptr(this.#ptrBuf));
      this.#ptrBuf = null;
      this.#handle = null;
    }
  }
}

// ==============================================================================
// Connection Class
// ==============================================================================

class Connection {
  #ptrBuf = null;
  #handle = null;
  #db = null;

  constructor(db) {
    this.#db = db;
    this.#ptrBuf = allocPtr();
    const result = lib.duckdb_connect(db.handle, ptr(this.#ptrBuf));
    if (result !== 0) throw new Error('Failed to create connection');
    this.#handle = readHandle(this.#ptrBuf);
    this.#statements = new Set();
  }

  get handle() { return this.#handle; }
  get ptrBuf() { return this.#ptrBuf; }

  // Track outstanding Statements so close() can free their prepared handles
  // before disconnect. A leaked Statement after Connection.close() would
  // either crash on next use or quietly leak the prepared handle in DuckDB.
  #statements = null;
  _trackStatement(stmt) { this.#statements?.add(stmt); }
  _untrackStatement(stmt) { this.#statements?.delete(stmt); }

  /**
   * Execute a SQL query and return results as array of objects
   * @param {string} sql - SQL query
   * @param {any[]} params - Optional parameters for prepared statement
   * @returns {Promise<object[]>} Array of row objects
   */
  query(sql, params = []) {
    return withLock(() => {
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
      this.#bindParams(stmtHandle, params);
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
  // Contract:
  //   BIGINT/UBIGINT → number (lossy above 2^53, JSON-safe)
  //   DECIMAL/HUGEINT/UHUGEINT → string (preserves precision)
  //   All timestamps → Date (UTC)
  //   UUID → string (formatted)
  //   VARCHAR/BLOB → string
  //   ENUM → string (dictionary lookup)
  //   TIME/TIME_NS/TIME_TZ → string (formatted)
  //   LIST/ARRAY → array, STRUCT → object, MAP → object
  // ---------------------------------------------------------------------------

  #extractChunks(resultPtr) {
    const rp = ptr(resultPtr);
    const colCount = Number(lib.duckdb_column_count(rp));

    // Get column info + logical type metadata for complex types
    const columns = [];
    for (let c = 0; c < colCount; c++) {
      const namePtr = lib.duckdb_column_name(rp, BigInt(c));
      const type = lib.duckdb_column_type(rp, BigInt(c));
      const col = {
        name: fromCString(namePtr) || `col${c}`,
        type,
        typeName: this.#typeName(type)
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

    // Fetch chunks and extract rows
    const rows = [];
    const chunkBuf = allocPtr();

    while (true) {
      const chunk = fetchChunk(rp);
      if (!chunk) break;

      const chunkSize = Number(lib.duckdb_data_chunk_get_size(chunk));
      if (chunkSize === 0) {
        new DataView(chunkBuf.buffer).setBigUint64(0, BigInt(chunk), true);
        lib.duckdb_destroy_data_chunk(ptr(chunkBuf));
        break;
      }

      // Get vectors for each column (data + validity + handle for nested types)
      const colVec = [];
      const colData = [];
      const colValidity = [];
      for (let c = 0; c < colCount; c++) {
        const vec = lib.duckdb_data_chunk_get_vector(chunk, BigInt(c));
        colVec.push(vec);
        const dp = vec ? lib.duckdb_vector_get_data(vec) : 0n;
        colData.push(Number(dp));
        const vp = vec ? lib.duckdb_vector_get_validity(vec) : 0n;
        colValidity.push(Number(vp));
      }

      // Extract rows from this chunk
      for (let r = 0; r < chunkSize; r++) {
        const row = {};
        for (let c = 0; c < colCount; c++) {
          const col = columns[c];
          if (!isValid(colValidity[c], r)) {
            row[col.name] = null;
          } else {
            row[col.name] = this.#readValue(colData[c], r, col.type, col, colVec[c]);
          }
        }
        rows.push(row);
      }

      // Destroy chunk
      new DataView(chunkBuf.buffer).setBigUint64(0, BigInt(chunk), true);
      lib.duckdb_destroy_data_chunk(ptr(chunkBuf));
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
  #readValue(dataPtr, row, type, col, vec) {
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
      case DUCKDB_TYPE.BLOB:
        return readString(dataPtr, row);

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
            result.push(this.#readValue(childData, childRow, childType, null, childVec));
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
            obj[child.name] = this.#readValue(childData, row, child.type, null, childVec);
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
            ? this.#readValue(keyData, childRow, keyType, null, keyVec) : null;
          const v = isValid(valValidity, childRow)
            ? this.#readValue(valData, childRow, valType, null, valVec) : null;
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
            result.push(this.#readValue(childData, childRow, childType, null, childVec));
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

  #typeName(type) {
    for (const [name, value] of Object.entries(DUCKDB_TYPE)) {
      if (value === type) return name;
    }
    return 'UNKNOWN';
  }

  #bindParams(stmtHandle, params) {
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
    return withLock(() => {
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
   * Execute a prepared statement multiple times with different param sets
   * @param {string} sql - SQL with $1, $2, ... placeholders
   * @param {any[][]} paramSets - Array of param arrays
   * @returns {Promise<{rows: number}>}
   */
  queryBatch(sql, paramSets) {
    return withLock(() => {
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
          this.#bindParams(stmtHandle, params);

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
   * Prepare an SQL statement for repeated execution. The returned Statement
   * holds the prepared handle until close() is called; reuse it via .all/get/run.
   * Falls under withLock to serialize with other in-flight queries on this conn.
   *
   * @returns {Promise<Statement>}
   */
  prepare(sql) {
    if (!this.#handle) throw new DuckDBClosedError('Connection');
    return withLock(() => {
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

  /**
   * Run fn() inside a transaction. BEGIN before, COMMIT after success,
   * ROLLBACK + rethrow on any throw. fn receives this Connection.
   *
   * Nested transactions are not yet supported — calling transaction()
   * inside another transaction throws DuckDBTransactionError.
   *
   * @template R
   * @param {(tx: Connection) => Promise<R>} fn
   * @returns {Promise<R>}
   */
  async transaction(fn) {
    if (this.#inTransaction) {
      throw new DuckDBTransactionError('Nested transactions not supported in v0.2 (planned for v0.3 via SAVEPOINT)');
    }
    this.#inTransaction = true;
    try {
      await this.query('BEGIN');
      try {
        const result = await fn(this);
        await this.query('COMMIT');
        return result;
      } catch (err) {
        try { await this.query('ROLLBACK'); } catch { /* swallow */ }
        throw err;
      }
    } finally {
      this.#inTransaction = false;
    }
  }

  #inTransaction = false;

  close() {
    if (this.#ptrBuf) {
      // Free any outstanding prepared statements before tearing down the
      // connection. They become unusable after disconnect anyway, and we'd
      // leak DuckDB-side memory otherwise.
      if (this.#statements) {
        for (const stmt of this.#statements) {
          try { stmt.close(); } catch { /* swallow */ }
        }
        this.#statements.clear();
      }
      lib.duckdb_disconnect(ptr(this.#ptrBuf));
      this.#ptrBuf = null;
      this.#handle = null;
    }
  }

  [Symbol.dispose]() { this.close(); }
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

  constructor(conn, handle, stmtPtr) {
    this.#conn = conn;
    this.#handle = handle;
    this.#stmtPtr = stmtPtr;
    // Register with the owning Connection so its close() can also close us.
    conn._trackStatement?.(this);
  }

  get closed() { return this.#handle === null; }

  /** Execute and return all rows as QueryResult. */
  all(params = []) {
    if (this.#handle === null) throw new DuckDBClosedError('Statement');
    // The owning Connection might be closed even though this Statement
    // hasn't had its own close() called yet. The prepared handle is
    // bound to that connection — using it after disconnect is undefined
    // behavior in DuckDB. Reject loudly instead.
    if (!this.#conn || this.#conn.handle === null) {
      throw new DuckDBClosedError('Connection (statement\'s owning connection)');
    }
    const handle = this.#handle;
    const conn = this.#conn;
    return withLock(() => conn._executePreparedSync(handle, params));
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

  close() {
    if (this.#stmtPtr) {
      // Only call duckdb_destroy_prepare if the connection is still alive.
      // If the connection is already closed, the prepared handle has been
      // freed by libduckdb's disconnect — calling destroy on it would
      // double-free.
      if (this.#conn && this.#conn.handle !== null) {
        lib.duckdb_destroy_prepare(ptr(this.#stmtPtr));
        this.#conn._untrackStatement?.(this);
      }
      this.#stmtPtr = null;
      this.#handle = null;
      this.#conn = null;
    }
  }

  [Symbol.dispose]() { this.close(); }
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

const DEFAULT_CONN = Symbol('bun-duckdb.defaultConn');

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
});

// Wrap close() to also close the implicit connection. Preserve the original
// for the underlying duckdb_close call. Idempotent — calling close() twice
// is a no-op (both layers already check their own state).
const _originalDatabaseClose = Database.prototype.close;
Object.defineProperty(Database.prototype, 'close', {
  value: function close() {
    if (this[DEFAULT_CONN]) {
      try { this[DEFAULT_CONN].close(); } catch { /* swallow */ }
      this[DEFAULT_CONN] = null;
    }
    _originalDatabaseClose.call(this);
  },
  enumerable: false,
  configurable: true,
  writable: true,
});

Object.defineProperty(Database.prototype, Symbol.dispose, {
  value: function () { this.close(); },
  enumerable: false,
  configurable: true,
  writable: true,
});

// ==============================================================================
// Public API
// ==============================================================================

export function open(path) {
  return new Database(path);
}

export function version() {
  const versionPtr = lib.duckdb_library_version();
  return fromCString(versionPtr);
}

export { Database, Connection, Statement };
