// TypeScript declarations for duckdb-bun/async (v0.4+).
//
// Mirrors the main-thread surface (lib/duckdb.d.ts) but every method
// that crosses the worker boundary is async. `[Symbol.asyncDispose]`
// is the preferred dispose pattern; `[Symbol.dispose]` is best-effort
// fire-and-forget.

import type {
  Row, Params, QueryResult, RunResult, AppendResult,
  ColumnInfo,
} from '../duckdb.d.ts';

export type {
  Row, Params, QueryResult, RunResult, AppendResult, ColumnInfo,
};

// Re-export the error classes — they have the same identities as the
// main-thread driver's, so `instanceof` cross-checks across subpaths.
export {
  DuckDBError, DuckDBClosedError, DuckDBPrepareError,
  DuckDBTransactionError, DUCKDB_TYPE,
} from '../duckdb.d.ts';

/** Thrown when the worker exits unexpectedly. Extends DuckDBError. */
export class DuckDBWorkerCrashedError extends Error {
  readonly name: 'DuckDBWorkerCrashedError';
}

/** Reserved for v0.4.x. */
export interface OpenOptions {}

/** Options for streaming iteration. */
export interface IterateOptions {
  /**
   * Number of chunks the worker keeps in-flight ahead of the consumer.
   * Default 1; range [0, 4]. 0 = strict pull, max latency, min memory.
   */
  prefetch?: number;
}

/** Options for close() with a bounded shutdown. */
export interface CloseOptions {
  /** Force-terminate the worker after this many ms if in-flight ops haven't settled. */
  timeout?: number;
}

// ============================================================================
// AsyncDatabase
// ============================================================================

export class AsyncDatabase {
  /** Internal: worker-side numeric Database id. Null until lazy open completes. */
  readonly id: number | null;

  query<T extends Row = Row>(sql: string, params?: Params): Promise<QueryResult<T>>;
  all<T extends Row = Row>(sql: string, params?: Params):   Promise<QueryResult<T>>;
  get<T extends Row = Row>(sql: string, params?: Params):   Promise<T | undefined>;
  run(sql: string, params?: Params): Promise<RunResult>;
  exec(sql: string): Promise<void>;

  prepare<T extends Row = Row>(sql: string): Promise<AsyncStatement<T>>;

  iterate<T extends Row = Row>(
    sql: string, params?: Params, opts?: IterateOptions,
  ): AsyncIterableIterator<T>;

  transaction<R>(fn: (tx: AsyncConnection) => Promise<R>): Promise<R>;

  /** Sync — returns a proxy. The actual duckdb_connect happens lazily. */
  connect(): AsyncConnection;

  /** Close the Database. Awaits in-flight ops (or honors timeout), terminates Worker. */
  close(opts?: CloseOptions): Promise<void>;

  /** Symbol.dispose — fire-and-forget close(). Best-effort. */
  [Symbol.dispose](): void;
  /** Symbol.asyncDispose — awaits close(). Preferred for streaming code. */
  [Symbol.asyncDispose](): Promise<void>;
}

// ============================================================================
// AsyncConnection
// ============================================================================

export class AsyncConnection {
  readonly id: number | null;

  query<T extends Row = Row>(sql: string, params?: Params): Promise<QueryResult<T>>;
  all<T extends Row = Row>(sql: string, params?: Params):   Promise<QueryResult<T>>;
  get<T extends Row = Row>(sql: string, params?: Params):   Promise<T | undefined>;
  run(sql: string, params?: Params): Promise<RunResult>;
  exec(sql: string): Promise<void>;

  prepare<T extends Row = Row>(sql: string): Promise<AsyncStatement<T>>;

  iterate<T extends Row = Row>(
    sql: string, params?: Params, opts?: IterateOptions,
  ): AsyncIterableIterator<T>;

  /**
   * Bulk insert via the Appender API. Two forms:
   *   - One-shot: `conn.append(table, columns, rows)` — sends rows,
   *     flushes, returns `{ rows: number }`. Mirrors v0.3 main-thread.
   *   - Streaming: `conn.append(table, columns)` returns an
   *     `AsyncAppender` proxy the caller drives.
   */
  append(table: string, columns: string[], rows: unknown[][]): Promise<AppendResult>;
  append(table: string, columns: string[]): Promise<AsyncAppender>;

  transaction<R>(fn: (tx: AsyncConnection) => Promise<R>): Promise<R>;

  close(): Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

// ============================================================================
// AsyncStatement
// ============================================================================

export class AsyncStatement<T extends Row = Row> {
  readonly id: number;
  readonly closed: boolean;

  all(params?: Params):  Promise<QueryResult<T>>;
  get(params?: Params):  Promise<T | undefined>;
  run(params?: Params):  Promise<RunResult>;

  iterate(params?: Params, opts?: IterateOptions): AsyncIterableIterator<T>;

  close(): Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

// ============================================================================
// AsyncAppender (streaming form)
// ============================================================================

export class AsyncAppender {
  readonly closed: boolean;

  /** Sync. Buffers locally; flushes at batchSize, flush(), or close(). */
  appendRow(values: unknown[]): void;

  /** Drain pending batches + flush to DuckDB. Resolves with total flushed rows. */
  flush(): Promise<AppendResult>;

  close(): Promise<void>;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

// ============================================================================
// Top-level
// ============================================================================

export function open(path: string): AsyncDatabase;
export function version(): Promise<string>;
