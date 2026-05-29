<!-- generated-by: gsd-doc-writer; rewritten 2026-05-30 for 2-tier -->
# Getting Started

How to install, run, and use the 2-tier AI gateway.

---

## Prerequisites
- **Node.js 20** (`nvm use 20`) and **pnpm** (never `npm install` for Tier 1)
- **jq** (`brew install jq`) — used by the mode-toggle scripts
- Credentials present under `Credentials/` (one folder per provider)

---

## First Run

```bash
# 1. Install Tier 1 dependencies
cd ~/MASTER-C/AIClient2API && pnpm install

# 2. Start the gateway (memory-guarded; kills only the :3000/:3100 listeners)
./scripts/safe-restart.sh
#   …or from any shell:
start-proxies

# 3. Confirm it's up
curl -s -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/v1/models | jq '.data | length'
```

There is only **one** process to run — the AIClient2API gateway on `:3000`. (No LiteLLM tier.)

---

## Pointing Claude Code at the gateway

```bash
claude-proxy     # write gateway settings to ~/.claude/settings.json (ANTHROPIC_BASE_URL=:3000)
claude-native    # revert to native Anthropic auth (proxy keeps running)
claude-mode-status   # show current mode
```

`claude-proxy` also enables `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` so the in-session
`/model` command lists all backend models.

---

## Picking & switching models

```bash
claude-pick      # interactive menu (from :3000/v1/models) → starts gateway if offline → fresh session
claude-swap      # same menu mid-session → relaunches with `claude --continue`
```

Inside a session, `/model` switches to any configured backend model via gateway discovery.

---

## Health & diagnostics

```bash
proxy-status                                   # quick gateway health
curl -s http://127.0.0.1:3000/provider_health  # per-account detail
tail -50 /tmp/aiclient.log                      # gateway log
```

For structured diagnostics use the `proxy-repair` skill. For known issues see
`docs/Troubleshooting-and-Fixes.md`.

---

## Common first-run issues
- **Gateway won't start / "ABORT: reclaimable RAM < floor"** — free RAM (quit Antigravity IDE / Comet); the memory guard prevents a jetsam kernel panic (Issue 10).
- **`/model` shows nothing** — ensure `claude-proxy` ran (it sets the discovery env var); see Issue 1.
- **A provider 401s** — its static key/OAuth is dead; refresh via the `aiclient-credentials` skill (Issue 7).
