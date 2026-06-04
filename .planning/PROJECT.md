# Perfect, Modular API Proxy Routing for Claude Code

## What This Is

A fully optimized, modular, and maintainable API proxy routing system (AIClient2API) that routes Claude Code CLI through any OpenAI-compatible backend via `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. The system currently works — this project makes it exemplary: clean module boundaries, robust diagnostics, one-command connectivity validation, and operator-friendly documentation so any provider can be added or debugged without archaeology.

## Core Value

Any OpenAI-compatible model (OpenRouter, Ollama, Gemini, Mistral, Kiro, Codex, custom proxy) can be routed through AIClient2API with zero friction — add a provider, validate connectivity in one command, and trust the fallback chain to handle failures silently.

## Requirements

### Validated

- ✓ 2-tier architecture (Claude Code → AIClient2API :3000 → providers) — Milestone 1 complete
- ✓ LiteLLM removed (was corrupting Anthropic SSE stream) — Milestone 1
- ✓ Tool search headers pass through correctly — Milestone 1
- ✓ drop_params: false (preserves cache_control blocks) — Milestone 1
- ✓ 212-test suite passing — Milestone 1
- ✓ model-catalog.json as canonical model ID source — established
- ✓ Provider pool manager with cooldowns + fallback chain — established
- ✓ Module boundaries clean: core/providers/handlers/auth groups have clean one-way dependency boundaries — Phase 3
- ✓ Provider addition requires changes in ≤2 files: forward-api activated, 2-file workflow proven — Phase 3
- ✓ model-catalog.json → provider-models.js single source of truth: hardcoded model IDs eliminated from routing pipeline — Phase 3
- ✓ provider_health surfaces disabled providers as `status:disabled` instead of silently dropping them — Phase 3

### Active

- [ ] SyntaxError in antigravity-core.js:1830 fixed (proxy currently broken on that path)
- [ ] Standard connectivity test suite — curl one-liners for /v1/models and /v1/messages
- [ ] Provider-specific smoke tests covering all 7 active providers
- [ ] OPERATION.md / RUNBOOK.md written and accurate
- [ ] System analysis SYSTEM OVERVIEW written (traffic flow, provider selection, security paths)
- [ ] Best-practice audit completed — ISSUES.md with impact/cause/remediation

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

1. **SyntaxError in antigravity-core.js:1830** — proxy fails on Antigravity path (from handoff notes)
2. **openai-custom disabled** — credential revoked, needs cleanup or re-provisioning
3. **Test scripts not unified** — live-verify.cjs, master-smoke-test.cjs, omni-test.cjs exist but no single "does it work?" one-liner

### Debug Log Analysis (2026-06-04)

Both recent debug logs show clean startup with no proxy errors. MCP servers connect normally. The FotW campaign payload warnings are cosmetic (Claude Code internal UI feature). The ENOENT for jobs directory is cosmetic (watcher for non-existent session file). No provider authentication failures in the startup window.

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
| Coarse GSD granularity (3-5 phases) | System already works; changes are surgical, not greenfield | — Pending |

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
*Last updated: 2026-06-05 after Phase 3 (Architecture + Modularity) completion*
