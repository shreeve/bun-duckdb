// Query API: query/all/get/run/exec on both Database and Connection,
// parameter binding, multi-statement SQL, large result sets.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { d, open, available, version } from './helpers.mjs';

let db;
beforeEach(() => { if (available) db = open(':memory:'); });
afterEach(() => { if (available) { try { db.close(); } catch {} } });

d('version()', () => {
  test('returns a string starting with v', () => {
    const v = version();
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
    expect(v).toMatch(/^v?\d/);
  });
});

d('basic queries', () => {
  test('SELECT 42 returns a row with answer:42', async () => {
    const rows = await db.all('SELECT 42 AS answer');
    expect(rows.length).toBe(1);
    expect(rows[0].answer).toBe(42);
    expect(rows.columns[0].name).toBe('answer');
    expect(rows.columns[0].typeName).toBe('INTEGER');
  });

  test('CREATE/INSERT/SELECT round-trip', async () => {
    await db.exec('CREATE TABLE users (id INT, name VARCHAR)');
    await db.run('INSERT INTO users VALUES (1, ?), (2, ?)', ['Alice', 'Bob']);
    const rows = await db.all('SELECT * FROM users ORDER BY id');
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({ id: 1, name: 'Alice' });
    expect(rows[1]).toEqual({ id: 2, name: 'Bob' });
  });

  test('rowsChanged is BigInt after INSERT', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    const r = await db.run('INSERT INTO t VALUES (1), (2), (3)');
    expect(r.rowsChanged).toBe(3n);
  });

  test('rowsChanged is 0n for SELECT', async () => {
    const rows = await db.all('SELECT 1');
    expect(rows.rowsChanged).toBe(0n);
  });

  test('result is an Array (iterable, indexable, spreadable)', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    await db.run('INSERT INTO t VALUES (1), (2), (3)');
    const rows = await db.all('SELECT * FROM t ORDER BY n');
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(3);
    expect([...rows].length).toBe(3);
    expect(rows[0].n).toBe(1);
    let sum = 0;
    for (const r of rows) sum += r.n;
    expect(sum).toBe(6);
  });
});

d('parameter binding', () => {
  test('positional ? bindings: integer, string, bigint, boolean, null', async () => {
    const rows = await db.all(
      // BIGINT decoder returns Number when the value fits safely, so we use
      // a value that's exactly representable as a Number. Precision is
      // documented in the type-mapping table; this test verifies the bind
      // path is correct, not the precision boundary.
      'SELECT ?::INT AS i, ? AS s, ?::BIGINT AS bi, ? AS b, ? AS n',
      [42, 'hello', 9007199254740992n, true, null],
    );
    expect(rows[0].i).toBe(42);
    expect(rows[0].s).toBe('hello');
    expect(rows[0].bi).toBe(9007199254740992);  // Number, not BigInt — see decoder
    expect(rows[0].b).toBe(true);
    expect(rows[0].n).toBeNull();
  });

  test('Date bound as TIMESTAMP round-trips', async () => {
    const dt = new Date('2025-01-15T12:34:56.000Z');
    const rows = await db.all('SELECT CAST(? AS TIMESTAMP) AS t', [dt]);
    expect(rows[0].t).toBeInstanceOf(Date);
    expect(rows[0].t.toISOString()).toBe(dt.toISOString());
  });
});

d('shortcut equivalence', () => {
  test('db.query and db.all return the same shape', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    await db.run('INSERT INTO t VALUES (42)');
    const a = await db.all('SELECT * FROM t');
    const b = await db.query('SELECT * FROM t');
    expect(a.length).toBe(b.length);
    expect(a[0].n).toBe(b[0].n);
    expect(a.columns[0].name).toBe(b.columns[0].name);
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

  test('db.run returns just rowsChanged', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    const r = await db.run('INSERT INTO t VALUES (1), (2)');
    expect(r).toEqual({ rowsChanged: 2n });
  });

  test('Database shortcuts share one implicit Connection', async () => {
    // Temp tables are per-connection — if shortcuts share a connection,
    // exec creating + run inserting + get reading should all see the same temp table.
    await db.exec('CREATE TEMP TABLE t (n INT)');
    await db.run('INSERT INTO t VALUES (1)');
    const row = await db.get('SELECT * FROM t');
    expect(row.n).toBe(1);
  });

  test('Connection-level shortcuts mirror Database ones', async () => {
    using conn = db.connect();
    await conn.exec('CREATE TABLE t (n INT)');
    await conn.run('INSERT INTO t VALUES (?)', [99]);
    const row = await conn.get('SELECT * FROM t');
    expect(row.n).toBe(99);
  });
});

d('large result sets', () => {
  test('chunk iteration handles results larger than one chunk (>2048 rows)', async () => {
    await db.exec('CREATE TABLE big (n INT)');
    // Insert 5000 rows via Appender (fastest path)
    const conn = db.connect();
    const rows = [];
    for (let i = 0; i < 5000; i++) rows.push([i]);
    await conn.append('big', ['n'], rows);
    conn.close();

    // SELECT all — must span multiple chunks
    const result = await db.all('SELECT * FROM big ORDER BY n');
    expect(result.length).toBe(5000);
    expect(result[0].n).toBe(0);
    expect(result[2048].n).toBe(2048);   // boundary across chunks
    expect(result[4999].n).toBe(4999);
  });
});
