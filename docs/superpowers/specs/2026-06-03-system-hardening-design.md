# AIClient2API System Hardening — Design Spec

**Date:** 2026-06-03  
**Author:** Antigravity (generated from brainstorming session)  
**Status:** Approved for implementation

---

## Goal

Fix 6 identified issues in AIClient2API (Tier 1 gateway) to make the system fully production-hardened:
configuration correctness, protocol compliance, code cleanliness, test coverage, and runtime resilience.

---

## Background

A thorough audit of the MASTER-C project (2026-06-03) identified:
- A regression in `config.json` (SYSTEM_PROMPT_FILE_PATH not cleared as Issue 8 documented)
- Two dead providers with expired credentials polluting the fallback chain
- A missing global shell export breaking subagent tool access
- Dead commented-out code in the hot request path
- A leaking timer in the test suite
- Unverified `anthropic-beta`/`anthropic-version` header forwarding (required by Claude Code spec)
- ProviderPoolManager — the most critical file (2,600 lines) — having zero unit tests
- `restartCount` never resetting after long healthy uptime

---

## Approach: Phase-Gated, TDD, Ordered by Risk

All four phases execute sequentially. Each phase ends with a green test gate before the next starts.
Every code change follows TDD: write the failing test first, then implement the fix.

---

## Phase 1 — Config & Shell Fixes (zero code risk)

### 1.1 Fix SYSTEM_PROMPT_FILE_PATH regression
**File:** `AIClient2API/configs/config.json`, line 6  
**Change:** Set `SYSTEM_PROMPT_FILE_PATH` to `""`.  
**Why:** Issue 8 (FIXED 2026-05-29) documents this as the correct resolution. Leaving it non-empty creates the Kiro double-override refusal (identity + content prompt both arrive). The current absolute path also breaks portability.  
**Verify:** Start server; `SYSTEM_PROMPT_CONTENT` in logs must be empty.

### 1.2 Disable dead provider accounts
**File:** `AIClient2API/configs/provider_pools.json`  
**Change:** Set all `github-models` and `openai-custom` accounts to `"enabled": false`.  
**Why:** Both providers return persistent 401s (expired GitHub PAT + OpenRouter key). Issue 7 is OPEN. Keeping them active burns fallback budget on guaranteed failures.  
**Method:** Use the atomic write helper (`withFileLock` + `atomicWriteFile`) or the management API endpoint — never direct JSON edit.  
**Verify:** `GET /provider_health` returns those providers absent or unhealthy-disabled, not unhealthy-401-retrying.

### 1.3 Add ENABLE_TOOL_SEARCH global export
**File:** `~/dotfiles/zsh/zshrc`  
**Change:** Add `export ENABLE_TOOL_SEARCH=true` as a standalone global export (not only inline at `claude-pick` call sites).  
**Why:** Issue 11a — subagents spawned in `--resume` paths and IDE sessions don't inherit inline exports. This is a silent tool-use failure mode.  
**Verify:** Source zshrc, confirm `echo $ENABLE_TOOL_SEARCH` prints `true` in a fresh shell.

**Phase 1 Gate:** `pnpm test` → 21 suites / 156 tests green.

---

## Phase 2 — Dead Code & Leaking Timer

### 2.1 Remove dead apiService block
**File:** `AIClient2API/src/handlers/request-handler.js`  
**Change:** Remove the commented-out `apiService` fetch block (lines ~411–424) and the dead `let apiService;` declaration that is never assigned.  
**Why:** The variable is passed as `undefined` into `handleAPIRequests`, which works only because that function re-fetches it internally. The dead code misleads readers about the actual execution path.  
**Note:** No test needed for a removal; run the full suite to confirm nothing breaks.

### 2.2 Fix leaking timer in test suite
**Diagnosis:** Run `pnpm test -- --detectOpenHandles` to identify which test file or module leaves an active handle.  
**Expected root cause:** A `setInterval` (health-check scheduler or Cockpit keep-alive) not calling `.unref()` in module initialization, or a test file not clearing an interval in `afterAll()`.  
**Fix options (in order of preference):**
- Call `.unref()` on the interval in the module that creates it (preferred — doesn't affect production behavior)
- Add `afterAll(() => clearInterval(handle))` in the offending test file
**Verify:** `pnpm test` → no "worker process has failed to exit gracefully" warning.

**Phase 2 Gate:** `pnpm test` → 21 suites / 156 tests green + zero leaking-handle warning.

---

## Phase 3 — Protocol Compliance: Header Pass-Through Audit & Fix

### 3.1 Anthropic-beta / anthropic-version TDD
**Spec requirement** (`docs/ANTHROPIC_GATEWAY_SPEC.md`, line 26):  
- Anthropic Messages format endpoints MUST forward `anthropic-beta` and `anthropic-version` verbatim
- Non-Anthropic providers MUST strip these headers outbound

**Files affected:**
- `src/handlers/request-handler.js` — where headers are initially parsed
- `src/providers/adapters/claude-kiro.js` — must forward
- `src/providers/adapters/gemini-antigravity.js` — must strip
- `src/providers/adapters/gemini-cli-oauth.js` — must strip
- `src/providers/adapters/openai-codex.js` — must strip
- `src/providers/adapters/openai-custom.js` — must strip
- `src/providers/adapters/nvidia-nim.js` — must strip
- `tests/unit/header-passthrough.test.js` — NEW

**TDD test cases:**
1. `anthropic-beta` on inbound request → Kiro adapter outbound call includes it
2. `anthropic-version` on inbound request → Kiro adapter outbound call includes it
3. `anthropic-beta` on inbound request → Gemini adapter outbound call does NOT include it
4. `anthropic-version` on inbound request → Gemini adapter outbound call does NOT include it
5. Same as 3+4 for OpenAI, NVIDIA, Codex adapters
6. Request with NO `anthropic-beta` → Kiro outbound call has no `anthropic-beta` (no phantom injection)

**Audit approach:**  
For each adapter, identify where `headers` are assembled for the outbound fetch/axios call. Verify the header is forwarded (for Kiro) or that the constructed headers object doesn't include it (for others). Fix any non-compliant adapters.

### 3.2 Master server CORS tighten
**File:** `AIClient2API/src/core/master.js`, line ~265  
**Change:** `Access-Control-Allow-Origin: *` → `Access-Control-Allow-Origin: http://127.0.0.1`  
**Why:** Management endpoints (restart/stop/start) on `:3100` are local-only. A SSRF from any browser tab could trigger restarts with wildcard CORS.  
**No test required** (local-only server), note in commit message.

**Phase 3 Gate:** `pnpm test` → all suites pass (including new header-passthrough.test.js).

---

## Phase 4 — ProviderPoolManager Unit Tests + restartCount Reset

### 4.1 ProviderPoolManager unit test suite
**New file:** `tests/unit/provider-pool-manager.test.js`

**9 behaviors to test:**

| # | Behavior | Test strategy |
|---|----------|--------------|
| 1 | Provider selection picks healthy account | Mock pool with 1 healthy + 1 on cooldown; assert healthy selected |
| 2 | L1 vertical fallback — exhausts all accounts | All accounts in cooldown; assert L1 exhaustion error propagated |
| 3 | L2 horizontal fallback — tries next provider in chain | Primary provider accounts all fail; assert secondary provider in chain is tried |
| 4 | L3 tiered downgrade — downgrades model after full horizontal exhaustion | All providers for model fail; assert next model in `modelFallbackMapping` is requested |
| 5 | L3 cycle guard | Create circular `modelFallbackMapping`; assert error thrown (no infinite loop) |
| 6 | Cross-family downgrade warning | Map `claude-opus-*` → `gemini-*`; assert logger.warn called with cross-family message |
| 7 | Cooldown manager — account enters cooldown on 429 | Inject 429; assert account `onCooldown` returns true, self-clears after timeout |
| 8 | Cockpit penalty scoring pre-filters exhausted accounts | Set account quota to 100%; assert it is skipped in selection |
| 9 | Refresh queue concurrency cap | Fire N refreshes where N > `REFRESH_CONCURRENCY_PER_PROVIDER`; assert at most cap concurrent at one time |

**Testing approach:**
- Use Jest module mocks to isolate pool manager from real provider adapters
- Use `jest.useFakeTimers()` for cooldown tests (avoid real delays)
- Use constructor injection or module-level state reset for pool state

### 4.2 restartCount reset in master.js
**File:** `AIClient2API/src/core/master.js`  
**Change:** In `scheduleRestart()`, before computing exponential backoff delay, check if the worker was alive for ≥ 60 s. If so, reset `restartCount` to 0. This prevents a single crash after hours of healthy uptime from inheriting a 30 s restart penalty.

```javascript
// Before the existing backoff calculation:
const uptime = Date.now() - workerStatus.startTime;
if (uptime >= 60_000) {
    workerStatus.restartCount = 0;
}
// Existing: const delay = Math.min(config.restartDelay * Math.pow(2, workerStatus.restartCount), 30000);
```

**TDD:** Write test asserting that after 60+ s uptime, restart delay equals `config.restartDelay` (base delay, exponent = 0), not `30000`.

**Phase 4 Gate:** `pnpm test` → all suites pass (156 + new provider-pool-manager.test.js tests + restartCount test).

---

## Success Criteria

1. `pnpm test` → green with zero warnings after every phase
2. `SYSTEM_PROMPT_FILE_PATH` is `""` in `config.json`
3. `github-models` and `openai-custom` do not appear as actively-retrying in `/provider_health`
4. `echo $ENABLE_TOOL_SEARCH` → `true` in a fresh shell after re-sourcing zshrc
5. No commented-out dead code block in `request-handler.js`
6. `pnpm test -- --detectOpenHandles` exits cleanly with no leaking handles
7. `anthropic-beta` and `anthropic-version` forwarded to Kiro, stripped from all other providers (verified by tests)
8. ProviderPoolManager has unit tests for all 9 critical behaviors
9. Master server CORS on `:3100` is locked to `127.0.0.1`
10. Worker restart after long healthy uptime uses base restart delay, not accumulated 30 s maximum

---

## Out of Scope

- Re-credentialing `github-models` or `openai-custom` (tracked separately)
- Resolving Kiro identity reveal / refusals (inherent to CodeWhisperer backend — Issue 9)
- Upgrading Jest to v30
- Replacing lodash with native ES methods
- ProviderPoolManager integration tests (L1→L2→L3 full chain with real providers)
