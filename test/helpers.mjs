// Shared test setup. Each test file imports from here so the
// "import driver, skip suite if libduckdb is missing" dance lives in
// one place.
//
// Usage:
//
//   import { test, expect, beforeEach, afterEach } from 'bun:test';
//   import { d, open, available } from './helpers.mjs';
//
//   let db;
//   beforeEach(() => { if (available) db = open(':memory:'); });
//   afterEach(() => { if (available) db?.close(); });
//
//   d('my topic', () => {
//     test('does the thing', async () => { ... });
//   });

import { describe } from 'bun:test';

let _open, _version, _DUCKDB_TYPE;
let _DuckDBError, _DuckDBClosedError, _DuckDBPrepareError, _DuckDBTransactionError;
let _Database, _Connection, _Statement;
let _available = false;

try {
  ({
    open: _open,
    version: _version,
    DUCKDB_TYPE: _DUCKDB_TYPE,
    DuckDBError: _DuckDBError,
    DuckDBClosedError: _DuckDBClosedError,
    DuckDBPrepareError: _DuckDBPrepareError,
    DuckDBTransactionError: _DuckDBTransactionError,
    Database: _Database,
    Connection: _Connection,
    Statement: _Statement,
  } = await import('../lib/duckdb.ts'));
  _available = true;
} catch {
  // libduckdb not installed — exported describe is .skip below.
}

export const open = _open;
export const version = _version;
export const DUCKDB_TYPE = _DUCKDB_TYPE;
export const DuckDBError = _DuckDBError;
export const DuckDBClosedError = _DuckDBClosedError;
export const DuckDBPrepareError = _DuckDBPrepareError;
export const DuckDBTransactionError = _DuckDBTransactionError;
export const Database = _Database;
export const Connection = _Connection;
export const Statement = _Statement;
export const available = _available;

/** describe() that auto-skips when libduckdb isn't installed. */
export const d = _available ? describe : describe.skip;
