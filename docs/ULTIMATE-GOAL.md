# ULTIMATE-GOAL.md
# Goal: A Production-Grade 2-Tier AI Gateway for Claude Code

Engineer and operate a fully functional, resilient, crash-proof gateway that serves as the
single communication hub between the Claude Code CLI and all external AI API providers —
enabling seamless routing of any selected AI model with 100% compatibility, zero downtime,
high speed, low latency, and the smoothest high-performance user experience possible, on par
with how Claude Code feels against its own native models.

**Success Criteria:**
- Both tiers are running and healthy.
- A full end-to-end request successfully traverses Tier 2 (ZSH env injection) → Tier 1
  (AIClient2API) → provider and returns a valid, cleanly-streamed response.
- The `claude-pick` command launches a live Claude Code session routed through the gateway.
- The `claude-swap` command restarts a session with a newly selected model, carrying forward
  conversation history via `claude --continue`.
- The `/model` command within an active session switches to any configured backend model via
  gateway model discovery.
- All three fallback levels (now owned entirely by Tier 1) are verified functional end-to-end.
- Architecture documentation is accurate and committed.

---

## Architecture: Two Tiers

### Request Flow

```text
Claude Code CLI
    → [Tier 2] ZSH: injects ANTHROPIC_BASE_URL=http://127.0.0.1:3000 per-execution
    → [Tier 1] AIClient2API (port 3000): provider pool, auth, protocol translation,
               native Anthropic + OpenAI SSE, and ALL fallback levels (1, 2, 3)
    → External providers (Kiro, Antigravity, Gemini CLI, OpenAI Codex, OpenRouter,
                          NVIDIA NIM, GitHub Models)
```

Claude Code talks **directly** to AIClient2API's Anthropic-native endpoint (`/v1/messages`)
on `http://127.0.0.1:3000`. There is no middle proxy re-serializing the stream.

> **History — why there is no LiteLLM tier.** An earlier design placed a LiteLLM gateway
> (port 4000) between Claude Code and AIClient2API as a "shock absorber." In practice it
> re-wrapped streaming chunks and corrupted the Anthropic SSE stream (verified duplicate
> `message_start` events), added a network hop of latency, consumed ~1.8 GB on disk, and
> contributed to memory-pressure crashes. It was removed. All of its intended
> responsibilities (payload normalization, retries, tiered fallback) are handled natively
> and more cheaply inside Tier 1. See `docs/archive/` for the historical LiteLLM notes.

---

### Tier 1 — AIClient2API Gateway (Node.js, port 3000)
**The single backend that connects directly to all external providers.**
- Serves both the Anthropic-native endpoint (`/v1/messages`) consumed by Claude Code and an
  OpenAI-compatible endpoint (`/v1/chat/completions`).
- Performs raw API protocol translation across all provider formats (Claude, Gemini, OpenAI,
  Grok) via the converter layer.
- Executes stateful account-pool load-balancing with persistent state, cooldowns, and
  quota-aware penalty scoring (Cockpit).
- Owns **all three fallback levels** (see Fallback Routing Strategy below).
- Manages credential state and OAuth lifecycle; pre-warms OAuth adapters at startup.
- Emits status-line telemetry (model, context, tokens, latency, TTFT, fallback count).

**Critical rule:** A model string sent to AIClient2API must exactly match the provider
adapter's internal model map in `src/providers/provider-models.js`. Mismatches are the #1
source of silent 404s.

---

### Tier 2 — CLI Router (ZSH, `~/dotfiles/zsh/zshrc`)
**The local shell layer that wires Claude Code to the gateway.**
- Houses `claude-pick`, `claude-swap`, `claude-proxy`, `claude-native`, `proxy-status`,
  `start-proxies`, `stop-proxies`.
- Dynamically injects environment variables scoped per command execution
  (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, model name, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`).
- Toggles Claude Code between gateway ("proxy") and native Anthropic auth via
  `AIClient2API/scripts/claude-mode.sh`, persisting to `~/.claude/settings.json`.
- Enforces the memory-headroom guard before starting the gateway (jetsam crash prevention).

---

## Cockpit Quota Tracking & Load-Balancing (within Tier 1)

A resilient, non-blocking quota tracking and load-balancing module inside AIClient2API.

**Endpoint:** `http://127.0.0.1:18081/report?token=C-Code-CLI-Model-API`

1. **Session Keep-Alive:** Poll on a sub-10-minute interval to prevent OAuth session expiry.
2. **Quota Ingestion:** Parse the Markdown table response; store account/model/quota state in memory.
3. **Smart Routing:** Expose a synchronous penalty-scoring function so the load balancer skips
   near-exhausted accounts *before* attempting them.
4. **Filesystem Fallback:** Fall back to `~/.antigravity_cockpit/` if the endpoint is unavailable.

---

## Fallback Routing Strategy (Three-Level Guarantee — all in Tier 1)

All three levels are implemented natively in `src/providers/provider-pool-manager.js`:

1. **Vertical Rotation (Level 1)** — Exhaust all account credentials for the selected model on
   the current provider. The Cockpit penalty scorer pre-filters exhausted accounts.
   (`_doSelectProvider`)
2. **Horizontal Rotation (Level 2)** — If the model fails across all accounts of the primary
   provider, try the same model on every other compatible provider. (`providerFallbackChain`)
3. **Tiered Downgrade (Level 3)** — Only after the requested model is fully exhausted across
   all accounts and providers, descend to the next lower model in the ladder
   (e.g. Opus → Sonnet → Gemini Flash — always down, never up). (`modelFallbackMapping`,
   guarded by a horizontal-exhaustion check, cycle guards, and a cross-family downgrade warning.)

All operations remain uninterrupted regardless of upstream 429s, 403s, and 500s. Fallbacks are
silent and prioritise keeping the requested capability available.

---

## CLI Workflow & Model Switching

### External Commands
- **`claude-pick`**: interactive model menu (sourced from the live `:3000/v1/models` catalog),
  verifies Tier 1 health (starting it if needed, subject to the memory guard), injects scoped
  env vars, and launches a fresh Claude Code session.
- **`claude-swap`**: same selection, but relaunches with `claude --continue` to carry history.

### Internal Command
- **`/model`**: switches to any configured backend model via
  `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` + AIClient2API's `/v1/models` endpoint.
