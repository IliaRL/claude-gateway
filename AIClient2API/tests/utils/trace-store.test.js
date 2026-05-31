import { test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TraceStore } from '../../src/utils/trace-store.js';

let store;
let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'traces-test-'));
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
  store.persist(makeTrace({ requestId: 'new', startedAt: now - 1_000 }));        // 1s ago - include
  store.persist(makeTrace({ requestId: 'old', startedAt: now - 3_700_000 }));    // >1h ago - exclude
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
