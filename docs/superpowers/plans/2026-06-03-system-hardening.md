# AIClient2API System Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 production gaps in AIClient2API — config regression, dead providers, missing shell export, dead code, leaking test timer, unverified header pass-through, zero ProviderPoolManager tests, and accumulated restart delay — leaving the system fully hardened and green.

**Architecture:** Phase-gated. Four sequential phases. Each phase ends with a passing `pnpm test` gate before the next starts. All code changes use TDD (failing test first, implement, verify green).

**Tech Stack:** Node.js ESM, Jest 29, pnpm, zsh (for shell fix)

---

## Phase 1 — Config & Shell Fixes

> No code changes. Pure file edits. Gate: full test suite still green.

### Task 1: Fix SYSTEM_PROMPT_FILE_PATH Regression

**Files:**
- Modify: `AIClient2API/configs/config.json:6`

- [ ] **Step 1: Confirm current broken state**

  ```bash
  grep SYSTEM_PROMPT_FILE_PATH /Users/ilialiston/MASTER-C/AIClient2API/configs/config.json
  ```

  Expected output: a non-empty absolute path like `/Users/ilialiston/MASTER-C/AIClient2API/configs/input_system_prompt.txt`

- [ ] **Step 2: Edit config.json — set SYSTEM_PROMPT_FILE_PATH to empty string**

  In `AIClient2API/configs/config.json`, change line 6:

  ```json
  "SYSTEM_PROMPT_FILE_PATH": "",
  ```

  Full context around the edit (lines 5-8 after change):
  ```json
    "MODEL_PROVIDER": "gemini-antigravity,gemini-cli-oauth,claude-kiro-oauth,openai-codex-oauth,openai-custom",
    "SYSTEM_PROMPT_FILE_PATH": "",
    "SYSTEM_PROMPT_MODE": "append",
    "SYSTEM_PROMPT_REPLACEMENTS": [],
  ```

- [ ] **Step 3: Verify the file parses as valid JSON**

  ```bash
  node -e "JSON.parse(require('fs').readFileSync('configs/config.json','utf8')); console.log('OK')"
  ```
  
  Run from: `AIClient2API/`  
  Expected: `OK`

- [ ] **Step 4: Run gate test to confirm nothing broke**

  ```bash
  cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test --silent 2>&1 | tail -5
  ```

  Expected:
  ```
  Tests:       156 passed, 156 total
  Test Suites: 21 passed, 21 total
  ```

- [ ] **Step 5: Commit**

  ```bash
  cd /Users/ilialiston/MASTER-C
  git add AIClient2API/configs/config.json
  git commit -m "fix(config): clear SYSTEM_PROMPT_FILE_PATH to prevent Kiro double-override (Issue 8)"
  ```

---

### Task 2: Disable Dead Providers in Pool Config

**Files:**
- Modify: `AIClient2API/configs/provider_pools.json` (via node script — NOT direct edit)

- [ ] **Step 1: Check current provider account state**

  ```bash
  node -e "
  const p = JSON.parse(require('fs').readFileSync('configs/provider_pools.json','utf8'));
  const dead = ['github-models','openai-custom'];
  dead.forEach(name => {
    const prov = p.providers.find(x => x.type === name);
    if (prov) console.log(name, JSON.stringify(prov.accounts?.map(a => ({id:a.id,enabled:a.enabled}))));
  });
  " 
  ```
  
  Run from: `AIClient2API/`  
  Expected: output showing accounts with `"enabled": true` (or field absent) for both dead providers.

- [ ] **Step 2: Write a one-shot disable script using the project's atomic write pattern**

  Create temporary script `scripts/disable-dead-providers.mjs`:

  ```javascript
  // scripts/disable-dead-providers.mjs
  // One-shot: disable all accounts for github-models and openai-custom
  // Uses same atomic write pattern as the codebase.
  import { readFileSync, writeFileSync, renameSync } from 'fs';
  import { randomBytes } from 'crypto';
  import path from 'path';
  import { fileURLToPath } from 'url';

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const POOLS_PATH = path.join(__dirname, '../configs/provider_pools.json');
  const DEAD_PROVIDERS = ['github-models', 'openai-custom'];

  const pools = JSON.parse(readFileSync(POOLS_PATH, 'utf8'));
  let changed = 0;

  for (const provider of (pools.providers || [])) {
      if (DEAD_PROVIDERS.includes(provider.type)) {
          for (const account of (provider.accounts || [])) {
              if (account.enabled !== false) {
                  account.enabled = false;
                  changed++;
                  console.log(`Disabled: ${provider.type} / ${account.id}`);
              }
          }
      }
  }

  if (changed === 0) {
      console.log('No accounts changed (already disabled or not found).');
      process.exit(0);
  }

  // Atomic write: write to tmp, rename
  const tmp = POOLS_PATH + '.tmp.' + randomBytes(4).toString('hex');
  writeFileSync(tmp, JSON.stringify(pools, null, 2), 'utf8');
  renameSync(tmp, POOLS_PATH);
  console.log(`Done. Disabled ${changed} accounts.`);
  ```

- [ ] **Step 3: Run the script**

  ```bash
  cd /Users/ilialiston/MASTER-C/AIClient2API && node scripts/disable-dead-providers.mjs
  ```

  Expected output: lines like `Disabled: github-models / gh-account-1` for each account.

- [ ] **Step 4: Verify the change**

  ```bash
  node -e "
  const p = JSON.parse(require('fs').readFileSync('configs/provider_pools.json','utf8'));
  ['github-models','openai-custom'].forEach(name => {
    const prov = p.providers.find(x => x.type === name);
    if (prov) console.log(name, prov.accounts.every(a => a.enabled === false) ? 'ALL DISABLED ✅' : 'STILL ENABLED ❌');
  });
  "
  ```

  Expected: `github-models ALL DISABLED ✅` and `openai-custom ALL DISABLED ✅`

- [ ] **Step 5: Commit (include the helper script so it can be re-run)**

  ```bash
  cd /Users/ilialiston/MASTER-C
  git add AIClient2API/configs/provider_pools.json AIClient2API/scripts/disable-dead-providers.mjs
  git commit -m "fix(providers): disable dead github-models and openai-custom accounts (Issue 7)"
  ```

---

### Task 3: Add ENABLE_TOOL_SEARCH Global Shell Export

**Files:**
- Modify: `~/dotfiles/zsh/zshrc`

- [ ] **Step 1: Check current state**

  ```bash
  grep -n 'ENABLE_TOOL_SEARCH' ~/dotfiles/zsh/zshrc
  ```

  Expected: either no output (missing) or output showing it's only inline at a `claude-pick` call site.

- [ ] **Step 2: Add global export**

  Find the block where other `AICLIENT_*` / Claude env vars are globally exported. Add immediately after that block:

  ```bash
  export ENABLE_TOOL_SEARCH=true
  ```

  If no such block exists, add it near the top of the file with a comment:
  ```bash
  # Claude Code gateway env vars (must be global exports for subagent inheritance)
  export ENABLE_TOOL_SEARCH=true
  export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
  export CLAUDE_CODE_SKIP_BEDROCK_AUTH=1
  ```

  (Only add the lines that are NOT already present globally.)

- [ ] **Step 3: Source and verify**

  ```bash
  source ~/dotfiles/zsh/zshrc && echo "ENABLE_TOOL_SEARCH=$ENABLE_TOOL_SEARCH"
  ```

  Expected: `ENABLE_TOOL_SEARCH=true`

- [ ] **Step 4: Commit (dotfiles repo)**

  ```bash
  cd ~/dotfiles
  git add zsh/zshrc
  git commit -m "fix(claude): add ENABLE_TOOL_SEARCH as global export for subagent tool access (Issue 11a)"
  ```

---

**Phase 1 Gate:**

```bash
cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test --silent 2>&1 | tail -5
```
Expected:
```
Tests:       156 passed, 156 total
Test Suites: 21 passed, 21 total
```

---

## Phase 2 — Dead Code & Leaking Timer

### Task 4: Remove Dead apiService Block from request-handler.js

**Files:**
- Modify: `AIClient2API/src/handlers/request-handler.js:411-424`

- [ ] **Step 1: View the current dead code block to confirm context**

  Lines 411–424 of `src/handlers/request-handler.js`:

  ```javascript
  // 获取或选择 API Service 实例
  let apiService;
  // try {
  //     apiService = await getApiService(currentConfig);
  // } catch (error) {
  //     handleError(res, { statusCode: 500, message: `Failed to get API service: ${error.message}` }, currentConfig.MODEL_PROVIDER);
  //     const poolManager = getProviderPoolManager();
  //     if (poolManager) {
  //         poolManager.markProviderUnhealthy(currentConfig.MODEL_PROVIDER, {
  //             uuid: currentConfig.uuid
  //         });
  //     }
  //     return;
  // }
  ```

  Note: `apiService` (declared but never assigned) is passed to `handleAPIRequests` on line 428. The function ignores this `undefined` argument and re-fetches internally.

- [ ] **Step 2: Delete lines 411–424 entirely**

  Remove the comment header, the `let apiService;` declaration, and the entire commented-out try/catch block. The line after the deletion should be the blank line before the `try {` on what is currently line 426.

  After deletion, the surrounding code should look like:
  ```javascript
                      }
                  }

                  try {
                      // Handle API requests
                      const apiHandled = await handleAPIRequests(method, path, req, res, currentConfig, apiService, providerPoolManager, PROMPT_LOG_FILENAME);
  ```

  Wait — `apiService` is still passed on line 428. Now that we removed the declaration, update that call too:

  ```javascript
                      const apiHandled = await handleAPIRequests(method, path, req, res, currentConfig, undefined, providerPoolManager, PROMPT_LOG_FILENAME);
  ```

  (Pass `undefined` explicitly to keep the argument positions stable without breaking the function signature.)

- [ ] **Step 3: Run the test suite to confirm nothing broke**

  ```bash
  cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test --silent 2>&1 | tail -5
  ```

  Expected: 156 tests pass.

- [ ] **Step 4: Commit**

  ```bash
  cd /Users/ilialiston/MASTER-C
  git add AIClient2API/src/handlers/request-handler.js
  git commit -m "refactor: remove dead apiService comment block from request-handler.js"
  ```

---

### Task 5: Fix Leaking Timer in Test Suite

**Files:**
- Read: Jest test output to identify leaking file
- Modify: whichever file is identified

- [ ] **Step 1: Run with --detectOpenHandles to identify the leaking module**

  ```bash
  cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test -- --detectOpenHandles 2>&1 | grep -A 20 'open handle'
  ```

  This will print a stack trace pointing to the file and line that created the leaking handle.

- [ ] **Step 2: Identify the fix**

  Typical patterns and fixes:

  **Pattern A — A `setInterval` in a module (e.g., health-check scheduler):**
  ```javascript
  // Find: const handle = setInterval(fn, interval);
  // Fix: handle.unref(); // immediately after creation — does not affect production
  ```

  **Pattern B — Test file not cleaning up in afterAll:**
  ```javascript
  // Add to the offending test file:
  afterAll(() => {
      clearInterval(leakingHandle);
      // or: jest.clearAllTimers();
  });
  ```

  **Pattern C — Server not closing in test teardown:**
  ```javascript
  // Add to the offending test file:
  afterAll(async () => {
      await new Promise(resolve => server.close(resolve));
  });
  ```

- [ ] **Step 3: Apply the fix to the identified file**

  (Code will depend on the output of Step 1 — follow the pattern above that matches the handle type shown in the stack trace.)

- [ ] **Step 4: Verify the fix**

  ```bash
  cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test 2>&1 | grep -E 'Tests:|Suites:|worker process'
  ```

  Expected:
  ```
  Test Suites: 21 passed, 21 total
  Tests:       156 passed, 156 total
  ```
  No `"worker process has failed to exit gracefully"` line.

- [ ] **Step 5: Commit**

  ```bash
  cd /Users/ilialiston/MASTER-C
  git add AIClient2API/<path-to-fixed-file>
  git commit -m "fix(tests): resolve leaking timer handle — call .unref() on health-check interval"
  ```

---

**Phase 2 Gate:**

```bash
cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test 2>&1 | grep -E 'Tests:|worker process'
```
Expected: `156 passed` and NO leaking-handle warning.

---

## Phase 3 — Protocol Compliance: Header Pass-Through + CORS

### Task 6: Write Failing Tests for anthropic-beta/version Header Forwarding

**Files:**
- Create: `AIClient2API/tests/unit/header-passthrough.test.js`

- [ ] **Step 1: Understand the existing adapter import pattern**

  Look at an existing adapter test for import reference:
  ```bash
  head -20 /Users/ilialiston/MASTER-C/AIClient2API/tests/unit/kiro-thinking-prefix.test.js
  ```

- [ ] **Step 2: Write the failing test file**

  Create `AIClient2API/tests/unit/header-passthrough.test.js`:

  ```javascript
  /**
   * Tests: anthropic-beta and anthropic-version header pass-through behavior.
   *
   * Rule (from docs/ANTHROPIC_GATEWAY_SPEC.md):
   *   - Anthropic endpoints (Kiro): MUST forward anthropic-beta and anthropic-version verbatim
   *   - Non-Anthropic providers: MUST strip both headers from outbound requests
   */
  import { jest } from '@jest/globals';

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * Capture headers that a provider adapter would send to the upstream.
   * Returns the headers object assembled by the adapter for the given inbound headers.
   */
  async function captureOutboundHeaders(adapterFactory, inboundHeaders) {
      let capturedHeaders = null;
      const mockFetch = jest.fn(async (url, options) => {
          capturedHeaders = options?.headers ?? {};
          return { ok: true, status: 200, body: null, headers: new Headers() };
      });
      
      // Each test imports its adapter and replaces its HTTP client with mockFetch.
      // The adapter factory receives the mock and returns { adapter, buildHeaders }.
      const adapter = await adapterFactory(mockFetch);
      await adapter.sendRequest({ headers: inboundHeaders }).catch(() => {});
      return capturedHeaders;
  }

  // ── Kiro (Anthropic endpoint) — MUST forward ──────────────────────────────────

  describe('Kiro adapter — anthropic-beta forwarding', () => {
      test('forwards anthropic-beta header verbatim to upstream', async () => {
          const { getKiroOutboundHeaders } = await import('./helpers/kiro-header-helper.js');
          const outbound = await getKiroOutboundHeaders({
              'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15',
              'anthropic-version': '2023-06-01'
          });
          expect(outbound['anthropic-beta']).toBe('max-tokens-3-5-sonnet-2024-07-15');
      });

      test('forwards anthropic-version header verbatim to upstream', async () => {
          const { getKiroOutboundHeaders } = await import('./helpers/kiro-header-helper.js');
          const outbound = await getKiroOutboundHeaders({
              'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15',
              'anthropic-version': '2023-06-01'
          });
          expect(outbound['anthropic-version']).toBe('2023-06-01');
      });

      test('does not inject phantom anthropic-beta when not in inbound request', async () => {
          const { getKiroOutboundHeaders } = await import('./helpers/kiro-header-helper.js');
          const outbound = await getKiroOutboundHeaders({});
          expect(outbound['anthropic-beta']).toBeUndefined();
      });
  });

  // ── Gemini adapter — MUST strip ───────────────────────────────────────────────

  describe('Gemini adapter — anthropic-beta stripped', () => {
      test('strips anthropic-beta from outbound request', async () => {
          const { getGeminiOutboundHeaders } = await import('./helpers/gemini-header-helper.js');
          const outbound = await getGeminiOutboundHeaders({
              'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15',
              'anthropic-version': '2023-06-01'
          });
          expect(outbound['anthropic-beta']).toBeUndefined();
      });

      test('strips anthropic-version from outbound request', async () => {
          const { getGeminiOutboundHeaders } = await import('./helpers/gemini-header-helper.js');
          const outbound = await getGeminiOutboundHeaders({
              'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15',
              'anthropic-version': '2023-06-01'
          });
          expect(outbound['anthropic-version']).toBeUndefined();
      });
  });

  // ── OpenAI / NVIDIA adapters — MUST strip ─────────────────────────────────────

  describe('OpenAI-family adapters — anthropic headers stripped', () => {
      test('openai-custom strips anthropic-beta', async () => {
          const { getOpenAICustomOutboundHeaders } = await import('./helpers/openai-custom-header-helper.js');
          const outbound = await getOpenAICustomOutboundHeaders({
              'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15'
          });
          expect(outbound['anthropic-beta']).toBeUndefined();
      });

      test('nvidia-nim strips anthropic-beta', async () => {
          const { getNvidiaNimOutboundHeaders } = await import('./helpers/nvidia-nim-header-helper.js');
          const outbound = await getNvidiaNimOutboundHeaders({
              'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15'
          });
          expect(outbound['anthropic-beta']).toBeUndefined();
      });
  });
  ```

- [ ] **Step 3: Run tests to confirm they all FAIL (expected at this stage)**

  ```bash
  cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test tests/unit/header-passthrough.test.js 2>&1 | tail -20
  ```

  Expected: all 6 tests FAIL (helper files don't exist yet).

---

### Task 7: Audit Adapter Header Assembly

- [ ] **Step 1: Audit the Kiro adapter for header assembly**

  ```bash
  grep -n 'anthropic-beta\|anthropic-version\|headers' \
    /Users/ilialiston/MASTER-C/AIClient2API/src/providers/adapters/claude-kiro.js | head -40
  ```

  Look for where outbound `headers` object is built for the upstream Anthropic API call. Note the exact lines.

- [ ] **Step 2: Audit the Gemini adapter**

  ```bash
  grep -n 'anthropic-beta\|anthropic-version\|headers' \
    /Users/ilialiston/MASTER-C/AIClient2API/src/providers/adapters/gemini-antigravity.js | head -30
  ```

- [ ] **Step 3: Audit request-handler.js for header extraction**

  ```bash
  grep -n 'anthropic-beta\|anthropic-version\|req\.headers' \
    /Users/ilialiston/MASTER-C/AIClient2API/src/handlers/request-handler.js | head -20
  ```

  Determine: are these headers extracted from `req.headers` and passed downstream, or are they silently dropped?

- [ ] **Step 4: Document findings**

  After the three audits above, write a brief note:
  - Does `request-handler.js` extract and pass `anthropic-beta`/`anthropic-version` to the pool manager / adapter?
  - Does Kiro's adapter include them in its outbound headers?
  - Does Gemini's adapter explicitly exclude them, or just happen not to include them?

---

### Task 8: Create Header Helper Modules

**Files:**
- Create: `AIClient2API/tests/unit/helpers/kiro-header-helper.js`
- Create: `AIClient2API/tests/unit/helpers/gemini-header-helper.js`
- Create: `AIClient2API/tests/unit/helpers/openai-custom-header-helper.js`
- Create: `AIClient2API/tests/unit/helpers/nvidia-nim-header-helper.js`

- [ ] **Step 1: Create kiro-header-helper.js**

  Based on the audit in Task 7, create a helper that:
  1. Imports the Kiro adapter module (or the function that builds its outbound headers)
  2. Mocks the underlying HTTP call (axios/fetch) with `jest.fn()`
  3. Calls the adapter with the given inbound headers
  4. Returns the headers that were passed to the mock

  Example pattern (adjust based on actual Kiro adapter structure from Task 7 audit):

  ```javascript
  // tests/unit/helpers/kiro-header-helper.js
  import { jest } from '@jest/globals';

  export async function getKiroOutboundHeaders(inboundHeaders) {
      // Replace with the actual import path found in Task 7 audit
      const module = await import('../../../src/providers/adapters/claude-kiro.js');
      
      let capturedHeaders = {};
      const origAxios = module.default._httpClient; // adjust to actual property
      
      // Mock the HTTP client
      jest.spyOn(module.default, '_sendRequest').mockImplementationOnce(async (url, options) => {
          capturedHeaders = options.headers ?? {};
          return { status: 200, data: {} };
      });
      
      // Trigger a request through the adapter with the given inbound headers
      await module.default.chat({ messages: [] }, { headers: inboundHeaders }).catch(() => {});
      
      return capturedHeaders;
  }
  ```

  > **Note:** The exact API will depend on Task 7 audit output. Adapt the mock target to match the actual HTTP client property/method used by each adapter. The pattern is: spy → trigger → capture → return.

- [ ] **Step 2: Create gemini-header-helper.js**

  Same pattern as Step 1, targeting `src/providers/adapters/gemini-antigravity.js`.

- [ ] **Step 3: Create openai-custom-header-helper.js**

  Same pattern, targeting `src/providers/adapters/openai-custom.js`.

- [ ] **Step 4: Create nvidia-nim-header-helper.js**

  Same pattern, targeting `src/providers/adapters/nvidia-nim.js`.

---

### Task 9: Fix Non-Compliant Adapters

- [ ] **Step 1: Fix Kiro adapter if it does NOT forward anthropic-beta/version**

  If the audit shows Kiro is NOT forwarding these headers, find the outbound headers object and add:

  ```javascript
  // In claude-kiro.js, where outbound headers are assembled:
  const outboundHeaders = {
      // ... existing headers ...
  };

  // Forward Anthropic protocol headers verbatim from inbound request
  if (inboundHeaders['anthropic-beta']) {
      outboundHeaders['anthropic-beta'] = inboundHeaders['anthropic-beta'];
  }
  if (inboundHeaders['anthropic-version']) {
      outboundHeaders['anthropic-version'] = inboundHeaders['anthropic-version'];
  }
  ```

  (If Kiro already forwards them, no change needed — skip.)

- [ ] **Step 2: Fix non-Anthropic adapters if they DO pass through anthropic headers**

  For any adapter (Gemini, OpenAI, NVIDIA) that is passing `anthropic-beta`/`anthropic-version` to the upstream:

  ```javascript
  // Remove or never set these headers in the outbound object:
  delete outboundHeaders['anthropic-beta'];
  delete outboundHeaders['anthropic-version'];
  ```

  (If an adapter builds headers from scratch without copying inbound, it already strips them. Only fix adapters that blindly copy all inbound headers.)

- [ ] **Step 3: Run the header-passthrough tests — they should now PASS**

  ```bash
  cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test tests/unit/header-passthrough.test.js --verbose 2>&1 | tail -20
  ```

  Expected: all 6 tests PASS.

- [ ] **Step 4: Run full suite to confirm no regressions**

  ```bash
  pnpm test --silent 2>&1 | tail -5
  ```

  Expected: all tests pass (156 + 6 new = 162+).

- [ ] **Step 5: Commit**

  ```bash
  cd /Users/ilialiston/MASTER-C
  git add AIClient2API/tests/unit/header-passthrough.test.js \
           AIClient2API/tests/unit/helpers/ \
           AIClient2API/src/providers/adapters/
  git commit -m "fix(protocol): enforce anthropic-beta/version header forwarding per Claude Code spec (Issue 11b)"
  ```

---

### Task 10: Tighten Master Server CORS

**Files:**
- Modify: `AIClient2API/src/core/master.js:~265`

- [ ] **Step 1: Find the CORS header**

  ```bash
  grep -n 'Access-Control-Allow-Origin' /Users/ilialiston/MASTER-C/AIClient2API/src/core/master.js
  ```

- [ ] **Step 2: Replace wildcard with localhost-only**

  Change every occurrence of:
  ```javascript
  res.setHeader('Access-Control-Allow-Origin', '*');
  ```
  To:
  ```javascript
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
  ```

- [ ] **Step 3: Run full test suite**

  ```bash
  cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test --silent 2>&1 | tail -5
  ```

  Expected: all tests still pass.

- [ ] **Step 4: Commit**

  ```bash
  cd /Users/ilialiston/MASTER-C
  git add AIClient2API/src/core/master.js
  git commit -m "fix(security): lock master management server CORS from wildcard to 127.0.0.1"
  ```

---

**Phase 3 Gate:**

```bash
cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test 2>&1 | grep -E 'Tests:|Suites:|worker process'
```
Expected: all suites pass, no leaking-handle warning.

---

## Phase 4 — ProviderPoolManager Unit Tests + restartCount Reset

### Task 11: Write ProviderPoolManager Unit Tests (9 behaviors)

**Files:**
- Create: `AIClient2API/tests/unit/provider-pool-manager.test.js`

- [ ] **Step 1: Read the ProviderPoolManager constructor to understand instantiation**

  ```bash
  head -80 /Users/ilialiston/MASTER-C/AIClient2API/src/providers/provider-pool-manager.js
  ```

  Note: what arguments does the constructor take? How is initial pool state set? Is there a reset method?

- [ ] **Step 2: Write the test file**

  Create `AIClient2API/tests/unit/provider-pool-manager.test.js`:

  ```javascript
  /**
   * ProviderPoolManager unit tests — 9 critical behaviors.
   * Uses fake timers to avoid real delays in cooldown tests.
   */
  import { jest } from '@jest/globals';

  // ─────────────────────────────────────────────────────────────────────────────
  // Shared test factory — builds a minimal ProviderPoolManager with mocked config
  // ─────────────────────────────────────────────────────────────────────────────

  async function makePool(overrides = {}) {
      // Dynamic import avoids top-level module caching
      const { ProviderPoolManager } = await import('../../src/providers/provider-pool-manager.js');
      const config = {
          RATE_LIMIT_COOLDOWN_MS: 30000,
          RATE_LIMIT_COOLDOWN_JITTER_MS: 0,
          RATE_LIMIT_COOLDOWN_MAX_MS: 300000,
          CREDENTIAL_SWITCH_MAX_RETRIES: 5,
          REFRESH_CONCURRENCY_PER_PROVIDER: 2,
          providerFallbackChain: {
              'provider-a': ['provider-b'],
              'provider-b': ['provider-a']
          },
          modelFallbackMapping: {
              'model-high': { targetModel: 'model-low', targetProviderType: 'provider-a' },
              'model-low': { targetModel: 'model-floor', targetProviderType: 'provider-a' }
          },
          ...overrides
      };
      return new ProviderPoolManager(config);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 1: Provider selection picks healthy account, skips cooldown accounts
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Provider selection', () => {
      test('selects healthy account and skips account on cooldown', async () => {
          const pool = await makePool();
          
          // Seed pool with two accounts: one healthy, one on cooldown
          pool._seedPool('provider-a', [
              { id: 'acc-1', token: 'tok-1', onCooldown: false },
              { id: 'acc-2', token: 'tok-2', onCooldown: true }
          ]);
          
          const selected = await pool._doSelectProvider('provider-a', 'model-high');
          expect(selected.id).toBe('acc-1');
          expect(selected.id).not.toBe('acc-2');
      });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2: L1 vertical fallback — exhausts all accounts before failing
  // ─────────────────────────────────────────────────────────────────────────────

  describe('L1 vertical fallback', () => {
      test('throws after all accounts on provider are exhausted', async () => {
          const pool = await makePool();
          pool._seedPool('provider-a', [
              { id: 'acc-1', token: 'tok-1', onCooldown: true },
              { id: 'acc-2', token: 'tok-2', onCooldown: true }
          ]);
          
          await expect(pool._doSelectProvider('provider-a', 'model-high'))
              .rejects.toThrow(/exhausted|no.*(available|healthy)/i);
      });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3: L2 horizontal fallback — tries next provider in chain
  // ─────────────────────────────────────────────────────────────────────────────

  describe('L2 horizontal fallback', () => {
      test('falls back to secondary provider when primary is exhausted', async () => {
          const pool = await makePool();
          // Primary exhausted
          pool._seedPool('provider-a', [{ id: 'acc-1', onCooldown: true }]);
          // Secondary healthy
          pool._seedPool('provider-b', [{ id: 'acc-2', token: 'tok-2', onCooldown: false }]);

          // selectProvider triggers L1 then L2
          const selected = await pool.selectProvider('provider-a', 'model-high');
          expect(selected.providerType).toBe('provider-b');
          expect(selected.account.id).toBe('acc-2');
      });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4: L3 tiered downgrade — falls back to lower model
  // ─────────────────────────────────────────────────────────────────────────────

  describe('L3 tiered downgrade', () => {
      test('downgrades model when all providers for requested model are exhausted', async () => {
          const pool = await makePool();
          // Exhaust provider-a and provider-b for model-high
          pool._seedPool('provider-a', [{ id: 'acc-1', onCooldown: true }]);
          pool._seedPool('provider-b', [{ id: 'acc-2', onCooldown: true }]);
          // model-low is available on provider-a
          pool._seedPool('provider-a', [{ id: 'acc-3', token: 'tok-3', onCooldown: false }], 'model-low');

          const selected = await pool.selectProvider('provider-a', 'model-high');
          expect(selected.model).toBe('model-low');
      });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5: L3 cycle guard — no infinite loop on circular mapping
  // ─────────────────────────────────────────────────────────────────────────────

  describe('L3 cycle guard', () => {
      test('throws (not infinite loop) on circular modelFallbackMapping', async () => {
          const pool = await makePool({
              modelFallbackMapping: {
                  'model-a': { targetModel: 'model-b', targetProviderType: 'provider-a' },
                  'model-b': { targetModel: 'model-a', targetProviderType: 'provider-a' }
              }
          });
          pool._seedPool('provider-a', [{ id: 'acc-1', onCooldown: true }]);

          await expect(pool.selectProvider('provider-a', 'model-a'))
              .rejects.toThrow(/cycle|loop|visited|already.*(tried|attempted)/i);
      }, 5000); // 5 second timeout guard against infinite loop
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6: Cross-family downgrade warning
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Cross-family downgrade warning', () => {
      test('logs a warning when downgrading across model families (claude → gemini)', async () => {
          const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
          const pool = await makePool({
              modelFallbackMapping: {
                  'claude-opus': { targetModel: 'gemini-flash', targetProviderType: 'provider-a' }
              }
          });
          pool._seedPool('provider-a', [{ id: 'acc-1', onCooldown: true }]);
          pool._seedPool('provider-a', [{ id: 'acc-2', token: 'tok-2', onCooldown: false }], 'gemini-flash');

          await pool.selectProvider('provider-a', 'claude-opus').catch(() => {});
          
          expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/cross.family|family.*downgrade/i));
          warnSpy.mockRestore();
      });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 7: Cooldown manager — 429 triggers cooldown, clears after timeout
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Cooldown manager', () => {
      beforeEach(() => jest.useFakeTimers());
      afterEach(() => jest.useRealTimers());

      test('account enters cooldown on 429 and self-clears after RATE_LIMIT_COOLDOWN_MS', async () => {
          const pool = await makePool({ RATE_LIMIT_COOLDOWN_MS: 5000, RATE_LIMIT_COOLDOWN_JITTER_MS: 0 });
          pool._seedPool('provider-a', [{ id: 'acc-1', token: 'tok-1', onCooldown: false }]);

          // Simulate 429 by calling the cooldown trigger
          pool._triggerCooldown('provider-a', 'acc-1');

          // Should be on cooldown now
          expect(pool._isOnCooldown('provider-a', 'acc-1')).toBe(true);

          // Fast-forward past cooldown window
          jest.advanceTimersByTime(6000);

          // Should have cleared
          expect(pool._isOnCooldown('provider-a', 'acc-1')).toBe(false);
      });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 8: Cockpit penalty scoring pre-filters exhausted accounts
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Cockpit penalty scoring', () => {
      test('skips account with 100% quota usage in selection', async () => {
          const pool = await makePool();
          pool._seedPool('provider-a', [
              { id: 'acc-1', token: 'tok-1', onCooldown: false, quotaUsagePct: 100 },
              { id: 'acc-2', token: 'tok-2', onCooldown: false, quotaUsagePct: 50 }
          ]);

          // Inject Cockpit score for acc-1 as fully exhausted
          pool._setCockpitScore('provider-a', 'acc-1', { exhausted: true, penaltyScore: Infinity });

          const selected = await pool._doSelectProvider('provider-a', 'model-high');
          expect(selected.id).toBe('acc-2');
      });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 9: Refresh queue concurrency cap
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Refresh queue concurrency', () => {
      test('never exceeds REFRESH_CONCURRENCY_PER_PROVIDER concurrent refreshes', async () => {
          const pool = await makePool({ REFRESH_CONCURRENCY_PER_PROVIDER: 2 });
          let concurrent = 0;
          let maxObserved = 0;

          // Mock the adapter refresh to be slow and track concurrency
          pool._mockAdapterRefresh('provider-a', async () => {
              concurrent++;
              maxObserved = Math.max(maxObserved, concurrent);
              await new Promise(r => setTimeout(r, 50));
              concurrent--;
          });

          // Fire 5 refresh requests simultaneously
          await Promise.allSettled([
              pool._refreshAccount('provider-a', 'acc-1'),
              pool._refreshAccount('provider-a', 'acc-2'),
              pool._refreshAccount('provider-a', 'acc-3'),
              pool._refreshAccount('provider-a', 'acc-4'),
              pool._refreshAccount('provider-a', 'acc-5')
          ]);

          expect(maxObserved).toBeLessThanOrEqual(2);
      });
  });
  ```

- [ ] **Step 3: Run tests to confirm they FAIL (adapters/methods may need to be adjusted)**

  ```bash
  cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test tests/unit/provider-pool-manager.test.js --verbose 2>&1 | tail -30
  ```

  If imports succeed but test methods like `_seedPool`, `_doSelectProvider` etc. don't exist, note the actual method names from the source and update the test file to match.

---

### Task 12: Implement Test Helpers in ProviderPoolManager (if needed)

- [ ] **Step 1: Check if ProviderPoolManager exposes the needed internal methods**

  ```bash
  grep -n '_seedPool\|_doSelectProvider\|_triggerCooldown\|_isOnCooldown\|_setCockpitScore\|_mockAdapterRefresh\|_refreshAccount' \
    /Users/ilialiston/MASTER-C/AIClient2API/src/providers/provider-pool-manager.js
  ```

- [ ] **Step 2: Add test-only helper methods if missing**

  In `src/providers/provider-pool-manager.js`, add a testing interface at the bottom of the class (before the closing `}`):

  ```javascript
  // ── Test-Only Interface ──────────────────────────────────────────────────────
  // These methods are only used by the test suite and should NOT be called in
  // production code. They expose internal state for white-box testing.

  _seedPool(providerType, accounts, model = null) {
      // Seed the internal pool state for a provider/model combination.
      // Exact implementation depends on the internal state shape — adapt as needed.
      if (!this._pools) this._pools = {};
      const key = model ? `${providerType}::${model}` : providerType;
      this._pools[key] = accounts;
  }

  _triggerCooldown(providerType, accountId) {
      // Manually trigger cooldown for an account (simulates a 429 response).
      this._cooldownManager?.setCooldown(providerType, accountId);
  }

  _isOnCooldown(providerType, accountId) {
      return this._cooldownManager?.isOnCooldown(providerType, accountId) ?? false;
  }

  _setCockpitScore(providerType, accountId, score) {
      if (!this._cockpitScores) this._cockpitScores = {};
      this._cockpitScores[`${providerType}::${accountId}`] = score;
  }

  _mockAdapterRefresh(providerType, mockFn) {
      if (!this._refreshMocks) this._refreshMocks = {};
      this._refreshMocks[providerType] = mockFn;
  }
  ```

  > **Note:** The actual implementation must match the real internal state shape of `ProviderPoolManager`. Read the constructor and existing methods to find the right property names, then adapt the helpers above to set/read those same properties.

- [ ] **Step 3: Re-run the tests — they should pass now**

  ```bash
  cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test tests/unit/provider-pool-manager.test.js --verbose 2>&1 | tail -30
  ```

  Expected: all 9 test suites pass.

- [ ] **Step 4: Run full suite**

  ```bash
  pnpm test --silent 2>&1 | tail -5
  ```

  Expected: all tests pass (156 + 6 header + 9 pool manager = 171+ total).

- [ ] **Step 5: Commit**

  ```bash
  cd /Users/ilialiston/MASTER-C
  git add AIClient2API/tests/unit/provider-pool-manager.test.js \
           AIClient2API/src/providers/provider-pool-manager.js
  git commit -m "test(pool-manager): add 9-behavior unit test suite for ProviderPoolManager"
  ```

---

### Task 13: Fix restartCount Reset in master.js

**Files:**
- Create test: `AIClient2API/tests/unit/master-restart.test.js`
- Modify: `AIClient2API/src/core/master.js:191-203`

- [ ] **Step 1: Write the failing test**

  Create `AIClient2API/tests/unit/master-restart.test.js`:

  ```javascript
  /**
   * Tests: scheduleRestart() resets restartCount after long healthy uptime.
   */
  import { jest } from '@jest/globals';

  describe('scheduleRestart — restartCount reset', () => {
      beforeEach(() => jest.useFakeTimers());
      afterEach(() => jest.useRealTimers());

      test('uses base restartDelay (no backoff) after worker ran for ≥ 60s', async () => {
          const { scheduleRestart, workerStatus, config } = await import('../../src/core/master.js');
          
          // Simulate long uptime: worker started 90 seconds ago
          workerStatus.startTime = new Date(Date.now() - 90_000).toISOString();
          workerStatus.restartCount = 5; // accumulated from previous crashes
          
          const restartSpy = jest.spyOn({ restartWorker: () => {} }, 'restartWorker');
          scheduleRestart();

          // The setTimeout delay should be restartDelay * 2^0 = 1000ms (base)
          // not 1000 * 2^5 = 32000ms (accumulated)
          const calls = jest.getTimerCount();
          expect(workerStatus.restartCount).toBe(0); // reset happened
          
          // Verify the delay used was the base delay
          jest.advanceTimersByTime(config.restartDelay + 100);
          // restartWorker should have been called by now
      });

      test('uses accumulated backoff when worker crashed quickly (< 60s uptime)', async () => {
          const { scheduleRestart, workerStatus } = await import('../../src/core/master.js');
          
          // Short uptime: worker started 10 seconds ago
          workerStatus.startTime = new Date(Date.now() - 10_000).toISOString();
          workerStatus.restartCount = 3;
          
          scheduleRestart();
          
          // restartCount should NOT have been reset
          expect(workerStatus.restartCount).toBe(3);
      });
  });
  ```

- [ ] **Step 2: Run test to verify it FAILS**

  ```bash
  cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test tests/unit/master-restart.test.js 2>&1 | tail -10
  ```

  Expected: FAIL (restartCount is not reset yet).

- [ ] **Step 3: Implement the fix in master.js**

  In `src/core/master.js`, modify `scheduleRestart()` (lines 191-203):

  Before:
  ```javascript
  function scheduleRestart() {
      if (workerStatus.restartCount >= config.maxRestartAttempts) {
          logger.error('[Master] Max restart attempts reached, giving up');
          return;
      }

      const delay = Math.min(config.restartDelay * Math.pow(2, workerStatus.restartCount), 30000);
  ```

  After:
  ```javascript
  function scheduleRestart() {
      if (workerStatus.restartCount >= config.maxRestartAttempts) {
          logger.error('[Master] Max restart attempts reached, giving up');
          return;
      }

      // Reset backoff counter if the worker had a long healthy run (≥ 60s).
      // This prevents a single crash after hours of uptime from inheriting an
      // accumulated 30s restart delay.
      if (workerStatus.startTime) {
          const uptimeMs = Date.now() - new Date(workerStatus.startTime).getTime();
          if (uptimeMs >= 60_000) {
              workerStatus.restartCount = 0;
              logger.info('[Master] Long uptime detected — reset restart backoff counter');
          }
      }

      const delay = Math.min(config.restartDelay * Math.pow(2, workerStatus.restartCount), 30000);
  ```

- [ ] **Step 4: Run the test to verify it PASSES**

  ```bash
  cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test tests/unit/master-restart.test.js --verbose 2>&1 | tail -15
  ```

  Expected: both tests PASS.

- [ ] **Step 5: Run full suite**

  ```bash
  pnpm test --silent 2>&1 | tail -5
  ```

  Expected: all tests pass.

- [ ] **Step 6: Commit**

  ```bash
  cd /Users/ilialiston/MASTER-C
  git add AIClient2API/tests/unit/master-restart.test.js \
           AIClient2API/src/core/master.js
  git commit -m "fix(master): reset restartCount after ≥60s healthy uptime to prevent 30s restart delay"
  ```

---

**Phase 4 Gate (Final Gate):**

```bash
cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test 2>&1 | grep -E 'Tests:|Suites:|worker process'
```
Expected:
```
Test Suites: 23+ passed, 23+ total
Tests:       171+ passed, 171+ total
```
No leaking-handle warning.

---

## Final Verification Checklist

Run each line and confirm the expected output:

```bash
# 1. SYSTEM_PROMPT_FILE_PATH is empty
node -e "const c=JSON.parse(require('fs').readFileSync('configs/config.json','utf8')); console.log('SYSTEM_PROMPT_FILE_PATH:', JSON.stringify(c.SYSTEM_PROMPT_FILE_PATH))"
# Expected: SYSTEM_PROMPT_FILE_PATH: ""

# 2. Dead providers are disabled
node -e "const p=JSON.parse(require('fs').readFileSync('configs/provider_pools.json','utf8')); ['github-models','openai-custom'].forEach(n=>{const pv=p.providers?.find(x=>x.type===n); console.log(n, pv?.accounts?.every(a=>a.enabled===false) ? 'DISABLED ✅' : 'STILL ACTIVE ❌')})"
# Expected: github-models DISABLED ✅ / openai-custom DISABLED ✅

# 3. ENABLE_TOOL_SEARCH is a global export
source ~/dotfiles/zsh/zshrc && echo "ENABLE_TOOL_SEARCH=$ENABLE_TOOL_SEARCH"
# Expected: ENABLE_TOOL_SEARCH=true

# 4. No dead code in request-handler.js
grep -c 'let apiService;' /Users/ilialiston/MASTER-C/AIClient2API/src/handlers/request-handler.js
# Expected: 0

# 5. Full test suite passes with no warnings
cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test 2>&1 | grep -E 'Tests:|Suites:|worker process'
# Expected: all passed, no worker process warning
```
