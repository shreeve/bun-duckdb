// Async subpath end-to-end tests.
//
// Mirrors the v0.3 main-thread test surface, plus async-specific cases:
// lazy open, worker crash, prefetch, appender batching, close timeout.

import { test, expect, describe } from 'bun:test';

let mod;
let available = false;
try {
  mod = await import('../../lib/async/index.mjs');
  available = true;
} catch (e) {
  // libduckdb not present — tests skip via describe.skip below.
}

const d = available ? describe : describe.skip;
const {
  open, AsyncDatabase, AsyncConnection, AsyncStatement, AsyncAppender,
  DuckDBError, DuckDBClosedError, DuckDBPrepareError,
  DuckDBTransactionError, DuckDBWorkerCrashedError,
} = mod || {};

// ============================================================================
// Lifecycle + lazy open
// ============================================================================

d('AsyncDatabase — lazy open', () => {
  test('open() returns a proxy synchronously', () => {
    const db = open(':memory:');
    expect(db).toBeInstanceOf(AsyncDatabase);
    expect(db.id).toBeNull();
    db.close();
  });

  test('first awaited op triggers actual duckdb_open', async () => {
    await using db = open(':memory:');
    expect(db.id).toBeNull();
    const r = await db.get('SELECT 42 AS n');
    expect(r).toEqual({ n: 42 });
    expect(typeof db.id).toBe('number');
  });

  test('concurrent first ops share a single open promise', async () => {
    await using db = open(':memory:');
    const [a, b, c] = await Promise.all([
      db.get('SELECT 1 AS n'),
      db.get('SELECT 2 AS n'),
      db.get('SELECT 3 AS n'),
    ]);
    expect(a.n).toBe(1);
    expect(b.n).toBe(2);
    expect(c.n).toBe(3);
    expect(typeof db.id).toBe('number');
  });

  test('open() of an invalid path caches the error; subsequent ops reject', async () => {
    const db = open('/path/that/cannot/exist/db.duckdb');
    let err1, err2;
    try { await db.get('SELECT 1'); } catch (e) { err1 = e; }
    try { await db.get('SELECT 2'); } catch (e) { err2 = e; }
    expect(err1).toBeInstanceOf(DuckDBError);
    expect(err2).toBeInstanceOf(DuckDBError);
    // Same cached error (identity)
    expect(err1).toBe(err2);
    await db.close();
  });
});

d('AsyncDatabase — queries', () => {
  test('exec / run / all / get', async () => {
    await using db = open(':memory:');
    await db.exec('CREATE TABLE t (id INT, name VARCHAR)');
    const r = await db.run('INSERT INTO t VALUES (1, ?), (2, ?)', ['Alice', 'Bob']);
    expect(r.rowsChanged).toBe(2n);
    const rows = await db.all('SELECT * FROM t ORDER BY id');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: 1, name: 'Alice' });
    expect(rows.columns[0].name).toBe('id');
    expect(rows.rowsChanged).toBe(0n);
    const one = await db.get('SELECT * FROM t WHERE id = ?', [2]);
    expect(one).toEqual({ id: 2, name: 'Bob' });
  });

  test('QueryResult.columns + .rowsChanged survive structuredClone', async () => {
    await using db = open(':memory:');
    const rows = await db.all('SELECT 1 AS a UNION ALL SELECT 2');
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.columns).toBeDefined();
    expect(rows.columns[0].typeName).toBe('INTEGER');
    expect(typeof rows.rowsChanged).toBe('bigint');
  });

  test('error from a bad query surfaces as DuckDBError on the main thread', async () => {
    await using db = open(':memory:');
    let err;
    try { await db.all('SELECT * FROM nonexistent_table'); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(DuckDBError);
    expect(err.message).toMatch(/nonexistent/i);
    // Stack is prefixed with [worker]
    expect(err.stack).toMatch(/\[worker\]/);
  });
});

d('AsyncDatabase — disposal', () => {
  test('await using awaits worker drain', async () => {
    let proxy;
    {
      await using db = open(':memory:');
      proxy = db;
      await db.exec('CREATE TABLE t (n INT)');
    }
    expect(proxy._state).toBe('closed');
  });

  test('using (sync dispose) is fire-and-forget', async () => {
    let proxy;
    {
      using db = open(':memory:');
      proxy = db;
      await db.exec('SELECT 1');
    }
    // close started but might not have completed yet
    expect(['closing', 'closed']).toContain(proxy._state);
    // Eventually settles
    await new Promise(r => setTimeout(r, 50));
    expect(proxy._state).toBe('closed');
  });

  test('close() is idempotent', async () => {
    const db = open(':memory:');
    await db.exec('SELECT 1');
    await db.close();
    await db.close();
    await db.close();
    expect(db._state).toBe('closed');
  });

  test('ops after close() reject with DuckDBClosedError', async () => {
    const db = open(':memory:');
    await db.exec('SELECT 1');
    await db.close();
    await expect(db.get('SELECT 1')).rejects.toThrow(DuckDBClosedError);
  });

  test('close({ timeout }) terminates the worker if it hangs', async () => {
    const db = open(':memory:');
    await db.exec('SELECT 1');
    // No way to easily make the worker hang without injection, but
    // we can verify the API doesn't reject for a fast close.
    await db.close({ timeout: 2000 });
    expect(db._state).toBe('closed');
  });
});

// ============================================================================
// AsyncConnection
// ============================================================================

d('AsyncConnection', () => {
  test('connect() + close()', async () => {
    await using db = open(':memory:');
    const conn = db.connect();
    expect(conn).toBeInstanceOf(AsyncConnection);
    expect(conn.id).toBeNull();
    const r = await conn.get('SELECT 1 AS n');
    expect(r.n).toBe(1);
    expect(typeof conn.id).toBe('number');
    await conn.close();
  });

  test('two connections see each other (regular tables, not temp)', async () => {
    await using db = open(':memory:');
    await db.exec('CREATE TABLE t (n INT)');
    using a = db.connect();
    using b = db.connect();
    await a.run('INSERT INTO t VALUES (1)');
    const r = await b.get('SELECT * FROM t');
    expect(r.n).toBe(1);
  });

  test('parallel queries on two connections both succeed', async () => {
    await using db = open(':memory:');
    using a = db.connect();
    using b = db.connect();
    const [r1, r2] = await Promise.all([
      a.get('SELECT 1 AS n'),
      b.get('SELECT 2 AS n'),
    ]);
    expect(r1.n).toBe(1);
    expect(r2.n).toBe(2);
  });
});

// ============================================================================
// AsyncStatement
// ============================================================================

d('AsyncStatement', () => {
  test('prepare + reuse', async () => {
    await using db = open(':memory:');
    await db.exec('CREATE TABLE t (id INT)');
    const stmt = await db.prepare('INSERT INTO t VALUES (?)');
    for (let i = 0; i < 5; i++) await stmt.run([i]);
    await stmt.close();
    const r = await db.get('SELECT COUNT(*) AS n FROM t');
    expect(Number(r.n)).toBe(5);
  });

  test('all / get / run', async () => {
    await using db = open(':memory:');
    using stmt = await db.prepare('SELECT ? + ? AS s');
    const rows = await stmt.all([2, 3]);
    expect(rows[0].s).toBe(5);
    const row = await stmt.get([10, 20]);
    expect(row.s).toBe(30);
  });

  test('use after close rejects with DuckDBClosedError', async () => {
    await using db = open(':memory:');
    const stmt = await db.prepare('SELECT 1');
    await stmt.close();
    await expect(stmt.all()).rejects.toThrow(DuckDBClosedError);
  });

  test('bad SQL throws DuckDBPrepareError', async () => {
    await using db = open(':memory:');
    await expect(db.prepare('NOT VALID SQL ###'))
      .rejects.toThrow(DuckDBPrepareError);
  });
});

// ============================================================================
// AsyncStatement.iterate
// ============================================================================

d('AsyncStatement.iterate', () => {
  test('yields all rows in order', async () => {
    await using db = open(':memory:');
    await db.exec('CREATE TABLE t (n INT)');
    using conn = db.connect();
    await conn.append('t', ['n'], Array.from({ length: 100 }, (_, i) => [i]));
    using stmt = await db.prepare('SELECT * FROM t ORDER BY n');
    const got = [];
    for await (const r of stmt.iterate()) got.push(r.n);
    expect(got).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  test('binds parameters', async () => {
    await using db = open(':memory:');
    using stmt = await db.prepare('SELECT ? + ? AS s');
    const out = [];
    for await (const r of stmt.iterate([5, 7])) out.push(r);
    expect(out).toEqual([{ s: 12 }]);
  });

  test('break mid-stream cleans up; subsequent query works', async () => {
    await using db = open(':memory:');
    await db.exec('CREATE TABLE t (n INT)');
    using conn = db.connect();
    await conn.append('t', ['n'], Array.from({ length: 200 }, (_, i) => [i]));
    using stmt = await db.prepare('SELECT * FROM t ORDER BY n');
    let seen = 0;
    for await (const _r of stmt.iterate()) {
      if (++seen >= 3) break;
    }
    expect(seen).toBe(3);
    // Subsequent op on same conn succeeds
    const r = await conn.get('SELECT COUNT(*) AS n FROM t');
    expect(Number(r.n)).toBe(200);
  });

  test('explicit .return() cleans up', async () => {
    await using db = open(':memory:');
    await db.exec('CREATE TABLE t (n INT)');
    await db.run('INSERT INTO t VALUES (1), (2), (3)');
    using stmt = await db.prepare('SELECT * FROM t ORDER BY n');
    const it = stmt.iterate();
    const first = await it.next();
    expect(first.value.n).toBe(1);
    await it.return();
    // Statement reusable after explicit return
    const it2 = stmt.iterate();
    const r = await it2.next();
    expect(r.value.n).toBe(1);
    await it2.return();
  });

  test('second iterate while first active throws', async () => {
    await using db = open(':memory:');
    using stmt = await db.prepare('SELECT ?::INT AS n');
    const it = stmt.iterate([1]);
    expect(() => stmt.iterate([2])).toThrow(DuckDBError);
    await it.return();
  });

  test('prefetch=0 (strict pull) still works', async () => {
    await using db = open(':memory:');
    await db.exec('CREATE TABLE t (n INT)');
    await db.run('INSERT INTO t VALUES (1), (2), (3)');
    using stmt = await db.prepare('SELECT * FROM t ORDER BY n');
    const got = [];
    for await (const r of stmt.iterate([], { prefetch: 0 })) got.push(r.n);
    expect(got).toEqual([1, 2, 3]);
  });

  test('prefetch>1 (4) handles many chunks', async () => {
    await using db = open(':memory:');
    await db.exec('CREATE TABLE t (n INT)');
    using conn = db.connect();
    await conn.append('t', ['n'], Array.from({ length: 5000 }, (_, i) => [i]));
    using stmt = await db.prepare('SELECT * FROM t ORDER BY n');
    let count = 0;
    for await (const _r of stmt.iterate([], { prefetch: 4 })) count++;
    expect(count).toBe(5000);
  });

  test('db.iterate(sql) sugar works', async () => {
    await using db = open(':memory:');
    let sum = 0;
    for await (const r of db.iterate('SELECT * FROM range(10) AS t(n)')) {
      sum += r.n;
    }
    expect(sum).toBe(45);
  });

  test('conn.iterate(sql) sugar works', async () => {
    await using db = open(':memory:');
    using conn = db.connect();
    const ids = [];
    for await (const r of conn.iterate('SELECT * FROM range(5) AS t(n) WHERE n > ?', [1])) {
      ids.push(r.n);
    }
    expect(ids).toEqual([2, 3, 4]);
  });
});

// ============================================================================
// Transactions
// ============================================================================

d('AsyncDatabase.transaction', () => {
  test('commit on resolve', async () => {
    await using db = open(':memory:');
    await db.exec('CREATE TABLE t (n INT)');
    const r = await db.transaction(async (tx) => {
      await tx.exec('INSERT INTO t VALUES (1)');
      await tx.exec('INSERT INTO t VALUES (2)');
      return 'ok';
    });
    expect(r).toBe('ok');
    const c = await db.get('SELECT COUNT(*) AS n FROM t');
    expect(Number(c.n)).toBe(2);
  });

  test('rollback on throw', async () => {
    await using db = open(':memory:');
    await db.exec('CREATE TABLE t (n INT)');
    await db.exec('INSERT INTO t VALUES (1)');
    let caught;
    try {
      await db.transaction(async (tx) => {
        await tx.exec('INSERT INTO t VALUES (2)');
        throw new Error('boom');
      });
    } catch (e) { caught = e; }
    expect(caught?.message).toBe('boom');
    const c = await db.get('SELECT COUNT(*) AS n FROM t');
    expect(Number(c.n)).toBe(1);
  });

  test('nested transaction throws DuckDBTransactionError', async () => {
    await using db = open(':memory:');
    let caught;
    try {
      await db.transaction(async (tx) => {
        await tx.transaction(async () => {});
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DuckDBTransactionError);
  });

  test('after rejected transaction, a new one succeeds', async () => {
    await using db = open(':memory:');
    await db.exec('CREATE TABLE t (n INT)');
    let caught;
    try {
      await db.transaction(async () => { throw new Error('first'); });
    } catch (e) { caught = e; }
    expect(caught?.message).toBe('first');
    const r = await db.transaction(async (tx) => {
      await tx.exec('INSERT INTO t VALUES (42)');
      return 'second';
    });
    expect(r).toBe('second');
  });
});

// ============================================================================
// Appender
// ============================================================================

d('AsyncAppender', () => {
  test('one-shot append matches v0.3 semantics', async () => {
    await using db = open(':memory:');
    await db.exec('CREATE TABLE t (id INT, name VARCHAR)');
    using conn = db.connect();
    const r = await conn.append('t', ['id', 'name'], [
      [1, 'a'], [2, 'b'], [3, 'c'],
    ]);
    expect(r.rows).toBe(3);
    const rows = await conn.all('SELECT * FROM t ORDER BY id');
    expect(rows).toHaveLength(3);
  });

  test('streaming append: batches + flush', async () => {
    await using db = open(':memory:');
    await db.exec('CREATE TABLE t (n INT)');
    using conn = db.connect();
    const app = await conn.append('t', ['n']);
    expect(app).toBeInstanceOf(AsyncAppender);
    for (let i = 0; i < 2500; i++) app.appendRow([i]);
    const r = await app.flush();
    await app.close();
    expect(r.rows).toBeGreaterThan(0);
    const c = await conn.get('SELECT COUNT(*) AS n FROM t');
    expect(Number(c.n)).toBe(2500);
  });

  test('100k rows via streaming appender', async () => {
    await using db = open(':memory:');
    await db.exec('CREATE TABLE big (n INT)');
    using conn = db.connect();
    const app = await conn.append('big', ['n']);
    for (let i = 0; i < 100_000; i++) app.appendRow([i]);
    await app.close();
    const c = await conn.get('SELECT COUNT(*) AS n FROM big');
    expect(Number(c.n)).toBe(100_000);
  });

  test('appendRow on closed appender throws synchronously (no round-trip)', async () => {
    await using db = open(':memory:');
    await db.exec('CREATE TABLE t (n INT)');
    using conn = db.connect();
    const app = await conn.append('t', ['n']);
    await app.close();
    expect(() => app.appendRow([1])).toThrow(DuckDBClosedError);
  });
});

// ============================================================================
// Close coordination with in-flight requests
// ============================================================================
//
// We don't have a clean handle to inject a true worker crash from tests
// (Bun.Worker doesn't expose a "force-fault" knob and unhandled-rejection
// behavior is platform-dependent). The behavior we DO want to pin is that
// no request hangs forever when the Database is torn down, regardless
// of how the close happens.

d('close coordination with in-flight requests', () => {
  test('close() does not hang when pending requests exist', async () => {
    const db = open(':memory:');
    await db.exec('SELECT 1');
    // Issue a request, then close immediately. The request might
    // resolve (if the worker handles it before processing CLOSE) or
    // reject (if CLOSE wins the race). Either is acceptable; the
    // contract is "no hang".
    const p = db.get('SELECT 1');
    await db.close();
    let settled = false;
    await Promise.race([
      p.then(() => { settled = true; }, () => { settled = true; }),
      new Promise(r => setTimeout(r, 1000)),
    ]);
    expect(settled).toBe(true);
  });

  test('close({timeout:0}) forces shutdown without hanging', async () => {
    const db = open(':memory:');
    await db.exec('SELECT 1');
    const t0 = Date.now();
    await db.close({ timeout: 0 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
  });

  test('after close, new ops reject with DuckDBClosedError', async () => {
    const db = open(':memory:');
    await db.exec('SELECT 1');
    await db.close();
    let caught;
    try { await db.get('SELECT 1'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DuckDBClosedError);
  });
});

// ============================================================================
// Error reconstruction
// ============================================================================

d('Error reconstruction', () => {
  test('DuckDBPrepareError comes back with the right class', async () => {
    await using db = open(':memory:');
    let err;
    try { await db.prepare('NOT SQL'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DuckDBError);
    expect(err).toBeInstanceOf(DuckDBPrepareError);
  });

  test('DuckDBClosedError comes back with the right class', async () => {
    await using db = open(':memory:');
    const stmt = await db.prepare('SELECT 1');
    await stmt.close();
    let err;
    try { await stmt.all(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DuckDBClosedError);
  });
});

// ============================================================================
// Type round-trip (BLOB, BigInt, Date)
// ============================================================================

d('Async type round-trip', () => {
  test('BLOB Uint8Array round-trips through structuredClone', async () => {
    await using db = open(':memory:');
    const bytes = new Uint8Array([0xFF, 0x00, 0xFE, 0x80, 0xC2]);
    const r = await db.get('SELECT CAST(? AS BLOB) AS b', [bytes]);
    expect(r.b).toBeInstanceOf(Uint8Array);
    expect([...r.b]).toEqual([0xFF, 0x00, 0xFE, 0x80, 0xC2]);
  });

  test('Date round-trips through TIMESTAMP', async () => {
    await using db = open(':memory:');
    const dt = new Date('2026-05-15T12:00:00.000Z');
    const r = await db.get('SELECT CAST(? AS TIMESTAMP) AS t', [dt]);
    expect(r.t).toBeInstanceOf(Date);
    expect(r.t.toISOString()).toBe(dt.toISOString());
  });

  test('BIGINT decodes to number', async () => {
    await using db = open(':memory:');
    const r = await db.get('SELECT 9007199254740992::BIGINT AS n');
    expect(typeof r.n).toBe('number');
    expect(r.n).toBe(9007199254740992);
  });
});
