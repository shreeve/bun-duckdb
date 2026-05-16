// TypeScript types for the duckdb-bun/async wire protocol.
//
// Imported separately from protocol.mjs because that file is shipped as
// pure ESM (no transpile step). The matching runtime constants
// (OP, KIND, WORKER_READY, ERROR_CLASSES, DuckDBWorkerCrashedError,
// serializeError, reconstructError) live in protocol.mjs.

import type { Params, Row } from '../../lib/duckdb.d.ts';

// ============================================================================
// Targets
// ============================================================================

/** Discriminated union identifying what kind of handle a request targets. */
export type Target =
  | { kind: 'db';   id: number }
  | { kind: 'conn'; id: number }
  | { kind: 'stmt'; id: number }
  | { kind: 'app';  id: number };

export type DbTarget   = Extract<Target, { kind: 'db' }>;
export type ConnTarget = Extract<Target, { kind: 'conn' }>;
export type StmtTarget = Extract<Target, { kind: 'stmt' }>;
export type AppTarget  = Extract<Target, { kind: 'app' }>;

/** Ops that target either a Database (uses its implicit conn) or a Connection. */
export type DbOrConn = DbTarget | ConnTarget;

// ============================================================================
// Open options (mirrors the main-thread surface)
// ============================================================================

/** Reserved for future use. Empty for v0.4.0. */
export interface OpenOptions {}

// ============================================================================
// Request / Response
// ============================================================================

/**
 * All requests carry a unique numeric `id` minted by the proxy. The
 * worker's response references it. IDs are monotonic uint53 starting
 * at 1; never reused within a Database's lifetime.
 */
export type Request =
  // ── lifecycle ─────────────────────────────────────────────────────
  | { id: number; op: 'open';         path: string; opts?: OpenOptions }
  | { id: number; op: 'close';        target: Target }
  // GC notification: fire-and-forget; no response expected.
  | { id: number; op: 'release';      target: Target }
  // ── connections ───────────────────────────────────────────────────
  | { id: number; op: 'connect';      target: DbTarget }
  // ── one-shot queries (mirror Database/Connection methods) ─────────
  | { id: number; op: 'query';        target: DbOrConn;
                                      method: 'query'|'all'|'get'|'run'|'exec';
                                      sql: string; params?: Params }
  // ── prepared statements ───────────────────────────────────────────
  | { id: number; op: 'prepare';      target: DbOrConn; sql: string }
  | { id: number; op: 'stmtCall';     target: StmtTarget;
                                      method: 'all'|'get'|'run'; params?: Params }
  // ── streaming (pull-based; no unsolicited pushes) ─────────────────
  | { id: number; op: 'iterStart';    target: StmtTarget; params?: Params }
  | { id: number; op: 'iterNext';     iterId: number }
  | { id: number; op: 'iterReturn';   iterId: number }
  // ── appender ──────────────────────────────────────────────────────
  | { id: number; op: 'appendCreate'; target: DbOrConn; table: string;
                                      columns: string[] }
  | { id: number; op: 'appendRows';   target: AppTarget; rows: unknown[][] }
  | { id: number; op: 'appendFlush';  target: AppTarget }
  // ── transactions (see RFC §7) ─────────────────────────────────────
  | { id: number; op: 'txnBegin';     target: DbOrConn }
  | { id: number; op: 'txnCommit';    target: ConnTarget }
  | { id: number; op: 'txnRollback';  target: ConnTarget };

export type Response =
  | { id: number; ok: true;  value: unknown }
  | { id: number; ok: false; error: SerializedError };

export interface SerializedError {
  /** Class name — used to reconstruct the right DuckDB*Error subclass. */
  name: string;
  message: string;
  /** Worker-side stack, prefixed with "[worker]" by reconstructError. */
  stack?: string;
  /** DuckDB-specific code; reserved for when duckdb_result_error_type() lands. */
  code?: string;
  /** Chained cause, recursively serialized. */
  cause?: SerializedError;
}

// ============================================================================
// Op string constants (re-exported from protocol.mjs as runtime values).
// ============================================================================

export type OpName = Request['op'];
export type TargetKind = Target['kind'];

// ============================================================================
// Response value shapes (the `value` field of a successful Response).
// ============================================================================

export interface OpenResult   { dbId: number }

/**
 * Reply to a `connect` / `txnBegin` request.
 *
 * `interruptHandle` is the raw `duckdb_connection` pointer (cast to
 * `BigInt`). Reserved for the planned AbortSignal cancellation: the main thread will
 * dlopen `duckdb_interrupt` and call it with this handle to abort an
 * in-flight query while the worker is blocked in FFI. The handle is
 * never dereferenced from JavaScript on the main thread.
 *
 * `interruptGeneration` is a monotonic token that lets the main thread
 * invalidate stale references — if a `connId` is recycled after
 * `close()`, the new generation prevents an old `AbortSignal` from
 * firing `duckdb_interrupt` on the recycled connection.
 *
 * Both fields are optional for back-compat with v0.4.0 servers, where
 * they were not sent. v0.4.1+ workers always include them.
 */
export interface ConnectResult {
  connId: number;
  interruptHandle?: bigint;
  interruptGeneration?: number;
}
export interface PrepareResult { stmtId: number }
export interface IterStartResult {
  iterId: number;
  /** Lightweight column descriptors so the proxy can attach `.columns` to results. */
  columns: Array<{ name: string; type: number; typeName: string }>;
}
export interface IterNextResult<T extends Row = Row> {
  /** Freshly-allocated array each response. Never reused by the worker. */
  rows: T[];
  /** True when the underlying stream is exhausted. `rows` may still be non-empty. */
  done: boolean;
}
export interface AppendCreateResult { appId: number }
export interface AppendRowsResult   { rows: number }
export interface AppendFlushResult  { rows: number }
export interface TxnBeginResult {
  connId: number;
  /** See ConnectResult.interruptHandle (forward-compat for v0.5). */
  interruptHandle?: bigint;
  interruptGeneration?: number;
}

/** What the worker sends back for any `close`/`release`/`appendFlush`/`commit`/`rollback`. */
export type OkResult = { ok: true };
