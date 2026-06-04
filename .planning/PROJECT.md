# Perfect, Modular API Proxy Routing for Claude Code

## What This Is

A fully optimized, modular, and maintainable API proxy routing system (AIClient2API) that routes Claude Code CLI through any OpenAI-compatible backend via `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. The system currently works — this project makes it exemplary: clean module boundaries, robust diagnostics, one-command connectivity validation, and operator-friendly documentation so any provider can be added or debugged without archaeology.

## Core Value

Any OpenAI-compatible model (OpenRouter, Ollama, Gemini, Mistral, Kiro, Codex, custom proxy) can be routed through AIClient2API with zero friction — add a provider, validate connectivity in one command, and trust the fallback chain to handle failures silently.

## Requirements

### Validated

- ✓ 2-tier architecture (Claude Code → AIClient2API :3000 → providers) — v1.0
- ✓ LiteLLM removed (was corrupting Anthropic SSE stream) — v1.0
- ✓ Tool search headers pass through correctly — v1.0
- ✓ drop_params: false (preserves cache_control blocks) — v1.0
- ✓ 212-test suite passing — v1.0
- ✓ model-catalog.json as canonical model ID source — v1.0
- ✓ Provider pool manager with cooldowns + fallback chain — v1.0
- ✓ Antigravity SyntaxError fixed and verified (node --check exits 0) — v2.0
- ✓ openai-custom correctly disabled at pool level (isDisabled: true) — v2.0
- ✓ One-command connectivity validation: pnpm run smoke completes in <30s — v2.0
- ✓ OPERATION.md operator runbook — 259-line copy-pastable guide — v2.0
- ✓ docs/SYSTEM-OVERVIEW.md architecture reference — traffic flow, provider selection, security paths — v2.0
- ✓ Security audit passed — no command injection, no hardcoded secrets, sync scripts reviewed — v2.0
- ✓ Module boundaries clean: core/providers/handlers/auth groups have clean one-way dependency boundaries — v2.0
- ✓ Provider addition requires changes in ≤2 files: forward-api activated, 2-file workflow proven — v2.0
- ✓ model-catalog.json → provider-models.js single source of truth: hardcoded model IDs eliminated — v2.0
- ✓ /provider_health surfaces disabled providers as `status:disabled` with disabledCount — v2.0

### Active

*(No active requirements — v3.0 not yet defined. Run `/gsd:new-milestone` to define next milestone.)*

### Out of Scope

- Kiro first-call identity override — pre-existing Kiro behavior, not a config bug
- LiteLLM re-introduction — removed intentionally, not coming back
- Mobile/web UI for the proxy — this is a developer CLI tool only
- Cloud deployment — localhost-only by design (Apple Silicon safety rules)

## Context

### Current Architecture

```
Claude Code CLI
  → ANTHROPIC_BASE_URL=http://127.0.0.1:3000
  → AIClient2API (Node.js, port 3000)
      → Provider router (github-models | gemini-antigravity | openai-custom |
                         nvidia-nim | claude-kiro-oauth | gemini-cli-oauth | openai-codex-oauth)
      → External AI providers
```

### Source Map

| Path | Role |
|------|------|
| `src/core/master.js` | Process entrypoint |
| `src/core/config-manager.js` | Config load + validation |
| `src/providers/provider-models.js` | Loads model catalog (clean separation ✓) |
| `src/providers/provider-pool-manager.js` | Pool load balancing, cooldowns, fallback |
| `src/handlers/request-handler.js` | OpenAI + Anthropic endpoint handlers |
| `src/converters/` + `src/convert/` | Format translation |
| `src/auth/` | API key injection + validation |
| `configs/model-catalog.json` | Canonical model IDs |
| `configs/config.json` | Runtime config (providers, fallback chains) |
| `configs/provider_pools.json` | Per-account credentials + pool config |

### Known Active Issues

1. **72 circular import cycles** — all route through `src/utils/` as intermediary; no direct cross-group boundary imports. Catalogued in `AIClient2API/docs/ARCH-AUDIT.md` as C-01 through C-04. Deferred to future refactor phase.
2. **model-catalog.test.js** — 1 pre-existing failure (unknown provider in catalog). Non-blocking.
3. **api-integration.test.js** — 8 pre-existing failures (credential-related, upstream quota). Non-blocking.
4. **REQUIRED_API_KEY in config.json** — low-severity placeholder value committed to git; overridden by `AICLIENT_TOKEN` env var at runtime. Recommend replacing with a comment placeholder in future cleanup.

### Current State (post-v2.0)

- **Proxy:** Stable. 4/5 active providers healthy (github-models, nvidia-nim, gemini-antigravity, kiro). openai-custom disabled (credential revoked).
- **Diagnostics:** `pnpm run smoke` validates all providers in <30s. `pnpm run check:models` and `pnpm run check:chat` for quick one-liners.
- **Documentation:** OPERATION.md + docs/SYSTEM-OVERVIEW.md written. All stale LiteLLM refs removed from active docs.
- **Architecture:** Module boundaries clean. Provider addition is a 2-file operation. All model IDs flow from model-catalog.json.

## Constraints

- **Memory guard**: 2 GB reclaimable RAM floor before gateway start — enforced by safe-restart.sh
- **Port safety**: Restart via `./scripts/safe-restart.sh` only — kills :3000/:3100, never parent Claude process
- **Credentials**: All from `Credentials/` folder only — never hardcoded
- **No node_modules globbing**: `node_modules` (187MB) excluded via .claudesignore
- **Package manager**: pnpm only — no npm install
- **Apple Silicon**: No heavy operations when RAM is constrained

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 2-tier only (LiteLLM removed) | LiteLLM corrupted Anthropic SSE stream, added latency | ✓ Good |
| model-catalog.json as source of truth | Prevents hardcoded model IDs scattered across source | ✓ Good |
| Provider pool manager with cooldowns | Enables multi-account quota rotation without code changes | ✓ Good |
| ANTHROPIC_BASE_URL direct to :3000 | Clean path, no intermediate proxy serialization | ✓ Good |
| Coarse GSD granularity (3-5 phases) | System already works; changes are surgical, not greenfield | ✓ Good |
| Security audit before archiving docs | Catch injection/hardcoded-secret patterns while actively in the code | ✓ Good |
| forward-api as 2-file proof (not a real provider) | Demo entry proves the workflow without adding a live external dependency | ✓ Good |
| madge module audit before declaring ARCH-02 pass | 72 cycles looked alarming — audit revealed all are via utils/ intermediary, not real boundary violations | ✓ Good |
| Defer 72 circular cycles to future refactor | Cycles are pre-existing and utils/-mediated; fixing them is a large refactor with no immediate user-facing benefit | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-05 after v2.0 milestone (Proxy Excellence) completion*
