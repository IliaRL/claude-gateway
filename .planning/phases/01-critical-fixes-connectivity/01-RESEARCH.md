# Phase 1: Critical Fixes + Connectivity Tests — Research

**Date:** 2026-06-04
**Status:** Complete

## ## RESEARCH COMPLETE

---

## Key Findings

### BUG-01 (SyntaxError) — Already Fixed

`node --check src/providers/gemini/antigravity-core.js` exits **0 with no output**.
The SyntaxError mentioned in the handoff notes was resolved during the v3.2.0 upstream
merge (commit: 26abe91). Lines 1820–1845 (around the reported line 1830) are syntactically
clean — `buildAntigravityPayload` method is well-formed.

**Impact on plan:** BUG-01 becomes a verification task, not a fix task. Confirm syntax,
document the finding, and move on.

### BUG-02 (openai-custom) — Needs isDisabled: true

`configs/provider_pools.json` structure for openai-custom:
- Type: **array with 1 account**
- Account already has `isDisabled` field in its schema
- Pool manager filters with `!p.config.isDisabled` at lines 262, 686, 1092, 1556
- Setting `isDisabled: true` will cause the pool manager to skip this account at all
  selection points, and count it as "disabled" in statistics

**No fallback chain editing required.** The providerFallbackChain in config.json still
references openai-custom but the pool manager will find 0 healthy accounts and skip it.

### OPS-03 (pnpm run smoke) — Missing, Easy to Add

Current package.json has `verify:live` and `verify:quick` but no `smoke` alias.
`live-verify.cjs --quick` already does exactly what `smoke` should:
- One representative model per provider
- Chat only (no tool probe in --quick mode)
- Skips providers with 0 healthy accounts
- Rate-limited at 1.2s per call

Adding `"smoke": "node scripts/live-verify.cjs --quick"` to package.json scripts
satisfies DIAG-01–04, OPS-01, OPS-03 in one step.

### DIAG-01–02 (curl one-liners) — Simple, Just Needs Documentation

The two essential curl commands are straightforward. They should be added as npm scripts
so they're discoverable with `pnpm run` and copy-pastable:

```bash
# Test /v1/models
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/v1/models | jq '.data[].id' | head -10

# Test /v1/messages (minimal, deterministic)
curl -sf http://127.0.0.1:3000/v1/messages \
  -H "Authorization: Bearer $AICLIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"Hi"}]}' | jq '.content[0].text'
```

### Proxy Runtime State

The proxy health endpoint returned empty output — proxy may be offline. Plans must
include proxy-start verification before connectivity tests.

## Plan Implications

| Requirement | Finding | Plan Action |
|-------------|---------|------------|
| BUG-01 | Already fixed | Verify + document |
| BUG-02 | isDisabled field exists | Set to true in provider_pools.json |
| DIAG-01 | curl one-liner defined | Add as npm script or document |
| DIAG-02 | curl one-liner defined | Add as npm script or document |
| DIAG-03 | live-verify.cjs --quick | Add `smoke` alias |
| DIAG-04 | /provider_health works | Verify after BUG-02 fix |
| OPS-01 | verify:quick exists | Confirm <30s exit, document |
| OPS-02 | safe-restart.sh works | Verify + add `restart` npm alias |
| OPS-03 | Missing from package.json | Add `smoke` script |

## Recommended Plan Structure

**2 plans, Wave 1 (parallel — independent file sets):**

- **Plan 01-01** — Verify BUG-01 fix + set openai-custom isDisabled + run tests
  Files: `configs/provider_pools.json`, docs
- **Plan 01-02** — Add smoke/connectivity scripts to package.json + document one-liners
  Files: `package.json`
