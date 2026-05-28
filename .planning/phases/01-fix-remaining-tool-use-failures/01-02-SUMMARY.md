---
phase: 01-fix-remaining-tool-use-failures
plan: 02
status: complete
commit: 0187ab7
---

# Plan 01-02 Summary — Kiro anthropic-beta Header Fix

## What was done

Updated both header-building sites in `claude-kiro.js` (unary ~line 1724, streaming ~line 2300) to build `anthropic-beta` from request body signals instead of only injecting `prompt-caching-2024-07-31`.

## Changes

**File:** `Tier1-AIClient2API/src/providers/claude/claude-kiro.js`

Replaced the single `hasCacheControl` → `prompt-caching-2024-07-31` pattern at both sites with a multi-beta collector:

| Signal | Beta value injected |
|--------|---------------------|
| `body.tools` is non-empty array | `tools-2024-04-04` |
| `cache_control` blocks present | `prompt-caching-2024-07-31` |
| `body.thinking` is object | `interleaved-thinking-2025-05-14` |

Multiple values are comma-joined. The `x-amzn-kiro-amazonq-beta` header name is used for `amazonq` models; `anthropic-beta` for all others.

## Verification

- `grep -c "tools-2024-04-04" claude-kiro.js` → 2 ✓
- `grep -c "interleaved-thinking-2025-05-14" claude-kiro.js` → 2 ✓
- `grep -c "betaValues.join" claude-kiro.js` → 4 (2 per site: join in push + join in log) ✓
- `grep -c "prompt-caching-2024-07-31" claude-kiro.js` → 2 ✓
- Syntax check: OK (import error expected in CJS context) ✓
- Proxy health after restart: healthy ✓
- Commit: 0187ab7

## Impact

Kiro-backed Claude models now activate the tool-use streaming schema (`tools-2024-04-04`) and interleaved thinking (`interleaved-thinking-2025-05-14`) when those features are present in the request. Previously, tool calls to Kiro would silently fail to activate the correct schema.
