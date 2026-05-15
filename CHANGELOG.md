# Changelog

All notable changes documented here. Versioning follows
[semver](https://semver.org/) — `0.x` releases may make breaking changes
between minor versions until the `1.0.0` API freeze.

## 0.2.1 — 2026-05-14

Install-friction patch. Pre-built shim binaries now ship in the npm
tarball for Linux x64 / Linux arm64 / macOS x64 / macOS arm64 — no
`make` step required after `bun add bun-duckdb`.

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
