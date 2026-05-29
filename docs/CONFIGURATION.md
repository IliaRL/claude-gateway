<!-- generated-by: gsd-doc-writer; rewritten 2026-05-30 for 2-tier -->
# Configuration Reference

All Tier 1 configuration lives under `AIClient2API/configs/`. These files hold secrets and are
**gitignored** (`config.json`, `provider_pools.json`) — edit locally; never commit them.

| File | Purpose |
|---|---|
| `configs/config.json` | Server settings, fallback maps, logging, health-check schedule |
| `configs/provider_pools.json` | Per-account credential pools (live OAuth tokens / static keys) |
| `configs/custom_models.json` | Model list for `openai-custom` (OpenRouter) |

---

## `config.json` — key settings

| Key | Meaning |
|---|---|
| `REQUIRED_API_KEY` | Bearer token clients must present to `/v1/*` |
| `SERVER_PORT` | **Always `3000`** — never change |
| `HOST` | Bind address (`0.0.0.0`) |
| `MODEL_PROVIDER` | Comma-separated active provider types, in priority order |
| `SYSTEM_PROMPT_FILE_PATH` | Keep `""` — per-provider prefixes handle identity (Troubleshooting Issue 8) |
| `REQUEST_MAX_RETRIES` / `REQUEST_BASE_DELAY` | Upstream retry policy |
| `CREDENTIAL_SWITCH_MAX_RETRIES` | Max account switches per request |
| `RATE_LIMIT_COOLDOWN_*` | 429 cooldown enable / base / jitter / max (ms) |
| `CRON_NEAR_MINUTES` / `CRON_REFRESH_TOKEN` | Proactive OAuth refresh window |
| `PROVIDER_POOLS_FILE_PATH` | Path to `provider_pools.json` |
| `MAX_ERROR_COUNT` | Errors before an account is marked unhealthy |
| `WARMUP_TARGET` | Accounts pre-warmed per provider at startup |
| `REFRESH_CONCURRENCY_PER_PROVIDER` | Parallel token refreshes per provider (keep ≤2 on this machine) |
| `providerFallbackChain` | Level-2 routing: provider → [compatible providers for the same model] |
| `modelFallbackMapping` | Level-3 routing: model → `{targetModel, targetProviderType}` (must terminate, no cycles) |
| `LOG_*` | File logging config (`LOG_DIR=logs`, rotation) |
| `PROMPT_LOG_MODE` | `none` normally; set `file` to capture raw request/response for debugging |
| `TLS_SIDECAR_*` | Browser-fingerprint sidecar for strict providers (e.g. Grok JA3/JA4) |
| `SCHEDULED_HEALTH_CHECK` | Keep `startupRun:false` to avoid a startup 429 storm |

### Fallback maps — invariants
- Every `targetModel` in `modelFallbackMapping` must exist in `provider-models.js` and be served by its `targetProviderType`.
- Chains must **descend** and **terminate** at an always-available model (e.g. `gemini-3-flash`).
- Validate after edits (no dangling targets, no cycles). The `tier-config-auditor` agent checks this.

---

## `provider_pools.json` — credentials

An object keyed by provider type, each an array of account entries. Field names by provider:

| Provider | Key field |
|---|---|
| `claude-kiro-oauth`, `gemini-antigravity` | OAuth token fields (auto-refreshed) |
| `nvidia-nim` | `NVIDIA_API_KEY` (static) |
| `github-models` | `OPENAI_API_KEY` = GitHub PAT with `models:read` (static) |
| `openai-custom` (OpenRouter) | `OPENAI_API_KEY` = `sk-or-v1-…` (static) |

**Editing safely while the gateway runs:** the pool manager persists this file on a debounce, so
edit it **while the gateway is stopped**, then restart — otherwise your change can be clobbered.
**Never** add `needsReauth: true` to a static-key provider (causes a pool deadlock).

---

## Environment (set by Tier 2 / `claude-mode.sh`)

| Var | Value | Why |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:3000` | Route Claude Code to the gateway |
| `ANTHROPIC_API_KEY` | `REQUIRED_API_KEY` | Gateway auth |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` | Enable `/model` discovery via `/v1/models` |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | `0` | — |
| `ENABLE_TOOL_SEARCH` | `true` | Reliable tool-use (Issue 11) |
