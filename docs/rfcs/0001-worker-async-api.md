# RFC-0001 · `duckdb-bun/async` — Worker-backed subpath

| Field | Value |
|---|---|
| Status | **Implemented in v0.4.0** (shipped 2026-05-15). Preserved here as a design archive. |
| Target release | v0.4.0 |
| Drafted | 2026-05-15 |
| Reviewed | 2026-05-15 (Anthropic Opus 4.7 via `mcp/user-ai/discuss`; load-balanced from a GPT-5.5 conversation) |
| Prerequisites | v0.3.0 shipped (`Statement.iterate()` semantics frozen) |

### Why this RFC still exists

The `duckdb-bun/async` subpath has shipped — most of the
implementation TODOs below are historical. The document is preserved
as a design archive: future maintainers reading
`lib/async/{index,worker,protocol}.mjs` can trace back to the
decisions and trade-offs that produced the current shape.

The one section that is still actively useful is **§16 #5
(cancellation)** — the spike findings and architecture there describe
the path for the planned v0.6 `AbortSignal` work. The rest of the
document is for context.

### Changelog of this RFC

- **v1 (initial draft):** consolidated the original async-subpath
  plan with light edits.
- **v2 (post-review):** added `release` op for GC notification (§6),
  ready handshake before request queue drains (§11), prefetch
  semantics for streaming with fresh-array-per-response guarantee
  (§8), cancellation deferred-to-future-minor with rationale (§16),
  shared error-class registry (§6), `close({ timeout })` (§11),
  lifecycle cascade rules in worker registry (new §4.2),
  multiple-Databases-multiple-Workers doc, transaction-callback
  runs-on-main-thread doc.

---

## §1 · Motivation

`duckdb-bun` v0.3 is fully synchronous at the FFI boundary. Every
`db.query(sql)` / `for await (row of db.iterate(sql))` runs DuckDB on
Bun's main event-loop thread. A 30-second analytical aggregation locks
the loop for 30 seconds — `Bun.serve` requests pile up, scheduled
timers fire late, animations on the renderer (if any) stall.

For HTTP-server and interactive workloads, that's a deal-breaker.

The proposed `duckdb-bun/async` subpath gives users the **same API
surface** as the main thread driver, but runs DuckDB inside a `Worker`.
The main event loop stays responsive; queries arrive over a
`postMessage` protocol, results come back the same way.

Non-goal: parallelism *within* DuckDB. DuckDB's own parallelism (query
planner workers) is unchanged. This RFC moves the entire DuckDB stack
off the main thread, period.

---

## §2 · Goals (v0.4.0)

1. **`import { open } from 'duckdb-bun/async'`** with the same
   surface as `duckdb-bun`: `Database`, `Connection`, `Statement`,
   `Appender`, plus `iterate()` streaming.
2. **No main-thread DuckDB FFI** — every libduckdb call happens inside
   the Worker.
3. **Workable smoke test** that proves event-loop responsiveness
   improves measurably for long queries.
4. **Honest documentation** of small-query latency cost (workers add
   overhead).

## §3 · Non-goals (v0.4.0)

- Worker pooling. One Worker per `Database`. Pool is premature
  optimization; revisit only if v0.4.x users hit the limits.
- Transferable / SharedArrayBuffer optimization for result transport.
  Use structured-clone via `postMessage`; benchmark first, optimize
  only if needed.
- `AbortSignal` support. Deferred to v0.5+. (`duckdb_interrupt()` is
  the right tool; we need a clean cancellation story across
  iterators + multi-statement transactions, which is more design.)
- Browser support. Bun-only for now. The protocol is portable, but
  the package keeps its Bun-only contract.

---

## §4 · Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ Main thread (consumer)                                         │
│                                                                │
│   import { open } from 'duckdb-bun/async';                     │
│   await using db = open(':memory:');                           │
│                                                                │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│   │  AsyncDb     │  │ AsyncConn    │  │ AsyncStmt    │         │
│   │  (proxy)     │  │ (proxy)      │  │ (proxy)      │         │
│   │ ID only      │  │ ID only      │  │ ID only      │         │
│   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘         │
│          │   structured-clone postMessage    │                 │
└──────────┼──────────────────────────────────-┼─────────────────┘
           │                                   │
           ▼                                   ▼
┌────────────────────────────────────────────────────────────────┐
│ Worker thread (lib/async/worker.mjs)                           │
│                                                                │
│   Re-uses the v0.3 main-thread driver wholesale:               │
│   import { open as openSync } from '../duckdb.mjs';            │
│                                                                │
│   ┌──────────────┐                                             │
│   │ Registry      │ {dbId,connId,stmtId,appId} → live handle   │
│   │ (Map)         │                                            │
│   └──────────────┘                                             │
│                                                                │
│   Dispatcher: incoming Request → execute against handle →      │
│                serialize Response → postMessage back            │
│                                                                │
│   ┌──────────────────────────────────────────────────────────┐ │
│   │  lib/duckdb.mjs (the actual v0.3 driver, unchanged)      │ │
│   └──────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

### Why this shape

- **No FFI handles cross the worker boundary.** Bun's structured-clone
  is well-defined for plain JS values; opaque FFI handles aren't. The
  main thread only sees numeric IDs.
- **Worker reuses the v0.3 driver verbatim.** No second implementation
  of FFI declarations, type decoding, locking, etc. The async path is
  a *transport*, not a fork.
- **Symmetry with main-thread API.** A library that imports the sync
  subpath in one file and the async subpath in another should see the
  same method names and shapes. The only difference: `close()` is
  async on async, `Symbol.asyncDispose` is preferred over `dispose`,
  etc. (and v0.3 already moved the main-thread driver in this
  direction.)

### Subpath layout

| File | Role |
|---|---|
| `lib/async/index.mjs` | Main-thread entry. `open(path, opts?)` returns an `AsyncDatabase` proxy. Re-exports the same `DuckDBError` etc. classes. |
| `lib/async/worker.mjs` | Worker entry. Imports `../duckdb.mjs`, holds the handle registry, dispatches requests. Top-level: `self.onmessage = (e) => dispatch(e.data)`. |
| `lib/async/protocol.mjs` | Runtime constants and helpers (e.g. `OP.QUERY = 'query'`). No type-only declarations here — this package ships source directly. |
| `lib/async/protocol.d.ts` | TypeScript type declarations for `Request`, `Response`, `Target`, etc. |

`package.json` `exports` map:

```json
{
  "exports": {
    ".": { /* main */ },
    "./async": {
      "types": "./lib/async/index.d.ts",
      "default": "./lib/async/index.mjs"
    }
  },
  "files": [
    "lib/async/",
    /* existing entries */
  ]
}
```

### §4.2 · Lifecycle cascade in the worker registry

The worker's registry enforces parent → child ownership exactly like
the main-thread v0.3 driver. Closing a parent cascades:

| Parent close | Cascades to (in order) |
|---|---|
| `dbClose` | child `Connection`s → their `Statement`s + `Appender`s → their active iterators → finally `duckdb_close` |
| `connClose` | child `Statement`s + `Appender`s → their active iterators → finally `duckdb_disconnect` |
| `stmtClose` | active iterator (via `iter.return()`) → finally `duckdb_destroy_prepare` |
| `appenderClose` | flush pending → `duckdb_appender_close` + `_destroy` |

Each cascade level reuses the v0.3 main-thread close protocol
(cancel iterator first, then destroy under the connection lock).
There is no second implementation of the close semantics in the
worker — it just calls into the v0.3 driver's `close()` methods,
which already cascade correctly.

### §4.3 · Multiple Databases in one process

**One Worker per Database.** Each `open()` spawns a fresh Worker.
N `Databases` = N Workers = N OS threads of overhead. That's fine
for typical applications (1–3 Databases), inappropriate for use
cases where someone is creating Databases per HTTP request — but
that's the wrong pattern anyway, and we document it as such.

If a future use case warrants a shared Worker pool, that's v0.5+
work. Don't pessimize the common case for a hypothetical.

---

## §5 · Public API

### Imports

```ts
import {
  open,
  version,
  DuckDBError, DuckDBClosedError, DuckDBPrepareError,
  DuckDBTransactionError, DuckDBWorkerCrashedError,
  type Row, type QueryResult, type AsyncDatabase,
  type AsyncConnection, type AsyncStatement,
} from 'duckdb-bun/async';
```

### Mirrored surface

Every method on `duckdb-bun`'s `Database`/`Connection`/`Statement` has
an `async`-typed counterpart on the async classes. The signatures are
otherwise identical:

| Main-thread | Async-subpath equivalent |
|---|---|
| `db.query(sql, params?)` | `db.query(sql, params?)` |
| `db.all/get/run/exec` | (same) |
| `db.prepare(sql)` | `db.prepare(sql)` returns `Promise<AsyncStatement>` |
| `db.iterate(sql, params?)` | `db.iterate(sql, params?)` returns `AsyncIterableIterator<Row>` |
| `db.connect()` | `db.connect()` returns `AsyncConnection` |
| `db.transaction(fn)` | `db.transaction(fn)` — `fn` receives an `AsyncConnection` |
| `db.close()` | `db.close()` — also tears down the worker |
| `db[Symbol.asyncDispose]` | (same; preferred over `Symbol.dispose`) |

`open(path, opts?)` is **synchronous on the main thread** — it returns
a proxy immediately. The Worker is spawned and `duckdb_open` runs on
first awaited operation. If open fails, that first awaited operation
rejects with the (reconstructed) DuckDB error and the proxy enters
"permanently failed" state.

```js
import { open } from 'duckdb-bun/async';
const db = open('/path/that/does/not/exist.duckdb');  // sync; no error yet
await db.exec('SELECT 1');                            // rejects here
```

Rationale: matches the main-thread API shape (where `open()` is also
sync). Initialization errors surface at first use, not at construction.

### Disposal

| Trigger | Behavior |
|---|---|
| `await using db = open(...)` (`Symbol.asyncDispose`) | Wait for in-flight ops, close all child handles, terminate Worker. |
| `await db.close()` | Same as above. Explicit. Idempotent. |
| `using db = open(...)` (`Symbol.dispose`, sync fallback) | Fire-and-forget close, then `worker.terminate()`. Documented as best-effort; **streaming code should use `await using`**. |
| Worker crash | All pending request Promises reject with `DuckDBWorkerCrashedError`. Future calls reject with `DuckDBClosedError`. No Promise hangs. |

---

## §6 · Wire protocol

Place TypeScript types in `lib/async/protocol.d.ts`; place runtime
helpers (the `OP` enum constants, etc.) in `lib/async/protocol.mjs`.
This package ships source directly with no transpile step — `export
type` in `.mjs` would not parse under stricter loaders.

### Request

```ts
// lib/async/protocol.d.ts
import type { OpenOptions, BindParam } from 'duckdb-bun';

export type Target =
  | { kind: 'db';   id: number }
  | { kind: 'conn'; id: number }
  | { kind: 'stmt'; id: number }
  | { kind: 'app';  id: number };

export type DbTarget   = Extract<Target, { kind: 'db' }>;
export type ConnTarget = Extract<Target, { kind: 'conn' }>;
export type StmtTarget = Extract<Target, { kind: 'stmt' }>;
export type AppTarget  = Extract<Target, { kind: 'app' }>;

export type DbOrConn = DbTarget | ConnTarget;

export type Request =
  // ── lifecycle ─────────────────────────────────────────────────────
  | { id: number; op: 'open';         path: string; opts?: OpenOptions }
  | { id: number; op: 'close';        target: Target }
  // ── GC notification (fire-and-forget; no response expected) ───────
  // Sent when a proxy is collected without explicit close. Best-effort:
  // the main thread MUST NOT rely on this for correctness (GC isn't
  // guaranteed), but the worker uses it to release any handles the
  // user forgot to close, preventing slow leaks.
  | { id: number; op: 'release';      target: Target }
  // ── connections ───────────────────────────────────────────────────
  | { id: number; op: 'connect';      target: DbTarget }
  // ── one-shot queries (mirror Database/Connection methods) ─────────
  | { id: number; op: 'query';        target: DbOrConn;
                                      method: 'query'|'all'|'get'|'run'|'exec';
                                      sql: string; params?: BindParam[] }
  // ── prepared statements ───────────────────────────────────────────
  | { id: number; op: 'prepare';      target: DbOrConn; sql: string }
  | { id: number; op: 'stmtCall';     target: StmtTarget;
                                      method: 'all'|'get'|'run'; params?: BindParam[] }
  // ── streaming (pull-based; no unsolicited pushes) ─────────────────
  | { id: number; op: 'iterStart';    target: StmtTarget; params?: BindParam[] }
  | { id: number; op: 'iterNext';     iterId: number }
  | { id: number; op: 'iterReturn';   iterId: number }
  // ── appender ──────────────────────────────────────────────────────
  | { id: number; op: 'appendCreate'; target: DbOrConn; table: string }
  | { id: number; op: 'appendRows';   target: AppTarget; rows: unknown[][] }
  | { id: number; op: 'appendFlush';  target: AppTarget }
  // ── transactions (see §7) ─────────────────────────────────────────
  | { id: number; op: 'txnBegin';     target: DbOrConn }
  | { id: number; op: 'txnCommit';    target: ConnTarget }
  | { id: number; op: 'txnRollback';  target: ConnTarget };

export type Response =
  | { id: number; ok: true;  value: unknown }
  | { id: number; ok: false; error: SerializedError };

export interface SerializedError {
  name: string;       // 'DuckDBClosedError' etc. — used to reconstruct subclass
  message: string;
  stack?: string;     // best-effort: worker's stack as a string, prefixed with
                      // "[worker]" so it's distinguishable from main-thread frames
  code?: string;      // DuckDB-specific error code if surfaced (currently unused;
                      // reserved for when duckdb_result_error_type() lands)
  cause?: SerializedError;  // recurses for chained errors
}
```

### Shared error-class registry

Both the main thread and the worker import a single source of truth
for which DuckDB error subclasses are known:

```js
// lib/async/protocol.mjs
import {
  DuckDBError, DuckDBClosedError, DuckDBPrepareError,
  DuckDBTransactionError,
} from '../duckdb.mjs';

export class DuckDBWorkerCrashedError extends DuckDBError {
  constructor(message) { super(message); this.name = 'DuckDBWorkerCrashedError'; }
}

export const ERROR_CLASSES = Object.freeze({
  DuckDBError,
  DuckDBClosedError,
  DuckDBPrepareError,
  DuckDBTransactionError,
  DuckDBWorkerCrashedError,
});
```

The main-thread proxy's `_reconstructError(serialized)` looks up
`ERROR_CLASSES[serialized.name]`; missing entries fall through to
`DuckDBError` (so a new class added to `lib/duckdb.mjs` without
registering here still propagates *as a DuckDB error*, just without
its specific subclass).

**CI guard:** add a test in `test/async/errors.test.mjs` that
imports every export from `lib/duckdb.mjs` matching
`/^DuckDB.*Error$/` and asserts each one is present in
`ERROR_CLASSES`. New error classes that fail to register break this
test loudly.

### Rules

1. **Every request has a unique numeric `id`** (monotonic `uint53`
   starting at 1, minted by the proxy, never reused within a Database's
   lifetime). Response references it. At 100k req/s the counter lasts
   ~3000 years; overflow is not handled.
2. **postMessage ordering is preserved.** The HTML spec (and Bun)
   guarantees in-order delivery on a single MessagePort, so two
   non-awaited proxy ops on the same connId still serialize at the
   worker in arrival order. The worker's per-Connection mutex then
   serializes their FFI calls. Net: `Promise.all([conn.query(a),
   conn.query(b)])` executes in arrival order, matching v0.3 main-
   thread semantics.
3. **`iterNext` is pull-based.** The worker fetches **one chunk** per
   request and replies with `{ rows: Row[], done: boolean }`. The
   consumer's `for await` drives the cadence; no unsolicited pushes.
   Backpressure is automatic.
4. **Each `iterNext` response contains a freshly-allocated `rows`
   array.** The worker MUST NOT retain references to the posted row
   data after `postMessage` returns; structuredClone produces a copy
   on the main thread, but a buggy worker that reuses an internal
   buffer and overwrites it before the consumer drains the chunk
   would still leak garbage. Per-response allocation eliminates the
   class of bug.
5. **`iterReturn` cleans up.** Sent on consumer `break` / `.return()` /
   parent close. The worker destroys the result + chunk handles and
   releases the connection lock (same protocol as v0.3 main thread).
6. **`release` is fire-and-forget.** Sent when the proxy is GC'd
   without explicit close. Has the same protocol as `close` but no
   response is expected; the worker logs and proceeds. Document
   that `release` is best-effort (GC isn't guaranteed) and the
   right pattern is always explicit `close()` or `await using`.
7. **Errors are reconstructed** on the main thread into the right
   `DuckDB*Error` subclass via `ERROR_CLASSES[name]`. Unknown names
   fall through to `DuckDBError`. Stack is preserved as a string
   prefixed with `[worker]` so it's visually distinguishable from
   main-thread frames in mixed traces.
8. **No raw FFI handles cross the wire.** All `Target.id` values are
   monotonic counters minted by the worker.

### Supported value types crossing the boundary

Per v0.3's type-mapping contract (CHANGELOG / `#readValue` docstring):

| Type in row object | Survives structuredClone? |
|---|---|
| `boolean` / `number` / `string` / `null` | Yes (primitives) |
| `bigint` | Yes (v8/JSC support is stable) |
| `Uint8Array` (BLOB) | Yes |
| `Date` (TIMESTAMP) | Yes |
| `Array` (LIST/ARRAY) | Yes (recursively) |
| plain `object` (STRUCT/MAP) | Yes (recursively) |
| string (HUGEINT/DECIMAL/UUID/DATE/INTERVAL/TIME) | Yes (just a string) |

No DuckDB type currently maps to a class instance that
structuredClone can't handle, so the protocol works without
custom serialization. If a future type adds a custom class (e.g.
a dedicated `DuckDBInterval` value class), it must register a
serializer here.

---

## §7 · Transaction semantics

`db.transaction(callback)` is **not** modeled as a batch of `subOps`
— that would require the user's callback to be serializable, which it
isn't. The user's callback runs on the main thread and can do
arbitrary control flow based on intermediate results.

DEFAULT protocol:

1. Proxy sends `{ op: 'txnBegin', target: <db or conn> }`. The worker
   allocates a **fresh dedicated Connection** for this transaction
   (so its ops are serialized behind the transaction without blocking
   the parent connection), runs `BEGIN`, and returns
   `{ ok: true, value: { connId: <new id> } }`.
2. Proxy invokes `callback(txProxy)` where `txProxy` is an
   `AsyncConnection` proxy with `target = { kind: 'conn', id:
   <txnConnId> }`. All user ops in the callback route to that
   connection.
3. On callback resolve: send `{ op: 'txnCommit', target:
   { kind: 'conn', id: <txnConnId> } }`.
4. On callback reject: send `{ op: 'txnRollback', target: ... }`,
   then rethrow the original error.
5. Worker holds the transaction's Connection open for the entire
   callback; all txn ops naturally serialize behind any other queries
   on that fresh connection (only one connection-holder, no contention).

This mirrors the main-thread API exactly. No surprising divergence.

**The user's callback runs on the main thread.** It receives a
`txProxy` (an `AsyncConnection`-shaped object whose `target.id` is
the transaction's worker-side connId). Every op in the callback
round-trips to the worker. Slow but correct — and the same model as
v0.3 main-thread, where the callback also runs on the main thread
and each op crosses the FFI boundary synchronously inside its
own `withLock`. Document loudly so users don't expect the callback
to magically run "inside" the transaction context.

**Nested transactions are not supported** (same as v0.3 main-thread).
Calling `tx.transaction(...)` from inside a `db.transaction(...)`
callback throws `DuckDBTransactionError` immediately on the proxy
side (no round-trip needed — the proxy carries the txn flag itself).

---

## §8 · Streaming protocol (pull-based iterate)

Critical correctness detail: **the worker holds the connection lock
for the iterator's lifetime** (same model as v0.3 main thread). The
worker can't release the lock between `iterNext` calls because DuckDB
doesn't allow interleaving other ops on a single connection
mid-result-stream.

Main-thread proxy shape:

```js
class AsyncStatement {
  iterate(params) {
    const stmtId = this.id;
    const conn = this.#proxy;   // the AsyncDatabase
    let iterId = null;
    let started = false;
    let finished = false;

    const wrapper = {
      [Symbol.asyncIterator]() { return wrapper; },

      async next() {
        if (finished) return { value: undefined, done: true };
        if (!started) {
          started = true;
          const { iterId: id, columns } = await conn._send({
            op: 'iterStart',
            target: { kind: 'stmt', id: stmtId },
            params,
          });
          iterId = id;
          // (optional: capture columns for type info)
        }
        const { rows, done } = await conn._send({
          op: 'iterNext', iterId,
        });
        if (done || rows.length === 0) {
          finished = true;
          return { value: undefined, done: true };
        }
        // Per-chunk buffer is held briefly here; yield rows one by one.
        // Implementation detail: cache rows in the wrapper, return one
        // per .next() until empty, then fetch the next chunk.
        // (Skeleton elided for clarity.)
      },

      async return() {
        if (finished) return { value: undefined, done: true };
        finished = true;
        if (iterId !== null) {
          try { await conn._send({ op: 'iterReturn', iterId }); }
          catch { /* swallow */ }
        }
        return { value: undefined, done: true };
      },

      async throw(err) {
        if (finished) throw err;
        finished = true;
        if (iterId !== null) {
          try { await conn._send({ op: 'iterReturn', iterId }); }
          catch { /* swallow */ }
        }
        throw err;
      },
    };

    return wrapper;
  }
}
```

Worker side: `iterStart` calls `stmt.iterate(params)` from the v0.3
driver (which holds the connection lock for the iterator's lifetime).
`iterNext` calls `it.next()` and returns the row. `iterReturn` calls
`it.return()` which runs the iterator's `finally` (destroy result,
release lock).

**Per-chunk transport (locked in).** Each `iterNext` returns one
DuckDB vector's worth of rows (currently 2048). The wrapper holds
the chunk in JS and yields its rows from `.next()` without round-
tripping until the chunk drains. Empty chunks (`rows.length === 0
&& done === true`) signal end-of-stream.

**Prefetch (default `prefetch: 1`).** With strict pull, wall-clock
time = `chunks × roundtrip`. With one chunk prefetched ahead, the
network/postMessage latency overlaps with the user's row processing,
roughly halving wall time on dense iteration:

```js
async function* drainIterator(iterId) {
  let pending = sendIterNext(iterId);     // start chunk 1
  while (true) {
    const chunk = await pending;
    if (chunk.done) return;
    pending = sendIterNext(iterId);       // prefetch chunk N+1
    for (const row of chunk.rows) yield row;
  }
}
```

Configurable via the iterate options bag:

```ts
stmt.iterate(params, { prefetch?: number });  // default 1; range [0, 4]
```

- `prefetch: 0` — strict pull. Each `iterNext` request happens after
  the previous chunk is fully drained. Lowest memory; highest wall
  time.
- `prefetch: 1` — one chunk in flight while consumer processes the
  previous one (DEFAULT).
- `prefetch: > 1` — bounded buffer. Worker can be N chunks ahead of
  the consumer. Capped at 4 to prevent unbounded memory growth on a
  slow consumer.

**Cancellation interaction with prefetch.** On consumer break with a
prefetched chunk in flight: send `iterReturn`, then `await` (and
discard) the prefetched response. Document that the latency hit on
`break` includes one extra round-trip.

---

## §9 · Async appender (batched)

`AsyncAppender.appendRow()` stays **synchronous** in the proxy
(matching the main-thread API where `Appender.appendRow` is sync).
The proxy buffers rows in memory and sends an `appendRows` batch to
the worker when:

- The buffer fills (DEFAULT batch size = **1000 rows**; configurable
  via `db.connect().append(table, { batchSize: N })`)
- `flush()` is called
- `close()` is called

**Error semantics:**

| Error source | Surfaced via |
|---|---|
| `appendRow()` after `close()` | Throws synchronously **on the proxy, no round-trip**, `DuckDBClosedError`. The proxy carries the closed flag locally. |
| `appendRow()` after Connection close | Same — the proxy checks its parent's state. |
| `appendRow()` after a prior batch failed (poisoned state) | Throws synchronously **on the proxy**, the cached error. The proxy caches the error from the last failing `appendRows` response and checks it before buffering. |
| Background batch failure | Stored on the appender (proxy side); surfaced on the next awaited `flush()` or `close()`. |
| `flush()` / `close()` | Awaits the pending batch promise; throws if it rejected. `close()` always resolves so the user can dispose cleanly via `using` — the rejection surfaces via `flush()` ordering, not via `close()`. |

The poisoned state is sticky: after a batch error, subsequent
`appendRow()`s throw the cached error. The proxy enforces all the
"throws synchronously" cases without round-tripping to the worker;
this matches main-thread `appendRow` (sync) semantics and avoids the
asymmetry where one append op would suddenly be async because it's
in a failed state.

---

## §10 · Concurrent lazy open

The proxy's `open()` returns synchronously. Worker spawn +
`duckdb_open` happen on the first awaited operation.

**MUST: a single `#openPromise` is shared** across concurrent first
operations. If three queries are issued in parallel before open
completes, all three await the same promise. If open fails, all
three reject with the (reconstructed) open error and the proxy moves
to "permanently failed" state (every subsequent call rejects with
the same error).

**Four error cases all funnel into `#openFailed`:**

1. `new Worker()` throws synchronously (e.g. file URL didn't resolve)
   → cache and reject all pending.
2. Worker emits `'error'` before the ready handshake (worker module's
   top-level threw) → same.
3. Worker emits `'error'` after ready but before `duckdb_open` returns
   (rare: e.g. malformed `OpenOptions`) → same.
4. `duckdb_open` returns an error (path invalid, permission denied,
   corrupted file) → same.

All four produce identical observable state: proxy is permanently
failed, every subsequent call rejects with the cached error, no
auto-recovery. Users wanting to recover open a fresh `Database` with
corrected inputs.

```js
async #ensureOpen() {
  if (this.#opened)      return;
  if (this.#openFailed)  throw this.#openFailed;        // cached error
  if (this.#openPromise) return this.#openPromise;      // share in-flight
  this.#openPromise = this.#doOpen()
    .then(() => { this.#opened = true; })
    .catch(err => { this.#openFailed = err; throw err; })
    .finally(() => { this.#openPromise = null; });
  return this.#openPromise;
}
```

---

## §11 · Worker lifecycle (spawn, ready, crash, close)

### Spawn and ready handshake

`new Worker(new URL('./worker.mjs', import.meta.url))` is async. The
worker's top-level evaluation may take milliseconds; until it
finishes, the worker can't dispatch messages.

Protocol: the worker `postMessage({ type: 'ready' })` once its module
has loaded. The proxy queues outgoing requests in
`#preReadyQueue: Request[]` until the ready message arrives, then
flushes the queue in order.

If the worker emits `'error'` before `'ready'`, every queued request
rejects with `DuckDBWorkerCrashedError` and the proxy moves to
permanently-failed state (same state as a crashed worker after
ready — see below).

### Crash

If the Worker exits unexpectedly (uncaught exception, `terminate()`
from anywhere, OS kill, etc.):

1. **All pending request Promises reject** with a new
   `DuckDBWorkerCrashedError` (extends `DuckDBError`).
2. **All proxy objects on that Database enter permanently-closed
   state.** Future calls reject with `DuckDBClosedError`.
3. **No request Promise hangs forever.** The proxy maintains
   `#pendingRequests: Map<id, { resolve, reject }>` and iterates it
   on the worker's `'exit'` / `'error'` event, rejecting each entry.
4. **Active iterators short-circuit their `iterReturn`.** A paused
   iterator's `for await` reads the worker-crash rejection from its
   pending `iterNext`. Its `finally` would normally send `iterReturn`
   — that send MUST check the proxy state and skip the send if the
   worker is gone. Otherwise the `iterReturn` `postMessage` either
   fails or queues against a dead worker.

**No auto-restart.** Worker crash is unrecoverable. The user must
`open()` a new Database. Auto-restart would silently hide bugs and
lose transaction state.

Implementation note: hook `worker.addEventListener('error', ...)` and
`'exit'` (verify exact Bun event names against Bun 1.3+ docs in the
implementation spike).

### Close with optional timeout

`db.close()` waits forever by default — it's a clean shutdown. For
users who want a bounded shutdown (e.g. a server's graceful-stop
handler):

```ts
await db.close({ timeout: 5_000 });
```

On timeout:

1. Call `worker.terminate()` (hard kill).
2. Reject every entry in `#pendingRequests` with
   `DuckDBWorkerCrashedError('close timeout')`.
3. Mark the proxy closed.

Default: no timeout. The opt-in shape avoids surprising users who
expect `await close()` to be a barrier.

---

## §12 · Required benchmarks

`bench/async-vs-sync.mjs` — committed in the same PR as the
implementation. Compare:

1. **Event-loop responsiveness.** Set a `setInterval` that bumps a
   counter every 1ms. Run a 10-second `SELECT count(*) FROM
   range(1e8)` synchronously vs. via the async subpath. Measure how
   many counter ticks were missed.
2. **Small-query latency.** `SELECT 1` 10,000 times. Sync wins;
   document the worker round-trip cost. If it's worse than ~10× sync,
   call it out loudly in the README.
3. **Large result clone cost.** `SELECT * FROM range(1e6)` (one
   integer column). Measure time-to-first-row, time-to-last-row,
   peak heap. Compare sync materialize vs. async materialize vs.
   async iterate.
4. **Appender throughput.** 100K rows. Async should be within 20% of
   sync; if it's worse, the batch size is wrong (or the structured-
   clone cost dominates — in which case we may need
   `Transferable`).

**Acceptance criteria:** benchmark #1 shows ≥95% of expected ticks
landed during the long async query (i.e. event loop stayed
responsive). #2 may regress (acceptable, document it). #3/#4 must be
within 30% of sync for non-trivial workloads.

If acceptance criteria aren't met, ship the RFC's deferred parts as
follow-ups but **don't** call v0.4.0 the worker-async release until
the responsiveness goal is hit.

---

## §13 · Test strategy

Re-run the v0.3 test suite against the async subpath. Most tests are
shape-agnostic — they call `db.all('...')` and check the returned
rows. A test-helpers tweak that parameterizes `import { open } from
'./helpers.mjs'` to either subpath would let us run both suites with
one source of truth.

Async-specific tests to add:
- Worker spawn happens on first awaited op, not on `open()` call
- Concurrent first-ops share `#openPromise`
- Open failure caches in `#openFailed`; all subsequent ops fail same way
- Worker crash → pending Promises reject with `DuckDBWorkerCrashedError`
- Worker crash → future ops reject with `DuckDBClosedError`
- Appender batching: row-count parity with sync after `flush()` /
  `close()`
- Appender poisoning: a bad row poisons; subsequent rows throw the
  cached error
- `iterate` cleanup on `break` sends `iterReturn`; subsequent query
  on the same connection succeeds
- `Symbol.asyncDispose` awaits worker drain + terminate
- `Symbol.dispose` is fire-and-forget; documented as best-effort

---

## §14 · Smoke test

Add to release smoke checklist. **Must use `await using`, not bare
`using`** — the async subpath uses `Symbol.asyncDispose`, and bare
`using` would only fire the sync best-effort fallback, masking
worker-cleanup bugs:

```bash
mkdir -p /tmp/duckdb-bun-async-smoke && cd /tmp/duckdb-bun-async-smoke
echo '{ "type": "module" }' > package.json
bun add duckdb-bun@0.4.0
bun -e "
  import { open } from 'duckdb-bun/async';
  await using db = open(':memory:');
  console.log(await db.get('SELECT 42 AS n'));
"
```

This catches:
1. Missing `package.json` `exports['./async']` entry
2. Missing `lib/async/` in `files[]`
3. Async-dispose paths that leave the Worker alive past process exit

---

## §15 · Migration / compatibility

- **No main-thread API changes.** The async subpath is purely
  additive. v0.3 code continues to work unchanged.
- **Mental model:** if you find yourself doing `db.exec('PRAGMA
  threads = 4')` to scale main-thread DuckDB, consider whether you
  actually want `import from 'duckdb-bun/async'` instead — the worker
  isolates the entire DuckDB stack from your hot path.

---

## §16 · Open questions & resolved decisions

Items marked **resolved** are locked in; **open** items must be
spiked or decided before approval.

1. **Bun Worker file URL under npm-install — RESOLVED (2026-05-15).**
   Spiked with a minimal `dbn-worker-spike` package: a stub
   `lib/async/index.mjs` that does `new Worker(new URL('./worker.mjs',
   import.meta.url).href)`, packed and installed via `bun add
   ./*.tgz` into a fresh tempdir. The Worker spawned correctly from
   `file:///.../node_modules/dbn-worker-spike/lib/async/worker.mjs`,
   `import.meta.url` matched on the worker side, and ping/pong
   round-tripped. **No fallback resolver needed** — the simple URL
   shape works under `node_modules`. Implementation can use the
   pattern in §11 verbatim.
2. **`OpenOptions` shape — RESOLVED.** Defer until v0.3.x ships
   options on the main-thread API. The async subpath is a strict
   superset of main; it'll inherit whatever shape v0.3.x lands on.
   Acceptance criterion: if v0.3.x hasn't shipped options by v0.4.0
   freeze, v0.4.0 ships with no options support and adds them in
   v0.4.1 when v0.3.x catches up. **Pre-v0.4 work:** check
   `lib/duckdb.mjs` `open(path)` signature; document explicitly here
   that we ship matching it.
3. **Per-chunk transport with prefetch — RESOLVED.** §8 locks in
   per-chunk transport with `prefetch: 1` default, range `[0, 4]`.
   Benchmark the prefetch values in `bench/async-vs-sync.mjs` and
   document the chosen default with one sentence of rationale.
4. **Close timeout — RESOLVED.** Opt-in via `close({ timeout })`. No
   default. See §11.
5. **`AbortSignal` / cancellation — RESOLVED (v0.5 with revised
   architecture; v0.4.0 shipped without).** v0.5.0 adds it as the
   headline feature; Windows slides to v0.6.0. **The "half-day"
   scope estimate in this RFC's first draft was wrong** — a post-v0.4
   spike (2026-05-15) proved the original implicit architecture
   ("worker handles a `cancel` postMessage") cannot work, because
   the worker's JS event loop is **completely blocked** during a
   DuckDB FFI call. Concrete data:

   ```
   Spike 1 — same-worker cancel:
     Worker started query at  +58ms
     Main sent cancel at     +158ms
     Worker received cancel  +769ms   ← only after query finished
     Cancel latency 611ms (worker frozen during 711ms FFI block)
   ```

   The viable architecture (proven by Spike 2): the **main thread
   calls `duckdb_interrupt(connHandle)` directly** while the worker
   is blocked. This works because `libduckdb` is loaded once per
   process; the connection pointer is just a memory address that's
   valid in both threads; DuckDB documents `duckdb_interrupt` as
   safe to call from another thread.

   ```
   Spike 2 — main-thread interrupt on worker-owned handle:
     Worker started query at  +44ms
     Main called duckdb_interrupt(handle) directly at +145ms
     Worker queryEnd at      +147ms  with err="INTERRUPT Error: Interrupted!"
     Interrupt latency: 2ms
   ```

   The v0.4.1 patch ships **forward-compat plumbing** for this
   architecture without exposing any new public API:
   - Worker's `connect`/`txnBegin` responses include `interruptHandle:
     bigint` (the raw `duckdb_connection` pointer) and
     `interruptGeneration: number` (monotonic, prevents stale abort
     listeners firing on a recycled connId).
   - Main proxy stores these in `AsyncDatabase._interruptHandles:
     Map<connId, { ptr, generation }>` but never reads them.
   - The map is cleared on every `Connection.close()` and
     `Database.close()`.

   v0.5 wiring (still to ship):
   - Main thread dlopens just `duckdb_interrupt` (libduckdb is already
     loaded by the sync subpath; reuse same library path).
   - Every async query method accepts `{ signal: AbortSignal }`.
   - **Critical correctness invariant** (per GPT-5.5 review): only
     interrupt when the aborted request is **known to be active** on
     its target connection. Worker emits a `requestActive` event
     immediately before entering blocking FFI; main tracks
     `activeRequestByConn: Map<connId, requestId>`. Without this,
     aborting a queued request would interrupt a different request
     that's currently active — a correctness bug.
   - New error class: `DuckDBAbortError extends DuckDBError`.
   - Iterator coordination: aborting mid-`iterNext` interrupts the
     active fetch; in-flight prefetch is drained; `iterReturn` is
     sent best-effort. Aborting between chunks (when no FFI is
     active) marks the iterator aborted and next `.next()` rejects.
   - Transaction coordination: aborting a sub-op rejects with
     `DuckDBAbortError`; `runTransaction`'s catch path sends
     `txnRollback` **without** the user signal (cleanup must be
     best-effort even after abort).
   - **Sync subpath does NOT get `AbortSignal`** — sync FFI blocks
     the JS thread that would receive the abort event; shipping a
     signal that can't interrupt mid-FFI would be misleading.
     Document that users needing cancellation use `duckdb-bun/async`;
     `close({ timeout })` is the only fallback for the sync subpath
     and is framed as a shutdown hammer, not equivalent to per-query
     cancellation.

   **Revised scope (per GPT-5.5):** 1.5–2 days minimum for correct
   semantics; 2–3 days with full polish (main-side request scheduler
   for prompt queued-cancel, transaction-level signal, stress tests).

---

## §17 · Scope discipline

Things to **explicitly defer to v0.5+**:

- `AbortSignal` / cancellation (now the headline feature of v0.5.0 —
  see §16 item 5). Was previously slated for v0.5+; the reviewer
  argued for v0.4 but the scope blew the budget.
- Worker pooling (one Worker per Database stays)
- Transferable optimization for result transport (benchmark first;
  may not be needed)
- Multi-process / multi-host (Worker is one process)
- `await using` browser polyfill ergonomics (Bun-only for now)

Each of those would extend the scope by ≥1 day. v0.4.0 ships a
working, tested, benchmarked subpath; everything else is v0.4.x or
later.

### Adjusted roadmap (post-RFC)

The original roadmap had v0.5.0 = Windows. With cancellation now
deferred from v0.4, the new sequence is:

| Version | Feature |
|---|---|
| v0.4.0 | `duckdb-bun/async` worker subpath (this RFC) |
| v0.5.0 | `AbortSignal` / `duckdb_interrupt` cancellation, across both subpaths |
| v0.6.0 | Windows x86_64 support (was v0.5.0 in the original roadmap) |

User can override this ordering; the dependency chain is:
v0.4 → v0.5 (cancellation depends on the async transport's request-id
machinery for `cancel` op routing). Windows is independent of both
and could ship out-of-order if it's higher priority.

---

## §18 · Estimated scope

Original estimate: **1–2 days** of focused work, including this RFC,
implementation, tests (parameterized against the v0.3 suite),
benchmarks, smoke test, README, and CHANGELOG.

If the actual time exceeds 2 days, audit what's growing — usually
it's the Worker file-URL spike (open question #1) or unexpected Bun
FFI behavior inside the Worker (handle types should be the same as
main thread but verify in spike #2 before assuming).

---

## §19 · Approval

This RFC is **draft v2 — awaiting user approval**. To advance to
"approved":

1. ✅ A fresh review has been performed (2026-05-15, via
   `mcp/user-ai/discuss`; load-balanced to Anthropic Opus 4.7 even
   though we asked for `openai:gpt-5.5`). Corrections folded in;
   see "Changelog of this RFC" at the top.
2. **TODO — user approves:** the protocol shape (§6 + §8 + §11
   together), the transaction semantics (§7), and the deferral of
   cancellation to v0.5 (§16 #5). These are the load-bearing
   decisions.
3. ✅ v0.3.0 published on npm (2026-05-15). The async subpath
   consumes the v0.3 driver wholesale; this prerequisite was the
   gate for `lib/async/worker.mjs` importing `../duckdb.mjs`.
4. ✅ Spike open question #1 — Bun Worker URL resolution under
   npm-install — passed (2026-05-15). The simple `new Worker(new
   URL('./worker.mjs', import.meta.url))` pattern works without
   any fallback machinery.

Once those four items are green, implementation proceeds. Until
then, **do not write any code under `lib/async/`.**

### What the implementation PR should contain

Ship-checklist (matches the implementation that landed in v0.4.0):

- [ ] `lib/async/index.mjs` (main-thread proxies)
- [ ] `lib/async/worker.mjs` (Worker entry, registry, dispatcher)
- [ ] `lib/async/protocol.mjs` (runtime constants, `ERROR_CLASSES`,
      `DuckDBWorkerCrashedError`)
- [ ] `lib/async/protocol.d.ts` (TypeScript types)
- [ ] `lib/async/index.d.ts` (TypeScript types for the public API)
- [ ] `package.json` — `exports['./async']`, `files: ['lib/async/']`
- [ ] `test/async/*.test.mjs` — parameterized v0.3 suite + async-
      specific tests (lazy open, crash semantics, appender batching,
      iterate prefetch)
- [ ] `bench/async-vs-sync.mjs` — the four benchmarks from §12
- [ ] `examples/async.mjs` — runnable demo, wired into CI smoke
- [ ] `README.md` — section linking to `duckdb-bun/async`, perf notes
- [ ] `CHANGELOG.md` — v0.4.0 entry, document the cancellation gap
- [ ] `package.json` `version` bumped to `0.4.0`
- [ ] Smoke test from §14 succeeds in fresh tempdir post-publish
