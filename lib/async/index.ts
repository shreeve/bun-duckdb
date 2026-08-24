// Main-thread entry for duckdb-bun/async.
//
// Spawns a single Worker per Database; mints monotonic numeric IDs for
// every Database / Connection / Statement / Appender; routes every
// public API call through one `postMessage` to the Worker and resolves
// when the response arrives. The Worker (lib/async/worker.ts) holds
// the actual DuckDB handles; this side holds only IDs.
//
// See docs/rfcs/0001-worker-async-api.md for the design contract and
// lib/async/protocol.ts for the wire shapes.

import {
  DuckDBError,
  DuckDBClosedError,
  DuckDBPrepareError,
  DuckDBTransactionError,
  DuckDBWorkerCrashedError,
  DuckDBAbortError,
  reconstructError,
  OP,
  KIND,
  WORKER_READY,
} from './protocol.ts';

// _internals exposes duckdb_interrupt (called directly from the main
// thread on a worker-owned connection handle — Bun Workers share the
// process's libduckdb state, so this is supported by DuckDB's C API).
// See lib/duckdb.ts near the bottom for the contract.
import { _internals } from '../duckdb.ts';

import type {
  Row, Params, QueryResult, RunResult, AppendResult,
  ColumnInfo, OpenOptions, RowChunk, TxnHandle, CheckpointOptions,
} from '../duckdb.ts';

export {
  DuckDBError,
  DuckDBClosedError,
  DuckDBPrepareError,
  DuckDBTransactionError,
  DuckDBWorkerCrashedError,
  DuckDBAbortError,
};

// Re-export the DUCKDB_TYPE constant from the main-thread driver so
// users of the async subpath get the same type-code mapping for
// introspecting result.columns.
export { DUCKDB_TYPE } from '../duckdb.ts';

// Re-export the shared public types so `duckdb-bun/async` consumers can
// import them without reaching into the sync subpath.
export type {
  Row, Params, QueryResult, RunResult, AppendResult, ColumnInfo,
  OpenOptions, RowChunk, TxnHandle, CheckpointOptions,
};

// ==============================================================================
// Option types (formerly lib/async/index.d.ts)
// ==============================================================================

/** Options for any single async op that should honor an AbortSignal. */
export interface QueryOptions {
  /**
   * AbortSignal used to cancel this op. (v0.7+)
   *
   * If aborted at call time, the op rejects immediately without
   * sending work to the worker. If aborted while the op is the
   * actively-running op on its connection, the main thread calls
   * duckdb_interrupt on the worker's connection handle and the op
   * rejects with DuckDBAbortError. Ops queued behind the active op
   * are not interrupted; they reject (also with DuckDBAbortError)
   * when their turn arrives.
   */
  signal?: AbortSignal;
}

/** Options for streaming iteration. */
export interface IterateOptions extends QueryOptions {
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

// Internal: iterator wrappers built by AsyncStatement.iterate() always
// implement next/return/throw, unlike the optional members on the base
// AsyncIterableIterator interface.
interface ActiveIterator<T = any> extends AsyncIterableIterator<T> {
  return(value?: any): Promise<IteratorResult<T, any>>;
  throw(e?: any): Promise<IteratorResult<T, any>>;
}

// Internal: sender callable handed to the inline-exec helpers (see
// AsyncConnection.#sender). (method, sql) → Promise of the wire result.
type InlineSender = (method: string, sql: string) => Promise<any>;

// ----------------------------------------------------------------------
// AbortSignal helpers — kept module-private; not part of the public API.
// ----------------------------------------------------------------------

// Build a DuckDBAbortError from an AbortSignal's reason (if any). The
// Web platform allows arbitrary `reason` values (often a DOMException
// or string); we extract a sensible message but always return a
// DuckDBAbortError so callers can catch one type.
function abortErrorFor(signal: AbortSignal | false | null | undefined): DuckDBAbortError {
  if (!signal) return new DuckDBAbortError();
  const r = signal.reason;
  if (r instanceof Error) {
    const e = new DuckDBAbortError(r.message || 'Query aborted');
    e.cause = r;
    return e;
  }
  if (typeof r === 'string') return new DuckDBAbortError(r);
  return new DuckDBAbortError();
}

// True if the AbortSignal-like object is in the aborted state. Treats
// null/undefined signals as not-aborted.
function isAborted(signal: AbortSignal | false | null | undefined): boolean {
  return !!(signal && signal.aborted);
}

// ==============================================================================
// AsyncDatabase
// ==============================================================================

class AsyncDatabase {
  #path: string;
  #opts: OpenOptions | undefined;
  #worker: Worker | null = null;
  #state: 'pre-open' | 'opening' | 'open' | 'closing' | 'closed' | 'crashed' = 'pre-open';          // 'pre-open' | 'opening' | 'open' | 'closing' | 'closed' | 'crashed'
  #dbId: number | null = null;
  #nextRequestId = 1;
  #pending = new Map<number, { resolve: (value: any) => void; reject: (err: unknown) => void }>();         // id → { resolve, reject }
  #ready = false;
  #preReadyQueue: any[] = [];          // requests sent before the worker's ready handshake
  #openPromise: Promise<void> | null = null;
  #openFailed: unknown = null;           // cached error after a failed open
  #closePromise: Promise<void> | null = null;
  #crashError: DuckDBWorkerCrashedError | null = null;
  #defaultConn: AsyncConnection | null = null;          // lazy implicit AsyncConnection — all
                                // db-level shortcuts (db.query / db.exec /
                                // db.iterate / db.prepare / ...) route
                                // through it so AbortSignal has a stable
                                // connection identity to interrupt.
  // Interrupt-capability cache (v0.4.1 plumbing, v0.7 actually used).
  // Per AsyncConnection, the worker returns the raw duckdb_connection
  // pointer (BigInt) plus a generation token on its `connect` /
  // `txnBegin` response. The main thread stores it here and, when an
  // AbortSignal fires for an in-flight op on that conn, calls
  // duckdb_interrupt(ptr) directly via the FFI binding declared in
  // lib/duckdb.ts. Bun Workers share the process's libduckdb state,
  // so this is the supported way to cancel a worker-blocked query
  // from the main thread.
  _interruptHandles = new Map<number, { ptr: bigint; generation?: number }>(); // connId → { ptr: bigint, generation: number }

  constructor(path: string, opts?: OpenOptions) {
    this.#path = path;
    this.#opts = opts;
    this.#spawnWorker();
  }

  #spawnWorker() {
    try {
      const url = new URL('./worker.ts', import.meta.url);
      this.#worker = new Worker(url.href);
    } catch (err: any) {
      // Sync spawn failure (file URL didn't resolve, etc.). Cache and
      // every awaited op rejects.
      this.#crashError = new DuckDBWorkerCrashedError(
        `Failed to spawn worker: ${err.message}`,
      );
      this.#state = 'crashed';
      return;
    }
    this.#worker.addEventListener('message', (e) => this.#onMessage(e.data));
    this.#worker.addEventListener('error', (e) => {
      // Bun's Worker error event is an ErrorEvent-ish object. Convert
      // to a Worker-crashed error and reject everything in flight.
      this.#onCrash(e?.message || 'Worker error event');
    });
    // Bun doesn't fire a guaranteed 'exit' event with code, but
    // 'close' / 'messageerror' may. Hook what we can.
    if (typeof this.#worker.addEventListener === 'function') {
      this.#worker.addEventListener('messageerror', (e: any) => {
        this.#onCrash(`messageerror: ${e?.message || ''}`);
      });
    }
  }

  #onMessage(data: any) {
    if (data && data.type === WORKER_READY) {
      this.#ready = true;
      // Flush queued messages
      for (const req of this.#preReadyQueue) this.#worker!.postMessage(req);
      this.#preReadyQueue = [];
      return;
    }
    if (!data || typeof data.id !== 'number') return;
    const pending = this.#pending.get(data.id);
    if (!pending) return;
    this.#pending.delete(data.id);
    if (data.ok) pending.resolve(data.value);
    else         pending.reject(reconstructError(data.error));
  }

  #onCrash(message: string) {
    if (this.#state === 'crashed' || this.#state === 'closed') return;
    this.#crashError = new DuckDBWorkerCrashedError(
      message || 'Worker exited unexpectedly',
    );
    this.#state = 'crashed';
    // Reject all in-flight requests
    for (const { reject } of this.#pending.values()) reject(this.#crashError);
    this.#pending.clear();
    // Clear pre-ready queue without sending — worker is gone.
    this.#preReadyQueue = [];
  }

  // Internal: trigger lazy db open from outside the class. Used by
  // AsyncConnection.#ensureOpen since it needs the db to be open
  // before sending CONNECT, but can't recurse through any db.method()
  // shortcut (those route through the implicit conn — infinite loop).
  _ensureDbOpen() { return this.#ensureOpen(); }

  // Send a request and return a Promise for its response. The proxy
  // queues until the worker's ready handshake arrives so the user can
  // call methods immediately after open() returns.
  //
  // Check `#openFailed` BEFORE `#state === 'crashed'` because a failed
  // open also sets state to 'crashed' (so subsequent ops are sticky),
  // but the meaningful error to surface is the original open failure,
  // not a generic crash error.
  // Wire-boundary escape hatch (`req: any` / `Promise<any>`): requests
  // are structurally the Request union in protocol.ts, but several call
  // sites build targets from ids that are `number | null` until lazy
  // open completes (the runtime guarantees non-null by then), and each
  // caller knows its own response shape. Typing the boundary loosely
  // here beats sprinkling non-null assertions on every message literal.
  _send(req: any): Promise<any> {
    if (this.#openFailed)          return Promise.reject(this.#openFailed);
    if (this.#state === 'crashed') return Promise.reject(this.#crashError || new DuckDBWorkerCrashedError('Worker crashed'));
    if (this.#state === 'closed')  return Promise.reject(new DuckDBClosedError('Database'));

    const id = this.#nextRequestId++;
    const message = { ...req, id };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      if (this.#ready) {
        try { this.#worker!.postMessage(message); }
        catch (err: any) {
          this.#pending.delete(id);
          reject(new DuckDBError(`postMessage failed: ${err.message}`));
        }
      } else {
        this.#preReadyQueue.push(message);
      }
    });
  }

  // Lazy open. Called by every awaited public method that needs the
  // database to be open. Concurrent first-callers share the same
  // promise; if open fails, the failure is cached and all subsequent
  // ops reject with the same error.
  async #ensureOpen(): Promise<void> {
    if (this.#state === 'open')                       return;
    if (this.#openFailed)                             throw this.#openFailed;
    if (this.#state === 'crashed')                    throw this.#crashError || new DuckDBWorkerCrashedError('Worker crashed');
    if (this.#state === 'closed')                     throw new DuckDBClosedError('Database');
    if (this.#openPromise)                            return this.#openPromise;

    this.#state = 'opening';
    this.#openPromise = (async () => {
      try {
        const { dbId } = await this._send({
          op: OP.OPEN, path: this.#path, opts: this.#opts,
        });
        this.#dbId = dbId;
        this.#state = 'open';
      } catch (err) {
        this.#openFailed = err;
        this.#state = 'crashed';
        throw err;
      } finally {
        this.#openPromise = null;
      }
    })();
    return this.#openPromise;
  }

  /** Read-only: numeric Database ID inside the worker. Null until lazy open completes. */
  get id(): number | null { return this.#dbId; }
  get _state(): 'pre-open' | 'opening' | 'open' | 'closing' | 'closed' | 'crashed' { return this.#state; }

  /** Sync — returns an AsyncConnection proxy. The actual duckdb_connect happens lazily. */
  connect(): AsyncConnection {
    return new AsyncConnection(this);
  }

  // Lazy implicit connection used by every db-level shortcut. Creating
  // the proxy is sync; the underlying duckdb_connect happens lazily on
  // first use. We keep exactly one default conn per Database so
  // signal-based cancellation has a stable connection identity for
  // db.query / db.exec / db.iterate / db.prepare / etc.
  #getDefaultConn(): AsyncConnection {
    if (!this.#defaultConn) this.#defaultConn = new AsyncConnection(this);
    return this.#defaultConn;
  }

  query<T extends Row = Row>(sql: string, params?: Params, opts?: QueryOptions): Promise<QueryResult<T>>   { return this.#getDefaultConn().query(sql, params, opts); }
  all<T extends Row = Row>(sql: string, params?: Params, opts?: QueryOptions): Promise<QueryResult<T>>     { return this.#getDefaultConn().all(sql, params, opts); }
  get<T extends Row = Row>(sql: string, params?: Params, opts?: QueryOptions): Promise<T | undefined>     { return this.#getDefaultConn().get(sql, params, opts); }
  run(sql: string, params?: Params, opts?: QueryOptions): Promise<RunResult>     { return this.#getDefaultConn().run(sql, params, opts); }
  exec(sql: string, opts?: QueryOptions): Promise<void>            { return this.#getDefaultConn().exec(sql, opts); }
  prepare<T extends Row = Row>(sql: string): Promise<AsyncStatement<T>>               { return this.#getDefaultConn().prepare(sql); }
  iterate<T extends Row = Row>(sql: string, params?: Params, opts?: IterateOptions): AsyncIterableIterator<T> { return this.#getDefaultConn().iterate(sql, params, opts); }
  /** Stream rows chunk-by-chunk. (v0.5+) */
  chunks<T extends Row = Row>(sql: string, params?: Params, opts?: QueryOptions): AsyncIterableIterator<RowChunk<T>>  { return this.#getDefaultConn().chunks(sql, params, opts); }

  /** Run `PRAGMA name` (get) or `PRAGMA name=value` (set). (v0.5+) */
  pragma(name: string, value?: string | number | boolean | bigint | null): Promise<Row | undefined> {
    // Preserve the 1-vs-2-argument distinction (get vs set) — can't
    // delegate via `...rest` because that would always pass 2 args.
    const c = this.#getDefaultConn();
    return arguments.length < 2 ? c.pragma(name) : c.pragma(name, value);
  }

  /** `INSTALL <name>` with strict identifier validation. (v0.5+) */
  installExtension(name: string): Promise<void> { return this.#getDefaultConn().installExtension(name); }
  /** `LOAD <name>` with strict identifier validation. (v0.5+) */
  loadExtension(name: string): Promise<void>    { return this.#getDefaultConn().loadExtension(name); }
  /** Flush the WAL via `CHECKPOINT` (or `FORCE CHECKPOINT`). (v0.5.1+) */
  checkpoint(opts?: CheckpointOptions): Promise<void>       { return this.#getDefaultConn().checkpoint(opts); }

  async transaction<R>(fn: (tx: AsyncConnection) => Promise<R>): Promise<R> {
    await this.#ensureOpen();
    return runTransaction(this, { kind: KIND.DB, id: this.#dbId }, fn);
  }

  /**
   * Close the Database. Async. Idempotent. Waits for in-flight ops to
   * settle (subject to optional timeout), tells the worker to close
   * the Database (cascades to all children), then terminates the
   * Worker.
   *
   * Options:
   *   - timeout: number of ms to wait for in-flight ops before forcing
   *     worker.terminate(). Default: no timeout (waits forever).
   */
  async close(opts?: CloseOptions): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state === 'closed' || this.#state === 'crashed') {
      this.#state = 'closed';
      return;
    }
    const timeout = opts && typeof opts.timeout === 'number' ? opts.timeout : undefined;

    this.#closePromise = (async () => {
      const wasOpen = this.#state === 'open' && this.#dbId !== null;
      this.#state = 'closing';

      // Close the implicit default conn first if one was created. Its
      // close cascade flushes any active iterators / serialization
      // chain before we tear down the worker-side Database (which
      // would invalidate every child handle anyway).
      if (this.#defaultConn) {
        try { await this.#defaultConn.close(); } catch { /* swallow */ }
        this.#defaultConn = null;
      }

      let closeTask: Promise<unknown>;
      if (wasOpen) {
        closeTask = this._send({
          op: OP.CLOSE, target: { kind: KIND.DB, id: this.#dbId },
        }).catch(() => { /* worker may die during close — that's fine */ });
      } else {
        closeTask = Promise.resolve();
      }

      if (typeof timeout === 'number') {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise(resolve => {
          timer = setTimeout(() => resolve('timeout'), timeout);
        });
        const result = await Promise.race([closeTask.then(() => 'ok'), timedOut]);
        clearTimeout(timer);
        if (result === 'timeout') {
          // Force kill. Mark as crashed so #ensureOpen-style rechecks
          // see the right state; reject in-flight via #onCrash.
          this.#onCrash('close timeout');
        }
      } else {
        await closeTask;
      }

      try { this.#worker?.terminate(); } catch { /* swallow */ }
      this.#worker = null;
      // Reject any requests that never got a response (typical when
      // close was called with in-flight ops, e.g. close({timeout:0})
      // racing a pending op, or a Database close while child
      // operations were queued at the worker).
      for (const { reject } of this.#pending.values()) {
        reject(new DuckDBClosedError('Database'));
      }
      this.#pending.clear();
      this.#preReadyQueue = [];
      // Drop all interrupt-capability entries: any AbortSignal handler
      // that fires after db close looks up its connId and finds
      // nothing, bailing before it could call duckdb_interrupt on a
      // freed connection pointer.
      this._interruptHandles.clear();
      this.#state = 'closed';
      this.#dbId = null;
    })();
    return this.#closePromise;
  }

  [Symbol.dispose]() { this.close().catch(() => { /* fire-and-forget */ }); }
  [Symbol.asyncDispose]() { return this.close(); }
}

// ==============================================================================
// AsyncConnection
// ==============================================================================

class AsyncConnection {
  #db: AsyncDatabase;
  #connId: number | null = null;
  #connectPromise: Promise<void> | null = null;
  #state: 'pre-open' | 'opening' | 'open' | 'closing' | 'closed' = 'pre-open';     // 'pre-open' | 'opening' | 'open' | 'closing' | 'closed'
  #closePromise: Promise<void> | null = null;
  #inTransaction = false;
  // Per-conn serialization chain. All async ops (query/exec/run/all/
  // get/iter*/append*/pragma/etc.) enqueue onto this so at most ONE
  // op is in flight to the worker at any time on this conn. Matches
  // the sync driver's per-Connection lock semantics, and gives us a
  // well-defined "active request" for AbortSignal cancellation.
  #serialChain: Promise<unknown> = Promise.resolve();
  // Identity of the currently active op (null when idle). Set inside
  // #runSerial and cleared in its finally. AbortSignal handler checks
  // that the active token still matches its own before firing
  // duckdb_interrupt, so a stale handler can't interrupt a later op.
  #activeOp: { token: object; signal: AbortSignal | false | undefined } | null = null;        // { token: object, signal: AbortSignal | undefined }

  constructor(db: AsyncDatabase, /** optional pre-allocated connId (used by transaction) */ preConnId: number | null = null,
              /** mark this conn as already inside a transaction (used by runTransaction's txConn) */
              isTxnConn = false) {
    this.#db = db;
    if (preConnId !== null) {
      this.#connId = preConnId;
      this.#state = 'open';
    }
    if (isTxnConn) this.#inTransaction = true;
  }

  get id(): number | null { return this.#connId; }
  get _state(): 'pre-open' | 'opening' | 'open' | 'closing' | 'closed' { return this.#state; }

  async #ensureOpen(): Promise<void> {
    if (this.#state === 'open')    return;
    if (this.#state === 'closed')  throw new DuckDBClosedError('Connection');
    if (this.#state === 'closing') throw new DuckDBClosedError('Connection');
    if (this.#connectPromise)      return this.#connectPromise;

    this.#state = 'opening';
    this.#connectPromise = (async () => {
      try {
        // Trigger lazy db open via the private hatch. We can't call
        // any db.method() shortcut here — those route through the
        // implicit conn (which may BE us), so it would infinite-loop.
        // AsyncDatabase._ensureDbOpen() throws the sticky open failure
        // on every retry, so propagating that error is the right
        // identity-preserving behavior.
        await this.#db._ensureDbOpen();
        const res = await this.#db._send({
          op: OP.CONNECT, target: { kind: KIND.DB, id: this.#db.id },
        });
        this.#connId = res.connId;
        // Store the worker's duckdb_connection handle so the main
        // thread can call duckdb_interrupt on it when AbortSignal
        // fires. The generation token prevents stale-pointer use:
        // if this connId is ever reused (it isn't, ids are
        // monotonic — but defensive), the generation mismatch
        // ensures we don't interrupt an unrelated conn.
        if (res.interruptHandle !== undefined) {
          this.#db._interruptHandles.set(res.connId, {
            ptr: res.interruptHandle,
            generation: res.interruptGeneration,
          });
        }
        this.#state = 'open';
      } catch (err) {
        // If the failure was a db open failure, leave us in 'pre-open'
        // so a subsequent #ensureOpen retries and re-throws the SAME
        // cached error (sticky-open-failure invariant; tests rely on
        // err identity across attempts). Only move to 'closed' for
        // unambiguous closed-conn errors.
        this.#state = 'pre-open';
        throw err;
      } finally {
        this.#connectPromise = null;
      }
    })();
    return this.#connectPromise;
  }

  // ─── Cancellation primitive ──────────────────────────────────────
  // Run `fn` on this connection's serialization chain. Wires the
  // AbortSignal in `opts.signal` (if any) to interrupt the in-flight
  // op via duckdb_interrupt on the worker-owned connection handle.
  //
  // Three cases:
  //   1. signal already aborted at call time → reject immediately,
  //      never enqueue, never touch the worker.
  //   2. signal fires while this op is active → call duckdb_interrupt
  //      on the conn handle. Worker's blocked FFI returns with a
  //      DuckDB error; we replace it with DuckDBAbortError.
  //   3. signal fires after this op completed but before .return →
  //      detected by the token comparison; #interrupt is a no-op for
  //      a non-active op. The op resolves normally.
  //
  // Aborts to ops that are still queued behind another active op:
  // they wait their turn, then immediately reject at dequeue time
  // (because the signal is already aborted when they enter the
  // serial body) — never reach the worker. This satisfies the
  // "abort queued does not interrupt active" invariant.
  async #runSerial(opts: QueryOptions | undefined, fn: () => any): Promise<any> {
    const signal = opts && opts.signal;
    if (isAborted(signal)) throw abortErrorFor(signal);
    if (this.#state === 'closed' || this.#state === 'closing') {
      throw new DuckDBClosedError('Connection');
    }
    const enqueued = this.#serialChain.then(async () => {
      // Re-check abort inside the chain: the signal may have fired
      // while we were queued behind an earlier op.
      //
      // We do NOT re-check 'closed'/'closing' here — close() drains
      // the serial chain BEFORE transitioning state, so any op that
      // reached this body was enqueued while state was 'open'. The
      // entrance check at the top of #runSerial catches ops added
      // after close has started.
      //
      // The benefit of "drain first, transition state second" is
      // timing: queued ops complete normally (resolve), and new ops
      // get a synchronous rejection from the entrance check. This
      // avoids a delicate unhandled-rejection window where a
      // queued promise rejects faster than the user's .then() can
      // attach a handler.
      if (isAborted(signal)) throw abortErrorFor(signal);
      await this.#ensureOpen();
      // Re-check after #ensureOpen: it can take real wall time on a
      // fresh AsyncDatabase (worker spawn + OPEN + CONNECT round-
      // trips, easily 100ms+ on CI). Without this, an abort firing
      // during that window would attach a handler AFTER the abort
      // already happened — handler never fires, signal.aborted is
      // true but our local flag stays false, and the actual query
      // runs unimpeded. The CI test "active long query aborts
      // quickly" caught this on a cold worker.
      if (isAborted(signal)) throw abortErrorFor(signal);

      const token = {};
      let abortedDuringOp = false;
      const abortHandler = () => {
        abortedDuringOp = true;
        // Only interrupt if this is still the active op. Otherwise
        // either the op completed before the abort handler ran
        // (#activeOp cleared) or some later op is now active (token
        // mismatch) — either way, don't touch a stale request.
        if (this.#activeOp && this.#activeOp.token === token) {
          this.#interrupt();
        }
      };
      this.#activeOp = { token, signal };
      if (signal) signal.addEventListener('abort', abortHandler, { once: true });
      try {
        const result = await fn();
        // If abort fired during the op (even if libduckdb finished
        // before the interrupt arrived), honor the abort. The user
        // explicitly chose to cancel; deliver AbortError regardless
        // of timing race. Same convention as fetch + AbortSignal.
        if (abortedDuringOp) throw abortErrorFor(signal);
        return result;
      } catch (err) {
        if (abortedDuringOp) throw abortErrorFor(signal);
        throw err;
      } finally {
        if (signal) signal.removeEventListener('abort', abortHandler);
        if (this.#activeOp && this.#activeOp.token === token) {
          this.#activeOp = null;
        }
      }
    });
    // Replace the chain with a never-rejecting tail so a single op's
    // failure doesn't poison every subsequent enqueue.
    this.#serialChain = enqueued.then(() => undefined, () => undefined);
    return enqueued;
  }

  // Call duckdb_interrupt on this conn's worker-owned handle. Safe to
  // call when nothing is running (no-op at libduckdb level).
  #interrupt() {
    if (this.#connId === null) return;
    const cap = this.#db._interruptHandles.get(this.#connId);
    if (!cap) return;
    try { _internals.duckdb_interrupt(cap.ptr); }
    catch { /* swallow — interrupting a freed conn would be the only
               way this throws, and the response will still resolve. */ }
  }

  #queryOp(method: 'query' | 'all' | 'get' | 'run' | 'exec', sql: string, params: Params | undefined, opts: QueryOptions | undefined) {
    return this.#runSerial(opts, () =>
      this.#db._send({
        op: OP.QUERY, target: { kind: KIND.CONN, id: this.#connId },
        method, sql, params,
      }),
    );
  }

  query<T extends Row = Row>(sql: string, params?: Params, opts?: QueryOptions): Promise<QueryResult<T>> { return this.#queryOp('query', sql, params, opts); }
  all<T extends Row = Row>(sql: string, params?: Params, opts?: QueryOptions): Promise<QueryResult<T>>   { return this.#queryOp('all',   sql, params, opts); }
  get<T extends Row = Row>(sql: string, params?: Params, opts?: QueryOptions): Promise<T | undefined>   { return this.#queryOp('get',   sql, params, opts); }
  run(sql: string, params?: Params, opts?: QueryOptions): Promise<RunResult>   { return this.#queryOp('run',   sql, params, opts); }
  exec(sql: string, opts?: QueryOptions): Promise<void>          { return this.#queryOp('exec',  sql, undefined, opts); }

  async prepare<T extends Row = Row>(sql: string): Promise<AsyncStatement<T>> {
    // Prepare itself doesn't take a signal — it's quick and the
    // resulting Statement carries its own per-call signal support.
    return this.#runSerial(undefined, async () => {
      const { stmtId } = await this.#db._send({
        op: OP.PREPARE, target: { kind: KIND.CONN, id: this.#connId }, sql,
      });
      return new AsyncStatement(this.#db, stmtId, this);
    });
  }

  iterate<T extends Row = Row>(sql: string, params?: Params, opts?: IterateOptions): AsyncIterableIterator<T> {
    return iterateThroughConn(this, sql, params, opts);
  }

  /** Stream rows chunk-by-chunk. (v0.5+) */
  chunks<T extends Row = Row>(sql: string, params?: Params, opts?: QueryOptions): AsyncIterableIterator<RowChunk<T>> {
    return chunksThroughConn(this, sql, params, opts);
  }

  /** Run `PRAGMA name` (get) or `PRAGMA name=value` (set). (v0.5+) */
  pragma(name: string, value?: string | number | boolean | bigint | null): Promise<Row | undefined> {
    const isGet = arguments.length < 2;
    return this.#runSerial(undefined, () =>
      execPragmaInline(this.#sender(), name, value, isGet),
    );
  }

  /** `INSTALL <name>` with strict identifier validation. (v0.5+) */
  installExtension(name: string): Promise<void> {
    return this.#runSerial(undefined, () =>
      execExtensionInline(this.#sender(), 'INSTALL', name),
    );
  }

  /** `LOAD <name>` with strict identifier validation. (v0.5+) */
  loadExtension(name: string): Promise<void> {
    return this.#runSerial(undefined, () =>
      execExtensionInline(this.#sender(), 'LOAD', name),
    );
  }

  /** Flush the WAL via `CHECKPOINT` (or `FORCE CHECKPOINT`). (v0.5.1+) */
  checkpoint(opts?: CheckpointOptions): Promise<void> {
    return this.#runSerial(undefined, () =>
      execCheckpointInline(this.#sender(), opts),
    );
  }

  // Build a sender bound to this conn's id. Returns (method, sql) → Promise.
  // Used by inline-exec helpers that already run inside #runSerial and
  // must NOT re-enter the chain (would deadlock).
  #sender(): InlineSender {
    const db = this.#db;
    const connId = this.#connId;
    return (method, sql) => db._send({
      op: OP.QUERY, target: { kind: KIND.CONN, id: connId }, method, sql,
    });
  }

  // Internal: send a request through the serialization chain. Used by
  // AsyncStatement so prepared-statement calls and iterations on a
  // given connection serialize against the connection's other ops.
  _runSerial(opts: QueryOptions | undefined, fn: () => any): Promise<any> { return this.#runSerial(opts, fn); }
  // Internal: an "I am inside #runSerial — let me send raw" escape
  // hatch. Returns a sender callable that bypasses serialization.
  // AsyncStatement uses this to route stmt calls through its owning
  // conn's serialization chain.
  _rawSender(): InlineSender { return this.#sender(); }
  // Internal: called by an iterator's abort handler to interrupt the
  // worker-side query without going through #runSerial. The iterator
  // owns its own serialization (one in-flight iterNext at a time on
  // a Statement), so we just need to fire the interrupt.
  _interruptForIterator() { this.#interrupt(); }
  // Internal: wrap an iterNext send so the conn's #activeOp slot is
  // set for its duration. Lets iterator aborts use the same
  // #interrupt path as regular ops without needing #runSerial.
  // Returns the underlying promise so the caller's await preserves
  // ordering semantics.
  async _withActiveIterChunk(fn: () => Promise<any>): Promise<any> {
    const token = {};
    this.#activeOp = { token, signal: undefined };
    try { return await fn(); }
    finally {
      if (this.#activeOp && this.#activeOp.token === token) this.#activeOp = null;
    }
  }

  /**
   * Bulk insert via the Appender API. Two forms:
   *   - One-shot: `conn.append(table, columns, rows)` — sends rows,
   *     flushes, returns `{ rows: number }`. Mirrors v0.3 main-thread.
   *   - Streaming: `conn.append(table, columns)` returns an
   *     `AsyncAppender` proxy the caller drives.
   */
  async append(table: string, columns: string[], rows: unknown[][]): Promise<AppendResult>;
  async append(table: string, columns: string[]): Promise<AsyncAppender>;
  async append(table: string, columns: string[], rows?: unknown[][]): Promise<AppendResult | AsyncAppender> {
    // For convenience, support the one-shot signature
    // `conn.append(table, columns, rows)` that v0.3 uses.
    await this.#ensureOpen();
    const { appId } = await this.#db._send({
      op: OP.APP_CREATE, target: { kind: KIND.CONN, id: this.#connId },
      table, columns,
    });
    if (rows !== undefined) {
      // One-shot mode: send rows, flush, "close" by destroying.
      try {
        await this.#db._send({
          op: OP.APP_ROWS, target: { kind: KIND.APP, id: appId }, rows,
        });
        const result = await this.#db._send({
          op: OP.APP_FLUSH, target: { kind: KIND.APP, id: appId },
        });
        return { rows: result.rows };
      } finally {
        try {
          await this.#db._send({
            op: OP.CLOSE, target: { kind: KIND.APP, id: appId },
          });
        } catch { /* swallow */ }
      }
    }
    // Streaming mode: return an AsyncAppender proxy. Caller drives.
    return new AsyncAppender(this.#db, appId);
  }

  async transaction<R>(fn: (tx: AsyncConnection) => Promise<R>): Promise<R> {
    await this.#ensureOpen();
    if (this.#inTransaction) {
      throw new DuckDBTransactionError('Nested transactions are not supported');
    }
    this.#inTransaction = true;
    try {
      return await runTransaction(this.#db, { kind: KIND.CONN, id: this.#connId }, fn);
    } finally {
      this.#inTransaction = false;
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state === 'closed') return;
    const wasOpen = this.#state === 'open' && this.#connId !== null;
    this.#closePromise = (async () => {
      // Drain the serial chain FIRST while state is still 'open' so
      // any already-queued ops complete normally (don't rug-pull
      // them with a synchronous DCE). New ops added after this drain
      // see state='closing' on the entrance check in #runSerial and
      // reject synchronously, but those rejections happen in user-
      // initiated code paths where .then is already attached.
      try { await this.#serialChain; } catch { /* op may have rejected */ }
      this.#state = 'closing';
      // Drop the interrupt-capability entry now so any late
      // abort listener that fires here finds nothing and bails.
      // Without this an abort firing between drain and CLOSE
      // could call duckdb_interrupt on a conn we're about to
      // destroy. The generation token would also save us, but
      // explicit removal is cleaner.
      if (this.#connId !== null) {
        this.#db._interruptHandles.delete(this.#connId);
      }
      if (wasOpen) {
        try {
          await this.#db._send({
            op: OP.CLOSE, target: { kind: KIND.CONN, id: this.#connId },
          });
        } catch { /* swallow */ }
      }
      this.#state = 'closed';
      this.#connId = null;
    })();
    return this.#closePromise;
  }

  [Symbol.dispose]() { this.close().catch(() => {}); }
  [Symbol.asyncDispose]() { return this.close(); }
}

// ==============================================================================
// AsyncStatement
// ==============================================================================

class AsyncStatement<T extends Row = Row> {
  #db: AsyncDatabase;
  #stmtId: number;
  #conn: AsyncConnection | null;                    // owning AsyncConnection (or null if owned by db's implicit)
  #state: 'open' | 'closing' | 'closed' = 'open';          // 'open' | 'closing' | 'closed'
  #closePromise: Promise<void> | null = null;
  #activeIterator: ActiveIterator<T> | null = null;

  constructor(db: AsyncDatabase, stmtId: number, conn: AsyncConnection | null = null) {
    this.#db = db;
    this.#stmtId = stmtId;
    this.#conn = conn;
  }

  get id(): number { return this.#stmtId; }
  get closed(): boolean { return this.#state !== 'open'; }

  #stmtCall(method: 'all' | 'get' | 'run', params: Params | undefined, opts: QueryOptions | undefined) {
    if (this.#state !== 'open') return Promise.reject(new DuckDBClosedError('Statement'));
    if (this.#activeIterator) return Promise.reject(new DuckDBError('Statement is iterating; consume or close the iterator first'));
    // If we have an owning AsyncConnection, route through its serial
    // chain so the stmt call serializes with other ops on the same
    // conn and gets AbortSignal support. Otherwise (statement owned
    // by AsyncDatabase shortcuts before the implicit-conn refactor),
    // fall back to a raw _send — no per-stmt signal in that path.
    const sendRaw = () => this.#db._send({
      op: OP.STMT_CALL, target: { kind: KIND.STMT, id: this.#stmtId },
      method, params,
    });
    if (this.#conn) return this.#conn._runSerial(opts, sendRaw);
    return sendRaw();
  }

  all(params?: Params, opts?: QueryOptions): Promise<QueryResult<T>> { return this.#stmtCall('all', params, opts); }
  get(params?: Params, opts?: QueryOptions): Promise<T | undefined> { return this.#stmtCall('get', params, opts); }
  run(params?: Params, opts?: QueryOptions): Promise<RunResult> { return this.#stmtCall('run', params, opts); }

  /**
   * Stream rows from a prepared statement. Pull-based per-chunk.
   *
   * Options:
   *   - prefetch: number of chunks the worker keeps ready ahead of the
   *     consumer. Default: 1. Range: [0, 4]. prefetch=0 is strict pull
   *     (no overlap between drain + fetch).
   *   - signal: AbortSignal. If aborted while an iterNext is in flight,
   *     the conn is interrupted; .next() rejects with DuckDBAbortError
   *     and the iterator is cleaned up. If aborted between iterNext
   *     calls (i.e. while serving from the local buffer or right after
   *     an exhausted chunk), the next call to .next() rejects with
   *     DuckDBAbortError.
   */
  iterate(params?: Params, opts?: IterateOptions): AsyncIterableIterator<T> {
    if (this.#state !== 'open') throw new DuckDBClosedError('Statement');
    if (this.#activeIterator) throw new DuckDBError('Statement is already iterating');

    const prefetch = clampPrefetch(opts && opts.prefetch);
    const signal = opts && opts.signal;
    const self = this;
    const db = this.#db;
    const conn = this.#conn;
    const stmtId = this.#stmtId;

    let iterId: number | null = null;
    let started  = false;
    let finished = false;
    let buffer: any[] = [];
    let bufferIdx = 0;
    let exhausted = false;
    let nextChunk: Promise<any> | null = null;     // in-flight prefetch promise

    // The signal arms a flag that .next() and the in-flight prefetch
    // honor. The handler also fires duckdb_interrupt on the owning
    // conn so a worker-blocked iterNext returns immediately. We do
    // NOT remove the handler on completion of a single iterNext —
    // it's installed once for the iterator's lifetime, removed on
    // cleanup. So even an abort fired between iterNext calls (when
    // the conn is idle) sets the flag; .next() picks it up on its
    // re-check.
    let aborted = false;
    const abortHandler = signal ? () => {
      aborted = true;
      // Interrupt whatever's running on this conn. If nothing is
      // running, this is a no-op at libduckdb. The flag above
      // ensures .next() rejects even without a worker-side interrupt.
      if (conn) conn._interruptForIterator();
    } : null;
    if (signal) {
      if (signal.aborted) aborted = true;
      else signal.addEventListener('abort', abortHandler!, { once: true });
    }

    function abortIfNeeded() {
      if (aborted) throw abortErrorFor(signal);
    }

    // Iterator wire ops bypass the conn's serial chain — they take
    // exclusive use of the conn for the duration of the iterator
    // (the Statement guard above ensures no other op runs on this
    // stmt). The conn's #activeOp tracking still lets duckdb_interrupt
    // hit the right query.
    async function startIter() {
      const res = await db._send({
        op: OP.ITER_START, target: { kind: KIND.STMT, id: stmtId }, params,
      });
      iterId = res.iterId;
    }

    function fetchChunk() {
      // Mark the iterNext as the conn's active op (via conn) so an
      // abort during it triggers duckdb_interrupt on the right conn.
      // We don't go through #runSerial because iterators establish
      // their own per-iteration discipline and would deadlock with
      // prefetch otherwise. Instead, set the conn's activeOp directly
      // around the in-flight chunk fetch.
      if (!conn) return db._send({ op: OP.ITER_NEXT, iterId });
      return conn._withActiveIterChunk(() =>
        db._send({ op: OP.ITER_NEXT, iterId }),
      );
    }

    async function nextRow(): Promise<IteratorResult<any>> {
      abortIfNeeded();
      // Drain local buffer first
      if (bufferIdx < buffer.length) return { value: buffer[bufferIdx++], done: false };
      // Buffer empty. If we have a prefetch in flight, await it. Else fetch now.
      let chunk;
      if (nextChunk) { chunk = await nextChunk; nextChunk = null; }
      else if (!exhausted) chunk = await fetchChunk();
      else return { value: undefined, done: true };
      abortIfNeeded();

      if (chunk.done && chunk.rows.length === 0) {
        exhausted = true;
        return { value: undefined, done: true };
      }
      buffer = chunk.rows;
      bufferIdx = 0;
      exhausted = chunk.done;
      // Kick off prefetch for the chunk after this one, if prefetch > 0
      if (prefetch > 0 && !exhausted && !nextChunk) nextChunk = fetchChunk();
      return { value: buffer[bufferIdx++], done: false };
    }

    async function cleanup() {
      try {
        if (iterId !== null) {
          await db._send({ op: OP.ITER_RETURN, iterId }).catch(() => {});
        }
        // Drain any in-flight prefetch so the worker isn't surprised by
        // a dangling iterId. Discard the result.
        if (nextChunk) { try { await nextChunk; } catch {} nextChunk = null; }
      } finally {
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
        self.#activeIterator = null;
      }
    }

    const wrapper: ActiveIterator<T> = {
      [Symbol.asyncIterator]() { return wrapper; },

      async next() {
        if (finished) return { value: undefined, done: true };
        if (aborted) {
          finished = true;
          await cleanup();
          throw abortErrorFor(signal);
        }
        if (!started) {
          started = true;
          try { await startIter(); }
          catch (err) {
            finished = true;
            if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
            self.#activeIterator = null;
            throw err;
          }
          if (prefetch > 0) nextChunk = fetchChunk();
        }
        try {
          const r = await nextRow();
          if (r.done) {
            finished = true;
            await cleanup();
          }
          return r;
        } catch (err) {
          finished = true;
          await cleanup();
          // If we aborted, return the canonical AbortError regardless
          // of what the worker actually surfaced (libduckdb's
          // "INTERRUPT" message would otherwise leak through).
          if (aborted) throw abortErrorFor(signal);
          throw err;
        }
      },

      async return(value?: unknown) {
        if (finished) return { value, done: true };
        finished = true;
        if (started) await cleanup();
        else {
          if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
          self.#activeIterator = null;
        }
        return { value, done: true };
      },

      async throw(err?: unknown) {
        if (finished) throw err;
        finished = true;
        if (started) await cleanup();
        else {
          if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
          self.#activeIterator = null;
        }
        throw err;
      },
    };

    this.#activeIterator = wrapper;
    return wrapper;
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state !== 'open') return;
    this.#state = 'closing';
    const stmtId = this.#stmtId;
    const db = this.#db;
    this.#closePromise = (async () => {
      if (this.#activeIterator) {
        try { await this.#activeIterator.return(); } catch {}
        this.#activeIterator = null;
      }
      try {
        await db._send({ op: OP.CLOSE, target: { kind: KIND.STMT, id: stmtId } });
      } catch { /* swallow */ }
      this.#state = 'closed';
    })();
    return this.#closePromise;
  }

  [Symbol.dispose]() { this.close().catch(() => {}); }
  [Symbol.asyncDispose]() { return this.close(); }
}

// ==============================================================================
// AsyncAppender
// ==============================================================================

class AsyncAppender {
  #db: AsyncDatabase;
  #appId: number;
  #state: 'open' | 'closing' | 'closed' = 'open';
  #closePromise: Promise<void> | null = null;
  #poisoned: unknown = null;
  #pending: Promise<any> | null = null;            // in-flight appendRows promise
  #buffer: unknown[][] = [];
  #batchSize: number;

  constructor(db: AsyncDatabase, appId: number, opts: { batchSize?: number } = {}) {
    this.#db = db;
    this.#appId = appId;
    // `!` is type-only: `undefined | 0` evaluates to 0 at runtime, which
    // the `|| 1000` then replaces — same result as before.
    this.#batchSize = (opts.batchSize! | 0) || 1000;
  }

  get closed(): boolean { return this.#state !== 'open'; }

  /**
   * Append one row. Sync (matches main-thread API). Buffers locally;
   * batches are sent when the buffer reaches batchSize, or on flush()/
   * close(). Throws synchronously on closed/poisoned state — the proxy
   * cache enforces this without a worker round-trip.
   */
  appendRow(values: unknown[]): void {
    if (this.#state !== 'open') throw new DuckDBClosedError('Appender');
    if (this.#poisoned)        throw this.#poisoned;
    this.#buffer.push(values);
    if (this.#buffer.length >= this.#batchSize) {
      // Schedule the batch send. Don't await — appendRow is sync.
      const batch = this.#buffer;
      this.#buffer = [];
      const sendPromise = this.#db._send({
        op: OP.APP_ROWS, target: { kind: KIND.APP, id: this.#appId },
        rows: batch,
      }).catch(err => { this.#poisoned = err; throw err; });
      // Coalesce: if there's already a pending batch, chain after it.
      this.#pending = this.#pending
        ? this.#pending.then(() => sendPromise)
        : sendPromise;
      this.#pending.catch(() => { /* poisoning is recorded; this catch is here
                                     to prevent unhandled rejection */ });
    }
  }

  async flush(): Promise<AppendResult> {
    if (this.#poisoned)        throw this.#poisoned;
    // 'closing' is allowed — close() calls flush() during teardown.
    // Only 'closed' is too late to drain buffered rows.
    if (this.#state === 'closed') throw new DuckDBClosedError('Appender');
    // Drain in-flight batches first.
    if (this.#pending) { await this.#pending; this.#pending = null; }
    // Send any leftover buffered rows.
    if (this.#buffer.length > 0) {
      const batch = this.#buffer;
      this.#buffer = [];
      try {
        await this.#db._send({
          op: OP.APP_ROWS, target: { kind: KIND.APP, id: this.#appId }, rows: batch,
        });
      } catch (err) { this.#poisoned = err; throw err; }
    }
    // Tell the worker to flush its appender to DuckDB.
    try {
      const r = await this.#db._send({
        op: OP.APP_FLUSH, target: { kind: KIND.APP, id: this.#appId },
      });
      return r;
    } catch (err) { this.#poisoned = err; throw err; }
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state !== 'open') return;
    this.#state = 'closing';
    this.#closePromise = (async () => {
      try { await this.flush(); } catch { /* poisoned/closed; swallow */ }
      try {
        await this.#db._send({
          op: OP.CLOSE, target: { kind: KIND.APP, id: this.#appId },
        });
      } catch { /* swallow */ }
      this.#state = 'closed';
    })();
    return this.#closePromise;
  }

  [Symbol.dispose]() { this.close().catch(() => {}); }
  [Symbol.asyncDispose]() { return this.close(); }
}

// ==============================================================================
// Shared helpers
// ==============================================================================

function clampPrefetch(v: unknown): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return 1;
  if (v < 0) return 0;
  if (v > 4) return 4;
  return v | 0;
}

// Connection.iterate(sql) / Database.iterate(sql) sugar. Lazy-prepare:
// nothing happens until the consumer's first .next(). The temp Statement
// is closed in `finally` regardless of how the iterator terminates.
function iterateThroughConn(target: AsyncConnection, sql: string, params: Params | undefined, opts: IterateOptions | undefined): AsyncIterableIterator<any> {
  return (async function* () {
    const stmt = await target.prepare(sql);
    try {
      for await (const row of stmt.iterate(params, opts)) yield row;
    } finally {
      try { await stmt.close(); } catch { /* swallow */ }
    }
  })();
}

// Same shape for chunk-by-chunk streaming. The async statement
// transport already buffers per-chunk; this just exposes that
// directly to the consumer. Honors opts.signal via the underlying
// iterate path.
function chunksThroughConn(target: AsyncConnection, sql: string, params: Params | undefined, opts: IterateOptions | undefined): AsyncIterableIterator<any> {
  return (async function* () {
    const stmt = await target.prepare(sql);
    try {
      // The Statement iterate() yields rows; to expose chunks we
      // accumulate per-yield rows into a chunk of up to ~2048 rows on
      // the proxy side. Matches DuckDB's natural chunk size and avoids
      // new protocol surface.
      const BUFFER_SIZE = 2048;
      let buf: any[] = [];
      let chunkIndex = 0;
      let rowOffset = 0;
      for await (const row of stmt.iterate(params, opts)) {
        buf.push(row);
        if (buf.length >= BUFFER_SIZE) {
          yield { rows: buf, chunkIndex, rowOffset };
          rowOffset += buf.length;
          chunkIndex++;
          buf = [];
        }
      }
      if (buf.length > 0) yield { rows: buf, chunkIndex, rowOffset };
    } finally {
      try { await stmt.close(); } catch { /* swallow */ }
    }
  })();
}

// PRAGMA + extension helpers via the same identifier validation +
// SQL escaping as the sync driver. We don't add new protocol ops —
// the generated SQL goes through the normal query path.
const ASYNC_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertAsyncIdent(name: string, label: string) {
  if (typeof name !== 'string' || !ASYNC_IDENT_RE.test(name)) {
    throw new DuckDBError(`Invalid ${label}: ${JSON.stringify(name)}`);
  }
}

function quoteAsyncSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DuckDBError(`Cannot bind non-finite number as SQL literal: ${value}`);
    }
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  throw new DuckDBError(`Cannot bind ${typeof value} as SQL literal`);
}

// "Inline" variants take a sender callback (method, sql) → Promise so
// they can run inside an AsyncConnection's #runSerial without
// recursively entering the serialization chain. AsyncConnection
// passes #sender() bound to its connId.
async function execPragmaInline(send: InlineSender, name: string, value: unknown, isGet: boolean) {
  assertAsyncIdent(name, 'PRAGMA name');
  const sql = isGet ? `PRAGMA ${name}` : `PRAGMA ${name}=${quoteAsyncSqlLiteral(value)}`;
  const rows = await send('all', sql);
  return rows.length > 0 ? rows[0] : undefined;
}

async function execExtensionInline(send: InlineSender, kind: string /* 'INSTALL' | 'LOAD' */, name: string) {
  assertAsyncIdent(name, 'extension name');
  await send('exec', `${kind} ${name}`);
}

async function execCheckpointInline(send: InlineSender, opts: CheckpointOptions | undefined) {
  const force = opts && opts.force === true;
  let sql = force ? 'FORCE CHECKPOINT' : 'CHECKPOINT';
  if (opts && opts.database !== undefined) {
    assertAsyncIdent(opts.database, 'database name');
    sql += ` ${opts.database}`;
  }
  await send('exec', sql);
}

// Shared transaction runner. `txnTarget` is the DbOrConn the user
// called `.transaction()` on. We allocate a fresh worker-side
// Connection for the transaction's lifetime, hand the user a proxy
// for it, and emit commit/rollback based on the callback's outcome.
async function runTransaction(db: AsyncDatabase, txnTarget: any, fn: (tx: AsyncConnection) => Promise<any>): Promise<any> {
  const res = await db._send({ op: OP.TXN_BEGIN, target: txnTarget });
  const { connId } = res;
  // Cache the txn conn's interrupt capability so AbortSignal can
  // cancel sub-ops running inside the transaction (v0.7+).
  if (res.interruptHandle !== undefined) {
    db._interruptHandles.set(connId, {
      ptr: res.interruptHandle,
      generation: res.interruptGeneration,
    });
  }
  const txConn = new AsyncConnection(db, connId, /* isTxnConn */ true);
  let result;
  try {
    result = await fn(txConn);
  } catch (err) {
    await db._send({ op: OP.TXN_ROLLBACK, target: { kind: KIND.CONN, id: connId } })
      .catch(() => {});
    await txConn.close().catch(() => {});
    throw err;
  }
  await db._send({ op: OP.TXN_COMMIT, target: { kind: KIND.CONN, id: connId } });
  await txConn.close().catch(() => {});
  return result;
}

// ==============================================================================
// Public API
// ==============================================================================

/**
 * Open (or create) a DuckDB database via the worker subpath. Sync
 * (returns a proxy; worker spawn + duckdb_open happen lazily on
 * first awaited op).
 *
 * @param {string} path - file path, or ':memory:' for in-memory
 * @param {object} [opts] - same shape as the main-thread `open(path, opts)`:
 *   readOnly, accessMode, threads, memoryLimit, tempDirectory, config.
 *   See the sync `open()` docs in lib/duckdb.ts.
 */
export function open(path: string, opts?: OpenOptions): AsyncDatabase {
  return new AsyncDatabase(path, opts);
}

export { AsyncDatabase, AsyncConnection, AsyncStatement, AsyncAppender };

// `version()` mirrors the main-thread API. The libduckdb version lives
// in the worker; we cache it lazily after the first round-trip.
// For simplicity (and because async-version requires the worker to be
// alive), the sync main-thread version() is preferred — but we expose
// an async one here for parity.
export async function version(): Promise<string> {
  // Use a transient AsyncDatabase to fetch the version from the worker.
  // For ergonomics we just delegate to the main-thread driver which
  // already does a sync FFI call.
  const m = await import('../duckdb.ts');
  return m.version();
}
