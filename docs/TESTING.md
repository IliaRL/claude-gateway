<!-- generated-by: gsd-doc-writer -->
# TESTING.md

Testing guide for the 3-Tier AI Gateway — unit tests, integration tests, smoke tests, and live proxy verification.

---

## Test Framework and Setup

### Tier 1 — AIClient2API (Node.js)

**Framework:** Jest 29.7.0 with Babel transpilation for ESM support.

**Config:** `Tier1-AIClient2API/jest.config.js`

- Test environment: `node`
- Test match pattern: `**/tests/**/*.test.js`
- Timeout: 30 000 ms per test
- Coverage directory: `Tier1-AIClient2API/coverage/`
- Coverage reporters: `text`, `lcov`, `html`

**Prerequisites:** Tier 1 dependencies must be installed first.

```bash
cd Tier1-AIClient2API && pnpm install
```

Integration tests (`tests/api-integration.test.js`) require Tier 1 to be running at `http://127.0.0.1:3000` before execution. Unit tests in `tests/unit/` run offline.

### Tier 2 — LiteLLM

Tier 2 has no project-level test suite. Health is verified through the live endpoint checks described in the [Proxy Health Verification](#proxy-health-verification) section.

---

## Running Tests

### Unit Tests (offline, no running server required)

```bash
cd Tier1-AIClient2API
pnpm test
```

Runs all `tests/unit/*.test.js` files:

| Test File | What it covers |
|---|---|
| `claude-converter-tool-use.test.js` | Claude format tool-use schema normalization |
| `gemini-converter-streaming.test.js` | Gemini SSE streaming chunk conversion |
| `grok-converter-streaming.test.js` | Grok streaming response conversion |
| `openai-converter-block-dedup.test.js` | REQ-03: `content_block_start` deduplication — same-index duplicate `function.name` chunks emit exactly one block start; parallel tool calls (different indices) each get their own |
| `openai-converter-gemini-response-json-guard.test.js` | F-03: `toGeminiResponse` with malformed JSON arguments — no `SyntaxError` thrown, valid `candidates` structure returned, tool name preserved |
| `openai-converter-tool-call-integrity.test.js` | OpenAI tool-call ID and name buffering |
| `openai-converter-tool-use.test.js` | OpenAI tool-use round-trip fidelity |
| `request-handlers-display-name.test.js` | buildFriendlyDisplayName: Claude prefix naming convention for /v1/models display_name (7 cases) |

### Watch Mode

```bash
cd Tier1-AIClient2API
pnpm run test:watch
```

Reruns affected tests on every file save. Use during active converter development.

### Verbose Output

```bash
cd Tier1-AIClient2API
pnpm run test:verbose
```

Prints each `it()` / `describe()` block result individually.

### Silent Mode

```bash
cd Tier1-AIClient2API
pnpm run test:silent
```

Suppresses console output from test code. Useful in CI where log noise obscures pass/fail summary.

### Coverage Report

```bash
cd Tier1-AIClient2API
pnpm run test:coverage
```

Generates coverage under `Tier1-AIClient2API/coverage/`. Open `coverage/index.html` in a browser for the HTML report.

No minimum coverage threshold is configured in `jest.config.js`.

### Integration Tests (requires live Tier 1)

```bash
# Start Tier 1 first
cd ~/AIClient2API && npm start

# In a separate shell, run integration tests
cd Tier1-AIClient2API
TEST_SERVER_BASE_URL=http://127.0.0.1:3000 TEST_API_KEY=$AICLIENT_TOKEN pnpm test tests/api-integration.test.js
```

`TEST_SERVER_BASE_URL` defaults to `http://127.0.0.1:3000` if unset. `TEST_API_KEY` defaults to `process.env.AICLIENT_TOKEN` (set by `~/dotfiles/zsh/zshrc`) if not passed explicitly. Any CI environment running integration tests must export `AICLIENT_TOKEN`.

The `/v1/models` (OpenAI-format) and `/v1beta/models` (Gemini-format) integration tests assert that every entry in the model list has a `display_name` field starting with `"Claude "`.

---

## Smoke Tests (Live Provider Verification)

Smoke tests hit real provider endpoints. They require Tier 1 to be running and at least one healthy provider account pool.

### Quick Smoke Test (~90 seconds, 7 suites, 5 models)

```bash
cd Tier1-AIClient2API
node scripts/master-smoke-test.cjs
```

Per-model checks performed by the smoke test:

| Check | Endpoint | Pass criterion |
|---|---|---|
| Non-streaming chat | `POST /v1/messages` | HTTP 200, content block present |
| Streaming response | `POST /v1/messages` (stream: true) | HTTP 200, at least 1 `data:` SSE chunk |
| Tool use | `POST /v1/messages` (tools array) | HTTP 200, `tool_use` block in response |

**Use this after any change to a converter, fallback chain, or provider adapter.**

### Full Test Suite (all 39 models, use after major changes only)

```bash
cd Tier1-AIClient2API
pnpm run test:suite
```

Equivalent to `node scripts/unified-test-suite.cjs`. This exercises every model across every provider. Allow 5–15 minutes depending on provider latency.

### Skill Reference Validation

```bash
cd Tier1-AIClient2API
bash scripts/validate-skills.sh
```

Asserts that all 62 assertion points in `Tier1-AIClient2API/.claude/skills/` still point to valid files and line numbers. Run after any refactor that moves or renames source files.

---

## Proxy Health Verification

These checks do not use Jest — they are direct HTTP probes against the running gateway.

### Is Tier 1 alive?

```bash
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/provider_health | jq .
```

A healthy response shows per-provider account status with `healthy: true` entries. Any provider showing all accounts as `429` or `error` indicates quota exhaustion or an authentication failure.

### Model list

```bash
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/v1/models | jq '.data[].id'
```

Should return all 39 model IDs. If the list is empty or truncated, check that `startupRun: false` is set in `configs/config.json` — a true value triggers a startup 429 storm that can corrupt the pool state.

### Recent Tier 1 logs

```bash
tail -50 /tmp/aiclient.log
```

Look for `[Warmup] failed=N` lines — a non-zero value means one or more OAuth adapters failed to pre-warm at startup, which will cause the first request through that adapter to be slow.

### Request/response trace logging

To inspect the exact payload transformation through the converter stack:

1. Edit `Tier1-AIClient2API/configs/config.json` — set `"PROMPT_LOG_MODE": "file"`.
2. Restart Tier 1 via `./scripts/safe-restart.sh`.
3. Send a request.
4. Read `Tier1-AIClient2API/logs/prompt_log_*.log`.

Reset `PROMPT_LOG_MODE` to `""` after debugging — log files grow quickly under load.

---

## End-to-End Request Flow Verification

A full end-to-end test validates every layer: Claude Code CLI → Tier 1 → provider.

**Step 1: Confirm active routing mode**

```bash
claude-mode-status
```

In proxy mode, `ANTHROPIC_BASE_URL` is `http://127.0.0.1:3000`. Claude Code routes directly to Tier 1 (Tier 2 / LiteLLM is bypassed in the current active path — see Issue 5 in `docs/Troubleshooting-and-Fixes.md`).

**Step 2: Send a test request through Claude Code**

Open Claude Code and issue any message. Then check:

```bash
cat /tmp/aiclient_last_model
```

The JSON object should include `provider`, `model`, `latencyMs`, `ttftMs`, and `fallbackCount`. A `fallbackCount` greater than 0 means the primary account was rate-limited and the request was rerouted.

**Step 3: Verify no SSE corruption**

SSE buffering is mitigated by `X-Accel-Buffering: no` headers injected in `src/ui-modules/oauth-api.js` and the `CLAUDE_CODE_STREAM_DELAY=50` env var set in the ZSH launcher. If Claude Code crashes with `Unexpected token in JSON`, confirm:

```bash
grep "X-Accel-Buffering" ~/AIClient2API/src/ui-modules/oauth-api.js
```

Should return at least one match. If the header is missing, the SSE buffering fix has been reverted by an upstream merge.

---

## CI Integration

No CI/CD pipeline is configured for this repository. All test execution is manual.

For the canonical test sequence after any non-trivial change:

```
1. pnpm test                        → unit tests pass (80 tests across 8 files)
2. node scripts/master-smoke-test.cjs   → live provider smoke passes
3. /provider_health shows ≥ 25 healthy accounts
4. cat /tmp/aiclient_last_model shows correct provider + fallbackCount=0
```

---

## Known Test Gotchas

- **Integration tests require `AICLIENT_TOKEN`** — export it from your shell before running, or pass `TEST_API_KEY` explicitly. `TEST_API_KEY` falls back to `process.env.AICLIENT_TOKEN`; the hardcoded literal fallback was removed. Any CI environment must export this variable.
- **Concurrent test file** (`tests/concurrent-test.js`) is not part of the Jest run. Execute it directly with `node tests/concurrent-test.js` when stress-testing the pool rotation logic.
- **Full suite duration** — `unified-test-suite.cjs` tests all 39 models sequentially. Do not run it while the proxy is serving live Claude Code traffic — it consumes quota across all provider pools.
- **SQLite state can override in-memory pool state** — if a test produces unexpected 429s after restart, check `pool_state.db` for corrupted `modelCooldowns` values (they must be objects, not the string `"[object Object]"`).
