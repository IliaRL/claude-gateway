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
