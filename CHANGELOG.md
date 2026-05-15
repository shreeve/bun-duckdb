# Changelog

All notable changes documented here. Versioning follows
[semver](https://semver.org/) — `0.x` releases may make breaking changes
between minor versions until the `1.0.0` API freeze.

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
  HANDOFF.md's earlier sketch left under-specified.

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
