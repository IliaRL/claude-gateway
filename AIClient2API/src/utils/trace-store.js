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

  /** Close the database (call in tests / graceful shutdown). */
  close() {
    this._db.close();
  }
}

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

/** Singleton for use in production. */
export const traceStore = new TraceStore();
