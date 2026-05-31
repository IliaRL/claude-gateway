# HealthGuard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add proactive reliability to AIClient2API via three capabilities: auto-disable permanently-revoked credentials (consecutive 401 detector), enable the pool manager's built-in scheduled health checks via config, and fix `modelCooldowns` corruption at startup.

**Architecture:** A singleton `HealthGuard` class in `src/utils/health-guard.js` tracks consecutive auth failures per account UUID using an in-memory Map. A separate `validateProviderPools()` utility in `src/utils/provider-pools-validator.js` runs once at startup to repair known `modelCooldowns` corruption (Rule 10 from CLAUDE.md). The pool manager's existing `performHealthChecks()` is activated via a new `SCHEDULED_HEALTH_CHECK` config block — no duplicate pulse logic needed.

**Tech Stack:** Node.js ESM, Jest 29, no new runtime dependencies.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/utils/health-guard.js` | **Create** | Consecutive-failure tracker; singleton export |
| `src/utils/provider-pools-validator.js` | **Create** | Startup JSON validation + modelCooldowns repair |
| `src/services/api-server.js` | **Modify** | Init HealthGuard + validator after pool manager obtained |
| `src/providers/provider-pool-manager.js` | **Modify** | Call `healthGuard.recordAuthFailure()` in 401 path; `recordSuccess()` on success |
| `configs/config.json` | **Modify** | Add `healthGuard` block + `SCHEDULED_HEALTH_CHECK` block |
| `tests/utils/health-guard.test.js` | **Create** | Unit tests for failure tracker |
| `tests/utils/provider-pools-validator.test.js` | **Create** | Unit tests for startup validator |

---

### Task 1: Add config blocks

**Files:**
- Modify: `configs/config.json`

- [ ] **Step 1: Add `healthGuard` and `SCHEDULED_HEALTH_CHECK` blocks**

Open `configs/config.json` and add these two blocks at the top level (after `"WARMUP_TARGET"`):

```json
"healthGuard": {
  "enabled": true,
  "maxConsecutive401s": 3,
  "permanentFailureWindowMs": 600000
},
"SCHEDULED_HEALTH_CHECK": {
  "enabled": true,
  "interval": 300000,
  "providerTypes": [
    "gemini-antigravity",
    "gemini-cli-oauth",
    "claude-kiro-oauth",
    "openai-codex-oauth",
    "openai-custom",
    "nvidia-nim",
    "github-models"
  ]
},
```

- [ ] **Step 2: Verify JSON is valid**

```bash
cd AIClient2API && node -e "JSON.parse(require('fs').readFileSync('configs/config.json','utf8')); console.log('valid')"
```
Expected: `valid`

- [ ] **Step 3: Verify scheduled health checks activate**

```bash
cd AIClient2API && grep -n 'SCHEDULED_HEALTH_CHECK' src/providers/provider-pool-manager.js | head -5
```
Expected: lines showing the config key is already read by the pool manager.

- [ ] **Step 4: Commit**

```bash
git add configs/config.json
git commit -m "config: enable scheduled health checks + add healthGuard block"
```

---

### Task 2: HealthGuard class scaffold + pass-through test

**Files:**
- Create: `src/utils/health-guard.js`
- Create: `tests/utils/health-guard.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/utils/health-guard.test.js
import { test, expect } from '@jest/globals';
import { HealthGuard } from '../../src/utils/health-guard.js';

test('HealthGuard can be instantiated', () => {
  const hg = new HealthGuard();
  expect(hg).toBeDefined();
  expect(typeof hg.recordAuthFailure).toBe('function');
  expect(typeof hg.recordSuccess).toBe('function');
  expect(typeof hg.attach).toBe('function');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd AIClient2API && pnpm test tests/utils/health-guard.test.js
```
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/utils/health-guard.js
import logger from './logger.js';

export class HealthGuard {
  constructor() {
    this._failures = new Map(); // uuid → { count, firstSeen }
    this._poolManager = null;
  }

  /** Attach to the live pool manager instance after it is created. */
  attach(poolManager) {
    this._poolManager = poolManager;
  }

  recordAuthFailure(_uuid, _providerType, _providerConfig) {}

  recordSuccess(_uuid) {}
}

/** Singleton — import this in all integration points. */
export const healthGuard = new HealthGuard();
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd AIClient2API && pnpm test tests/utils/health-guard.test.js
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/health-guard.js tests/utils/health-guard.test.js
git commit -m "feat(health-guard): add HealthGuard scaffold"
```

---

### Task 3: Consecutive-failure detection

**Files:**
- Modify: `src/utils/health-guard.js`
- Modify: `tests/utils/health-guard.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `tests/utils/health-guard.test.js`:

```javascript
test('counter increments on each auth failure', () => {
  const hg = new HealthGuard();
  hg.recordAuthFailure('uuid-1', 'openai-custom', {});
  hg.recordAuthFailure('uuid-1', 'openai-custom', {});
  expect(hg._failures.get('uuid-1').count).toBe(2);
});

test('counter resets to zero on success', () => {
  const hg = new HealthGuard();
  hg.recordAuthFailure('uuid-1', 'openai-custom', {});
  hg.recordAuthFailure('uuid-1', 'openai-custom', {});
  hg.recordSuccess('uuid-1');
  expect(hg._failures.has('uuid-1')).toBe(false);
});

test('auto-disables after threshold consecutive failures', () => {
  const hg = new HealthGuard({ maxConsecutive401s: 3, permanentFailureWindowMs: 600_000 });
  const mockPool = { disableProvider: jest.fn() };
  hg.attach(mockPool);

  hg.recordAuthFailure('uuid-1', 'openai-custom', { uuid: 'uuid-1' });
  hg.recordAuthFailure('uuid-1', 'openai-custom', { uuid: 'uuid-1' });
  expect(mockPool.disableProvider).not.toHaveBeenCalled();

  hg.recordAuthFailure('uuid-1', 'openai-custom', { uuid: 'uuid-1' });
  expect(mockPool.disableProvider).toHaveBeenCalledWith('openai-custom', { uuid: 'uuid-1' });
});

test('does NOT auto-disable before threshold', () => {
  const hg = new HealthGuard({ maxConsecutive401s: 3, permanentFailureWindowMs: 600_000 });
  const mockPool = { disableProvider: jest.fn() };
  hg.attach(mockPool);

  hg.recordAuthFailure('uuid-1', 'openai-custom', {});
  hg.recordAuthFailure('uuid-1', 'openai-custom', {});
  expect(mockPool.disableProvider).not.toHaveBeenCalled();
});

test('window expiry resets the counter', () => {
  const hg = new HealthGuard({ maxConsecutive401s: 3, permanentFailureWindowMs: 1 }); // 1ms window
  const mockPool = { disableProvider: jest.fn() };
  hg.attach(mockPool);

  hg.recordAuthFailure('uuid-1', 'openai-custom', {});
  // Manually backdate firstSeen so window has "expired"
  hg._failures.get('uuid-1').firstSeen = Date.now() - 100;

  hg.recordAuthFailure('uuid-1', 'openai-custom', {});
  expect(hg._failures.get('uuid-1').count).toBe(1); // Reset to 1, not 2
  expect(mockPool.disableProvider).not.toHaveBeenCalled();
});

test('counter is per-uuid, does not bleed between accounts', () => {
  const hg = new HealthGuard({ maxConsecutive401s: 3, permanentFailureWindowMs: 600_000 });
  const mockPool = { disableProvider: jest.fn() };
  hg.attach(mockPool);

  hg.recordAuthFailure('uuid-A', 'openai-custom', {});
  hg.recordAuthFailure('uuid-A', 'openai-custom', {});
  hg.recordAuthFailure('uuid-B', 'openai-custom', {});
  expect(mockPool.disableProvider).not.toHaveBeenCalled();
  expect(hg._failures.get('uuid-A').count).toBe(2);
  expect(hg._failures.get('uuid-B').count).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd AIClient2API && pnpm test tests/utils/health-guard.test.js
```
Expected: FAIL — multiple failures

- [ ] **Step 3: Implement consecutive-failure logic**

Replace the full content of `src/utils/health-guard.js`:

```javascript
// src/utils/health-guard.js
import logger from './logger.js';

const DEFAULTS = {
  maxConsecutive401s: 3,
  permanentFailureWindowMs: 600_000, // 10 minutes
};

export class HealthGuard {
  constructor(config = {}) {
    this._config = { ...DEFAULTS, ...config };
    this._failures = new Map(); // uuid → { count, firstSeen }
    this._poolManager = null;
  }

  /** Call once the pool manager is initialized. */
  attach(poolManager) {
    this._poolManager = poolManager;
  }

  /**
   * Record an auth failure (HTTP 401) for an account.
   * Auto-disables the account after maxConsecutive401s consecutive failures
   * within permanentFailureWindowMs.
   */
  recordAuthFailure(uuid, providerType, providerConfig) {
    const now = Date.now();
    const existing = this._failures.get(uuid);

    if (existing && (now - existing.firstSeen) > this._config.permanentFailureWindowMs) {
      // Window expired — treat this as the first failure in a new window
      this._failures.set(uuid, { count: 1, firstSeen: now });
      return;
    }

    const count = (existing?.count ?? 0) + 1;
    this._failures.set(uuid, { count, firstSeen: existing?.firstSeen ?? now });

    if (count >= this._config.maxConsecutive401s) {
      this._autoDisable(uuid, providerType, providerConfig, count);
    }
  }

  /** Call on any successful response — resets the failure counter for that account. */
  recordSuccess(uuid) {
    this._failures.delete(uuid);
  }

  _autoDisable(uuid, providerType, providerConfig, count) {
    if (!this._poolManager) {
      logger.warn(`[HealthGuard] No pool manager attached — cannot disable ${uuid}`);
      return;
    }
    try {
      this._poolManager.disableProvider(providerType, providerConfig);
      logger.warn(`[HealthGuard] Auto-disabled ${uuid} (${providerType}): 401 ×${count} consecutive. Use /provider_health reset to re-enable.`);
      this._failures.delete(uuid);
    } catch (err) {
      logger.error(`[HealthGuard] Auto-disable failed for ${uuid}: ${err.message}`);
    }
  }
}

/** Singleton — import this wherever auth failures are caught. */
export const healthGuard = new HealthGuard();
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd AIClient2API && pnpm test tests/utils/health-guard.test.js
```
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/health-guard.js tests/utils/health-guard.test.js
git commit -m "feat(health-guard): consecutive 401 detection + auto-disable"
```

---

### Task 4: Provider pools startup validator

**Files:**
- Create: `src/utils/provider-pools-validator.js`
- Create: `tests/utils/provider-pools-validator.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/utils/provider-pools-validator.test.js
import { test, expect } from '@jest/globals';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateAndRepairProviderPools } from '../../src/utils/provider-pools-validator.js';

function writeTempPools(data) {
  const dir = mkdtempSync(join(tmpdir(), 'pools-test-'));
  const p = join(dir, 'provider_pools.json');
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  return p;
}

test('returns without error when file does not exist', () => {
  expect(() => validateAndRepairProviderPools('/nonexistent/path.json')).not.toThrow();
});

test('returns without error on clean pools file', () => {
  const path = writeTempPools({
    'openai-custom': [{ uuid: 'abc', isHealthy: true, modelCooldowns: {} }]
  });
  expect(() => validateAndRepairProviderPools(path)).not.toThrow();
});

test('cleans modelCooldowns that became the string "[object Object]"', () => {
  const path = writeTempPools({
    'openai-custom': [{ uuid: 'abc', isHealthy: true, modelCooldowns: '[object Object]' }]
  });
  validateAndRepairProviderPools(path);
  const result = JSON.parse(require('fs').readFileSync(path, 'utf8'));
  expect(result['openai-custom'][0].modelCooldowns).toEqual({});
});

test('cleans modelCooldowns that is null', () => {
  const path = writeTempPools({
    'gemini-antigravity': [{ uuid: 'xyz', modelCooldowns: null }]
  });
  validateAndRepairProviderPools(path);
  const result = JSON.parse(require('fs').readFileSync(path, 'utf8'));
  expect(result['gemini-antigravity'][0].modelCooldowns).toEqual({});
});

test('cleans modelCooldowns that is an array', () => {
  const path = writeTempPools({
    'nvidia-nim': [{ uuid: 'nim1', modelCooldowns: ['bad', 'data'] }]
  });
  validateAndRepairProviderPools(path);
  const result = JSON.parse(require('fs').readFileSync(path, 'utf8'));
  expect(result['nvidia-nim'][0].modelCooldowns).toEqual({});
});

test('does not modify a valid modelCooldowns object', () => {
  const cooldowns = { 'gpt-4o': 1234567890 };
  const path = writeTempPools({
    'openai-custom': [{ uuid: 'abc', modelCooldowns: cooldowns }]
  });
  validateAndRepairProviderPools(path);
  const result = JSON.parse(require('fs').readFileSync(path, 'utf8'));
  expect(result['openai-custom'][0].modelCooldowns).toEqual(cooldowns);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd AIClient2API && pnpm test tests/utils/provider-pools-validator.test.js
```
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Implement the validator**

```javascript
// src/utils/provider-pools-validator.js
import { readFileSync, writeFileSync } from 'fs';
import logger from './logger.js';

/**
 * Validates provider_pools.json at startup and repairs known corruption patterns.
 *
 * CLAUDE.md Rule 10: `modelCooldowns` must be a plain object.
 * It can become the string "[object Object]", null, or an array due to
 * serialization bugs. This repairs those cases before the pool manager loads.
 *
 * @param {string} poolsFilePath  Absolute or relative path to provider_pools.json
 */
export function validateAndRepairProviderPools(poolsFilePath) {
  let data;
  try {
    data = JSON.parse(readFileSync(poolsFilePath, 'utf8'));
  } catch (err) {
    // Missing file or parse error — pool manager will handle it; nothing to repair
    logger.warn(`[PoolsValidator] Skipping validation: ${err.message}`);
    return;
  }

  let repaired = 0;

  for (const [providerType, accounts] of Object.entries(data)) {
    if (!Array.isArray(accounts)) continue;

    for (const account of accounts) {
      if (!account || typeof account !== 'object') continue;

      const cd = account.modelCooldowns;
      const isBroken =
        cd === null ||
        Array.isArray(cd) ||
        typeof cd === 'string' ||
        typeof cd === 'number';

      if (isBroken) {
        logger.warn(
          `[PoolsValidator] Repaired modelCooldowns for ${account.uuid ?? 'unknown'} ` +
          `(${providerType}): was ${JSON.stringify(cd)}`
        );
        account.modelCooldowns = {};
        repaired++;
      }
    }
  }

  if (repaired > 0) {
    try {
      writeFileSync(poolsFilePath, JSON.stringify(data, null, 2), 'utf8');
      logger.info(`[PoolsValidator] Wrote ${repaired} repair(s) back to ${poolsFilePath}`);
    } catch (writeErr) {
      logger.error(`[PoolsValidator] Write failed after repair: ${writeErr.message}`);
    }
  }
}
```

- [ ] **Step 4: Fix the `require('fs')` in the test** — tests use ESM, replace with import:

Update `tests/utils/provider-pools-validator.test.js` — change the `require('fs')` inside the test body to use `readFileSync` imported at the top (it was already imported via `import { writeFileSync, mkdtempSync } from 'fs'`):

```javascript
// In the test file, add readFileSync to the existing fs import:
import { writeFileSync, readFileSync, mkdtempSync } from 'fs';
// Then in the test bodies, use readFileSync directly instead of require('fs').readFileSync
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd AIClient2API && pnpm test tests/utils/provider-pools-validator.test.js
```
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add src/utils/provider-pools-validator.js tests/utils/provider-pools-validator.test.js
git commit -m "feat(pools-validator): repair modelCooldowns corruption at startup"
```

---

### Task 5: Wire HealthGuard into api-server.js

**Files:**
- Modify: `src/services/api-server.js`

- [ ] **Step 1: Add imports at top of `api-server.js`**

Find the existing import block (near lines 1–15). Add:

```javascript
import { healthGuard } from '../utils/health-guard.js';
import { validateAndRepairProviderPools } from '../utils/provider-pools-validator.js';
```

- [ ] **Step 2: Add validator call before pool manager init**

Find the `startServer()` function. Find where `initializeConfig` is called (around line 261). Add the validator call immediately after config is loaded but BEFORE the pool manager initializes:

```javascript
await initializeConfig(process.argv.slice(2), 'configs/config.json');

// Repair known provider_pools.json corruption before pool manager loads state
validateAndRepairProviderPools(CONFIG.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json');
```

- [ ] **Step 3: Attach HealthGuard to pool manager after it is obtained**

Find the section around line 389 where `getProviderPoolManager()` is called:

```javascript
const poolManager = getProviderPoolManager();
if (poolManager) {
    logger.info('[Initialization] Performing initial health checks for provider pools...');
    poolManager.performInitialHealthChecks();
    // Add after the above line:
    const hgConfig = CONFIG.healthGuard || {};
    healthGuard._config = { ...healthGuard._config, ...hgConfig };
    healthGuard.attach(poolManager);
    logger.info('[HealthGuard] Attached to pool manager');
}
```

- [ ] **Step 4: Verify the server still starts cleanly**

```bash
cd AIClient2API && timeout 8 node src/services/api-server.js 2>&1 | head -30
```
Expected: Server starts, logs show `[HealthGuard] Attached to pool manager`, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/api-server.js
git commit -m "feat(health-guard): attach HealthGuard at server startup"
```

---

### Task 6: Wire 401 recording into pool manager

**Files:**
- Modify: `src/providers/provider-pool-manager.js`

- [ ] **Step 1: Find the 401 error handling path**

```bash
cd AIClient2API && grep -n '401\|needsReauth\|markProviderNeedsReauth\|definitive.*auth' src/providers/provider-pool-manager.js | head -20
```
Expected: Lines showing `markProviderNeedsReauth` or equivalent around line 1851.

- [ ] **Step 2: Find the success path**

```bash
cd AIClient2API && grep -n 'markProviderHealthy\|recordSuccess\|isHealthy.*true' src/providers/provider-pool-manager.js | head -10
```
Expected: Lines showing `markProviderHealthy()` call around line 1940.

- [ ] **Step 3: Add import at top of provider-pool-manager.js**

Find the existing import block. Add:

```javascript
import { healthGuard } from '../utils/health-guard.js';
```

- [ ] **Step 4: Add `recordAuthFailure` call in the 401 error handler**

In the function handling definitive auth errors (near line 1851 — the comment reads "Used for definitive authentication errors like 401/403"), add the `healthGuard` call:

```javascript
// Inside the auth-failure handling block, after the existing needsReauth logic:
const uuid = providerConfig?.uuid ?? providerConfig?.customName ?? 'unknown';
healthGuard.recordAuthFailure(uuid, providerType, providerConfig);
```

- [ ] **Step 5: Add `recordSuccess` call in the healthy path**

In `markProviderHealthy()` (near line 1940), add the success reset:

```javascript
// Inside markProviderHealthy(), after provider.config.isHealthy = true:
const uuid = providerConfig?.uuid ?? providerConfig?.customName ?? 'unknown';
healthGuard.recordSuccess(uuid);
```

- [ ] **Step 6: Run the full test suite**

```bash
cd AIClient2API && pnpm test
```
Expected: **110 tests pass, 0 failures.** The pool-manager tests should not break because `healthGuard.recordAuthFailure/recordSuccess` are no-ops when not attached to a pool manager.

- [ ] **Step 7: Verify health guard activates under a real 401**

Check the gateway log after making a request to an unhealthy provider:
```bash
tail -20 /tmp/aiclient.log | grep -i 'healthguard\|auto-disabled\|consecutive'
```

- [ ] **Step 8: Commit**

```bash
git add src/providers/provider-pool-manager.js
git commit -m "feat(health-guard): record 401 failures + successes in pool manager"
```

---

### Task 7: Verification

- [ ] **Run full test suite one final time**

```bash
cd AIClient2API && pnpm test
```
Expected: 110+ tests pass, 0 failures, no worker process leak introduced by this work.

- [ ] **Verify scheduled health checks are running**

After restarting the gateway:
```bash
# Wait 5 minutes, then:
grep 'ScheduledHealthCheck\|HealthGuard' /tmp/aiclient.log | tail -10
```
Expected: Log lines showing scheduled health check ran and HealthGuard attached.

- [ ] **Verify modelCooldowns repair runs**

Manually corrupt a test entry in `configs/provider_pools.json` (a non-live account):
```bash
# Edit one account's modelCooldowns to "[object Object]"
# Restart: ./scripts/safe-restart.sh
# Check log:
grep 'PoolsValidator' /tmp/aiclient.log | head -5
```
Expected: `[PoolsValidator] Repaired modelCooldowns for <uuid>`

- [ ] **Final commit tag**

```bash
git tag health-guard-complete
```
