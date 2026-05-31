<!-- generated-by: gsd-doc-writer; rewritten 2026-05-30 for 2-tier -->
# Architecture — 2-Tier AI Gateway

A production-grade local gateway that routes Claude Code CLI traffic to any external AI provider,
with 100% protocol compatibility, account-pool load balancing, and three levels of fallback.

---

## Overview

The system is a **2-tier gateway**. Claude Code talks **directly** to AIClient2API (Tier 1) on
`:3000`; a thin ZSH layer (Tier 2) injects the right environment per command. There is no LiteLLM
middle tier — it was removed because re-serializing the SSE stream corrupted it and added latency
(see `docs/archive/` and `docs/ULTIMATE-GOAL.md`).

```
Claude Code CLI
    │  (ANTHROPIC_BASE_URL=http://127.0.0.1:3000, scoped per-exec by Tier 2)
    ▼
[Tier 1] AIClient2API  :3000   — Node.js
    • /v1/messages (Anthropic-native) + /v1/chat/completions (OpenAI)
    • provider auth + OAuth lifecycle, protocol translation
    • account-pool load balancing + Cockpit quota scoring
    • fallback levels 1, 2, 3
    ▼
External providers: Kiro · Antigravity · Gemini CLI · OpenAI Codex · OpenRouter · NVIDIA NIM · GitHub Models
```

---

## Tier 1 — AIClient2API (Node.js, port 3000)

### Process model
`src/core/master.js` is the entrypoint. The master (port 3100) forks a worker that runs the API
server (`src/services/api-server.js`) on port 3000. OAuth adapters are pre-warmed at startup via
`setImmediate` so the first request isn't slow.

### Key components

| Path | Role |
|---|---|
| `src/core/master.js` | Process entrypoint — forks worker, starts services |
| `src/core/config-manager.js` | Loads/validates `configs/config.json` at startup |
| `src/core/plugin-manager.js` | Provider plugin orchestration |
| `src/providers/provider-models.js` | **Canonical model ID map** — static & synchronous; source of truth for valid model strings |
| `src/providers/provider-pool-manager.js` | Account selection, cooldowns, **all 3 fallback levels** |
| `src/providers/adapter.js` | Per-provider service-adapter registry |
| `src/handlers/request-handler.js` | `/v1/messages` + `/v1/chat/completions` handlers (what Claude Code hits) |
| `src/converters/` & `src/convert/` | Format translation (Anthropic/OpenAI ↔ native provider) |
| `src/utils/cockpit-quota.js` | Quota ingestion + synchronous penalty scoring |
| `src/utils/response-cache.js` | 30s in-process cache for deterministic non-streaming requests |
| `src/utils/db.js` | SQLite persistence of pool state across restarts |
| `src/auth/` | API-key injection / validation |

### Endpoints
- `POST /v1/messages` — Anthropic-native (Claude Code's primary path)
- `POST /v1/chat/completions` — OpenAI-compatible
- `GET /v1/models` — model catalog (drives `/model` discovery + `claude-pick` menu)
- `GET /provider_health` — per-account health/usage
- `GET /health` — liveness

### Streaming
Native HTTP SSE for both endpoints. Because no intermediate proxy re-wraps the stream, the
Anthropic event sequence (`message_start` → deltas → `message_stop`) reaches Claude Code clean —
exactly one `message_start` per response.

### State
Two sources: the **in-memory pool** (runtime source of truth) and **SQLite** (`src/utils/db.js`,
persists across restarts). SQLite state is overlaid onto the pool at startup.

---

## Fallback Routing (all three levels in Tier 1)

Implemented in `provider-pool-manager.js`; configured by data in `configs/config.json`.

| Level | Name | Mechanism |
|---|---|---|
| 1 | Vertical rotation | Rotate accounts for the requested model on its provider (`_doSelectProvider` scoring + cooldowns) |
| 2 | Horizontal rotation | Same model on other compatible providers (`providerFallbackChain`) |
| 3 | Tiered downgrade | Descend to a lower model only after full exhaustion (`modelFallbackMapping`); guarded by a horizontal-exhaustion check, a cross-family downgrade warning, and cycle guards |

Level-3 ladders must always descend and **terminate** at a stable, always-available model
(e.g. `gemini-3-flash`). Cyclic ladders are a bug — the runtime guard prevents a crash but defeats
the purpose. (Validated cycle-free as of 2026-05-30.)

---

## Tier 2 — CLI Router (ZSH, `~/dotfiles/zsh/zshrc`)

Not in this repo. Sources `AIClient2API/scripts/claude-mode.sh`. Responsibilities:
- `claude-pick` / `claude-swap`: model menu (from `:3000/v1/models`) → ensure gateway up → launch Claude Code (fresh / `--continue`).
- `claude-proxy` / `claude-native`: toggle Claude Code between gateway and native Anthropic auth, persisting to `~/.claude/settings.json` (sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, etc.).
- `start-proxies` / `stop-proxies` / `proxy-status`: lifecycle + health, via `_ensure_gateways` (enforces the memory-headroom guard).

---

## Cross-cutting concerns
- **Memory safety:** `scripts/safe-restart.sh` + `_ensure_gateways` abort startup below a 2 GB reclaimable-RAM floor (jetsam crash prevention — Troubleshooting Issue 10), and run `live-verify.cjs` to validate API reasoning paths.
- **Identity headers:** per-provider system-prompt prefixes handle model identity; `SYSTEM_PROMPT_FILE_PATH` is intentionally empty (Troubleshooting Issue 8).
- **Observability:** status-line telemetry (`/tmp/aiclient_last_model`) reports model, context window, tokens, latency, TTFT, fallback count, and downgrade flag.
