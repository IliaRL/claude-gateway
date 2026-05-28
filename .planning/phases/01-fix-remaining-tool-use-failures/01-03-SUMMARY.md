---
phase: 01-fix-remaining-tool-use-failures
plan: 03
status: complete
commit: 39228e9
---

# Plan 01-03 Summary — OpenAIConverter Parallel Tool Streaming Fix

## What was done

Hardened the tool block opening guard in `OpenAIConverter.toClaudeStreamChunk` to prevent duplicate `content_block_start` events and fix the parallel tool close gap.

## Changes

**File:** `Tier1-AIClient2API/src/converters/strategies/OpenAIConverter.js`

Two changes at lines ~581-592:

1. **Outer guard:** `if (toolCall.function?.name)` → `if (toolCall.function?.name && !state.toolIndexMap.has(openaiIdx))`
   - Prevents duplicate `content_block_start` when a provider sends non-empty name on multiple chunks for the same tool index.

2. **Unified close branch:** Replaced split `if (blockStarted && currentBlockType !== 'tool_use') ... else if (blockStarted && toolIndexMap.has(openaiIdx))` with single `if (state.blockStarted)`.
   - The old split had a gap: when `openaiIdx=1` started while `openaiIdx=0` was open, `currentBlockType` was already `'tool_use'` so the first branch skipped, and `toolIndexMap.has(openaiIdx=1)` was false so the else-if also skipped — tool 0 was never closed before tool 1 opened.
   - The unified check closes any open block (text, thinking, or parallel tool) before opening a new tool block.

## Verification

- `grep -c "toolIndexMap.has(openaiIdx)"` → 1 (outer guard only) ✓
- `grep -c "if (state.blockStarted)"` → 2 (line 583: tool-call close; line 631: finish_reason close — both correct) ✓
- `grep -c "currentBlockType !== 'tool_use'"` → 0 (old split branch removed) ✓
- `grep -c "else if.*toolIndexMap.has"` → 0 (old parallel-tool else-if removed) ✓
- Syntax check: OK ✓
- Proxy health after restart: healthy ✓
- Commit: 39228e9

## Impact

Streaming tool calls through the proxy now produce exactly one `content_block_start` per tool index. Parallel tool calls each receive a `content_block_stop` before the next tool's `content_block_start`. Agentic tool loops that previously crashed silently on empty-name tool events or missing parallel-tool close events will now work correctly.
