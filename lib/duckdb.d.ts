// TypeScript declarations for bun-duckdb v0.2
//
// Hand-written. Mirrors lib/duckdb.mjs's runtime API. Generic parameters
// let users tighten row shapes when they know them; defaults are loose
// (Record<string, unknown>) for ad-hoc queries.

// ============================================================================
// Type system
// ============================================================================

/** A single row from a query — keys are column names. */
export type Row = Record<string, unknown>;

/** Bind parameters for a prepared statement (positional). */
export type Params = readonly unknown[];

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
  readonly name: 'DuckDBError' | 'DuckDBClosedError' | 'DuckDBPrepareError' | 'DuckDBTransactionError';
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
   * Run fn() inside a transaction. BEGIN before, COMMIT after success,
   * ROLLBACK + rethrow on any throw. fn receives the underlying Connection.
   *
   * Nested transactions throw DuckDBTransactionError in v0.2 (planned for
   * v0.3 via SAVEPOINT).
   */
  transaction<R>(fn: (tx: Connection) => Promise<R>): Promise<R>;

  /** Close the database. Idempotent. Also closes the lazy implicit Connection. */
  close(): void;

  /** Symbol.dispose for `using db = open(...)` syntax. */
  [Symbol.dispose](): void;
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

  /** Run fn() inside a transaction. See Database.transaction for semantics. */
  transaction<R>(fn: (tx: Connection) => Promise<R>): Promise<R>;

  /** Close the connection. Idempotent. */
  close(): void;

  /** Symbol.dispose for `using conn = db.connect()` syntax. */
  [Symbol.dispose](): void;
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

  /** Free the prepared statement handle. Idempotent. */
  close(): void;

  /** Symbol.dispose for `using stmt = await db.prepare(...)` syntax. */
  [Symbol.dispose](): void;
}

// ============================================================================
// Top-level functions
// ============================================================================

/**
 * Open (or create) a DuckDB database at `path`. Use `':memory:'` for an
 * in-memory database.
 */
export function open(path: string): Database;

/** Returns the version string of the loaded libduckdb (e.g. "v1.5.2"). */
export function version(): string;
