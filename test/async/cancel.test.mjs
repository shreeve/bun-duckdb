// AbortSignal cancellation on the async subpath (v0.7+).
//
// Covers the 10 invariants enumerated in the v0.7 cancellation spec:
//
//  1. Active long async query aborts quickly
//  2. Abort error maps to DuckDBAbortError (with name 'AbortError')
//  3. Already-aborted signal rejects BEFORE sending work to the worker
//  4. Aborting a queued request does NOT interrupt the active request
//  5. Abort during an active iterator's iterNext cleans up
//  6. Abort while iterator has buffered rows cleans up on next turn / return
//  7. Transaction sub-op abort rolls back
//  8. Late abort (signal fires AFTER successful query) does nothing
//  9. close() removes interrupt handle; late abort does not call stale ptr
// 10. Worker crash + aborted request does not hang
//
// These tests run against the async subpath only — sync FFI blocks the
// JS event loop and can't deliver AbortSignal, by design.

import { test, expect, describe } from 'bun:test';

let mod;
let available = false;
try {
  mod = await import('../../lib/async/index.mjs');
  available = true;
} catch {
  // libduckdb not present — tests skip.
}

const d = available ? describe : describe.skip;
const {
  open,
  DuckDBError,
  DuckDBClosedError,
  DuckDBAbortError,
} = mod || {};

// A "hot loop" SQL that takes long enough for an AbortSignal listener
// to fire mid-query. range(N) is the cheapest way DuckDB scales work;
// we cross-join two ranges to make it CPU-bound for ~hundreds of ms.
// If hardware is much faster than expected, the test would be racy —
// we don't assert on minimum duration, only that abort terminates the
// query quickly relative to its un-aborted runtime.
const SLOW_SQL = `
  SELECT COUNT(*) AS n
  FROM range(0, 5_000_000) AS a
  CROSS JOIN range(0, 200) AS b
  WHERE a.range % 7 = 0
`;

// ============================================================================
// 1. Active long query aborts quickly
// ============================================================================

d('Cancellation — active query', () => {
  test('AbortController.abort() during a long query rejects quickly with DuckDBAbortError', async () => {
    await using db = open(':memory:');
    const ctl = new AbortController();
    const t0 = Date.now();
    const p = db.get(SLOW_SQL, undefined, { signal: ctl.signal });
    // Fire the abort a beat after the query starts.
    setTimeout(() => ctl.abort(), 50);
    let caught;
    try { await p; }
    catch (e) { caught = e; }
    const elapsed = Date.now() - t0;
    expect(caught).toBeInstanceOf(DuckDBAbortError);
    expect(caught).toBeInstanceOf(DuckDBError);
    expect(caught.name).toBe('AbortError');
    // Aborted query should return in O(100ms), not the multi-second
    // natural runtime. 2 seconds is a very loose bound that still
    // catches "interrupt didn't work."
    expect(elapsed).toBeLessThan(2000);
  });
});

// ============================================================================
// 2. Error class identity
// ============================================================================

d('Cancellation — error class', () => {
  test('abort error has name=AbortError and code=ERR_DUCKDB_ABORTED', async () => {
    await using db = open(':memory:');
    const ctl = new AbortController();
    ctl.abort();    // pre-aborted; rejects before sending work
    let caught;
    try { await db.get('SELECT 1', undefined, { signal: ctl.signal }); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DuckDBAbortError);
    expect(caught.name).toBe('AbortError');
    expect(caught.code).toBe('ERR_DUCKDB_ABORTED');
    // Common abort-aware code paths key on err.name
    // (fetch / ReadableStream convention).
    expect(caught.name).toBe('AbortError');
  });
});

// ============================================================================
// 3. Already-aborted signal rejects WITHOUT touching the worker
// ============================================================================

d('Cancellation — pre-aborted signal', () => {
  test('pre-aborted signal rejects before round-trip; conn still usable after', async () => {
    await using db = open(':memory:');
    const ctl = new AbortController();
    ctl.abort();
    const t0 = Date.now();
    let caught;
    try { await db.exec('CREATE TABLE t (n INT)', { signal: ctl.signal }); }
    catch (e) { caught = e; }
    const elapsed = Date.now() - t0;
    expect(caught).toBeInstanceOf(DuckDBAbortError);
    // Should be near-instant (well under one tick). We give 100ms
    // grace for very slow CI machines.
    expect(elapsed).toBeLessThan(100);

    // Conn is still healthy — the aborted op never touched the worker,
    // so a fresh op (no signal) succeeds.
    await db.exec('CREATE TABLE t (n INT)');
    await db.run('INSERT INTO t VALUES (42)');
    const r = await db.get('SELECT n FROM t');
    expect(r.n).toBe(42);
  });
});

// ============================================================================
// 4. Aborting a queued request must NOT interrupt the active request
// ============================================================================

d('Cancellation — queued vs active', () => {
  test('aborting a queued op does not interrupt the currently running op', async () => {
    await using db = open(':memory:');
    // Single connection → both ops queue on the same serialization chain.
    const conn = db.connect();
    try {
      const ctl = new AbortController();
      // Op A: a long-ish but bounded query, NO signal. Will complete.
      const pA = conn.get(SLOW_SQL);
      // Op B: queued behind A, with abort signal.
      const pB = conn.get('SELECT 1', undefined, { signal: ctl.signal });
      // Abort B while A is still running.
      setTimeout(() => ctl.abort(), 30);
      // A should complete successfully (not be interrupted by B's abort).
      const a = await pA;
      expect(typeof a.n).toBe('number');
      expect(a.n).toBeGreaterThan(0);
      // B should reject with AbortError without ever hitting the worker
      // (the chain entry-point catches it once it dequeues).
      let bErr;
      try { await pB; }
      catch (e) { bErr = e; }
      expect(bErr).toBeInstanceOf(DuckDBAbortError);
    } finally {
      await conn.close();
    }
  });
});

// ============================================================================
// 5. Abort during active iterator's iterNext
// ============================================================================

d('Cancellation — iterator iterNext', () => {
  test('abort during iteration: rejects, cleans up, conn still usable', async () => {
    await using db = open(':memory:');
    const ctl = new AbortController();
    let count = 0;
    let caught;
    try {
      for await (const row of db.iterate(SLOW_SQL.replace('COUNT(*) AS n', 'a.range, b.range AS b'), undefined, { signal: ctl.signal })) {
        count++;
        if (count === 1) {
          // Abort once we've seen at least one row arrive from the worker.
          // The next iterNext will be interrupted.
          setTimeout(() => ctl.abort(), 10);
        }
        // safety: bound the loop in case the abort doesn't fire
        if (count > 1_000_000) break;
      }
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DuckDBAbortError);
    // Conn must still be usable after the abort.
    const r = await db.get('SELECT 42 AS x');
    expect(r.x).toBe(42);
  });
});

// ============================================================================
// 6. Abort while iterator has buffered rows (no worker call in flight)
// ============================================================================

d('Cancellation — iterator buffered rows', () => {
  test('abort while buffered rows are draining rejects on next .next()', async () => {
    await using db = open(':memory:');
    // Small dataset that fits in one prefetched chunk.
    await db.exec('CREATE TABLE t (n INT)');
    for (let i = 0; i < 50; i++) await db.run('INSERT INTO t VALUES (?)', [i]);
    const ctl = new AbortController();
    const iter = db.iterate('SELECT n FROM t ORDER BY n', undefined, {
      signal: ctl.signal,
      prefetch: 1,
    });
    // Consume one row to ensure the iterator started and pre-fetched.
    const first = await iter.next();
    expect(first.value.n).toBe(0);
    // Now abort. No worker call is currently in flight — the rows are
    // already buffered. The iterator's abort flag fires; next .next()
    // should reject.
    ctl.abort();
    let caught;
    try { await iter.next(); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DuckDBAbortError);
    // Conn still usable.
    const r = await db.get('SELECT COUNT(*) AS c FROM t');
    expect(Number(r.c)).toBe(50);
  });
});

// ============================================================================
// 7. Transaction sub-op abort rolls back
// ============================================================================

d('Cancellation — transaction', () => {
  test('aborting a sub-op inside a transaction rolls back', async () => {
    await using db = open(':memory:');
    await db.exec('CREATE TABLE t (n INT)');
    const ctl = new AbortController();
    let caught;
    try {
      await db.transaction(async (tx) => {
        await tx.run('INSERT INTO t VALUES (1)');
        // Schedule an abort and run a slow op that will be interrupted.
        setTimeout(() => ctl.abort(), 30);
        await tx.get(SLOW_SQL, undefined, { signal: ctl.signal });
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DuckDBAbortError);
    // Rollback must have happened — the INSERT before the slow query
    // should have been undone.
    const r = await db.get('SELECT COUNT(*) AS c FROM t');
    expect(Number(r.c)).toBe(0);
  });
});

// ============================================================================
// 8. Late abort after successful query is a no-op
// ============================================================================

d('Cancellation — late abort', () => {
  test('abort fired AFTER a query already resolved does nothing', async () => {
    await using db = open(':memory:');
    const ctl = new AbortController();
    const r = await db.get('SELECT 7 AS x', undefined, { signal: ctl.signal });
    expect(r.x).toBe(7);
    // Result is already in hand. Aborting now should be silent.
    ctl.abort();
    // Subsequent ops with a fresh signal should work normally.
    const r2 = await db.get('SELECT 8 AS x');
    expect(r2.x).toBe(8);
  });
});

// ============================================================================
// 9. Close removes interrupt handle; late abort does not segfault
// ============================================================================

d('Cancellation — close + late abort', () => {
  test('abort firing AFTER conn close does not call duckdb_interrupt on a stale ptr', async () => {
    const db = open(':memory:');
    const conn = db.connect();
    const ctl = new AbortController();
    // Attach handlers immediately; we don't care whether the query
    // completed or rejected. Both are safe; we're testing for
    // process safety, not user-visible outcome.
    const p = conn.get(SLOW_SQL, undefined, { signal: ctl.signal })
      .then(() => {}, () => {});
    await new Promise(r => setTimeout(r, 10));
    // Close drains the chain — slow query either completes or, on
    // fast hardware, is still running. Either way, after close
    // returns the interrupt-capability entry has been removed.
    await conn.close();
    // Now fire abort AFTER close. The abort handler will look up
    // the interrupt handle by connId and find nothing (close removed
    // it). If we incorrectly called duckdb_interrupt on a freed
    // connection pointer, the process would crash. Reaching the
    // assertion below proves we didn't.
    ctl.abort();
    await p;
    // db is still usable: this conn is gone, but the default conn
    // is alive.
    const r = await db.get('SELECT 1 AS x');
    expect(r.x).toBe(1);
    await db.close();
  });
});

// ============================================================================
// 10. Worker crash + aborted request must not hang
// ============================================================================

d('Cancellation — worker crash + abort', () => {
  test('an in-flight aborted request does not hang if the worker dies', async () => {
    const db = open(':memory:');
    await db.exec('SELECT 1'); // force open
    const ctl = new AbortController();
    // Attach a "settled" capture handler to p BEFORE firing the abort
    // or the close — otherwise the rejection races the user code
    // attaching its own handler, which Bun's test runner treats as
    // an unhandled rejection (failing the test even though semantically
    // we'd catch it later). The user-facing API is unchanged; this
    // is just a test-harness ergonomic.
    let settled = false;
    let capturedError;
    const p = db.get(SLOW_SQL, undefined, { signal: ctl.signal })
      .then(() => { settled = true; },
            (e) => { settled = true; capturedError = e; });
    // Race: simulate a crash by force-closing with no timeout. This
    // terminates the worker; the in-flight query must settle (either
    // with AbortError or ClosedError or WorkerCrashedError). The
    // CONTRACT IS "NO HANG."
    const t0 = Date.now();
    await Promise.all([
      (async () => { ctl.abort(); })(),
      db.close({ timeout: 0 }),
    ]);
    await Promise.race([
      p,
      new Promise(r => setTimeout(r, 2000)),
    ]);
    expect(settled).toBe(true);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2500);
    // capturedError can be any of AbortError / ClosedError /
    // WorkerCrashedError depending on the race; all that matters is
    // that it's a DuckDBError and the op didn't hang.
    expect(capturedError).toBeInstanceOf(DuckDBError);
  });
});

// ============================================================================
// Bonus: AbortSignal is honored on AsyncStatement.{all,get,run}
// ============================================================================

d('Cancellation — prepared statement', () => {
  test('AsyncStatement.get honors signal', async () => {
    await using db = open(':memory:');
    await using stmt = await db.prepare(SLOW_SQL);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    let caught;
    try { await stmt.get([], { signal: ctl.signal }); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DuckDBAbortError);
  });
});
