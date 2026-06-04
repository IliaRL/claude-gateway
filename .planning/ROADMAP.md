# ROADMAP: Perfect, Modular API Proxy Routing for Claude Code

**Project:** Perfect, Modular API Proxy Routing for Claude Code
**Milestone:** v2.0 — Proxy Excellence
**Phases:** 3 | **Requirements:** 18 | **Granularity:** Coarse

---

## Phase Summary

| # | Phase | Goal | Requirements | Success Criteria |
|---|-------|------|--------------|-----------------|
| 1 | Critical Fixes + Connectivity | Fix live bugs, establish one-command validation | BUG-01, BUG-02, DIAG-01–04, OPS-01–03 | 4 |
| 2 | Documentation + Security | Write runbook and audit credential handling | DOC-01–03, SEC-01–03 | 3 |
| 3 | Architecture + Modularity | 3/3 | Complete   | 2026-06-04 |

---

## Phase Details

### Phase 1: Critical Fixes + Connectivity Tests

**Goal:** Fix the live Antigravity SyntaxError, clean up disabled providers, and give operators a single command to validate the full proxy stack.
**Mode:** mvp

**Requirements:**
- BUG-01: Fix SyntaxError in antigravity-core.js:1830
- BUG-02: Disabled providers clearly marked / removed from fallback chain
- DIAG-01: curl one-liner for /v1/models pass/fail
- DIAG-02: curl one-liner for /v1/messages with validation
- DIAG-03: Smoke-test script — one call per active provider, per-provider pass/fail/skip
- DIAG-04: /provider_health output is human-readable
- OPS-01: `pnpm run verify:quick` completes in <30s with clear pass/fail
- OPS-02: `./scripts/safe-restart.sh` behavior preserved and documented
- OPS-03: `pnpm run smoke` runs provider smoke tests

**Success Criteria:**
1. `curl -sf http://127.0.0.1:3000/v1/models -H "Authorization: Bearer $AICLIENT_TOKEN"` returns a valid model list with no errors
2. `pnpm run verify:quick` exits 0 in under 30 seconds
3. `pnpm run smoke` outputs per-provider pass/fail for all 7 providers
4. antigravity-core.js loads without SyntaxError (confirmed by `node --check src/providers/gemini/antigravity-core.js`)

---

### Phase 2: Documentation + Security Audit

**Goal:** Write the runbook operators actually need, document the system architecture clearly, and verify there are no credential handling anti-patterns.
**Mode:** mvp

**Requirements:**
- DOC-01: OPERATION.md — add provider, test connectivity, troubleshoot
- DOC-02: docs/SYSTEM-OVERVIEW.md — traffic flow, provider selection, security paths
- DOC-03: Existing docs/ updated to reflect 2-tier architecture (no stale LiteLLM references)
- SEC-01: No hardcoded API keys or OAuth tokens in source
- SEC-02: No command injection paths in shell exec calls
- SEC-03: Credential sync scripts reviewed for secure patterns

**Success Criteria:**
1. OPERATION.md exists and "How to add a new provider" section has a working end-to-end example
2. docs/SYSTEM-OVERVIEW.md accurately describes the 2-tier flow with no LiteLLM references
3. `grep -r "sk-\|ghp_\|AIza" src/ configs/*.json` returns zero results (no hardcoded secrets)

---

### Phase 3: Architecture + Modularity

**Goal:** Ensure the codebase has clean module boundaries so adding a provider is a 2-file operation and routing/config/logging don't pollute each other.
**Mode:** mvp

**Requirements:**
- ARCH-01: Adding a new provider requires changes in ≤2 files
- ARCH-02: Config, routing, logging, security in separated source modules
- ARCH-03: model-catalog.json → provider-models.js is the single model ID source of truth

**Success Criteria:**
1. A new OpenAI-compatible provider can be added by editing only `configs/config.json` and `configs/model-catalog.json` — no source file changes required
2. `grep -rn "hardcoded model" src/` returns zero results; all model IDs flow from model-catalog.json
3. Module dependency audit passes: no circular imports between config, routing, logging, and auth modules

---

## Requirement → Phase Mapping

| Requirement | Description | Phase | Status |
|-------------|-------------|-------|--------|
| BUG-01 | Fix antigravity-core.js:1830 SyntaxError | 1 | Pending |
| BUG-02 | Clean up disabled providers in fallback chain | 1 | Pending |
| DIAG-01 | curl one-liner /v1/models | 1 | Pending |
| DIAG-02 | curl one-liner /v1/messages | 1 | Pending |
| DIAG-03 | Per-provider smoke test script | 1 | Pending |
| DIAG-04 | Human-readable /provider_health | 1 | Pending |
| OPS-01 | pnpm run verify:quick <30s | 1 | Pending |
| OPS-02 | safe-restart.sh documented | 1 | Pending |
| OPS-03 | pnpm run smoke alias | 1 | Pending |
| DOC-01 | OPERATION.md runbook | 2 | Pending |
| DOC-02 | docs/SYSTEM-OVERVIEW.md | 2 | Pending |
| DOC-03 | Docs updated for 2-tier | 2 | Pending |
| SEC-01 | No hardcoded keys in source | 2 | Pending |
| SEC-02 | No command injection paths | 2 | Pending |
| SEC-03 | Credential sync scripts reviewed | 2 | Pending |
| ARCH-01 | Provider addition ≤2 files | 3 | Pending |
| ARCH-02 | Module boundary separation | 3 | Pending |
| ARCH-03 | model-catalog.json single source of truth | 3 | Pending |

**Coverage:** 18 v1 requirements mapped to 3 phases ✓

---
*Roadmap created: 2026-06-04*
*Next: `/gsd:discuss-phase 1` or `/gsd:plan-phase 1`*
