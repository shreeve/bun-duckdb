# AI Agent Guide for duckdb-bun

For human-facing docs, see [README.md](./README.md). This guide
covers the implementation architecture, the load-bearing FFI
workarounds, and conventions for extending the driver.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Consumer code (Bun process)                                 │
│                                                              │
│  Sync path:                       Async path (v0.4+):        │
│    import { open } from              import { open } from    │
│      'duckdb-bun';                     'duckdb-bun/async';   │
└──────────┬──────────────────────────────────┬────────────────┘
           │ JS calls                         │ postMessage IPC
           ▼                                  ▼
┌──────────────────────────────┐  ┌────────────────────────────┐
│ lib/duckdb.mjs               │  │ lib/async/index.mjs        │
│ (main-thread driver, 1 file) │  │ (main-thread proxies only) │
│                              │  │                            │
│  • dlopen libduckdb via      │  │  • One Worker per Database │
│    bun:ffi                   │  │  • Numeric IDs only;       │
│  • Database / Connection /   │  │    no FFI handles cross    │
│    Statement / Appender      │  │    postMessage             │
│  • Chunk-based decoding      │  │  • Lazy open, ready        │
│  • Per-Connection AsyncMutex │  │    handshake, request map  │
└────────┬──────────────┬──────┘  └────────────┬───────────────┘
         │ FFI          │ FFI                  │ Worker
         ▼              ▼                      ▼
   libduckdb     libduckdb-shim       lib/async/worker.mjs
   (the DB)     (3 by-value funcs;        (imports lib/duckdb.mjs
                Linux x64 ABI fix)         and dispatches by op)
```

The main-thread driver is one file (`lib/duckdb.mjs`, ~2500 lines)
plus a ~30-line C shim. The async subpath adds ~1100 lines across
`lib/async/{index,worker,protocol}.{mjs,d.ts}` — no second FFI
implementation; the worker reuses the main-thread driver wholesale.

No build step for users — pre-built platform-tagged shims ship in the
npm tarball. Source-clone contributors run `make -C lib` once.

| File | Role |
|---|---|
| `lib/duckdb.mjs` | The entire main-thread FFI driver — symbol declarations, type decoders, classes |
| `lib/async/index.mjs` | Main-thread proxies for the `duckdb-bun/async` subpath |
| `lib/async/worker.mjs` | Worker dispatcher; imports `lib/duckdb.mjs` for actual FFI |
| `lib/async/protocol.{mjs,d.ts}` | Wire protocol constants + types + shared error registry |
| `lib/duckdb-shim.c` | C shim wrapping 3 DuckDB functions that take `duckdb_result` by value (Linux/Windows x64 ABI workaround) |
| `lib/Makefile` | Builds `libduckdb-shim.{so,dylib}` (platform-tagged with `TAGGED=1` for CI) |
| `lib/build.ps1` | Windows MSVC build script — produces `libduckdb-shim.dll` (or `libduckdb-shim-win32-x64.dll` with `-Tagged`) |
| `test/*.test.mjs` | Bun-test files, split by topic; auto-skip when `libduckdb` is absent |
| `test/async/async.test.mjs` | End-to-end tests for the async subpath |
| `bench/async-vs-sync.mjs` | Benchmark harness comparing sync vs Worker paths |
| `docs/rfcs/` | Architectural RFCs (the v0.4 async design was written here first) |

---

## Bun FFI on Linux x86_64 — Critical Knowledge

**Two real bugs in Bun's FFI cause segfaults when wrapping a C library
with opaque handles or large struct returns.** Both are worked around
in `lib/duckdb.mjs`. **Do not revert these patterns.**

These workarounds are the most valuable knowledge in this codebase.
Anyone extending the driver, or building any other Bun FFI binding to
a C API with opaque handles, needs to know about both.

### Bug 1: Number-as-`'ptr'` argument corruption

Bun corrupts plain JavaScript numbers when marshaling them to C
pointer arguments declared as `'ptr'`. The segfault address is
typically `0xFFFFFFFFFFFFFFFF` (the number gets sign-extended or
sentinel-replaced).

**Fix:** All opaque DuckDB handles (database, connection, prepared
statement, data chunk, vector, logical type, appender) are declared
as `'u64'` arguments and stored as BigInt. Buffer pointers using
`ptr(buf)` remain `'ptr'`.

```js
// WRONG — crashes on Linux x64
duckdb_connect: { args: ['ptr', 'ptr'], returns: 'i32' },
lib.duckdb_connect(dbHandle, ptr(connBuf))  // dbHandle is a Number

// CORRECT — works on all platforms
duckdb_connect: { args: ['u64', 'ptr'], returns: 'i32' },
lib.duckdb_connect(dbHandle, ptr(connBuf))  // dbHandle is a BigInt
```

### Bug 2: Struct-by-value passing is impossible

`duckdb_fetch_chunk(duckdb_result result)` takes a 48-byte struct by
value. On Linux x64 (SysV AMD64 ABI) this struct is classified as
MEMORY and passed on the stack. On Windows x64 (Microsoft x64 ABI),
a 48-byte struct return is passed via a hidden first-pointer argument
to caller-provided storage — also unrepresentable through Bun's FFI
declarations. Bun FFI has no mechanism to pass structs by value;
passing `ptr(buf)` puts a pointer in a register where the callee
expects something else.

On macOS arm64, large structs are passed by hidden pointer in r8, so
`ptr(buf)` as `'ptr'` happens to work. On Linux x64 it segfaults at
`0x0`; on Windows x64 it would corrupt the return value.

**Fix:** A C shim (`lib/duckdb-shim.c`) wraps the by-value functions:

```c
duckdb_data_chunk shim_fetch_chunk(duckdb_result *result) {
    return duckdb_fetch_chunk(*result);
}
```

The shim is loaded at startup. If not found, the driver falls back to
a direct call (works on macOS arm64 only).

### Handle lifecycle

All handles flow as BigInt through the system:

```
duckdb_open(null, ptr(buf))  →  readHandle(buf) returns BigInt
                                      ↓
duckdb_connect(BigInt, ptr(buf))  →  readHandle(buf) returns BigInt
                                           ↓
duckdb_query(BigInt, ptr(sql), ptr(resultBuf))
                                           ↓
fetchChunk(ptr(resultBuf))  →  returns BigInt (chunk handle)
                                      ↓
duckdb_data_chunk_get_vector(BigInt, BigInt)  →  returns BigInt
                                                      ↓
duckdb_vector_get_data(BigInt)  →  Number() for ffiRead
```

Data pointers (from `duckdb_vector_get_data`) are converted to
Number via `Number(bigint)` before being passed to `ffiRead.i32()`,
`ffiRead.u8()`, etc., because Bun's `ffiRead` functions expect
Number addresses.

### Building the shim

```bash
cd lib
make            # produces libduckdb-shim.so or .dylib
sudo make install   # → /usr/local/lib/   (optional)
```

Or directly:

```bash
gcc -shared -fPIC -o libduckdb-shim.so duckdb-shim.c -lduckdb
```

Windows uses a PowerShell + MSVC build instead:

```powershell
# from a Developer PowerShell for VS (or after running vcvars64.bat)
cd lib
.\build.ps1 -DuckDbDir C:\path\to\duckdb-windows-amd64
# → libduckdb-shim.dll (or libduckdb-shim-win32-x64.dll with -Tagged)
```

Place next to `libduckdb.{so,dylib,dll}`, or set `DUCKDB_SHIM_PATH`.

---

## Windows-specific notes

Three things are different on Windows. All of them are in
`lib/duckdb.mjs` and `lib/duckdb-shim.c` already; don't re-discover
them.

### 1. DLL load order matters (preload pattern)

The shim DLL has a static import dependency on `duckdb.dll`. Windows's
OS loader resolves that dependency at the moment `dlopen(shimPath)` is
called, NOT via our JS path discovery. The fix is to load `libduckdb`
first by absolute path, then load the shim. Once a DLL by the name
`duckdb.dll` is loaded into the process, the shim's import binds to
the already-loaded module by name.

The driver already does this. The order in `lib/duckdb.mjs` is:

1. `ddbLib = dlopen(libPath, { ...duckdb symbols })` (retained module-scope)
2. `shimLib = dlopen(shimPath, { ...shim symbols })` (also retained)

Both objects MUST be retained at module scope, not just `.symbols`
destructured. If Bun ever GCs the wrapper, it could call `FreeLibrary`
on the underlying module — which on Windows would invalidate the
shim's bound import. On Unix this is harmless, but the pattern is
identical across platforms for simplicity.

### 2. `__declspec(dllexport)` on shim functions

On Linux/macOS, non-static C functions are visible to `dlsym` by
default. On Windows, DLL functions are NOT exported unless they're
marked with `__declspec(dllexport)`. The shim wraps this in a
`DUCKDB_BUN_EXPORT` macro that's `__declspec(dllexport)` on Windows
and `__attribute__((visibility("default")))` on Unix. If new shim
functions are added, they MUST use this macro — otherwise `cl.exe /LD`
produces a DLL that loads cleanly but has zero callable entry points,
and Bun's `dlopen` silently returns null symbols.

CI verifies this: `lib/build.ps1` runs `dumpbin /exports` on the built
shim and asserts that all required symbols are present.

### 3. Async close + file locking

Windows enforces exclusive file locks on open DuckDB DBs. Tests that
populate a file then immediately reopen the same path must `await
close()` between the two opens — `Symbol.dispose` is fire-and-forget
(it doesn't await the close() promise; that's by design — `await
using` is the awaitable version), so naive `using db = open(path)`
followed by `using db2 = open(path)` would race the close on Windows.

The pattern in `test/options.test.mjs` is:

```js
const d1 = open(path);
// ...populate...
await d1.close();              // explicit, not `using`
const d2 = open(path, opts);   // safe to reopen
```

`using` / `await using` still work fine for any DB whose file isn't
reopened during its lifetime — which is the common case.

---

## FFI Declaration Rules

When adding new DuckDB C API bindings, follow these rules. They are
the direct consequence of Bug 1 above plus DuckDB's C API conventions.

| C parameter type | FFI arg type | JS value |
|---|---|---|
| Opaque handle by value (`duckdb_connection`, `duckdb_data_chunk`, etc.) | `'u64'` | BigInt |
| Pointer to buffer/struct (`duckdb_result *`, `duckdb_connection *`) | `'ptr'` | `ptr(buf)` |
| C string (`const char *`) | `'ptr'` | `ptr(toCString(s))` |
| `null` pointer | `'ptr'` | `null` |
| Scalar (`int32_t`, `bool`, `double`) | `'i32'`/`'bool'`/`'f64'` | Number/Boolean |
| `idx_t` / `uint64_t` | `'u64'` | BigInt |

For **return** types:

- Opaque handles → `'u64'` (returns BigInt)
- String pointers (used with CString) → `'ptr'` (returns Number)
- Data pointers (used with ffiRead) → `'u64'`, then `Number()` at
  call site

Functions that take a 48-byte+ struct by value (the three result-
fetching functions in DuckDB's modern API) need a wrapper in
`duckdb-shim.c`. There is no way to declare them in pure JS that
works on Linux x64.

---

## Adding a new DuckDB C API function

1. **Find the C signature** in DuckDB's docs:
   <https://duckdb.org/docs/api/c/overview>
2. **Add the declaration** to the `dlopen` block in
   `lib/duckdb.mjs`. Match the FFI Declaration Rules table above.
3. **If the function takes a struct by value** (rare — only the
   chunk-fetching trio currently does), add a shim wrapper in
   `lib/duckdb-shim.c` and rebuild the shim with `make -C lib`.
4. **Wire the JS API** via methods on `Database` or `Connection`
   classes. Always go through `withLock(() => ...)` for connection-
   level operations to serialize concurrent FFI calls into a single
   handle.
5. **Add a test** in the appropriate `test/*.test.mjs` file (by
   topic — `lifecycle`, `queries`, `statements`, etc.).

---

## Type system

### DuckDB → JS conversions

Implemented in the chunk-decoding loop in `lib/duckdb.mjs` (`#readValue`).
Each `DUCKDB_TYPE` enum value maps to a reader function that pulls the
right primitive from chunk vector memory via `Bun.ffi.read.*`. The
authoritative contract lives in the `#readValue` docstring; this table
is a summary. Keep them in sync when editing either.

| DuckDB type | Reader | JS value |
|---|---|---|
| `BOOLEAN` | `ffiRead.u8` | `boolean` |
| `TINYINT` | `ffiRead.i8` | `number` |
| `SMALLINT` | `ffiRead.i16` | `number` |
| `INTEGER` | `ffiRead.i32` | `number` |
| `UTINYINT`/`USMALLINT`/`UINTEGER` | `ffiRead.u{8,16,32}` | `number` |
| `BIGINT`/`UBIGINT` | `ffiRead.i64`/`u64` | `number` (lossy above 2^53) |
| `HUGEINT`/`UHUGEINT` | 128-bit composite | `string` (decimal) |
| `FLOAT` | `ffiRead.f32` | `number` |
| `DOUBLE` | `ffiRead.f64` | `number` |
| `DECIMAL` | scaled integer ÷ 10^scale | `string` (decimal) |
| `VARCHAR` | inline-or-pointer string | `string` |
| `BLOB` | inline-or-pointer bytes | `Uint8Array` (copy) |
| `DATE` | `ffiRead.i32` (days since epoch) | `string` (`"YYYY-MM-DD"`) |
| `TIME`/`TIME_NS`/`TIME_TZ` | microseconds / nanoseconds | `string` (ISO-ish) |
| `TIMESTAMP`/`TIMESTAMP_{S,MS,NS,TZ}` | `ffiRead.i64` (microseconds since epoch) | `Date` |
| `INTERVAL` | composite | `string` (`"3 months 2 days 1.5 seconds"`) |
| `UUID` | 16 bytes | `string` (canonical 8-4-4-4-12) |
| `LIST`/`ARRAY` | child vector iteration | `Array` |
| `STRUCT` | child vector tuple | `object` (plain `{}`) |
| `MAP` | LIST of STRUCT(key,value) | `object` (plain `{}`, keys stringified) |
| `ENUM` | dictionary index | `string` |
| `BIT`/`UNION` | not implemented | `null` |
| `NULL` (validity bit clear) | validity bitmap | `null` |

### Validity (NULL) handling

Each chunk vector has a validity bitmap — one bit per row, 1 = valid,
0 = NULL. Decoded via `isValid(validityPtr, row)` in `lib/duckdb.mjs`.
Always check before reading the value bytes.

### String layout

VARCHAR uses DuckDB's inline-or-pointer string format:

- Strings ≤ 12 bytes: stored inline in the 16-byte slot
- Strings > 12 bytes: 4-byte length + 12-byte prefix + 8-byte
  pointer to heap buffer

The `readString(dataPtr, row)` helper handles both cases.

---

## Async cancellation (v0.7+)

`duckdb-bun/async` supports `AbortSignal` per-op cancellation. The
sync subpath does not (sync FFI blocks the JS thread that would
receive the abort event).

### How it works

1. Worker creates a `duckdb_connection` via the sync driver's
   `db.connect()` and ships the raw handle (BigInt) and a generation
   token back to the main thread on the `connect` / `txnBegin`
   response.
2. Main thread caches it in `AsyncDatabase._interruptHandles:
   Map<connId, { ptr, generation }>`.
3. `AsyncConnection.#runSerial` wraps every op with an abort listener
   that — when fired during an active op — calls `duckdb_interrupt(ptr)`
   from the main thread via the new FFI binding in `lib/duckdb.mjs`
   (exposed through the internal `_internals` export).
4. Bun Workers share the process's libduckdb state, so the main
   thread calling `duckdb_interrupt` on a worker-owned connection
   pointer is well-defined per DuckDB's C API.
5. The worker's blocked FFI call returns with a DuckDB error. The
   main thread sees the rejection, notices the abort flag was set,
   and surfaces `DuckDBAbortError` (with `.name === 'AbortError'`)
   regardless of what libduckdb actually reported.

### Active-request tracking

`AsyncConnection` runs ops on a per-conn serialization chain (one
in-flight op at a time per conn — same as the sync driver's per-conn
lock). Inside `#runSerial`, the active op gets a unique token and is
recorded in `#activeOp`. The abort handler checks this token before
firing `duckdb_interrupt`: if the active op is a different op (or
the op completed and `#activeOp` is null), the abort is a no-op.
This is what satisfies the "aborting a queued request does NOT
interrupt the active request" invariant.

### Stale-pointer safety

`AsyncConnection.close()` removes the entry from `_interruptHandles`
before sending the worker-side CLOSE. Any abort listener that fires
after close looks up the connId and finds nothing — it bails before
calling `duckdb_interrupt` on a freed pointer. The generation token
provides a second line of defense but in practice the explicit
delete is what guards us.

### AsyncDatabase shortcuts

`db.query / db.exec / db.iterate / db.prepare / ...` route through
a **lazy implicit `AsyncConnection`** (`#getDefaultConn`). This
gives cancellation a stable connection identity for db-level
shortcuts. Before v0.7 these shortcuts used the sync driver's
implicit conn inside the worker (no main-thread handle); the
refactor unifies the two code paths.

---

## Locking model

As of v0.3, each `Connection` owns its own `AsyncMutex` instance.
(Pre-v0.3 the lock was process-global and lived as a module-level
promise queue — that's gone.) Every public method on a `Connection`
that crosses the FFI boundary goes through one of two patterns:

```js
// One-shot critical section (most queries)
conn.withLock(() => {
  if (this.#state !== 'open') throw new DuckDBClosedError('Connection');
  // ... sync FFI here ...
});

// Lifetime lock (Statement.iterate's generator only)
const release = await conn.acquireLock();
try {
  // ... can yield/await between FFI calls, lock is held ...
} finally {
  release();
}
```

**Critical rule:** state checks belong **inside** `withLock`'s
callback (not before queueing). `close()` can flip `#state` from
`'open'` to `'closing'` while a query is waiting in the mutex queue.
Checking state before queueing lets the query proceed; checking
inside the callback rejects cleanly with `DuckDBClosedError`.

For parallelism, create multiple `Connection`s via `db.connect()`.
DuckDB supports many simultaneous connections to one database. As of
v0.3, sibling Connections execute concurrently (pre-v0.3 they all
serialized through the global lock).

### State machine

`Database`, `Connection`, and `Statement` all carry a `#state` field:

- `'open'`     — usable.
- `'closing'`  — `close()` has been called; new ops abort with
                `DuckDBClosedError` inside their lock callback.
- `'closed'`   — FFI handles destroyed.

The transition `'open' → 'closing'` happens **synchronously** at the
top of `close()`. Public handle getters (`db.handle`, `conn.handle`,
`stmt.closed`) reflect that synchronously so the v0.2-era contract
`obj.close(); obj.handle === null` continues to hold without
awaiting. The FFI destroy itself happens in the returned Promise.

### Async close protocol

`close()` is `async` on all three classes. Protocol:

1. Set `#state = 'closing'`; null public handles synchronously.
2. **Cancel active iterators first.** Each class tracks its in-flight
   `Statement.iterate()` wrapper in `#activeIterator`. Calling
   `await wrapper.return()` forces the paused generator to run its
   `finally` (destroy result, destroy chunk, release lock).
3. **Kick off `close()` on each child resource synchronously.** This
   flips child `#state` to `'closing'` immediately (so
   `stmt.closed === true` holds with the sync getter after a parent
   `conn.close()` without awaiting). Capture the promises.
4. **Await child closes** in the async tail.
5. **Re-acquire the lock** (`await this.withLock(...)`). Any queries
   queued behind the cancelled iterator wake up here, see `#state
   === 'closing'` inside their callback, and reject cleanly with
   `DuckDBClosedError` before any FFI call.
6. Inside the lock: call `duckdb_disconnect` / `duckdb_close` /
   `duckdb_destroy_prepare`. Set `#state = 'closed'`.

The key invariant: **FFI destroy happens under the lock, not after
it.** A naive "release iterator → destroy without lock" would race
against any operations that queued behind the iterator and woke up
when it released.

Symbol semantics for `using`:

| Pattern | Maps to |
|---|---|
| `using db = open(...)` (sync) | `Symbol.dispose` → `close().catch(...)` fire-and-forget. Best-effort. |
| `await using db = open(...)` (preferred for streaming) | `Symbol.asyncDispose` → `await close()`. Full async cleanup. |

---

## Testing

```bash
bun test                              # all tests
bun test test/queries.test.mjs        # specific file
bun examples/basic.mjs                # smoke test against installed libduckdb
```

If `libduckdb` is missing the import fails and tests skip via
`describe.skip` — the suite stays green so CI doesn't fail on
machines without DuckDB. Install `libduckdb` to actually exercise the
driver.

---

## Common tasks

### Find a memory leak

`duckdb_destroy_*` cleanup is critical. Every `duckdb_open`,
`duckdb_connect`, `duckdb_query`, `duckdb_prepare`, `duckdb_appender_create`
must be paired with the corresponding `_destroy` / `_close` /
`_disconnect`. The classes use `try/finally` to guarantee this even
when JS exceptions propagate. New methods MUST do the same — leaking
a chunk handle, prepared-statement handle, or appender handle leaks
unbounded amounts of DuckDB memory.

### Debug an FFI segfault

1. Suspect Bug 1 first. Look at the FFI declaration: is any handle
   declared as `'ptr'`? Change to `'u64'`.
2. If it's a struct return (`duckdb_fetch_chunk`-shaped), check
   whether it's going through the shim. On Linux x64 the direct
   path will segfault; the shim path won't.
3. Print the handle value (`console.log(typeof handle, handle)`) at
   the call site. If it's a `Number` instead of `BigInt`, that's
   Bug 1 in action.

### Update for a new DuckDB version

1. Read the release notes for any C API additions/deprecations.
2. Check `duckdb.h` for any signature changes to functions already
   declared in `lib/duckdb.mjs`.
3. If new types were added (rare), extend the `DUCKDB_TYPE` map and
   the chunk-decoding switch.
4. Run `bun test` against the new libduckdb.

---

## Conventions

- **One file for the main-thread driver.** `lib/duckdb.mjs` is at
  ~2500 lines. Splitting is reasonable when the next risky change
  would touch many concerns at once (e.g. a decoder rework); resist
  splitting purely for line count. The async subpath lives in
  `lib/async/` because Worker IPC is genuinely a different concern.
- **No build step for the JS.** Pure ESM. The C shim is the only
  artifact that needs `make`.
- **Honest comments.** When you add a workaround for a Bun bug or a
  DuckDB C API quirk, leave a comment explaining *why* — future you
  will not remember.
- **Tests skip cleanly when libduckdb is missing.** Don't break
  this — CI can run on machines without DuckDB.
- **No dependencies.** Not even devDependencies if avoidable. Pure
  Bun + libduckdb is the contract.

Consider these rules if they affect your changes.
