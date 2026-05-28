# ROADMAP.md

## Milestone 1: Gateway Tool-Use Reliability

**Goal:** Claude Code works reliably in proxy mode — tools call correctly, SSE streams intact, full 3-tier fallback active.

---

### Phase 1: Fix Remaining Tool-Use Failures

**Goal:** Implement the 3 remaining fixes from `tool_failure_root_cause.md` (Fixes 2, 3, 5) to restore full gateway reliability.

**Requirements:** REQ-02, REQ-03, REQ-05

**Plans:** 3 plans

Plans:
- [ ] 01-01-PLAN.md — Commit Gemini context window fix + SSE buffering in LiteLLM + restore Tier 2 routing
- [ ] 01-02-PLAN.md — Fix anthropic-beta header pass-through in claude-kiro.js (tools + thinking betas)
- [ ] 01-03-PLAN.md — Fix empty-tool-name streaming bug in OpenAIConverter.toClaudeStreamChunk

**Success criteria:**
- Both `:3000` and `:4000` healthy and in active request path
- `anthropic-beta` headers present in Kiro-bound requests
- No duplicate `content_block_start` events in streaming tool calls
- Tool-heavy agentic tasks complete without stalling

**Depends on:** (nothing — Fix 1 and Fix 4 already complete)

---

**Previously completed (not tracked as phases):**
- Fix 1: ENABLE_TOOL_SEARCH global export in zshrc ✓
- Fix 4: drop_params: false in litellm_config.yaml ✓
- Bonus: Gemini 1M context window injection in request-handlers.js ✓
