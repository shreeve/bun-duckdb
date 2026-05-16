// TypeScript declarations for duckdb-bun.
//
// Hand-written. Mirrors lib/duckdb.mjs's runtime API exactly. Generic
// parameters let users tighten row shapes when they know them; defaults
// are loose (`Record<string, unknown>`) for ad-hoc queries.
//
// Per-feature "introduced in" markers in JSDoc comments (e.g. *(v0.5+)*)
// trace each method back to its release. See CHANGELOG.md for full
// release notes.

// ============================================================================
// Type system
// ============================================================================

/** A single row from a query — keys are column names. */
export type Row = Record<string, unknown>;

/** Bind parameters for a prepared statement (positional). */
export type Params = readonly unknown[];

/** DuckDB access mode (v0.5+). Maps to the `access_mode` config key. */
export type DuckDBAccessMode = 'AUTOMATIC' | 'READ_ONLY' | 'READ_WRITE';

/**
 * Options accepted by `open(path, opts?)` (v0.5+). Common settings are
 * exposed as typed fields; arbitrary DuckDB config keys can be set via
 * the `config` escape hatch. Typed options + `config` setting the same
 * DuckDB key with different values throws; matching values are allowed.
 */
export interface OpenOptions {
  /** Sugar for `accessMode: 'READ_ONLY'`. */
  readOnly?: boolean;
  /** DuckDB `access_mode` (maps directly). */
  accessMode?: DuckDBAccessMode;
  /** DuckDB `threads` (positive integer). */
  threads?: number;
  /** DuckDB `memory_limit` (e.g. `'1GB'`, `'512MB'`, `'80%'`). */
  memoryLimit?: string;
  /** DuckDB `temp_directory`. */
  tempDirectory?: string;
  /** Escape hatch: any DuckDB config key + value not exposed above. */
  config?: Record<string, string | number | boolean | bigint>;
}

/** Options for `checkpoint()` (v0.5.1+). */
export interface CheckpointOptions {
  /**
   * Emit `FORCE CHECKPOINT` — checkpoints even with active transactions
   * present (they are ABORTed). Default: false.
   */
  force?: boolean;
  /**
   * Target a specific attached database by name (when you've used
   * `ATTACH '...' AS aux`). Strictly validated as an identifier.
   */
  database?: string;
}

/** Yielded by `chunks()` iterators (v0.5+). */
export interface RowChunk<T extends Row = Row> {
  /** Decoded rows for this chunk. Also exposes `.columns` (same as QueryResult). */
  rows: T[] & { columns?: ColumnInfo[] };
  /** 0-based index of this chunk in the stream. */
  chunkIndex: number;
  /** Number of rows yielded before this chunk's first row. */
  rowOffset: number;
}

/**
 * A scoped transaction handle (v0.5+) passed to the `db.transaction(fn)`
 * callback. Same shortcut methods as Connection, but using the handle
 * after the callback returns/throws raises DuckDBTransactionError.
 *
 * Nested transactions are not currently supported (DuckDB v1.5.2
 * doesn't parse SAVEPOINT); `tx.transaction()` always rejects with
 * DuckDBTransactionError. The method is reserved for forward-compat
 * when upstream lands SAVEPOINT.
 */
export interface TxnHandle {
  query<T extends Row = Row>(sql: string, params?: Params): Promise<QueryResult<T>>;
  all<T extends Row = Row>(sql: string, params?: Params): Promise<QueryResult<T>>;
  get<T extends Row = Row>(sql: string, params?: Params): Promise<T | undefined>;
  run(sql: string, params?: Params): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  prepare<T extends Row = Row>(sql: string): Promise<Statement<T>>;
  iterate<T extends Row = Row>(sql: string, params?: Params): AsyncIterableIterator<T>;
  chunks<T extends Row = Row>(sql: string, params?: Params): AsyncIterableIterator<RowChunk<T>>;
  pragma(name: string, value?: string | number | boolean | bigint | null): Promise<Row | undefined>;
  installExtension(name: string): Promise<void>;
  loadExtension(name: string): Promise<void>;
  checkpoint(opts?: CheckpointOptions): Promise<void>;
  append(table: string, columns: string[], rows: unknown[][]): Promise<AppendResult>;
  executeBatchPrepared(sql: string, batches: unknown[][]): Promise<AppendResult>;
  /** Always rejects with DuckDBTransactionError until upstream SAVEPOINT support lands. */
  transaction<R>(fn: (tx: TxnHandle) => Promise<R>): Promise<R>;
}

/** Column metadata attached to QueryResult. */
export interface ColumnInfo {
  name: string;
  /** DuckDB internal type code (matches a DUCKDB_TYPE value). */
  type: number;
  /** DuckDB type name as a string (e.g. "INTEGER", "VARCHAR"). */
  typeName: string;
  /** Logical type metadata for complex types (DECIMAL, ENUM, LIST, STRUCT, MAP, ARRAY). */
  logicalType?: unknown;
}

/**
 * What `query()` / `all()` resolve to: an Array of rows with two extra
 * properties attached. Treat the value as the rows themselves; spread,
 * iterate, index — `.columns` and `.rowsChanged` are sidecar metadata.
 */
export type QueryResult<T extends Row = Row> = T[] & {
  /** Column metadata (one entry per result column, in column order). */
  columns: ColumnInfo[];
  /**
   * Number of rows changed by a DML statement (INSERT/UPDATE/DELETE).
   * Always 0n for SELECT or DDL. BigInt because DuckDB returns uint64.
   */
  rowsChanged: bigint;
};

/** Result of a non-row-returning execution. */
export interface RunResult {
  rowsChanged: bigint;
}

/** Result of an Appender bulk insert. */
export interface AppendResult {
  rows: number;
}

/** DuckDB type codes. Frozen object; values are stable per DuckDB release. */
export const DUCKDB_TYPE: Readonly<{
  INVALID: 0;
  BOOLEAN: 1;
  TINYINT: 2;
  SMALLINT: 3;
  INTEGER: 4;
  BIGINT: 5;
  UTINYINT: 6;
  USMALLINT: 7;
  UINTEGER: 8;
  UBIGINT: 9;
  FLOAT: 10;
  DOUBLE: 11;
  TIMESTAMP: 12;
  DATE: 13;
  TIME: 14;
  INTERVAL: 15;
  HUGEINT: 16;
  VARCHAR: 17;
  BLOB: 18;
  DECIMAL: 19;
  TIMESTAMP_S: 20;
  TIMESTAMP_MS: 21;
  TIMESTAMP_NS: 22;
  ENUM: 23;
  LIST: 24;
  STRUCT: 25;
  MAP: 26;
  UUID: 27;
  UNION: 28;
  BIT: 29;
  TIME_TZ: 30;
  TIMESTAMP_TZ: 31;
  UHUGEINT: 32;
  ARRAY: 33;
  TIME_NS: 39;
}>;

export type DuckDBTypeCode = (typeof DUCKDB_TYPE)[keyof typeof DUCKDB_TYPE];

// ============================================================================
// Error classes
// ============================================================================

export class DuckDBError extends Error {
  readonly name:
    | 'DuckDBError' | 'DuckDBClosedError' | 'DuckDBPrepareError'
    | 'DuckDBTransactionError' | 'AbortError';
}

export class DuckDBClosedError extends DuckDBError {
  readonly name: 'DuckDBClosedError';
}

export class DuckDBPrepareError extends DuckDBError {
  readonly name: 'DuckDBPrepareError';
}

export class DuckDBTransactionError extends DuckDBError {
  readonly name: 'DuckDBTransactionError';
}

/**
 * Raised when an async query is interrupted via AbortSignal (v0.7+).
 *
 * `.name` is `'AbortError'` (Web standard convention used by fetch /
 * ReadableStream / similar) so code that keys on `err.name` to detect
 * cancellation works without knowing about DuckDB specifics. The
 * class itself is still a DuckDBError so `instanceof DuckDBError`
 * is true.
 *
 * Only thrown by the `duckdb-bun/async` subpath — the sync subpath
 * blocks the JS event loop in FFI, so it can't deliver AbortSignal
 * events while a query runs.
 */
export class DuckDBAbortError extends DuckDBError {
  readonly name: 'AbortError';
  readonly code: 'ERR_DUCKDB_ABORTED';
}

// ============================================================================
// Database
// ============================================================================

export class Database {
  /** Internal: BigInt handle to the underlying duckdb_database. */
  readonly handle: bigint | null;

  /** Open a connection. Each connection is independent and can be used in parallel. */
  connect(): Connection;

  // --- v0.2 shortcuts (delegate to a lazy implicit Connection) ---

  /** Execute a query. Returns full QueryResult (rows + columns + rowsChanged). */
  query<T extends Row = Row>(sql: string, params?: Params): Promise<QueryResult<T>>;

  /** Alias of query(). */
  all<T extends Row = Row>(sql: string, params?: Params): Promise<QueryResult<T>>;

  /** Execute and return the first row, or undefined if no rows. */
  get<T extends Row = Row>(sql: string, params?: Params): Promise<T | undefined>;

  /** Execute for side effects. Returns rowsChanged for INSERT/UPDATE/DELETE. */
  run(sql: string, params?: Params): Promise<RunResult>;

  /** Fire-and-forget multi-statement execution. No params, no rows returned. */
  exec(sql: string): Promise<void>;

  /** Prepare a statement for repeated execution. Caller must close() the Statement. */
  prepare<T extends Row = Row>(sql: string): Promise<Statement<T>>;

  /**
   * Stream rows from an SQL query. Sugar around prepare(sql).iterate(params)
   * that owns the temporary Statement's lifecycle. Prepares LAZILY on first
   * `.next()`, so abandoning the iterator allocates no FFI resources.
   * (v0.3+)
   */
  iterate<T extends Row = Row>(sql: string, params?: Params): AsyncIterableIterator<T>;

  /**
   * Run fn() inside a transaction. BEGIN before, COMMIT after success,
   * ROLLBACK + rethrow on any throw. fn receives a `TxnHandle` (v0.5+)
   * — a scoped proxy with the same shortcut methods as Connection, but
   * marked closed after the callback so out-of-scope use throws.
   *
   * Nested transactions throw `DuckDBTransactionError`: DuckDB v1.5.2
   * doesn't parse SAVEPOINT. Reserved for forward-compat when upstream
   * lands savepoint support.
   */
  transaction<R>(fn: (tx: TxnHandle) => Promise<R>): Promise<R>;

  /** Run `PRAGMA name` (get) or `PRAGMA name=value` (set). Returns the first row, or undefined. (v0.5+) */
  pragma(name: string, value?: string | number | boolean | bigint | null): Promise<Row | undefined>;

  /** `INSTALL <name>` with strict identifier validation. (v0.5+) */
  installExtension(name: string): Promise<void>;

  /** `LOAD <name>` with strict identifier validation. (v0.5+) */
  loadExtension(name: string): Promise<void>;

  /** Flush the WAL via `CHECKPOINT` (or `FORCE CHECKPOINT`). (v0.5.1+) */
  checkpoint(opts?: CheckpointOptions): Promise<void>;

  /** Stream rows chunk-by-chunk (DuckDB vector ≈ 2048 rows per chunk). (v0.5+) */
  chunks<T extends Row = Row>(sql: string, params?: Params): AsyncIterableIterator<RowChunk<T>>;

  /**
   * Close the database. Idempotent.
   *
   * v0.3 made this async to coordinate with active iterators on child
   * Connections. Callers using `db.close()` without await will still work
   * (the public handle nulls out synchronously, matching v0.2 semantics),
   * but the FFI destroy happens in the returned Promise. For streaming
   * users, prefer `await using db = open(...)`.
   */
  close(): Promise<void>;

  /**
   * Symbol.dispose for `using db = open(...)` syntax. Fires close() with
   * .catch() so the dispose can't throw an unhandled rejection. Best-effort
   * fallback; for streaming code prefer `await using` (Symbol.asyncDispose).
   */
  [Symbol.dispose](): void;

  /** Symbol.asyncDispose for `await using db = open(...)`. Awaits close(). */
  [Symbol.asyncDispose](): Promise<void>;
}

// ============================================================================
// Connection
// ============================================================================

export class Connection {
  /** Internal: BigInt handle to the underlying duckdb_connection. */
  readonly handle: bigint | null;

  // --- Core API (since v0.1) ---

  /** Execute a query. If params is provided (and non-empty), runs as a prepared statement. */
  query<T extends Row = Row>(sql: string, params?: Params): Promise<QueryResult<T>>;

  /** Bulk insert via DuckDB's Appender API. Fastest path for many rows. */
  append(table: string, columns: string[], rows: unknown[][]): Promise<AppendResult>;

  /** Advanced: execute a prepared statement multiple times with batched parameter sets. */
  executeBatchPrepared(sql: string, batches: unknown[][]): Promise<AppendResult>;

  /**
   * Parse SQL and return the number of statements (does not execute).
   * Throws on parse failure. Useful for refusing multi-statement input.
   */
  countStatements(sql: string): number;

  // --- v0.2 shortcuts ---

  /** Alias of query(). */
  all<T extends Row = Row>(sql: string, params?: Params): Promise<QueryResult<T>>;

  /** Execute and return the first row, or undefined. */
  get<T extends Row = Row>(sql: string, params?: Params): Promise<T | undefined>;

  /** Execute for side effects. Returns rowsChanged. */
  run(sql: string, params?: Params): Promise<RunResult>;

  /** Fire-and-forget multi-statement execution. */
  exec(sql: string): Promise<void>;

  /** Prepare a statement for repeated execution. Caller must close() the Statement. */
  prepare<T extends Row = Row>(sql: string): Promise<Statement<T>>;

  /**
   * Stream rows from an SQL query. Sugar that owns its temporary Statement;
   * prepares LAZILY on first `.next()`. (v0.3+)
   */
  iterate<T extends Row = Row>(sql: string, params?: Params): AsyncIterableIterator<T>;

  /** Run fn() inside a transaction. See Database.transaction for semantics. (v0.5: tx is a TxnHandle, not a Connection.) */
  transaction<R>(fn: (tx: TxnHandle) => Promise<R>): Promise<R>;

  /** Run `PRAGMA name` (get) or `PRAGMA name=value` (set). (v0.5+) */
  pragma(name: string, value?: string | number | boolean | bigint | null): Promise<Row | undefined>;

  /** `INSTALL <name>` with strict identifier validation. (v0.5+) */
  installExtension(name: string): Promise<void>;

  /** `LOAD <name>` with strict identifier validation. (v0.5+) */
  loadExtension(name: string): Promise<void>;

  /** Flush the WAL via `CHECKPOINT` (or `FORCE CHECKPOINT`). (v0.5.1+) */
  checkpoint(opts?: CheckpointOptions): Promise<void>;

  /** Stream rows chunk-by-chunk. (v0.5+) */
  chunks<T extends Row = Row>(sql: string, params?: Params): AsyncIterableIterator<RowChunk<T>>;

  /**
   * Close the connection. Async as of v0.3 — cancels any active iterator
   * (via wrapper.return()), waits for child Statements to close, then
   * disconnects. The public handle nulls out synchronously, so the
   * `conn.close(); conn.handle === null` contract still holds without
   * awaiting.
   */
  close(): Promise<void>;

  /** Symbol.dispose for `using conn = db.connect()` syntax. Fire-and-forget close(). */
  [Symbol.dispose](): void;

  /** Symbol.asyncDispose for `await using conn = db.connect()`. Awaits close(). */
  [Symbol.asyncDispose](): Promise<void>;
}

// ============================================================================
// Statement (v0.2)
// ============================================================================

/**
 * A prepared SQL statement. Created via `db.prepare(sql)` or `conn.prepare(sql)`.
 * Holds the prepared handle until close() is called; reuse via .all/.get/.run.
 *
 * Parameters are positional arrays — pass `[1, 'foo']` not `(1, 'foo')`.
 *
 * Lifecycle: explicit close() required. Use `using stmt = await db.prepare(...)`
 * for automatic cleanup.
 */
export class Statement<T extends Row = Row> {
  /** True after close(). Subsequent calls throw DuckDBClosedError. */
  readonly closed: boolean;

  /** Execute and return all rows. */
  all(params?: Params): Promise<QueryResult<T>>;

  /** Execute and return the first row, or undefined. */
  get(params?: Params): Promise<T | undefined>;

  /** Execute for side effects. Returns rowsChanged. */
  run(params?: Params): Promise<RunResult>;

  /**
   * Stream rows one at a time without materializing the full result set
   * in memory. Holds the owning Connection's lock for the iterator's
   * entire lifetime — concurrent queries on the same Connection queue
   * behind it. Use `db.connect()` for parallel streams.
   *
   * The returned `AsyncIterableIterator` MUST be either consumed via
   * `for await ... of` (which calls `.return()` on `break`/throw), or
   * disposed explicitly via `await it.return()`. A paused-and-abandoned
   * iterator holds the lock until garbage collection (or `close()`).
   *
   * Concurrent `.iterate()` on the same Statement throws DuckDBError;
   * iterate on a closed Statement/Connection throws DuckDBClosedError.
   * (v0.3+)
   */
  iterate(params?: Params): AsyncIterableIterator<T>;

  /**
   * Free the prepared statement handle. Idempotent. Async as of v0.3 —
   * cancels any active iterator before destroy.
   */
  close(): Promise<void>;

  /** Symbol.dispose for `using stmt = ...`. Fire-and-forget close(). */
  [Symbol.dispose](): void;

  /** Symbol.asyncDispose for `await using stmt = ...`. Awaits close(). */
  [Symbol.asyncDispose](): Promise<void>;
}

// ============================================================================
// Top-level functions
// ============================================================================

/**
 * Open (or create) a DuckDB database at `path`. Use `':memory:'` for an
 * in-memory database.
 *
 * v0.5+: optional `opts` for startup config (readOnly, accessMode,
 * threads, memoryLimit, tempDirectory, plus raw `config:` escape hatch).
 */
export function open(path: string, opts?: OpenOptions): Database;

/** Returns the version string of the loaded libduckdb (e.g. "v1.5.2"). */
export function version(): string;
