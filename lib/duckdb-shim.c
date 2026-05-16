/*
 * Bun FFI shim for DuckDB functions that take duckdb_result by value.
 *
 * Bun's FFI cannot pass structs by value (48-byte duckdb_result on SysV
 * AMD64 is MEMORY class; same constraint applies on Windows x64). These
 * wrappers accept a pointer instead and dereference it before calling
 * the real DuckDB function.
 *
 * Build:
 *   Linux:   gcc -shared -fPIC -o libduckdb-shim.so duckdb-shim.c -lduckdb
 *   macOS:   clang -dynamiclib -o libduckdb-shim.dylib duckdb-shim.c -lduckdb
 *   Windows: see lib/build.ps1 (uses MSVC cl.exe; needs duckdb.lib import library)
 *
 * Windows-specific note: on Windows, symbols are NOT exported from a DLL
 * by default. The DUCKDB_BUN_EXPORT macro emits __declspec(dllexport) so
 * that Bun's dlopen() can find these functions via GetProcAddress.
 */

#include <stdint.h>

#ifdef _WIN32
#  define DUCKDB_BUN_EXPORT __declspec(dllexport)
#else
#  define DUCKDB_BUN_EXPORT __attribute__((visibility("default")))
#endif

typedef uint64_t idx_t;
typedef void *duckdb_data_chunk;

typedef struct {
    idx_t deprecated_column_count;
    idx_t deprecated_row_count;
    idx_t deprecated_rows_changed;
    void *deprecated_columns;
    char *deprecated_error_message;
    void *internal_data;
} duckdb_result;

extern duckdb_data_chunk duckdb_fetch_chunk(duckdb_result result);
extern duckdb_data_chunk duckdb_result_get_chunk(duckdb_result result, idx_t chunk_index);
extern idx_t duckdb_result_chunk_count(duckdb_result result);

DUCKDB_BUN_EXPORT duckdb_data_chunk shim_fetch_chunk(duckdb_result *result) {
    return duckdb_fetch_chunk(*result);
}

DUCKDB_BUN_EXPORT duckdb_data_chunk shim_result_get_chunk(duckdb_result *result, idx_t chunk_index) {
    return duckdb_result_get_chunk(*result, chunk_index);
}

DUCKDB_BUN_EXPORT idx_t shim_result_chunk_count(duckdb_result *result) {
    return duckdb_result_chunk_count(*result);
}
