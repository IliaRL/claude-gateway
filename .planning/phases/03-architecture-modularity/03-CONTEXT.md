# Phase 3: Architecture + Modularity - Context

**Gathered:** 2026-06-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Verify and enforce three architectural properties: (1) adding any new OpenAI-compatible provider is a 2-file operation via the existing `forward-api` adapter pattern, (2) config/routing/logging/security modules have no circular cross-dependencies, and (3) model-catalog.json is the single source of truth for all model IDs surfaced through the routing pipeline.

**In scope:**
- Uncomment `registerAdapter(MODEL_PROVIDER.FORWARD_API, ForwardApiServiceAdapter)` in `adapter.js` (1-line fix) to activate the 2-file provider-addition path
- Verify the forward-api pattern end-to-end: configs/config.json + configs/model-catalog.json is sufficient, no other source changes required
- Fix `claude-core.js:280-284` hardcoded `listModels()` fallback — replace with catalog-sourced model list
- Annotate `provider-pool-manager.js` defaultModelMap as catalog-sourced (lines 79-91) so it stays documentably correct; evaluate whether health-check default models should be read from catalog
- Run module dependency audit (madge or grep-based) to confirm no circular imports between core, providers, handlers, auth, and converters; produce a pass/fail result
- Write a passing `grep -rn "hardcoded model" src/` check (zero results from the success criterion test)

**Out of scope:**
- Redesigning the adapter registration system (the `registerAdapter()` pattern stays; no plugin-style dynamic loading)
- Refactoring `register-converters.js` — it already maps protocol prefixes cleanly and doesn't need per-provider entries
- Fixing context window metadata hardcoded in `claude-kiro.js:179` — context windows are static metadata, not catalog routing data
- Fixing behavioral model-prefix checks in `gemini-core.js` (e.g., `name.startsWith('gemini-2.5-')`) — those are SDK-level version gates, not catalog ID violations
- Adding new observability features, structured logging, or metrics (v2 requirements)
- Provider-specific smoke tests (Phase 1 scope, already complete)

</domain>

<decisions>
## Implementation Decisions

### ARCH-01: Forward-API Activation

- **D-01:** The `ForwardApiService` + `ForwardApiServiceAdapter` already exist and are fully implemented in `src/providers/forward/forward-core.js` + `adapter.js`. The only thing blocking 2-file OpenAI-compatible provider addition is one commented-out line in `adapter.js`:
  ```js
  // registerAdapter(MODEL_PROVIDER.FORWARD_API, ForwardApiServiceAdapter);
  ```
  Uncomment this line. No redesign needed.
  `[auto] Selected: Uncomment registerAdapter(FORWARD_API) — surgical 1-line activation (recommended default)`

- **D-02:** After uncommenting, the `isRegisteredProvider()` prefix-matching logic in `adapter.js` already handles `forward-api-anything` → `ForwardApiServiceAdapter` resolution. No further source changes are needed for subsequent forward-type providers.

- **D-03:** The OpenAI converter (`OpenAIConverter`) is already registered in `register-converters.js` under `MODEL_PROTOCOL_PREFIX.OPENAI`. Forward-type providers use `openai:` prefix in `model-catalog.json`. No change to `register-converters.js` needed.

- **D-04:** After activation, the complete 2-file workflow for a new OpenAI-compatible provider is:
  1. `configs/config.json` — add `providerFallbackChain` entry with `forward-api` type, `FORWARD_BASE_URL`, `FORWARD_API_KEY`
  2. `configs/model-catalog.json` — add model entries with `openai:` prefix
  That's it. Verify this end-to-end with a test.

### ARCH-03: Model ID Catalog Compliance

- **D-05:** `src/providers/claude/claude-core.js:280-284` contains a hardcoded fallback `listModels()` response with 5 hardcoded Claude model IDs. These should be sourced from `model-catalog.json` via `provider-models.js`. The catalog is the authority; `listModels()` should reflect it.
  `[auto] Selected: Fix claude-core.js listModels to source from catalog (clear catalog violation — recommended default)`

- **D-06:** `src/providers/provider-pool-manager.js:79-91` contains `defaultModelMap` — a map of provider → fallback test model used for health checks. These are hardcoded strings like `'gpt-4o-mini'`, `'gemini-2.5-flash-lite'`. The right fix is to:
  - Either read these from `model-catalog.json` (preferred if catalog has a "test model" or "default" field per provider)
  - Or document them with a clear comment that they're intentional health-check defaults and must stay in sync with the catalog when models are added/removed
  `[auto] Selected: Evaluate catalog read vs. documented constants; prefer catalog-sourced if a default/test-model marker is feasible (recommended default)`

- **D-07:** `src/providers/gemini/gemini-core.js:70` model name prefix checks (`name.startsWith('gemini-2.5-')`) are behavioral logic for SDK version gating. These are NOT catalog ID violations — they don't put routing model IDs into the source. Leave them unchanged.
  `[auto] Selected: Skip gemini prefix checks — behavioral guards, not catalog violations (recommended default)`

- **D-08:** `src/providers/claude/claude-kiro.js:179` context window map (`"gemini-2.5-pro": 1000000`) is static metadata used for token counting in Kiro's internal logic. Out of scope for this phase (context window metadata is not model catalog routing data). Leave unchanged.
  `[auto] Selected: Skip kiro context window map — metadata, not routing catalog violation (recommended default)`

### ARCH-02: Module Boundary Audit

- **D-09:** Audit method: run `npx madge --circular --extensions js src/` (madge detects circular imports automatically). If madge isn't available, use targeted `grep -rn "from.*core" src/providers/ + grep -rn "from.*providers" src/core/` cross-check to confirm no core ↔ providers circular dependency.
  `[auto] Selected: madge circular scan + targeted grep cross-check (recommended default)`

- **D-10:** Expected clean state from scout analysis:
  - `src/core/` imports only from `src/utils/` — CLEAN ✓
  - `src/providers/` imports from `src/utils/` and `src/core/config-manager.js` — one-way dependency, no circularity ✓
  - `src/providers/adapter.js` is the registry; it imports all provider cores but is imported by handlers, not by providers themselves
  - Known potential concern: does `src/handlers/` import from `src/providers/`, and do providers import from handlers? If yes, that's a cycle. Audit must confirm.

- **D-11:** Audit scope — confirm no circular imports between these four module groups:
  1. `src/core/` (config, plugin management)
  2. `src/providers/` + `src/converters/` (routing, protocol translation)
  3. `src/auth/` (credential management)
  4. `src/utils/` (logging, common utilities)
  If madge shows zero cycles: PASS, document result, no refactoring needed. If madge shows a cycle: fix the specific cycle (move the offending import to utils/ or break the dependency direction). Do not restructure clean code.
  `[auto] Selected: Report-only unless cycle found; no proactive restructuring (recommended default)`

### Claude's Discretion

- Exact format and depth of the end-to-end forward-api test (shell script, Jest test, or curl sequence in OPERATION.md Section 2)
- Whether to add a "test_model" field to model-catalog.json entries for pool-manager health checks, or use a simpler approach (e.g., pick the first catalog model for each provider)
- Wording and placement of the madge audit result (inline comment in source? separate ARCH-AUDIT.md? note in OPERATION.md?)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Primary Source Files (must read before touching)

- `AIClient2API/src/providers/adapter.js` — adapter registry with commented-out forward-api line; this is the ARCH-01 fix target
- `AIClient2API/src/providers/provider-models.js` — catalog loader; model IDs flow through here from model-catalog.json
- `AIClient2API/src/providers/provider-pool-manager.js` — contains defaultModelMap (lines 79-91) — ARCH-03 evaluation target
- `AIClient2API/src/providers/claude/claude-core.js` — hardcoded listModels fallback at lines 280-284 — ARCH-03 fix target
- `AIClient2API/src/providers/forward/forward-core.js` — ForwardApiService implementation (already complete, just needs registration)
- `AIClient2API/src/converters/register-converters.js` — protocol-prefix converter map (READ to verify no change needed for forward-api path)
- `AIClient2API/src/utils/constants.js` — MODEL_PROVIDER + MODEL_PROTOCOL_PREFIX constants (verify FORWARD_API constant exists)

### Config Files

- `AIClient2API/configs/model-catalog.json` — canonical model ID source; read to understand entry structure for D-04 and D-06
- `AIClient2API/configs/config.json` — providerFallbackChain and provider config structure; read to understand what a new forward-api entry looks like

### Requirements and Success Criteria

- `.planning/REQUIREMENTS.md` §ARCH-01–03 — exact success criteria this phase must satisfy
- `.planning/ROADMAP.md` Phase 3 — three success criteria (2-file add, zero hardcoded model grep, module audit pass)
- `.planning/PROJECT.md` — constraints (pnpm only, no node_modules globbing, memory guard)

### Prior Phase Context

- `.planning/phases/02-documentation-security/02-CONTEXT.md` — Phase 2 decisions (esp. D-08: surgical edits only, no restructuring; D-09: grep-first audit pattern)
- `.planning/phases/01-critical-fixes-connectivity/01-CONTEXT.md` — Phase 1 decisions (provider health state, forward-api gap noted in deferred)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `src/providers/forward/forward-core.js` — `ForwardApiService` fully implemented; handles `FORWARD_BASE_URL`, `FORWARD_API_KEY`, `FORWARD_HEADER_NAME`, proxy settings. Zero changes needed to this file.
- `src/providers/adapter.js:isRegisteredProvider()` — prefix-matching logic already handles `forward-api-*` resolution once `forward-api` is registered. This is the enabling mechanism for multi-account forward providers.
- `src/providers/adapter.js:getServiceAdapter()` — already handles prefix resolution and singleton caching. The forward-api path will slot in automatically once registered.
- `src/converters/ConverterFactory.js` — `registerConverter()` is already called for `OPENAI` protocol; forward-api models using `openai:` prefix will route correctly without changes.

### Established Patterns

- **Surgical edit preference** (from Phase 2, D-08): only change what's broken. The forward-api activation is 1 line; don't rewrite the registration system.
- **pnpm only** — all commands in tests/scripts use `pnpm`, never `npm`.
- **Prefix matching for multi-account pools** — `MODEL_PROVIDER.OPENAI_CUSTOM` + `openai-custom-2`, `openai-custom-3` etc. all resolve via `isRegisteredProvider()` prefix logic. Forward-api will work the same way.
- **Commented-out providers** — `QWEN_API` and `IFLOW_API` adapters are also commented out in adapter.js. Don't uncomment those (out of scope); only `FORWARD_API`.

### Integration Points

- `adapter.js` → `forward-core.js`: 1-line uncomment connects the adapter
- `provider-pool-manager.js` health-check path → `defaultModelMap`: evaluation target for D-06
- `provider-models.js:getCustomModelConfig()` → `model-catalog.json`: already the catalog entry point; `claude-core.js` should call this instead of its hardcoded list
- `handlers/request-handler.js` → `providers/adapter.js:getServiceAdapter()`: clean boundary; handlers don't import provider internals

</code_context>

<specifics>
## Specific Ideas

- The deferred note from Phase 2 CONTEXT.md explicitly flags: "Fix /provider_health to show SKIP instead of FAIL for isDisabled providers → Phase 3 (architecture)" — check if this is within ARCH-02 scope (it may be a 1-line fix in the health handler). If it's small, fold it in.
- For the ARCH-01 end-to-end verification, a simple curl test with a mock `forward-api` endpoint (or the existing OpenRouter/custom provider) would be sufficient proof. The test doesn't need to be a full Jest test — a documented curl sequence in OPERATION.md is acceptable.
- The `defaultModelMap` in pool-manager (D-06) uses `gpt-4o-mini` as the default for most OpenAI-type providers. If `model-catalog.json` has entries for those providers, picking the first listed model would be more maintainable. Check if catalog has sufficient coverage before deciding the approach.

</specifics>

<deferred>
## Deferred Ideas

- `QWEN_API` and `IFLOW_API` adapters are commented out alongside `FORWARD_API` in adapter.js — these may need activation in a future phase if Qwen/iFlow providers are added
- Context window metadata in `claude-kiro.js` (e.g., `"gemini-2.5-pro": 1000000`) — should eventually move to model-catalog.json as a `contextWindow` field per model entry; deferred to v2
- Per-provider latency/error-rate tracking in cockpit.db → v2 requirements (OBS-01–03)
- Circuit-breaker pattern for providers with >N failures → v2 ROUT-02
- Web dashboard for provider health → out of scope (CLI-only by design)

</deferred>

---

*Phase: 3-Architecture-Modularity*
*Context gathered: 2026-06-05*
