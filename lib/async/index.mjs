// Main-thread entry for duckdb-bun/async.
//
// Spawns a single Worker per Database; mints monotonic numeric IDs for
// every Database / Connection / Statement / Appender; routes every
// public API call through one `postMessage` to the Worker and resolves
// when the response arrives. The Worker (lib/async/worker.mjs) holds
// the actual DuckDB handles; this side holds only IDs.
//
// See docs/rfcs/0001-worker-async-api.md for the design contract and
// lib/async/protocol.d.ts for the wire shapes.

import {
  DuckDBError,
  DuckDBClosedError,
  DuckDBPrepareError,
  DuckDBTransactionError,
  DuckDBWorkerCrashedError,
  reconstructError,
  OP,
  KIND,
  WORKER_READY,
} from './protocol.mjs';

export {
  DuckDBError,
  DuckDBClosedError,
  DuckDBPrepareError,
  DuckDBTransactionError,
  DuckDBWorkerCrashedError,
};

// Re-export the DUCKDB_TYPE constant from the main-thread driver so
// users of the async subpath get the same type-code mapping for
// introspecting result.columns.
export { DUCKDB_TYPE } from '../duckdb.mjs';

// ==============================================================================
// AsyncDatabase
// ==============================================================================

class AsyncDatabase {
  #path;
  #opts;
  #worker = null;
  #state = 'pre-open';          // 'pre-open' | 'opening' | 'open' | 'closing' | 'closed' | 'crashed'
  #dbId = null;
  #nextRequestId = 1;
  #pending = new Map();         // id → { resolve, reject }
  #ready = false;
  #preReadyQueue = [];          // requests sent before the worker's ready handshake
  #openPromise = null;
  #openFailed = null;           // cached error after a failed open
  #closePromise = null;
  #crashError = null;
  #defaultConn = null;          // lazy implicit Connection (mirrors v0.3 surface)
  // Forward-compat for AbortSignal cancellation (no functional use today).
  // The worker returns the raw duckdb_connection handle on each
  // `connect` / `txnBegin` response; we cache it here as an "interrupt
  // capability" so a future minor release can dlopen duckdb_interrupt
  // on the main thread and abort an in-flight query while the worker
  // is blocked in FFI. Architecture proven by spike — see
  // docs/rfcs/0001-worker-async-api.md §16 #5.
  _interruptHandles = new Map(); // connId → { ptr: bigint, generation: number }

  constructor(path, opts) {
    this.#path = path;
    this.#opts = opts;
    this.#spawnWorker();
  }

  #spawnWorker() {
    try {
      const url = new URL('./worker.mjs', import.meta.url);
      this.#worker = new Worker(url.href);
    } catch (err) {
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
      this.#worker.addEventListener('messageerror', (e) => {
        this.#onCrash(`messageerror: ${e?.message || ''}`);
      });
    }
  }

  #onMessage(data) {
    if (data && data.type === WORKER_READY) {
      this.#ready = true;
      // Flush queued messages
      for (const req of this.#preReadyQueue) this.#worker.postMessage(req);
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

  #onCrash(message) {
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

  // Send a request and return a Promise for its response. The proxy
  // queues until the worker's ready handshake arrives so the user can
  // call methods immediately after open() returns.
  //
  // Check `#openFailed` BEFORE `#state === 'crashed'` because a failed
  // open also sets state to 'crashed' (so subsequent ops are sticky),
  // but the meaningful error to surface is the original open failure,
  // not a generic crash error.
  _send(req) {
    if (this.#openFailed)          return Promise.reject(this.#openFailed);
    if (this.#state === 'crashed') return Promise.reject(this.#crashError || new DuckDBWorkerCrashedError('Worker crashed'));
    if (this.#state === 'closed')  return Promise.reject(new DuckDBClosedError('Database'));

    const id = this.#nextRequestId++;
    const message = { ...req, id };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      if (this.#ready) {
        try { this.#worker.postMessage(message); }
        catch (err) {
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
  async #ensureOpen() {
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
  get id() { return this.#dbId; }
  get _state() { return this.#state; }

  /** Sync — returns an AsyncConnection proxy. The actual duckdb_connect happens lazily. */
  connect() {
    return new AsyncConnection(this);
  }

  async query(sql, params) {
    await this.#ensureOpen();
    return this._send({
      op: OP.QUERY, target: { kind: KIND.DB, id: this.#dbId },
      method: 'query', sql, params,
    });
  }
  async all(sql, params) {
    await this.#ensureOpen();
    return this._send({
      op: OP.QUERY, target: { kind: KIND.DB, id: this.#dbId },
      method: 'all', sql, params,
    });
  }
  async get(sql, params) {
    await this.#ensureOpen();
    return this._send({
      op: OP.QUERY, target: { kind: KIND.DB, id: this.#dbId },
      method: 'get', sql, params,
    });
  }
  async run(sql, params) {
    await this.#ensureOpen();
    return this._send({
      op: OP.QUERY, target: { kind: KIND.DB, id: this.#dbId },
      method: 'run', sql, params,
    });
  }
  async exec(sql) {
    await this.#ensureOpen();
    return this._send({
      op: OP.QUERY, target: { kind: KIND.DB, id: this.#dbId },
      method: 'exec', sql,
    });
  }

  async prepare(sql) {
    await this.#ensureOpen();
    const { stmtId } = await this._send({
      op: OP.PREPARE, target: { kind: KIND.DB, id: this.#dbId }, sql,
    });
    return new AsyncStatement(this, stmtId);
  }

  iterate(sql, params, opts) {
    return iterateThroughConn(this, sql, params, opts);
  }

  chunks(sql, params) {
    return chunksThroughConn(this, sql, params);
  }

  async pragma(name, value) {
    await this.#ensureOpen();
    // Pragma is just sugar over query — we generate the SQL on the
    // main thread (with the same validation as the sync driver) and
    // send it through. Keeps the protocol simple (no new op needed).
    return execPragma(this, name, arguments.length < 2 ? undefined : value, arguments.length < 2);
  }

  async installExtension(name) {
    await this.#ensureOpen();
    return execExtension(this, 'INSTALL', name);
  }

  async loadExtension(name) {
    await this.#ensureOpen();
    return execExtension(this, 'LOAD', name);
  }

  async checkpoint(opts) {
    await this.#ensureOpen();
    return execCheckpoint(this, opts);
  }

  async transaction(fn) {
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
  async close(opts) {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state === 'closed' || this.#state === 'crashed') {
      this.#state = 'closed';
      return;
    }
    const timeout = opts && typeof opts.timeout === 'number' ? opts.timeout : undefined;

    this.#closePromise = (async () => {
      const wasOpen = this.#state === 'open' && this.#dbId !== null;
      this.#state = 'closing';

      let closeTask;
      if (wasOpen) {
        closeTask = this._send({
          op: OP.CLOSE, target: { kind: KIND.DB, id: this.#dbId },
        }).catch(() => { /* worker may die during close — that's fine */ });
      } else {
        closeTask = Promise.resolve();
      }

      if (typeof timeout === 'number') {
        let timer;
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
      // Forward-compat: clear all interrupt handles. v0.5 abort listeners
      // that fire after close should see no handle and bail.
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
  #db;
  #connId = null;
  #connectPromise = null;
  #state = 'pre-open';     // 'pre-open' | 'opening' | 'open' | 'closing' | 'closed'
  #closePromise = null;
  #inTransaction = false;

  constructor(db, /** optional pre-allocated connId (used by transaction) */ preConnId = null,
              /** mark this conn as already inside a transaction (used by runTransaction's txConn) */
              isTxnConn = false) {
    this.#db = db;
    if (preConnId !== null) {
      this.#connId = preConnId;
      this.#state = 'open';
    }
    if (isTxnConn) this.#inTransaction = true;
  }

  get id() { return this.#connId; }
  get _state() { return this.#state; }

  async #ensureOpen() {
    if (this.#state === 'open')    return;
    if (this.#state === 'closed')  throw new DuckDBClosedError('Connection');
    if (this.#state === 'closing') throw new DuckDBClosedError('Connection');
    if (this.#connectPromise)      return this.#connectPromise;

    this.#state = 'opening';
    this.#connectPromise = (async () => {
      try {
        // ensure the underlying DB is open first
        // (We call a no-op method that triggers AsyncDatabase.#ensureOpen.)
        await this.#db.exec('SELECT 1').catch(() => { /* may fail if db crashed */ });
        const res = await this.#db._send({
          op: OP.CONNECT, target: { kind: KIND.DB, id: this.#db.id },
        });
        this.#connId = res.connId;
        // Forward-compat for AbortSignal cancellation: store the
        // interrupt handle if the worker sent one. Ignored today; a
        // future minor release will use it to call duckdb_interrupt
        // from the main thread on AbortSignal.abort.
        if (res.interruptHandle !== undefined) {
          this.#db._interruptHandles.set(res.connId, {
            ptr: res.interruptHandle,
            generation: res.interruptGeneration,
          });
        }
        this.#state = 'open';
      } catch (err) {
        this.#state = 'closed';
        throw err;
      } finally {
        this.#connectPromise = null;
      }
    })();
    return this.#connectPromise;
  }

  async #queryOp(method, sql, params) {
    await this.#ensureOpen();
    return this.#db._send({
      op: OP.QUERY, target: { kind: KIND.CONN, id: this.#connId },
      method, sql, params,
    });
  }

  query(sql, params) { return this.#queryOp('query', sql, params); }
  all(sql, params)   { return this.#queryOp('all',   sql, params); }
  get(sql, params)   { return this.#queryOp('get',   sql, params); }
  run(sql, params)   { return this.#queryOp('run',   sql, params); }
  exec(sql)          { return this.#queryOp('exec',  sql); }

  async prepare(sql) {
    await this.#ensureOpen();
    const { stmtId } = await this.#db._send({
      op: OP.PREPARE, target: { kind: KIND.CONN, id: this.#connId }, sql,
    });
    return new AsyncStatement(this.#db, stmtId, this);
  }

  iterate(sql, params, opts) {
    return iterateThroughConn(this, sql, params, opts);
  }

  chunks(sql, params) {
    return chunksThroughConn(this, sql, params);
  }

  async pragma(name, value) {
    await this.#ensureOpen();
    return execPragma(this, name, arguments.length < 2 ? undefined : value, arguments.length < 2);
  }

  async installExtension(name) {
    await this.#ensureOpen();
    return execExtension(this, 'INSTALL', name);
  }

  async loadExtension(name) {
    await this.#ensureOpen();
    return execExtension(this, 'LOAD', name);
  }

  async checkpoint(opts) {
    await this.#ensureOpen();
    return execCheckpoint(this, opts);
  }

  /** Bulk insert via the Appender API. Returns an AsyncAppender proxy. */
  async append(table, columns, rows) {
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

  async transaction(fn) {
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

  async close() {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state === 'closed') return;
    const wasOpen = this.#state === 'open' && this.#connId !== null;
    this.#state = 'closing';
    this.#closePromise = (async () => {
      if (wasOpen) {
        try {
          await this.#db._send({
            op: OP.CLOSE, target: { kind: KIND.CONN, id: this.#connId },
          });
        } catch { /* swallow */ }
      }
      // Forward-compat: drop the interrupt-capability entry so a v0.5
      // late abort listener can't fire duckdb_interrupt on a freed
      // connection. The generation token in the entry would already
      // make this safe, but explicit removal is one fewer surface.
      if (this.#connId !== null) {
        this.#db._interruptHandles.delete(this.#connId);
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

class AsyncStatement {
  #db;
  #stmtId;
  #conn;                    // owning AsyncConnection (or null if owned by db's implicit)
  #state = 'open';          // 'open' | 'closing' | 'closed'
  #closePromise = null;
  #activeIterator = null;

  constructor(db, stmtId, conn = null) {
    this.#db = db;
    this.#stmtId = stmtId;
    this.#conn = conn;
  }

  get id() { return this.#stmtId; }
  get closed() { return this.#state !== 'open'; }

  async all(params) {
    if (this.#state !== 'open') throw new DuckDBClosedError('Statement');
    if (this.#activeIterator) throw new DuckDBError('Statement is iterating; consume or close the iterator first');
    return this.#db._send({
      op: OP.STMT_CALL, target: { kind: KIND.STMT, id: this.#stmtId },
      method: 'all', params,
    });
  }

  async get(params) {
    if (this.#state !== 'open') throw new DuckDBClosedError('Statement');
    if (this.#activeIterator) throw new DuckDBError('Statement is iterating; consume or close the iterator first');
    return this.#db._send({
      op: OP.STMT_CALL, target: { kind: KIND.STMT, id: this.#stmtId },
      method: 'get', params,
    });
  }

  async run(params) {
    if (this.#state !== 'open') throw new DuckDBClosedError('Statement');
    if (this.#activeIterator) throw new DuckDBError('Statement is iterating; consume or close the iterator first');
    return this.#db._send({
      op: OP.STMT_CALL, target: { kind: KIND.STMT, id: this.#stmtId },
      method: 'run', params,
    });
  }

  /**
   * Stream rows from a prepared statement. Pull-based per-chunk.
   *
   * Options:
   *   - prefetch: number of chunks the worker keeps ready ahead of the
   *     consumer. Default: 1. Range: [0, 4]. prefetch=0 is strict pull
   *     (no overlap between drain + fetch).
   */
  iterate(params, opts) {
    if (this.#state !== 'open') throw new DuckDBClosedError('Statement');
    if (this.#activeIterator) throw new DuckDBError('Statement is already iterating');

    const prefetch = clampPrefetch(opts && opts.prefetch);
    const self = this;
    const db = this.#db;
    const stmtId = this.#stmtId;

    let iterId = null;
    let started  = false;
    let finished = false;
    let buffer = [];
    let bufferIdx = 0;
    let exhausted = false;
    let nextChunk = null;     // in-flight prefetch promise

    async function startIter() {
      const res = await db._send({
        op: OP.ITER_START, target: { kind: KIND.STMT, id: stmtId }, params,
      });
      iterId = res.iterId;
    }

    function fetchChunk() {
      return db._send({ op: OP.ITER_NEXT, iterId });
    }

    async function nextRow() {
      // Drain local buffer first
      if (bufferIdx < buffer.length) return { value: buffer[bufferIdx++], done: false };
      // Buffer empty. If we have a prefetch in flight, await it. Else fetch now.
      let chunk;
      if (nextChunk) { chunk = await nextChunk; nextChunk = null; }
      else if (!exhausted) chunk = await fetchChunk();
      else return { value: undefined, done: true };

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
        self.#activeIterator = null;
      }
    }

    const wrapper = {
      [Symbol.asyncIterator]() { return wrapper; },

      async next() {
        if (finished) return { value: undefined, done: true };
        if (!started) {
          started = true;
          try { await startIter(); }
          catch (err) { finished = true; self.#activeIterator = null; throw err; }
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
          throw err;
        }
      },

      async return(value) {
        if (finished) return { value, done: true };
        finished = true;
        if (started) await cleanup();
        else self.#activeIterator = null;
        return { value, done: true };
      },

      async throw(err) {
        if (finished) throw err;
        finished = true;
        if (started) await cleanup();
        else self.#activeIterator = null;
        throw err;
      },
    };

    this.#activeIterator = wrapper;
    return wrapper;
  }

  async close() {
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
  #db;
  #appId;
  #state = 'open';
  #closePromise = null;
  #poisoned = null;
  #pending = null;            // in-flight appendRows promise
  #buffer = [];
  #batchSize;

  constructor(db, appId, opts = {}) {
    this.#db = db;
    this.#appId = appId;
    this.#batchSize = (opts.batchSize | 0) || 1000;
  }

  get closed() { return this.#state !== 'open'; }

  /**
   * Append one row. Sync (matches main-thread API). Buffers locally;
   * batches are sent when the buffer reaches batchSize, or on flush()/
   * close(). Throws synchronously on closed/poisoned state — the proxy
   * cache enforces this without a worker round-trip.
   */
  appendRow(values) {
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

  async flush() {
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

  async close() {
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

function clampPrefetch(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return 1;
  if (v < 0) return 0;
  if (v > 4) return 4;
  return v | 0;
}

// Connection.iterate(sql) / Database.iterate(sql) sugar. Lazy-prepare:
// nothing happens until the consumer's first .next(). The temp Statement
// is closed in `finally` regardless of how the iterator terminates.
function iterateThroughConn(target, sql, params, opts) {
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
// directly to the consumer.
function chunksThroughConn(target, sql, params) {
  return (async function* () {
    const stmt = await target.prepare(sql);
    try {
      // The Statement iterate() yields rows; to expose chunks we'd
      // need to thread a chunk-mode flag through to the worker. For
      // v0.5 simplicity, accumulate per-yield rows into a chunk of
      // up to ~2048 rows on the proxy side. This matches DuckDB's
      // natural chunk size and avoids new protocol surface.
      const BUFFER_SIZE = 2048;
      let buf = [];
      let chunkIndex = 0;
      let rowOffset = 0;
      for await (const row of stmt.iterate(params)) {
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

function assertAsyncIdent(name, label) {
  if (typeof name !== 'string' || !ASYNC_IDENT_RE.test(name)) {
    throw new DuckDBError(`Invalid ${label}: ${JSON.stringify(name)}`);
  }
}

function quoteAsyncSqlLiteral(value) {
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

async function execPragma(target, name, value, isGet) {
  assertAsyncIdent(name, 'PRAGMA name');
  const sql = isGet ? `PRAGMA ${name}` : `PRAGMA ${name}=${quoteAsyncSqlLiteral(value)}`;
  const rows = await target.all(sql);
  return rows.length > 0 ? rows[0] : undefined;
}

async function execExtension(target, kind /* 'INSTALL' | 'LOAD' */, name) {
  assertAsyncIdent(name, 'extension name');
  await target.exec(`${kind} ${name}`);
}

async function execCheckpoint(target, opts) {
  const force = opts && opts.force === true;
  let sql = force ? 'FORCE CHECKPOINT' : 'CHECKPOINT';
  if (opts && opts.database !== undefined) {
    assertAsyncIdent(opts.database, 'database name');
    sql += ` ${opts.database}`;
  }
  await target.exec(sql);
}

// Shared transaction runner. `txnTarget` is the DbOrConn the user
// called `.transaction()` on. We allocate a fresh worker-side
// Connection for the transaction's lifetime, hand the user a proxy
// for it, and emit commit/rollback based on the callback's outcome.
async function runTransaction(db, txnTarget, fn) {
  const res = await db._send({ op: OP.TXN_BEGIN, target: txnTarget });
  const { connId } = res;
  // Forward-compat: cache the txn conn's interrupt handle for v0.5
  // (transaction-level AbortSignal will interrupt the txn's sub-ops).
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
 *   See the sync `open()` docs in lib/duckdb.mjs.
 */
export function open(path, opts) {
  return new AsyncDatabase(path, opts);
}

export { AsyncDatabase, AsyncConnection, AsyncStatement, AsyncAppender };

// `version()` mirrors the main-thread API. The libduckdb version lives
// in the worker; we cache it lazily after the first round-trip.
// For simplicity (and because async-version requires the worker to be
// alive), the sync main-thread version() is preferred — but we expose
// an async one here for parity.
export async function version() {
  // Use a transient AsyncDatabase to fetch the version from the worker.
  // For ergonomics we just delegate to the main-thread driver which
  // already does a sync FFI call.
  const m = await import('../duckdb.mjs');
  return m.version();
}
