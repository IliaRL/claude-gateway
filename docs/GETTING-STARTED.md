<!-- generated-by: gsd-doc-writer -->
# Getting Started

This guide walks through everything needed to set up and run the MASTER-C 3-Tier AI Gateway from scratch on a new machine, or to verify a working state on an existing installation.

---

## Prerequisites

The gateway has three runtime tiers. Before starting, confirm all of the following are present:

| Requirement | Version | Purpose |
|---|---|---|
| Node.js | `>= 20.x` | Tier 1 — AIClient2API |
| pnpm | Any current | Tier 1 dependency installation (`npm install` is not used here) |
| Python | `3.12.x` | Tier 2 — LiteLLM `.venv/` runtime |
| `uv` | Any current | Tier 2 dependency management (already run; do not re-run) |
| ZSH + dotfiles | `~/dotfiles/zsh/zshrc` sourced | Tier 3 — shell functions (`claude-pick`, `start-proxies`, etc.) |

Check installed versions:

```bash
node --version
pnpm --version
python3 --version
uv --version
```

The active Node.js version on this machine is managed by nvm (`v20.19.6`). The Python runtime used by Tier 2 is `3.12.11` inside `Tier2-LiteLLM/.venv/` — managed by `uv sync`, which has already been run. Do not recreate `.venv/` or run any installer for Tier 2.

---

## Repository Layout

```
MASTER-C/
├── Credentials/              # Per-provider credential bootstrap files
│   ├── claude-kiro-oauth/
│   ├── gemini-antigravity/
│   ├── gemini-cli-oauth/
│   ├── github-models/
│   ├── nvidia-nim/
│   ├── openai-codex-oauth/
│   └── openai-custom/
├── Tier1-AIClient2API/       # Node.js proxy — symlink to ~/AIClient2API/
├── Tier2-LiteLLM/            # Python gateway — litellm 1.87.0
│   ├── litellm_config.yaml   # Active config (85 model entries)
│   └── .venv/                # Pre-built Python env — do not touch
└── docs/                     # Architecture, config, and best-practice docs
```

> **Symlink note:** `Tier1-AIClient2API/` is a symlink to `~/AIClient2API/`. Never glob, list, or scan inside it — `node_modules` (187 MB) and `.git` (11 MB) live there.

---

## Installation Steps

### Step 1 — Clone the repository

```bash
git clone <repo-url> ~/MASTER-C
cd ~/MASTER-C
```

### Step 2 — Install Tier 1 dependencies

```bash
cd ~/AIClient2API
pnpm install
```

Use `pnpm` only. Never use `npm install` in this project.

### Step 3 — Verify Tier 2 environment

Tier 2 dependencies are already installed into `Tier2-LiteLLM/.venv/` via `uv sync`. Confirm the binary exists:

```bash
/Users/ilialiston/MASTER-C/Tier2-LiteLLM/.venv/bin/litellm --version
```

If the binary is missing, run `uv sync` inside `Tier2-LiteLLM/` — and only that command. Never run `pip install` or `make install-*`.

### Step 4 — Configure Tier 1 credentials

Copy the example config and set your API key:

```bash
cp ~/AIClient2API/configs/config.json.example ~/AIClient2API/configs/config.json
cp ~/AIClient2API/configs/provider_pools.json.example ~/AIClient2API/configs/provider_pools.json
```

Edit `configs/config.json` and set `REQUIRED_API_KEY` to a strong token. This token must match `AICLIENT_TOKEN` in your shell environment (`~/dotfiles/zsh/zshrc`).

Populate `configs/provider_pools.json` with your provider account credentials. See `docs/CONFIGURATION.md` — Tier 1 Credentials Directory for the per-provider format.

### Step 5 — Source shell functions

Ensure `~/dotfiles/zsh/zshrc` is sourced in your shell. The `start-proxies`, `claude-pick`, and `claude-proxy` functions must be available:

```bash
source ~/dotfiles/zsh/zshrc
# Verify
type start-proxies
```

---

## First Run

**Startup order is mandatory.** Tier 1 must be healthy before Tier 2 starts. Starting them in parallel causes LiteLLM to fire up to 80 concurrent health-check requests at port 3000 before it is ready — instant CPU spike.

### Option A — Recommended: use the shell alias

```bash
start-proxies
```

This starts Tier 1 (`~/AIClient2API && npm start`) and then Tier 2 (LiteLLM on port 4000) in the correct order via the `_ensure_gateways` function.

### Option B — Manual sequential startup

```bash
# Terminal 1 — Start Tier 1 first
cd ~/AIClient2API && npm start

# Wait until you see the "Server listening on port 3000" log line, then:

# Terminal 2 — Start Tier 2
/Users/ilialiston/MASTER-C/Tier2-LiteLLM/.venv/bin/litellm \
  --config /Users/ilialiston/MASTER-C/Tier2-LiteLLM/litellm_config.yaml \
  --port 4000
```

### Verify both tiers are healthy

```bash
# Tier 1 — should return a list of model IDs
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/v1/models | jq '.data[].id' | head -10

# Tier 2 — should return a 200 with model list
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:4000/v1/models | jq '.data[].id' | head -10
```

### Route Claude Code to the gateway

```bash
# Switch Claude Code CLI to proxy mode (writes ANTHROPIC_BASE_URL to ~/.claude/settings.json)
claude-proxy

# Or launch Claude Code with model selection:
claude-pick
```

**Current operational mode:** `claude-proxy` sets `ANTHROPIC_BASE_URL=http://127.0.0.1:3000`, routing Claude Code directly to Tier 1. LiteLLM (port 4000) runs and is healthy but is not in the active Claude Code request path — it was bypassed to eliminate SSE stream corruption from LiteLLM re-wrapping streaming chunks.

---

## Common Setup Issues

### Tier 1 fails to start: `Error: REQUIRED_API_KEY is "123456"`

Tier 1 emits a startup warning when the default key is still set. Edit `configs/config.json` and set `REQUIRED_API_KEY` to a strong token, then ensure `AICLIENT_TOKEN` in your shell matches it.

### LiteLLM fires hundreds of requests at startup and CPU spikes

You started Tier 2 before Tier 1 was ready. Stop both processes, start Tier 1 first, wait for the `port 3000` log line, then start Tier 2. Use `start-proxies` to avoid this — it enforces the correct order.

### `claude-pick` / `start-proxies` not found

The shell functions are defined in `~/dotfiles/zsh/zshrc`. Run `source ~/dotfiles/zsh/zshrc` or open a new terminal session.

### Model returns 404 silently

The model string sent by LiteLLM must exactly match the provider adapter's internal model map in `Tier1-AIClient2API/src/providers/provider-models.js`. A mismatch is the most common source of silent 404s. Cross-reference `docs/Model-Guide.md` for the canonical model ID list.

### SSE stream errors / JSON parse failures during tool use

Every proxy layer must inject `X-Accel-Buffering: no` on streaming responses. Check `Tier2-LiteLLM/litellm_config.yaml` for `response_headers.X-Accel-Buffering: "no"` under `litellm_settings:`. See `docs/Architecture-and-Proxy-Integration.md` for full SSE buffering rules.

### OAuth token expired / provider returns 401

Use the `aiclient-credentials` skill or the `proxy-debugger` agent. Check `Tier1-AIClient2API/configs/provider_pools.json` for `needsRefresh` or `needsReauth` flags on affected accounts.

---

## Next Steps

| Document | What it covers |
|---|---|
| `docs/ARCHITECTURE.md` | Full system design, request flow, component diagram, fallback routing strategy |
| `docs/CONFIGURATION.md` | All config keys for Tier 1 (`config.json`) and Tier 2 (`litellm_config.yaml`) |
| `docs/Model-Guide.md` | Canonical model IDs, provider strings, context windows, fallback chains |
| `docs/AIClient-BP.md` | AIClient2API best practices and validated patterns |
| `docs/LiteLLM-BP.md` | LiteLLM gateway best practices and macOS CPU stability notes |
| `docs/Troubleshooting-and-Fixes.md` | Known issues registry with root causes and fix status |

For live health diagnostics after startup, use the `proxy-repair` skill at `~/.claude/skills/proxy-repair`. For any 429 / 502 / auth error or model ID mismatch, invoke the `proxy-debugger` agent.
