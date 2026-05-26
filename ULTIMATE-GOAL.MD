# ULTIMATE-GOAL.MD
# Goal: Build a Production-Grade 3-Tier AI Gateway

Engineer and deliver a fully functional, resilient, crash-proof 3-Tier AI Gateway that serves as
the master communication hub between the Claude Code CLI and all external AI API providers —
enabling seamless routing of any selected AI model with 100% compatibility, zero downtime, high
speed, low latency, and the smoothest high-performance user experience possible.

**Do not stop until all of the following are true:**
- All three tiers are running and healthy
- A full end-to-end test request successfully traverses Tier 3 → Tier 2 → Tier 1 → provider
  and returns a valid response
- The `claude-pick` command launches a live Claude Code session routed through the proxy
- The `claude-swap` command restarts a session with a newly selected model, carrying forward
  conversation history via `claude --resume`
- The `/model` command within an active session successfully switches to any configured
  backend model
- All three fallback levels have been verified functional end-to-end
- Complete architecture documentation has been written and committed

---

## Constraints & Non-Negotiables

Consult `Model-Guide.md` before making any architectural decisions about model IDs, provider
routing, or repository structure. It is an informational reference — not a strict spec — that
points to relevant project files and links to up-to-date model ID sources. The actual model IDs
and provider specs live in the project files it references; use those as the authoritative source.

All credentials must be sourced exclusively from `/Users/ilialiston/MASTER-C/Credentials/`.
No credentials may be hardcoded or assumed anywhere in the system. One subfolder per provider.

Use **`pnpm`** for all Node.js dependency installation and builds in code we write from scratch.
Do not force pnpm into AIClient2API's existing npm scripts — leave those untouched.

---

## Architecture: Three Immovable Tiers

### Request Flow

```
Claude Code CLI
    → [Tier 3] ZSH: injects ANTHROPIC_BASE_URL=http://localhost:4000 per-execution
    → [Tier 2] LiteLLM (port 4000): payload normalization, silent retry, fallback level 3
    → [Tier 1] AIClient2API (port 3000): provider pool, auth, protocol translation, fallback levels 1 & 2
    → External providers
```

LiteLLM targets AIClient2API's **OpenAI endpoint** (`http://127.0.0.1:3000/v1`) using
`openai/*` model prefix. LiteLLM performs the Anthropic → OpenAI translation itself.
This avoids double-translation and is the cleanest integration path.

---

### Tier 1 — Proxy Worker (AIClient2API, port 3000)
Source: https://github.com/justlovemaki/AIClient2API

The heavy-lifting backend that connects directly to all external providers. Responsibilities:
- Executes stateful account pool load-balancing with persistent state tracking and cooldown
- Owns fallback levels 1 and 2 (see Fallback Routing Strategy below)
- Performs raw API protocol translation across all provider formats
- Manages credential state and OAuth lifecycle
- Hosts the Cockpit Quota Tracking module (see below)

Providers to configure: Kiro, Antigravity, Gemini CLI OAuth, OpenAI Codex OAuth, Grok/xAI,
Qwen OAuth, GitHub Models (`forward-custom`), NVIDIA NIM (`forward-custom`).

All API keys and OAuth credentials are in `/Users/ilialiston/MASTER-C/Credentials/` —
one subfolder per provider. Read every subfolder before writing any provider config.

**Critical rule:** Model strings sent from LiteLLM to AIClient2API must exactly match the
provider adapter's internal model map in `src/providers/provider-models.js`. Mismatches are
the #1 source of silent 404s. Validate every model ID against this file before configuring.

---

### Tier 2 — Gateway / Shock-Absorber (LiteLLM, port 4000)
Source: https://github.com/BerriAI/litellm

The middle layer between Claude Code CLI and Tier 1. Responsibilities:
- Serves `/v1/messages` (Anthropic format) to Claude Code at `ANTHROPIC_BASE_URL`
- Formats and standardizes all payloads for 100% Claude Code compatibility
- Silently retries on failures (429s, 500s, 502s) and absorbs transient errors
- Owns fallback level 3 only (tiered model downgrade — see below)
- Routes normalized traffic downstream to Tier 1's OpenAI endpoint

Enable `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` so that the native `/model` picker
inside an active Claude Code session populates from the proxy's `/v1/models` endpoint.

Starting config (extend during build — do not treat as final):
```yaml
model_list:
  - model_name: "*"
    litellm_params:
      model: "openai/*"
      api_base: "http://127.0.0.1:3000/v1"
      api_key: "sk-a60f3efdf9b97e63c84ab4a3583f9d1c"

litellm_settings:
  drop_params: true
  set_verbose: true
```

---

### Tier 3 — Local CLI Router (ZSH, `~/dotfiles/zsh/zshrc`)
Handled by local ZSH dotfiles. Not in this repo. Responsibilities:
- Houses `claude-pick` and `claude-swap` shell scripts
- Intercepts native Claude CLI traffic
- Dynamically injects environment variables scoped per-command execution only:
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, and model name
- Never pollutes global system credentials
- Routes CLI sessions securely to local LiteLLM infrastructure

---

## Cockpit Quota Tracking & Load-Balancing

Implement a resilient, non-blocking Quota Tracking and Load-Balancing module within Tier 1.

**The endpoint is already live and active on this machine:**
`http://127.0.0.1:18081/report?token=C-Code-CLI-Model-API`

This endpoint returns a plain-text Markdown table of accounts, models, and remaining quota
percentages. The `~/.antigravity_cockpit/` directory already exists with offline state files.

This module must:

**Session Keep-Alive:** Poll the endpoint on a sub-10-minute interval to prevent OAuth session
expiration and refresh the in-memory quota cache. Must be fully non-blocking — use async I/O
and never block the main proxy thread.

**Quota Ingestion:** Parse the Markdown table response and store account/model/quota state
in memory for instant synchronous lookup.

**Smart Routing:** Expose a synchronous penalty scoring function to the load balancer. Accounts
and models near quota exhaustion receive heavy penalties. High-quota accounts are prioritized.
This means the load balancer knows which accounts to skip *before* attempting them — reducing
failed attempts and latency during fallback sequences.

**Filesystem Fallback:** If the Cockpit endpoint is unavailable, seamlessly fall back to reading
offline state from:
- `~/.antigravity_cockpit/accounts.json` (aggregate state)
- `~/.antigravity_cockpit/accounts/` (individual account files)

Focus on non-blocking I/O, efficient data structures, and bulletproof error handling.
The quota module must never crash or block the proxy under any circumstances.

---

## Model Configuration & Access Validation

For every configured API key:
- Include only AI models that are accessible and actively working with that key
- If a model has reached its quota limit, treat it as accessible — it simply requires quota
  refresh (the Cockpit module handles deprioritization automatically)
- If a key grants access to more than 15 models, cap at 15, prioritizing the most powerful
  and capable models available under that key
- GitHub Models and NVIDIA NIM connect via AIClient2API's `forward-custom` provider type —
  both have live working API keys in the Credentials directory

---

## Fallback Routing Strategy (Three-Level Guarantee)

Fallback ownership is split cleanly between tiers for maximum efficiency:

**Tier 1 owns Levels 1 & 2** — AIClient2API's pool manager executes these natively:

1. **Vertical Rotation (Level 1)** — Exhaust all account credentials and tokens for the
   selected model on the current primary provider. The Cockpit penalty scorer pre-filters
   exhausted accounts so the pool manager skips them without attempting.

2. **Horizontal Rotation (Level 2)** — If the primary provider fails entirely, exhaust all
   accounts for that identical model across all other available providers. Same Cockpit-aware
   penalty scoring applies.

**Tier 2 owns Level 3** — LiteLLM's router triggers this only after Tier 1 signals total
exhaustion of a model across all providers:

3. **Tiered Downgrade (Level 3)** — Silently fall back to the next lower-tier model.
   Always descend the tier ladder (e.g. Opus → Sonnet → Flash). Never upgrade.
   Never expose the downgrade to the user — it must be seamless.

All operations must remain uninterrupted regardless of upstream 429s, 403s, and 500s.

---

## CLI Workflow & Model Switching

### External Commands (outside active sessions)

**`claude-pick`**
- Present a comprehensive, categorized interactive menu of all available models across all
  providers with mapped shorthand selection
- Verify Tier 1 (port 3000) and Tier 2 (port 4000) are healthy before proceeding
- If either tier is offline, automatically spin it up and wait for health confirmation
- Inject `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, and model name scoped to this execution
- Launch a fresh Claude Code session routed through LiteLLM

**`claude-swap`**
- Same model selection menu as `claude-pick`
- Verify both tiers are healthy (same startup behavior as above)
- Use `claude --resume` to carry forward conversation history into the new session
- The new session launches with the newly selected model while retaining prior context

### Internal Command (inside active sessions)

The native `/model` command must fully support seamless swapping to any configured backend
model without requiring external shell menus. This is enabled by:
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` + LiteLLM's `/v1/models` endpoint returning
all configured models. Validate this works end-to-end before marking the build complete.

---

## Ports (All Confirmed Available)

| Port | Service |
|---|---|
| 3000 | Tier 1 — AIClient2API |
| 4000 | Tier 2 — LiteLLM |
| 8085 | OAuth callback (AIClient2API-managed) |
| 8086 | OAuth callback (AIClient2API-managed) |
| 1455 | OAuth callback (AIClient2API-managed) |
| 19876–19880 | OAuth callbacks (AIClient2API-managed) |

---

## User Experience Requirements

- Model selection menus must be categorized by provider and tier, with shorthand key mapping
- Environment variable injection must be isolated per command execution — never override
  global system credentials
- All operations must remain uninterrupted regardless of upstream failures, rate limits,
  false-positive blocks, or transient backend errors
- Downgrade fallback must be silent and seamless — never surface to the user
- Optimize for high speed and low latency throughout the entire stack

---

## Deliverable Requirements

Provide complete, working, immediately usable code and configuration, plus architecture
documentation covering:

1. **Provider integration strategy** — how each provider type (OAuth, API key, forward-custom)
   is configured in AIClient2API, with credential sourcing documented
2. **Credential flow** — how credentials travel from `Credentials/` through Tier 1 to each
   provider, end-to-end
3. **Three-level fallback execution** — exact flow for all three levels, including how
   Cockpit penalty scoring influences pool manager behavior at Levels 1 and 2
4. **Model switching mechanics** — how `claude-pick`, `claude-swap`, and `/model` each work,
   and how they interact with both tiers
5. **Model access validation and 15-model cap** — where in the code this is enforced
6. **Cockpit quota module** — polling strategy, async implementation, penalty scoring
   algorithm, memory data structure, and filesystem fallback logic
7. **LiteLLM → AIClient2API connection** — why OpenAI endpoint is targeted, how translation
   works, and how Level 3 downgrade is configured in LiteLLM's router
8. **Performance decisions** — all architectural choices made to ensure low latency,
   non-blocking I/O, and zero-downtime operation across all failure modes