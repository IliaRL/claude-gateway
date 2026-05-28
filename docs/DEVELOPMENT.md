<!-- generated-by: gsd-doc-writer -->
# DEVELOPMENT.md

Developer guide for working on the 3-Tier AI Gateway. Covers local setup, build and test commands, safe editing workflow, and how to add providers or models.

---

## Local Setup

### Prerequisites

- **Node.js** v20 (managed via nvm — `nvm use 20`)
- **pnpm** — required for all Node.js operations in Tier 1; never use `npm install`
- **Python 3.12.11** — managed via pyenv; the Tier 2 `.venv/` already exists at this version
- **Git**

### Cloning and installing

Tier 1 source lives at `~/AIClient2API/` on disk. `Tier1-AIClient2API/` is a directory copy of that source — changes to one do not automatically propagate to the other. Do not glob or scan inside it — `node_modules` (187 MB) and `.git` (11 MB) live there.

```bash
# Install Tier 1 dependencies (pnpm only — never npm install)
cd ~/AIClient2API && pnpm install
```

Tier 2 dependencies are pre-installed in `Tier2-LiteLLM/.venv/` via `uv sync`. **Never recreate this environment** or run `pip install`, `make install-*`, or `uv sync` again. The correct Python binary is already at:

```
/Users/ilialiston/MASTER-C/Tier2-LiteLLM/.venv/bin/litellm
```

### Credentials

All credentials are sourced from `/Users/ilialiston/MASTER-C/Credentials/`, one subfolder per provider:

```
Credentials/
├── claude-kiro-oauth/
├── gemini-antigravity/
├── gemini-cli-oauth/
├── github-models/
├── nvidia-nim/
├── openai-codex-oauth/
└── openai-custom/
```

Never hardcode credential values in source files. `configs/provider_pools.json` contains live OAuth tokens — never stage it with `git add -A` or `git add .`.

---

## Build Commands

All commands run from inside `Tier1-AIClient2API/` (i.e., `~/AIClient2API/`).

| Command | Description |
|---|---|
| `pnpm start` | Start Tier 1 in production mode (`node src/core/master.js`) |
| `pnpm run start:dev` | Start Tier 1 in dev mode (same entrypoint, `--dev` flag) |
| `pnpm run start:standalone` | Start the API server only (`src/services/api-server.js`) |
| `pnpm test` | Run all tests via Jest |
| `pnpm run test:silent` | Run tests with suppressed console output |
| `pnpm run test:coverage` | Run tests with coverage report (output in `coverage/`) |
| `pnpm run test:verbose` | Run tests with verbose output |
| `pnpm run test:watch` | Watch mode — reruns on file change |
| `pnpm run test:suite` | Full unified test suite across all 39 models (`scripts/unified-test-suite.cjs`) |
| `pnpm run sync-creds` | Sync credentials from `Credentials/` to `configs/` (`scripts/sync-credentials.js`) |
| `pnpm run build:native` | Build the native Rust tokenizer (requires Cargo) |
| `pnpm run help` | Show available CLI commands |

### Quick smoke test (preferred before full suite)

```bash
node scripts/master-smoke-test.cjs   # 7 suites, 5 models, ~90 seconds
```

Use the full unified test suite only after major changes:

```bash
node scripts/unified-test-suite.cjs  # all 39 models — runs several minutes
```

---

## Startup Order (CPU Safety — Apple Silicon)

**This rule is non-negotiable.** Starting tiers in the wrong order causes an immediate CPU spike.

1. Start Tier 1 first and wait for it to be healthy.
2. Only then start Tier 2.

```bash
# Preferred: use the shell alias (enforces correct order automatically)
start-proxies

# Manual Tier 1 start
cd ~/AIClient2API && pnpm start

# Manual Tier 2 start — only after Tier 1 passes health check
/Users/ilialiston/MASTER-C/Tier2-LiteLLM/.venv/bin/litellm \
  --config /Users/ilialiston/MASTER-C/Tier2-LiteLLM/litellm_config.yaml \
  --port 4000
```

LiteLLM fires approximately 80 concurrent health-check requests at Tier 1 on startup. If Tier 1 is still initializing, this causes a connection storm and pegs CPU at 100%. The `start-proxies` alias and `scripts/safe-restart.sh` enforce sequential startup — use them.

**Additional CPU restrictions for Tier 2:**
- Do not use `--watch` or `--hot-reload`
- Do not enable `routing_strategy: latency-based` in `litellm_config.yaml` — this polls upstream endpoints in a tight loop on macOS
- Do not glob, list, or scan inside `Tier2-LiteLLM/litellm/`, `.venv/`, `tests/`, `ui/`, `enterprise/`, `docs/`, or `cookbook/`

### Safe restart

```bash
./scripts/safe-restart.sh   # kills only the port-3000 listener; safe to run at any time
```

---

## Safe Editing Workflow

Before editing any core Tier 1 file, follow this sequence:

1. **Read the skill first.** For any file under `src/`, `configs/`, or `scripts/`, read `aiclient-master` at `Tier1-AIClient2API/.claude/skills/` before touching anything.
2. **Run the preflight skill** (`aiclient-preflight`) before editing `adapter.js`, `provider-models.js`, `utils.js`, or any converter.
3. **Read the file before editing it.** Never assume current state — check `configs/config.json` before modifying it; search `src/providers/provider-models.js` before adding a model ID.
4. **Verify after changes.** Check `/provider_health` endpoint shows ≥25 healthy accounts. Run the smoke test before claiming anything works.

```bash
# Health check
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/provider_health | jq .

# Model list
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/v1/models | jq '.data[].id'
```

**Key files and their roles:**

| File | Role | Edit caution |
|---|---|---|
| `src/core/master.js` | Process entrypoint | High — starts all services |
| `src/core/config-manager.js` | Config loading and validation at startup | High |
| `src/providers/provider-models.js` | Canonical model ID map — must stay synchronous, no `await` | High |
| `src/providers/provider-pool-manager.js` | Account pool load balancing and cooldown state | High |
| `src/handlers/request-handler.js` | OpenAI-compatible endpoint handlers | Medium |
| `src/converters/` and `src/convert/` | Format translation between OpenAI spec and native provider APIs | High |
| `src/auth/` | API key injection and validation | High |
| `configs/config.json` | Runtime configuration | Read before every edit |
| `configs/provider_pools.json` | Live OAuth credentials — never commit without explicit instruction | Critical |
| `Tier2-LiteLLM/litellm_config.yaml` | LiteLLM model list and router settings | Safe to edit |

---

## Adding a New Provider

Before starting, read the `aiclient-providers` skill.

1. Create the adapter directory under `src/providers/<provider-name>/`.
2. Add the provider's model IDs to `src/providers/provider-models.js`. Model IDs must be versioned strings (e.g., `claude-sonnet-4-5-20250929`, not `claude-sonnet-4-6`). This file must remain **synchronous** — no `await` or live API calls.
3. Add the provider to `src/core/plugin-manager.js` for orchestration.
4. Add credential files under `Credentials/<provider-name>/` and reference them via `configs/provider_pools.json`.
5. Add the corresponding model entries to `Tier2-LiteLLM/litellm_config.yaml` using the `openai/` prefix:

```yaml
- model_name: "my-new-model"
  litellm_params:
    model: "openai/my-new-model"
    api_base: "http://127.0.0.1:3000/v1"
    api_key: "os.environ/AICLIENT_API_KEY"
```

6. Verify end-to-end: start both tiers, hit `/v1/models`, confirm the new model appears, then run a single request through it.

The model string in `litellm_config.yaml` (after the `openai/` prefix) must exactly match the key in `src/providers/provider-models.js`. A mismatch produces a silent 404 — this is the most common failure when adding providers.

---

## Adding a New Model to an Existing Provider

1. Read the `aiclient-models` skill before proceeding.
2. Search `src/providers/provider-models.js` to confirm the model ID is not already present — duplicate entries shadow each other silently.
3. Add the model ID with its context window size. Check `docs/Model-Guide.md` for verified model IDs and context window values.
4. Add a corresponding entry to `Tier2-LiteLLM/litellm_config.yaml`.
5. Optionally add a short-name alias entry in `litellm_config.yaml` pointing to the versioned model name.
6. Run the smoke test to confirm routing works.

---

## Testing

Tests live in `Tier1-AIClient2API/tests/` and use Jest with Babel for ESM support (`"type": "module"` in `package.json`). The test timeout is 30 seconds per test.

### Auth token requirement

Tests require the `AICLIENT_TOKEN` environment variable (or `TEST_API_KEY`) to be set. There is no hardcoded fallback — tests will fail with an auth error if neither variable is present.

```bash
export AICLIENT_TOKEN=your-token-here
```

### Running tests

```bash
# All tests (run from ~/AIClient2API)
cd ~/AIClient2API && pnpm test

# Unit tests only
pnpm run test:unit

# Integration tests only (requires Tier 1 running on :3000)
pnpm run test:integration

# Single file
pnpm test tests/path/to/file.test.js

# With coverage
pnpm run test:coverage
```

Integration tests require Tier 1 to be running on port 3000 before they are invoked.

### Coverage

Coverage is collected from `src/**/*.js`, excluding test files and `node_modules`. Reports are written to `coverage/` in text, lcov, and HTML formats. No minimum coverage threshold is configured — coverage reports are informational.

### Writing new tests

Test files follow the `*.test.js` naming convention and live under `tests/`. Unit tests go in `tests/unit/`; integration tests go in `tests/api-integration.test.js` or alongside it. The project uses ESM imports throughout — use `import` not `require`.

Notable unit test files:
- `tests/unit/request-handlers-display-name.test.js` — verifies the `display_name` naming convention; exercises `buildFriendlyDisplayName`, which is exported from `src/utils/request-handlers.js` for testability.

### Debugging test failures

Enable request/response logging before reproducing:

```bash
# In configs/config.json, set:
# "PROMPT_LOG_MODE": "file"
# Then restart Tier 1 and reproduce the failure
# Logs appear in logs/prompt_log_*.log
```

---

## Debugging

### PROMPT_LOG_MODE

Set `"PROMPT_LOG_MODE": "file"` in `configs/config.json` to capture full request/response payloads to `logs/prompt_log_*.log`. Useful for diagnosing converter failures, malformed tool-use payloads, and SSE stream corruption.

### proxy-debugger agent

Invoke the `proxy-debugger` custom agent for any 429, 502, auth error, or model ID mismatch across Tier 1 or Tier 2. It runs structured diagnostics across both tiers.

### aiclient-debug skill

Read the `aiclient-debug` skill (`Tier1-AIClient2API/.claude/skills/`) for request tracing, latency analysis, and `ECONNREFUSED` diagnosis patterns.

---

## Code Style

There is no linter or formatter configured for this project. Match the existing style in each file you edit:

- ES modules (`import`/`export`) throughout Tier 1 — `"type": "module"` in `package.json`
- No TypeScript — plain JavaScript only
- `provider-models.js` must stay synchronous — no async/await, no live API calls

---

## Branch and PR Conventions

No formal branch naming convention is documented. Based on recent commit history, the project uses conventional commit prefixes: `feat(scope):`, `fix(scope):`, `docs(scope):`.

Tier 1 commits must not include `configs/provider_pools.json` unless explicitly instructed — it contains live OAuth tokens. Always specify files individually when staging; never use `git add -A` or `git add .`.

Before committing provider or routing changes, confirm `/provider_health` shows ≥25 healthy accounts.

---

## Reference Docs

| Document | When to read |
|---|---|
| `docs/ULTIMATE-GOAL.md` | Full architecture spec — read before any structural change |
| `docs/Model-Guide.md` | Verified model IDs, provider strings, context windows |
| `docs/AIClient-BP.md` | AIClient2API operational best practices |
| `docs/LiteLLM-BP.md` | LiteLLM configuration best practices |
| `docs/Architecture-and-Proxy-Integration.md` | SSE buffering rules, env vars, header pass-through |
| `docs/Troubleshooting-and-Fixes.md` | Known issues registry with root causes and fix status |
| `docs/ANTHROPIC_GATEWAY_SPEC.md` | Official Claude Code LLM gateway wire protocol |
| `Tier1-AIClient2API/CLAUDE.md` | Project rules, quick commands, skill routing table |
