// Tests for v0.2 additions:
//   - db.all/get/run/exec/prepare/transaction shortcuts
//   - Statement class (all/get/run, close, idempotency, use-after-close)
//   - Symbol.dispose on Database, Connection, Statement
//   - Error classes (DuckDBError, DuckDBClosedError, DuckDBPrepareError,
//     DuckDBTransactionError)
//   - Lazy implicit Connection lifecycle

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

let open, version;
let DuckDBError, DuckDBClosedError, DuckDBPrepareError, DuckDBTransactionError;
let available = false;

try {
  ({
    open, version,
    DuckDBError, DuckDBClosedError, DuckDBPrepareError, DuckDBTransactionError,
  } = await import('../lib/duckdb.mjs'));
  available = true;
} catch {
  // libduckdb not installed — skip these tests too
}

const d = available ? describe : describe.skip;

let db;
beforeEach(() => { if (available) db = open(':memory:'); });
afterEach(() => { if (available) db?.close(); });

// =============================================================================
// Database shortcuts
// =============================================================================

d('Database shortcuts', () => {
  test('db.exec runs DDL via implicit Connection', async () => {
    await db.exec('CREATE TABLE t (id INT, name VARCHAR)');
    const cols = await db.all("SELECT column_name FROM information_schema.columns WHERE table_name = 't'");
    expect(cols.length).toBe(2);
  });

  test('db.run returns rowsChanged for DML', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    const r = await db.run('INSERT INTO t VALUES (?), (?), (?)', [1, 2, 3]);
    expect(r.rowsChanged).toBe(3n);
  });

  test('db.all returns full QueryResult with rows + columns', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    await db.run('INSERT INTO t VALUES (1), (2)');
    const rows = await db.all('SELECT * FROM t ORDER BY n');
    expect(rows.length).toBe(2);
    expect(rows[0].n).toBe(1);
    expect(rows.columns).toBeDefined();
    expect(rows.columns[0].name).toBe('n');
  });

  test('db.get returns first row', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    await db.run('INSERT INTO t VALUES (1), (2), (3)');
    const row = await db.get('SELECT * FROM t ORDER BY n');
    expect(row).toEqual({ n: 1 });
  });

  test('db.get returns undefined when no rows', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    const row = await db.get('SELECT * FROM t');
    expect(row).toBeUndefined();
  });

  test('db.query is identical to db.all', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    await db.run('INSERT INTO t VALUES (42)');
    const a = await db.all('SELECT * FROM t');
    const b = await db.query('SELECT * FROM t');
    expect(b.length).toBe(a.length);
    expect(b[0].n).toBe(a[0].n);
  });

  test('shortcuts share one implicit Connection', async () => {
    // Sanity: DDL/DML in one call is visible to next call (same conn)
    await db.exec('CREATE TEMP TABLE t (n INT)');
    await db.run('INSERT INTO t VALUES (1)');
    const row = await db.get('SELECT * FROM t');
    expect(row.n).toBe(1);
  });
});

// =============================================================================
// Statement
// =============================================================================

d('Statement', () => {
  test('prepare → run multiple times reuses the prepared handle', async () => {
    await db.exec('CREATE TABLE t (id INT, name VARCHAR)');
    const stmt = await db.prepare('INSERT INTO t VALUES (?, ?)');
    await stmt.run([1, 'a']);
    await stmt.run([2, 'b']);
    await stmt.run([3, 'c']);
    stmt.close();
    const rows = await db.all('SELECT * FROM t ORDER BY id');
    expect(rows.length).toBe(3);
    expect(rows[2].name).toBe('c');
  });

  test('Statement.all returns QueryResult', async () => {
    const stmt = await db.prepare('SELECT ? AS n');
    const rows = await stmt.all([42]);
    expect(rows[0].n).toBe(42);
    expect(rows.columns[0].name).toBe('n');
    stmt.close();
  });

  test('Statement.get returns first row or undefined', async () => {
    const stmt = await db.prepare('SELECT ? AS n');
    const row = await stmt.get([99]);
    expect(row).toEqual({ n: 99 });
    stmt.close();
  });

  test('Statement.run returns rowsChanged', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    const stmt = await db.prepare('INSERT INTO t VALUES (?)');
    const r = await stmt.run([1]);
    expect(r.rowsChanged).toBe(1n);
    stmt.close();
  });

  test('Statement.close is idempotent', async () => {
    const stmt = await db.prepare('SELECT 1');
    expect(stmt.closed).toBe(false);
    stmt.close();
    expect(stmt.closed).toBe(true);
    stmt.close();   // should not throw
    expect(stmt.closed).toBe(true);
  });

  test('Statement use-after-close throws DuckDBClosedError', async () => {
    const stmt = await db.prepare('SELECT 1');
    stmt.close();
    await expect(stmt.run()).rejects.toThrow(DuckDBClosedError);
  });

  test('prepare() bad SQL throws DuckDBPrepareError', async () => {
    await expect(db.prepare('NOT VALID SQL ###')).rejects.toThrow(DuckDBPrepareError);
  });
});

// =============================================================================
// Transactions
// =============================================================================

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

  test('return value of fn is the return value of transaction()', async () => {
    const r = await db.transaction(async () => ({ count: 42, name: 'ok' }));
    expect(r).toEqual({ count: 42, name: 'ok' });
  });
});

// =============================================================================
// Symbol.dispose
// =============================================================================

d('Symbol.dispose', () => {
  test('Database has Symbol.dispose', () => {
    const db2 = open(':memory:');
    expect(typeof db2[Symbol.dispose]).toBe('function');
    db2[Symbol.dispose]();
    // Calling again should not throw (idempotent close)
    db2[Symbol.dispose]();
  });

  test('Connection has Symbol.dispose', () => {
    const conn = db.connect();
    expect(typeof conn[Symbol.dispose]).toBe('function');
    conn[Symbol.dispose]();
    conn[Symbol.dispose]();
  });

  test('Statement has Symbol.dispose', async () => {
    const stmt = await db.prepare('SELECT 1');
    expect(typeof stmt[Symbol.dispose]).toBe('function');
    stmt[Symbol.dispose]();
    expect(stmt.closed).toBe(true);
  });

  test('"using" syntax cleans up automatically (Database)', async () => {
    let captured;
    {
      using inner = open(':memory:');
      captured = inner;
      await inner.exec('CREATE TABLE t (n INT)');
      const row = await inner.get('SELECT 42 AS n');
      expect(row.n).toBe(42);
    }
    // After `using` scope exits, inner.close() has been called.
    // Implementation detail: handle should be null now.
    expect(captured.handle).toBeNull();
  });

  test('"using" syntax cleans up Statement', async () => {
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

// =============================================================================
// Lifecycle / cross-resource ownership (GPT 5.5 review blockers)
// =============================================================================

d('Statement lifetime when Connection closes', () => {
  test('Connection.close also closes outstanding Statements', async () => {
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
    // Statement was auto-closed by Connection.close, so Statement-level
    // closed check fires first.
    await expect(stmt.run([1])).rejects.toThrow(DuckDBClosedError);
  });

  test('Database.close cascades through implicit Connection to its Statements', async () => {
    const db2 = open(':memory:');
    const stmt = await db2.prepare('SELECT 1');
    db2.close();
    expect(stmt.closed).toBe(true);
  });
});

d('Database lifecycle (closed-state checks)', () => {
  test('double db.close() is safe', () => {
    const db2 = open(':memory:');
    db2.close();
    expect(() => db2.close()).not.toThrow();
  });

  test('shortcut on a closed Database throws DuckDBClosedError, not crash', async () => {
    const db2 = open(':memory:');
    db2.close();
    await expect(db2.all('SELECT 1')).rejects.toThrow(DuckDBClosedError);
    await expect(db2.exec('SELECT 1')).rejects.toThrow(DuckDBClosedError);
    await expect(db2.prepare('SELECT 1')).rejects.toThrow(DuckDBClosedError);
  });

  test('Database does not silently re-create implicit conn after close', async () => {
    const db2 = open(':memory:');
    await db2.exec('CREATE TABLE t (n INT)');
    await db2.run('INSERT INTO t VALUES (1)');
    db2.close();
    // Re-opening a fresh DB at the same path would not see the data
    // (it was :memory:); calling .all on the closed DB must reject.
    await expect(db2.all('SELECT * FROM t')).rejects.toThrow(DuckDBClosedError);
  });
});

// =============================================================================
// Error classes
// =============================================================================

d('error classes', () => {
  test('all errors extend DuckDBError', () => {
    expect(new DuckDBClosedError() instanceof DuckDBError).toBe(true);
    expect(new DuckDBPrepareError('x') instanceof DuckDBError).toBe(true);
    expect(new DuckDBTransactionError('x') instanceof DuckDBError).toBe(true);
  });

  test('DuckDBError extends Error', () => {
    expect(new DuckDBError('x') instanceof Error).toBe(true);
  });

  test('error names are correct for instanceof discrimination', () => {
    expect(new DuckDBClosedError().name).toBe('DuckDBClosedError');
    expect(new DuckDBPrepareError('x').name).toBe('DuckDBPrepareError');
    expect(new DuckDBTransactionError('x').name).toBe('DuckDBTransactionError');
  });
});
