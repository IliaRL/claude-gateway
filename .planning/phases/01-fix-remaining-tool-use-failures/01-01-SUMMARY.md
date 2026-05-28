---
phase: 01-fix-remaining-tool-use-failures
plan: 01
subsystem: tier2-litellm
tags: [sse, streaming, litellm, gemini, context-window, proxy-routing]
dependency_graph:
  requires: []
  provides: [litellm-sse-buffering-config, gemini-context-window-committed]
  affects: [Tier2-LiteLLM/litellm_config.yaml, Tier1-AIClient2API/src/utils/request-handlers.js]
tech_stack:
  added: []
  patterns: [yaml-config-edit, git-force-track]
key_files:
  created: [Tier2-LiteLLM/litellm_config.yaml]
  modified: [Tier1-AIClient2API/src/utils/request-handlers.js]
decisions:
  - "Used git update-index --add to force-track litellm_config.yaml past upstream LiteLLM .gitignore"
  - "PROXY_BASE already defaults to :4000 in claude-mode.sh — claude-proxy will restore routing correctly"
metrics:
  duration: ~10 minutes
  completed: 2026-05-28
  tasks_completed: 2
  tasks_total: 3
  files_changed: 2
---

# Phase 01 Plan 01: Commit Gemini Fix + SSE Buffering Config Summary

**One-liner:** Committed Gemini 1M context window injection (already in git at 756fbd3) and added SSE stream_timeout/request_timeout/X-Accel-Buffering settings to litellm_config.yaml (a093426); ANTHROPIC_BASE_URL restore to :4000 awaits human checkpoint.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Commit pending Gemini context window fix | 756fbd3 | Tier1-AIClient2API/src/utils/request-handlers.js |
| 2 | Add SSE buffering settings to LiteLLM config | a093426 | Tier2-LiteLLM/litellm_config.yaml |
| 3 | Restore ANTHROPIC_BASE_URL to :4000 | PENDING — checkpoint | (shell env, ~/.claude/settings.json) |

## What Was Done

### Task 1 — Gemini Context Window Commit

The Gemini context window injection fix was already committed at `756fbd3` (prior to this plan execution). The commit adds:

```javascript
} else if (MODEL_CONTEXT_WINDOWS[modelId]) {
    modelResponse.context_length = MODEL_CONTEXT_WINDOWS[modelId];
}
```

This injects the correct 1M context window for Gemini models in the model list response, so Claude Code displays accurate context size and avoids premature context-exhaustion fallbacks.

### Task 2 — LiteLLM SSE Buffering Config

Added to `Tier2-LiteLLM/litellm_config.yaml` under `litellm_settings`:

```yaml
stream_timeout: 600          # Keep streaming connections alive up to 10 min
request_timeout: 600         # Match to avoid premature closes
response_headers:
  X-Accel-Buffering: "no"   # Disable nginx proxy buffering on SSE streams
```

File was never previously committed to MASTER-C despite being in the `.gitignore` exception list. Used `git update-index --add` to bypass the nested upstream `.gitignore` inside `Tier2-LiteLLM/`.

### Task 3 — Checkpoint: Awaiting Human Verification

Current state: No `ANTHROPIC_BASE_URL` in `~/.claude/settings.json` (Claude Code is in native Anthropic mode). The `claude-proxy` shell function already defaults `PROXY_BASE` to `http://127.0.0.1:4000` (line 36 of `~/AIClient2API/scripts/claude-mode.sh`). Running `claude-proxy` will correctly set `:4000`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Gemini commit was already done before plan execution**
- **Found during:** Task 1
- **Issue:** git status showed `request-handlers.js` as untracked in initial status, but the file was already committed at 756fbd3
- **Fix:** Verified commit content matched plan expectations, treated as complete
- **Files modified:** None
- **Commit:** 756fbd3 (pre-existing)

**2. [Rule 3 - Blocking] litellm_config.yaml blocked by nested upstream .gitignore**
- **Found during:** Task 2
- **Issue:** `Tier2-LiteLLM/.gitignore` (upstream LiteLLM repo) has `litellm_config.yaml` on line 90. Both `git add -f` and `git add --force` silently failed.
- **Fix:** Used `git update-index --add Tier2-LiteLLM/litellm_config.yaml` to directly write to index, bypassing all `.gitignore` rules.
- **Files modified:** None (git index only)
- **Commit:** a093426

## Known Stubs

None — the litellm_config.yaml changes are complete configuration values, not placeholders.

## Threat Flags

None — only loopback URL changes and config edits, no new network endpoints or auth paths introduced.

## Self-Check: PASSED (Tasks 1-2)

- FOUND: 756fbd3 (Gemini context window commit)
- FOUND: a093426 (SSE buffering config commit)
- Tier2-LiteLLM/litellm_config.yaml is tracked in git
- stream_timeout: 600 present in config

Task 3 (ANTHROPIC_BASE_URL restore) awaits human checkpoint approval.

## Verification Commands (After Checkpoint Approval)

```bash
# Both tiers healthy
curl -sf http://127.0.0.1:3000/health | jq .status   # → "healthy"
curl -sf http://127.0.0.1:4000/health | jq .status   # → "healthy"

# Active URL shows :4000
claude-mode-status  # → contains "4000"

# Gemini commit in log
git log --oneline -5 | grep -i gemini  # → 756fbd3

# SSE settings present
grep "stream_timeout" Tier2-LiteLLM/litellm_config.yaml  # → stream_timeout: 600
```
