// async-vs-sync — four benchmarks comparing duckdb-bun (main thread)
// to duckdb-bun/async (Worker thread).
//
// Per RFC docs/rfcs/0001-worker-async-api.md §12. The acceptance
// criterion for v0.4 is:
//   - #1 (event-loop responsiveness): ≥95% of expected ticks landed
//     during the long async query
//   - #2 (small-query latency): may regress; document loudly
//   - #3 (large result transport): within 30% of sync for non-trivial
//     workloads
//   - #4 (appender throughput): within 20% of sync
//
// Run:
//   bun bench/async-vs-sync.mjs

import { open as openSync } from '../lib/duckdb.ts';
import { open as openAsync } from '../lib/async/index.ts';

function fmt(ms) { return `${ms.toFixed(1)}ms`; }
function pct(n) { return `${(n * 100).toFixed(1)}%`; }
function bar() { console.log('-'.repeat(72)); }

// ============================================================================
// #1 — Event-loop responsiveness
// ============================================================================
//
// Run a heavy query in each mode for ~3 seconds; count timer ticks.
// The sync mode should miss most ticks (loop blocked); the async mode
// should hit nearly all of them.

async function bench1_responsiveness() {
  bar();
  console.log('Bench #1 — event-loop responsiveness (5ms ticks during ~2s query)');
  bar();
  const SQL = `
    SELECT count(*) AS n
    FROM range(1500000) a, range(80) b
    WHERE (a.range + b.range) % 7 = 0
  `;
  const TICK_MS = 5;

  for (const mode of ['sync', 'async']) {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, TICK_MS);
    const t0 = Date.now();
    if (mode === 'sync') {
      using db = openSync(':memory:');
      const r = await db.get(SQL);
      void r;
    } else {
      await using db = openAsync(':memory:');
      const r = await db.get(SQL);
      void r;
    }
    const elapsed = Date.now() - t0;
    clearInterval(timer);
    const expectedTicks = Math.floor(elapsed / TICK_MS);
    const hitRate = expectedTicks > 0 ? ticks / expectedTicks : 1;
    console.log(`  ${mode.padEnd(5)} — query ${fmt(elapsed)}, ` +
                `ticks fired: ${ticks}/${expectedTicks} (${pct(hitRate)})`);
  }
}

// ============================================================================
// #2 — Small-query latency
// ============================================================================
//
// 10K trivial `SELECT 1` queries. Sync should win (no postMessage
// overhead); document the async cost.

async function bench2_small_query() {
  bar();
  console.log('Bench #2 — small-query latency (10,000 × SELECT 1)');
  bar();
  const N = 10_000;

  {
    using db = openSync(':memory:');
    await db.get('SELECT 1');   // warmup
    const t0 = Date.now();
    for (let i = 0; i < N; i++) await db.get('SELECT 1');
    const elapsed = Date.now() - t0;
    console.log(`  sync  — total ${fmt(elapsed)}, ${fmt(elapsed / N)}/op, ${Math.round(N / (elapsed / 1000))} ops/s`);
  }
  {
    await using db = openAsync(':memory:');
    await db.get('SELECT 1');
    const t0 = Date.now();
    for (let i = 0; i < N; i++) await db.get('SELECT 1');
    const elapsed = Date.now() - t0;
    console.log(`  async — total ${fmt(elapsed)}, ${fmt(elapsed / N)}/op, ${Math.round(N / (elapsed / 1000))} ops/s`);
  }
}

// ============================================================================
// #3 — Large result transport
// ============================================================================
//
// SELECT * FROM range(1e6). Measure time-to-last-row, peak heap.
// Tests the postMessage / structuredClone overhead per chunk.

async function bench3_large_result() {
  bar();
  console.log('Bench #3 — large result transport (1M rows, one int column)');
  bar();
  const SQL = 'SELECT range AS n FROM range(1000000)';

  {
    using db = openSync(':memory:');
    const t0 = Date.now();
    const rows = await db.all(SQL);
    const elapsed = Date.now() - t0;
    console.log(`  sync materialize     — ${fmt(elapsed)}, ${rows.length} rows`);
  }
  {
    using db = openSync(':memory:');
    const t0 = Date.now();
    let count = 0;
    for await (const _row of db.iterate(SQL)) count++;
    const elapsed = Date.now() - t0;
    console.log(`  sync iterate         — ${fmt(elapsed)}, ${count} rows`);
  }
  {
    await using db = openAsync(':memory:');
    const t0 = Date.now();
    const rows = await db.all(SQL);
    const elapsed = Date.now() - t0;
    console.log(`  async materialize    — ${fmt(elapsed)}, ${rows.length} rows`);
  }
  {
    await using db = openAsync(':memory:');
    const t0 = Date.now();
    let count = 0;
    for await (const _row of db.iterate(SQL, [], { prefetch: 1 })) count++;
    const elapsed = Date.now() - t0;
    console.log(`  async iterate (pf=1) — ${fmt(elapsed)}, ${count} rows`);
  }
  {
    await using db = openAsync(':memory:');
    const t0 = Date.now();
    let count = 0;
    for await (const _row of db.iterate(SQL, [], { prefetch: 4 })) count++;
    const elapsed = Date.now() - t0;
    console.log(`  async iterate (pf=4) — ${fmt(elapsed)}, ${count} rows`);
  }
}

// ============================================================================
// #4 — Appender throughput
// ============================================================================

async function bench4_appender() {
  bar();
  console.log('Bench #4 — appender throughput (100K rows)');
  bar();
  const N = 100_000;

  {
    using db = openSync(':memory:');
    await db.exec('CREATE TABLE t (n INT)');
    const rows = Array.from({ length: N }, (_, i) => [i]);
    using conn = db.connect();
    const t0 = Date.now();
    const r = await conn.append('t', ['n'], rows);
    const elapsed = Date.now() - t0;
    console.log(`  sync one-shot        — ${fmt(elapsed)}, ${r.rows} rows, ${Math.round(N / (elapsed / 1000))} rows/s`);
  }
  {
    await using db = openAsync(':memory:');
    await db.exec('CREATE TABLE t (n INT)');
    using conn = db.connect();
    const rows = Array.from({ length: N }, (_, i) => [i]);
    const t0 = Date.now();
    const r = await conn.append('t', ['n'], rows);
    const elapsed = Date.now() - t0;
    console.log(`  async one-shot       — ${fmt(elapsed)}, ${r.rows} rows, ${Math.round(N / (elapsed / 1000))} rows/s`);
  }
  {
    await using db = openAsync(':memory:');
    await db.exec('CREATE TABLE t (n INT)');
    using conn = db.connect();
    const t0 = Date.now();
    const app = await conn.append('t', ['n']);
    for (let i = 0; i < N; i++) app.appendRow([i]);
    await app.close();
    const elapsed = Date.now() - t0;
    console.log(`  async streaming      — ${fmt(elapsed)}, ${N} rows, ${Math.round(N / (elapsed / 1000))} rows/s`);
  }
}

// ============================================================================
// Run
// ============================================================================

await bench1_responsiveness();
await bench2_small_query();
await bench3_large_result();
await bench4_appender();
bar();
