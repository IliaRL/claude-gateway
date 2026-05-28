# ULTIMATE-GOAL.MD
# Goal: Build a Production-Grade 3-Tier AI Gateway

Engineer and deliver a fully functional, resilient, crash-proof 3-Tier AI Gateway that serves as the master communication hub between the Claude Code CLI and all external AI API providers — enabling seamless routing of any selected AI model with 100% compatibility, zero downtime, high speed, low latency, and the smoothest high-performance user experience possible.

**Success Criteria:**
- All three tiers are running and healthy.
- A full end-to-end test request successfully traverses Tier 3 → Tier 2 → Tier 1 → provider and returns a valid response.
- The `claude-pick` command launches a live Claude Code session routed through the proxy.
- The `claude-swap` command restarts a session with a newly selected model, carrying forward conversation history via `claude --resume`.
- The `/model` command within an active session successfully switches to any configured backend model.
- All three fallback levels have been verified functional end-to-end.
- Complete architecture documentation has been written and committed.

---

## Architecture: Three Immovable Tiers

### Request Flow

```text
Claude Code CLI
    → [Tier 3] ZSH: injects ANTHROPIC_BASE_URL=http://127.0.0.1:4000 per-execution
    → [Tier 2] LiteLLM (port 4000): payload normalization, silent retry, fallback level 3
    → [Tier 1] AIClient2API (port 3000): provider pool, auth, protocol translation, fallback levels 1 & 2
    → External providers
```

LiteLLM targets AIClient2API's **OpenAI endpoint** (`http://127.0.0.1:3000/v1`) using the `openai/*` model prefix. LiteLLM performs the Anthropic → OpenAI translation itself. This avoids double-translation and is the cleanest integration path.

---

### Tier 1 — Proxy Worker (AIClient2API, port 3000)
**The heavy-lifting backend that connects directly to all external providers.**
- Executes stateful account pool load-balancing with persistent state tracking and cooldown.
- Owns fallback levels 1 and 2 (see Fallback Routing Strategy below).
- Performs raw API protocol translation across all provider formats.
- Manages credential state and OAuth lifecycle.
- Hosts the Cockpit Quota Tracking module.

**Critical rule:** Model strings sent from LiteLLM to AIClient2API must exactly match the provider adapter's internal model map in `src/providers/provider-models.js`.

---

### Tier 2 — Gateway / Shock-Absorber (LiteLLM, port 4000)
**The middle layer between Claude Code CLI and Tier 1.**
- Serves `/v1/messages` (Anthropic format) to Claude Code at `ANTHROPIC_BASE_URL`.
- Formats and standardizes all payloads for 100% Claude Code compatibility.
- Silently retries on failures (429s, 500s, 502s) and absorbs transient errors.
- Owns fallback level 3 only (tiered model downgrade).
- Routes normalized traffic downstream to Tier 1's OpenAI endpoint.

---

### Tier 3 — Local CLI Router (ZSH, `~/dotfiles/zsh/zshrc`)
**Handled by local ZSH dotfiles.**
- Houses `claude-pick` and `claude-swap` shell scripts.
- Intercepts native Claude CLI traffic.
- Dynamically injects environment variables scoped per-command execution only (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, and model name).
- Routes CLI sessions securely to local LiteLLM infrastructure without polluting global system credentials.

---

## Cockpit Quota Tracking & Load-Balancing

Implement a resilient, non-blocking Quota Tracking and Load-Balancing module within Tier 1.

**Endpoint:** `http://127.0.0.1:18081/report?token=C-Code-CLI-Model-API`

This module must:
1. **Session Keep-Alive:** Poll the endpoint on a sub-10-minute interval to prevent OAuth session expiration.
2. **Quota Ingestion:** Parse the Markdown table response and store account/model/quota state in memory.
3. **Smart Routing:** Expose a synchronous penalty scoring function to the load balancer so it knows which accounts to skip *before* attempting them.
4. **Filesystem Fallback:** Fall back to reading offline state from `~/.antigravity_cockpit/` if the endpoint is unavailable.

---

## Fallback Routing Strategy (Three-Level Guarantee)

Fallback ownership is split cleanly between tiers for maximum efficiency:

**Tier 1 owns Levels 1 & 2** (Executed natively by AIClient2API's pool manager):
1. **Vertical Rotation (Level 1)** — Exhaust all account credentials and tokens for the selected model on the current primary provider. The Cockpit penalty scorer pre-filters exhausted accounts.
2. **Horizontal Rotation (Level 2)** — If the primary provider fails entirely, exhaust all accounts for that identical model across all other available providers. 

**Tier 2 owns Level 3** (Triggered by LiteLLM only after Tier 1 signals total exhaustion):
3. **Tiered Downgrade (Level 3)** — Silently fall back to the next lower-tier model. Always descend the tier ladder (e.g., Opus → Sonnet → Flash). Never upgrade.

All operations must remain uninterrupted regardless of upstream 429s, 403s, and 500s.

---

## CLI Workflow & Model Switching

### External Commands
- **`claude-pick`**: Present an interactive menu of all available models, verify Tier 1/2 health (spinning them up if needed), inject scoped environment variables, and launch a fresh Claude Code session.
- **`claude-swap`**: Perform the same health checks and selection as `claude-pick`, but launch with `claude --resume` to carry forward conversation history.

### Internal Command
- **`/model`**: The native command must fully support seamless swapping to any configured backend model via `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` + LiteLLM's `/v1/models` endpoint.
