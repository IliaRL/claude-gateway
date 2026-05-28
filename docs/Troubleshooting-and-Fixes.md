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

## Issue 5: Tier 2 SSE Corruption (Resolved)
**Status:** FIXED — Tier 2 SSE passthrough verified clean  
**Symptom:** Streaming responses through LiteLLM (:4000) produced corrupted SSE chunks in Claude Code.  
**Root Cause:** LiteLLM re-wraps SSE streaming chunks in a way that Claude Code's parser cannot handle under certain tool-use payloads.  
**Fix applied (commit a093426):** Added `stream_timeout: 600`, `X-Accel-Buffering: "no"`, and `drop_params: false` to `Tier2-LiteLLM/litellm_config.yaml`. SSE passthrough tested with curl — returns `text/event-stream` with unbroken `data:` lines and no corruption (SSE_PASSTHROUGH: PASS).  
**Current routing:** `claude-proxy` sets `ANTHROPIC_BASE_URL=http://127.0.0.1:4000`, routing Claude Code through Tier 2 as designed. Both tiers healthy and in the active request path.

---

## Issue 6: Startup CPU Spike (Sequential Startup Required)
**Status:** FIXED  
**Symptom:** MacBook CPU pegs at 100% immediately after starting both tiers.  
**Root Cause:** LiteLLM fires ~80 concurrent health-check requests at Tier 1 before Tier 1 has finished initializing, causing a storm of concurrent connections.  
**Fix:** `scripts/safe-restart.sh` enforces sequential startup — Tier 1 must pass a health check before Tier 2 starts. Never start both tiers simultaneously.

---

## Diagnostic Quick Reference

```bash
# Is Tier 1 alive?
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/provider_health | jq .

# Recent Tier 1 logs
tail -50 /tmp/aiclient.log

# Enable request/response logging (add to configs/config.json, then restart)
"PROMPT_LOG_MODE": "file"
# Logs appear in: Tier1-AIClient2API/logs/prompt_log_*.log

# Tier 1 model list
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/v1/models | jq '.data[].id'
```
