# Troubleshooting & Fixes Registry

Known failure modes for the 3-Tier AI Gateway — root causes, affected files, and resolution status. Add new entries here when a non-obvious issue is diagnosed.

---

## Issue 1: Tool Search and Model Discovery Disabled
**Status:** FIXED  
**Symptom:** Claude Code cannot search for local files/tools; `/model` command doesn't show backend models.  
**Root Cause:** Claude Code disables native features when `ANTHROPIC_BASE_URL` doesn't match official Anthropic endpoints — assumes it's hitting AWS Bedrock.  
**Fix:** Inject these env vars in the ZSH launcher before starting Claude Code (already applied in `~/dotfiles/zsh/zshrc`):
```bash
export ENABLE_TOOL_SEARCH=true
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
export CLAUDE_CODE_SKIP_BEDROCK_AUTH=1
```

---

## Issue 2: Silent Tool Use Failure (`drop_params` bug)
**Status:** FIXED  
**Symptom:** Claude Code issues a tool command; model returns generic text instead of invoking the tool schema.  
**Root Cause:** `drop_params: true` at the global LiteLLM router level strips nested JSON tool schemas before forwarding. Provider receives the prompt but no tool definitions.  
**Fix:** Global `drop_params` removed from `Tier2-LiteLLM/litellm_config.yaml`. If a specific provider needs it, apply only within that model's `litellm_params` block — never globally.

---

## Issue 3: JSON Corruption in Long Tool Loops
**Status:** FIXED  
**Symptom:** During agentic loops, Claude Code crashes with `Unexpected token in JSON at position...`.  
**Root Cause:** SSE buffering — proxy layers concatenate multiple `data:` frames into one chunk, breaking the CLI's streaming parser.  
**Fix:**
- `X-Accel-Buffering: no` injected on all streaming responses in both Tier 1 (`src/ui-modules/oauth-api.js`) and Tier 2 (`litellm_config.yaml` `headers` block).
- `export CLAUDE_CODE_STREAM_DELAY=50` set in ZSH launcher.

---

## Issue 4: Empty Tool Name / Duplicate Tool Use Error
**Status:** FIXED  
**Symptom:** AIClient2API throws "empty tool name" or "duplicate tool invocation ID" during streaming.  
**Root Cause:** Async chunk fragmentation — the `name` and `id` fields of a streaming tool call arrive in separate micro-chunks. The converter yielded the tool call before both fields were populated.  
**Fix:** Streaming accumulator in `src/converters/` (`OpenAIConverter.js`) buffers tool-call chunks until both `id` and `name` are fully populated before yielding downstream.

---

## Issue 5: Tier 2 SSE Corruption (NOT Resolved — Tier 2 Bypassed)
**Status:** OPEN — worked around by routing Claude Code directly to Tier 1 (:3000)  
**Symptom:** Streaming responses through LiteLLM (:4000) produce corrupted SSE in Claude Code.  
**Root Cause:** LiteLLM re-wraps the (already Anthropic-format) SSE stream, emitting a **duplicate `message_start` event** and interleaving replies.  
**Verification (2026-05-29 live test):** Identical streaming `/v1/messages` request to both ports — `:3000` returned one clean Anthropic sequence (`message_start` → deltas → `message_stop`, all valid JSON); `:4000` returned **two `message_start` events** + interleaved text. The earlier `a093426` buffering change (`stream_timeout`, `X-Accel-Buffering: no`) did **not** resolve the re-wrap.  
**Current routing:** `claude-proxy` sets `ANTHROPIC_BASE_URL=http://127.0.0.1:3000` (Tier 1 direct). Tier 2 runs but is **out of the Claude Code hot path**. A scoped RCA of the double-wrap is tracked for a future fix so :4000 can re-enter the path.

---

## Issue 6: Startup CPU Spike (Sequential Startup Required)
**Status:** FIXED  
**Symptom:** MacBook CPU pegs at 100% immediately after starting both tiers.  
**Root Cause:** LiteLLM fires ~80 concurrent health-check requests at Tier 1 before Tier 1 has finished initializing, causing a storm of concurrent connections.  
**Fix:** `scripts/safe-restart.sh` enforces sequential startup — Tier 1 must pass a health check before Tier 2 starts. Never start both tiers simultaneously.

---

## Issue 7: Dead Provider Credentials (github-models, openai-custom)
**Status:** OPEN — flagged, awaiting credential refresh  
**Symptom:** `/provider_health` shows `github-models` and `openai-custom` (OpenRouter) unhealthy with `Request failed with status code 401`. Their models still appear in `/v1/models` (catalog is static) but every request to them fails.  
**Root Cause:** Expired/invalid static keys — the GitHub PAT and the OpenRouter API key. A cooldown reset cannot clear a 401; these need new keys.  
**Note:** Distinct from the transient `429 short cooldown` on `nvidia-nim` / `gemini-cli-oauth` accounts, which self-clear.  
**Fix:** Refresh both keys via the `aiclient-credentials` skill (update `configs/provider_pools.json` through the file-lock write path — never edit it directly), or disable the two providers until re-credentialed.

---

## Issue 8: Broken SYSTEM_PROMPT_FILE_PATH — but the correct fix is to REMOVE it, not repair it
**Status:** FIXED (2026-05-29) — `SYSTEM_PROMPT_FILE_PATH` set to `""`; redundant external override removed (repairing the path would re-introduce the double-override refusal). Restart to apply.  
**Symptom:** `config.json` `SYSTEM_PROMPT_FILE_PATH` points at the dead `Tier1-AIClient2API/` path → `SYSTEM_PROMPT_CONTENT=''`.  
**Why repairing the path is WRONG (verified 2026-05-29):** The external override file (`input_system_prompt.txt`) is **near-identical** to the hardcoded `<CRITICAL_OVERRIDE>` in `claude-kiro.js:1063-1071`, which is prepended to *every* Kiro request. `claude-strategy.js:47-64` also applies `SYSTEM_PROMPT_CONTENT` to Claude/Kiro requests. So repairing the path makes Kiro receive the identity override **twice** → empirically triggers a hard `"I can't discuss that."` refusal (isolation test C). Today they don't collide only because the path is broken (content empty).  
**Fix:** set `SYSTEM_PROMPT_FILE_PATH: ""` in `config.json` (remove the redundant external override; per-provider hardcoded prefixes already handle identity), then `./scripts/safe-restart.sh`. Secondary: `claude-strategy.js:53` guards on `=== null` but a missing file yields `''`, so the guard misfires — harden to also treat `''` as "no external prompt".  
**Note:** This does NOT fix the Kiro identity reveal or refusals — those are Kiro/CodeWhisperer backend behavior (see Issue 9).

---

## Issue 9: Kiro "I can't discuss that" refusals + "I'm Kiro" identity (CodeWhisperer backend)
**Status:** OPEN — inherent to the Kiro backend; mitigate via routing, not fixable in converter.  
**Symptom:** `claude-sonnet-4-5-20250929` (unprefixed → routes to `claude-kiro-oauth`) prepends/returns `"I can't discuss that."` on non-coding prompts ("say hello world", "respond with exactly X"), and self-identifies as "Kiro" not "Claude". This is the "weird response from one model."  
**Root Cause (verified 2026-05-29 isolation tests):** Kiro = Amazon CodeWhisperer / Q Developer, a **code-specialized** assistant with server-side guardrails. (1) It refuses non-coding/imperative-echo prompts. (2) Its server-side system prompt overrides the client `<CRITICAL_OVERRIDE>`, so it still says "I'm Kiro." Real coding tool-use works (the `calculate_sum` tool test passed). Non-Kiro providers (antigravity/gemini) handled the identical prompts cleanly.  
**Mitigation (not a converter fix):** Kiro is fine for its purpose (coding in Claude Code). For casual/non-coding turns, either (a) accept the guardrail, or (b) demote `claude-kiro-oauth` below a general-purpose provider in the default route for unprefixed `claude-*` so casual prompts don't land on Kiro. Do NOT double the identity override (see Issue 8).

---

## Issue 10: Kernel Panic from Memory Exhaustion (jetsam → WindowServer watchdog)
**Status:** FIXED (2026-05-29) — memory-headroom guard added to `safe-restart.sh`.  
**Symptom:** MacBook Air (8-core / **16 GB**) hard-crashes and reboots mid-task whenever the proxy is started (or node-heavy tests run) while other apps are open; recurred 3×.  
**Root Cause (verified 2026-05-29 via `JetsamEvent-2026-05-29-163132.ips`):** **out-of-memory, not CPU.** At the jetsam kill, **resident memory = 15,154 MB / 16,384 MB (92%)**. macOS jetsam then kills processes → swap/IO thrash → WindowServer misses watchdog check-ins for 125 s → `userspace watchdog timeout` kernel panic (the panic is the *downstream symptom*). Top consumers: **node (MCP fleet + proxy + claude-mem) = 4,949 MB**, Comet ≈ 1.9 GB, Antigravity IDE (+ on-device inference) ≈ 1.95 GB, toolbox 623 MB, python3.12 335 MB. **The proxy itself is NOT a bug** — no node/litellm process hit a `cpu_resource.diag` violation (only Apple daemons did) and no single node proc exceeded ~120 MB (no leak). It is cumulative oversubscription: the steady baseline (full MCP/node fleet + Antigravity + Comet ≈ 15 GB) leaves no room, so starting the ~200–400 MB proxy is the allocation that crosses the jetsam threshold.  
**Fix:** Memory-headroom guard in `scripts/safe-restart.sh` — computes reclaimable RAM (`vm_stat` free+inactive+speculative+purgeable) and **aborts the start if < `MIN_FREE_MB` (default 2048)**, printing the top memory consumers and advising to free RAM. This makes a proxy start incapable of tipping the machine into jetsam. Also: `REFRESH_CONCURRENCY_PER_PROVIDER` 3→2 (`config.json`); standing rule: start the proxy **only** via `safe-restart.sh`, never raw.  
**Durable prevention (user side):** keep ≥2 GB RAM free before starting the proxy — quit Antigravity IDE and/or Comet (≈4 GB combined) when not in use, and/or reduce the MCP fleet. Note: trimming `~/.claude.json mcpServers` does NOT stick (servers are re-injected by enabled plugins each launch); to durably cut the ~5 GB node fleet, disable unused plugins (e.g. `data-agent-kit-starter-pack`) via `/plugin` or `enabledPlugins` in `settings.json`.

---

## Issue 11: Tool-Use Reliability in Proxy Mode (open investigation)
**Status:** OPEN — root causes identified; fixes partially applied; full resolution pending.  
**Symptom:** When routing through the proxy, agents may silently stop calling tools mid-task, call fewer tools than expected, or stall in agentic loops. Model responses look normal.  
**Root causes (from `Known-Errors/tool_failure_root_cause.md` investigation):**  
1. **`ENABLE_TOOL_SEARCH` not reliably active** — placing it in `settings.json` is documented as unreliable for this var. Must also be a global shell export in `zshrc` (alongside other `AICLIENT_*` exports), not only inline at `claude-pick` call sites. Affects subagent spawning, IDE sessions, and `--resume` paths.  
2. **`anthropic-beta` header pass-through unaudited** — for Kiro (real Anthropic endpoint), `anthropic-beta` and `anthropic-version` headers must be forwarded verbatim; verify `src/handlers/request-handler.js` and provider adapters don't strip them. For non-Anthropic providers, headers must be stripped outbound but response translator must synthesize correct Anthropic-format capability blocks.  
3. **Empty tool-name streaming bug** — FIXED (WR-04/05 in Phase 2, 2026-05-29): converter now buffers tool-call chunks and only emits `content_block_start` once per `index`.  
4. **`drop_params: true` in LiteLLM** — FIXED (Issue 2): removed global `drop_params`.  
**Fix 1 (quick, low-risk):** Add `export ENABLE_TOOL_SEARCH=true` as a true shell export in `~/dotfiles/zsh/zshrc`, not just inline at `claude-pick`. Currently only inline injection.  
**Fix 2 (audit needed):** Read `src/handlers/request-handler.js` to verify `anthropic-beta` is forwarded for Kiro and stripped + re-synthesized for other providers.

---

## Diagnostic Quick Reference

```bash
# Is Tier 1 alive?
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/provider_health | jq .

# Recent Tier 1 logs
tail -50 /tmp/aiclient.log

# Enable request/response logging (add to configs/config.json, then restart)
"PROMPT_LOG_MODE": "file"
# Logs appear in: AIClient2API/logs/prompt_log_*.log

# Tier 1 model list
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/v1/models | jq '.data[].id'
```
