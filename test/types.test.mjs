// Type-aware decoding: every DUCKDB_TYPE that produces a JS value
// that's worth verifying. Plus the DUCKDB_TYPE constant table itself.

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { d, open, available, DUCKDB_TYPE } from './helpers.mjs';

let db, conn;
beforeAll(() => {
  if (!available) return;
  db = open(':memory:');
  conn = db.connect();
});
afterAll(() => {
  if (!available) return;
  conn.close();
  db.close();
});

// =============================================================================
// Integers
// =============================================================================

d('integers', () => {
  test('BOOLEAN', async () => {
    const rows = await conn.query('SELECT true AS t, false AS f');
    expect(rows[0].t).toBe(true);
    expect(rows[0].f).toBe(false);
  });

  test('TINYINT', async () => {
    const rows = await conn.query('SELECT 127::TINYINT AS val');
    expect(rows[0].val).toBe(127);
  });

  test('SMALLINT', async () => {
    const rows = await conn.query('SELECT 32000::SMALLINT AS val');
    expect(rows[0].val).toBe(32000);
  });

  test('INTEGER', async () => {
    const rows = await conn.query('SELECT 2147483647::INTEGER AS val');
    expect(rows[0].val).toBe(2147483647);
  });

  test('BIGINT', async () => {
    const rows = await conn.query('SELECT 9007199254740992::BIGINT AS val');
    expect(rows[0].val).toBe(9007199254740992);
  });

  test('UTINYINT', async () => {
    const rows = await conn.query('SELECT 255::UTINYINT AS val');
    expect(rows[0].val).toBe(255);
  });

  test('USMALLINT', async () => {
    const rows = await conn.query('SELECT 65535::USMALLINT AS val');
    expect(rows[0].val).toBe(65535);
  });

  test('UINTEGER', async () => {
    const rows = await conn.query('SELECT 4294967295::UINTEGER AS val');
    expect(rows[0].val).toBe(4294967295);
  });

  test('UBIGINT', async () => {
    const rows = await conn.query('SELECT 9007199254740992::UBIGINT AS val');
    expect(rows[0].val).toBe(9007199254740992);
  });
});

// =============================================================================
// Floats
// =============================================================================

d('floats', () => {
  test('FLOAT', async () => {
    const rows = await conn.query('SELECT 3.14::FLOAT AS val');
    expect(rows[0].val).toBeCloseTo(3.14, 2);
  });

  test('DOUBLE', async () => {
    const rows = await conn.query('SELECT 3.141592653589793::DOUBLE AS val');
    expect(rows[0].val).toBeCloseTo(3.141592653589793);
  });
});

// =============================================================================
// Large integers (returned as strings to preserve full precision)
// =============================================================================

d('large integers', () => {
  test('HUGEINT', async () => {
    const rows = await conn.query('SELECT 170141183460469231731687303715884105727::HUGEINT AS val');
    expect(rows[0].val).toBe('170141183460469231731687303715884105727');
  });

  test('UHUGEINT', async () => {
    const rows = await conn.query('SELECT 340282366920938463463374607431768211455::UHUGEINT AS val');
    expect(rows[0].val).toBe('340282366920938463463374607431768211455');
  });
});

// =============================================================================
// Strings
// =============================================================================

d('strings', () => {
  test('VARCHAR', async () => {
    const rows = await conn.query("SELECT 'hello world'::VARCHAR AS val");
    expect(rows[0].val).toBe('hello world');
  });

  test('VARCHAR empty string', async () => {
    const rows = await conn.query("SELECT ''::VARCHAR AS val");
    expect(rows[0].val).toBe('');
  });

  test('BLOB', async () => {
    const rows = await conn.query("SELECT '\\x48454C4C4F'::BLOB AS val");
    expect(rows[0].val).toBeTruthy();
  });
});

// =============================================================================
// Temporal
// =============================================================================

d('temporal', () => {
  test('DATE', async () => {
    const rows = await conn.query("SELECT '2024-03-15'::DATE AS val");
    expect(rows[0].val).toBe('2024-03-15');
  });

  test('TIME', async () => {
    const rows = await conn.query("SELECT '14:30:00'::TIME AS val");
    expect(rows[0].val).toBe('14:30:00');
  });

  test('TIME with microseconds', async () => {
    const rows = await conn.query("SELECT '14:30:00.123456'::TIME AS val");
    expect(rows[0].val).toBe('14:30:00.123456');
  });

  test('TIMESTAMP', async () => {
    const rows = await conn.query("SELECT '2024-03-15 14:30:00'::TIMESTAMP AS val");
    expect(rows[0].val).toBeInstanceOf(Date);
  });

  test('TIMESTAMP_S', async () => {
    const rows = await conn.query("SELECT '2024-03-15 14:30:00'::TIMESTAMP_S AS val");
    expect(rows[0].val).toBeInstanceOf(Date);
  });

  test('TIMESTAMP_MS', async () => {
    const rows = await conn.query("SELECT '2024-03-15 14:30:00'::TIMESTAMP_MS AS val");
    expect(rows[0].val).toBeInstanceOf(Date);
  });

  test('TIMESTAMP_NS', async () => {
    const rows = await conn.query("SELECT '2024-03-15 14:30:00'::TIMESTAMP_NS AS val");
    expect(rows[0].val).toBeInstanceOf(Date);
  });

  test('TIMESTAMP WITH TIME ZONE', async () => {
    const rows = await conn.query("SELECT '2024-03-15 14:30:00+00'::TIMESTAMPTZ AS val");
    expect(rows[0].val).toBeInstanceOf(Date);
  });

  test('TIME WITH TIME ZONE', async () => {
    const rows = await conn.query("SELECT '14:30:00+05:30'::TIMETZ AS val");
    expect(rows[0].val).toMatch(/14:30:00/);
    expect(rows[0].val).toMatch(/[+-]\d{2}:\d{2}/);
  });

  test('INTERVAL', async () => {
    const rows = await conn.query("SELECT INTERVAL '3 months 2 days 1.5 seconds' AS val");
    expect(rows[0].val).toContain('3 months');
    expect(rows[0].val).toContain('2 days');
    expect(rows[0].val).toContain('second');
  });
});

// =============================================================================
// Special types
// =============================================================================

d('special', () => {
  test('UUID', async () => {
    const rows = await conn.query("SELECT 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::UUID AS val");
    expect(rows[0].val).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
  });

  test('DECIMAL', async () => {
    const rows = await conn.query('SELECT 123.456::DECIMAL(10,3) AS val');
    expect(rows[0].val).toBe('123.456');
  });

  test('ENUM', async () => {
    await conn.query("CREATE TYPE mood AS ENUM ('happy', 'sad', 'neutral')");
    await conn.query('CREATE TABLE test_enum (m mood)');
    await conn.query("INSERT INTO test_enum VALUES ('happy'), ('sad')");
    const rows = await conn.query('SELECT m FROM test_enum ORDER BY m');
    expect(rows[0].m).toBe('happy');
    expect(rows[1].m).toBe('sad');
    await conn.query('DROP TABLE test_enum');
    await conn.query('DROP TYPE mood');
  });
});

// =============================================================================
// Nested types
// =============================================================================

d('nested', () => {
  test('LIST of integers', async () => {
    const rows = await conn.query('SELECT [1, 2, 3] AS val');
    expect(rows[0].val).toEqual([1, 2, 3]);
  });

  test('LIST with NULL', async () => {
    const rows = await conn.query('SELECT [1, NULL, 3] AS val');
    expect(rows[0].val).toEqual([1, null, 3]);
  });

  test('STRUCT', async () => {
    const rows = await conn.query("SELECT {'name': 'Alice', 'age': 30} AS val");
    expect(rows[0].val).toEqual({ name: 'Alice', age: 30 });
  });

  test('MAP', async () => {
    const rows = await conn.query("SELECT MAP {'a': 1, 'b': 2} AS val");
    expect(rows[0].val).toEqual({ a: 1, b: 2 });
  });

  test('ARRAY (fixed-size)', async () => {
    const rows = await conn.query('SELECT [1, 2, 3]::INT[3] AS val');
    expect(rows[0].val).toEqual([1, 2, 3]);
  });
});

// =============================================================================
// NULL handling
// =============================================================================

d('NULL handling', () => {
  test('NULL integer', async () => {
    const rows = await conn.query('SELECT NULL::INTEGER AS val');
    expect(rows[0].val).toBe(null);
  });

  test('NULL varchar', async () => {
    const rows = await conn.query('SELECT NULL::VARCHAR AS val');
    expect(rows[0].val).toBe(null);
  });

  test('mixed NULL and non-NULL', async () => {
    const rows = await conn.query("SELECT * FROM (VALUES (1, 'a'), (NULL, 'b'), (3, NULL)) AS v(n, s) ORDER BY s");
    expect(rows.length).toBe(3);
    expect(rows[0].n).toBe(1);
    expect(rows[1].n).toBeNull();
    expect(rows[2].s).toBeNull();
  });
});

// =============================================================================
// DUCKDB_TYPE constant table — sanity check that it's frozen and stable
// =============================================================================

d('DUCKDB_TYPE constant', () => {
  test('is exported and is an object', () => {
    expect(typeof DUCKDB_TYPE).toBe('object');
    expect(DUCKDB_TYPE).toBeTruthy();
  });

  test('TIMESTAMP_TZ is 31 (not 32, easy off-by-one)', () => {
    expect(DUCKDB_TYPE.TIMESTAMP_TZ).toBe(31);
  });

  test('UHUGEINT is 32', () => {
    expect(DUCKDB_TYPE.UHUGEINT).toBe(32);
  });

  test('TIME_TZ is 30', () => {
    expect(DUCKDB_TYPE.TIME_TZ).toBe(30);
  });

  test('ARRAY is 33', () => {
    expect(DUCKDB_TYPE.ARRAY).toBe(33);
  });

  test('TIME_NS is 39', () => {
    expect(DUCKDB_TYPE.TIME_NS).toBe(39);
  });

  test('INVALID is 0', () => {
    expect(DUCKDB_TYPE.INVALID).toBe(0);
  });
});
