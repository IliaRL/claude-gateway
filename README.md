# AI Gateway — Master Configuration & Source Tree (`MASTER-C`)

A local, multi-provider AI gateway that lets the **Claude Code CLI** talk to *any* backend model — Kiro (Claude), Google Antigravity, Gemini CLI, OpenAI Codex, OpenRouter, NVIDIA NIM, GitHub Models — through one OpenAI/Anthropic-compatible endpoint.

---

## What This Is

This repository is the **single source of truth** for a 2-tier AI gateway:

| Tier | Component | Port | Role |
|---|---|---|---|
| **Tier 1** | AIClient2API (Node.js) | `3000` | Provider auth, protocol translation, account-pool load balancing, and all three fallback levels |
| **Tier 2** | ZSH CLI router | — | `claude-pick` / `claude-swap` model menu, scoped env injection, mode toggle |

Claude Code talks **directly** to Tier 1's Anthropic-native endpoint — no middle proxy
re-serializes the stream, which keeps streaming clean and latency low. (An earlier LiteLLM
tier on `:4000` was removed; see `docs/ULTIMATE-GOAL.md` and `docs/archive/`.)

---

## Repository Structure

```
MASTER-C/
├── Credentials/          # Per-provider credential folders (gitignored)
├── AIClient2API/         # Tier 1 — Node.js gateway (port 3000)
├── docs/                 # Architecture, configuration, testing, troubleshooting
│   └── archive/          # Historical docs (incl. the removed LiteLLM tier)
└── CLAUDE.md             # Project guidance for Claude Code
```

---

## Request Flow

```
Claude Code CLI
   │
   ▼
[Tier 2] ZSH env injection  (claude-pick / claude-swap)
   │
   ▼
[Tier 1] AIClient2API  :3000  — provider auth, translation, fallback L1/L2/L3
   │
   ▼
External provider APIs  (Kiro · Antigravity · Gemini · Codex · OpenRouter · NIM · GitHub)
```

---

## Quick Start

```bash
# 1. Start the gateway (Tier 1)
start-proxies

# 2. Point Claude Code at the gateway and pick a model
claude-pick

# 3. (Optional) switch model mid-session
claude-swap
```

---

## Documentation

| Doc | Contents |
|---|---|
| `docs/ULTIMATE-GOAL.md` | Full architecture spec, success criteria |
| `docs/ARCHITECTURE.md` | Component breakdown, request lifecycle, fallback design |
| `docs/CONFIGURATION.md` | Every config file and env var explained |
| `docs/GETTING-STARTED.md` | First-run setup and model switching |
| `docs/DEVELOPMENT.md` | Local dev, adding providers/models, testing |
| `docs/TESTING.md` | Test suites and how to run them |
| `docs/Model-Guide.md` | Canonical model IDs and provider strings |
| `docs/Troubleshooting-and-Fixes.md` | Known issues and fixes |
| `docs/AIClient-BP.md` | AIClient2API best practices |

---

## Health Check

```bash
# Tier 1 gateway
curl -s http://127.0.0.1:3000/v1/models | jq '.data[].id'

# Or use the shell helper
proxy-status
```

---

## Notes

- **pnpm** is the package manager for Tier 1. Never use `npm install`.
- Credentials live in `Credentials/` (gitignored) — never commit them.
- The gateway auto-refreshes OAuth tokens; static-key providers (NIM, GitHub, OpenRouter) don't need refresh.
- Restart with `./AIClient2API/scripts/safe-restart.sh` (enforces the memory-headroom guard and triggers `live-verify.cjs`).
- See `CLAUDE.md` for the full operating manual.
