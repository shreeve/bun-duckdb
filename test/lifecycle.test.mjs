// Database, Connection, and Statement lifecycle:
//   - open / close / Symbol.dispose
//   - cross-resource cleanup (Database close → implicit Connection,
//     Connection close → outstanding Statements)
//   - closed-state checks (closed Database can't silently re-create
//     an implicit Connection)

import { test, expect, beforeEach, afterEach } from 'bun:test';
import {
  d, open, available,
  DuckDBClosedError,
} from './helpers.mjs';

let db;
beforeEach(() => { if (available) db = open(':memory:'); });
afterEach(() => { if (available) { try { db.close(); } catch {} } });

d('Database', () => {
  test('open(":memory:") returns a Database', () => {
    const d2 = open(':memory:');
    expect(d2).toBeTruthy();
    expect(typeof d2.handle).toBe('bigint');
    d2.close();
  });

  test('open() with on-disk path works', () => {
    const path = `/tmp/duckdb-bun-test-${Date.now()}.duckdb`;
    const d2 = open(path);
    expect(d2).toBeTruthy();
    d2.close();
    // Cleanup the file
    try {
      const { unlinkSync } = require('fs');
      unlinkSync(path);
      try { unlinkSync(path + '.wal'); } catch {}
    } catch {}
  });

  test('close() is idempotent', () => {
    const d2 = open(':memory:');
    d2.close();
    expect(() => d2.close()).not.toThrow();
    expect(() => d2.close()).not.toThrow();
  });

  test('handle is null after close()', () => {
    const d2 = open(':memory:');
    d2.close();
    expect(d2.handle).toBeNull();
  });

  test('shortcut on a closed Database throws DuckDBClosedError', async () => {
    const d2 = open(':memory:');
    d2.close();
    await expect(d2.all('SELECT 1')).rejects.toThrow(DuckDBClosedError);
    await expect(d2.exec('SELECT 1')).rejects.toThrow(DuckDBClosedError);
    await expect(d2.prepare('SELECT 1')).rejects.toThrow(DuckDBClosedError);
  });

  test('Symbol.dispose enables `using` syntax', async () => {
    let captured;
    {
      using inner = open(':memory:');
      captured = inner;
      await inner.exec('CREATE TABLE t (n INT)');
      const row = await inner.get('SELECT 42 AS n');
      expect(row.n).toBe(42);
    }
    // After the using scope exits, close() has been called.
    expect(captured.handle).toBeNull();
  });
});

d('Connection', () => {
  test('connect() returns a Connection', () => {
    const conn = db.connect();
    expect(conn).toBeTruthy();
    expect(typeof conn.handle).toBe('bigint');
    conn.close();
  });

  test('multiple connections per Database are independent', async () => {
    const a = db.connect();
    const b = db.connect();
    expect(a.handle).not.toBe(b.handle);
    await a.exec('CREATE TEMP TABLE t (n INT)');
    // Temp tables are per-connection, so b shouldn't see it
    await expect(b.query('SELECT * FROM t')).rejects.toThrow();
    a.close();
    b.close();
  });

  test('close() is idempotent', () => {
    const conn = db.connect();
    conn.close();
    expect(() => conn.close()).not.toThrow();
  });

  test('Symbol.dispose enables `using` syntax', async () => {
    let captured;
    {
      using conn = db.connect();
      captured = conn;
      const row = await conn.get('SELECT 1 AS n');
      expect(row.n).toBe(1);
    }
    expect(captured.handle).toBeNull();
  });

  test('parallel queries on multiple Connections both succeed', async () => {
    const a = db.connect();
    const b = db.connect();
    const [r1, r2] = await Promise.all([
      a.all('SELECT 1 AS n'),
      b.all('SELECT 2 AS n'),
    ]);
    expect(r1[0].n).toBe(1);
    expect(r2[0].n).toBe(2);
    a.close();
    b.close();
  });
});

d('Cross-resource cleanup', () => {
  test('Connection.close cascades to outstanding Statements', async () => {
    const conn = db.connect();
    const stmt1 = await conn.prepare('SELECT 1 AS n');
    const stmt2 = await conn.prepare('SELECT 2 AS m');
    expect(stmt1.closed).toBe(false);
    expect(stmt2.closed).toBe(false);
    conn.close();
    expect(stmt1.closed).toBe(true);
    expect(stmt2.closed).toBe(true);
  });

  test('using a Statement after its Connection closes throws DuckDBClosedError', async () => {
    const conn = db.connect();
    const stmt = await conn.prepare('SELECT ? AS n');
    conn.close();
    await expect(stmt.run([1])).rejects.toThrow(DuckDBClosedError);
  });

  test('Database.close cascades through implicit Connection to its Statements', async () => {
    const d2 = open(':memory:');
    const stmt = await d2.prepare('SELECT 1');
    d2.close();
    expect(stmt.closed).toBe(true);
  });
});
