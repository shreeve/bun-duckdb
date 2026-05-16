// Shared protocol constants + error machinery for duckdb-bun/async.
//
// This file is imported by BOTH lib/async/index.mjs (main thread) and
// lib/async/worker.mjs (Worker thread). It deliberately holds no
// runtime state — just constants and error class wiring.
//
// Type declarations for the Request / Response / Target shapes live in
// lib/async/protocol.d.ts. They're not declared here because this
// package ships source directly (no transpile step), and TypeScript
// `export type` syntax wouldn't parse in plain .mjs.

import {
  DuckDBError,
  DuckDBClosedError,
  DuckDBPrepareError,
  DuckDBTransactionError,
  DuckDBAbortError,
} from '../duckdb.mjs';

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
  constructor(message) {
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
export function serializeError(err) {
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
export function reconstructError(serialized) {
  if (!serialized) return new DuckDBError('Unknown worker error');
  const Cls = ERROR_CLASSES[serialized.name] || DuckDBError;
  const err = new Cls(serialized.message || '');
  if (serialized.stack) {
    // Prefix so it's visually distinguishable from main-thread frames in
    // mixed stack traces — the worker's stack is otherwise the actual
    // file paths inside the .async/ subpath which can be confusing.
    err.stack = `[worker] ${serialized.stack}`;
  }
  if (serialized.code) err.code = serialized.code;
  if (serialized.cause) err.cause = reconstructError(serialized.cause);
  return err;
}

// ==============================================================================
// Op constants — string values match the discriminated union in
// lib/async/protocol.d.ts. Using constants instead of bare string
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
});

// Target.kind constants — same rationale as OP.
export const KIND = Object.freeze({
  DB:   'db',
  CONN: 'conn',
  STMT: 'stmt',
  APP:  'app',
});

// Worker → main "ready" handshake type. The Worker posts this once its
// module has loaded; the proxy queues outgoing requests until it
// arrives. (See lib/async/index.mjs §preReadyQueue.)
export const WORKER_READY = '__duckdb_bun_worker_ready__';
