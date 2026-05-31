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
