<!-- generated-by: gsd-doc-writer; rewritten 2026-05-30 for 2-tier -->
# Development Guide

Local development for Tier 1 (AIClient2API). Tier 2 is shell config in `~/dotfiles`.

---

## Setup & run

```bash
cd ~/MASTER-C/AIClient2API
pnpm install                 # NEVER npm install
./scripts/safe-restart.sh    # start/restart (memory-guarded; only kills :3000/:3100)
pnpm run start:dev           # dev mode
```

---

## Tests

```bash
pnpm test                          # Jest — unit + integration (11 suites, 95 tests)
node scripts/master-smoke-test.cjs # quick live smoke (7 suites, ~5 models, ~90s)
node scripts/unified-test-suite.cjs# full live suite (all models) — after major changes
bash scripts/validate-skills.sh    # assert skill reference points still resolve
```

Integration tests require the gateway running at `:3000`; unit tests (`tests/unit/`) run offline.

---

## Adding a model

1. Add the exact model ID to the right provider array in `src/providers/provider-models.js`.
   - **Keep this file static & synchronous** — no `await`, no live API calls (it's read on every model-list call).
   - Use the provider's exact, versioned string. A mismatch = silent 404.
2. If it's an `openai-custom` (OpenRouter) model, add it to `configs/custom_models.json` instead.
3. Restart and confirm it appears: `curl -s …/v1/models | jq '.data[].id'`.

## Adding a provider

1. Create an adapter under `src/providers/<name>/` and register it in `src/providers/adapter.js`.
2. Choose a converter strategy in `src/convert/` (which native format ↔ OpenAI/Anthropic).
3. Add the provider type to `MODEL_PROVIDER` in `config.json` and a pool entry in `provider_pools.json`.
4. Add it to `providerFallbackChain` (and `modelFallbackMapping` where relevant).
5. Static-key providers must **not** set `needsReauth` and don't implement `refreshToken()`.

## Editing fallback routing

- `providerFallbackChain` (Level 2) and `modelFallbackMapping` (Level 3) live in `config.json`.
- After any change, verify no dangling targets and no cycles (use the `tier-config-auditor` agent or the validation pattern in `docs/CONFIGURATION.md`).

---

## Debugging

- Enable raw request/response capture: set `"PROMPT_LOG_MODE": "file"` in `config.json`, restart, reproduce, then read `logs/prompt_log_*.log`. This is the source of truth for protocol/converter bugs.
- Gateway log: `/tmp/aiclient.log`. Per-account health: `/provider_health`.
- State lives in the in-memory pool **and** SQLite (`src/utils/db.js`) — a corrupted SQLite row overrides healthy in-memory state on restart.

---

## Conventions & safety
- **pnpm only.** Restart **only** via `./scripts/safe-restart.sh`.
- Never `git add -A` — `config.json` and `provider_pools.json` hold secrets (gitignored).
- Commit `provider_pools.json` only when explicitly instructed, via the GitHub Contents API.
- Match existing style; keep changes surgical. Run `pnpm test` before and after.
