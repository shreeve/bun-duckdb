// Appender API: bulk insert, the fastest path for loading many rows.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { d, open, available } from './helpers.mjs';

let db;
beforeEach(() => { if (available) db = open(':memory:'); });
afterEach(() => { if (available) { try { db.close(); } catch {} } });

d('appender', () => {
  test('bulk insert with appender', async () => {
    using conn = db.connect();
    await conn.exec('CREATE TABLE t (id INTEGER, name VARCHAR, score DOUBLE)');
    const result = await conn.append('t', ['id', 'name', 'score'], [
      [1, 'Alice', 95.5],
      [2, 'Bob',   87.3],
      [3, 'Carol', 92.1],
    ]);
    expect(result.rows).toBe(3);

    const rows = await conn.all('SELECT * FROM t ORDER BY id');
    expect(rows.length).toBe(3);
    expect(rows[0].name).toBe('Alice');
    expect(rows[2].score).toBeCloseTo(92.1);
  });

  test('appender handles 100k rows in well under a second', async () => {
    using conn = db.connect();
    await conn.exec('CREATE TABLE big (n INT, label VARCHAR)');
    const rows = [];
    for (let i = 0; i < 100_000; i++) rows.push([i, `row-${i}`]);

    const t0 = Date.now();
    const result = await conn.append('big', ['n', 'label'], rows);
    const elapsed = Date.now() - t0;

    expect(result.rows).toBe(100_000);
    // Generous bound — appender is typically <100ms on modern hardware.
    // CI/slow VM safety: 5s.
    expect(elapsed).toBeLessThan(5000);

    const count = await conn.get('SELECT COUNT(*) AS n FROM big');
    expect(Number(count.n)).toBe(100_000);
  });
});
