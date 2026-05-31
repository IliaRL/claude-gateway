# Spec B: Observability & Diagnostics — Trace Store

## Overview

This spec makes existing request traces persistent and queryable. The trace
infrastructure (`createTrace`, `pushTrace`, `X-Proxy-Trace` headers) already
captures the right data — this spec adds a SQLite persistence layer and an HTTP
query interface on top of it.

**Problem being solved:** Traces live only in memory and disappear on restart.
Diagnosing a failed request requires: enable `PROMPT_LOG_MODE: "file"`, restart,
reproduce the exact failure, then grep through log files. With this spec: one HTTP
GET with filters replaces that entire manual process.

---

## Architecture

```
src/utils/db.js                     ← extend: request_traces table + TraceStore
src/handlers/request-handler.js     ← extend: TraceStore.persist() in finalizeTrace()
src/services/api-server.js          ← extend: GET /v1/traces + GET /v1/traces/:requestId
tests/utils/trace-store.test.js     ← new
```

No new dependencies. Uses the existing SQLite connection (`cockpit.db`) already
managed by `src/utils/db.js`.

---

## Components

### 1. `request_traces` Table

```sql
CREATE TABLE IF NOT EXISTS request_traces (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  requestId    TEXT UNIQUE NOT NULL,
  model        TEXT,
  provider     TEXT,
  startedAt    INTEGER,       -- unix milliseconds
  totalRTTMs   INTEGER,
  ttftMs       INTEGER,
  status       TEXT,          -- 'ok' | 'error' | 'fallback'
  errorCode    TEXT,
  errorMsg     TEXT,
  fallbackCount INTEGER DEFAULT 0,
  isDowngrade  INTEGER DEFAULT 0,   -- 0/1 boolean
  inputTokens  INTEGER,
  outputTokens INTEGER
);

CREATE INDEX IF NOT EXISTS idx_traces_startedAt ON request_traces (startedAt DESC);
CREATE INDEX IF NOT EXISTS idx_traces_provider  ON request_traces (provider);
CREATE INDEX IF NOT EXISTS idx_traces_status    ON request_traces (status);
```

**Auto-prune:** After each INSERT, a DELETE keeps only the most recent 500 rows.
No cron job or external process needed:
```sql
DELETE FROM request_traces
WHERE id NOT IN (
  SELECT id FROM request_traces ORDER BY startedAt DESC LIMIT 500
);
```

### 2. TraceStore (added to `db.js`)

```
TraceStore.persist(trace)          → non-blocking INSERT (fire-and-forget)
TraceStore.query(filters)          → SELECT with WHERE clauses, returns array
TraceStore.getById(requestId)      → SELECT single trace by requestId
TraceStore.summary()               → aggregate: total, errors, avg latency (last 1h)
```

`persist()` is intentionally fire-and-forget. A SQLite write failure logs a WARN
and returns — it never delays or blocks the HTTP response to Claude Code.

### 3. HTTP Endpoints

Added to `src/services/api-server.js`:

```
GET /v1/traces
```

Query parameters:

| Param | Example | SQL |
|---|---|---|
| `error=true` | `?error=true` | `WHERE status = 'error'` |
| `provider` | `?provider=openai-custom` | `WHERE provider = 'openai-custom'` |
| `model` | `?model=gpt-4o` | `WHERE model LIKE '%gpt-4o%'` |
| `since` | `?since=1h` / `?since=30m` / `?since=24h` | `WHERE startedAt > (now - interval)` |
| `limit` | `?limit=20` | `LIMIT N` (default 50, max 200) |

Response shape:
```json
{
  "total": 42,
  "traces": [
    {
      "requestId": "abc-123",
      "model": "deepseek/deepseek-v4-flash:free",
      "provider": "openai-custom",
      "startedAt": 1748681952000,
      "totalRTTMs": 340,
      "status": "error",
      "errorCode": "503",
      "errorMsg": "No healthy provider found in pool for openai-custom",
      "fallbackCount": 0,
      "isDowngrade": false
    }
  ]
}
```

```
GET /v1/traces/:requestId
```

Returns a single full trace by `requestId`. The `requestId` is already present in
every proxy response as a header — so any failed request can be looked up directly
from the client-side error log.

```
GET /v1/traces/summary
```

Returns aggregate stats for the last hour: total requests, error rate, avg latency,
per-provider breakdown. Useful as a quick health dashboard call.

---

## Data Flow

```
REQUEST COMPLETES (existing path, single extension)
  finalizeTrace(status) in request-handler.js
    → trace.status = status             // existing
    → pushTrace(trace)                  // existing: in-memory ring buffer
    → TraceStore.persist(trace)         // NEW: SQLite write (async, fire-and-forget)
    → auto-prune runs in same txn

QUERY
  GET /v1/traces?error=true&since=1h
    → TraceStore.query({error: true, since: Date.now() - 3_600_000})
    → db SELECT WHERE status='error' AND startedAt > threshold
    → JSON array response (< 5ms for 500 rows on SQLite)
```

---

## Diagnostic Upgrade: Before vs After

**Before this spec — diagnosing "why did request X fail":**
1. Edit `configs/config.json` → set `PROMPT_LOG_MODE: "file"`
2. `./scripts/safe-restart.sh`
3. Reproduce the exact failure scenario
4. `ls -lt logs/prompt_log_*.log | head -5`
5. `cat logs/prompt_log_<timestamp>.log` and grep manually

**After this spec:**
```bash
curl -s "http://127.0.0.1:3000/v1/traces?error=true&since=1h" | jq .
# → Immediate answer: which model, which provider, what error, how many fallbacks
```

---

## Error Handling

- `TraceStore.persist()` failure: log WARN, return. Never blocks response.
- Auto-prune DELETE failure: log WARN, skip. Prune will succeed on the next insert.
- Invalid `since` param value: return 400 with `{"error": "invalid since value"}`.
- `requestId` not found in `GET /v1/traces/:id`: return 404.
- SQLite lock contention during burst: writes are serialized through the existing
  `db.js` connection — no new concurrency concern introduced.

---

## Testing

| Test | Type | What it verifies |
|---|---|---|
| Trace round-trip: persist → query → match | Unit | Serialization |
| `?error=true` filters correctly | Unit | Filter: status |
| `?provider=X` filters correctly | Unit | Filter: provider |
| `?since=1h` parses and filters correctly | Unit | Filter: time window |
| `?since=invalid` returns 400 | Unit | Input validation |
| Auto-prune: insert 600, assert max 500 remain | Unit | Prune logic |
| `persist()` failure does not throw | Unit | Fault isolation |
| Integration: make request → appears in /v1/traces | Integration | Full path |
| Integration: 0 regressions on existing 110 tests | Integration | Non-interference |

---

## Relationship to Existing Trace Infrastructure

The existing `trace-buffer.js` / `pushTrace()` in-memory ring buffer is **preserved
unchanged**. The `X-Proxy-Trace` and `X-Proxy-Trace-Final` response headers continue
working as before. TraceStore is additive: it appends a SQLite write alongside the
existing in-memory push — it does not replace it.

The `PROMPT_LOG_MODE: "file"` mechanism also remains. It logs the full request body
and response body (useful for converter debugging). The trace store logs metadata
only (timing, routing, status) — they serve different purposes.
