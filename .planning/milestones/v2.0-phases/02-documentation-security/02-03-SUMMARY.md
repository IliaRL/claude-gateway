# Plan 02-03 Summary: DOC-01 — Write OPERATION.md

**Status:** COMPLETE
**Executed:** 2026-06-05

## What Was Done

Created `AIClient2API/OPERATION.md` — the operational runbook for the proxy. 259 lines covering all 3 required sections.

**Section 1: Adding a Provider/Model**
- Full 5-step numbered procedure: credentials → routing → catalog → restart → validate
- Concrete JSON examples for provider_pools.json and config.json providerFallbackChain
- model-catalog.json entry structure with all required fields
- Disabling a provider as a subsection
- All examples use placeholder values, not real credentials

**Section 2: Testing Connectivity**
- `pnpm run smoke` as primary test with expected output format
- `pnpm run check:models` and `pnpm run check:chat` as secondary tests
- `/provider_health` curl command with python3 pretty-print
- Both manual curl one-liners (verbatim from package.json Phase 1 definitions)

**Section 3: Troubleshooting**
- ECONNREFUSED: `ps aux | grep master.js` → `./scripts/safe-restart.sh`
- 429/no-healthy-provider: `/provider_health` check + cooldown explanation (30s–5min)
- Wrong model/unexpected fallback: `/tmp/aiclient_last_model` check + routing config check
- Log locations: `~/MASTER-C/AIClient2API/logs/app-$(date +%Y-%m-%d).log`
- Complete restart procedure

## Quality Checks

- 3 sections (`## ` headers) ✓
- 4 occurrences of `pnpm run smoke` ✓
- 6 references to `./scripts/safe-restart.sh` ✓
- 5 curl one-liners ✓
- Zero bare `npm` commands ✓
- Zero `:8000` or `:8080` references ✓
- Zero hardcoded tokens (`$AICLIENT_TOKEN` used throughout) ✓

## Commits

- `73f2dde` — docs(02): add OPERATION.md runbook (DOC-01)

## Self-Check: PASSED
