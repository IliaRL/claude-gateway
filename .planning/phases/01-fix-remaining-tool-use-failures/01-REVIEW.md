---
phase: 01-fix-remaining-tool-use-failures
reviewed: 2026-05-28T00:00:00Z
depth: deep
files_reviewed: 7
files_reviewed_list:
  - src/converters/strategies/OpenAIConverter.js
  - src/providers/provider-models.js
  - src/providers/provider-pool-manager.js
  - src/utils/request-handlers.js
  - src/utils/response-cache.js
  - tests/api-integration.test.js
  - src/providers/claude/claude-kiro.js
findings:
  critical: 5
  warning: 8
  info: 4
  total: 17
status: issues_found
---

# Phase 01: Code Review Report — Deep

**Reviewed:** 2026-05-28  
**Depth:** deep  
**Files Reviewed:** 7  
**Status:** issues_found

---

## Summary

Phase 01 introduced streaming deduplication guards, multi-beta header support for Kiro, Gemini native-format detection in the unary path, cache key isolation by protocol, and a 30-second models-list cache. The core logic is generally sound. However, the review surfaces five blockers: a memory leak in `streamParams` on any abnormal stream termination, a broken regex in the bracket-tool-call cleanup that silently removes no text, a hardcoded API key in the test suite that will leak into source control, a shared mutable test-data object that causes cross-test pollution, and a missing `anthropic-beta` multi-value header construction that makes the Phase 01 Kiro multi-beta feature a no-op for interleaved-thinking. Warnings cover race conditions in the token bucket throttle, cache false-negative for tool-less requests, and several logic gaps.

---

## Critical Issues

### CR-01: `streamParams` Map leaks on abnormal stream termination (memory leak / state corruption)

**File:** `src/converters/strategies/OpenAIConverter.js:656`  
**Severity:** Critical  
**Description:** `this.streamParams.delete(stateKey)` is called only when a `finish_reason` chunk is received (line 656). If the upstream provider closes the connection early, throws, or the TTFT abort fires (`nativeStream.return()` / `.destroy()`), the `for await` loop exits without ever receiving a `finish_reason` chunk. The stateKey entry is never deleted. On a long-running server with concurrent requests, this is an unbounded memory leak. Worse, if `requestId` is reused (the `req_${Date.now()}_${random}` scheme has collisions under high concurrency), the stale state from a previous failed request will corrupt the next stream that shares the key — emitting an extra `message_start` will be suppressed and content_block_delta events will target the wrong block index.

**Impact:** Memory grows without bound on streams that fail mid-way. Under high concurrency, state key collisions produce malformed Claude SSE event sequences, breaking tool-use parsing on the client.

**Fix:**  
Call `streamParams.delete(stateKey)` in the `finally` block of `handleStreamRequest`, or expose a `cleanupStream(stateKey)` method on the converter and call it there. The simplest fix inside the converter is to ensure cleanup on all exit paths:

```js
// In toClaudeStreamChunk, change the finish_reason branch:
if (finishReason) {
    // ... existing event push logic ...
    this.streamParams.delete(stateKey);
}
// Add a separate cleanup entry point called by handleStreamRequest's finally block:
cleanupStreamState(stateKey) {
    this.streamParams.delete(stateKey);
}
```

Then in `handleStreamRequest` (request-handlers.js), in the `finally` block, call `converter.cleanupStreamState(streamRequestId)` unconditionally.

---

### CR-02: Bracket tool-call cleanup regex is broken — silently removes nothing

**File:** `src/providers/claude/claude-kiro.js:2098-2100` and `1630-1636`  
**Severity:** Critical  
**Description:** Both cleanup sites construct a regex to strip `[Called <name> with args: {...}]` from response text. The pattern string uses double-escaped sequences like `\\\\[Called\\\\s+` which, after JS string interpretation, becomes the literal regex `/\\[Called\\s+.../` — matching a literal backslash followed by `[Called`, not the bracket character `[`. The regex never matches the target text. Tool-call markers remain in `fullContent` / `fullResponseText` and are returned to the client as plain text prepended to the actual response.

**Impact:** Any response that triggers the bracket-tool-call fallback path (`parseBracketToolCalls`) will include raw `[Called tool with args: {...}]` syntax in the text content sent to Claude Code, corrupting the visible output and potentially causing downstream JSON parse failures.

**Fix:**
```js
// Correct pattern — single escape for the regex literal, no double-escaping:
const pattern = new RegExp(
    `\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[\\s\\S]*?\\}\\]`,
    'g'
);
```

Apply the same correction at both line ~2098 and line ~1633.

---

### CR-03: Hardcoded API key in test file committed to source control

**File:** `tests/api-integration.test.js:19`  
**Severity:** Critical  
**Description:** `const TEST_API_KEY = process.env.TEST_API_KEY || 'sk-a60f3efdf9b97e63c84ab4a3583f9d1c';` embeds a literal API key as a fallback. Even if this is a test/proxy key, committing authentication credentials to source control violates security policy and will appear in git history permanently. Any contributor with repo access — or any future public exposure of this repo — reveals the key.

**Impact:** Credential exposure. If this key grants access to the running proxy (which it does — `isAuthorized` checks it), any party who reads the file can authenticate against the proxy and consume upstream provider quota.

**Fix:**
```js
// Remove the hardcoded fallback entirely:
const TEST_API_KEY = process.env.TEST_API_KEY;
if (!TEST_API_KEY) {
    throw new Error('TEST_API_KEY environment variable must be set before running integration tests');
}
```

Additionally, rotate the key `sk-a60f3efdf9b97e63c84ab4a3583f9d1c` immediately, as it is now in git history.

---

### CR-04: Shared mutable `REAL_TEST_DATA` object causes cross-test state pollution

**File:** `tests/api-integration.test.js:167-168, 192, 231, 254`  
**Severity:** Critical  
**Description:** Multiple tests mutate `REAL_TEST_DATA.openai.nonStreamRequest.model` and `REAL_TEST_DATA.claude.nonStreamRequest.model` directly (e.g., lines 167-168, 231, 254). Because `REAL_TEST_DATA` is a module-level constant shared across all tests in the suite, mutations from one test persist into subsequent tests regardless of execution order. Jest does not guarantee a fixed ordering within a `describe` block when tests run in parallel or are filtered with `-t`. The "streaming with Claude provider" test at line 254 reads `REAL_TEST_DATA.claude.nonStreamRequest` (the non-stream variant) while asserting on streaming headers — it appears to be sending the wrong body already because line 253-254 sets the non-stream model rather than the stream request's model.

**Impact:** Test results are order-dependent and non-deterministic. A test that passes in isolation may fail when the full suite runs. This makes the CI signal unreliable and masks regressions.

**Fix:**
```js
// In each test, clone before mutating:
const requestBody = { ...REAL_TEST_DATA.openai.nonStreamRequest, model: 'openai-custom:deepseek/deepseek-v4-flash:free' };
const response = await makeRequest(url, 'POST', 'bearer', headers, requestBody);
```

Or restructure REAL_TEST_DATA as a factory function that returns fresh objects.

---

### CR-05: Kiro multi-beta header is a string concatenation no-op — interleaved-thinking beta never sent

**File:** `src/providers/claude/claude-kiro.js:1741-1744`  
**Severity:** Critical  
**Description:** The Phase 01 implementation intention was to send multiple `anthropic-beta` values (tools-2024-04-04, prompt-caching-2024-07-31, interleaved-thinking-2025-05-14) to Kiro. The code at line 1741-1744 only sets a single `anthropic-beta` header value conditioned on `hasCacheControl`. There is no code path that appends `interleaved-thinking-2025-05-14` or `tools-2024-04-04` to the request headers. The `_autoInjectPromptCaching` method adds cache_control marks to the body, so `hasCacheControl` will be true for most requests — but this only sends the caching beta, not the thinking beta. The Kiro endpoint requires `interleaved-thinking-2025-05-14` to enable thinking block streaming; without it, thinking content is silently dropped by the upstream.

**Impact:** Thinking mode (claude-sonnet-4-6-thinking, explicit `thinking: {type: 'enabled'}`) produces responses with no thinking blocks even when requested. This is the core Phase 01 feature and it does not function as implemented.

**Fix:**
```js
// Replace the single-beta assignment with a multi-value header:
const betas = ['tools-2024-04-04', 'prompt-caching-2024-07-31'];
const hasThinking = body.thinking && body.thinking.type !== 'disabled';
if (hasThinking) betas.push('interleaved-thinking-2025-05-14');
// hasCacheControl check is no longer the gate — always send caching beta:
const betaHeader = model.startsWith('amazonq') ? 'x-amzn-kiro-amazonq-beta' : 'anthropic-beta';
headers[betaHeader] = betas.join(',');
```

---

## Warnings

### WR-01: Kiro throttle queue — `releaseCurrent` may be called before assignment

**File:** `src/providers/claude/claude-kiro.js:114-135`  
**Severity:** Warning  
**Description:** `acquireKiroRequestSlot` builds a chain: `kiroThrottleQueue = previous.then(() => new Promise(resolve => { releaseCurrent = resolve; }))`. The closure captures `releaseCurrent` by reference, but if `minIntervalMs <= 0` the function returns early on line 112. Under extremely tight timing (microtask interleaving), if `previous` resolves synchronously, the `then` callback runs before `releaseCurrent` is assigned in the outer scope — though in practice JS is single-threaded, the pattern is fragile and would break under any future refactor that introduces `await` before the assignment. The `released` guard at line 131 prevents the worst case, but the returned release function closes over `releaseCurrent` which remains `undefined` if the inner `.then` has not yet fired.

**Fix:** Assign `releaseCurrent` to a no-op default before the Promise constructor:
```js
let releaseCurrent = () => {};
kiroThrottleQueue = previous.then(() => new Promise(resolve => {
    releaseCurrent = resolve;
}));
```

---

### WR-02: Response cache skips caching when `temperature` is `undefined` — intended behaviour undocumented

**File:** `src/utils/response-cache.js:33-35`  
**Severity:** Warning  
**Description:** The condition `if (temp != null && temp !== 0) return null` means a request with no `temperature` field (undefined) is treated as cacheable. This is intentional only if the adapter always defaults to temperature 0 for unset requests — but adapters like Gemini and OpenAI default to non-zero temperatures when the field is absent. Caching a response produced at temperature > 0 and returning it for a subsequent request with temperature undefined will produce deterministic-looking results for what is actually a non-deterministic operation. The comment says "never cache non-deterministic requests" but the implementation allows them through.

**Fix:** Cache only when temperature is explicitly `0`:
```js
if (temp == null || temp !== 0) return null;
```
Or document clearly that "undefined temperature" is treated as cacheable by policy and accepted as a risk.

---

### WR-03: `_doSelectProvider` mutates `availableProviders` in-place via `.sort()`, breaking concurrent callers

**File:** `src/providers/provider-pool-manager.js:1121`  
**Severity:** Warning  
**Description:** `availableAndHealthyProviders.sort(...)` sorts in-place. `availableAndHealthyProviders` is derived from `availableProviders` (the raw `this.providerStatus[providerType]` array) without a copy via `filter()` — `filter()` returns a new array, so the sort is on a copy, which is safe. However, the sort at line 1121 is still performed on the filtered copy each time. The mutex (`_isSelecting`) guards re-entrant calls on the same event loop tick, but `setImmediate`-based resolution means two calls can interleave at the `await new Promise(resolve => setImmediate(resolve))` boundary (line 1046). The selection lock is released in `finally`, but if two concurrent requests both pass the `while` loop, one may observe a mid-sort state. This is a latent race under Node's cooperative scheduler.

**Fix:** Use `.slice().sort()` explicitly to document intent and ensure the in-memory pool array is never sorted:
```js
const selected = [...availableAndHealthyProviders].sort((a, b) => { ... })[0];
```

---

### WR-04: `getCachedAvailableModels` cache is not invalidated when a new provider type is added at runtime

**File:** `src/providers/provider-pool-manager.js:1717-1728`  
**Severity:** Warning  
**Description:** `invalidateModelsCache()` is called from `_logHealthStatusChange`, which fires on health state transitions. However, `initializeProviderStatus` (called on hot-reload) does not call `invalidateModelsCache`. If the admin adds a new provider type via config reload, the 30-second cached model list will not include the new provider's models until the cache naturally expires or a health event fires.

**Fix:** Add `this.invalidateModelsCache()` at the end of `initializeProviderStatus`.

---

### WR-05: `buildClaudeToolChoice` returns `{ type: undefined }` for unknown string values

**File:** `src/converters/strategies/OpenAIConverter.js:696-699`  
**Severity:** Warning  
**Description:** When `toolChoice` is a string not in `{ auto, none, required }`, `mapping[toolChoice]` is `undefined`, and the function returns `{ type: undefined }`. Claude's API will reject this with a 400 error. The `default` case is silently swallowed.

**Fix:**
```js
const type = mapping[toolChoice];
if (!type) return undefined; // Unknown string value → omit tool_choice
return { type };
```

---

### WR-06: `_generateThinkingPrefix` uses HTML-encoded Unicode escapes — Kiro receives literal `\x3C` strings

**File:** `src/providers/claude/claude-kiro.js:992-1000`  
**Severity:** Warning  
**Description:** The prefix strings use `\\x3C` (a 4-character literal backslash-x-3-C escape in the source), not `\x3C` (the actual `<` character). In a JS string literal `'\\x3C'` is `\x3C` (4 chars), not `<`. So the generated prefix is `\x3Cthinking_mode>enabled\x3C/thinking_mode>...` which Kiro sees as a literal string, not XML tags. Kiro's thinking mode parser will not recognise these and will not enable thinking.

**Fix:**
```js
// Use actual angle-bracket characters:
return `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
// and:
return `<thinking_mode>adaptive</thinking_mode><thinking_effort>${normalizedEffort}</thinking_effort>`;
```

---

### WR-07: `toGrokRequest` imports `ConverterFactory` as always-null dead code

**File:** `src/converters/strategies/OpenAIConverter.js:1516`  
**Severity:** Warning  
**Description:** Line 1516 contains `const { ConverterFactory } = (import.meta.url ? { ConverterFactory: null } : { ConverterFactory: null });` — both branches produce `null`. This is dead code that was never cleaned up. `ConverterFactory` is unused. This is a code smell and any linter will flag it, but it also signals that the Grok request conversion path is incomplete and may be silently passing raw OpenAI payloads to the Grok adapter when a real conversion was intended.

**Fix:** Remove lines 1516-1519 entirely. If Grok conversion is needed, import the factory properly.

---

### WR-08: `loadCredentials` overwrites `expiresAt` from target file with the first sidecar file found

**File:** `src/providers/claude/claude-kiro.js:717`  
**Severity:** Warning  
**Description:** In `loadCredentials`, after loading `targetCredentials`, the loop over other JSON files in the directory does: `credentials.expiresAt = mergedCredentials.expiresAt` (line 717) — this copies the expiry from the already-loaded target into the sidecar, then `Object.assign(mergedCredentials, credentials)`. This means any sidecar file that contains its own `expiresAt` field will have it overwritten with the target file's value before being merged. If the sidecar has a different (potentially later) expiry, the more accurate value is discarded. This can cause premature token refresh attempts.

**Fix:** Only copy `expiresAt` from sidecar to merged if the sidecar does not have its own value:
```js
if (!credentials.expiresAt) {
    credentials.expiresAt = mergedCredentials.expiresAt;
}
```

---

## Info

### IN-01: `getConfiguredSupportedModels` hard-caps at 15 models without documentation

**File:** `src/providers/provider-models.js:298`  
**Severity:** Info  
**Description:** `return models.slice(0, 15)` silently truncates the supported model list to 15 entries for managed-list providers. There is no log warning, no config override for the cap, and no documentation explaining why 15 was chosen. If an operator configures more than 15 models, the excess are silently dropped from routing eligibility.

**Fix:** Either make the cap configurable or log a warning when truncation occurs:
```js
if (models.length > 15) {
    logger.warn(`[provider-models] ${providerType}: configured ${models.length} models but cap is 15 — extras ignored`);
}
return models.slice(0, 15);
```

---

### IN-02: `toOpenAIResponsesStreamChunk` is gated on `delta.role === 'assistant'` — most providers never send this

**File:** `src/converters/strategies/OpenAIConverter.js:1751`  
**Severity:** Info  
**Description:** The OpenAI Responses streaming begin-events (`generateResponseCreated`, etc.) are only emitted when `delta.role === 'assistant'` (line 1751). Most streaming providers (Antigravity, NVIDIA, OpenAI custom) do not emit `delta.role` on the first chunk — a known issue documented in the `toClaudeStreamChunk` comments. This means the Responses streaming path never emits the `response.created` / `response.in_progress` events for these providers, leaving the Responses stream incomplete.

**Fix:** Apply the same stateful `messageStarted` guard used in `toClaudeStreamChunk` — emit begin-events on the first chunk regardless of `delta.role`, tracked via a per-request state Map.

---

### IN-03: Integration test `makeRequest` sets `Content-Type: application/json` for GET requests

**File:** `tests/api-integration.test.js:698`  
**Severity:** Info  
**Description:** `makeRequest` unconditionally includes `'Content-Type': 'application/json'` in headers even for GET requests (model list tests, auth tests). While this does not break anything server-side (the header is ignored), it is incorrect HTTP and may mask server-side content-type validation bugs in future tests.

---

### IN-04: `toClaudeModelList` does not populate `display_name`

**File:** `src/converters/strategies/OpenAIConverter.js:665-671`  
**Severity:** Info  
**Description:** `toClaudeModelList` maps models to `{ name, description: "" }` without carrying `display_name`. The Claude Code `/model` picker uses `display_name` to render friendly names. When this converter is invoked for a Claude-endpoint model list response, all models appear with raw IDs rather than the friendly names generated in `getAllAvailableModels`.

---

## Clean Areas

- **`response-cache.js`**: LRU eviction logic is correct. The `contents` key addition for Gemini-format requests is sound. TTL and key refresh on hit are implemented correctly.
- **`provider-models.js`**: `normalizeModelIds` deduplication with `Set` and sort is correct. `Object.create(null)` for `PROVIDER_MODELS` avoids prototype pollution. `customModelMatchesProvider` prefix-matching logic is consistent with usage at call sites.
- **`provider-pool-manager.js` core health logic**: The `markProviderUnhealthy` error windowing (10s window, error count reset), `_awaitRefreshWithTimeout` with proper `clearTimeout` in finally, and `_checkAndRecoverScheduledProviders` auto-recovery are all correctly implemented.
- **`request-handlers.js` Gemini format detection** (lines 916-924): The explicit check for `nativeResponse?.choices !== undefined` on a Gemini-prefix request correctly catches the case where the backend returned OpenAI format, and the conversion is applied cleanly.
- **`OpenAIConverter.toClaudeStreamChunk` deduplication guard**: The `blockStarted` flag correctly prevents duplicate `content_block_start` events for empty tool names. The `toolIndexMap` multi-tool tracking is logically sound for the normal case.

---

_Reviewed: 2026-05-28_  
_Reviewer: Claude (gsd-code-reviewer)_  
_Depth: deep_
