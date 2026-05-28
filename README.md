<!-- generated-by: gsd-doc-writer -->
# MASTER-C

Master configuration and source tree for a 3-tier AI gateway that routes Claude Code CLI through any external AI provider — enabling seamless model switching across Kiro, Antigravity, Gemini, OpenAI Codex, GitHub Models, NVIDIA NIM, and Grok with zero downtime.

---

## What this is

MASTER-C is a personal infrastructure repository. It contains the configuration, source code, and credentials for a layered proxy stack that intercepts Claude Code CLI traffic and routes it to whichever AI backend is selected at runtime.

**Request flow:**

```
Claude Code CLI
    → [Tier 3] ZSH (env injection, model selection)
    → [Tier 2] LiteLLM :4000 (payload normalization, retry, fallback)
    → [Tier 1] AIClient2API :3000 (provider auth, protocol translation)
    → External provider (Kiro, Antigravity, Gemini, Codex, Grok, etc.)
```

---

## Repository Structure

```
MASTER-C/
├── Credentials/          # One folder per provider — all secrets live here
│   ├── claude-kiro-oauth/
│   ├── gemini-antigravity/
│   ├── gemini-cli-oauth/
│   ├── github-models/
│   ├── nvidia-nim/
│   ├── openai-codex-oauth/
│   └── openai-custom/
├── Tier1-AIClient2API/   # Node.js proxy
├── Tier2-LiteLLM/        # Python gateway — LiteLLM 1.87.0, Python 3.12.11
└── docs/                 # Architecture specs, best practices, routing guides
```

---

## Tiers

### Tier 1 — AIClient2API (Node.js, port 3000)

Provider-facing proxy. Handles account pool load balancing, OAuth credential lifecycle, protocol translation (OpenAI ↔ native provider APIs), and fallback levels 1 & 2 (vertical/horizontal account rotation).

**Source root:** `Tier1-AIClient2API/`  
**Entry point:** `src/core/master.js`  
**Model registry:** `src/providers/provider-models.js`

```bash
cd Tier1-AIClient2API && pnpm install   # first-time setup
pnpm start                              # production
pnpm run start:dev                      # dev mode
pnpm test                               # full test suite
```

### Tier 2 — LiteLLM Gateway (Python, port 4000)

Middle layer between Claude Code and Tier 1. Accepts Anthropic-format requests from the CLI, normalizes payloads, retries on 429s/500s/502s, and owns fallback level 3 (tiered model downgrade).

**Config:** `Tier2-LiteLLM/litellm_config.yaml` — 85 model entries across 7 providers  
**Runtime:** `Tier2-LiteLLM/.venv/` (Python 3.12.11, litellm 1.87.0) — do not recreate

```bash
/Users/ilialiston/MASTER-C/Tier2-LiteLLM/.venv/bin/litellm \
  --config /Users/ilialiston/MASTER-C/Tier2-LiteLLM/litellm_config.yaml \
  --port 4000
```

### Tier 3 — CLI Router (ZSH, `~/dotfiles/`)

Shell layer — not in this repo. Provides `claude-pick` (model menu + fresh session) and `claude-swap` (model menu + resume session). Dynamically injects `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, and model name per-execution without polluting global shell state.

---

## Starting the Stack

```bash
# Start both tiers with the shell alias (preferred)
start-proxies

# Or start individually — Tier 1 MUST be healthy before Tier 2 starts
cd ~/AIClient2API && npm start

/Users/ilialiston/MASTER-C/Tier2-LiteLLM/.venv/bin/litellm \
  --config /Users/ilialiston/MASTER-C/Tier2-LiteLLM/litellm_config.yaml \
  --port 4000
```

**Startup order is mandatory.** If LiteLLM starts while Tier 1 is still initializing, it fires ~80 concurrent health-check requests at `:3000` — instant CPU spike on Apple Silicon. Use `start-proxies` or `safereset` to enforce correct order.

**Current active path:** `claude-proxy` sets `ANTHROPIC_BASE_URL=http://127.0.0.1:3000`, routing Claude Code directly to Tier 1. LiteLLM runs and is healthy but is not in the active request path — bypassed to eliminate SSE stream corruption from LiteLLM re-wrapping streaming chunks.

---

## Key Commands

| Command | What it does |
|---|---|
| `claude-pick` | Interactive model menu → starts gateway if offline → opens Claude Code |
| `claude-swap` | Same menu mid-session → resumes with `claude --resume` |
| `start-proxies` | Starts Tier 1 + Tier 2 in correct order |
| `claude-proxy` | Switches Claude Code to proxy mode (writes `ANTHROPIC_BASE_URL` to settings) |
| `claude-native` | Switches Claude Code back to native Anthropic auth |

---

## Fallback Strategy

| Level | Owner | Behavior |
|---|---|---|
| 1 — Vertical rotation | Tier 1 | Exhaust all account credentials for the selected model on the primary provider |
| 2 — Horizontal rotation | Tier 1 | If primary provider fails, try the same model across all other providers |
| 3 — Tiered downgrade | Tier 2 | After total Tier 1 exhaustion, fall back to next lower-tier model (e.g., Opus → Sonnet → Flash) |

---

## Critical Rules

- **`Tier1-AIClient2API/`** is a real directory. Never glob or scan inside it — `node_modules` (187 MB) and `.git` (11 MB) live there.
- **Never glob inside** `Tier2-LiteLLM/litellm/`, `.venv/`, `tests/`, `ui/`, `enterprise/`, `docs/`, or `cookbook/`.
- **Never recreate** `Tier2-LiteLLM/.venv/` or run `uv sync`, `pip install`, or `make install-*`.
- **Model strings** in `litellm_config.yaml` must exactly match `src/providers/provider-models.js` — mismatches are the #1 source of silent 404s.
- **Credentials** must be sourced from `Credentials/` — never hardcoded elsewhere.
- Use **`pnpm`** for all Node.js operations in Tier 1 — never `npm install`.

---

## Reference Docs

| Document | Purpose |
|---|---|
| `docs/ULTIMATE-GOAL.md` | Full architecture spec and success criteria |
| `docs/Model-Guide.md` | Canonical model IDs, provider strings, context windows |
| `docs/AIClient-BP.md` | AIClient2API best practices and validated patterns |
| `docs/LiteLLM-BP.md` | LiteLLM gateway best practices |
| `docs/Architecture-and-Proxy-Integration.md` | Env vars, SSE buffering rules, header pass-through spec |
| `docs/Troubleshooting-and-Fixes.md` | Known issues registry — root causes, affected files, fix status |
| `docs/ANTHROPIC_GATEWAY_SPEC.md` | Saved official Claude Code LLM gateway spec |
| `CLAUDE.md` | Claude Code guidance for working in this repo |

---

## Health Diagnostics

After startup, use the `proxy-repair` skill for structured diagnostics:

```bash
# Is Tier 1 alive?
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/v1/models | jq '.data[].id'

# Recent gateway log
tail -50 /tmp/aiclient.log

# Provider health
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/provider_health | jq .
```
