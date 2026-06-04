# Phase 3: Architecture + Modularity — Research

**Researched:** 2026-06-05  
**Status:** ## RESEARCH COMPLETE

---

## Executive Summary

ARCH-01 is a verified 1-line fix: uncommenting `registerAdapter(MODEL_PROVIDER.FORWARD_API, ForwardApiServiceAdapter)` at `adapter.js:765` immediately unlocks the 2-file provider-addition path. ARCH-03 has two violations — a hardcoded 8-model `listModels()` in `claude-core.js:276-285` and a `DEFAULT_HEALTH_CHECK_MODELS` map in `provider-pool-manager.js:78-94` where 5 provider types borrow model IDs from other providers because they have no catalog entries of their own. ARCH-02 is in **FAIL** state: madge detected 22+ circular dependency cycles rooted in four structural problems in `utils/`, none of which are within Phase 3 scope to fix unless a specific cycle is blocking a deliverable.

---

## ARCH-01: Provider Addition Path

### Current state

Today, adding a new OpenAI-compatible provider requires changes to **3+ items**:

| Item | Required change |
|---|---|
| `configs/config.json` | Add entry to `providerFallbackChain` with provider type, `FORWARD_BASE_URL`, `FORWARD_API_KEY` |
| `configs/model-catalog.json` | Add model entries with `openai:` protocol prefix |
| `src/providers/adapter.js:765` | ~~Uncomment `registerAdapter(MODEL_PROVIDER.FORWARD_API, ForwardApiServiceAdapter)`~~ (currently commented out — blocks all forward-api routing) |

Without the uncomment, the entire forward-api adapter is dead. No `configs/` changes alone can route to it.

### The full registration block (adapter.js:753-767)

```js
registerAdapter(MODEL_PROVIDER.OPENAI_CUSTOM, OpenAIApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.ATLASCLOUD, OpenAIApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES, OpenAIResponsesApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.CLAUDE_CUSTOM, ClaudeApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.GEMINI_CLI, GeminiApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.ANTIGRAVITY, AntigravityApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.KIRO_API, KiroApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.CODEX_API, CodexApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.GROK_WEB, GrokApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.GROK_CLI, GrokCliApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.NVIDIA_NIM, OpenAIApiServiceAdapter);
registerAdapter(MODEL_PROVIDER.GITHUB_MODELS, OpenAIApiServiceAdapter);
// registerAdapter(MODEL_PROVIDER.FORWARD_API, ForwardApiServiceAdapter);  ← FIX TARGET
// registerAdapter(MODEL_PROVIDER.QWEN_API, QwenApiServiceAdapter);         ← out of scope
// registerAdapter(MODEL_PROVIDER.IFLOW_API, IFlowApiServiceAdapter);       ← out of scope
```

### Constants verified

`src/utils/constants.js` confirms both constants exist:
- `MODEL_PROVIDER.FORWARD_API = 'forward-api'` (line ~71)
- `MODEL_PROTOCOL_PREFIX.FORWARD = 'forward'` (line ~53)
- `MODEL_PROTOCOL_PREFIX.OPENAI = 'openai'` (line ~49) — used by forward-type models in catalog

### Required fix

**File:** `src/providers/adapter.js`, **line 765**  
**Change:** Remove the `// ` comment prefix from the `registerAdapter(MODEL_PROVIDER.FORWARD_API, ForwardApiServiceAdapter)` line.

That is the only source file change needed. After this 1-line fix, the complete 2-file workflow for any subsequent new OpenAI-compatible provider becomes:
1. `configs/config.json` — add to `providerFallbackChain`: `{ "type": "forward-api", "FORWARD_BASE_URL": "...", "FORWARD_API_KEY": "..." }`
2. `configs/model-catalog.json` — add model entries: `{ "id": "openai:model-name", "provider": "forward-api", ... }`

### Provider-models.js seeding (already correct)

`provider-models.js:19-21` already seeds `forward-api` as a managed-list provider with an empty array, so `getProviderModels('forward-api')` returns an empty list rather than null — no change needed there.

### Verification approach

After uncommenting:
```bash
# 1. Restart gateway
./scripts/safe-restart.sh

# 2. Check forward-api appears in adapter registry
# (no direct CLI for this — verify via smoke test)
pnpm run smoke

# 3. End-to-end: add a mock forward-api entry to provider_pools.json and model-catalog.json,
# then hit /v1/models to confirm the model appears
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/v1/models | jq '.data[].id' | grep -i forward
```

---

## ARCH-03: Hardcoded Model ID Violations

### claude-core.js violations

**File:** `src/providers/claude/claude-core.js`  
**Lines:** 271–288

```js
async listModels() {
    // ...comment: "hardcode models you want to support"
    const models = [
        { id: "claude-4-sonnet",            name: "claude-4-sonnet" },
        { id: "claude-sonnet-4-20250514",   name: "claude-sonnet-4-20250514" },
        { id: "claude-opus-4-20250514",     name: "claude-opus-4-20250514" },
        { id: "claude-3-7-sonnet-20250219", name: "claude-3-7-sonnet-20250219" },
        { id: "claude-3-5-sonnet-20241022", name: "claude-3-5-sonnet-20241022" },
        { id: "claude-3-5-haiku-20241022",  name: "claude-3-5-haiku-20241022" },
        { id: "claude-3-opus-20240229",     name: "claude-3-opus-20240229" },
        { id: "claude-3-haiku-20240307",    name: "claude-3-haiku-20240307" },
    ];
    return { models: models.map(m => ({ name: m.name })) };
}
```

**8 hardcoded model IDs** — none of these flow from `model-catalog.json`.

**Replacement approach:**  
`provider-models.js:getProviderModels('claude-custom')` returns catalog-sourced model IDs for claude-type providers. For the `ClaudeApiService` (used by `claude-custom` provider), the `listModels()` fallback should call:
```js
import { getProviderModels } from '../provider-models.js';
// In listModels():
const ids = getProviderModels('claude-custom');
return { models: ids.map(id => ({ name: id })) };
```
This replaces 8 hardcoded strings with a catalog-driven list that stays current as models are added/removed.

### provider-pool-manager.js DEFAULT_HEALTH_CHECK_MODELS

**File:** `src/providers/provider-pool-manager.js`  
**Lines:** 76–94 (`static DEFAULT_HEALTH_CHECK_MODELS`)

```js
static DEFAULT_HEALTH_CHECK_MODELS = {
    'gemini-cli-oauth':      'gemini-2.5-flash-lite',   // EXACT MATCH in catalog
    'gemini-antigravity':    'gemini-3-flash',           // EXACT MATCH in catalog
    'openai-custom':         'gpt-4o-mini',              // MODEL IN CATALOG (github-models owns it)
    'atlascloud':            'gpt-4o-mini',              // MODEL IN CATALOG (borrowed)
    'nvidia-nim':            'meta/llama-3.2-3b-instruct', // EXACT MATCH in catalog
    'github-models':         'gpt-4o-mini',              // EXACT MATCH in catalog
    'claude-custom':         'claude-sonnet-4-5-20250929', // MODEL IN CATALOG (kiro owns it)
    'claude-kiro-oauth':     'claude-haiku-4-5',         // EXACT MATCH in catalog
    'openai-qwen-oauth':     'qwen3-coder-flash',        // EXACT MATCH in catalog
    'openai-iflow':          'qwen3-coder-plus',         // EXACT MATCH in catalog
    'openai-codex-oauth':    'gpt-5.4',                  // EXACT MATCH in catalog
    'openaiResponses-custom':'gpt-4o-mini',              // MODEL IN CATALOG (borrowed)
    'forward-api':           'gpt-4o-mini',              // MODEL IN CATALOG (borrowed)
    'grok-cli-oauth':        'grok-3-mini',              // EXACT MATCH in catalog
    'grok-web':              'grok-4.1-mini',            // EXACT MATCH in catalog
};
```

**Coverage summary:**
- 10/15 providers: EXACT MATCH (model ID owned by that provider in catalog)
- 5/15 providers (`openai-custom`, `atlascloud`, `claude-custom`, `openaiResponses-custom`, `forward-api`): borrow a model ID from another provider because **they have no static catalog entries** (their model lists come from live API calls at runtime)

**Why catalog-sourcing is non-trivial for the 5 borrowed providers:**  
These providers are "managed-list" providers — `provider-models.js:19-21` seeds them with empty arrays and they discover their models dynamically from the upstream API. At startup, before any live API call, there is no catalog-driven model ID to use for health checks. The borrowed `gpt-4o-mini` is a deliberate functional choice: a stable, cheap model known to work on OpenAI-compatible endpoints.

**Recommended approach (D-06 resolution):**  
Do NOT attempt to source these 5 from the catalog — the catalog legitimately has no entries for them. Instead, add a JSDoc comment block above the map:
```js
/**
 * Default health-check model per provider type.
 * For providers with static catalog entries, these MUST match a catalog model ID.
 * For managed-list providers (openai-custom, atlascloud, claude-custom, openaiResponses-custom,
 * forward-api), a borrowed stable model ID is used because they have no static catalog entries.
 * Keep in sync with configs/model-catalog.json when catalog models are added or removed.
 */
```
This satisfies the ARCH-03 spirit (the map is documented as catalog-derived where possible) without introducing a runtime catalog lookup that would fail for managed-list providers.

### provider-models.js replacement API

`getProviderModels(providerType)` at `provider-models.js:172` is the correct catalog-driven replacement for hardcoded lists:
- Reads `PROVIDER_MODELS[providerType]` which was built from `model-catalog.json` at module load
- Falls back to prefix-matching (`openai-custom-1` → `openai-custom` catalog group)
- Injects custom model aliases from `CONFIG.customModels`
- Returns a normalized, deduplicated, sorted array of model ID strings

For `claude-core.js:listModels()`, call `getProviderModels('claude-custom')` — the claude-custom catalog group contains the Claude model IDs appropriate for this fallback.

---

## ARCH-02: Module Dependency Audit

### Circular dependency scan results

madge was run against `src/` (`npx madge --circular --extensions js src/`). **22+ cycles found.** The cycles cluster into 4 structural root causes:

**Cluster C-01: utils/ imports providers/ imports convert/ imports utils/**
```
utils/common.js
  → utils/error-handling.js
    → utils/model-utils.js
      → providers/provider-models.js    ← utils importing providers (layer violation)
        → convert/convert.js
          → converters/ConverterFactory.js  ← converters import back into utils
```
Affects cycles 1–5 in madge output.

**Cluster C-02: utils/provider-strategies.js ↔ providers/\*-strategy.js**
```
utils/common.js → utils/model-utils.js → utils/provider-strategies.js
  → providers/claude/claude-strategy.js → utils/provider-strategy.js (back to utils)
  → providers/forward/forward-strategy.js
  → providers/gemini/gemini-strategy.js
  → providers/openai/openai-strategy.js  (etc.)
```
Affects cycles 6–14.

**Cluster C-03: utils/request-handlers.js pulls the full services→providers stack into utils**
```
utils/common.js → utils/request-handlers.js
  → services/service-manager.js
    → providers/adapter.js
      → providers/claude/claude-core.js (and others)
```
Affects cycles 15–18.

**Cluster C-04: auth ↔ providers/gemini/antigravity-core.js (cross-layer)**
```
auth/codex-oauth.js → core/config-manager.js → utils/common.js
  → utils/request-handlers.js → services/service-manager.js
    → providers/adapter.js → providers/gemini/antigravity-core.js
      → auth/oauth-handlers.js → auth/index.js → auth/gemini-oauth.js
        (back to auth)
```
Affects cycles 19–22+.

### Verdict

**FAIL — 22+ circular dependency cycles detected.** However:

- **Phase 3 scope per CONTEXT.md (D-11):** Fix only if a cycle is actively blocking a deliverable. None of the 22 cycles prevent ARCH-01 or ARCH-03 from being delivered.
- **The expected clean state assumed in D-10 is incorrect.** The pre-existing circular imports in `utils/` mean the codebase is already in a cyclic state that predates this phase.
- **Recommended planner action:** Mark ARCH-02 as AUDIT-ONLY for Phase 3. Document the 4 root-cause clusters in the phase artifact. Schedule refactoring of C-01 through C-04 as a separate Phase 4 sub-task rather than blocking Phase 3 delivery on a pre-existing structural debt.

### Cross-imports that ARE clean

```bash
# core/ → providers/: NO imports (clean)
grep -rn "require.*providers\|from.*providers" src/core/ → 0 results

# providers/ → handlers/: NO imports (clean)
grep -rn "require.*handlers\|from.*handlers" src/providers/ → 0 results

# auth/ → providers/: NO direct imports (clean)
grep -rn "require.*providers\|from.*providers" src/auth/ → 0 results

# handlers/ → auth/ and providers/: imports service-manager (clean intermediary)
# handlers/ does NOT directly import from providers/ — goes through service-manager
```

The handler→service→adapter boundary is architecturally correct. The cycles all live within the `utils/` layer (which has grown too many cross-layer concerns).

---

## provider_health SKIP vs FAIL (deferred from Phase 2)

### Finding

The "SKIP vs FAIL for isDisabled" issue is more nuanced than a 1-line fix:

**`service-manager.js:741`** — disabled providers are **filtered out entirely** from `/provider_health` output:
```js
.filter(item => {
    if (item.isDisabled) return false;  // ← silently dropped
    ...
})
```

**`provider-pool-manager.js:1574-1580`** — `getProviderStats()` correctly counts disabled separately from unhealthy, but this data does not flow into the `/provider_health` response.

**Current behavior:** Disabled providers are invisible in `/provider_health` — they show neither SKIP nor FAIL; they simply don't appear.

**The actual "SKIP vs FAIL" issue:** When a provider's `isDisabled=true`, it was previously counted in `unhealthyCount` (because `isHealthy` defaults to false for disabled nodes), inflating the `unhealthyRatio`. The filter at L741 prevents them from appearing in `items[]`, but they may still affect the count.

**Is it a 1-line fix?** No — it requires:
1. Including disabled items in the slim output (remove the `if (item.isDisabled) return false` filter or add a separate pass)
2. Labeling them with `"status": "disabled"` rather than counting them as unhealthy
3. Excluding them from `unhealthyCount` calculation

**Estimated effort:** ~10 lines in `service-manager.js:739-770`. This is a UI/observability fix, not a structural architecture fix. **Confirm whether this is in Phase 3 scope before planning it as a task.**

**File:** `src/services/service-manager.js`, lines 739–771 (the `slimArr` builder and count logic).

---

## Test Suite

Relevant test files for adapter/provider registration:

| Test file | Lines | Relevance |
|---|---|---|
| `tests/unit/provider-pool-manager.test.js` | 534 | Health, construction, isDisabled, pool selection |
| `tests/providers/model-catalog.test.js` | 66 | Catalog structure validation — most relevant for ARCH-03 |
| `tests/unit/models-schema.test.js` | 26 | Model schema shape checks |
| `tests/api-integration.test.js` | 766 | End-to-end API integration |
| `tests/utils/health-guard.test.js` | 76 | Health check utilities |

**No test file covers adapter registration directly** — there is no `adapter.test.js` or `forward-api.test.js`. The planner should include a task to add an integration test that verifies the forward-api adapter is registered and routes a request correctly after the ARCH-01 fix.

**Run tests:**
```bash
cd /Users/ilialiston/MASTER-C/AIClient2API && pnpm test
# Or targeted:
pnpm test -- tests/providers/model-catalog.test.js
pnpm test -- tests/unit/provider-pool-manager.test.js
```

---

## Proxy Health at Research Time

```
Proxy: ONLINE
Total accounts: 32 across 6 providers
Unhealthy: 24/32 (ratio: 0.75) — high but expected; many credential-refreshing accounts
Providers: claude-kiro-oauth (3), gemini-antigravity (13), gemini-cli-oauth (13),
           github-models (1), nvidia-nim (1), openai-codex-oauth (1)
forward-api: 0 accounts in provider_pools.json (not yet configured)
```

---

## Planning Recommendations

**Task 1 — ARCH-01 fix (1 line + verification):**  
Uncomment `adapter.js:765`. Restart gateway. Verify `isRegisteredProvider('forward-api')` resolves. Add a model-catalog entry + provider_pools entry for a mock forward-api endpoint. Confirm `/v1/models` returns it. This is the Phase 3 capstone proof.

**Task 2 — ARCH-03 fix: claude-core.js listModels:**  
Replace the hardcoded 8-model array in `claude-core.js:276-285` with a `getProviderModels('claude-custom')` call. Import `getProviderModels` from `../provider-models.js`. Verify `pnpm test` still passes — `model-catalog.test.js` should exercise this path.

**Task 3 — ARCH-03 annotation: DEFAULT_HEALTH_CHECK_MODELS:**  
Add a JSDoc block above `provider-pool-manager.js:78` documenting which entries are exact catalog matches vs. borrowed IDs for managed-list providers. No code change; documentation only. This satisfies the "catalog compliance" audit for this map.

**Task 4 — ARCH-02 audit artifact:**  
Document the 4 cycle clusters (C-01 through C-04) in a `03-VERIFICATION.md` artifact. Run `grep -rn "hardcoded model" src/` to confirm zero results after Task 2. Run the targeted grep checks for handler↔provider↔core cross-imports to confirm those boundaries remain clean. No refactoring — PASS on clean boundaries, DOCUMENT on pre-existing cycles.

**Task 5 — provider_health SKIP/FAIL (conditional):**  
Only include if confirmed in scope by the planner. If included: modify `service-manager.js:739-771` to pass through disabled providers with a `"status": "disabled"` field and exclude them from `unhealthyCount`. Estimate: ~10 lines.

**Do NOT include:**  
- Refactoring the `utils/` circular imports (C-01 through C-04) — pre-existing structural debt, out of scope per CONTEXT.md  
- Uncommenting `QWEN_API` or `IFLOW_API` adapters — explicitly out of scope per CONTEXT.md  
- Touching `gemini-core.js` prefix checks or `claude-kiro.js` context window map — excluded by D-07 and D-08
