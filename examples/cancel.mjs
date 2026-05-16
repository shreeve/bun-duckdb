// AbortSignal cancellation example for duckdb-bun/async (v0.7+).
//
// Demonstrates the patterns most users want:
//   1. Cancel a long-running query when an external signal fires
//   2. Detect cancellation vs other errors via DuckDBAbortError
//   3. Pre-aborted signals reject without touching the worker
//   4. AbortSignal.timeout() for a fire-and-forget timeout
//
// Run:  bun examples/cancel.mjs

import { open, DuckDBAbortError, DuckDBError } from '../lib/async/index.mjs';

// A query heavy enough to be reliably cancellable on any hardware.
// CRC32 hashing on a 1B-row cartesian product is genuinely CPU-bound.
const SLOW = `
  SELECT MAX(hash(a.range * 31 + b.range)) AS h
  FROM range(0, 5_000_000) AS a
  CROSS JOIN range(0, 200) AS b
`;

await using db = open(':memory:');

// ----------------------------------------------------------------------
// 1. Cancel mid-query with an AbortController
// ----------------------------------------------------------------------
{
  console.log('— example 1: cancel mid-query');
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 100);   // cancel 100ms in

  const t0 = Date.now();
  try {
    await db.get(SLOW, undefined, { signal: ctl.signal });
    console.log('  unexpected: query completed');
  } catch (err) {
    const elapsed = Date.now() - t0;
    if (err instanceof DuckDBAbortError) {
      console.log(`  ✓ canceled in ${elapsed}ms (${err.name}, ${err.code})`);
    } else {
      throw err;
    }
  }
}

// ----------------------------------------------------------------------
// 2. AbortSignal.timeout() — fire-and-forget timeout
// ----------------------------------------------------------------------
{
  console.log('— example 2: AbortSignal.timeout()');
  const t0 = Date.now();
  try {
    await db.get(SLOW, undefined, { signal: AbortSignal.timeout(50) });
    console.log('  unexpected: query completed');
  } catch (err) {
    const elapsed = Date.now() - t0;
    if (err instanceof DuckDBAbortError) {
      console.log(`  ✓ timed out after ${elapsed}ms`);
    } else {
      throw err;
    }
  }
}

// ----------------------------------------------------------------------
// 3. Pre-aborted signal — never touches the worker
// ----------------------------------------------------------------------
{
  console.log('— example 3: pre-aborted signal rejects synchronously');
  const ctl = new AbortController();
  ctl.abort('user canceled');
  const t0 = Date.now();
  try {
    await db.get('SELECT 1', undefined, { signal: ctl.signal });
  } catch (err) {
    const elapsed = Date.now() - t0;
    console.log(`  ✓ rejected in ${elapsed}ms with ${err.name}`);
    console.log(`    (note: no worker round-trip needed)`);
  }
}

// ----------------------------------------------------------------------
// 4. Cancellation in an iterator
// ----------------------------------------------------------------------
{
  console.log('— example 4: cancel a streaming iterator');
  // Use a real table so we can iterate.
  await db.exec('CREATE TABLE t (n INT)');
  for (let i = 0; i < 1000; i++) await db.run('INSERT INTO t VALUES (?)', [i]);

  const ctl = new AbortController();
  let count = 0;
  try {
    for await (const row of db.iterate('SELECT n FROM t ORDER BY n', undefined, { signal: ctl.signal })) {
      count++;
      if (count === 10) ctl.abort();
    }
  } catch (err) {
    if (err instanceof DuckDBAbortError) {
      console.log(`  ✓ iterator aborted after ${count} rows`);
    } else {
      throw err;
    }
  }
}

// ----------------------------------------------------------------------
// 5. HTTP request signal pattern (illustrative)
// ----------------------------------------------------------------------
console.log('— example 5: typical HTTP handler pattern');
console.log(`
  // Bun.serve({ async fetch(request) {
  //   const rows = await db.all('SELECT ...', params, {
  //     signal: request.signal,           // ← bail when client disconnects
  //   });
  //   return Response.json(rows);
  // } });
`);

console.log('done.');
