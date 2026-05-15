// Statement.iterate() — streaming results across the FFI boundary.
//
// These tests exercise the close-coordination protocol (paused-generator
// cancellation), cleanup on early break/return/throw, and the
// Connection.iterate / Database.iterate sugar.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import {
  d, open, available,
  DuckDBClosedError, DuckDBError,
} from './helpers.mjs';

let db;
beforeEach(() => { if (available) db = open(':memory:'); });
afterEach(async () => { if (available && db) { try { await db.close(); } catch {} } });

d('Statement.iterate — happy paths', () => {
  test('yields all rows in order', async () => {
    using conn = db.connect();
    await conn.exec('CREATE TABLE t (n INT)');
    await conn.run('INSERT INTO t VALUES (1), (2), (3), (4), (5)');
    using stmt = await conn.prepare('SELECT * FROM t ORDER BY n');
    const got = [];
    for await (const row of stmt.iterate()) got.push(row.n);
    expect(got).toEqual([1, 2, 3, 4, 5]);
  });

  test('binds positional params', async () => {
    using stmt = await db.prepare('SELECT ? + ? AS s');
    const rows = [];
    for await (const row of stmt.iterate([2, 3])) rows.push(row);
    expect(rows).toEqual([{ s: 5 }]);
  });

  test('empty result yields nothing', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    using stmt = await db.prepare('SELECT * FROM t');
    let count = 0;
    for await (const _row of stmt.iterate()) count++;
    expect(count).toBe(0);
  });

  test('iterates across chunk boundaries (>2048 rows)', async () => {
    using conn = db.connect();
    await conn.exec('CREATE TABLE big (n INT)');
    const rows = [];
    for (let i = 0; i < 5000; i++) rows.push([i]);
    await conn.append('big', ['n'], rows);

    using stmt = await conn.prepare('SELECT * FROM big ORDER BY n');
    let count = 0;
    let lastSeen = -1;
    for await (const row of stmt.iterate()) {
      expect(row.n).toBe(lastSeen + 1);
      lastSeen = row.n;
      count++;
    }
    expect(count).toBe(5000);
    expect(lastSeen).toBe(4999);
  });

  test('row decoding contract holds (varchar, blob, null)', async () => {
    using conn = db.connect();
    await conn.exec("CREATE TABLE mixed (a VARCHAR, b BLOB, c INT)");
    await conn.append('mixed', ['a', 'b', 'c'], [
      ['hello', new Uint8Array([0xFF, 0x00]), 42],
      [null, null, null],
    ]);
    using stmt = await conn.prepare('SELECT * FROM mixed ORDER BY a NULLS LAST');
    const rows = [];
    for await (const row of stmt.iterate()) rows.push(row);
    expect(rows[0].a).toBe('hello');
    expect([...rows[0].b]).toEqual([0xFF, 0x00]);
    expect(rows[0].c).toBe(42);
    expect(rows[1].a).toBeNull();
    expect(rows[1].b).toBeNull();
    expect(rows[1].c).toBeNull();
  });
});

d('Statement.iterate — cleanup on early termination', () => {
  test('break mid-stream releases the lock; subsequent query works', async () => {
    using conn = db.connect();
    await conn.exec('CREATE TABLE t (n INT)');
    const rows = [];
    for (let i = 0; i < 5000; i++) rows.push([i]);
    await conn.append('t', ['n'], rows);

    using stmt = await conn.prepare('SELECT * FROM t ORDER BY n');
    let count = 0;
    for await (const _row of stmt.iterate()) {
      if (++count >= 3) break;          // break mid-chunk
    }
    expect(count).toBe(3);
    // If the lock weren't released, this next query would hang forever.
    const r = await conn.get('SELECT COUNT(*) AS n FROM t');
    expect(Number(r.n)).toBe(5000);
  });

  test('throw mid-stream releases the lock; subsequent query works', async () => {
    using conn = db.connect();
    await conn.exec('CREATE TABLE t (n INT)');
    await conn.run('INSERT INTO t VALUES (1), (2), (3)');
    using stmt = await conn.prepare('SELECT * FROM t');
    let thrown;
    try {
      for await (const _row of stmt.iterate()) {
        throw new Error('user break');
      }
    } catch (e) { thrown = e; }
    expect(thrown.message).toBe('user break');
    const r = await conn.get('SELECT COUNT(*) AS n FROM t');
    expect(Number(r.n)).toBe(3);
  });

  test('explicit .return() releases the lock', async () => {
    using conn = db.connect();
    await conn.exec('CREATE TABLE t (n INT)');
    await conn.run('INSERT INTO t VALUES (1), (2), (3)');
    using stmt = await conn.prepare('SELECT * FROM t');
    const it = stmt.iterate();
    const first = await it.next();
    expect(first.value.n).toBe(1);
    await it.return();
    // Lock released — next operation succeeds.
    const r = await conn.get('SELECT n FROM t WHERE n = 2');
    expect(r.n).toBe(2);
  });

  test('pre-start .return() (never called .next()) leaves statement usable', async () => {
    using conn = db.connect();
    using stmt = await conn.prepare('SELECT ? AS n');
    const it = stmt.iterate([42]);
    // Caller abandons immediately without iterating.
    await it.return();
    // Statement should be reusable: get(), all(), and a fresh iterate().
    const row = await stmt.get([99]);
    expect(row.n).toBe(99);
  });
});

d('Statement.iterate — concurrency guards', () => {
  test('second iterate() on same Statement throws while first is active', async () => {
    using conn = db.connect();
    using stmt = await conn.prepare('SELECT ?::INT AS n');
    const it = stmt.iterate([1]);
    expect(() => stmt.iterate([2])).toThrow(DuckDBError);
    await it.return();
    // Now it should work again.
    const it2 = stmt.iterate([2]);
    const got = (await it2.next()).value;
    expect(got.n).toBe(2);
    await it2.return();
  });

  test('stmt.all() while iterate is active throws DuckDBError', async () => {
    using conn = db.connect();
    using stmt = await conn.prepare('SELECT ?::INT AS n');
    const it = stmt.iterate([1]);
    await expect(stmt.all([2])).rejects.toThrow(DuckDBError);
    await it.return();
  });
});

d('Statement.iterate — close coordination', () => {
  test('stmt.close() mid-iteration terminates the iterator and frees the connection', async () => {
    using conn = db.connect();
    await conn.exec('CREATE TABLE t (n INT)');
    const rows = [];
    for (let i = 0; i < 1000; i++) rows.push([i]);
    await conn.append('t', ['n'], rows);

    const stmt = await conn.prepare('SELECT * FROM t');
    const it = stmt.iterate();
    await it.next();   // consume one row; iterator paused at next yield
    await stmt.close();
    expect(stmt.closed).toBe(true);
    // Subsequent .next() should resolve as { done: true }.
    const after = await it.next();
    expect(after.done).toBe(true);
    // Connection is still usable.
    const r = await conn.get('SELECT COUNT(*) AS n FROM t');
    expect(Number(r.n)).toBe(1000);
  });

  test('conn.close() mid-iteration terminates iterator + releases lock', async () => {
    const conn = db.connect();
    await conn.exec('CREATE TABLE t (n INT)');
    await conn.run('INSERT INTO t VALUES (1), (2), (3), (4), (5)');
    const stmt = await conn.prepare('SELECT * FROM t');
    const it = stmt.iterate();
    await it.next();
    await conn.close();
    expect(stmt.closed).toBe(true);
    const after = await it.next();
    expect(after.done).toBe(true);
  });

  test('db.close() cascades through implicit conn + iterators', async () => {
    const d2 = open(':memory:');
    await d2.exec('CREATE TABLE t (n INT)');
    await d2.run('INSERT INTO t VALUES (1), (2)');
    const it = d2.iterate('SELECT * FROM t');
    await it.next();
    await d2.close();
    const after = await it.next();
    expect(after.done).toBe(true);
  });
});

d('Connection.iterate / Database.iterate sugar', () => {
  test('conn.iterate(sql, params) streams without manual prepare', async () => {
    using conn = db.connect();
    await conn.exec('CREATE TABLE t (n INT)');
    await conn.run('INSERT INTO t VALUES (10), (20), (30)');
    const got = [];
    for await (const row of conn.iterate('SELECT * FROM t WHERE n > ? ORDER BY n', [10])) {
      got.push(row.n);
    }
    expect(got).toEqual([20, 30]);
  });

  test('conn.iterate is lazy: abandoning the iterator allocates no FFI handle', async () => {
    using conn = db.connect();
    await conn.exec('CREATE TABLE t (n INT)');
    await conn.run('INSERT INTO t VALUES (1)');
    const it = conn.iterate('SELECT * FROM t');
    await it.return();
    // The Connection is still in a clean state — a follow-up query
    // succeeds without errors about an unclosed prepared handle.
    const row = await conn.get('SELECT n FROM t');
    expect(row.n).toBe(1);
  });

  test('conn.iterate closes its temp Statement on early break', async () => {
    using conn = db.connect();
    await conn.exec('CREATE TABLE t (n INT)');
    const rows = [];
    for (let i = 0; i < 5000; i++) rows.push([i]);
    await conn.append('t', ['n'], rows);
    let count = 0;
    for await (const _row of conn.iterate('SELECT * FROM t ORDER BY n')) {
      if (++count >= 5) break;
    }
    expect(count).toBe(5);
    // If the temp Statement leaked, the next operation might hang or
    // surface a "statement already iterating" error.
    const r = await conn.get('SELECT COUNT(*) AS n FROM t');
    expect(Number(r.n)).toBe(5000);
  });

  test('db.iterate(sql) works through the implicit Connection', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    await db.run('INSERT INTO t VALUES (7), (8), (9)');
    const got = [];
    for await (const row of db.iterate('SELECT * FROM t ORDER BY n')) {
      got.push(row.n);
    }
    expect(got).toEqual([7, 8, 9]);
  });
});

d('Statement.iterate — closed-state checks', () => {
  test('iterate() on a closed Statement throws DuckDBClosedError', async () => {
    using conn = db.connect();
    const stmt = await conn.prepare('SELECT 1');
    await stmt.close();
    expect(() => stmt.iterate()).toThrow(DuckDBClosedError);
  });

  test('iterate() on a Statement whose Connection is closed throws DuckDBClosedError', async () => {
    const conn = db.connect();
    const stmt = await conn.prepare('SELECT 1');
    await conn.close();
    expect(() => stmt.iterate()).toThrow(DuckDBClosedError);
  });
});

d('Statement.iterate — stress', () => {
  test('1000 short iterators, no leak / no hang', async () => {
    using conn = db.connect();
    await conn.exec('CREATE TABLE t (n INT)');
    await conn.append('t', ['n'], Array.from({ length: 10 }, (_, i) => [i]));
    for (let trial = 0; trial < 1000; trial++) {
      using stmt = await conn.prepare('SELECT * FROM t ORDER BY n');
      let count = 0;
      for await (const _row of stmt.iterate()) {
        if (++count >= 3) break;
      }
      expect(count).toBe(3);
    }
    // Sanity: connection still usable.
    const r = await conn.get('SELECT COUNT(*) AS n FROM t');
    expect(Number(r.n)).toBe(10);
  });
});

d('Per-Connection lock parallelism', () => {
  test('iterator on conn A does not block queries on conn B', async () => {
    using a = db.connect();
    using b = db.connect();
    await a.exec('CREATE TABLE t (n INT)');
    await a.run('INSERT INTO t VALUES (1), (2), (3), (4), (5)');

    const itA = a.iterate('SELECT * FROM t ORDER BY n');
    const first = await itA.next();
    expect(first.value.n).toBe(1);
    // While itA is paused holding conn A's lock, conn B must be free.
    const row = await b.get("SELECT 99 AS n");
    expect(row.n).toBe(99);
    await itA.return();
  });
});
