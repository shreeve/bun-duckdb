// Shared protocol constants + error machinery for duckdb-bun/async.
//
// This file is imported by BOTH lib/async/index.ts (main thread) and
// lib/async/worker.ts (Worker thread). It deliberately holds no
// runtime state — just constants and error class wiring.
//
// Type declarations for the Request / Response / Target shapes live at
// the bottom of this file (formerly lib/async/protocol.d.ts — the
// package now ships TypeScript source directly, no transpile step).

import {
  DuckDBError,
  DuckDBClosedError,
  DuckDBPrepareError,
  DuckDBTransactionError,
  DuckDBAbortError,
} from '../duckdb.ts';

import type { Params, Row } from '../duckdb.ts';

// ==============================================================================
// Worker-specific error
//
// Thrown on the main thread when the Worker exits unexpectedly (uncaught
// exception inside the worker, terminate() from anywhere, OS kill).
// All pending request promises reject with this; future calls on any
// proxy from that Database reject with DuckDBClosedError. No promise
// hangs forever.
// ==============================================================================

export class DuckDBWorkerCrashedError extends DuckDBError {
  declare readonly name: 'DuckDBWorkerCrashedError';

  constructor(message?: string) {
    super(message);
    this.name = 'DuckDBWorkerCrashedError';
  }
}

// Re-export the main-thread error classes so consumers of duckdb-bun/async
// can `import { DuckDBError, DuckDBClosedError, ... } from 'duckdb-bun/async'`
// and get the same identities the main-thread driver uses. The shared
// identity matters for `instanceof` checks against errors raised by
// either subpath.
export {
  DuckDBError,
  DuckDBClosedError,
  DuckDBPrepareError,
  DuckDBTransactionError,
  DuckDBAbortError,
};

// ==============================================================================
// Error reconstruction registry
//
// Both threads import from here. When the worker catches an error from
// the v0.3 driver, it serializes it to { name, message, stack, code,
// cause? } and posts it back. The main thread looks up the name here
// and constructs a real subclass instance, preserving message + stack
// and recursing for `cause`.
//
// If a name isn't registered, fall through to DuckDBError so the error
// still propagates as a DuckDB error (just without its specific
// subclass). A CI test in test/async/errors.test.mjs guards against
// new DuckDB* error classes that fail to register here.
// ==============================================================================

export const ERROR_CLASSES = Object.freeze({
  DuckDBError,
  DuckDBClosedError,
  DuckDBPrepareError,
  DuckDBTransactionError,
  DuckDBWorkerCrashedError,
  DuckDBAbortError,
  // 'AbortError' is the .name DuckDBAbortError uses (Web standard
  // convention). The serializer keys on .name, so register an alias
  // that maps the name back to the right class on the main thread.
  AbortError: DuckDBAbortError,
});

/** Serialize an Error (any subclass) for transmission across postMessage. */
export function serializeError(err: any): SerializedError {
  if (!err) return { name: 'Error', message: String(err) };
  return {
    name: err.name || 'Error',
    message: err.message || String(err),
    stack: typeof err.stack === 'string' ? err.stack : undefined,
    code: err.code,
    cause: err.cause ? serializeError(err.cause) : undefined,
  };
}

/** Reconstruct an Error on the main thread from its serialized form. */
export function reconstructError(serialized: SerializedError | null | undefined): DuckDBError {
  if (!serialized) return new DuckDBError('Unknown worker error');
  const Cls = (ERROR_CLASSES as Record<string, typeof DuckDBError>)[serialized.name] || DuckDBError;
  const err = new Cls(serialized.message || '');
  if (serialized.stack) {
    // Prefix so it's visually distinguishable from main-thread frames in
    // mixed stack traces — the worker's stack is otherwise the actual
    // file paths inside the .async/ subpath which can be confusing.
    err.stack = `[worker] ${serialized.stack}`;
  }
  if (serialized.code) (err as any).code = serialized.code;
  if (serialized.cause) err.cause = reconstructError(serialized.cause);
  return err;
}

// ==============================================================================
// Op constants — string values match the discriminated Request union
// declared below. Using constants instead of bare string
// literals at call sites makes typos a sync error rather than a
// silent "unknown op" reject.
// ==============================================================================

export const OP = Object.freeze({
  OPEN:         'open',
  CLOSE:        'close',
  RELEASE:      'release',
  CONNECT:      'connect',
  QUERY:        'query',
  PREPARE:      'prepare',
  STMT_CALL:    'stmtCall',
  ITER_START:   'iterStart',
  ITER_NEXT:    'iterNext',
  ITER_RETURN:  'iterReturn',
  APP_CREATE:   'appendCreate',
  APP_ROWS:     'appendRows',
  APP_FLUSH:    'appendFlush',
  TXN_BEGIN:    'txnBegin',
  TXN_COMMIT:   'txnCommit',
  TXN_ROLLBACK: 'txnRollback',
} as const);

// Target.kind constants — same rationale as OP.
export const KIND = Object.freeze({
  DB:   'db',
  CONN: 'conn',
  STMT: 'stmt',
  APP:  'app',
} as const);

// Worker → main "ready" handshake type. The Worker posts this once its
// module has loaded; the proxy queues outgoing requests until it
// arrives. (See lib/async/index.ts §preReadyQueue.)
export const WORKER_READY = '__duckdb_bun_worker_ready__';

// ==============================================================================
// Wire protocol types (formerly lib/async/protocol.d.ts)
//
// The matching runtime constants (OP, KIND, WORKER_READY, ERROR_CLASSES,
// DuckDBWorkerCrashedError, serializeError, reconstructError) live above.
// ==============================================================================

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
// Op string constants (declared as runtime values above).
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
 * `BigInt`). Used by AbortSignal cancellation (v0.7+): the main
 * thread calls `duckdb_interrupt(handle)` via its own FFI binding to
 * abort an in-flight query while the worker is blocked in FFI. The
 * handle is never dereferenced from JavaScript on the main thread.
 *
 * `interruptGeneration` is a monotonic token used as defense-in-depth
 * against stale references — if a `connId` were ever recycled after
 * `close()` (currently ids are monotonic, so this can't happen, but
 * the token is cheap insurance), the new generation would prevent an
 * old `AbortSignal` from firing `duckdb_interrupt` on the recycled
 * connection.
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
  /** See ConnectResult.interruptHandle. Used by AbortSignal cancellation
   *  (v0.7+) to interrupt sub-ops running inside the transaction. */
  interruptHandle?: bigint;
  interruptGeneration?: number;
}

/** What the worker sends back for any `close`/`release`/`appendFlush`/`commit`/`rollback`. */
export type OkResult = { ok: true };
