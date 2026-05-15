# Handoff: duckdb-bun → v0.3+

> **Purpose:** This is the SOLE briefing for the next AI agent picking up
> `duckdb-bun` after the v0.2.3 release. Read it in full **before**
> writing code. Especially the **MUST / DO NOT** rules in §3.
>
> Reviewed and improved with GPT-5.5 collaboration on 2026-05-15.
> If you're updating this doc later, run another fresh review pass.

---

## §1 · TL;DR

`duckdb-bun` is a Bun-native FFI driver for DuckDB. dlopens `libduckdb`
through `bun:ffi`, no node-gyp, no native build. v0.2.3 ships
pre-built C shims for 4 platforms; install is one command.

```bash
bun add duckdb-bun
brew install duckdb        # or: download from duckdb.org/docs/installation
```

```js
import { open } from 'duckdb-bun';
using db = open(':memory:');
const rows = await db.all('SELECT 42 AS n');
```

| Where | What |
|---|---|
| **Repo** | <https://github.com/shreeve/duckdb-bun> |
| **Local** | `/Users/shreeve/Data/Code/duckdb-bun` |
| **npm** | <https://www.npmjs.com/package/duckdb-bun> |
| **Driver** | one file, `lib/duckdb.mjs` (~1500 lines) |
| **C shim** | one file, `lib/duckdb-shim.c` (~30 lines) |
| **Tests** | 112 passing across 7 topical files |
| **Platforms shipped** | linux-x64, linux-arm64, darwin-arm64, darwin-x64 |
| **Platforms NOT yet** | win32-x64 |
| **CI** | 3-platform per-push test, 4-platform tag-driven release |

What's loosely promised in CHANGELOG/README but not yet built:

| Promise | Target version | Status |
|---|---|---|
| `Statement.iterate()` streaming | v0.3.0 | open |
| `duckdb-bun/async` worker subpath | v0.4.0 | open |
| Windows x86_64 support | v0.5.0 | open |

You're being asked to ship those three, in that order, each as a
separate release. **All three already have opinionated defaults
codified in §6–§8 — read those before designing.**

---

## §2 · Quickstart for the next agent

Do these four things in order, before touching code:

1. **Read this entire HANDOFF.md.** Especially §3.
2. **Read `AGENTS.md` end-to-end.** The FFI bug section is the
   single most important piece of knowledge in this codebase.
3. **Run the test suite locally:**
   ```bash
   cd /Users/shreeve/Data/Code/duckdb-bun
   make -C lib                      # build local C shim
   bun test                         # must show 112/112 passing
   ```
   If anything is red, fix that first; do not write code on a
   broken baseline.
4. **Verify clean working tree:** `git status --short` should be
   empty. If not, deal with it before starting work (see §5 on
   parallel-session hazards).

Then pick exactly one work item (start with v0.3.0), ship it
end-to-end (code + tests + CHANGELOG + version bump + tag + verify
on npm + smoke-test in fresh tempdir), and don't start the next
until the previous is fully shipped.

---

## §3 · MUST / DO NOT rules

These are non-negotiable. Most are hard-won knowledge that exists
nowhere else publicly. **Verify each before any change in the
affected area.**

### MUST · FFI discipline

1. **Opaque DuckDB handles flow as `'u64'` / BigInt, never as
   `'ptr'` / Number.** Bun FFI corrupts JS numbers passed as
   `'ptr'` arguments on Linux x64 (segfault address
   `0xFFFFFFFFFFFFFFFF`). See `AGENTS.md § Bug 1`. Every new FFI
   declaration must follow the table in `AGENTS.md § FFI
   Declaration Rules`.
2. **The C shim wraps the three DuckDB by-value functions
   (`duckdb_fetch_chunk`, `duckdb_fetch_chunk_destroy`,
   `duckdb_result_get_chunk`) — DO NOT remove it.** Linux x86_64
   SysV AMD64 ABI classifies the 48-byte `duckdb_result` struct as
   MEMORY; Bun FFI can't pass it by value. The shim takes a
   pointer and dereferences. See `AGENTS.md § Bug 2`.
3. **Every connection-level FFI call must hold the connection
   mutex, with one explicit exception: the close/disconnect path
   (see §6 close protocol).** Rules:
   - **Short async operations:** use the existing `withLock(fn)`
     wrapper. The `fn` callback should not contain arbitrary
     `await`s — the lock is held for `fn`'s entire duration. Long
     awaits inside `withLock` block other queries.
   - **Streaming/lifetime locks (§6 iterator):** use the explicit
     `acquireLock()` / `releaseLock()` primitive. Provide
     `withLock`-free internal paths (`_xUnlocked()` variants) so
     helpers called while the lifetime lock is already held don't
     double-lock and deadlock.
   - **Sync FFI methods that can't `await`** (e.g.
     `Appender.appendRow`): use `tryLock()` and throw
     `DuckDBError('connection busy — close active iterator first')`
     if it fails.
   - **After acquiring the lock**, always re-check `this.closed`
     before any FFI — `close()` can have flipped the flag while
     you were waiting for the mutex. If closed, abort cleanly
     (return early or reject with `DuckDBClosedError`, depending
     on context).
   - **The close/disconnect path is the exception:** `close()`
     does NOT take the lock (would deadlock behind held
     iterators). Instead, it sets `closed = true` synchronously,
     forces active iterators to `.return()` (which releases their
     lock and runs cleanup finally), then proceeds to FFI
     destroy. Queued waiters wake up after the iterator's lock
     release, see `closed === true` from rule above, and abort.
     See §6 for the full sequence.
4. **Every `duckdb_*_create` / `duckdb_open` / `duckdb_query` /
   `duckdb_prepare` / `duckdb_appender_create` MUST be paired with
   its corresponding `_destroy` / `_close`.**

### MUST · macOS dynamic linking

5. **Keep `-Wl,-rpath,/opt/homebrew/lib -Wl,-rpath,/usr/local/lib
   -Wl,-rpath,/usr/lib` in the macOS Makefile path.**
   `libduckdb.dylib` from `libduckdb-osx-universal.zip` has
   `install_name = @rpath/libduckdb.dylib`. Without `LC_RPATH`
   entries on the shim, dlopen has nothing to substitute. v0.2.1
   shipped without these and broke immediately.
6. **The darwin-x64 shim is cross-compiled from the macos-latest
   (Apple Silicon) runner via `make -C lib darwin-x64-from-arm64`.**
   GitHub's macos-13 (Intel) runner pool routinely queues jobs for
   5+ hours. DO NOT add the macos-13 runner back to the matrix as
   a workaround for any problem unless you have proof the
   cross-compile is producing a divergent binary.

### MUST · Release discipline

7. **`package.json` `version` MUST match the git tag.** The
   release workflow's `Verify package version matches tag` step
   enforces this — bump `package.json` first, commit, then tag.
8. **CHANGELOG entry written before tagging, not after.** Format:
   `## X.Y.Z — YYYY-MM-DD` header, then "Added/Changed/Fixed/CI"
   sections. Tone: terse but specific. Says *why*, not just *what*.
9. **Pre-tag checklist (run all four):**
   ```bash
   git status --short                                                # MUST be empty
   bun test                                                          # MUST be 112/112 (or higher)
   npm pack --dry-run                                                # inspect file list
   gh run list --workflow test.yml --commit "$(git rev-parse HEAD)"  # MUST show success for current SHA
   ```
   The `--commit` filter pins the check to the SHA you're about to
   tag; the bare `--limit 1` form is unreliable if other commits
   landed in parallel. Then `git tag vX.Y.Z && git push origin vX.Y.Z`.
10. **DO NOT use `git add -A`.** Always use explicit file paths
    (`git add file1 file2 file3`). Parallel agent sessions WILL
    leave WIP changes you don't know about; `git add -A` sweeps
    them in and your commit message becomes a lie. This actually
    happened during the v0.2 work.

### MUST · Test discipline

11. **`bun test` MUST be green before any commit, full stop.**
12. **New features need new tests** in the appropriate
    `test/*.test.mjs` file. The seven topical files:
    `lifecycle`, `queries`, `statements`, `transactions`, `types`,
    `appender`, `errors`. Add a new file for a new topic.
13. **Examples (`examples/*.mjs`) are smoke-tested in CI.** Don't
    add an example you wouldn't run in CI; don't break an existing
    example without updating it.

### DO NOT · Common landmines

- DO NOT publish locally except for emergencies. CI is the path.
- DO NOT `npm unpublish` to fix a broken release; use `npm
  deprecate` (see §5 release flow).
- DO NOT amend or rebase commits you didn't create in the current
  session — they may be from a parallel agent session.
- DO NOT widen the FFI surface without re-reading AGENTS.md §
  FFI Declaration Rules. **If you add or change an FFI signature
  without reading that section first, stop.**
- DO NOT push tags before the CI for that SHA goes green. (See
  rule #9.)
- DO NOT bundle `libduckdb` itself into the npm package. We ship
  only the shim. Users install libduckdb separately via brew, apt,
  or the official zip. (Future Windows support: see §8 for the DLL
  question.)

---

## §4 · v0.2.3 public API contract (don't regress these)

Any change that breaks one of these without a major version bump
is a contract violation. Use this as a regression checklist when
shipping v0.3+.

| API | Surface |
|---|---|
| `open(path, opts?)` | sync, returns `Database` |
| `version()` | returns DuckDB version string |
| `Database` | `.query/.all/.get/.run/.exec/.prepare/.transaction` (all async); `.connect()` (sync); `[Symbol.dispose]`; `.close()` |
| `Connection` | same query methods + explicit lifecycle; `.append(table)` returns `Appender`; `[Symbol.dispose]` |
| `Statement` | `.all/.get/.run/.close` (all async); `.closed` getter; `[Symbol.dispose]` |
| `Appender` | `.appendRow(values)` (sync); `.flush()` (async); `.close()` (async) |
| Errors | `DuckDBError`, `DuckDBClosedError`, `DuckDBPrepareError`, `DuckDBTransactionError` (all extend `DuckDBError`) |
| TS types | `Row`, `BindParam`, `QueryResult<T>`, `OpenOptions`, etc. — see `lib/duckdb.d.ts` |
| Subpaths | only `duckdb-bun` (root). v0.4.0 will add `duckdb-bun/async` |
| Shim discovery | `findShimLibrary()` order: `$DUCKDB_SHIM_PATH` → tagged platform shim → untagged shim → next to libduckdb |

---

## §5 · Operational flow

### Per-feature loop

```bash
# Develop
bun test                                  # repeatedly, fast feedback
bun test test/<topic>.test.mjs            # focused
bun examples/basic.mjs                    # smoke test

# Locally cross-compile darwin-x64 (verify Intel-Mac path on Apple Silicon)
make -C lib darwin-x64-from-arm64
file lib/libduckdb-shim-darwin-x64.dylib  # should say "Mach-O … x86_64"
otool -l lib/libduckdb-shim-darwin-x64.dylib | grep -A 1 LC_RPATH
```

### Release flow (when v0.3.0 is ready)

```bash
# 1. Bump version
#    Edit package.json: "version": "0.3.0"

# 2. Update CHANGELOG.md with new section at top

# 3. Pre-tag checklist (MUST do all four)
git status --short                                                  # empty
bun test                                                            # all green
npm pack --dry-run                                                  # files OK?
git push origin main                                                # push commits first
gh run watch                                                        # wait for test.yml green
gh run list --workflow test.yml --commit "$(git rev-parse HEAD)"    # confirm green is for THIS sha

# 4. Tag and push
git tag v0.3.0
git push origin v0.3.0

# 5. release.yml fires automatically. Watch it.
gh run watch

# 6. Verify on npm
npm view duckdb-bun versions

# 7. Smoke test from fresh tempdir
mkdir -p /tmp/duckdb-bun-smoke && cd /tmp/duckdb-bun-smoke
echo '{ "type": "module" }' > package.json
bun add duckdb-bun@0.3.0
bun -e "import { open } from 'duckdb-bun'; using db = open(':memory:'); console.log(await db.get('SELECT 42 AS n'));"
```

### If a release breaks after publish

1. **DO NOT** `npm unpublish`.
2. Bump patch, fix bug, ship the fix.
3. Then deprecate the broken version:
   ```bash
   npm deprecate duckdb-bun@X.Y.Z "<short reason; point at fixed version>"
   npm view duckdb-bun@X.Y.Z deprecated   # verify
   ```
4. Add a "Fixed in vX.Y.Z+1" note to the broken version's
   CHANGELOG entry retroactively.

### If CI fails BEFORE npm publish (tag pushed, publish job failed)

Safe to delete the tag and retry — nothing was published yet:

```bash
git tag -d v0.3.0
git push origin :refs/tags/v0.3.0
# fix the issue
git tag v0.3.0
git push origin v0.3.0
```

### If npm publish PARTIALLY succeeded

(Tarball published but GitHub release didn't get created, etc.)

The npm version is now permanent. **Don't reuse the version
number.** Bump patch, ship a fixed full release.

### Parallel-session hazards

The repo has been edited by parallel AI sessions before; **rule
#10** (no `git add -A`) was created because of one such incident.
To minimize collisions:

- **Run `git status` before editing** and again before committing.
- **Use explicit file paths in `git add`.** Always.
- **Coordinate ownership of `lib/duckdb.mjs`** — that's the file
  most likely to have parallel edits since it's the entire driver.
  If you see `M lib/duckdb.mjs` and you didn't edit it, stop and
  ask before committing.
- **Don't amend commits you didn't create in this session.** If
  you're tempted to amend, check `git log -1 --format='%an %ae'`
  first — if the committer isn't you (within this session), don't.
- For larger work (worker subpath, Windows port), consider working
  in a feature branch and merging only when ready.

### Ship checklist (paste into commit message body)

```
- [ ] code change in lib/duckdb.mjs
- [ ] type updates in lib/duckdb.d.ts
- [ ] tests added/updated and bun test green
- [ ] CHANGELOG entry written
- [ ] package.json version bumped
- [ ] npm pack --dry-run inspected
- [ ] CI green on this SHA before tagging
```

---

## §6 · Work item 1 — `Statement.iterate()` (v0.3.0)

### Goal

Stream large result sets without materializing in memory. Mirror
existing `.all()` row-decoding semantics exactly.

### Public API

```ts
// Statement (the primary API)
iterate<T extends Row = Row>(params?: BindParam[]): AsyncIterableIterator<T>;

// Sugar on Connection / Database (v0.3.0 also includes these)
iterate<T extends Row = Row>(sql: string, params?: BindParam[]): AsyncIterableIterator<T>;
```

(Return type is `AsyncIterableIterator<T>`, not `AsyncIterable<T>`,
so consumers can call `.return()` explicitly when needed for
cleanup.)

### DEFAULT design decisions (do these unless you have a strong reason)

| Question | DEFAULT | Why |
|---|---|---|
| Sync or async iterator? | **Async only** (`AsyncIterable`). | The chunk fetch is sync FFI but consumers want to `await` between rows. Sync iteration adds no value and forces API duplication. |
| Yield row-by-row or chunk-by-chunk? | **Row-by-row externally**, but internally fetch one chunk at a time and walk rows from the buffer. | Best of both: efficient FFI, simple consumer API. |
| Connection lock duration? | **Hold the connection lock for the entire iterator lifetime.** | DuckDB does NOT generally allow interleaving operations on a single connection mid-result-stream. Concurrent reads safety means *separate connections*. Releasing the lock between chunks is a correctness hazard. Users who need parallelism should `db.connect()` to get separate connections. **See "Close mid-iteration" rule below for the deadlock corollary.** |
| Multiple concurrent iterators on same Statement? | **Throw `DuckDBError` on second iterate.** | DuckDB result handles aren't reentrant. Add a private `#executing` flag on Statement; set **synchronously when `.iterate()` is called** (before the generator is awaited — see implementation note below); cleared on completion / error / `.return()` / parent close. The same flag must also block `.all()`/`.get()`/`.run()` while an iterator is active. |
| Behavior if Connection/Statement closed mid-iteration? | See **MUST · Close coordination** below — there's a real liveness pitfall here that needs an active `.return()` push, not just a cooperative flag check. | A paused generator (suspended at `yield`) won't run any cleanup code by itself. Close must actively unblock it. |
| Empty result? | Loop body never runs (yields nothing). | Standard async-iterable semantics. |
| Type parameter? | `<T extends Row = Row>` generic, same shape as `.all<T>()`. | Consistency. |
| Database/Connection sugar in v0.3.0? | **Yes, ship both.** Sugar prepares an internal `Statement` and the iterator owns it — must close it in the iterator's `finally`. **MUST lazy-prepare:** create the prepared statement **inside** the generator body on first `.next()`, not in the sync wrapper. Otherwise pre-start `.return()` leaks the prepared handle (the same trap that bites Statement.iterate()). | DX win, but "trivial wrapper" is misleading — own the lifecycle. |
| `Database.close()` / `Connection.close()` async or sync? | **MUST become `async`** to coordinate with active iterators. **This is a mild API change from v0.2.3** (where `Database.close()` was sync). Document loudly in CHANGELOG; the v0.2.3 callers using `db.close()` without `await` will silently work but won't wait for iterator cleanup before continuing. `Statement.close()` and `Appender.close()` were already async. `[Symbol.dispose]` (sync) stays best-effort. | Required for safe iterator cleanup. The alternative — forbidding close during active iteration — is a worse user experience. |

### MUST · Resource cleanup pattern

This is the most important code in v0.3.0. Three subtle bugs are
easy to make here. Read all three notes before writing the
implementation.

**Note 1 — `iterate()` is NOT itself an async generator.** It's a
regular method that does the synchronous gating (closed-state and
`#executing` checks), sets `#executing = true`, registers the
generator in `#activeIterator`, and returns an inner
`#iterateImpl()` async generator. If you make `iterate()` itself
the `async function*`, the body doesn't run until the consumer's
first `.next()` call — meaning `#executing` won't be set in time
to block a same-tick `.all()` call.

**Note 1a — Pre-start cleanup.** If the consumer never calls
`.next()` (just calls `.return()` immediately, or abandons the
iterator entirely and triggers `close()`), the generator's
`finally` block never runs because the body never started. The
`iterate()` wrapper must therefore return a custom
`AsyncIterableIterator` whose `.return()` checks `#started` — if
the generator hasn't started, the wrapper clears `#executing` and
`#activeIterator` itself, then resolves. The pseudo-code below
includes this wrapper layer.

**Note 2 — The `try/finally` for cleanup must wrap the lock
acquisition, not start after it.** Otherwise, if `acquireLock()`
rejects, `#executing` stays `true` forever and the statement is
permanently bricked.

**Note 3 — Use nested `try/finally`** so chunks are destroyed even
when the consumer breaks mid-chunk.

```js
// Public method: synchronous gates run BEFORE returning the iterator
iterate(params) {
  if (this.#closed)    throw new DuckDBClosedError(...);
  if (this.#executing) throw new DuckDBError('Statement already executing');
  this.#executing = true;

  const gen = this.#iterateImpl(params);   // generator object; body NOT yet running
  let started  = false;
  let finished = false;
  const self   = this;

  // Wrap so we can intercept .return()/.throw() before the body has started,
  // and so we expose a stable terminal state (finished) — without these,
  // a post-return .next() could re-enter the generator.
  const wrapper = {
    [Symbol.asyncIterator]() { return wrapper; },

    async next(...args) {
      if (finished) return { value: undefined, done: true };
      started = true;
      return gen.next(...args);
    },

    async return(value) {
      if (finished) return { value, done: true };
      finished = true;
      if (!started) {
        // Generator never ran — its finally won't fire; clean up here.
        // Also call gen.return() to dispose the generator object itself.
        self.#executing      = false;
        self.#activeIterator = null;
        try { await gen.return?.(value); } catch { /* never started */ }
        return { value, done: true };
      }
      return gen.return(value);
    },

    async throw(err) {
      if (finished) throw err;
      finished = true;
      if (!started) {
        // Symmetric to return: generator never ran, clean up our state
        // and let gen.throw close the generator. The throw still surfaces.
        self.#executing      = false;
        self.#activeIterator = null;
      }
      started = true;
      return gen.throw(err);
    },
  };
  this.#activeIterator = wrapper;
  return wrapper;
}

// Private generator: does all the work. Note: any helpers it calls
// (e.g. #beginExecute, fetchChunk, destroyChunk, destroyResult) MUST
// NOT take the connection lock themselves — we're already holding it.
// Provide _executePreparedUnlocked / _beginExecuteUnlocked variants if
// the existing helpers wrap themselves in withLock().
async *#iterateImpl(params) {
  let locked    = false;
  let resultPtr = 0;

  try {
    await this.#conn.acquireLock();
    locked = true;

    // §3 rule: post-acquire closed recheck. close() may have flipped
    // the flag while we were waiting for the mutex.
    if (this.#closed || this.#conn.closed) {
      return;   // resolves the consumer's pending .next() as { done: true }
    }

    resultPtr = this.#beginExecuteUnlocked(params);   // bind + execute_prepared
    const columns = decodeColumnsMetadata(resultPtr);
    const chunkBuf = allocPtr();

    while (true) {
      // Cooperative cancellation point: close() sets #closed.
      // (close() also calls wrapper.return() which forces unblock from
      // a paused yield — see "Close coordination" below.)
      if (this.#closed || this.#conn.closed) break;

      const chunk = fetchChunk(resultPtr);
      if (!chunk) break;

      try {
        const chunkSize = Number(lib.duckdb_data_chunk_get_size(chunk));
        if (chunkSize === 0) break;

        const colData = [...]; const colValidity = [...];
        for (let r = 0; r < chunkSize; r++) {
          const row = {};
          for (let c = 0; c < columns.length; c++) {
            row[columns[c].name] = isValid(colValidity[c], r)
              ? this.#readValue(colData[c], r, columns[c].type, columns[c], colVec[c])
              : null;
          }
          yield row;          // consumer can break here — both finallys run
        }
      } finally {
        destroyChunk(chunk, chunkBuf);
      }
    }
  } finally {
    // Defensive: even if destroyResult ever throws, we MUST release
    // the lock and clear executing — otherwise the connection is
    // bricked. Wrap each cleanup step so one failure can't skip the
    // others.
    try { if (resultPtr) destroyResult(resultPtr); } catch { /* swallow */ }
    this.#executing      = false;
    this.#activeIterator = null;
    if (locked) {
      try { this.#conn.releaseLock(); } catch { /* swallow */ }
    }
    // If close() was awaiting this iterator's exit, this is where it unblocks.
  }
}
```

**Locking primitive.** The existing `withLock(fn)` wrapper assumes
sync callbacks returning before yielding control. For lifetime
locks across awaits you need a queue-based async mutex
(`acquireLock()` returns a Promise; `releaseLock()` resolves the
next waiter). Implement it once, in `lib/duckdb.mjs`, as a private
`AsyncMutex` class. Don't re-enter it from inside its own holder.

**MUST · Close coordination.** This is the trickiest part of
v0.3.0. A paused generator (suspended at a `yield` waiting for
`.next()`) does not check `#closed` and does not run any
`finally` blocks until something resumes or returns it. So a
purely cooperative close-flag check **does not work** — `close()`
would hang forever on a paused-and-abandoned iterator.

The correct close protocol:

1. **Statement keeps a reference to the active iterator wrapper**
   in `#activeIterator` (set in `iterate()`, cleared in the
   generator's outer `finally` AND in the wrapper's pre-start
   `.return()` path).
2. `close()` (on Statement, Connection, or Database) is **async**:
   a. Set `#closed = true` synchronously.
   b. If there's an active iterator (`this.#activeIterator !==
      null`), call `await this.#activeIterator.return()`. This:
      - For a started+paused generator: forces the pending
        `.next()` to resolve with `{ done: true }` and runs the
        generator's `finally` blocks (destroying the chunk,
        destroying the result, releasing the connection lock).
      - For a not-yet-started generator: triggers the wrapper's
        pre-start cleanup path.
   c. By the time `.return()`'s promise resolves, the lock is
      released and `#executing` is false.
   d. **Now** safe to call `duckdb_disconnect` / `_destroy_prepare`
      / `duckdb_close` FFI.
3. `close()` MUST NOT itself take the connection lock — if it
   did, it would queue behind the iterator that's holding it,
   creating the original deadlock. The `.return()` mechanism
   bypasses the lock by using async-generator control flow.

**API impact:** This requires `Database.close()` and
`Connection.close()` to be `async`. v0.2.3 had `Database.close()`
sync. **This is a soft breaking change** — callers using
`db.close()` without `await` will continue to work but won't wait
for iterator cleanup before subsequent code. Document this loudly
in the v0.3.0 CHANGELOG. `[Symbol.dispose]` (sync) stays as a
best-effort fallback that doesn't await.

Edge case: what does the consumer's pending `.next()` see?
`AsyncGenerator.return()` resolves it as `{ done: true }`, not as
a throw. **Document this behavior explicitly:** if the consumer
wants to know the iterator was closed (vs naturally exhausted),
they should check `stmt.closed` after the loop, or use the
sentinel pattern. *Don't* try to make `.next()` reject —
overriding async-generator semantics is fragile.

For consumers who need throw-on-cancel semantics, document the
explicit pattern:

```js
for await (const row of stmt.iterate()) { ... }
if (stmt.closed) throw new DuckDBClosedError('cancelled mid-iteration');
```

### Tests to add

Add to `test/statements.test.mjs` (or `test/iterate.test.mjs` if
it gets large):

- Yields all rows in order for known result set
- Works with `for await` loop
- **Cleanup on early `break` mid-chunk** (the critical test): run
  iterate, break after row 1 of chunk, then immediately run another
  query on the same statement/connection — must succeed
- Cleanup on explicit `.return()` from the iterator
- Connection/Statement close mid-iteration: terminates the
  iterator (resolves the pending `.next()` as `{ done: true }`),
  releases the lock, and marks `stmt.closed === true`. The
  consumer pattern `if (stmt.closed) throw ...` after the loop is
  the documented way to detect cancellation.
- Pre-start `.return()`: calling `.return()` on the iterator
  before any `.next()` clears `#executing` and `#activeIterator`,
  allowing immediate reuse of the statement.
- Pre-start `close()`: calling `stmt.close()` immediately after
  `stmt.iterate()` (before consumer's first `.next()`) succeeds
  and doesn't leave the statement bricked.
- Throws if a second iterate started while first is running
- Throws if `.all()` called on the same statement while iterate is
  running
- Empty result yields nothing
- Result with multiple chunks (>2048 rows) iterates correctly
  across chunk boundaries
- Stress: 1000 interrupted iterators in a loop, no crash/OOM
- All existing row-shape contracts hold (column names, NULLs,
  BLOBs, BIGINT, etc.) — duplicate a few key cases from
  `test/types.test.mjs`

### Estimated scope

2–3 hours including the new mutex primitive. Ship as v0.3.0 alone.

---

## §7 · Work item 2 — `duckdb-bun/async` (v0.4.0)

### Goal

Subpath import that runs queries on a Worker thread, so heavy
queries don't block Bun's event loop.

```ts
import { open } from 'duckdb-bun/async';
await using db = open(':memory:');           // async dispose, NOT bare `using`
const rows = await db.all('SELECT * FROM big_table');
```

(`await using` is required because the async subpath uses
`Symbol.asyncDispose`. Bare `using` would only fire the sync
best-effort fallback — see the disposal table below.)

### MUST · Pre-implementation step

**Write `docs/rfcs/0001-worker-async-api.md` BEFORE writing
implementation code.** Include the protocol skeleton, lifecycle
rules, and benchmark plan from below. Commit the RFC as its own
PR/commit before starting the implementation. The RFC is the
contract; iterating on docs is cheap, iterating on shipped APIs
isn't.

### DEFAULT architecture — DO NOT deviate without RFC update

| Decision | DEFAULT | Why |
|---|---|---|
| Worker topology | **One Worker per `Database`.** No worker pool in v0.4.0. | Pool is premature optimization. Start with the simplest model that works. |
| Where DuckDB FFI lives | **Exclusively inside the Worker.** Main thread never receives raw DuckDB handles. | FFI handles crossing isolate boundaries is fragile, undocumented in Bun, and couples to internals. Even if it technically works today, don't depend on it. |
| Main-thread objects | **Pure proxies** holding only opaque IDs (numeric or string) generated by the Worker. | Clean separation of concerns; lifecycle is owned by the Worker. |
| Result transport | **Structured clone via `postMessage`.** No `Transferable` optimization in v0.4.0. | Get correctness first; benchmark before optimizing. |
| Subpath layout | `lib/async/index.mjs` (main-thread proxy), `lib/async/worker.mjs` (worker entry), `lib/async/protocol.mjs` (message types) | Standard pattern. |
| Symbol.dispose semantics | **`Symbol.asyncDispose` (preferred)** + `Symbol.dispose` as a best-effort sync fallback. | Sync `using` cannot reliably wait for worker cleanup. |
| `open()` return | **Sync — returns proxy immediately. Worker spawn + `duckdb_open` happen lazily on first awaited operation, which rejects with the open error if it failed.** | Matches main-thread API shape. Initialization errors surface at first use, not at construction. |
| Appender support | **Yes in v0.4.0.** Batch rows in the proxy and send one message per batch (default batch = 1000 rows) to avoid one-message-per-row overhead. | Appender perf is a selling point. Don't ship async without it. |
| Streaming (`iterate`) | **Yes in v0.4.0** — pull-based protocol (see below). | v0.3.0 just shipped iterate; can't have async be a regression. |
| Cancellation (`AbortSignal`) | **DEFERRED to v0.5+ unless trivial.** State explicitly that v0.4.0 has no cancellation. | Avoid scope creep. |
| Concurrency on one Database | Worker serializes operations per-connection. | Same model as main-thread driver. |

### Message protocol (commit this skeleton in the RFC)

**Important:** put types in `lib/async/protocol.d.ts` (TypeScript
declarations) and runtime constants/helpers in
`lib/async/protocol.mjs` (plain JS). Don't put `export type` in
`.mjs` — this package ships source directly with no transpile
step.

```ts
// lib/async/protocol.d.ts

// Verify the actual import path before committing — `lib/duckdb.mjs`
// is the runtime, `lib/duckdb.d.ts` is the type contract. Using the
// package name ('duckdb-bun') is the safest portable form:
import type { OpenOptions, BindParam } from 'duckdb-bun';

// Target is a discriminated union so Extract<Target, ...> works.
export type Target =
  | { kind: 'db';   id: number }
  | { kind: 'conn'; id: number }
  | { kind: 'stmt'; id: number }
  | { kind: 'app';  id: number };

export type DbTarget   = Extract<Target, { kind: 'db' }>;
export type ConnTarget = Extract<Target, { kind: 'conn' }>;
export type StmtTarget = Extract<Target, { kind: 'stmt' }>;
export type AppTarget  = Extract<Target, { kind: 'app' }>;

// Some operations target either a Database (uses implicit conn) or an
// explicit Connection. Define the union once.
export type DbOrConn = DbTarget | ConnTarget;

export type Request =
  // ── lifecycle ─────────────────────────────────────────────────────
  | { id: number; op: 'open';         path: string; opts?: OpenOptions }                       // → { dbId }
  | { id: number; op: 'close';        target: Target }                                         // → ok (any kind)
  // ── connections ───────────────────────────────────────────────────
  | { id: number; op: 'connect';      target: DbTarget }                                       // → { connId }
  // ── one-shot queries (mirror Database/Connection methods) ─────────
  | { id: number; op: 'query';        target: DbOrConn;
                                      method: 'query'|'all'|'get'|'run'|'exec';
                                      sql: string; params?: BindParam[] }                       // → method-specific shape
  // ── prepared statements ───────────────────────────────────────────
  | { id: number; op: 'prepare';      target: DbOrConn; sql: string }                          // → { stmtId }
  | { id: number; op: 'stmtCall';     target: StmtTarget;
                                      method: 'all'|'get'|'run'; params?: BindParam[] }         // → method-specific shape
  // ── streaming (pull-based; no unsolicited pushes) ─────────────────
  | { id: number; op: 'iterStart';    target: StmtTarget; params?: BindParam[] }               // → { iterId, columns }
  | { id: number; op: 'iterNext';     iterId: number }                                         // → { rows, done }
  | { id: number; op: 'iterReturn';   iterId: number }                                         // → ok
  // ── appender ──────────────────────────────────────────────────────
  | { id: number; op: 'appendCreate'; target: DbOrConn; table: string }                        // → { appId }
  | { id: number; op: 'appendRows';   target: AppTarget; rows: unknown[][] }                   // batched
  | { id: number; op: 'appendFlush';  target: AppTarget }
  // ── transactions: see "Transaction semantics" below ───────────────
  | { id: number; op: 'txnBegin';     target: DbOrConn }                                       // → { txnConnId }
  | { id: number; op: 'txnCommit';    target: ConnTarget }
  | { id: number; op: 'txnRollback';  target: ConnTarget };

export type Response =
  | { id: number; ok: true;  value: unknown }
  | { id: number; ok: false; error: SerializedError };

export interface SerializedError {
  name: string;       // e.g. 'DuckDBClosedError' — used to reconstruct the right subclass
  message: string;
  stack?: string;
  code?: string;
}
```

**Rules for the protocol:**

- Every request has a unique numeric `id`. Response references it.
- `iterNext` is pull-based: the worker fetches one chunk per
  request and replies with `{ rows, done }`. Backpressure is
  automatic (consumer doesn't request next chunk until current
  one is drained). No unsolicited pushes.
- `iterReturn` cleans up the iterator on the worker side. Sent
  on consumer `break` / `.return()` / parent close.
- Errors are reconstructed on the main thread into the
  appropriate `DuckDB*Error` subclass via `error.name` lookup.
  Preserve `stack` as a string.

### Transaction semantics

DO NOT model transactions as a batch of `subOps`. The user's
callback can do arbitrary control flow based on intermediate
results, which a flat batch can't express.

DEFAULT design: `db.transaction(callback)` on the main-thread
proxy:
1. Sends `txnBegin` (worker reserves a fresh connection bound to
   the txn, returns `txnConnId`).
2. Invokes the user `callback(txProxy)` where `txProxy` is a
   Connection-shaped proxy whose `target` is `{ kind: 'conn',
   id: txnConnId }`. All ops the user calls go to that
   connection.
3. On callback resolve: sends `txnCommit`.
4. On callback reject: sends `txnRollback`, then rethrows.
5. The worker holds the connection open for the whole transaction
   and serializes the txn ops behind any other queries on that
   connection (which is automatic if it's a fresh dedicated conn).

This mirrors the main-thread API exactly; no surprising
divergence.

### Async appender batching

`appendRow()` on the async proxy stays synchronous (matches
main-thread API). The proxy buffers rows in memory and sends an
`appendRows` batch when:
- batch fills (DEFAULT batch size = 1000 rows; configurable via
  `db.connect().append(table, { batchSize: N })`)
- `flush()` or `close()` is called

**Error semantics:**
- `appendRow()` throws synchronously only for "appender already
  closed" or "previous batch failed and appender is poisoned".
- Errors from a sent batch are surfaced on the next `flush()` or
  `close()` (whichever the user awaits next). Track a "pending
  error" on the proxy; clear it when `close()` returns.
- After the first batch error, the appender enters "poisoned"
  state — subsequent `appendRow()` calls throw, `flush()` and
  `close()` reject with the original error.

### Concurrent lazy open

The proxy's `open()` returns synchronously. Worker spawn +
`duckdb_open` happen lazily on first awaited operation.

**MUST: a single `#openPromise` is shared across concurrent first
operations.** If three queries are issued in parallel before open
completes, all three await the same promise. If open fails, all
three reject with the (reconstructed) open error and the proxy
moves to "permanently closed" state.

```js
async #ensureOpen() {
  if (this.#opened)       return;
  if (this.#openFailed)   throw this.#openFailed;     // cached error
  if (this.#openPromise)  return this.#openPromise;   // share in-flight
  this.#openPromise = this.#doOpen()
    .then(() => { this.#opened = true; })
    .catch(err => { this.#openFailed = err; throw err; })
    .finally(() => { this.#openPromise = null; });
  return this.#openPromise;
}
```

### Worker close + dispose semantics

| Trigger | Behavior |
|---|---|
| `db.close()` (explicit, async) | Wait for in-flight ops to settle. Send `close` for every still-open `Database`/`Connection`/`Statement`/`Appender`. Terminate the Worker. Future calls reject with `DuckDBClosedError`. |
| `await using db = open(...)` (`Symbol.asyncDispose`) | Same as `close()`. |
| `using db = open(...)` (`Symbol.dispose`, sync fallback) | Best-effort: send a fire-and-forget close message and `worker.terminate()`. Don't await. Document that this may leak files briefly if the process exits before the worker drains; recommend `await using` for async subpath. |
| Worker exits unexpectedly | All pending request promises reject with new `DuckDBWorkerCrashedError`. Future calls reject with `DuckDBClosedError`. No request promise hangs forever. |

### MUST · Worker crash behavior

If the worker exits unexpectedly:
- All pending request promises reject with a new
  `DuckDBWorkerCrashedError` (extends `DuckDBError`).
- Future calls on any proxy from that Database reject with
  `DuckDBClosedError`.
- No request promise hangs forever.

Implement a "worker died" sentinel and check it on every send.

### Required benchmarks (commit results in the RFC, then in the
release note)

Bench harness: `bench/async-vs-sync.mjs`. Compare:

1. **Event-loop responsiveness** — set an interval that bumps a
   counter every 1ms; run a 10-second `SELECT count(*) FROM
   range(1e8)` synchronously vs. via the async subpath. Measure
   how many counter ticks were missed.
2. **Small-query latency** — `SELECT 1` 10K times. Sync should
   win; how much does the worker round-trip cost?
3. **Large result clone cost** — `SELECT * FROM range(1e6)` (one
   column, integer). Compare time-to-first-row, time-to-last-row,
   peak heap.
4. **Appender throughput** — append 100K rows. Async should be
   close to sync (within 20%); if it's worse, the batching is
   wrong.

If small-query latency is more than 10× worse for async, document
it loudly in the README; don't claim async is "always better".

### MUST · Smoke test for the subpath

Add to release smoke test. **Use `await using`, not bare `using`**
— the async subpath uses `Symbol.asyncDispose`, and bare `using`
would only fire the sync best-effort fallback, masking
worker-cleanup bugs:

```bash
bun -e "
  import { open } from 'duckdb-bun/async';
  await using db = open(':memory:');
  console.log(await db.get('SELECT 42 AS n'));
"
```

This catches missing `package.json` `exports` map entries, missing
`files[]` patterns, AND broken async-dispose paths.

### `package.json` changes

Add to `exports`:

```json
"./async": {
  "types": "./lib/async/index.d.ts",
  "default": "./lib/async/index.mjs"
}
```

Add to `files`:

```
"lib/async/"
```

Verify with `npm pack --dry-run`.

### Estimated scope

1–2 days. Includes RFC, implementation, tests (parameterize the
v0.3.0 test suite to also run against async), benchmarks, and
documentation. **Don't skip the benchmark step.**

---

## §8 · Work item 3 — Windows x86_64 (v0.5.0)

### Goal

Make `bun add duckdb-bun` work on Windows x86_64 with the same
zero-`make` install story as the other platforms.

### Why deferred until now

- No local Windows machine; every iteration is "push to CI, wait
  5 min, read logs"
- Bun on Windows is the least-mature of the three platforms; FFI
  edge cases are likely
- Audience is small in early 2026

### DEFAULT decisions

| Decision | DEFAULT | Why |
|---|---|---|
| Build with the shim, even on Windows? | **YES**, for consistency. Don't try to optimize "maybe direct FFI works on Windows" as a first move. | One platform-conditional code path is enough. Investigate the shim-free path only after the shim path is shipped and green. |
| Build toolchain | **MSVC via PowerShell** (`lib/build.ps1` invoking `cl.exe`). | Native Windows tooling, no WSL dependency, matches what other Windows-bundled npm packages do. |
| Bundle `duckdb.dll`? | **NO. Same as Linux/macOS** — user installs DuckDB separately. | Consistency. Document install via the official zip from <https://duckdb.org/docs/installation>. |
| DLL search at runtime | See "Windows DLL loading" section below — this is the trickiest single thing about Windows support. | Windows has no rpath equivalent; the shim's static import of `duckdb.dll` resolves at the OS loader, before our JS path-discovery runs. |
| CI runner | `windows-latest` | Standard. |

### Windows DLL loading

The shim DLL has a static import dependency on `duckdb.dll`. The
Windows loader resolves that dependency **before** our JS code
runs, so JS path-discovery (`findDuckDBLibrary()`) only helps for
the explicit `dlopen` we issue ourselves — it can't influence the
loader's resolution of the shim's own dependency.

**The DEFAULT strategy:** explicitly preload `duckdb.dll` from its
known absolute path *before* loading the shim, and **retain the
returned handle for the lifetime of the module**. On Windows, when
a DLL is already loaded into the process, subsequent imports of
the same name resolve to that loaded module. If the returned
`dlopen` handle is GC'd, Bun may close the underlying library and
the dependency resolution breaks.

```js
// In lib/duckdb.mjs, module-scope:
let preloadedDuckDB = null;   // MUST be retained — see comment above

if (platform === 'win32') {
  const duckdbDll = findDuckDBLibrary();   // resolves to absolute path
  if (duckdbDll) {
    // Empty symbol map — we only want the side effect of loading the DLL
    // into the process so the shim's static import resolves.
    preloadedDuckDB = dlopen(duckdbDll, {});
  }
}

const shimPath = findShimLibrary();
const shim = shimPath ? dlopen(shimPath, { /* shim symbols */ }) : null;
```

This sidesteps the need to manipulate `PATH` at runtime
(unreliable in Bun) or copy DLLs around at install time.

**Verify in Spike 2** (see "Order of operations" below) that
`bun:ffi`'s `dlopen` actually triggers the right Windows loader
behavior. If it doesn't (e.g. Bun uses a custom loader that
bypasses the global module table), the fallback is to require
users to put DuckDB's `bin/` on PATH and document it loudly.

### What needs to change

1. **`findDuckDBLibrary()`** in `lib/duckdb.mjs` (~line 25): add
   `win32` branch with paths:
   - `%DUCKDB_LIB_PATH%` (override)
   - `%PROGRAMFILES%\DuckDB\bin\duckdb.dll`
   - directory of `process.execPath`
   - alongside the shim itself
2. **`findShimLibrary()`** in `lib/duckdb.mjs`: add `.dll`
   extension and `libduckdb-shim-win32-x64.dll` lookup.
3. **Win32 preload in `lib/duckdb.mjs`** as shown above.
4. **`lib/build.ps1`**: PowerShell script invoking
   `cl.exe duckdb-shim.c /link duckdb.lib /DLL /OUT:libduckdb-shim-win32-x64.dll`.
   **MUST initialize MSVC dev environment first** — `cl.exe` is
   not on PATH by default on GitHub `windows-latest`. Two viable
   approaches:
   - In CI: use the `ilammy/msvc-dev-cmd@v1` GitHub Action before
     calling the script (this sets up `cl.exe`, `link.exe`, paths,
     etc.)
   - In `build.ps1` itself: locate Visual Studio via `vswhere`,
     then dot-source `VsDevCmd.bat` to load env vars
   **Recommendation: use the action in CI; keep `build.ps1`
   simple and assume the dev env is already initialized.** Document
   the requirement at the top of the script.
5. **`.github/workflows/release.yml`**: add `windows-latest`
   matrix entry to `build-shim-required`. Steps:
   - `actions/checkout@v4`
   - `ilammy/msvc-dev-cmd@v1`
   - Download libduckdb Windows zip (URL pattern below)
   - `pwsh lib/build.ps1`
   - Upload `libduckdb-shim-win32-x64.dll` as artifact
6. **`.github/workflows/test.yml`**: add `windows-latest` to test
   matrix. Same shim build + run `bun test`.
7. **`package.json` `files[]`**: add
   `"lib/libduckdb-shim-win32-x64.dll"`.
8. **README**: update platform table, add Windows install snippet.

### Windows libduckdb URL + layout

```powershell
# In build.ps1 / CI
$url = "https://github.com/duckdb/duckdb/releases/download/$Env:DUCKDB_VERSION/libduckdb-windows-amd64.zip"
Invoke-WebRequest $url -OutFile libduckdb.zip
Expand-Archive libduckdb.zip -DestinationPath libduckdb

# After extraction, libduckdb/ contains:
#   duckdb.dll      — the runtime DLL
#   duckdb.lib      — the import library cl.exe links against
#   duckdb.h        — header
#   duckdb_static.lib (optional)

# For the shim build:
cl.exe lib/duckdb-shim.c /I libduckdb /link libduckdb/duckdb.lib /DLL /OUT:lib/libduckdb-shim-win32-x64.dll
```

### Windows CI runtime: making the DLL findable

CI's Windows job has the libduckdb files in `libduckdb/duckdb.dll`
after extraction, but `findDuckDBLibrary()`'s default Windows
paths don't include the workspace `libduckdb/` directory. Without
extra setup, the shim build will succeed but `bun test` will fail
at runtime with a load error.

DEFAULT: set `DUCKDB_LIB_PATH` for the test step:

```yaml
- name: Run tests
  run: bun test
  env:
    DUCKDB_LIB_PATH: ${{ github.workspace }}\libduckdb\duckdb.dll
```

Don't copy `duckdb.dll` into `lib/` permanently — that would
bundle the DuckDB runtime into the npm tarball, which we
explicitly DO NOT want (see Don't-break rules: "DO NOT bundle
libduckdb itself"). The `DUCKDB_LIB_PATH` env var is CI-test-only.

### Order of operations (DO NOT skip)

1. **Spike 1:** Push a workflow change that just runs `bun -e
   'console.log("hello")'` on `windows-latest`. Confirm Bun works
   on the GitHub Windows runner.
2. **Spike 2:** Build a Windows shim (just the `cl.exe` invocation,
   no test). Verify `bun:ffi` can dlopen the resulting DLL.
3. **Spike 3:** Minimal "open + SELECT 42" test on the Windows
   runner. Iterate on DLL search / PATH issues until green.
4. **Wire in the workflow + Makefile-equivalent changes** above.
   Run full test suite on Windows.
5. **Update `package.json`, `README.md`, ship as v0.5.0.**

Each spike commits separately on a feature branch. Don't merge to
main until tests pass on Windows.

### Estimated scope

4–8 hours of CI iteration if Bun on Windows is well-behaved. Could
balloon to a full day if FFI quirks bite. Budget half a day, accept
it might be more.

---

## §9 · Architecture quick reference

### File map

| File | Role |
|---|---|
| `lib/duckdb.mjs` | The entire driver — FFI declarations, type decoders, classes |
| `lib/duckdb.d.ts` | Hand-written TypeScript declarations. Keep in sync with `.mjs`. The runtime is the source of truth; the `.d.ts` is the contract. |
| `lib/duckdb-shim.c` | C shim wrapping 3 by-value DuckDB functions (Linux x64 ABI workaround) |
| `lib/Makefile` | Builds the shim. Native (`make`), platform-tagged (`make TAGGED=1`), or cross-compile (`make darwin-x64-from-arm64`). Auto-detects Homebrew on macOS. |
| `package.json` | npm metadata; `files[]` controls tarball; `exports` controls subpaths |
| `test/*.test.mjs` | Bun-test files, organized by topic |
| `examples/*.mjs` | Runnable smoke examples; CI-validated |
| `.github/workflows/test.yml` | Per-push 3-platform test matrix (linux-x64, linux-arm64, darwin-arm64) |
| `.github/workflows/release.yml` | Tag-driven publish. 3 native shims + 1 cross-compiled darwin-x64 |
| `README.md` | User-facing docs |
| `AGENTS.md` | AI/contributor architectural deep-dive (FFI bugs, locking, type system). MUST READ before FFI work. |
| `CONTRIBUTING.md` | External contributor guide |
| `CHANGELOG.md` | Per-version release notes |
| `docs/rfcs/` | (To be created in v0.4.0.) Architectural design docs. |

### Classes in `lib/duckdb.mjs`

- **`Database`** — single-handle wrapper. Lazy implicit
  `Connection` for shortcut methods (`.query/.all/.get/.run/.exec/
  .prepare/.transaction`). Tracked via `Symbol`-keyed slot, non-
  enumerable.
- **`Connection`** — explicit DuckDB connection. All FFI calls go
  through `withLock(() => ...)` to serialize against Bun's
  microtask interleaving. Tracks outstanding `Statement`s; `close`
  cascades.
- **`Statement`** — reusable prepared statement. `.all/.get/.run/
  .close` (all async), `.closed` getter, `[Symbol.dispose]`.
  Reuses one prepared handle across executes via `clearBindings`.
- **`Appender`** — bulk insert path. ~400× faster than
  parameterized INSERT for 100K rows. Sync `appendRow`, async
  `flush`/`close`.

### Chunk-fetching loop (relevant for `iterate()`)

In `_executePreparedSync` (`lib/duckdb.mjs` ~line 557+). Roughly:

```js
while (true) {
  const chunk = fetchChunk(rp);             // shim or direct
  if (!chunk) break;
  const chunkSize = Number(lib.duckdb_data_chunk_get_size(chunk));
  if (chunkSize === 0) { destroyChunk(chunk, chunkBuf); break; }

  // For each column: get vector, data ptr, validity ptr
  // For each row in chunk: assemble row object via #readValue
  for (let r = 0; r < chunkSize; r++) {
    const row = {};
    for (let c = 0; c < colCount; c++) {
      row[col.name] = isValid(...) ? this.#readValue(...) : null;
    }
    rows.push(row);
  }
  destroyChunk(chunk, chunkBuf);
}
return { rows, columns, rowsChanged };
```

For `iterate()`, factor the inner per-chunk work into the async
generator body, with try/finally around chunk processing for
cleanup on early break (see §6).

---

## §10 · Conventions

### Commit messages

Format: `<type>: <terse summary>`, blank line, body explaining
*why*.

Common types: `feat:`, `fix:`, `chore:`, `docs:`, `feat(ci):`,
`fix(ci):`, `feat(types):`, `fix(types):`.

Body conventions:
- Plain text, ~70 char/line. Bullets only when really needed.
- Cite files changed if it helps.
- **Explain rejected alternatives.** Future-you will not
  remember why you didn't take the obvious path.

### Code style

- 2-space indent (`.mjs`, `.d.ts`, `.json`, `.yml`)
- Single quotes in JS, double quotes in JSON
- `async function` for any method that should *reject* (not throw
  synchronously) on bad state
- Comments explain *why*, not *what*. One good comment beats three
  obvious ones.
- Keep `lib/duckdb.mjs` as the single driver file. If it crosses
  ~2500 lines, *then* split. Resist splitting earlier; the
  one-file simplicity is part of the appeal.

### Error classes

All errors thrown to user code MUST be one of:
- `DuckDBError` (base)
- `DuckDBClosedError`
- `DuckDBPrepareError`
- `DuckDBTransactionError`
- (v0.4.0 may add `DuckDBWorkerCrashedError`)

Add new subclasses sparingly. Each new class needs:
- Export from `lib/duckdb.mjs`
- Declaration in `lib/duckdb.d.ts`
- Test in `test/errors.test.mjs`

(Note: errors are part of the package's named exports, not
separate `package.json` `exports` map entries — those are for
*subpaths*, not individual symbols.)

### Async vs sync (rules of thumb)

- Public method that crosses FFI → `async function` (so
  closed-state checks become Promise rejections, matching
  `await foo()` user expectations).
- Pure-data getter → sync.
- Iterators → async.
- Disposal: `[Symbol.dispose]` (sync) for the main-thread driver;
  `[Symbol.asyncDispose]` for v0.4.0 worker-backed proxies (with
  sync `Symbol.dispose` as best-effort fallback).

### Versioning

| Bump | When |
|---|---|
| Patch (`0.X.Y → 0.X.Y+1`) | Bug fixes, doc updates, CI-only changes |
| Minor (`0.X.Y → 0.X+1.0`) | New features (additive), deprecations of old features |
| Major (`0.X.Y → 1.0.0`) | Only when API has been stable ≥6 months and no breaking changes anticipated. **Don't ship 1.0.0 lightly.** |

Roadmap target versions:
- v0.3.0 → `Statement.iterate()` (this release)
- v0.4.0 → `duckdb-bun/async` worker-backed
- v0.5.0 → Windows x86_64
- v1.0.0 → API stabilization milestone

`DUCKDB_VERSION` is pinned to `v1.5.2` in both workflows. Bump
when there's a real reason (upstream bug fix, new feature we want)
or routinely every ~3 months. When you bump, also re-run the test
suite locally and update README's compatibility line.

---

## §11 · Backlog (post-v0.5.0)

| Item | Why |
|---|---|
| `tsc --noEmit` step in CI consuming a sample TS consumer file | Currently `.d.ts` is unverified end-to-end |
| README "Performance" section with benchmarks vs `@duckdb/node-api` | Real numbers; bench harness in `bench/` |
| Coverage report (`bun test --coverage`) as CI artifact | Quality signal |
| Valgrind leak test on Linux for 1000-iteration query loop | Catch any per-query handle leaks |
| `db.pragma(name)` / `db.pragma(name, value)` typed wrapper | DX over `db.exec`/`db.get` for PRAGMA |
| `db.serialize()` / `db.deserialize()` for `EXPORT/IMPORT DATABASE` | DX |
| `optionalDependencies` per-platform sub-packages (esbuild-style) | Drops multi-arch tarball; only worth it if/when we hit npm size limits |
| Kysely / Drizzle dialect adapters as separate packages | Ecosystem |
| `examples/server.mjs` — duckdb-bun behind `Bun.serve` | Docs/marketing |
| `AbortSignal` support across both sync + async APIs | Modern cancellation story |

---

## §12 · Communication & decisions

When you make a significant decision (architecture, API surface,
trade-off), record it in:

- **CHANGELOG entry** for the release that ships it (one
  sentence + why)
- **`AGENTS.md` update** if it affects how the driver is
  structured
- **`docs/rfcs/NNNN-name.md`** for major architectural choices
  (the v0.4.0 worker design is the first one — see §7)

Don't put long explanations in commit messages alone — they're
hard to find later. Use commits for *what changed and why*; use
docs for *how the system is structured*.

---

## §13 · Quick-reference: where to find things

| Question | File |
|---|---|
| What does the package do for users? | `README.md` |
| What is the public API? | `lib/duckdb.d.ts` |
| How does the FFI binding work internally? | `AGENTS.md` (especially "Bun FFI on Linux x86_64") |
| Why was a particular decision made? | CHANGELOG entry → commit message → (eventually) RFC |
| What changed in each release? | `CHANGELOG.md` |
| How to contribute (external)? | `CONTRIBUTING.md` |
| How CI works? | Header comments in `.github/workflows/test.yml` and `release.yml` |
| What ships in the npm tarball? | `package.json` `files[]`. Verify with `npm pack --dry-run`. |
| What determines subpath imports? | `package.json` `exports` |

---

## §14 · Last updates

- 2026-05-15 — v0.2.3 shipped. HANDOFF.md created (this doc).
- 2026-05-15 — Reviewed by GPT-5.5; rewrote with stronger defaults
  for iterator locking, worker architecture, and Windows build.
- 2026-05-15 — **v0.3.0 work item completed locally** (ship-ready,
  awaiting user-mediated push/tag). Notes from implementation:
  - **Per-Connection locks shipped** as foundational refactor before
    `iterate()` itself. The pre-existing process-global `withLock`
    was replaced with an `AsyncMutex` class instance owned by each
    Connection. Two FFI patterns: `withLock(fn)` for one-shot
    critical sections, `acquire()` for lifetime locks (the iterator
    uses the latter).
  - **State machine `'open' | 'closing' | 'closed'`** added to
    Database/Connection/Statement. Per fresh-review with GPT-5.5:
    the close protocol cancels the active iterator first, THEN
    re-acquires the lock to do the FFI destroy (not "without the
    lock" as the original §6 text said).
  - **`Database.close()` etc. became async**, but with a sync side-
    effect: the public handle is nulled synchronously so the v0.2-era
    contract `obj.close(); obj.handle === null` keeps working without
    `await`. Existing 112 tests stayed green throughout the refactor.
  - **Statement.iterate() wrapper** implements §6's pre-start
    `.return()` path. The wrapper-reference threading needed a `ref`
    object (the wrapper isn't in scope inside the generator's
    `finally`).
  - **Connection.iterate / Database.iterate sugar are lazy-prepare**
    via an outer `async function*` that prepares on first `.next()`
    and closes the temp Statement in `finally`, per GPT-5.5's
    recommendation against eager allocation.
  - **22 new tests** in `test/iterate.test.mjs` covering all 13 cases
    from GPT-5.5's review plus a stress loop and the per-Connection
    lock parallelism pin.

**End of HANDOFF.md.**

If you (the next agent) update this file, run another fresh review
pass — `mcp/user-ai/fresh_review` with model `openai:gpt-5.5` is
how the previous version was sanity-checked.
