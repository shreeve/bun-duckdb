// Error classes: hierarchy, names, and instanceof discrimination.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import {
  d, open, available,
  DuckDBError,
  DuckDBClosedError,
  DuckDBPrepareError,
  DuckDBTransactionError,
} from './helpers.mjs';

let db;
beforeEach(() => { if (available) db = open(':memory:'); });
afterEach(() => { if (available) { try { db.close(); } catch {} } });

d('error class hierarchy', () => {
  test('DuckDBError extends Error', () => {
    expect(new DuckDBError('x') instanceof Error).toBe(true);
  });

  test('all subclasses extend DuckDBError', () => {
    expect(new DuckDBClosedError() instanceof DuckDBError).toBe(true);
    expect(new DuckDBPrepareError('x') instanceof DuckDBError).toBe(true);
    expect(new DuckDBTransactionError('x') instanceof DuckDBError).toBe(true);
  });

  test('error names are correct for instanceof discrimination', () => {
    expect(new DuckDBClosedError().name).toBe('DuckDBClosedError');
    expect(new DuckDBPrepareError('x').name).toBe('DuckDBPrepareError');
    expect(new DuckDBTransactionError('x').name).toBe('DuckDBTransactionError');
  });
});

d('thrown errors are typed correctly', () => {
  test('use-after-close on Statement throws DuckDBClosedError', async () => {
    const stmt = await db.prepare('SELECT 1');
    stmt.close();
    try {
      await stmt.run();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DuckDBError);
      expect(e).toBeInstanceOf(DuckDBClosedError);
    }
  });

  test('shortcut on closed Database throws DuckDBClosedError', async () => {
    const d2 = open(':memory:');
    d2.close();
    try {
      await d2.all('SELECT 1');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DuckDBError);
      expect(e).toBeInstanceOf(DuckDBClosedError);
    }
  });

  test('bad-SQL prepare throws DuckDBPrepareError with the parser message', async () => {
    try {
      await db.prepare('NOT VALID SQL ###');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DuckDBError);
      expect(e).toBeInstanceOf(DuckDBPrepareError);
      // Message should include the parser's complaint, not just "Failed to prepare"
      expect(e.message.length).toBeGreaterThan(20);
    }
  });

  test('using a TxnHandle after its callback returned throws DuckDBTransactionError', async () => {
    // v0.5+: nested transactions ARE supported (SAVEPOINT-based); the
    // remaining failure mode is using a TxnHandle outside its lexical
    // scope.
    let stale;
    await db.transaction(async (tx) => { stale = tx; });
    try {
      await stale.exec('SELECT 1');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DuckDBError);
      expect(e).toBeInstanceOf(DuckDBTransactionError);
    }
  });
});
