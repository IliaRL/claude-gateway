# Phase 1: Critical Fixes + Connectivity Tests - Context

**Gathered:** 2026-06-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Fix the live SyntaxError in antigravity-core.js, mark the disabled openai-custom provider so it fails fast instead of silently, and give operators a one-command proxy validation workflow (pnpm run smoke + curl one-liners documented in package.json).

**In scope:**
- Fix antigravity-core.js SyntaxError (wherever it is — use `node --check` to locate, not just line 1830)
- Mark openai-custom as disabled in pool config (don't remove from fallback chains yet)
- Add `pnpm run smoke` alias → `node scripts/live-verify.cjs --quick`
- Document curl one-liners for /v1/models and /v1/messages in package.json scripts
- Verify /provider_health endpoint returns correctly after fixes

**Out of scope:**
- Writing OPERATION.md (Phase 2)
- Architecture refactoring (Phase 3)
- Adding new providers or models
- Changing the fallback chain topology (just disable the broken node)

</domain>

<decisions>
## Implementation Decisions

### SyntaxError Fix

- **D-01:** Use `node --check src/providers/gemini/antigravity-core.js` to locate the exact syntax error first — the "line 1830" in the handoff notes is approximate, not confirmed. The lines around 1830 appear syntactically clean from the scan.
- **D-02:** Minimal surgical patch only — fix the specific syntax error, run `node --check` before and after to confirm clean, run `pnpm test` to confirm no regressions. Do NOT refactor surrounding logic.
- **D-03:** Success criterion: `node --check src/providers/gemini/antigravity-core.js` exits 0 with no output.

### Disabled Provider Handling

- **D-04:** Mark openai-custom as disabled in the pool config (provider_pools.json) rather than editing the providerFallbackChain — openai-custom appears in 5 different fallback chains and the pool manager already skips providers with zero healthy accounts. This is the minimal, reversible fix.
- **D-05:** If provider_pools.json already has an `enabled: false` or similar flag mechanism, use that. If not, set all openai-custom accounts' `status` to `disabled` or set pool-level `enabled: false`.
- **D-06:** After marking disabled, verify via `curl http://127.0.0.1:3000/provider_health` that openai-custom shows as unhealthy/skipped rather than being attempted.

### Connectivity Test Entry Point

- **D-07:** Add `"smoke": "node scripts/live-verify.cjs --quick"` to package.json scripts — NO new script needed. live-verify.cjs already provides accurate, quota-safe, semantically valid verification.
- **D-08:** The existing scripts are: `verify:live` (full), `verify:quick` (one per provider, quick), and now `smoke` (alias to --quick). These three cover all use cases.
- **D-09:** `pnpm run smoke` must exit 0 only when all active (non-disabled) providers respond with semantically valid output.

### Curl One-Liners

- **D-10:** Define curl one-liners as comments in package.json scripts section OR document them inline in the scripts/live-verify.cjs header. They will be formally moved to OPERATION.md in Phase 2.
- **D-11:** The two essential one-liners to document:
  ```bash
  # Test /v1/models:
  curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/v1/models | jq '.data[].id' | head -10
  
  # Test /v1/messages (minimal prompt):
  curl -sf http://127.0.0.1:3000/v1/messages \
    -H "Authorization: Bearer $AICLIENT_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"model":"claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"Say hi"}]}' | jq '.content[0].text'
  ```

### Claude's Discretion

- The exact mechanism for marking openai-custom disabled (flag name, location in pool config) — use whatever the existing pool manager already supports.
- Whether to add a `# DISABLED — credential revoked` comment to the fallback chain entries for clarity — recommended if it doesn't break parsing.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source Files to Inspect

- `AIClient2API/src/providers/gemini/antigravity-core.js` — Run `node --check` first; the SyntaxError location must be confirmed before editing
- `AIClient2API/configs/provider_pools.json` — Pool config where openai-custom accounts are defined; check existing `enabled`/`status` flags
- `AIClient2API/configs/config.json` — providerFallbackChain topology; DO NOT edit to remove openai-custom (just mark disabled)
- `AIClient2API/scripts/live-verify.cjs` — Existing verification script; add `smoke` alias, do not rewrite
- `AIClient2API/package.json` — Add `smoke` script entry here

### Documentation

- `.planning/REQUIREMENTS.md` — Requirements BUG-01, BUG-02, DIAG-01–04, OPS-01–03 define the success criteria for this phase
- `.planning/ROADMAP.md` Phase 1 — Success criteria 1–4

### Architecture Context

- `AIClient2API/docs/CLAUDE.md` (MASTER-C/CLAUDE.md) — Memory guard rules, restart rules, credential folder location
- `AIClient2API/src/providers/provider-pool-manager.js` — Understand how disabled/unhealthy pools are skipped before editing pool config

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `scripts/live-verify.cjs` — Full-featured, quota-safe verification suite. Supports `--quick`, `--provider=X`, `--json`, `--no-tool`, `--include-unhealthy`. Just alias it as `pnpm run smoke`.
- `scripts/safe-restart.sh` — Existing restart script that enforces the memory guard. Already does the right thing — don't modify.
- `src/providers/provider-pool-manager.js` — Already handles "skip if no healthy accounts" logic. The disable mechanism exists.

### Established Patterns

- **Surgical edits only**: Karpathy-style — touch the minimum required. The test suite (212 tests) is the regression gate.
- **node --check before editing**: Always syntax-check the file before and after editing any .js in src/providers/.
- **pnpm test as gate**: Run `pnpm test` before committing any source file change.
- **model-catalog.json is source of truth**: Don't add or remove models during this phase.

### Integration Points

- `package.json` `scripts` section → add `"smoke": "node scripts/live-verify.cjs --quick"`
- `configs/provider_pools.json` → disable openai-custom pool entries
- `src/providers/gemini/antigravity-core.js` → fix SyntaxError (locate with node --check)

</code_context>

<specifics>
## Specific Ideas

- The `live-verify.cjs` header comment already contains excellent usage documentation — the curl one-liners should mirror this script's approach (small max_tokens, semantically validate response).
- The `node --check` approach is the correct way to locate SyntaxErrors — it's faster than reading the entire file.
- After marking openai-custom disabled, run `pnpm run smoke` to confirm the remaining providers still pass.

</specifics>

<deferred>
## Deferred Ideas

- OPERATION.md runbook with curl one-liners → Phase 2
- SYSTEM-OVERVIEW.md architecture document → Phase 2
- Module boundary improvements (provider add = 2-file change) → Phase 3
- Security audit of credential sync scripts → Phase 2
- Observability/metrics (latency tracking in cockpit.db) → v2 requirements, not this project

</deferred>

---

*Phase: 1-Critical-Fixes-Connectivity*
*Context gathered: 2026-06-04*
