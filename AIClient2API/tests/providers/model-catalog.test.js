import { test, expect } from '@jest/globals';
import { readFileSync, existsSync } from 'fs';

// Since Task 1 is running in parallel, the file might not exist yet when this test file is loaded.
// Use a placeholder if missing so the test file parses, but the tests will fail.
const catalogPath = 'configs/model-catalog.json';
const catalog = existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, 'utf8')) : [];
const ids = catalog.map(e => e.id);

const VALID_PROVIDERS = new Set([
  'claude-kiro-oauth', 'gemini-antigravity', 'gemini-cli-oauth',
  'openai-codex-oauth', 'openai-custom', 'nvidia-nim', 'github-models',
]);
const VALID_STRATEGIES = new Set(['claude', 'gemini', 'openai']);

test('catalog is non-empty', () => {
  expect(catalog.length).toBeGreaterThan(0);
});

test('every entry has required fields', () => {
  for (const entry of catalog) {
    expect(entry.id,         `${entry.id}: missing id`).toBeTruthy();
    expect(entry.provider,   `${entry.id}: missing provider`).toBeTruthy();
    expect(entry.contextWindow, `${entry.id}: missing contextWindow`).toBeGreaterThan(0);
    expect(entry.maxOutput,  `${entry.id}: missing maxOutput`).toBeGreaterThan(0);
    expect(entry.converterStrategy, `${entry.id}: missing converterStrategy`).toBeTruthy();
  }
});

test('all IDs are unique', () => {
  const seen = new Set();
  const dupes = [];
  for (const id of ids) {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  expect(dupes).toEqual([]);
});

test('all providers are known provider types', () => {
  const unknown = catalog.filter(e => !VALID_PROVIDERS.has(e.provider));
  expect(unknown.map(e => `${e.id} → ${e.provider}`)).toEqual([]);
});

test('all converterStrategy values are valid', () => {
  const invalid = catalog.filter(e => !VALID_STRATEGIES.has(e.converterStrategy));
  expect(invalid.map(e => `${e.id} → ${e.converterStrategy}`)).toEqual([]);
});

test('fallbackTarget references a valid catalog ID or null', () => {
  const idSet = new Set(ids);
  const broken = catalog.filter(e => e.fallbackTarget !== null && e.fallbackTarget !== undefined && !idSet.has(e.fallbackTarget));
  expect(broken.map(e => `${e.id} → fallbackTarget: ${e.fallbackTarget}`)).toEqual([]);
});

test('IDs are versioned (contain a date-like substring)', () => {
  // Rule 8 from CLAUDE.md: model IDs must be versioned (e.g. claude-sonnet-4-5-20250929)
  // Exception: gemini and openai models use different versioning schemes
  const nonVersionedClaude = catalog.filter(e =>
    e.provider.startsWith('claude') &&
    !/\d{8}/.test(e.id)   // Claude IDs must have a date stamp
  );
  expect(nonVersionedClaude.map(e => e.id)).toEqual([]);
});
