# AI Agent Guide for duckdb-bun

For human-facing docs, see [README.md](./README.md). This guide
covers the implementation architecture, the load-bearing FFI
workarounds, and conventions for extending the driver.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│ duckdb-bun consumer code (Bun process)               │
│                                                      │
│   import { open } from 'duckdb-bun';                 │
│   const db = open(':memory:');                       │
│   const conn = db.connect();                         │
│   conn.query('SELECT 42');                           │
└────────────────────┬─────────────────────────────────┘
                     │ JS calls
                     ▼
┌──────────────────────────────────────────────────────┐
│ lib/duckdb.mjs   (the entire driver, single file)    │
│                                                      │
│   • Locates libduckdb (and libduckdb-shim if Linux)  │
│   • dlopen + symbol declarations via bun:ffi         │
│   • Database / Connection classes                    │
│   • Chunk-based result decoding via Bun.ffi.read     │
│   • Type-aware value conversion                      │
│   • Appender + prepared statement plumbing           │
└────────────────────┬──────────────────┬──────────────┘
                     │ FFI               │ FFI
                     ▼                   ▼
            libduckdb            libduckdb-shim
            (the database)       (Linux x64 only —
                                  3 functions that
                                  pass structs by value)
```

The whole driver is one file (`lib/duckdb.mjs`, ~1500 lines) plus a
~30-line C shim. No build step for users (the shim is pre-shipped or
built once with `make`).

| File | Role |
|---|---|
| `lib/duckdb.mjs` | The entire FFI driver — symbol declarations, type decoders, classes |
| `lib/duckdb-shim.c` | C shim wrapping 3 DuckDB functions that take `duckdb_result` by value (Linux x64 ABI workaround) |
| `lib/Makefile` | Builds `libduckdb-shim.{so,dylib}` |
| `test/duckdb.test.mjs` | Bun-test driver — skipped if libduckdb is absent |

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
value. On Linux x64 (SysV AMD64 ABI), this struct is classified as
MEMORY and passed on the stack. Bun FFI has no mechanism to pass
structs by value — passing `ptr(buf)` puts a pointer in a register
where the callee expects 48 bytes on the stack.

On macOS arm64, large structs are passed by hidden pointer, so
`ptr(buf)` as `'ptr'` happens to work. On Linux x64, it segfaults at
`0x0`.

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

Place next to `libduckdb.so`/`.dylib`, or set `DUCKDB_SHIM_PATH`.

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
5. **Add a test** in `test/duckdb.test.mjs`.

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

## Locking model

Every public method on `Connection` that crosses the FFI boundary
goes through `withLock(() => ...)`. This serializes concurrent calls
into a single connection — DuckDB connections are not thread-safe in
the JS-callback-during-FFI sense (Bun's loop can interleave promise
microtasks during an FFI call's I/O).

For parallelism, create multiple `Connection`s via `db.connect()`.
DuckDB supports many simultaneous connections to one database.

---

## Testing

```bash
bun test                              # all tests
bun test test/duckdb.test.mjs         # specific file
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

- **One file.** The whole driver lives in `lib/duckdb.mjs`. Split
  only if it crosses ~2000 lines or develops genuinely independent
  concerns.
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
