# PROJECT.md

## What This Is

3-tier AI gateway that routes Claude Code CLI through external AI providers (Kiro, Antigravity, Gemini, Codex, Grok, OpenRouter, NVIDIA NIM). Fixes tool-use failures caused by proxy-mode operation.

## Core Value

Claude Code works reliably through the proxy — tools call correctly, context window isn't exhausted, fallbacks trigger properly.

## Status

Active. Gateway running. 3 of 5 identified tool-use failures fixed. 2 remaining.

## Key Decisions

- **Tier 1 bypass**: `ANTHROPIC_BASE_URL=http://127.0.0.1:3000` (direct to Tier 1) was set to avoid LiteLLM SSE corruption. Needs to be restored to `:4000` once SSE is fixed.
- **drop_params: false**: Changed from `true` to preserve `cache_control` blocks.
- **ENABLE_TOOL_SEARCH**: Exported globally in zshrc (line 22) so all session paths inherit it.

## Requirements

### Active
- REQ-01: Tool Search must be enabled for all Claude Code session launch paths
- REQ-02: `anthropic-beta` headers must pass through AIClient2API to Kiro verbatim
- REQ-03: Streaming tool calls must not emit duplicate `content_block_start` events
- REQ-04: `drop_params` must not strip `cache_control` blocks
- REQ-05: Tier 2 (LiteLLM :4000) must be in the active request path with SSE buffering fixed

### Completed
- REQ-01: ENABLE_TOOL_SEARCH global export ✓
- REQ-04: drop_params: false ✓

### Out of Scope
- Kiro first-call identity override (pre-existing provider behavior)
- Antigravity Sonnet 4.6 empty-response (tracked separately)

## Constraints

- Never modify `.venv/` or run pip/uv install in Tier2-LiteLLM
- Never glob inside Tier1-AIClient2API/node_modules
- LiteLLM startup must wait for Tier 1 health before starting
- All credentials from `Credentials/` folder only
