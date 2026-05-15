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

  test('nested transaction throws DuckDBTransactionError', async () => {
    await expect(db.transaction(async (tx) => {
      await tx.transaction(async () => { /* never reached */ });
    })).rejects.toThrow(DuckDBTransactionError);
  });

  test('after a rejected transaction, a new transaction works', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    await expect(db.transaction(async () => {
      throw new Error('first one');
    })).rejects.toThrow('first one');

    // The connection's #inTransaction flag should have been cleared
    // in the finally block, so this second transaction must succeed.
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

  test('transaction passes the Connection as tx', async () => {
    using conn = db.connect();
    let receivedTx;
    await conn.transaction(async (tx) => { receivedTx = tx; });
    expect(receivedTx).toBe(conn);
  });
});
