# Phase 3: Architecture + Modularity - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-05
**Phase:** 3-architecture-modularity
**Mode:** --auto (all decisions auto-selected with recommended defaults)
**Areas discussed:** Forward-API activation path (ARCH-01), Hardcoded model ID cleanup scope (ARCH-03), Module boundary audit method (ARCH-02)

---

## Forward-API Activation Path (ARCH-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Uncomment + verify (surgical) | Uncomment the single `registerAdapter(FORWARD_API, ...)` line in adapter.js; verify 2-file workflow end-to-end | ✓ |
| Full redesign | Redesign adapter registration to be fully config-driven with no hardcoded imports | |

**Auto-selected:** Uncomment + verify (surgical) — the adapter and ForwardApiServiceAdapter are fully implemented; only 1 line is commented out. Redesigning the registration system would be scope creep.

**Notes:** The `isRegisteredProvider()` prefix-matching logic already handles multi-account forward-api routing once `forward-api` is registered. The OpenAI converter is already registered for the `openai:` protocol prefix. No changes needed to `register-converters.js` or provider cores.

---

## Hardcoded Model ID Cleanup Scope (ARCH-03)

| Option | Description | Selected |
|--------|-------------|----------|
| Fix all 4 violation sites | claude-core.js listModels + pool-manager defaultModelMap + kiro context windows + gemini prefix checks | |
| Fix catalog violations only | Fix claude-core.js listModels (primary); evaluate pool-manager defaultModelMap; skip behavioral prefix/metadata | ✓ |
| Fix claude-core.js only | Only the clearest violation (listModels fallback with hardcoded Claude model IDs) | |

**Auto-selected:** Fix catalog violations only — `claude-core.js:280-284` is a clear catalog violation (model IDs that should flow from catalog). `provider-pool-manager.js` defaultModelMap is evaluated (may be catalog-sourceable). Kiro context windows and gemini prefix checks are behavioral/metadata, not routing catalog violations.

**Notes:**
- `claude-core.js:280-284` hardcoded: `claude-3-7-sonnet-20250219`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`, `claude-3-opus-20240229`, `claude-3-haiku-20240307` — these belong in model-catalog.json
- `provider-pool-manager.js:79-91` defaultModelMap — health-check defaults; evaluate whether model-catalog.json can serve these
- `gemini-core.js:70` `name.startsWith('gemini-2.5-')` — SDK version gate, not a catalog ID; leave unchanged
- `claude-kiro.js:179` context window map — static metadata; deferred to v2

---

## Module Boundary Audit Method (ARCH-02)

| Option | Description | Selected |
|--------|-------------|----------|
| madge automated scan | `npx madge --circular src/` — programmatic circular detection | ✓ |
| Manual grep scan only | Targeted grep cross-checks for core↔providers, providers↔handlers | |
| Both | madge + targeted grep cross-checks | |

**Auto-selected:** madge automated scan (primary) with targeted grep as fallback — madge catches all circular chains; grep supplements with cross-module direction checks. No proactive restructuring unless a cycle is found.

**Notes:** From codebase scout: `src/core/` imports only from `src/utils/` (clean); `src/providers/` imports `src/core/config-manager.js` (one-way, acceptable). Main concern: does `src/handlers/` ↔ `src/providers/` create a cycle? Audit will confirm.

---

## Claude's Discretion

- Exact format of the forward-api end-to-end verification (shell test, curl, or Jest)
- Whether to add a `testModel` field to model-catalog.json for pool-manager health-check sourcing
- Format/placement of the madge audit result artifact

## Deferred Ideas

- `QWEN_API` and `IFLOW_API` adapters (also commented out in adapter.js) — future phase if those providers are activated
- Context window metadata migration to model-catalog.json — deferred to v2
- Fix `/provider_health` to show SKIP vs FAIL for isDisabled providers — small fix, planner may fold in if it's truly 1 line
- Per-provider observability (latency/error tracking) — v2 requirements OBS-01–03
