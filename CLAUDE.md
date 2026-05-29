# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Purpose

This repo is the **master configuration and source tree** for a 2-tier AI gateway that routes Claude Code CLI through any external AI provider. Read `docs/ULTIMATE-GOAL.md` first for the full requirements spec. Consult `docs/Model-Guide.md` before any architectural decision about model IDs, provider routing, or repository structure.

**Architecture in one line:** Claude Code → Tier 2 (ZSH env injection) → Tier 1 AIClient2API (:3000) → external providers. There is no LiteLLM middle tier (removed — see `docs/ULTIMATE-GOAL.md`).

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
├── AIClient2API/         # Node.js gateway — connects to all external providers (Tier 1, port 3000)
└── docs/                 # Architecture specs, best practices, routing guides
    ├── ULTIMATE-GOAL.md                # Full architecture spec and requirements (read first)
    ├── ARCHITECTURE.md                 # System overview, request flow, components
    ├── CONFIGURATION.md                # Config reference (config.json, pools, fallback)
    ├── GETTING-STARTED.md              # Install, first run, model switching
    ├── DEVELOPMENT.md                  # Local setup, build/test, adding providers/models
    ├── TESTING.md                      # Test suites and how to run them
    ├── Model-Guide.md                  # Master reference: model IDs, provider strings
    ├── AIClient-BP.md                  # AIClient2API best practices and validated patterns
    ├── Troubleshooting-and-Fixes.md    # Known issues registry — root causes and fixes
    ├── ANTHROPIC_GATEWAY_SPEC.md       # Saved official Claude Code LLM gateway spec
    └── archive/                        # Historical docs (incl. the removed LiteLLM tier)
```

---

## Tier 1 — AIClient2API (Node.js, port 3000)

### Commands

```bash
# Install dependencies
cd AIClient2API && pnpm install

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
| `src/providers/provider-pool-manager.js` | Account pool load balancing, cooldowns, and all 3 fallback levels |
| `src/handlers/request-handler.js` | OpenAI + Anthropic-compatible endpoint handlers (what Claude Code hits) |
| `src/converters/` & `src/convert/` | Format translation between OpenAI spec and native provider APIs |
| `src/services/api-server.js` | Standalone API server entrypoint |
| `src/auth/` | API key injection and validation |
| `src/utils/` | Error formatters and logging |
| `healthcheck.js` | Health endpoint |

**Critical rule:** The model string sent to AIClient2API **must exactly match** the provider adapter's internal model map in `src/providers/`. Mismatches are the #1 source of silent 404s.

### Credentials

All credentials must be sourced from `/Users/ilialiston/MASTER-C/Credentials/`. Never hardcode or assume credentials elsewhere.

---

## ⚠️ CPU / Memory Safety Rules (MacBook, Apple Silicon)

**Tier 1 directory:** `AIClient2API/` is the real Tier-1 gateway dir (`~/AIClient2API` is a symlink pointing to it). Never glob, list, or scan inside it — `node_modules` (187MB) and `.git` live there. `.claudesignore` excludes the heavy subdirs; do not remove those entries.

**Memory headroom guard:** Starting the gateway when RAM is near-full pushes resident memory past the jetsam threshold and triggers a WindowServer-watchdog kernel panic. `scripts/safe-restart.sh` and the `_ensure_gateways` shell helper enforce a **4 GB reclaimable-RAM floor** before launch — never bypass it. See `docs/Troubleshooting-and-Fixes.md` (Issue 10).

**Restart only via `./scripts/safe-restart.sh`** — it kills only the port-3000/3100 listeners, never the parent Claude process.

---

## Startup

```bash
# Tier 1 (AIClient2API, port 3000) — the only gateway process
cd ~/AIClient2API && pnpm start
# or, safe restart (kills only the :3000/:3100 listeners, enforces the memory guard):
./scripts/safe-restart.sh
# or, from any shell:
start-proxies
```

**Operational mode:** `claude-proxy` sets `ANTHROPIC_BASE_URL=http://127.0.0.1:3000`, routing Claude Code directly to Tier 1. `claude-native` reverts to native Anthropic auth. The toggle is in `AIClient2API/scripts/claude-mode.sh` (sourced by the zshrc).

For health diagnostics after startup, use the `proxy-repair` skill (`~/.claude/skills/proxy-repair`).

---

## Tier 2 — CLI Router (ZSH, `~/dotfiles/`)

Shell layer — not in this repo. Lives in `~/dotfiles/zsh/zshrc` (and sources `AIClient2API/scripts/claude-mode.sh`). The key commands it exposes:

| Command | What it does |
|---|---|
| `claude-pick` | Menu (from the live `:3000/v1/models` catalog) → starts Tier 1 if offline → opens Claude Code with chosen model |
| `claude-swap` | Same menu mid-session, relaunches with `claude --continue` (Tier 1 must already be running) |
| `start-proxies` / `stop-proxies` | Start / stop the AIClient2API gateway (:3000) via `_ensure_gateways` |
| `proxy-status` | Check gateway health |

---

## Request Flow

```
Claude Code CLI  →  Tier 2 (ZSH env injection)
    →  Tier 1 AIClient2API (:3000)  [provider auth, protocol translation, fallback]
    →  External provider (Kiro, Antigravity, Gemini, Codex, Grok, etc.)
```

Claude Code talks **directly** to AIClient2API's Anthropic-native `/v1/messages` endpoint — no
intermediate proxy re-serializes the SSE stream, which keeps streaming clean and latency low.

---

## Package Manager

Use **`pnpm`** for all Node.js dependency installation and builds. Never use `npm install` in this project.

---

## Model ID Reference

Exact model strings per provider are in `docs/Model-Guide.md`. The requested model string must exactly match the provider adapter's internal model map in `src/providers/provider-models.js` — mismatches are the #1 source of silent 404s. Fallback ladders (`modelFallbackMapping` in `configs/config.json`) must reference valid catalog models and terminate at a stable, always-available model (e.g. `gemini-3-flash`) — never cycle.

---

## Reference Docs

| Document | Purpose |
|---|---|
| `docs/ULTIMATE-GOAL.md` | Full architecture spec and requirements |
| `docs/ARCHITECTURE.md` | System overview, request flow, components |
| `docs/CONFIGURATION.md` | Config reference — config.json, pools, fallback |
| `docs/GETTING-STARTED.md` | Install, first run, model switching |
| `docs/DEVELOPMENT.md` | Local setup, build/test, adding providers/models |
| `docs/TESTING.md` | Test suites and how to run them |
| `docs/Model-Guide.md` | Canonical model IDs, provider strings, context windows |
| `docs/AIClient-BP.md` | AIClient2API best practices and validated patterns |
| `docs/Troubleshooting-and-Fixes.md` | Known issues registry — root causes, affected files, fix status |
| `docs/ANTHROPIC_GATEWAY_SPEC.md` | Saved official Claude Code LLM gateway spec — wire protocol, header forwarding, model discovery format |
| [Claude Code LLM Gateway docs](https://code.claude.com/docs/en/llm-gateway) | Live official spec — always-current source of truth for gateway requirements |
| [Claude Code docs index](https://code.claude.com/docs/llms.txt) | Full documentation index — use via context7 MCP to look up any Claude Code feature or protocol detail |
| [justlovemaki/AIClient2API](https://github.com/justlovemaki/AIClient2API) | Upstream AIClient2API source — check before applying upstream merges to Tier 1 |

**Standing rule:** For any question about Claude Code wire protocol, LLM gateway requirements, SSE streaming spec, tool-use schema, or official model IDs — fetch the relevant page from the docs index above (via context7 or `mcp__fetch__fetch`) before answering. The live docs are the source of truth; training knowledge may be stale.

---

## Claude Code Project Tooling

### MCPs (project-scoped, in `.mcp.json`)

| Server | Transport | Purpose |
|---|---|---|
| `sequential-thinking` | stdio / `npx @modelcontextprotocol/server-sequential-thinking` | Step-by-step reasoning for complex routing decisions |
| `context7` | stdio / `npx @upstash/context7-mcp` | Live docs lookup for Node.js, FastAPI, provider SDKs |
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
| `proxy-debugger` | Any 429/502/auth error or model ID mismatch in the Tier 1 gateway |
| `tier-config-auditor` | Before merging provider config changes; verify Credentials ↔ provider map ↔ `config.json` consistency |
| `security-reviewer` | Pre-commit security audit of credential handling, env var injection patterns, and file access |

### Tier 1 Project Skills (`AIClient2API/.claude/skills/`)

Full `aiclient-*` skill suite covering every operational concern:

| Skill | Use when |
|---|---|
| `aiclient-master` | Any task touching AIClient2API — read first as a safeguard |
| `aiclient-preflight` | Before editing any core file (adapter.js, provider-models.js, utils.js, etc.) |
| `aiclient-models` | Adding/removing models, fixing context window values, updating model catalog |
| `aiclient-routing` | Editing fallback chains, debugging unexpected model routing |
| `aiclient-health` | Pool health, 429s, cooldowns, quota exhaustion, account recovery |
| `aiclient-debug` | Request tracing, PROMPT_LOG_MODE, latency, ECONNREFUSED |
| `aiclient-statusline` | Status line display, mode toggle, context window accuracy |
| `aiclient-credentials` | OAuth refresh, API key updates, needsRefresh/needsReauth flags |
| `aiclient-providers` | Adding new provider adapters, converter strategy, protocol prefix |
| `aiclient-tooluse` | Tool-use failures, schema normalization, converter selection |
| `aiclient-sync` | After any modification — syncs agents and updates skill inventory |
| `aiclient-cleanup` | Removing dead weight, clearing stale files, freeing disk space |

---

## Setup Gotchas

- **Aikido MCP package:** The correct npm package is `@aikidosec/mcp`, NOT `@aikido-security/mcp-server` (404 on npm). User-scope plugin also uses `@aikidosec/mcp`.
- **`claude mcp add` scope:** Always pass `--scope project` when in this repo — default is user scope and won't write to `.mcp.json`.
- **Plugin installs are user-scoped:** All plugins installed via `/plugin` go to `~/.claude/settings.json`, not the project. No re-install needed per-project.
- **`verify` and `remember` skills:** Already provided by `ai-devkit` and `remember` plugins respectively — don't create stubs for these.
- **`anthropic-skills:aiclient2api` does not exist** — the correct operational skill is `proxy-repair` at `~/.claude/skills/proxy-repair`.
- **Kiro identity override:** Kiro occasionally responds as "Kiro" or "Amazon Q" on the first request in a session. The identity override prompt in `configs/input_system_prompt.txt` appends correctly but Kiro's internal system prompt can win on the first call. Pre-existing Kiro behavior, not a config bug. Subsequent calls in the same session return correct identity.

---

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
