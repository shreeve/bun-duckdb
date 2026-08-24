# Changelog

All notable changes documented here. Versioning follows
[semver](https://semver.org/) — `0.x` releases may make breaking changes
between minor versions until the `1.0.0` API freeze.

## 0.8.0 — 2026-08-24

**The Bun 1.4 / TypeScript-native release.** The package now ships
TypeScript source as the runtime artifact — Bun executes it natively,
so `lib/duckdb.ts` is simultaneously the implementation and the type
declarations. Zero runtime behavior changes: the 243-test suite passes
byte-identically before and after, on DuckDB 1.5.5 AND the 2.0
nightlies.

### Breaking

- **`engines.bun` raised to `>=1.4.0`** (was `>=1.1.0`). Bun 1.4's
  engine-native FFI is the certified target. The v0.8.0 driver was
  empirically verified to still run on Bun 1.1.34–1.3.x, but those are
  no longer supported — pin `duckdb-bun@0.7` if you're stuck on an
  older Bun.

### Changed

- **`.mjs` + hand-written `.d.ts` → shipped TypeScript.**
  `lib/duckdb.{mjs,d.ts}` and `lib/async/*.{mjs,d.ts}` are now
  `lib/duckdb.ts` and `lib/async/*.ts`; the parallel declaration files
  are deleted, eliminating the type-drift class of bugs entirely. All
  public JSDoc (including per-feature "(v0.x+)" markers) moved onto
  the source declarations. `package.json` exports gained the `"bun"`
  condition; `types` points at the source. New `tsconfig.json`
  (TypeScript 7, `strict`, `noUncheckedIndexedAccess`) with a
  `bunx tsc --noEmit` CI gate on every platform lane.
- **CI pins its toolchain**: Bun 1.4.0 exactly (was `latest`) and
  DuckDB v1.5.5 (was v1.5.2) on the required lanes.
- README benchmarks re-measured on Bun 1.4 + DuckDB 1.5.5 (appender:
  100K rows ~5ms / ~20M rows/s — the engine-native FFI cut per-call
  overhead vs the ~46ms measured on pre-1.4 Bun).

### Added

- **DuckDB CLI installer discovery**: `findDuckDBLibrary()` now also
  checks `~/.duckdb/cli/latest/` (the path maintained by
  `curl https://install.duckdb.org | sh`), after the system paths —
  the CLI installer alone is now a complete setup.
- **`v2-canary` CI job**: every push additionally runs the full suite
  against the DuckDB v2 nightly libduckdb + Bun `latest`,
  non-blocking, so a 2.x C-API break or Bun FFI regression surfaces
  on the commit that first sees it.
- **`_internals.libPath` / `_internals.shimPath`** — resolved library
  locations exposed for diagnostics (unsupported surface, like the
  rest of `_internals`).

### Notes

- The two load-bearing FFI workarounds (u64/BigInt handles; the C
  shim for struct-by-value) are **unchanged and still required** on
  Bun 1.4 — struct-by-value FFI remains open upstream
  (oven-sh/bun#6139). See AGENTS.md for the updated status.

## 0.7.0 — 2026-05-15

**AbortSignal cancellation on the async subpath.** Every async op now
accepts an optional `{ signal?: AbortSignal }` last argument. When the
signal aborts, the main thread interrupts the worker's blocked FFI
call via `duckdb_interrupt`; the op rejects with `DuckDBAbortError`.

The v0.4.1 forward-compat plumbing shipped per-connection interrupt
handles + generation tokens. v0.7 wires them up.

### Added

- **`DuckDBAbortError`** — new error class. `.name === 'AbortError'`
  (Web standard convention used by fetch / ReadableStream / etc.),
  `.code === 'ERR_DUCKDB_ABORTED'`, `instanceof DuckDBError`. Exported
  from both `duckdb-bun` and `duckdb-bun/async`.
- **`signal?: AbortSignal`** on every async op:
  - `AsyncConnection.query / all / get / run / exec / iterate / chunks`
  - `AsyncDatabase` shortcuts (same surface, delegated through a lazy
    implicit `AsyncConnection`)
  - `AsyncStatement.all / get / run / iterate`
  - Sub-ops inside `db.transaction(async tx => { ... })` callbacks
- **Per-connection serialization on the main thread.** Each
  `AsyncConnection` now has an internal promise chain that serializes
  every op against the conn's other ops. Matches the sync driver's
  per-`Connection` lock semantics, and gives cancellation a well-
  defined "active request" to interrupt without racing queued ones.

### Changed

- **`AsyncDatabase` shortcuts now route through a lazy implicit
  `AsyncConnection`.** Previously `db.query / db.exec / db.prepare`
  etc. used the sync driver's implicit connection inside the worker
  (KIND.DB target). That conn's handle wasn't reachable from the
  main thread, so cancellation couldn't target it. The refactor
  gives every db-level shortcut a stable connection identity for
  `AbortSignal` to interrupt. Behavior is otherwise identical.
- **`AsyncConnection.close()` drains its serial chain before
  transitioning to `'closing'`** so queued ops complete normally
  rather than rug-pull-rejecting with `DuckDBClosedError`. Avoids an
  unhandled-rejection window where queued promises rejected faster
  than user `.then()` handlers attached. Ops added after `close()` is
  called still reject synchronously at the entrance check.
- **`duckdb_interrupt` FFI binding** added to `lib/duckdb.mjs` and
  exposed via the new (internal, underscore-prefixed) `_internals`
  export. Used by the async subpath; not part of the public API.

### Cancellation semantics (the careful bits)

The implementation satisfies these invariants, each covered by a
test in `test/async/cancel.test.mjs`:

1. Active long query aborts quickly (no busy-wait to the natural end)
2. Abort error is `DuckDBAbortError`; `.name === 'AbortError'`
3. Already-aborted signal rejects before sending work to the worker
4. Aborting a queued request does NOT interrupt the active request
5. Abort during an active iterator's `iterNext` cleans up
6. Abort while iterator has buffered rows rejects on next `.next()`
7. Sub-op abort inside a transaction rolls back
8. Late abort (after a query already resolved) does nothing
9. `close()` removes the interrupt handle; late abort cannot call
   `duckdb_interrupt` on a freed connection pointer
10. Worker crash + aborted in-flight request does not hang

The sync subpath does **not** get `AbortSignal`. Sync FFI blocks the
JS thread that would receive the abort event — the listener can't
fire until the query returns. We considered an interrupt-from-another-
thread approach but it would require a second Bun worker thread for
the sync driver too, adding cost and complexity for an API that's
already covered by the async subpath. (If you need cancellation, use
`duckdb-bun/async`.)

### Not in scope

- Cancellation of `db.transaction(fn)` itself — aborting a sub-op
  inside the callback rolls back, but there's no signal on the
  outer `transaction()` call. The callback owns its own abort
  policy. Easy to add later if anyone wants it.
- Cancellation across multiple connections — each `AsyncConnection`
  has its own per-conn signal scope. A signal passed to `conn1.query`
  cannot abort an op on `conn2`.

## 0.6.0 — 2026-05-15

**Windows x86_64 support.** First-class Windows port: pre-built shim
DLL ships in the npm tarball, full test suite (232/232) and all five
examples are green on `windows-latest` in CI.

This is mechanically a small release — most of the work is the build
pipeline and a handful of correctness fixes that were latent on Unix.

### Added

- **Shim:** `lib/libduckdb-shim-win32-x64.dll` built per release via
  MSVC `cl.exe` and bundled into the npm tarball. The CI pipeline
  verifies all required exports (`shim_fetch_chunk`,
  `shim_result_get_chunk`, `shim_result_chunk_count`) via
  `dumpbin /exports` to fail fast if `__declspec(dllexport)` is ever
  dropped from the shim source.
- **Build script:** `lib/build.ps1` — PowerShell build script that
  produces the Windows shim from MSVC's `cl.exe`. Static-links the CRT
  (`/MT`) so users don't need MSVC runtime installed; verifies exports
  via `dumpbin` to fail fast if `__declspec(dllexport)` ever regresses.
- **DLL discovery:** existing `findDuckDBLibrary()` Windows paths kept
  (`C:\Program Files\DuckDB\duckdb.dll`, `duckdb.dll` on PATH), with
  `DUCKDB_LIB_PATH` as the explicit override.
- **CI:** `windows-latest` job in `test.yml` and `release.yml`, using
  `ilammy/msvc-dev-cmd@v1` to provision MSVC.

### Changed

- **`lib/duckdb.mjs` cross-platform path handling:** replaced regex-
  based dirname extraction (which only handled `/`) with `path.dirname` +
  `url.fileURLToPath`. The previous code would fail on `C:\...\lib\
  duckdb.mjs`.
- **`lib/duckdb.mjs` dlopen handle retention:** both `dlopen()` wrapper
  objects (libduckdb + shim) are now retained at module scope. Previously
  we only kept `.symbols`. On Unix this was harmless; on Windows, GC of
  the wrapper could trigger `FreeLibrary`, which would invalidate the
  shim's bound import of `duckdb.dll`. Load order is also explicitly
  documented (libduckdb first, then shim) — this is the "preload"
  pattern that makes Windows's loader resolve the shim's import to the
  already-loaded module by name.
- **Shim source:** `__declspec(dllexport)` (under a `DUCKDB_BUN_EXPORT`
  macro that's `__attribute__((visibility("default")))` on Unix). Without
  this, `cl.exe /LD` produces a DLL with no exported symbols — Bun's
  `dlopen` would silently return null entry points.
- **`engines.bun` raised to `>= 1.1.0`** — Bun added Windows support in
  1.1. The Linux/macOS path still works on 1.0, but npm metadata now
  reflects the reality of what's tested.
- **Test paths:** hardcoded `/tmp/...` replaced with
  `os.tmpdir() + path.join(...)` in lifecycle / options / async tests.

### Fixed

- Three options tests (`readOnly`, `accessMode`, `checkpoint` file-
  durability) previously used `using d1 = open(path)` to populate a
  file, then immediately reopened the same path. On Windows the file is
  exclusively locked while open and `Symbol.dispose` is fire-and-forget
  (by design — `await using` is the awaitable version), so the second
  open() raced the first close(). Switched to explicit `await close()`.
  Behavior on Unix is unchanged.

### Not shipping in 0.6.0

- **Windows arm64 shim.** DuckDB ships a Windows arm64 binary and Bun
  supports the platform, but we have no runtime test environment for
  arm64 Windows in CI — compile-only support isn't enough for an FFI
  package. Open an issue if you'd use it.

### Roadmap shift

- v0.6 was previously slated for `AbortSignal` cancellation; it's been
  swapped with what was v0.7 (Windows). Cancellation is now planned for
  v0.7. The cancellation architecture is already proven via the
  forward-compat plumbing shipped in v0.4.1 (worker returns interrupt
  handles per connection); the only missing piece is the main-thread
  `AbortSignal` API.

## 0.5.2 — 2026-05-15

Stabilization pass. **No public API changes, no behavior changes —
pure documentation and comment cleanup** to bring the in-tarball docs
in sync with what was actually shipped across v0.3 → v0.5.1.

### Documentation

- **README rewritten** in several sections to reflect v0.5.1 reality:
  API tables on Database / Connection / Statement now list every
  shipped helper (`chunks`, `pragma`, `installExtension`,
  `loadExtension`, `checkpoint`); errors table adds
  `DuckDBWorkerCrashedError`; Roadmap section rewritten with
  "Shipped / Planned / Likely later / Not planned" structure;
  cancellation note updated (v0.5 → v0.6); Windows compatibility
  clarified ("planned for v0.7; currently no shipped shim").
- **AGENTS.md** — architecture diagram redrawn to show the sync
  driver and async subpath side-by-side; file table updated;
  stale references to a single test file replaced.
- **CONTRIBUTING.md** — test count and driver line count updated;
  examples list adds `iterate.mjs` and `async.mjs`.
- **CHANGELOG.md** — older entries' forward-looking "v0.5 will ship
  cancellation" updated to reflect the actual v0.6+ target.
- **`docs/rfcs/0001-worker-async-api.md`** — marked
  "Implemented in v0.4.0" as a design archive.
- **`HANDOFF.md` deleted.** 1371 lines of v0.3→v0.5 implementation
  planning; all work shipped. The valuable engineering knowledge
  (FFI bugs, locking model, async architecture) lives in `AGENTS.md`;
  the v0.4 design rationale lives in `docs/rfcs/0001`; nothing is
  lost.

### Internal

- Comments in `lib/duckdb.mjs` and `lib/async/*` no longer mention
  "v0.5 cancellation" (cancellation is now planned for v0.6+).
  Section headers stripped of `(v0.2)` version tags where they no
  longer match the section's full v0.5 scope. JSDoc "introduced in"
  markers (`*(v0.5+)*`) are preserved.
- `lib/duckdb.mjs` top-level docstring rewritten (was "No Zig, no
  npm package" — confusing for a package that ships on npm).

### Repo

- Net change: 11 files modified, +250 / −1585 lines (mostly the
  HANDOFF.md deletion). Suite still 232 tests; tarball still 16 files.

## 0.5.1 — 2026-05-15

Tiny follow-up to v0.5.0 fills in a missing affordance.

### Added

- **`checkpoint(opts?)`** on `Database`, `Connection`, `TxnHandle`,
  `AsyncDatabase`, `AsyncConnection`. Sugar over DuckDB's
  `CHECKPOINT` / `FORCE CHECKPOINT` / `CHECKPOINT name` /
  `FORCE CHECKPOINT name`. Useful for flushing the WAL on file-backed
  databases before process exit or after a large batch insert.

  ```js
  await db.checkpoint();
  await db.checkpoint({ force: true });
  await db.checkpoint({ database: 'aux' });          // for ATTACHed DBs
  await db.checkpoint({ database: 'aux', force: true });
  ```

  The `database` field is strictly validated against
  `^[A-Za-z_][A-Za-z0-9_]*$` so it's safe to pass user-supplied names.
  Should have been in v0.5.0; missed because it wasn't in the original
  roadmap.

### Tests

- 11 new tests: in-memory no-op, force form, file-backed durability
  (insert → checkpoint → reopen → verify rowcount), identifier
  validation, attached-DB target, TxnHandle integration, async parity.
- Total: 232 tests (was 221).

## 0.5.0 — 2026-05-15

Core-polish release. Reorders the roadmap after a "are we still on
track with the package's goals?" check-in: instead of pushing further
async-subpath work (AbortSignal cancellation, Windows), this release
fills out the main driver with affordances that have been sitting in
the roadmap since v0.2. Cancellation is now v0.6; Windows is v0.7.

### Added

- **`open(path, opts?)` accepts `OpenOptions`** — startup config via
  `duckdb_create_config` + `duckdb_open_ext`. Typed shortcuts:
  - `readOnly: boolean` — sugar for `accessMode: 'READ_ONLY'`
  - `accessMode: 'AUTOMATIC' | 'READ_ONLY' | 'READ_WRITE'`
  - `threads: number` (positive integer)
  - `memoryLimit: string` (e.g. `'1GB'`, `'512MB'`)
  - `tempDirectory: string`
  - `config: Record<string, string|number|boolean|bigint>` — escape
    hatch for any DuckDB config key not exposed above

  Typed options and `config` setting the **same DuckDB key with
  different values** throw `DuckDBError` instead of silently choosing
  one (per GPT-5.5 review: "avoid 'why did my DB open read-write?'
  bugs"). Mirrored on the async subpath; opts flow through the
  `open` op to the worker.

- **`Connection.pragma(name, value?)`** + `Database.pragma()` — thin
  PRAGMA wrapper with strict `^[A-Za-z_][A-Za-z0-9_]*$` identifier
  validation and SQL-literal escaping on values. Get-form returns the
  first row object (multi-column for pragmas like `database_size` and
  `version`); set-form runs `PRAGMA name=value`. **Note:** DuckDB
  distinguishes PRAGMAs (function-like queries) from runtime
  *settings* like `threads`/`memory_limit` — set-form works for
  settings, but get-form does NOT (DuckDB exposes setting reads via
  `current_setting()`). See the method's JSDoc for the recommended
  patterns.

- **`Connection.installExtension(name)` / `loadExtension(name)`**
  (plus Database sugar) — `INSTALL <name>` and `LOAD <name>` with
  the same identifier validation. Safe to call with user input.

- **`chunks()` chunk-by-chunk streaming** — exposes the natural
  DuckDB vector boundary that `iterate()` papers over. Yields
  `{ rows: Row[], chunkIndex: number, rowOffset: number }` where
  `rows` carries a `.columns` sidecar matching `QueryResult`. Same
  lock/lifecycle model as `iterate()`: holds the Connection's
  lock for the iterator's lifetime, cleans up on break/throw/return.
  Available on `Statement`, `Connection`, and `Database` (plus async
  parity via on-proxy buffering).

- **`TxnHandle` — scoped transaction handle** (v0.5 design improvement,
  not a behavior change). `db.transaction(async (tx) => { ... })`
  now passes a TxnHandle, not the raw Connection. Using the handle
  after the callback returns/throws raises `DuckDBTransactionError`.
  This catches the common "user stashed `tx` somewhere and used it
  later" bug without changing transaction semantics.

### Changed

- Roadmap shift (per a goals check-in mid-session):
  - **v0.6.0** = `AbortSignal` cancellation (was v0.5; architecture
    spiked + RFC-documented in v0.4.1; implementation deferred to
    prioritize core-driver polish)
  - **v0.7.0** = Windows x86_64 (was v0.6)

### Not landing in v0.5

- **Nested transactions via SAVEPOINT.** DuckDB v1.5.2 (our pinned
  version) doesn't parse SAVEPOINT — it's an open upstream feature
  request. `tx.transaction()` still rejects with
  `DuckDBTransactionError`, now with a message that names the
  upstream blocker. The method is *kept* on the public API (not
  removed) so a future release that lands nested transactions is a
  non-breaking change.
- **Configurable type conversion** (BIGINT → bigint, etc.). Deferred
  to a future RFC alongside the cancellation work — it changes the
  decoder contract and wants a coherent options-bag design.

### Internal

- New FFI bindings: `duckdb_open_ext`, `duckdb_create_config`,
  `duckdb_set_config`, `duckdb_destroy_config`.
- Private SQL escape helpers (`assertSimpleIdentifier`,
  `quoteSqlLiteral`) — not exported; used only by PRAGMA / extension
  / SAVEPOINT-name generation.
- `makeTxnHandle(conn, scope)` — module-level helper that builds the
  scoped transaction wrapper. The scope's `closed` flag is flipped
  before COMMIT/ROLLBACK so a leaked handle reference can't get used
  mid-cleanup.

### Tests

- New `test/options.test.mjs` — 25 tests covering OpenOptions
  (typed/typed conflict, typed/config conflict, validation, file-
  backed read-only enforcement), PRAGMA helper (get/set, identifier
  injection rejection, SQL escape), extension helpers (validation +
  graceful error from missing extension), and `chunks()` on
  Statement / Connection / Database (multi-chunk span, metadata
  shape, concurrent guard, mid-stream cleanup).
- Updated `test/transactions.test.mjs` — replaced the v0.4 "nested
  throws" tests with new ones pinning the TxnHandle close-on-callback-
  return behavior. The nested-throw test stays in a focused form
  asserting the upstream-SAVEPOINT message.
- 7 new async tests for OpenOptions parity (threads, readOnly, bad-
  opts caching), pragma/extension via the worker, and `db.chunks`
  buffering.
- Total: 221 tests (was 186). Suite runs in ~2.6s.

## 0.4.1 — 2026-05-15

Patch release: forward-compat plumbing for v0.5 cancellation, iterator
race tests, and documentation refinements. **No public API additions.**

### Background

After v0.4.0 shipped, a post-release GPT-5.5 fresh-review surfaced a
critical question about how `AbortSignal` cancellation would actually
work in the async subpath. A spike (captured in
[`docs/rfcs/0001-worker-async-api.md` §16 #5](./docs/rfcs/0001-worker-async-api.md#16--open-questions--resolved-decisions))
proved that the original "worker handles a `cancel` postMessage" plan
is architecturally infeasible — the worker's JS event loop is
**completely frozen** during a blocking DuckDB FFI call (cancel
latency 611ms over a 711ms query, vs the desired ~0ms). A second
spike confirmed the viable architecture: **the main thread calls
`duckdb_interrupt(handle)` directly while the worker is blocked**;
interrupt latency 2ms; DuckDB returns `"INTERRUPT Error: Interrupted!"`.

v0.6.0 will ship that architecture (originally targeted for v0.5,
deferred when v0.5 became a core-polish release instead). v0.4.1
lays the protocol groundwork now so the eventual v0.6 wire format
is a strict superset.

### Added (forward-compat only)

- **`AsyncDatabase._interruptHandles: Map<connId, { ptr, generation }>`** —
  the worker now sends the raw `duckdb_connection` pointer (as
  `BigInt`) plus a monotonic `interruptGeneration` token on every
  `connect` and `txnBegin` response. The main proxy caches them but
  **does not use them in v0.4.1**. v0.6 will wire them into
  `mainLib.duckdb_interrupt(ptr)` on `AbortSignal.abort`. The
  generation token lets the future implementation detect stale abort
  listeners that fire after a connId has been reused.
- Handles are cleared from `_interruptHandles` on `Connection.close()`
  and `Database.close()` so late aborts can't fire on freed
  connections.

### Tests

- 5 new forward-compat tests pinning the interrupt-handle plumbing:
  presence after `connect()` and `transaction()`, fresh generation
  per connection, cleanup on `Connection.close()` and
  `Database.close()`.
- 3 new iterator-race tests covering the `prefetch > 0` scenarios
  GPT-5.5 flagged: `break` mid-prefetch, `throw` mid-prefetch, and
  immediate `.return()` after first `.next()` while prefetched
  chunks are still in flight. All verify the connection stays
  usable for subsequent ops.
- Total: 186 tests (was 178).

### Documentation

- **README** now has a "Cancellation note" inline with the async
  example explaining: v0.4.x has no `AbortSignal`; `close({ timeout })`
  is the only fallback and is a *shutdown hammer*, not a per-request
  primitive; a future minor release will add `AbortSignal` to the
  async subpath only; the sync `duckdb-bun` API will **never** get
  `AbortSignal` (sync FFI blocks the JS thread that would receive
  the event).
- **`docs/rfcs/0001-worker-async-api.md` §16 #5** rewritten with
  spike data, the revised architecture, the GPT-5.5-flagged
  correctness invariant (only call `duckdb_interrupt` when the
  aborted request is known to be active on its target connection —
  otherwise you cancel the wrong query), and the revised scope
  estimate (1.5–3 days, not "half a day").

## 0.4.0 — 2026-05-15

Adds the `duckdb-bun/async` subpath — same API surface as the main
package, but every DuckDB call runs inside a `Worker` so the main event
loop stays responsive for HTTP / interactive workloads. Designed
end-to-end before any implementation landed; design contract at
[`docs/rfcs/0001-worker-async-api.md`](./docs/rfcs/0001-worker-async-api.md).

### Added

- **`duckdb-bun/async`** subpath: `import { open } from 'duckdb-bun/async'`.
  Spawns one Bun `Worker` per `AsyncDatabase`; the Worker imports the
  v0.3 main-thread driver wholesale and dispatches against a numeric-ID
  registry. No raw FFI handles cross `postMessage`; result rows go
  through structuredClone (which preserves `Uint8Array`, `BigInt`,
  `Date`, plus the sidecar `.columns` / `.rowsChanged` properties on
  `QueryResult` arrays).
- **All four proxy classes** — `AsyncDatabase`, `AsyncConnection`,
  `AsyncStatement`, `AsyncAppender` — mirror the v0.3 surface 1:1.
  Every public method that crosses the wire is `async`. `Symbol.dispose`
  is fire-and-forget (`close().catch(...)`); **`Symbol.asyncDispose` is
  the preferred dispose pattern** for streaming code (`await using db =
  open(...)`).
- **Lazy open.** `open(path)` returns a proxy synchronously; the Worker
  spawns and `duckdb_open` runs on the first awaited op. Concurrent
  first-callers share one `#openPromise`. If open fails, the error is
  cached in `#openFailed` and every subsequent call rejects with the
  same identity error.
- **Pull-based streaming** for `AsyncStatement.iterate()`. Each
  `iterNext` request returns up to one DuckDB vector (≤2048 rows) as
  a freshly-allocated `rows` array; the wrapper drains the chunk
  locally and yields rows one at a time. Configurable `prefetch:
  number` option (default `1`, range `[0, 4]`) keeps one chunk in
  flight while the consumer processes the previous one. `break` /
  `throw` / explicit `.return()` cleanly send `iterReturn` and drain
  any in-flight prefetch.
- **`AsyncAppender` streaming form** via `conn.append(table, columns)`.
  `appendRow(values)` is sync, matching the main-thread API; rows are
  buffered locally and sent in batches (default `batchSize: 1000`).
  `flush()` and `close()` drain the buffer + tell the worker to flush
  to DuckDB. Sticky **poisoned state**: after a batch failure,
  subsequent `appendRow()` calls throw the cached error synchronously
  on the proxy (no round-trip).
- **`Database.transaction(fn)` / `Connection.transaction(fn)`** —
  worker allocates a fresh dedicated `Connection` for each
  transaction (returned as `txnConnId`); the user's callback receives
  a connection-shaped proxy whose ops route to that connection.
  Commit on resolve; rollback + rethrow on throw. Nested transactions
  throw `DuckDBTransactionError` **on the proxy side** without a
  round-trip.
- **`DuckDBWorkerCrashedError`** (extends `DuckDBError`) — thrown when
  the Worker exits unexpectedly. All pending request promises reject
  with it; future calls reject with `DuckDBClosedError`. No promise
  hangs forever.
- **Configurable close timeout.** `db.close({ timeout: ms })`
  force-terminates the Worker after the timeout, rejecting any
  pending requests with `DuckDBWorkerCrashedError('close timeout')`.
  Default: no timeout (wait forever).
- **`examples/async.mjs`** — runnable demo showing the lazy-open
  proxy, iterate, transactions, streaming appender, and the
  event-loop-responsiveness payoff (~90% of timer ticks fire during
  a ~500ms heavy query). Wired into CI smoke.
- **`bench/async-vs-sync.mjs`** — four-benchmark harness per RFC §12
  (event-loop responsiveness, small-query latency, large-result
  transport, appender throughput). On a 2024 M-series Mac:
  - Responsiveness: sync 0% / async ~90% of expected ticks
  - Small queries: sync ~22k ops/s / async ~16k ops/s (~25% overhead)
  - 1M-row iterate: sync ~250ms / async prefetch=1 ~380ms /
    prefetch=4 ~340ms
  - 100K-row appender: sync ~10M rows/s / async ~5M rows/s

### Acknowledged limitations

- **No cancellation in v0.4.** `AbortSignal` / `duckdb_interrupt()`
  is a planned future feature (see [RFC §16 #5](./docs/rfcs/0001-worker-async-api.md#16--open-questions--resolved-decisions)
  for the proven architecture). Users wanting bounded shutdown should
  use `db.close({ timeout })`.
- **One Worker per Database.** No Worker pooling. Heavy multi-tenant
  workloads should evaluate cost; revisit if needed in v0.4.x.
- **No `Transferable` optimization** for result transport.
  structuredClone for now; benchmark before optimizing.
- **Bun-only.** The async subpath uses `Worker` semantics that aren't
  perfectly portable to Node.

### Internal

- New files: `lib/async/index.mjs`, `lib/async/index.d.ts`,
  `lib/async/worker.mjs`, `lib/async/protocol.mjs`,
  `lib/async/protocol.d.ts`. Shared `ERROR_CLASSES` registry in
  `protocol.mjs` keeps error reconstruction in lockstep across the
  two threads.
- `package.json` `exports['./async']` + `files['lib/async/...']`.
- 44 new tests in `test/async/async.test.mjs` covering lazy open,
  queries, disposal, AsyncConnection, AsyncStatement (including
  iterate with prefetch 0/1/4), transactions (commit / rollback /
  nested / recovery), AsyncAppender (one-shot + streaming + 100k
  rows + poisoned state), close coordination, and type round-trip
  for `BLOB` / `Date` / `BIGINT`.
- Total test count: 134 main + 44 async = **178**.

### Roadmap note

The v0.4 RFC originally targeted `AbortSignal` for v0.5 and Windows
for v0.6. The actual sequence ended up different: v0.5 became core-
polish features (OpenOptions, pragma helpers, chunks, TxnHandle);
cancellation slid to v0.6+ and Windows to v0.7+. See README's Roadmap
section for the current plan.

## 0.3.0 — 2026-05-15

Streaming results via `Statement.iterate()` — pull rows one at a time
without materializing the full result set in memory. Also includes a
foundational lock-model refactor (per-Connection locks; was process-
global) that lets streams on one connection no longer block queries on
sibling connections.

### Added

- **`Statement.iterate(params?)`** — async-iterable streaming of query
  results. Holds the owning Connection's lock for the iterator's
  lifetime; concurrent queries on the same Connection queue behind the
  active iterator. For parallel streams, use multiple `db.connect()`s.
  - Cooperative cancellation: `break`/throw inside `for await`, an
    explicit `await it.return()`, or `await stmt.close()` /
    `conn.close()` / `db.close()` all unblock the iterator promptly
    and run the proper FFI destroy + lock-release in `finally`.
  - Pre-start `.return()` is safe: abandoning the iterator before the
    first `.next()` allocates no FFI handles and leaves the Statement
    immediately reusable.
  - Concurrent `.iterate()` on the same Statement throws `DuckDBError`
    ("already iterating"); `.all()`/`.get()`/`.run()` on a Statement
    with an active iterator likewise throws.
- **`Connection.iterate(sql, params?)`** and **`Database.iterate(sql,
  params?)`** — sugar that owns a temporary prepared Statement for the
  iterator's lifetime. Prepares LAZILY on first `.next()`, so
  abandoning the iterator without consuming it allocates no FFI
  resources.
- **`[Symbol.asyncDispose]`** on `Database`, `Connection`, and
  `Statement`. For streaming code, prefer `await using db =
  open(...)` — `Symbol.dispose` (sync) can't reliably wait for
  iterator cleanup, so it's now a best-effort fire-and-forget that
  routes through `close().catch(...)`.

### Changed (soft-breaking — see "Migration" below)

- **`Database.close()` / `Connection.close()` / `Statement.close()`
  are now `async`.** The public handle/`closed` getters still flip
  synchronously (so the v0.2 contract `obj.close(); obj.handle ===
  null` continues to hold without `await`), but the FFI destroy
  happens behind the returned Promise. Existing code using
  `db.close()` without `await` continues to work; new streaming code
  should `await close()` (or use `await using`) to be sure iterators
  have finished cleanup before subsequent code runs.
- **Connection lock is now per-Connection instead of process-global.**
  Previously every FFI call across every Connection serialized through
  one module-level promise queue, so two connections doing independent
  queries ran sequentially. Now each Connection has its own
  `AsyncMutex`; sibling connections execute concurrently. The new
  test `Per-Connection lock parallelism > iterator on conn A does not
  block queries on conn B` pins this behavior.
- **Connection close protocol** (per a fresh-review pass with GPT-5.5):
  `close()` first cancels any active iterator via `.return()` (so the
  iterator's `finally` releases the lock), then *re-acquires* the lock
  to perform `duckdb_disconnect` — under the lock, not after it. Any
  queries queued behind the iterator wake up inside their own
  withLock callback, see `state === 'closing'`, and abort with
  `DuckDBClosedError` before any FFI call. This eliminates a race
  the original design sketch left under-specified.

### Migration from v0.2.x to v0.3

| If you were doing… | Still works? | Recommended for v0.3 |
|---|---|---|
| `db.close()` (no await) | Yes — handle nulls sync | Add `await` if downstream code expects FFI cleanup done |
| `using db = open(...)` | Yes — best-effort | `await using db = open(...)` for full async cleanup |
| Materializing queries (`db.all/get/run`) | Yes, unchanged | Switch to `db.iterate(sql)` for large result sets |

### Internal

- New `AsyncMutex` class with two APIs: `withLock(fn)` for one-shot
  critical sections (replaces the old module-level `withLock`) and
  `acquire()` for lifetime locks (used by `iterate()`'s generator,
  which holds the lock across `yield` points).
- `Connection`/`Database`/`Statement` now carry a state machine
  (`'open' | 'closing' | 'closed'`) so callbacks queued behind a
  cancelling iterator can recheck state inside their own critical
  section and abort cleanly.
- `Connection.#extractChunks()` refactored into reusable helpers
  `_decodeColumnsMetadata(resultBuf)` and `_decodeChunkRows(chunk,
  cols)` — both the materializing path (`.all()`) and the streaming
  path (`.iterate()`) now share one column-decoder and one row-
  decoder implementation.

### Tests

- New `test/iterate.test.mjs` — 22 tests covering happy paths
  (in-order yield, parameter binding, chunk-boundary spanning, mixed
  null/blob row decoding), cleanup on early break / throw / explicit
  `.return()` / pre-start `.return()`, concurrency guards (second
  iterate throws, `.all()` during iterate throws), close coordination
  (`stmt.close()`/`conn.close()`/`db.close()` mid-iteration all
  resolve a paused `.next()` as `{ done: true }`), the sugar APIs,
  closed-state checks, and a stress loop (1000 short iterators).
- New `Per-Connection lock parallelism` test pinning the lock-model
  refactor.
- 134 total tests now passing (was 112).

## 0.2.3 — 2026-05-15

Intel-Mac (`darwin-x64`) shim now ships in the tarball, completing
the four-platform pre-built shim coverage promised since v0.2.1.

### Added

- **`lib/libduckdb-shim-darwin-x64.dylib`** is now bundled in the npm
  package. Intel-Mac users no longer need to run `make -C lib` after
  install — `bun add duckdb-bun` is everything you need on every
  supported platform now.

### CI

- New `make darwin-x64-from-arm64` target cross-compiles the Intel
  shim from any macOS host. Downloads DuckDB's universal libduckdb
  release, extracts the x86_64 slice with `lipo`, and links the shim
  with `clang -arch x86_64`. Result is a bit-for-bit equivalent dylib
  to one built natively on Intel.
- `release.yml` now produces the darwin-x64 shim from the macos-latest
  (Apple Silicon) runner via the cross-compile target, instead of
  spinning a separate macos-13 (Intel) job. GitHub's Intel runner
  pool is small enough to queue for hours; cross-compile sidesteps
  that entirely. Publish typically completes in 5–10 minutes now,
  with all four platform shims included.
- `test.yml` matrix shrunk back to 3 entries (linux-x64, linux-arm64,
  darwin-arm64). x86_64 coverage comes from release.yml's cross-
  compile path. If a future cross-compile vs. native runtime
  difference is suspected, add a one-off macos-13 smoke job back.

## 0.2.2 — 2026-05-15

Install-fix patch. v0.2.1 shipped pre-built shims for the first time,
but the macOS shim was unusable in practice — its `LC_RPATH` was
empty, so `dlopen` couldn't resolve `@rpath/libduckdb.dylib` at load
time and every `import` failed with `Library not loaded`. This
release also rolls in a documentation-correctness pass and fixes one
real data-corruption bug discovered while we were tightening the
type-mapping tables.

### Fixed

- **macOS shim now loads.** `lib/Makefile` now passes
  `-Wl,-rpath,/opt/homebrew/lib -Wl,-rpath,/usr/local/lib
  -Wl,-rpath,/usr/lib` when linking on Darwin (and the equivalent
  paths on Linux). The DuckDB-shipped `libduckdb.dylib` records its
  install_name as `@rpath/libduckdb.dylib`, so without these `LC_RPATH`
  entries on the shim the loader had no anchor to substitute. With
  the rpaths baked in, the shim resolves `libduckdb` at whichever
  standard path the user installed it (Apple Silicon Homebrew, Intel
  Homebrew, or system). Verified locally with `otool -l` showing
  three `LC_RPATH` entries on the rebuilt shim. **All v0.2.1 macOS
  users should upgrade to v0.2.2.**
- **`Connection.executeBatchPrepared(sql, batches)` now actually
  exists.** The method was documented in README/`.d.ts`/CHANGELOG since
  v0.1, but the runtime only exposed it under its original (undocumented)
  name `queryBatch`. The documented name is now the canonical one;
  `queryBatch` is retained as a back-compat alias.
- **`BLOB` columns now return `Uint8Array` (the documented contract)
  instead of a UTF-8 string.** The previous decoder ran blob bytes
  through `TextDecoder`, which replaced any non-UTF-8 byte with
  `U+FFFD` and silently corrupted binary data. The new path copies
  bytes out of DuckDB-owned vector memory verbatim, so the returned
  array is safe to retain across chunk destruction.
- **Parameter binding (and the Appender) now accepts `Uint8Array` /
  `ArrayBuffer` and binds them as `BLOB`** via `duckdb_bind_blob` /
  `duckdb_append_blob`. Previously these JS values fell through to
  `String(value)` and were bound as `VARCHAR` (`"72,69,76,..."` —
  comma-joined byte values), which silently corrupted the data. The
  README's parameter-binding table already advertised `Uint8Array →
  BLOB`, so this brings the runtime up to the documented contract.

### CI / Release

- `release.yml` restructured into three jobs: `build-shim-required`
  (Linux x64, Linux arm64, darwin-arm64), `build-shim-optional`
  (darwin-x64), and `publish` which depends only on the required
  shims. The Intel-Mac job runs in parallel and never blocks the
  publish — its shim ships in the tarball if it finishes by then,
  otherwise the tarball ships without it. Solves the v0.2.1 problem
  where a queued darwin-x64 runner blocked publish for hours.

### Changed

- **`README.md` and `AGENTS.md` type-mapping tables rewritten** to
  describe what the code actually returns. Notable corrections:
  `BIGINT`/`UBIGINT` → `number` (with explicit precision caveat at
  2^53); `HUGEINT`/`UHUGEINT`/`DECIMAL` → decimal `string`; `DATE` →
  `"YYYY-MM-DD"` string; `INTERVAL` → formatted `string`; `MAP` →
  plain `object` (not `Map`); `BIT`/`UNION` → `null` (not implemented).
  The `#readValue` docstring in `lib/duckdb.mjs` is the authoritative
  source — both tables are derived from it.
- **`examples/appender.mjs`** updated its `console.log` comment to
  reflect the actual decoded value (`{ n: 100000 }`, not `100000n`).

### Tests

- Added BLOB tests for: small (≤ 12 byte inline), large (> 12 byte
  pointer storage), empty, and non-UTF-8 byte sequences. Together they
  pin the byte-exact round-trip of `BLOB → Uint8Array`.
- Added a "bytes survive result destruction" test that holds onto a
  BLOB across many subsequent queries and asserts the bytes are still
  intact — locks in the copy-out-of-DuckDB-memory semantic.
- Added round-trip tests for binding `Uint8Array` / `ArrayBuffer` as
  BLOB (both via prepared parameters and via the Appender).
- Added `executeBatchPrepared` tests for: method existence, multi-row
  insert, empty batch, and the `queryBatch` alias.

## 0.2.1 — 2026-05-14

Install-friction patch. Pre-built shim binaries now ship in the npm
tarball for Linux x64 / Linux arm64 / macOS x64 / macOS arm64 — no
`make` step required after `bun add duckdb-bun`.

### Added

- Pre-built `lib/libduckdb-shim-{linux,darwin}-{x64,arm64}.{so,dylib}`
  bundled into the published package. Built per-platform by the new
  release workflow before publish.
- `.github/workflows/test.yml` expanded to a 4-platform matrix:
  Linux x64, Linux arm64 (free GitHub ARM runners), macOS x64,
  macOS arm64. Builds the shim, runs the test suite, smokes all
  three examples on every push.
- `.github/workflows/release.yml`: on tag push (`v*`), builds shims
  on all four platforms, bundles them, runs `npm publish` (if
  `NPM_TOKEN` secret is set), and creates a GitHub release with
  the tarball as an asset.
- `lib/Makefile` accepts `TAGGED=1` for platform-tagged output
  (e.g. `libduckdb-shim-linux-x64.so`); CI uses this to produce
  the artifacts that get bundled.

### Changed

- `findShimLibrary()` lookup priority updated to prefer the
  platform-tagged shim that ships in the package, with fallbacks
  for source-clone users (`make -C lib`) and historical install
  locations.

### Internal

- 13 files changed in the previous release polish; this patch is
  install-experience only — no public API change.

## 0.2.0 — 2026-05-14

First substantive release. v0.1 was a minimal extracted FFI binding;
v0.2 adds the polish that turns it into a real driver. All changes
are additive — no breaking changes from the v0.1 surface.

### Added

- **Database & Connection shortcuts** mirroring `better-sqlite3` /
  `bun:sqlite` conventions:
  - `db.query(sql, params?)` / `db.all(sql, params?)` — full
    `QueryResult` (rows + columns + `rowsChanged`)
  - `db.get(sql, params?)` — first row, or `undefined`
  - `db.run(sql, params?)` — `{ rowsChanged }` for DML
  - `db.exec(sql)` — fire-and-forget multi-statement, no params
  - `db.prepare(sql)` — reusable `Statement`
  - `db.transaction(fn)` — auto BEGIN / COMMIT / ROLLBACK
  - All seven also available on `Connection` directly
- **`Statement` class** — reusable prepared statement with
  `.all/.get/.run/.close`, `[Symbol.dispose]`, `closed` getter.
  Reuses one prepared handle across executes; `clearBindings`
  between binds prevents parameter leakage.
- **Lazy implicit Connection on `Database`** — Symbol-keyed slot,
  non-enumerable, created on first shortcut call, closed by
  `db.close()`.
- **`Symbol.dispose`** on `Database`, `Connection`, `Statement` —
  enables `using db = open(...)` and `using stmt = await db.prepare(...)`.
- **TypeScript declarations** (`lib/duckdb.d.ts`) — hand-written,
  generic `<T extends Row>` for row-shaping, intersection type
  for `QueryResult`, full coverage of public API and error classes.
  Wired in `package.json` exports map.
- **Named error classes** — `DuckDBError`, `DuckDBClosedError`,
  `DuckDBPrepareError`, `DuckDBTransactionError`. All extend
  `DuckDBError`; safe to discriminate via `instanceof`.
- **Examples** — `examples/basic.mjs`, `examples/prepared.mjs`
  (existing `examples/appender.mjs` retained).
- **Test reorganization** — split into seven topical files
  (`test/lifecycle.test.mjs`, `queries.test.mjs`,
  `statements.test.mjs`, `transactions.test.mjs`, `types.test.mjs`,
  `appender.test.mjs`, `errors.test.mjs`) plus shared
  `test/helpers.mjs`.
- **CI** — GitHub Actions workflow runs the test suite on Linux and
  macOS against a real `libduckdb`.

### Fixed

- `Connection.close()` now cascades to outstanding `Statement`s,
  preventing prepared-statement handle leaks
- A closed `Database` no longer silently re-creates an implicit
  `Connection` on the next shortcut call (throws
  `DuckDBClosedError` instead)
- `Statement.all()` and `Connection.prepare()` are `async function`
  so the closed-state check rejects via Promise (matching what
  `await stmt.all(...)` callers expect)

### Internal

- Connection's prepared-statement execution path extracted to
  `_executePreparedSync(stmtHandle, params)` so `Statement` and
  the legacy one-shot `query()` share a single canonical
  bind+execute+extract code path
- `lib/duckdb.d.ts` includes `INVALID: 0` in the `DUCKDB_TYPE`
  declaration to match runtime

## 0.1.0 — 2026-05-13

Initial extraction from rip-lang. Pure Bun FFI binding to
`libduckdb`'s C API.

### Added

- `open(path)` returning `Database`
- `version()` returning the libduckdb version string
- `Database` class with `connect()` and `close()`
- `Connection` class with `query(sql, params?)`, `append(table, cols, rows)`,
  `executeBatchPrepared(sql, batches)`, `countStatements(sql)`, `close()`
- `DUCKDB_TYPE` constant table
- Chunk-based result reading with type-aware decoding for all major
  DuckDB types (integers, floats, strings, BLOB, temporal, UUID,
  DECIMAL, ENUM, LIST, STRUCT, MAP, ARRAY, NULL handling)
- Linux x86_64 FFI bug workarounds (handle-as-BigInt) +
  `lib/duckdb-shim.c` for struct-by-value functions
