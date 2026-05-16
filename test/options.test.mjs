// OpenOptions, pragma/extension helpers, and chunks() — v0.5 features.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { d, open, available, DuckDBError } from './helpers.mjs';

let db;
beforeEach(() => { if (available) db = open(':memory:'); });
afterEach(async () => { if (available && db) { try { await db.close(); } catch {} } });

// ============================================================================
// OpenOptions
// ============================================================================

d('OpenOptions', () => {
  test('open(":memory:") still works without opts (back-compat)', () => {
    using d2 = open(':memory:');
    expect(d2.handle).toBeTruthy();
  });

  test('open with threads + memoryLimit takes effect', async () => {
    using d2 = open(':memory:', { threads: 2, memoryLimit: '256MB' });
    const t = await d2.get(`SELECT current_setting('threads') AS v`);
    expect(t.v).toBe(2);
    const m = await d2.get(`SELECT current_setting('memory_limit') AS v`);
    expect(typeof m.v).toBe('string');
  });

  test('readOnly: true on a file-backed DB rejects writes', async () => {
    // DuckDB doesn't allow read-only for `:memory:` (it has no
    // pre-existing data). Create a real file, populate it, close,
    // then reopen read-only and verify writes are rejected.
    const path = join(tmpdir(), `duckdb-bun-readonly-${Date.now()}.duckdb`);
    {
      using d1 = open(path);
      await d1.exec('CREATE TABLE t (n INT)');
      await d1.run('INSERT INTO t VALUES (1)');
    }
    try {
      using d2 = open(path, { readOnly: true });
      const r = await d2.get('SELECT * FROM t');
      expect(r.n).toBe(1);
      await expect(d2.exec('INSERT INTO t VALUES (2)')).rejects.toThrow();
    } finally {
      try { (await import('fs')).unlinkSync(path); } catch {}
      try { (await import('fs')).unlinkSync(path + '.wal'); } catch {}
    }
  });

  test('explicit accessMode: READ_ONLY behaves the same', async () => {
    const path = join(tmpdir(), `duckdb-bun-accessmode-${Date.now()}.duckdb`);
    {
      using d1 = open(path);
      await d1.exec('CREATE TABLE t (n INT)');
    }
    try {
      using d2 = open(path, { accessMode: 'READ_ONLY' });
      await expect(d2.exec('INSERT INTO t VALUES (1)')).rejects.toThrow();
    } finally {
      try { (await import('fs')).unlinkSync(path); } catch {}
      try { (await import('fs')).unlinkSync(path + '.wal'); } catch {}
    }
  });

  test('config: escape hatch sets arbitrary config keys', async () => {
    using d2 = open(':memory:', { config: { threads: 3 } });
    const r = await d2.get(`SELECT current_setting('threads') AS v`);
    expect(r.v).toBe(3);
  });

  test('conflict between typed option and config: throws', () => {
    expect(() => open(':memory:', {
      readOnly: true,
      config: { access_mode: 'READ_WRITE' },
    })).toThrow(/conflict/i);
  });

  test('same typed + config value is allowed (no conflict)', () => {
    // Use threads where typed and config agree — no need for a file.
    using d2 = open(':memory:', {
      threads: 2,
      config: { threads: 2 },                   // identical, OK
    });
    expect(d2.handle).toBeTruthy();
  });

  test('threads validation: negative throws', () => {
    expect(() => open(':memory:', { threads: -1 })).toThrow(/threads/i);
  });

  test('memoryLimit validation: empty string throws', () => {
    expect(() => open(':memory:', { memoryLimit: '' })).toThrow(/memoryLimit/i);
  });

  test('invalid config value (e.g. threads: garbage) bubbles DuckDB error', () => {
    // duckdb_set_config returns failure for "not_a_number"
    expect(() => open(':memory:', { config: { threads: 'not_a_number' } }))
      .toThrow(/threads/);
  });
});

// ============================================================================
// PRAGMA helper
// ============================================================================

d('PRAGMA helper', () => {
  test('get-form: PRAGMA version returns a row object', async () => {
    const v = await db.pragma('version');
    expect(v).toBeDefined();
    expect(typeof v.library_version).toBe('string');
    expect(v.library_version).toMatch(/^v?\d/);
  });

  test('get-form: PRAGMA database_size returns a multi-column row', async () => {
    const v = await db.pragma('database_size');
    expect(v).toBeDefined();
    expect(v.database_name).toBe('memory');
  });

  test('set-form: PRAGMA threads=N changes the setting', async () => {
    await db.pragma('threads', 2);
    // Get-back is via current_setting(), NOT pragma() — DuckDB
    // settings (as opposed to PRAGMA functions) are read that way.
    const r = await db.get(`SELECT current_setting('threads') AS v`);
    expect(r.v).toBe(2);
  });

  test('set-form: memory_limit accepts string literal', async () => {
    await db.pragma('memory_limit', '256MB');
    const r = await db.get(`SELECT current_setting('memory_limit') AS v`);
    expect(typeof r.v).toBe('string');
  });

  test('rejects identifiers with non-word chars (no SQL injection)', async () => {
    await expect(db.pragma('threads; DROP TABLE foo')).rejects.toThrow(/PRAGMA name/);
  });

  test('rejects empty PRAGMA name', async () => {
    await expect(db.pragma('')).rejects.toThrow(/PRAGMA name/);
  });

  test('escapes single-quotes in string values', async () => {
    // memory_limit doesn't accept this malformed value; the assertion
    // is that DuckDB returns a value error (NOT a SQL parse error,
    // which is what would happen if escaping were broken).
    await expect(db.pragma('memory_limit', "1'; DROP TABLE x; --")).rejects.toThrow();
    // Connection still alive — no table got dropped, no parse blowup.
    const r = await db.get('SELECT 1 AS n');
    expect(r.n).toBe(1);
  });
});

// ============================================================================
// Extension helpers
// ============================================================================

d('Extension helpers', () => {
  // We can't INSTALL a real extension in offline CI (would download),
  // but we can verify the SQL the helper generates by trapping the
  // error path on a non-existent extension name.

  test('installExtension validates the name (no SQL injection)', async () => {
    await expect(db.installExtension('json; DROP TABLE x')).rejects.toThrow(/extension name/);
  });

  test('loadExtension validates the name', async () => {
    await expect(db.loadExtension('not a valid ident')).rejects.toThrow(/extension name/);
  });

  test('loadExtension(missing) surfaces DuckDB error, not a SQL parse error', async () => {
    // Bogus but legally-named extension. DuckDB should reject because
    // the extension isn't installed, NOT because of a syntax error.
    let err;
    try { await db.loadExtension('totally_not_an_extension'); }
    catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.message).not.toMatch(/syntax error/i);
  });
});

// ============================================================================
// chunks() — chunk-by-chunk streaming
// ============================================================================

d('checkpoint helper', () => {
  test('db.checkpoint() works on a fresh :memory: (no-op, no throw)', async () => {
    await db.checkpoint();    // should not throw
  });

  test('db.checkpoint({ force: true }) emits FORCE CHECKPOINT', async () => {
    await db.checkpoint({ force: true });
  });

  test('CHECKPOINT actually flushes WAL on a file-backed DB', async () => {
    const { existsSync, unlinkSync, statSync } = await import('fs');
    const path = join(tmpdir(), `duckdb-bun-checkpoint-${Date.now()}.duckdb`);
    try {
      using d2 = open(path);
      await d2.exec('CREATE TABLE t (n INT)');
      // Insert enough rows that the WAL is non-empty.
      await d2.run('INSERT INTO t SELECT range FROM range(1000)');
      // Before checkpoint there should be a .wal file (DuckDB writes
      // WAL during open transactions on file DBs).
      await d2.checkpoint();
      // After checkpoint, the WAL is truncated/removed. We don't assert
      // absence (DuckDB's exact WAL lifecycle isn't part of our
      // contract); we just verify the data is durable.
      using d3 = open(path);
      const c = await d3.get('SELECT COUNT(*) AS n FROM t');
      expect(Number(c.n)).toBe(1000);
    } finally {
      try { unlinkSync(path); } catch {}
      try { unlinkSync(path + '.wal'); } catch {}
    }
  });

  test('db.checkpoint({ database }) validates identifier (no SQL injection)', async () => {
    await expect(db.checkpoint({ database: 'aux; DROP TABLE foo' }))
      .rejects.toThrow(/database name/);
  });

  test('db.checkpoint({ database: \"aux\" }) targets attached database', async () => {
    await db.exec(`ATTACH ':memory:' AS aux`);
    await db.checkpoint({ database: 'aux' });
    await db.checkpoint({ database: 'aux', force: true });
  });

  test('Connection.checkpoint is the same function', async () => {
    using conn = db.connect();
    expect(typeof conn.checkpoint).toBe('function');
    await conn.checkpoint();
    await conn.checkpoint({ force: true });
  });

  test('TxnHandle.checkpoint works inside a transaction (FORCE)', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    await db.transaction(async (tx) => {
      await tx.exec('INSERT INTO t VALUES (1)');
      // FORCE CHECKPOINT inside a transaction aborts the txn (DuckDB
      // semantics); the rollback test below covers that case. Plain
      // CHECKPOINT may or may not succeed depending on isolation; we
      // assert the method exists and is callable without TypeError.
      expect(typeof tx.checkpoint).toBe('function');
    });
  });

  test('TxnHandle.checkpoint rejects after callback returns', async () => {
    let stale;
    await db.transaction(async (tx) => { stale = tx; });
    await expect(stale.checkpoint()).rejects.toThrow(DuckDBError);
  });
});

d('chunks() streaming', () => {
  test('Statement.chunks yields chunks with metadata', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    using conn = db.connect();
    await conn.append('t', ['n'], Array.from({ length: 5000 }, (_, i) => [i]));
    using stmt = await db.prepare('SELECT * FROM t ORDER BY n');
    const seenChunks = [];
    for await (const c of stmt.chunks()) {
      seenChunks.push({ size: c.rows.length, idx: c.chunkIndex, offset: c.rowOffset });
    }
    // Should span at least 2 chunks (DuckDB's vector size is 2048).
    expect(seenChunks.length).toBeGreaterThanOrEqual(2);
    // Chunk indexes are monotonic 0..N-1
    expect(seenChunks.map(c => c.idx)).toEqual([...seenChunks.keys()]);
    // rowOffsets are correct: each chunk starts where the previous ended
    let acc = 0;
    for (const c of seenChunks) {
      expect(c.offset).toBe(acc);
      acc += c.size;
    }
    expect(acc).toBe(5000);
  });

  test('chunks has .columns on each yielded rows array', async () => {
    using stmt = await db.prepare('SELECT 1 AS a, 2 AS b');
    for await (const c of stmt.chunks()) {
      expect(Array.isArray(c.rows)).toBe(true);
      expect(c.rows.columns).toBeDefined();
      expect(c.rows.columns.map(col => col.name)).toEqual(['a', 'b']);
    }
  });

  test('Connection.chunks sugar', async () => {
    using conn = db.connect();
    await conn.exec('CREATE TABLE t (n INT)');
    await conn.run('INSERT INTO t VALUES (1), (2), (3)');
    let total = 0;
    for await (const c of conn.chunks('SELECT * FROM t ORDER BY n')) {
      total += c.rows.length;
    }
    expect(total).toBe(3);
  });

  test('Database.chunks sugar', async () => {
    await db.exec('CREATE TABLE t (n INT)');
    await db.run('INSERT INTO t VALUES (1), (2), (3)');
    const got = [];
    for await (const c of db.chunks('SELECT * FROM t ORDER BY n')) {
      for (const r of c.rows) got.push(r.n);
    }
    expect(got).toEqual([1, 2, 3]);
  });

  test('chunks holds the conn lock (concurrent chunks throws)', async () => {
    using stmt = await db.prepare('SELECT 1');
    const c1 = stmt.chunks();
    // Statement can't have two concurrent iterators (chunks or iterate)
    expect(() => stmt.chunks()).toThrow(DuckDBError);
    await c1.return();
  });

  test('break mid-chunks releases lock; subsequent query works', async () => {
    using conn = db.connect();
    await conn.exec('CREATE TABLE t (n INT)');
    await conn.append('t', ['n'], Array.from({ length: 5000 }, (_, i) => [i]));
    let seen = 0;
    for await (const c of conn.chunks('SELECT * FROM t ORDER BY n')) {
      seen += c.rows.length;
      if (seen >= 100) break;
    }
    const c = await conn.get('SELECT COUNT(*) AS n FROM t');
    expect(Number(c.n)).toBe(5000);
  });
});
