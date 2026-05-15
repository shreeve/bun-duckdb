// Worker entry for duckdb-bun/async.
//
// This file runs inside the Bun Worker. It imports the v0.3 main-thread
// driver verbatim and holds a registry mapping numeric IDs (one set per
// Database, Connection, Statement, Appender) to live driver objects.
// All DuckDB FFI happens here; the main thread never sees raw handles.
//
// Protocol: see lib/async/protocol.d.ts. The dispatcher below maps each
// request `op` to a v0.3 method call and serializes the result.

import { open as openSync, version as driverVersion } from '../duckdb.mjs';
import { serializeError, OP, WORKER_READY } from './protocol.mjs';

// ============================================================================
// Registry
// ============================================================================
//
// Numeric IDs are monotonic per-kind and never reused. The registry
// holds the actual driver objects:
//   dbs[id]    → Database
//   conns[id]  → Connection
//   stmts[id]  → Statement
//   apps[id]   → Appender (currently: { conn, table, columns, appender? })
//   iters[id]  → { wrapper, stmtId, exhausted }
//
// Counters start at 1 so id=0 can be sentinel "invalid" if needed.

const dbs   = new Map();
const conns = new Map();
const stmts = new Map();
const apps  = new Map();
const iters = new Map();

let nextDbId = 1, nextConnId = 1, nextStmtId = 1, nextAppId = 1, nextIterId = 1;
// Generation counter for v0.5 cancellation: each new connection gets a
// fresh generation token so stale abort listeners on a closed-then-
// reopened connId can't accidentally interrupt the new connection.
let connGeneration = 1;

// Track Database → Set<Connection>, Connection → Set<Statement>/Set<Appender>,
// Statement → activeIterId so close cascades can find children without
// re-querying the driver. The v0.3 driver already cascades internally
// when conn.close() / db.close() is called, so all we need is the
// inverse map for the registry's own ID cleanup.
const dbConns       = new Map();   // dbId → Set<connId>
const connStmts     = new Map();   // connId → Set<stmtId>
const connApps      = new Map();   // connId → Set<appId>
const stmtIters     = new Map();   // stmtId → Set<iterId>

// Register helper: insert into both the kind map and the parent index.
function trackChild(parentMap, parentId, childId) {
  let set = parentMap.get(parentId);
  if (!set) { set = new Set(); parentMap.set(parentId, set); }
  set.add(childId);
}
function untrackChild(parentMap, parentId, childId) {
  const set = parentMap.get(parentId);
  if (set) set.delete(childId);
}

// ============================================================================
// Target resolution
// ============================================================================

function getDb(id)   { const d = dbs.get(id);   if (!d) throw new Error(`No such Database (id=${id})`);   return d; }
function getConn(id) { const c = conns.get(id); if (!c) throw new Error(`No such Connection (id=${id})`); return c; }
function getStmt(id) { const s = stmts.get(id); if (!s) throw new Error(`No such Statement (id=${id})`);  return s; }
function getApp(id)  { const a = apps.get(id);  if (!a) throw new Error(`No such Appender (id=${id})`);   return a; }

// Resolve a DbOrConn target to a Connection-like driver object — for
// Database targets, we use the implicit connection via the shortcut
// methods. The actual routing here matches v0.3: db.query() / db.all()
// / db.prepare() etc. internally route through db's lazy default
// Connection.
function resolveDbOrConn(target) {
  if (target.kind === 'db')   return getDb(target.id);
  if (target.kind === 'conn') return getConn(target.id);
  throw new Error(`Invalid target kind for DbOrConn op: ${target.kind}`);
}

// ============================================================================
// Op handlers
// ============================================================================
//
// Each handler is `async` so it can `await` driver calls. The dispatcher
// catches and serializes any throw.

async function handleOpen(req) {
  // v0.5+: OpenOptions are passed through to the v0.3 driver as the
  // second arg. The driver does the duckdb_create_config /
  // duckdb_open_ext dance; we just hand it the user's opts.
  const db = openSync(req.path, req.opts);
  const id = nextDbId++;
  dbs.set(id, db);
  dbConns.set(id, new Set());
  return { dbId: id };
}

async function handleClose(req) {
  return doClose(req.target, /* fromRelease */ false);
}

async function handleRelease(req) {
  // GC-triggered cleanup. Treat like close() but never raise.
  try { return await doClose(req.target, /* fromRelease */ true); }
  catch { return { ok: true }; }
}

async function doClose(target) {
  const { kind, id } = target;
  if (kind === 'db') {
    const db = dbs.get(id);
    if (!db) return { ok: true };
    // Clean up child IDs in the registry before destroying. The driver's
    // db.close() cascades through the implicit connection and any
    // statements/appenders on it; we just need to flush our ID maps.
    const childConnIds = [...(dbConns.get(id) || [])];
    for (const cid of childConnIds) await doClose({ kind: 'conn', id: cid });
    await db.close();
    dbs.delete(id);
    dbConns.delete(id);
    return { ok: true };
  }
  if (kind === 'conn') {
    const conn = conns.get(id);
    if (!conn) return { ok: true };
    for (const sid of [...(connStmts.get(id) || [])]) await doClose({ kind: 'stmt', id: sid });
    for (const aid of [...(connApps.get(id) || [])])  await doClose({ kind: 'app',  id: aid });
    await conn.close();
    conns.delete(id);
    connStmts.delete(id);
    connApps.delete(id);
    // Detach from parent
    for (const [dbId, set] of dbConns) set.delete(id);
    return { ok: true };
  }
  if (kind === 'stmt') {
    const stmt = stmts.get(id);
    if (!stmt) return { ok: true };
    for (const itId of [...(stmtIters.get(id) || [])]) await closeIterator(itId);
    await stmt.close();
    stmts.delete(id);
    stmtIters.delete(id);
    for (const set of connStmts.values()) set.delete(id);
    return { ok: true };
  }
  if (kind === 'app') {
    const entry = apps.get(id);
    if (!entry) return { ok: true };
    try {
      if (entry.appender) {
        // The v0.3 Appender doesn't have a separate close — append() with
        // empty rows + the appender lives only for the duration of an
        // append() call. For our async API we maintain a persistent
        // appender via a manual flush pattern. Since the v0.3 driver
        // doesn't expose this directly, we instead buffer rows on the
        // worker side and flush all at once on appendFlush — see below.
      }
    } catch { /* swallow */ }
    apps.delete(id);
    for (const set of connApps.values()) set.delete(id);
    return { ok: true };
  }
  throw new Error(`Unknown target kind: ${kind}`);
}

async function closeIterator(iterId) {
  const entry = iters.get(iterId);
  if (!entry) return;
  try { await entry.wrapper.return(); } catch { /* swallow */ }
  iters.delete(iterId);
  for (const set of stmtIters.values()) set.delete(iterId);
}

async function handleConnect(req) {
  const db = getDb(req.target.id);
  const conn = db.connect();
  const id = nextConnId++;
  conns.set(id, conn);
  connStmts.set(id, new Set());
  connApps.set(id, new Set());
  trackChild(dbConns, req.target.id, id);
  // Forward-compat (v0.4.1+): include the raw duckdb_connection handle
  // as an opaque BigInt. Main thread stores it as an "interrupt
  // capability" for v0.5 cancellation (will pass it to duckdb_interrupt
  // from the main thread while this worker is blocked in FFI). Main
  // never dereferences it from JS. Increment generation per conn so
  // stale abort listeners can't fire on a reused connId.
  return {
    connId: id,
    interruptHandle: conn.handle,        // BigInt (duckdb_connection pointer)
    interruptGeneration: connGeneration++,
  };
}

async function handleQuery(req) {
  const target = resolveDbOrConn(req.target);
  switch (req.method) {
    case 'query':
    case 'all':  return await target.all(req.sql, req.params);
    case 'get':  return await target.get(req.sql, req.params);
    case 'run':  return await target.run(req.sql, req.params);
    case 'exec': await target.exec(req.sql); return { ok: true };
    default: throw new Error(`Unknown query method: ${req.method}`);
  }
}

async function handlePrepare(req) {
  const target = resolveDbOrConn(req.target);
  const stmt = await target.prepare(req.sql);
  const id = nextStmtId++;
  stmts.set(id, stmt);
  stmtIters.set(id, new Set());
  // Track under the owning Connection. If target was a Database, the
  // implicit conn is _defaultConn; pull its registry id via the dbConns
  // index — there's exactly one default conn per Database in the registry.
  // For Connection targets, target.id is the conn id directly.
  if (req.target.kind === 'conn') {
    trackChild(connStmts, req.target.id, id);
  } else {
    // Database target. The implicit conn isn't registered in `conns` —
    // it's owned internally by the Database. That means we can't track
    // the statement under a registered conn id. We accept this: the
    // statement will be reachable only via stmts.get(id); cascade on
    // Database close happens through the driver itself (db.close()
    // closes the implicit conn which closes its statements).
  }
  return { stmtId: id };
}

async function handleStmtCall(req) {
  const stmt = getStmt(req.target.id);
  switch (req.method) {
    case 'all': return await stmt.all(req.params);
    case 'get': return await stmt.get(req.params);
    case 'run': return await stmt.run(req.params);
    default: throw new Error(`Unknown stmt method: ${req.method}`);
  }
}

// ── streaming ──────────────────────────────────────────────────────────

async function handleIterStart(req) {
  const stmt = getStmt(req.target.id);
  const wrapper = stmt.iterate(req.params);
  const id = nextIterId++;
  // Buffer per-iterator chunks. The actual fetch happens in iterNext.
  iters.set(id, { wrapper, stmtId: req.target.id, exhausted: false });
  trackChild(stmtIters, req.target.id, id);
  // The driver doesn't expose column metadata before the first .next();
  // we'd have to peek a chunk. Rather than complicate, we let the proxy
  // attach columns lazily from the first iterNext response (the v0.3
  // streaming path doesn't surface .columns on the iterator anyway).
  return { iterId: id, columns: [] };
}

async function handleIterNext(req) {
  const entry = iters.get(req.iterId);
  if (!entry) return { rows: [], done: true };
  if (entry.exhausted) return { rows: [], done: true };

  // Drain one chunk from the iterator. The v0.3 driver yields rows
  // one at a time but each underlying generator step pulls one full
  // chunk and walks rows from it. We buffer up to ROWS_PER_CHUNK
  // here and return them as one wire message.
  //
  // Note: this is approximate — the v0.3 generator doesn't expose
  // "give me one chunk's worth"; it just yields row-by-row. We
  // collect rows until either a chunk boundary (signaled by the
  // generator pausing for our own setTimeout(0)) or a max row
  // count. For v0.4.0 simplicity, we collect up to MAX_ROWS_PER_NEXT
  // rows per request — this gives reasonable throughput without
  // unbounded buffering.
  const MAX_ROWS_PER_NEXT = 2048;
  const rows = [];
  for (let i = 0; i < MAX_ROWS_PER_NEXT; i++) {
    const r = await entry.wrapper.next();
    if (r.done) { entry.exhausted = true; break; }
    rows.push(r.value);
  }
  return { rows, done: entry.exhausted };
}

async function handleIterReturn(req) {
  await closeIterator(req.iterId);
  return { ok: true };
}

// ── appender ───────────────────────────────────────────────────────────
//
// The v0.3 Appender API exposes `conn.append(table, columns, rows)` as a
// one-shot bulk insert. For the async subpath we need a streaming append
// (rows arrive in batches from the proxy). We buffer rows in the
// worker-side registry entry and flush them via conn.append() when
// the proxy calls appendFlush or close.
//
// This means peak memory is bounded by the proxy's batch size + however
// many batches arrive before flush is called. Documented in RFC §9.

async function handleAppendCreate(req) {
  const target = resolveDbOrConn(req.target);
  const id = nextAppId++;
  // For Database targets, target gives us the lazy default Connection
  // via its .append() shortcut; for explicit Connection targets, we
  // use the conn directly. We need a real Connection reference so
  // store the resolved one.
  apps.set(id, {
    conn: target,
    table: req.table,
    columns: req.columns,
    pending: [],
    poisoned: null,
  });
  if (req.target.kind === 'conn') trackChild(connApps, req.target.id, id);
  return { appId: id };
}

async function handleAppendRows(req) {
  const entry = getApp(req.target.id);
  if (entry.poisoned) throw entry.poisoned;
  // Append rows to the worker-side buffer. The actual conn.append()
  // FFI call happens at flush time so we can batch across multiple
  // appendRows wire messages.
  for (const row of req.rows) entry.pending.push(row);
  return { rows: req.rows.length };
}

async function handleAppendFlush(req) {
  const entry = getApp(req.target.id);
  if (entry.poisoned) throw entry.poisoned;
  if (entry.pending.length === 0) return { rows: 0 };
  const rows = entry.pending;
  entry.pending = [];
  try {
    const result = await entry.conn.append(entry.table, entry.columns, rows);
    return { rows: result.rows };
  } catch (err) {
    entry.poisoned = err;
    throw err;
  }
}

// ── transactions ───────────────────────────────────────────────────────
//
// Per RFC §7: txnBegin allocates a fresh Connection bound to the txn so
// the user's callback's sub-ops naturally serialize on it without
// contending with other connections. Returns the new connId. The proxy
// invokes the user's callback with txProxy.target = { kind: 'conn',
// id: <new id> } and routes ops there. On callback resolve → txnCommit;
// on reject → txnRollback + rethrow.

async function handleTxnBegin(req) {
  // Find the owning Database. If target is a conn, walk up via dbConns.
  let db;
  if (req.target.kind === 'db') db = getDb(req.target.id);
  else {
    for (const [dbId, set] of dbConns) {
      if (set.has(req.target.id)) { db = getDb(dbId); break; }
    }
    if (!db) throw new Error('txnBegin: could not find owning Database');
  }
  const conn = db.connect();
  const id = nextConnId++;
  conns.set(id, conn);
  connStmts.set(id, new Set());
  connApps.set(id, new Set());
  // Find dbId for tracking
  for (const [dbId, theDb] of dbs) {
    if (theDb === db) { trackChild(dbConns, dbId, id); break; }
  }
  await conn.query('BEGIN');
  // Forward-compat: include interrupt capability for v0.5 cancellation
  // (transaction-level signal will interrupt the txn's sub-ops).
  return {
    connId: id,
    interruptHandle: conn.handle,
    interruptGeneration: connGeneration++,
  };
}

async function handleTxnCommit(req) {
  const conn = getConn(req.target.id);
  await conn.query('COMMIT');
  // Don't auto-close the conn here — the proxy might want to inspect
  // state or run a follow-up. Let the proxy emit close in its own
  // finally.
  return { ok: true };
}

async function handleTxnRollback(req) {
  const conn = getConn(req.target.id);
  try { await conn.query('ROLLBACK'); } catch { /* swallow */ }
  return { ok: true };
}

// ============================================================================
// Dispatcher
// ============================================================================

const HANDLERS = {
  [OP.OPEN]:         handleOpen,
  [OP.CLOSE]:        handleClose,
  [OP.RELEASE]:      handleRelease,
  [OP.CONNECT]:      handleConnect,
  [OP.QUERY]:        handleQuery,
  [OP.PREPARE]:      handlePrepare,
  [OP.STMT_CALL]:    handleStmtCall,
  [OP.ITER_START]:   handleIterStart,
  [OP.ITER_NEXT]:    handleIterNext,
  [OP.ITER_RETURN]:  handleIterReturn,
  [OP.APP_CREATE]:   handleAppendCreate,
  [OP.APP_ROWS]:     handleAppendRows,
  [OP.APP_FLUSH]:    handleAppendFlush,
  [OP.TXN_BEGIN]:    handleTxnBegin,
  [OP.TXN_COMMIT]:   handleTxnCommit,
  [OP.TXN_ROLLBACK]: handleTxnRollback,
};

self.onmessage = async (e) => {
  const req = e.data;
  if (req && req.op === OP.RELEASE) {
    // Fire-and-forget; no response expected.
    try { await handleRelease(req); } catch { /* swallow */ }
    return;
  }
  if (!req || typeof req.id !== 'number') {
    // Malformed; ignore.
    return;
  }
  try {
    const handler = HANDLERS[req.op];
    if (!handler) throw new Error(`Unknown op: ${req.op}`);
    const value = await handler(req);
    self.postMessage({ id: req.id, ok: true, value });
  } catch (err) {
    self.postMessage({ id: req.id, ok: false, error: serializeError(err) });
  }
};

// Notify the main thread that the worker module has loaded and is ready
// to accept requests. The proxy queues outgoing messages until this
// arrives.
self.postMessage({ type: WORKER_READY, driverVersion: driverVersion() });
