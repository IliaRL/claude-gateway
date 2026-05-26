# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Purpose

This repo is the **master configuration and source tree** for a 3-tier AI gateway that routes Claude Code CLI through any external AI provider. Read `ULTIMATE-GOAL.MD` first for the full requirements spec. Consult `Model-Guide.md` before any architectural decision about model IDs, provider routing, or repository structure.

---

## Repository Structure

```
MASTER-C/
├── Credentials/          # All credentials live here — one folder per provider
│   ├── claude-kiro-oauth/
│   ├── gemini-antigravity/
│   ├── gemini-cli-oauth/
│   ├── github-models/
│   ├── nvidia-nim/
│   ├── openai-codex-oauth/
│   └── openai-custom/
├── Tier1-AIClient2API/   # Node.js proxy — connects to external providers
├── Tier2-LiteLLM/        # Python gateway — formats payloads for Claude Code CLI
├── Model-Guide.md        # Master reference: model IDs, provider strings, docs links
└── ULTIMATE-GOAL.MD      # Full architecture spec and requirements
```

---

## Tier 1 — AIClient2API (Node.js, port 3000)

### Commands

```bash
# Install dependencies
cd Tier1-AIClient2API && pnpm install

# Start (production)
pnpm start            # node src/core/master.js

# Start (dev mode)
pnpm run start:dev

# Tests
pnpm test             # all tests
pnpm run test:unit
pnpm run test:integration
pnpm run test:coverage
pnpm run test:verbose
```

### Key Source Paths

| Path | Role |
|---|---|
| `src/core/master.js` | Process entrypoint — starts all services |
| `src/core/config-manager.js` | Loads and validates config at startup |
| `src/core/plugin-manager.js` | Provider plugin orchestration |
| `src/providers/` | One subfolder per provider adapter (`claude/`, `gemini/`, `openai/`, `grok/`, `forward/`) |
| `src/providers/provider-models.js` | Canonical model ID map — the source of truth for which model strings are valid |
| `src/providers/provider-pool-manager.js` | Account pool load balancing and cooldown state |
| `src/handlers/request-handler.js` | OpenAI-compatible endpoint handlers (what LiteLLM hits) |
| `src/converters/` & `src/convert/` | Format translation between OpenAI spec and native provider APIs |
| `src/services/api-server.js` | Standalone API server entrypoint |
| `src/auth/` | API key injection and validation |
| `src/utils/` | Error formatters and logging |
| `healthcheck.js` | Health endpoint |

**Critical rule:** The model string sent by LiteLLM → AIClient2API **must exactly match** the provider adapter's internal model map in `src/providers/`. Mismatches are the #1 source of silent 404s.

### Credentials

All credentials must be sourced from `/Users/ilialiston/MASTER-C/Credentials/`. Never hardcode or assume credentials elsewhere.

---

## ⚠️ CPU Safety Rules (MacBook Air, Apple Silicon)

**Tier 1 symlink:** `Tier1-AIClient2API/` is a symlink to `~/AIClient2API/`. Never glob, list, or scan inside it — node_modules (187MB) and .git (11MB) live there. `.claudesignore` excludes the heavy subdirs; do not remove those entries.

**Startup order is mandatory:** Tier1 MUST be healthy before Tier2 starts. `safereset` enforces this. If you start them in parallel, LiteLLM fires 80 concurrent health-check requests at :3000 before it is ready — instant CPU spike. Never run LiteLLM startup commands manually while Tier1 is still initializing.

**Tier 2 source tree:** **NEVER** glob, find, or list files inside `Tier2-LiteLLM/litellm/`, `.venv/`, `tests/`, `ui/`, `enterprise/`, `docs/`, `cookbook/`  
**NEVER** run `make install-*`, `pip install`, or `uv sync`  
**NEVER** use `--watch` or `--hot-reload`  
Safe files: `litellm_config.yaml`, `pyrightconfig.json`, `.vscode/settings.json`  
If unsure: stop and ask before scanning

---

## Tier 2 — LiteLLM Gateway (Python, default port 4000)

### Active Config

`Tier2-LiteLLM/litellm_config.yaml` — 29 named model entries across 6 providers, all routing via `openai/*` prefix to `http://127.0.0.1:3000/v1`. See file directly.

### Install Method

Dependencies are already installed via `uv sync` into `Tier2-LiteLLM/.venv/` (Python 3.12.11, litellm 1.87.0). **Never recreate `.venv/` or run any installer.** Coding conventions for the upstream LiteLLM source are in `Tier2-LiteLLM/CLAUDE.md`.

---

## Startup

```bash
# Tier 1 (AIClient2API, port 3000)
cd ~/AIClient2API && npm start

# Tier 2 (LiteLLM, port 4000)
/Users/ilialiston/MASTER-C/Tier2-LiteLLM/.venv/bin/litellm \
  --config /Users/ilialiston/MASTER-C/Tier2-LiteLLM/litellm_config.yaml \
  --port 4000

# Or start both with the shell alias
start-proxies
```

For health diagnostics after startup, use the `proxy-repair` skill (`~/.claude/skills/proxy-repair`).

---

## Tier 3 — CLI Router (ZSH, `~/dotfiles/`)

Shell layer — not in this repo. Lives in `~/dotfiles/zsh/zshrc`. The key commands it exposes:

| Command | What it does |
|---|---|
| `claude-pick` | Menu → starts Tier 1+2 if offline → opens Claude Code with chosen model |
| `claude-swap` | Same menu mid-session (Tier 1+2 must already be running) |
| `start-proxies` | Starts both Tier 1 (`~/AIClient2API`) and Tier 2 (LiteLLM on :4000) via `_ensure_gateways` |

---

## Request Flow

```
Claude Code CLI  →  Tier 3 (ZSH env injection)
    →  Tier 2 LiteLLM (:4000)  [payload normalization, retry, fallback]
    →  Tier 1 AIClient2API (:3000)  [provider auth, protocol translation]
    →  External provider (Kiro, Antigravity, Gemini, Codex, Grok, etc.)
```

---

## Three-Level Fallback (Required)

1. **Vertical rotation** — exhaust all account credentials for the selected model on the primary provider
2. **Horizontal rotation** — if the primary provider fails, exhaust all accounts for that model across other providers
3. **Tiered downgrade** — after all providers fail for the selected model, silently fall back to the next lower-tier model (Opus → Sonnet → Flash); never upgrade

---

## Cockpit Quota Module (Tier 1)

Polls `http://127.0.0.1:18081/report?token=C-Code-CLI-Model-API` on a sub-10-minute interval. Parses the plain-text Markdown table (accounts, models, quota percentages) and exposes a synchronous penalty scoring function to the load balancer. Filesystem fallback reads from `~/.antigravity_cockpit/accounts.json` and `~/.antigravity_cockpit/accounts/`.

---

## Package Manager

Use **`pnpm`** for all Node.js dependency installation and builds. Never use `npm install` in this project.

## Model ID Reference

Exact model strings per provider are in `Model-Guide.md` Part 3. The `model:` value in `litellm_config.yaml` must exactly match the provider adapter's internal model map in `src/providers/provider-models.js` — mismatches are the #1 source of silent 404s.

---

## Claude Code Project Tooling

### MCPs (project-scoped, in `.mcp.json`)

| Server | Transport | Purpose |
|---|---|---|
| `sequential-thinking` | stdio / `npx @modelcontextprotocol/server-sequential-thinking` | Step-by-step reasoning for complex routing decisions |
| `context7` | stdio / `npx @upstash/context7-mcp` | Live docs lookup for LiteLLM, Node.js, FastAPI, provider SDKs |
| `aikido` | stdio / `npx @aikidosec/mcp` | SAST + secrets scanning; requires `AIKIDO_API_KEY` env var |
| `git` | stdio / `uvx mcp-server-git` | Structured git ops on `/Users/ilialiston/AIClient2API` (live proxy repo) |
| `sqlite` | stdio / `uvx mcp-server-sqlite` | Direct query access to `/Users/ilialiston/AIClient2API/cockpit.db` (Cockpit quota DB) |
| `fetch` | stdio / `uvx mcp-server-fetch` | Full HTTP fetch without WebFetch restrictions — use for provider API testing |

### Installed Plugin Namespaces (user-scoped)

`superpowers`, `ai-devkit`, `aikido`, `claude-md-management`, `api-cache-manager`, `remember`, `skill-creator`, `code-simplifier`, `claude-code-setup`

Key skills: `proxy-repair` and `config` at `~/.claude/skills/`; `verify` from `ai-devkit`; `remember` from `remember` plugin. Project stubs (`run`, `loop`, `claude-api`, `fewer-permission-prompts`) in `.claude/skills/`.

### Custom Agents (`.claude/agents/`)

| Agent | When to invoke |
|---|---|
| `proxy-debugger` | Any 429/502/auth error or model ID mismatch across Tier 1 or Tier 2 |
| `tier-config-auditor` | Before merging provider config changes; verify Credentials ↔ provider map ↔ LiteLLM consistency |

---

## Setup Gotchas

- **Aikido MCP package:** The correct npm package is `@aikidosec/mcp`, NOT `@aikido-security/mcp-server` (404 on npm). User-scope plugin also uses `@aikidosec/mcp`.
- **`claude mcp add` scope:** Always pass `--scope project` when in this repo — default is user scope and won't write to `.mcp.json`.
- **Plugin installs are user-scoped:** All plugins installed via `/plugin` go to `~/.claude/settings.json`, not the project. No re-install needed per-project.
- **`verify` and `remember` skills:** Already provided by `ai-devkit` and `remember` plugins respectively — don't create stubs for these.
- **LiteLLM install method:** Use `uv sync` inside `Tier2-LiteLLM/` — NOT `pip install litellm[proxy]` or `make install-*`. The `.venv/` directory (Python 3.12.11) is the correct environment. Never recreate it.
- **`anthropic-skills:aiclient2api` does not exist** — the correct operational skill is `proxy-repair` at `~/.claude/skills/proxy-repair`.
- **Kiro identity override:** Kiro occasionally responds as "Kiro" or "Amazon Q" on the first request in a session. The identity override prompt in `configs/input_system_prompt.txt` appends correctly but Kiro's internal system prompt can win on the first call. Pre-existing Kiro behavior, not a config bug. Subsequent calls in the same session return correct identity.
