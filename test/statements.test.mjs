// Statement: prepare(sql), reuse across executes, all/get/run, rebind,
// closed-state checks, Symbol.dispose.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import {
  d, open, available,
  DuckDBClosedError, DuckDBPrepareError,
} from './helpers.mjs';

let db;
beforeEach(() => { if (available) db = open(':memory:'); });
afterEach(() => { if (available) { try { db.close(); } catch {} } });

d('Statement creation', () => {
  test('db.prepare(sql) returns a Statement', async () => {
    const stmt = await db.prepare('SELECT 1');
    expect(stmt).toBeTruthy();
    expect(stmt.closed).toBe(false);
    stmt.close();
  });

  test('conn.prepare(sql) returns a Statement (same shape as db.prepare)', async () => {
    using conn = db.connect();
    const stmt = await conn.prepare('SELECT 1');
    expect(stmt.closed).toBe(false);
    stmt.close();
  });

  test('prepare() with bad SQL throws DuckDBPrepareError', async () => {
    await expect(db.prepare('NOT VALID SQL ###')).rejects.toThrow(DuckDBPrepareError);
  });
});

d('Statement execution', () => {
  test('all() returns QueryResult with rows + columns', async () => {
    using stmt = await db.prepare('SELECT ? AS n');
    const rows = await stmt.all([42]);
    expect(rows.length).toBe(1);
    expect(rows[0].n).toBe(42);
    expect(rows.columns[0].name).toBe('n');
  });

  test('get() returns first row, or undefined', async () => {
    using stmt = await db.prepare('SELECT ? AS n');
    const row = await stmt.get([99]);
    expect(row).toEqual({ n: 99 });
  });

  test('get() returns undefined when no rows', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    using stmt = await db.prepare('SELECT * FROM t');
    const row = await stmt.get();
    expect(row).toBeUndefined();
  });

  test('run() returns { rowsChanged }', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    using stmt = await db.prepare('INSERT INTO t VALUES (?)');
    const r = await stmt.run([1]);
    expect(r).toEqual({ rowsChanged: 1n });
  });
});

d('Statement reuse', () => {
  test('prepare → run repeatedly with different params reuses one prepared handle', async () => {
    await db.exec('CREATE TABLE t (id INT, name VARCHAR)');
    using stmt = await db.prepare('INSERT INTO t VALUES (?, ?)');
    await stmt.run([1, 'a']);
    await stmt.run([2, 'b']);
    await stmt.run([3, 'c']);
    const rows = await db.all('SELECT * FROM t ORDER BY id');
    expect(rows.length).toBe(3);
    expect(rows[2].name).toBe('c');
  });

  test('rebind across calls — parameters from one call do not leak into the next', async () => {
    using stmt = await db.prepare('SELECT ? AS first, ? AS second');
    const a = await stmt.get([1, 2]);
    const b = await stmt.get([10, 20]);
    expect(a).toEqual({ first: 1, second: 2 });
    expect(b).toEqual({ first: 10, second: 20 });
  });

  test('SELECT prepared statement reused across many calls', async () => {
    await db.exec('CREATE TABLE t (id INT, name VARCHAR)');
    await db.run('INSERT INTO t VALUES (1, \'a\'), (2, \'b\'), (3, \'c\')');
    using stmt = await db.prepare('SELECT * FROM t WHERE id = ?');
    const a = await stmt.get([1]);
    const b = await stmt.get([2]);
    const c = await stmt.get([3]);
    expect(a.name).toBe('a');
    expect(b.name).toBe('b');
    expect(c.name).toBe('c');
  });
});

d('Statement lifecycle', () => {
  test('close() is idempotent', async () => {
    const stmt = await db.prepare('SELECT 1');
    expect(stmt.closed).toBe(false);
    stmt.close();
    expect(stmt.closed).toBe(true);
    stmt.close();   // should not throw
    expect(stmt.closed).toBe(true);
  });

  test('use after close throws DuckDBClosedError', async () => {
    const stmt = await db.prepare('SELECT 1');
    stmt.close();
    await expect(stmt.run()).rejects.toThrow(DuckDBClosedError);
    await expect(stmt.all()).rejects.toThrow(DuckDBClosedError);
    await expect(stmt.get()).rejects.toThrow(DuckDBClosedError);
  });

  test('Symbol.dispose enables `using` syntax', async () => {
    let captured;
    {
      using stmt = await db.prepare('SELECT 1 AS n');
      captured = stmt;
      const row = await stmt.get();
      expect(row.n).toBe(1);
    }
    expect(captured.closed).toBe(true);
  });
});
