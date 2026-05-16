# Contributing to duckdb-bun

Thanks for considering a contribution. This driver tries to stay small,
honest, and maintainable. The goals below should make most decisions
obvious; the rest is taste.

## Quick start

```bash
git clone https://github.com/shreeve/duckdb-bun
cd duckdb-bun

# DuckDB is a runtime requirement (not bundled).
brew install duckdb              # macOS
# sudo apt install libduckdb-dev # Debian/Ubuntu

# Build the FFI shim (one-time per platform)
make -C lib

# Run the test suite
bun test                          # ~230 tests, ~2.5s

# Smoke the examples
bun examples/basic.mjs
bun examples/prepared.mjs
bun examples/appender.mjs
bun examples/iterate.mjs
bun examples/async.mjs
```

If `libduckdb` isn't installed, `bun test` skips cleanly via
`describe.skip` — CI machines without DuckDB still see green.

## Project shape

| What | Where |
|---|---|
| Main-thread driver | `lib/duckdb.mjs` (~2500 lines, single file) |
| Async-subpath proxy | `lib/async/{index,worker,protocol}.{mjs,d.ts}` |
| FFI shim source | `lib/duckdb-shim.c` (works around a Bun struct-by-value ABI bug) |
| TypeScript declarations | `lib/duckdb.d.ts`, `lib/async/*.d.ts` (hand-written) |
| Tests, by topic | `test/{lifecycle,queries,statements,transactions,types,appender,errors,iterate,options}.test.mjs` |
| Async tests | `test/async/async.test.mjs` |
| Shared test setup | `test/helpers.mjs` |
| Examples | `examples/*.mjs` |
| Architecture notes | `AGENTS.md` (FFI bug knowledge, locking model, type contract — read this before any FFI work) |
| Design RFCs | `docs/rfcs/` (the v0.4 async subpath was designed in `0001-worker-async-api.md` first) |

## Conventions

- **Pure ESM, no build step for the JS.** `lib/duckdb.mjs` is shipped
  as-is. The TypeScript declarations are hand-maintained.
- **One file for the main-thread driver.** `lib/duckdb.mjs` is at
  ~2500 lines. Splitting is reasonable when the next risky change
  would touch many modules at once (e.g. a decoder rework). Resist
  splitting purely for line count.
- **No dependencies.** Not even devDependencies if avoidable. Pure
  Bun + libduckdb is the contract.
- **Every PR adds at least one test.** Tests live by topic in `test/`,
  not by code module.
- **No ORM features.** This is a driver. Models, migrations, query
  builders belong in companion packages (`duckdb-bun-kysely`,
  `duckdb-bun-drizzle`, etc.).
- **Update CHANGELOG.md** in the same PR as user-visible changes.
- **Document any FFI workarounds.** When you add a binding for a new
  DuckDB function, leave a comment if the FFI declaration deviates
  from the obvious shape (Bun bugs, ABI quirks, opaque-handle
  conventions). See `AGENTS.md` for the existing patterns.

## Adding a new DuckDB C API binding

1. Find the C signature in DuckDB's docs:
   <https://duckdb.org/docs/api/c/overview>
2. Add the FFI declaration to the `dlopen` block in `lib/duckdb.mjs`.
   Match the **FFI Declaration Rules** table in `AGENTS.md`.
3. If the function takes a struct by value, add a wrapper to
   `lib/duckdb-shim.c` and rebuild with `make -C lib`.
4. Wire the JS API as a method on `Database`, `Connection`, or
   `Statement`. Always go through `withLock(...)` for connection-
   level operations.
5. Add type declarations in `lib/duckdb.d.ts`.
6. Add at least one test in the appropriate `test/*.test.mjs` file.

## Reporting bugs

Please include:

- Bun version (`bun --version`)
- DuckDB version (`bun -e 'import { version } from "duckdb-bun"; console.log(version())'`)
- OS + architecture (e.g. `macOS arm64`, `Linux x86_64`)
- A minimal reproducer (an `examples/`-style script that triggers the bug)
- Stack trace or expected vs actual behavior

## Pull requests

- One concern per PR
- Tests pass: `bun test`
- README + CHANGELOG updated for user-visible changes
- Commit messages explain *why*, not just *what*

By contributing you agree that your contributions will be licensed
under the same MIT License that covers the project.
