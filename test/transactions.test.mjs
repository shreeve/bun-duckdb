// Transactions: commit on success, rollback + rethrow on throw,
// nested-transaction guard, return value passthrough.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import {
  d, open, available,
  DuckDBTransactionError,
} from './helpers.mjs';

let db;
beforeEach(() => { if (available) db = open(':memory:'); });
afterEach(() => { if (available) { try { db.close(); } catch {} } });

d('transactions', () => {
  test('commit on success', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    const result = await db.transaction(async (tx) => {
      await tx.exec('INSERT INTO t VALUES (1)');
      await tx.exec('INSERT INTO t VALUES (2)');
      return 'ok';
    });
    expect(result).toBe('ok');
    const rows = await db.all('SELECT * FROM t ORDER BY n');
    expect(rows.length).toBe(2);
  });

  test('rollback + rethrow on throw', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    await db.exec('INSERT INTO t VALUES (1)');   // pre-existing row

    await expect(db.transaction(async (tx) => {
      await tx.exec('INSERT INTO t VALUES (2)');
      throw new Error('boom');
    })).rejects.toThrow('boom');

    // Pre-existing row survives, the inserted one rolled back
    const rows = await db.all('SELECT * FROM t ORDER BY n');
    expect(rows.length).toBe(1);
    expect(rows[0].n).toBe(1);
  });

  test('nested transactions throw DuckDBTransactionError (upstream SAVEPOINT pending)', async () => {
    // DuckDB v1.5.2 doesn't parse SAVEPOINT; nested support is reserved
    // for a future release. The tx.transaction() method is intentionally
    // KEPT (not removed) so types stay stable and future support is a
    // non-breaking addition.
    let caught;
    try {
      await db.transaction(async (tx) => {
        await tx.transaction(async () => { /* never reached */ });
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DuckDBTransactionError);
    expect(caught.message).toMatch(/SAVEPOINT/);
  });

  test('after a rejected transaction, a new transaction works', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    await expect(db.transaction(async () => {
      throw new Error('first one');
    })).rejects.toThrow('first one');

    const r = await db.transaction(async (tx) => {
      await tx.exec('INSERT INTO t VALUES (1)');
      return 'second worked';
    });
    expect(r).toBe('second worked');
  });

  test('return value of fn is the return value of transaction()', async () => {
    const r = await db.transaction(async () => ({ count: 42, name: 'ok' }));
    expect(r).toEqual({ count: 42, name: 'ok' });
  });

  test('transaction passes a scoped TxnHandle as tx (NOT the Connection)', async () => {
    using conn = db.connect();
    let receivedTx;
    await conn.transaction(async (tx) => {
      receivedTx = tx;
      // The handle has the same shortcut methods as Connection.
      expect(typeof tx.query).toBe('function');
      expect(typeof tx.exec).toBe('function');
      expect(typeof tx.transaction).toBe('function');
      // The handle is NOT the Connection itself (different object).
      expect(tx).not.toBe(conn);
    });
    // After the callback returns, the handle MUST reject on use.
    await expect(receivedTx.exec('SELECT 1')).rejects.toThrow(DuckDBTransactionError);
  });

  test('TxnHandle.query/get/run all reject after the callback returns', async () => {
    let stale;
    await db.transaction(async (tx) => { stale = tx; });
    await expect(stale.query('SELECT 1')).rejects.toThrow(DuckDBTransactionError);
    await expect(stale.get('SELECT 1')).rejects.toThrow(DuckDBTransactionError);
    await expect(stale.run('SELECT 1')).rejects.toThrow(DuckDBTransactionError);
    await expect(stale.exec('SELECT 1')).rejects.toThrow(DuckDBTransactionError);
  });

  test('TxnHandle is closed even when the callback throws', async () => {
    let stale;
    try {
      await db.transaction(async (tx) => {
        stale = tx;
        throw new Error('boom');
      });
    } catch { /* expected */ }
    await expect(stale.exec('SELECT 1')).rejects.toThrow(DuckDBTransactionError);
  });
});
