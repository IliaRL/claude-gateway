# TraceStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-request diagnostic traces to a SQLite database and expose a `/v1/traces` HTTP query interface, making "why did this request fail?" answerable with a single HTTP GET instead of manual log reconstruction.

**Architecture:** A new `TraceStore` module (`src/utils/trace-store.js`) wraps a `better-sqlite3` database at `logs/traces.db`. After each request finalizes (`pushTrace()` is called in `request-handler.js`), `TraceStore.persist(trace)` is called fire-and-forget. Three HTTP endpoints are added to `src/services/api-server.js`: `GET /v1/traces`, `GET /v1/traces/summary`, `GET /v1/traces/:requestId`. Auto-prune keeps the DB at 500 rows max.

**Tech Stack:** Node.js ESM, `better-sqlite3` (new dep — synchronous SQLite, zero config), Jest 29, supertest.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/utils/trace-store.js` | **Create** | SQLite init, persist, query, prune |
| `src/handlers/request-handler.js` | **Modify** | Call `TraceStore.persist()` after `pushTrace()` in `finalizeTrace` |
| `src/services/api-server.js` | **Modify** | Register `GET /v1/traces`, `/v1/traces/summary`, `/v1/traces/:requestId` |
| `logs/.gitkeep` | **Create** | Ensure `logs/` directory exists in repo |
| `tests/utils/trace-store.test.js` | **Create** | Unit tests for persist, query, prune |

---

### Task 1: Install `better-sqlite3`

**Files:**
- Modify: `package.json` (via pnpm)

- [ ] **Step 1: Install the dependency**

```bash
cd AIClient2API && pnpm add better-sqlite3
```
Expected: Package added, `pnpm-lock.yaml` updated.

- [ ] **Step 2: Verify install**

```bash
cd AIClient2API && node -e "import('better-sqlite3').then(m => console.log('ok', typeof m.default))"
```
Expected: `ok function`

- [ ] **Step 3: Ensure `logs/` directory exists**

```bash
mkdir -p AIClient2API/logs && touch AIClient2API/logs/.gitkeep
```

- [ ] **Step 4: Add `logs/traces.db` to `.gitignore`**

Open `AIClient2API/.gitignore` (or the root `.gitignore`) and add:
```
AIClient2API/logs/traces.db
```

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml AIClient2API/logs/.gitkeep .gitignore
git commit -m "chore: add better-sqlite3 for trace persistence"
```

---

### Task 2: TraceStore schema + persist + auto-prune

**Files:**
- Create: `src/utils/trace-store.js`
- Create: `tests/utils/trace-store.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/utils/trace-store.test.js
import { test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let store;
let tmpDir;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'traces-test-'));
  const { TraceStore } = await import(`../../src/utils/trace-store.js?t=${Date.now()}`);
  store = new TraceStore(join(tmpDir, 'traces.db'));
});

afterEach(() => {
  store?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeTrace(overrides = {}) {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    model: 'gpt-4o',
    provider: 'openai-custom',
    startedAt: Date.now(),
    totalRTTMs: 250,
    ttftMs: 120,
    status: 'ok',
    errorCode: null,
    errorMsg: null,
    fallbackCount: 0,
    isDowngrade: false,
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  };
}

test('persist and retrieve a trace by requestId', () => {
  const t = makeTrace();
  store.persist(t);
  const found = store.getById(t.requestId);
  expect(found).toBeDefined();
  expect(found.requestId).toBe(t.requestId);
  expect(found.model).toBe('gpt-4o');
  expect(found.provider).toBe('openai-custom');
  expect(found.status).toBe('ok');
});

test('returns null for unknown requestId', () => {
  expect(store.getById('nonexistent')).toBeNull();
});

test('auto-prune keeps at most 500 rows', () => {
  for (let i = 0; i < 510; i++) {
    store.persist(makeTrace({ requestId: `req-${i}`, startedAt: i }));
  }
  const count = store.count();
  expect(count).toBeLessThanOrEqual(500);
});

test('persist is idempotent: duplicate requestId replaces the row', () => {
  const t = makeTrace();
  store.persist(t);
  store.persist({ ...t, status: 'error' });
  const found = store.getById(t.requestId);
  expect(found.status).toBe('error');
  expect(store.count()).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd AIClient2API && pnpm test tests/utils/trace-store.test.js
```
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Implement TraceStore with schema, persist, prune, getById, count**

```javascript
// src/utils/trace-store.js
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import logger from './logger.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS request_traces (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    requestId    TEXT UNIQUE NOT NULL,
    model        TEXT,
    provider     TEXT,
    startedAt    INTEGER,
    totalRTTMs   INTEGER,
    ttftMs       INTEGER,
    status       TEXT,
    errorCode    TEXT,
    errorMsg     TEXT,
    fallbackCount INTEGER DEFAULT 0,
    isDowngrade  INTEGER DEFAULT 0,
    inputTokens  INTEGER,
    outputTokens INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_traces_startedAt ON request_traces (startedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_traces_provider  ON request_traces (provider);
  CREATE INDEX IF NOT EXISTS idx_traces_status    ON request_traces (status);
`;

const MAX_ROWS = 500;

export class TraceStore {
  constructor(dbPath = 'logs/traces.db') {
    mkdirSync(dirname(dbPath), { recursive: true });
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.exec(SCHEMA);
    this._stmtInsert = this._db.prepare(`
      INSERT OR REPLACE INTO request_traces
        (requestId, model, provider, startedAt, totalRTTMs, ttftMs, status,
         errorCode, errorMsg, fallbackCount, isDowngrade, inputTokens, outputTokens)
      VALUES
        (@requestId, @model, @provider, @startedAt, @totalRTTMs, @ttftMs, @status,
         @errorCode, @errorMsg, @fallbackCount, @isDowngrade, @inputTokens, @outputTokens)
    `);
    this._stmtPrune = this._db.prepare(`
      DELETE FROM request_traces
      WHERE id NOT IN (
        SELECT id FROM request_traces ORDER BY startedAt DESC LIMIT ${MAX_ROWS}
      )
    `);
    this._stmtGetById = this._db.prepare(
      `SELECT * FROM request_traces WHERE requestId = ?`
    );
    this._stmtCount = this._db.prepare(`SELECT COUNT(*) as n FROM request_traces`);
    this._insertAndPrune = this._db.transaction((row) => {
      this._stmtInsert.run(row);
      this._stmtPrune.run();
    });
  }

  /**
   * Persist a trace. Fire-and-forget — errors are logged, never thrown.
   * @param {object} trace  createTrace() output (from trace-buffer.js)
   */
  persist(trace) {
    try {
      this._insertAndPrune({
        requestId:    trace.requestId ?? null,
        model:        trace.model ?? null,
        provider:     trace.provider ?? null,
        startedAt:    trace.startedAt ?? Date.now(),
        totalRTTMs:   trace.totalRTTMs ?? null,
        ttftMs:       trace.upstreamTTFTMs ?? trace.ttftMs ?? null,
        status:       trace.status ?? 'ok',
        errorCode:    trace.errorCode ?? null,
        errorMsg:     trace.errorMessage ?? trace.errorMsg ?? null,
        fallbackCount: trace.fallbackCount ?? 0,
        isDowngrade:  trace.isDowngrade ? 1 : 0,
        inputTokens:  trace.inputTokens ?? null,
        outputTokens: trace.outputTokens ?? null,
      });
    } catch (err) {
      logger.warn(`[TraceStore] persist failed for ${trace.requestId}: ${err.message}`);
    }
  }

  /** @returns {object|null} */
  getById(requestId) {
    return this._stmtGetById.get(requestId) ?? null;
  }

  /** Total rows in DB (for tests / prune verification). */
  count() {
    return this._stmtCount.get().n;
  }

  /** Close the database (call in tests / graceful shutdown). */
  close() {
    this._db.close();
  }
}

/** Singleton for use in production. */
export const traceStore = new TraceStore();
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd AIClient2API && pnpm test tests/utils/trace-store.test.js
```
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/trace-store.js tests/utils/trace-store.test.js AIClient2API/logs/.gitkeep
git commit -m "feat(trace-store): SQLite persistence with auto-prune at 500 rows"
```

---

### Task 3: Query methods (filters + summary)

**Files:**
- Modify: `src/utils/trace-store.js`
- Modify: `tests/utils/trace-store.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `tests/utils/trace-store.test.js`:

```javascript
test('query: filter by status=error returns only errors', () => {
  store.persist(makeTrace({ requestId: 'ok-1', status: 'ok' }));
  store.persist(makeTrace({ requestId: 'err-1', status: 'error' }));
  store.persist(makeTrace({ requestId: 'err-2', status: 'error' }));
  const results = store.query({ error: true });
  expect(results.every(r => r.status === 'error')).toBe(true);
  expect(results.length).toBe(2);
});

test('query: filter by provider', () => {
  store.persist(makeTrace({ requestId: 'a', provider: 'openai-custom' }));
  store.persist(makeTrace({ requestId: 'b', provider: 'gemini-antigravity' }));
  const results = store.query({ provider: 'gemini-antigravity' });
  expect(results.every(r => r.provider === 'gemini-antigravity')).toBe(true);
  expect(results.length).toBe(1);
});

test('query: filter by since=1h excludes old traces', () => {
  const now = Date.now();
  store.persist(makeTrace({ requestId: 'new', startedAt: now - 1_000 }));           // 1s ago - include
  store.persist(makeTrace({ requestId: 'old', startedAt: now - 3_700_000 }));        // >1h ago - exclude
  const results = store.query({ since: '1h' });
  expect(results.some(r => r.requestId === 'new')).toBe(true);
  expect(results.some(r => r.requestId === 'old')).toBe(false);
});

test('query: invalid since value returns empty array without throwing', () => {
  expect(() => store.query({ since: 'banana' })).not.toThrow();
  const results = store.query({ since: 'banana' });
  expect(Array.isArray(results)).toBe(true);
});

test('query: limit is respected', () => {
  for (let i = 0; i < 10; i++) store.persist(makeTrace({ requestId: `lim-${i}` }));
  const results = store.query({ limit: 3 });
  expect(results.length).toBe(3);
});

test('summary: returns total, errors, avgLatencyMs for last 1h', () => {
  const now = Date.now();
  store.persist(makeTrace({ requestId: 's1', status: 'ok',    totalRTTMs: 100, startedAt: now - 1_000 }));
  store.persist(makeTrace({ requestId: 's2', status: 'error', totalRTTMs: 300, startedAt: now - 2_000 }));
  store.persist(makeTrace({ requestId: 's3', status: 'ok',    totalRTTMs: 200, startedAt: now - 4_000_000 })); // >1h, excluded
  const s = store.summary();
  expect(s.total).toBe(2);
  expect(s.errors).toBe(1);
  expect(s.avgLatencyMs).toBeCloseTo(200, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd AIClient2API && pnpm test tests/utils/trace-store.test.js
```
Expected: FAIL — `store.query is not a function`

- [ ] **Step 3: Add query, summary, and parseSince to TraceStore**

Add these methods inside the `TraceStore` class, after `count()`:

```javascript
  /**
   * Query traces with optional filters.
   * @param {object} opts
   * @param {boolean} [opts.error]       If true, only return status='error' rows
   * @param {string}  [opts.provider]    Exact provider match
   * @param {string}  [opts.model]       LIKE %model% match
   * @param {string}  [opts.since]       Time window: '1h', '30m', '24h', '7d'
   * @param {number}  [opts.limit=50]    Max rows returned (capped at 200)
   * @returns {object[]}
   */
  query({ error, provider, model, since, limit = 50 } = {}) {
    const conditions = [];
    const params = [];

    if (error === true || error === 'true') {
      conditions.push(`status = 'error'`);
    }
    if (provider) {
      conditions.push(`provider = ?`);
      params.push(provider);
    }
    if (model) {
      conditions.push(`model LIKE ?`);
      params.push(`%${model}%`);
    }
    const sinceMs = _parseSince(since);
    if (sinceMs !== null) {
      conditions.push(`startedAt > ?`);
      params.push(Date.now() - sinceMs);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 200);
    params.push(safeLimit);

    return this._db.prepare(
      `SELECT * FROM request_traces ${where} ORDER BY startedAt DESC LIMIT ?`
    ).all(...params);
  }

  /**
   * Aggregate stats for the last 1 hour.
   * @returns {{ total: number, errors: number, avgLatencyMs: number|null }}
   */
  summary() {
    const since = Date.now() - 3_600_000;
    return this._db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
        AVG(totalRTTMs) as avgLatencyMs
      FROM request_traces
      WHERE startedAt > ?
    `).get(since);
  }
```

Add the helper function at the bottom of the file (outside the class):

```javascript
/**
 * Parse a human-readable since string into milliseconds.
 * Valid formats: '30m', '1h', '24h', '7d'
 * @returns {number|null}  null if unrecognized
 */
function _parseSince(since) {
  if (!since) return null;
  const match = String(since).match(/^(\d+)(m|h|d)$/);
  if (!match) return null;
  const [, n, unit] = match;
  const multipliers = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(n) * multipliers[unit];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd AIClient2API && pnpm test tests/utils/trace-store.test.js
```
Expected: PASS (all 10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/trace-store.js tests/utils/trace-store.test.js
git commit -m "feat(trace-store): add query(), summary() with filters and time windows"
```

---

### Task 4: Wire persistence into request-handler.js

**Files:**
- Modify: `src/handlers/request-handler.js`

- [ ] **Step 1: Add import at top of request-handler.js**

Find the existing import block (line 17 has `trace-buffer` imports). Add:

```javascript
import { traceStore } from '../utils/trace-store.js';
```

- [ ] **Step 2: Add persist call after pushTrace**

Find `finalizeTrace` (around line 88). Currently it looks like:

```javascript
const finalizeTrace = (status) => {
    if (traceFinalized) return;
    traceFinalized = true;
    trace.totalRTTMs = Date.now() - trace.startedAt;
    if (status) trace.status = status;
    else if (trace.status === 'pending') trace.status = 'ok';
    pushTrace(trace);
    // ... rest
};
```

Add `traceStore.persist(trace)` on the line immediately after `pushTrace(trace)`:

```javascript
    pushTrace(trace);
    traceStore.persist(trace); // ← add this line
```

- [ ] **Step 3: Run full test suite — verify zero regressions**

```bash
cd AIClient2API && pnpm test
```
Expected: **All previous tests still pass.** The `traceStore.persist()` call is fire-and-forget; it cannot affect test outcomes.

- [ ] **Step 4: Smoke test persistence**

```bash
# Make a test request:
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":10}' \
  http://127.0.0.1:3000/v1/messages -o /dev/null -w "%{http_code}\n"

# Verify trace was persisted:
node -e "
  import Database from 'better-sqlite3';
  const db = new Database('AIClient2API/logs/traces.db');
  const rows = db.prepare('SELECT requestId, model, provider, status, totalRTTMs FROM request_traces ORDER BY startedAt DESC LIMIT 3').all();
  console.log(rows);
  db.close();
"
```
Expected: One or more rows printed showing the request.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/request-handler.js
git commit -m "feat(trace-store): persist traces in finalizeTrace after pushTrace"
```

---

### Task 5: HTTP endpoints in api-server.js

**Files:**
- Modify: `src/services/api-server.js`

- [ ] **Step 1: Add import at top of api-server.js**

```javascript
import { traceStore } from '../utils/trace-store.js';
```

- [ ] **Step 2: Find the route registration section**

```bash
cd AIClient2API && grep -n "app.get\|router.get\|app.post\|'/v1/" src/services/api-server.js | head -20
```
Note the pattern used — whether it's `app.get(...)` directly or via a router.

- [ ] **Step 3: Add the three trace endpoints**

Add these routes near the other `/v1/` endpoints, using the same routing pattern as the existing code:

```javascript
// GET /v1/traces/summary — must come BEFORE /v1/traces/:requestId to avoid clash
app.get('/v1/traces/summary', (_req, res) => {
  try {
    const summary = traceStore.summary();
    res.json({
      window: '1h',
      total: summary.total ?? 0,
      errors: summary.errors ?? 0,
      errorRate: summary.total > 0 ? ((summary.errors / summary.total) * 100).toFixed(1) + '%' : '0%',
      avgLatencyMs: summary.avgLatencyMs != null ? Math.round(summary.avgLatencyMs) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /v1/traces?error=true&provider=X&model=Y&since=1h&limit=50
app.get('/v1/traces', (req, res) => {
  try {
    const { error, provider, model, since, limit } = req.query;
    const traces = traceStore.query({ error, provider, model, since, limit });
    res.json({ total: traces.length, traces });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /v1/traces/:requestId — look up a single trace
app.get('/v1/traces/:requestId', (req, res) => {
  try {
    const trace = traceStore.getById(req.params.requestId);
    if (!trace) return res.status(404).json({ error: 'Trace not found' });
    res.json(trace);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Test the endpoints**

```bash
# All recent traces:
curl -s "http://127.0.0.1:3000/v1/traces?limit=5" \
  -H "Authorization: Bearer $AICLIENT_TOKEN" | jq .

# Error traces in last 1h:
curl -s "http://127.0.0.1:3000/v1/traces?error=true&since=1h" \
  -H "Authorization: Bearer $AICLIENT_TOKEN" | jq .

# Summary:
curl -s "http://127.0.0.1:3000/v1/traces/summary" \
  -H "Authorization: Bearer $AICLIENT_TOKEN" | jq .
```
Expected: JSON responses with trace data.

- [ ] **Step 5: Run full test suite one final time**

```bash
cd AIClient2API && pnpm test
```
Expected: All 110+ tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/api-server.js
git commit -m "feat(trace-store): add /v1/traces, /v1/traces/summary, /v1/traces/:id endpoints"
```

---

### Task 6: Verification

- [ ] **Run full test suite**

```bash
cd AIClient2API && pnpm test
```
Expected: 110+ PASS, 0 FAIL.

- [ ] **Confirm auto-prune works**

```bash
node -e "
  import Database from 'better-sqlite3';
  const db = new Database('AIClient2API/logs/traces.db');
  const { n } = db.prepare('SELECT COUNT(*) as n FROM request_traces').get();
  console.log('Row count:', n, '(should be ≤ 500)');
  db.close();
"
```

- [ ] **Diagnose the live 503 failures with the new tool**

```bash
curl -s "http://127.0.0.1:3000/v1/traces?error=true&since=1h&provider=openai-custom" \
  -H "Authorization: Bearer $AICLIENT_TOKEN" | jq '.traces[] | {requestId, model, errorMsg, totalRTTMs}'
```
Expected: Shows the OpenRouter 503 errors with full context — model, error message, timing.

- [ ] **Final commit tag**

```bash
git tag trace-store-complete
```
