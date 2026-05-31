# Model Catalog + Response Validator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Replace the 3-file model addition workflow with a single `configs/model-catalog.json` file while keeping all existing exports identical. (2) Add a response schema validator that auto-repairs malformed non-Claude model output before it reaches Claude Code.

**Architecture:** `provider-models.js` becomes a thin loader that reads `model-catalog.json` and re-exports the same public API (`PROVIDER_MODELS`, `getProviderModels`, `getAllProviderModels`, etc.). A pure-function `validateAndRepair(response, ctx)` in `src/utils/response-validator.js` is called at the end of each converter's non-streaming response method. The validator warns and auto-repairs; it never hard-blocks. The 110-test suite must pass with zero changes after both parts.

**Tech Stack:** Node.js ESM, Jest 29. No new runtime dependencies.

**Implementation order:** Part 1 (catalog) first — verify suite passes — then Part 2 (validator).

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `configs/model-catalog.json` | **Create** | Single source of truth for all model metadata |
| `src/providers/provider-models.js` | **Refactor** | Thin loader; identical public API, catalog-backed |
| `src/utils/response-validator.js` | **Create** | Pure validate-and-repair function |
| `src/converters/strategies/OpenAIConverter.js` | **Modify** | Call `validateAndRepair()` in non-streaming response path |
| `src/converters/strategies/GeminiConverter.js` | **Modify** | Call `validateAndRepair()` in non-streaming response path |
| `src/converters/strategies/ClaudeConverter.js` | **Modify** | Call `validateAndRepair()` in non-streaming response path |
| `tests/providers/model-catalog.test.js` | **Create** | Catalog integrity assertions |
| `tests/utils/response-validator.test.js` | **Create** | Validator unit tests |

---

## Part 1 — Model Catalog

### Task 1: Extract `configs/model-catalog.json`

**Files:**
- Create: `configs/model-catalog.json`

This task migrates all model entries from `src/providers/provider-models.js` into a structured JSON file. The catalog is the new source of truth.

- [ ] **Step 1: Read the full `PROVIDER_MODELS` constant**

```bash
cd AIClient2API && grep -A 5 'PROVIDER_MODELS' src/providers/provider-models.js | head -30
# Then read the full file to inventory all provider→model arrays:
wc -l src/providers/provider-models.js
```

- [ ] **Step 2: Read `MODEL_CONTEXT_WINDOWS` and `MODEL_MAX_OUTPUT_TOKENS`**

```bash
cd AIClient2API && grep -n 'MODEL_CONTEXT_WINDOWS\|MODEL_MAX_OUTPUT_TOKENS' src/converters/utils.js | head -10
# Then view those constants in utils.js to capture all values
```

- [ ] **Step 3: Create the catalog**

Create `configs/model-catalog.json`. The structure is an array of entry objects. Each entry maps exactly one model ID to its provider and metadata. Add ALL models currently in `PROVIDER_MODELS`, cross-referencing `MODEL_CONTEXT_WINDOWS` and `MODEL_MAX_OUTPUT_TOKENS` from `src/converters/utils.js`.

The schema for each entry:
```json
{
  "id": "claude-sonnet-4-5-20250929",
  "displayName": "Claude Sonnet 4.5",
  "provider": "claude-kiro-oauth",
  "contextWindow": 200000,
  "maxOutput": 64000,
  "fallbackTarget": "claude-haiku-4-5-20251001",
  "converterStrategy": "claude",
  "tags": ["claude", "flagship"]
}
```

Start with a representative sample to validate the schema, then add all remaining entries:

```json
[
  {
    "id": "claude-sonnet-4-5-20250929",
    "displayName": "Claude Sonnet 4.5",
    "provider": "claude-kiro-oauth",
    "contextWindow": 200000,
    "maxOutput": 64000,
    "fallbackTarget": "claude-haiku-4-5-20251001",
    "converterStrategy": "claude",
    "tags": ["claude"]
  },
  {
    "id": "claude-haiku-4-5-20251001",
    "displayName": "Claude Haiku 4.5",
    "provider": "claude-kiro-oauth",
    "contextWindow": 200000,
    "maxOutput": 32000,
    "fallbackTarget": "gemini-3-flash",
    "converterStrategy": "claude",
    "tags": ["claude", "fast"]
  },
  {
    "id": "gemini-3-flash",
    "displayName": "Gemini 3 Flash",
    "provider": "gemini-antigravity",
    "contextWindow": 1000000,
    "maxOutput": 65536,
    "fallbackTarget": null,
    "converterStrategy": "gemini",
    "tags": ["gemini", "fast"]
  }
]
```

Add all remaining models following this pattern. For models in `openai-custom`, use `converterStrategy: "openai"`. For `nvidia-nim` and `github-models`, also use `converterStrategy: "openai"` (they share the OpenAIConverter). For `gemini-cli-oauth`, use `converterStrategy: "gemini"`. For `openai-codex-oauth`, use `converterStrategy: "openai"`.

- [ ] **Step 4: Validate JSON**

```bash
node -e "
  const catalog = JSON.parse(require('fs').readFileSync('configs/model-catalog.json','utf8'));
  console.log('Entries:', catalog.length);
  const dupes = catalog.map(e=>e.id).filter((id,i,arr)=>arr.indexOf(id)!==i);
  if(dupes.length) console.error('DUPLICATE IDs:', dupes);
  else console.log('No duplicates — OK');
"
```
Expected: `Entries: N`, `No duplicates — OK`

- [ ] **Step 5: Commit**

```bash
git add configs/model-catalog.json
git commit -m "feat(catalog): add model-catalog.json — single source of truth for model metadata"
```

---

### Task 2: Write catalog integrity tests

**Files:**
- Create: `tests/providers/model-catalog.test.js`

- [ ] **Step 1: Write tests**

```javascript
// tests/providers/model-catalog.test.js
import { test, expect } from '@jest/globals';
import { readFileSync } from 'fs';

const catalog = JSON.parse(readFileSync('configs/model-catalog.json', 'utf8'));
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
  // Exception: gemini models use a different versioning scheme (no date suffix required)
  const nonVersionedClaude = catalog.filter(e =>
    e.provider.startsWith('claude') &&
    !/\d{8}/.test(e.id)   // Claude IDs must have a date stamp
  );
  expect(nonVersionedClaude.map(e => e.id)).toEqual([]);
});
```

- [ ] **Step 2: Run tests**

```bash
cd AIClient2API && pnpm test tests/providers/model-catalog.test.js
```
Expected: PASS. If any test fails, fix the catalog entry — don't weaken the test.

- [ ] **Step 3: Commit**

```bash
git add tests/providers/model-catalog.test.js
git commit -m "test(catalog): add integrity tests for model-catalog.json"
```

---

### Task 3: Refactor `provider-models.js` to be a thin catalog loader

**Files:**
- Modify: `src/providers/provider-models.js`

**Critical:** The public API must stay **byte-for-byte identical** from callers' perspective. Run `pnpm test` before and after — the suite must pass both times.

- [ ] **Step 1: Snapshot current exports as a contract**

```bash
cd AIClient2API && node -e "
  import('./src/providers/provider-models.js').then(m => {
    console.log('Exports:', Object.keys(m).join(', '));
    const models = m.getProviderModels('claude-kiro-oauth');
    console.log('claude-kiro-oauth models sample:', models.slice(0,3));
    console.log('PROVIDER_MODELS keys:', Object.keys(m.PROVIDER_MODELS).join(', '));
  });
"
```
Copy the output — this is your contract to verify after refactoring.

- [ ] **Step 2: Run current test suite as baseline**

```bash
cd AIClient2API && pnpm test
```
Expected: All tests pass. Record the count.

- [ ] **Step 3: Write the refactored provider-models.js**

**Important:** The existing `provider-models.js` contains many utility functions (`getCustomModelConfig`, `normalizeModelIds`, `getCustomModelActualProvider`, etc.) that are NOT catalog-driven and must be preserved verbatim. Only the `PROVIDER_MODELS` constant, `MODEL_CONTEXT_WINDOWS`, and `MODEL_MAX_OUTPUT_TOKENS` become catalog-derived. All other functions stay as-is.

At the top of `provider-models.js`, add the catalog import and derived constants BEFORE the existing `PROVIDER_MODELS` definition:

```javascript
// At the very top, after existing imports:
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const _require = createRequire(import.meta.url);
const _catalogPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../configs/model-catalog.json');
const _catalog = JSON.parse(_require('fs').readFileSync(_catalogPath, 'utf8'));

// Build lookup maps from catalog
const _byProvider = {};
for (const entry of _catalog) {
  if (!_byProvider[entry.provider]) _byProvider[entry.provider] = [];
  _byProvider[entry.provider].push(entry.id);
}
```

Then replace the hardcoded `PROVIDER_MODELS` constant with:

```javascript
export const PROVIDER_MODELS = Object.assign(Object.create(null), _byProvider);
```

For `MODEL_CONTEXT_WINDOWS` and `MODEL_MAX_OUTPUT_TOKENS` — these live in `src/converters/utils.js`, not `provider-models.js`. Check whether they're defined there:

```bash
grep -n 'MODEL_CONTEXT_WINDOWS\|MODEL_MAX_OUTPUT_TOKENS' src/converters/utils.js | head -5
grep -n 'MODEL_CONTEXT_WINDOWS\|MODEL_MAX_OUTPUT_TOKENS' src/providers/provider-models.js | head -5
```

If they ARE in `converters/utils.js`, update those definitions there using the same catalog pattern:

```javascript
// In src/converters/utils.js, replace the hardcoded objects with:
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const _catalog = JSON.parse(_require('fs').readFileSync(
  new URL('../../configs/model-catalog.json', import.meta.url).pathname, 'utf8'
));

export const MODEL_CONTEXT_WINDOWS = Object.fromEntries(
  _catalog.map(m => [m.id, m.contextWindow])
);
export const MODEL_MAX_OUTPUT_TOKENS = Object.fromEntries(
  _catalog.map(m => [m.id, m.maxOutput])
);
```

- [ ] **Step 4: Run test suite**

```bash
cd AIClient2API && pnpm test
```
Expected: **Same test count as Step 2, all passing.** If any test fails, the contract was broken — compare the snapshot from Step 1 to diagnose.

- [ ] **Step 5: Verify the catalog-derived exports match the old values**

```bash
cd AIClient2API && node -e "
  import('./src/providers/provider-models.js').then(m => {
    console.log('Exports:', Object.keys(m).join(', '));
    const models = m.getProviderModels('claude-kiro-oauth');
    console.log('claude-kiro-oauth models sample:', models.slice(0,3));
  });
"
```
Expected: Identical output to Step 1.

- [ ] **Step 6: Commit**

```bash
git add src/providers/provider-models.js src/converters/utils.js
git commit -m "refactor(models): provider-models.js reads from model-catalog.json"
```

---

## Part 2 — Response Validator

### Task 4: Build `response-validator.js`

**Files:**
- Create: `src/utils/response-validator.js`
- Create: `tests/utils/response-validator.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/utils/response-validator.test.js
import { test, expect } from '@jest/globals';
import { validateAndRepair } from '../../src/utils/response-validator.js';

const CTX = { requestId: 'test-req', provider: 'test', model: 'test-model' };

function validResponse(overrides = {}) {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

test('valid response passes through unmodified', () => {
  const r = validResponse();
  const original = JSON.parse(JSON.stringify(r));
  validateAndRepair(r, CTX);
  expect(r).toEqual(original);
});

test('null content is replaced with empty array', () => {
  const r = validResponse({ content: null });
  validateAndRepair(r, CTX);
  expect(r.content).toEqual([]);
});

test('undefined content is replaced with empty array', () => {
  const r = validResponse({ content: undefined });
  validateAndRepair(r, CTX);
  expect(r.content).toEqual([]);
});

test('string content is wrapped in a text block', () => {
  const r = validResponse({ content: 'Hello world' });
  validateAndRepair(r, CTX);
  expect(r.content).toEqual([{ type: 'text', text: 'Hello world' }]);
});

test('missing usage is injected as zeros', () => {
  const r = validResponse({ usage: undefined });
  validateAndRepair(r, CTX);
  expect(r.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
});

test('null usage is injected as zeros', () => {
  const r = validResponse({ usage: null });
  validateAndRepair(r, CTX);
  expect(r.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
});

test('NaN input_tokens is replaced with 0', () => {
  const r = validResponse({ usage: { input_tokens: NaN, output_tokens: 5 } });
  validateAndRepair(r, CTX);
  expect(r.usage.input_tokens).toBe(0);
});

test('OpenAI stop → end_turn', () => {
  const r = validResponse({ stop_reason: 'stop' });
  validateAndRepair(r, CTX);
  expect(r.stop_reason).toBe('end_turn');
});

test('OpenAI length → max_tokens', () => {
  const r = validResponse({ stop_reason: 'length' });
  validateAndRepair(r, CTX);
  expect(r.stop_reason).toBe('max_tokens');
});

test('OpenAI tool_calls → tool_use', () => {
  const r = validResponse({ stop_reason: 'tool_calls' });
  validateAndRepair(r, CTX);
  expect(r.stop_reason).toBe('tool_use');
});

test('unknown stop_reason falls back to end_turn', () => {
  const r = validResponse({ stop_reason: 'FINISH' });
  validateAndRepair(r, CTX);
  expect(r.stop_reason).toBe('end_turn');
});

test('null stop_reason is mapped to end_turn', () => {
  const r = validResponse({ stop_reason: null });
  validateAndRepair(r, CTX);
  expect(r.stop_reason).toBe('end_turn');
});

test('returns the same object reference (mutates in place)', () => {
  const r = validResponse();
  const result = validateAndRepair(r, CTX);
  expect(result).toBe(r);
});

test('null response is returned as-is without throwing', () => {
  expect(() => validateAndRepair(null, CTX)).not.toThrow();
  expect(validateAndRepair(null, CTX)).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd AIClient2API && pnpm test tests/utils/response-validator.test.js
```
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Implement `response-validator.js`**

```javascript
// src/utils/response-validator.js
import logger from './logger.js';

const VALID_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'tool_use', 'stop_sequence']);

// Map OpenAI finish_reason values to Anthropic stop_reason
const STOP_REASON_MAP = {
  'stop':           'end_turn',
  'length':         'max_tokens',
  'tool_calls':     'tool_use',
  'content_filter': 'end_turn',
  'function_call':  'tool_use',
};

/**
 * Validate an assembled Anthropic-format response object and auto-repair
 * known violations from non-Claude providers.
 *
 * Strategy: warn + repair, never hard-block. Claude Code sees a valid response
 * even if upstream sent something malformed. Every repair is logged with
 * enough context to diagnose the upstream provider.
 *
 * @param {object} response  Assembled Anthropic message response
 * @param {object} ctx       { requestId, provider, model }
 * @returns {object}         The same object (mutated), or the original if null/non-object
 */
export function validateAndRepair(response, ctx = {}) {
  if (!response || typeof response !== 'object') return response;

  const tag = `[ResponseValidator] requestId=${ctx.requestId ?? '?'} provider=${ctx.provider ?? '?'} model=${ctx.model ?? '?'}`;

  // ── 1. content ──────────────────────────────────────────────────────────────
  if (response.content === null || response.content === undefined) {
    logger.warn(`${tag} — content is ${response.content}: replaced with []`);
    response.content = [];
  } else if (typeof response.content === 'string') {
    logger.warn(`${tag} — content is a string: wrapped as [{type:"text",text:...}]`);
    response.content = [{ type: 'text', text: response.content }];
  } else if (Array.isArray(response.content)) {
    for (const block of response.content) {
      if (block && typeof block === 'object' && !block.type) {
        logger.error(`${tag} — content block missing type field: ${JSON.stringify(block).slice(0, 80)}`);
        // Cannot safely infer type — pass through but log as ERROR
      }
    }
  }

  // ── 2. stop_reason ───────────────────────────────────────────────────────────
  if (!VALID_STOP_REASONS.has(response.stop_reason)) {
    const repaired = STOP_REASON_MAP[response.stop_reason] ?? 'end_turn';
    logger.warn(`${tag} — stop_reason "${response.stop_reason}" → "${repaired}"`);
    response.stop_reason = repaired;
  }

  // ── 3. usage ─────────────────────────────────────────────────────────────────
  if (!response.usage || typeof response.usage !== 'object') {
    logger.warn(`${tag} — missing usage: injected {input_tokens:0, output_tokens:0}`);
    response.usage = { input_tokens: 0, output_tokens: 0 };
  } else {
    if (typeof response.usage.input_tokens !== 'number' || isNaN(response.usage.input_tokens)) {
      logger.warn(`${tag} — invalid input_tokens (${response.usage.input_tokens}): set to 0`);
      response.usage.input_tokens = 0;
    }
    if (typeof response.usage.output_tokens !== 'number' || isNaN(response.usage.output_tokens)) {
      logger.warn(`${tag} — invalid output_tokens (${response.usage.output_tokens}): set to 0`);
      response.usage.output_tokens = 0;
    }
  }

  return response;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd AIClient2API && pnpm test tests/utils/response-validator.test.js
```
Expected: PASS (all 14 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/response-validator.js tests/utils/response-validator.test.js
git commit -m "feat(validator): add response-validator — warn-and-repair Anthropic schema violations"
```

---

### Task 5: Integrate validator into converters

**Files:**
- Modify: `src/converters/strategies/OpenAIConverter.js`
- Modify: `src/converters/strategies/GeminiConverter.js`
- Modify: `src/converters/strategies/ClaudeConverter.js`

The validator runs on the **assembled non-streaming response** only — not on individual SSE chunks. The integration point is the `return` statement of the non-streaming conversion path in each converter's `convertResponse()` method.

- [ ] **Step 1: Find the integration point in OpenAIConverter**

```bash
cd AIClient2API && grep -n 'stop_reason\|return.*type.*message\|convertResponse' src/converters/strategies/OpenAIConverter.js | head -20
```
Expected: Shows `convertResponse(data, targetProtocol, model)` around line 83 and a non-streaming return with `stop_reason` around line 468.

- [ ] **Step 2: Add import to OpenAIConverter.js**

At the top of `src/converters/strategies/OpenAIConverter.js`, add:

```javascript
import { validateAndRepair } from '../../utils/response-validator.js';
```

- [ ] **Step 3: Inject validator in OpenAIConverter non-streaming return**

Find the non-streaming return path (the `return { type: 'message', ..., stop_reason: stopReason, usage: {...} }` block around line 462–475). Wrap the return value:

```javascript
// Before (example):
return {
  type: 'message',
  id: ...,
  role: 'assistant',
  content: contentBlocks,
  stop_reason: stopReason,
  usage: { input_tokens: ..., output_tokens: ... },
};

// After:
const _resp = {
  type: 'message',
  id: ...,
  role: 'assistant',
  content: contentBlocks,
  stop_reason: stopReason,
  usage: { input_tokens: ..., output_tokens: ... },
};
return validateAndRepair(_resp, { provider: 'openai', model: data?.model });
```

- [ ] **Step 4: Find and integrate in GeminiConverter.js**

```bash
cd AIClient2API && grep -n 'stop_reason\|convertResponse\|return.*type.*message' src/converters/strategies/GeminiConverter.js | head -20
```

Add the same import and wrap the non-streaming return in `GeminiConverter.js`:

```javascript
import { validateAndRepair } from '../../utils/response-validator.js';
// ... at the non-streaming return:
return validateAndRepair(_resp, { provider: 'gemini', model: data?.model });
```

- [ ] **Step 5: Find and integrate in ClaudeConverter.js**

```bash
cd AIClient2API && grep -n 'stop_reason\|convertResponse\|return.*type.*message' src/converters/strategies/ClaudeConverter.js | head -20
```

Add the same import and wrap the non-streaming return in `ClaudeConverter.js`. Note: ClaudeConverter may pass through valid Anthropic responses directly — the validator is a no-op on valid inputs, so adding it is always safe.

```javascript
import { validateAndRepair } from '../../utils/response-validator.js';
// ... at the non-streaming return:
return validateAndRepair(_resp, { provider: 'claude', model: data?.model });
```

- [ ] **Step 6: Run the full test suite — the critical regression check**

```bash
cd AIClient2API && pnpm test
```
Expected: **All 110+ tests pass.** If any test fails, the validator is mutating a valid response. Debug by checking the failing test's expected output against the validator's repair logic — most likely a `stop_reason` value that the test uses that is being remapped.

To debug a specific failure:
```bash
cd AIClient2API && pnpm test tests/<failing-file>.test.js -- --verbose 2>&1 | tail -30
```

- [ ] **Step 7: Commit**

```bash
git add src/converters/strategies/OpenAIConverter.js \
        src/converters/strategies/GeminiConverter.js \
        src/converters/strategies/ClaudeConverter.js
git commit -m "feat(validator): integrate validateAndRepair into all three converter strategies"
```

---

### Task 6: End-to-end verification

- [ ] **Run the full test suite one final time**

```bash
cd AIClient2API && pnpm test
```
Expected: 110+ PASS, 0 FAIL.

- [ ] **Verify adding a new model now requires only one file**

As a live test: add a single entry to `configs/model-catalog.json` for a hypothetical new model, then verify it appears in the model catalog without any JS changes:

```bash
# Add to configs/model-catalog.json:
# { "id": "test-model-v1", "provider": "gemini-antigravity", ... }
node -e "
  import('./src/providers/provider-models.js').then(m => {
    const models = m.getProviderModels('gemini-antigravity');
    console.log('Contains test-model-v1:', models.includes('test-model-v1'));
  });
"
```
Expected: `Contains test-model-v1: true`

Remove the test entry after verifying.

- [ ] **Verify the validator fires on a malformed response**

```bash
# Grep gateway log for any validator warnings from recent requests:
grep 'ResponseValidator' /tmp/aiclient.log | tail -10
```
Expected: Either no lines (all providers behaved) or WARN lines showing specific repairs — both are correct outcomes.

- [ ] **Verify the catalog integrity test suite passes**

```bash
cd AIClient2API && pnpm test tests/providers/model-catalog.test.js
```
Expected: PASS (all 7 tests)

- [ ] **Final commit tag**

```bash
git tag catalog-validator-complete
```
