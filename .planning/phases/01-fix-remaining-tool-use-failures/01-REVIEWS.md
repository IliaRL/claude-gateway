---
phase: 1
reviewers: [gemini]
reviewed_at: 2026-05-28T00:00:00Z
plans_reviewed: [01-01-PLAN.md, 01-02-PLAN.md, 01-03-PLAN.md]
skipped_reviewers: [claude (runtime), codex (not installed), coderabbit (not installed), opencode (not installed)]
---

# Cross-AI Plan Review — Phase 1: Fix Remaining Tool-Use Failures

## Gemini Review

Here is a structured review of the implementation plans.

### Summary

The proposed plans are well-organized, logically sequenced, and directly address the remaining requirements for the AI Gateway. Plans 01-01 and 01-02 are robust, correctly utilizing standard proxy configurations and carefully aggregating Anthropic beta headers without destroying existing cache settings. However, Plan 01-03 contains a critical logical flaw in its streaming state machine that will fundamentally break parallel tool calling by failing to close blocks properly.

### Strengths

- **Logical Sequencing:** The dependency graph (Wave 1 vs Wave 2) correctly ensures that the foundational routing and SSE buffering fixes are in place before tackling the complex converter logic.
- **Safe Header Management (01-02):** The approach to building `betaValues` as an array and joining them prevents overwriting existing `prompt-caching` headers when `tools` or `interleaved-thinking` are introduced.
- **Standardized Proxy Fix (01-01):** Utilizing `X-Accel-Buffering: "no"` in LiteLLM is the correct, standard approach for preventing proxy layers from buffering Server-Sent Events (SSE).
- **Concrete Verification:** The verification steps rely on definitive, observable metrics (e.g., `grep` counts, specific log traces, health checks) rather than vague "test if it works" criteria.

### Concerns

- **HIGH (Plan 01-03):** The proposed fix removes the logic that closes a previous block when a new parallel tool is encountered. In the Anthropic protocol, a `content_block_stop` must be emitted before a new `content_block_start` can occur. If `openaiIdx` increments (a new parallel tool), the code bypasses the `currentBlockType !== 'tool_use'` check and opens a new tool block *without closing the previous one*. This will result in malformed SSE streams and cause the Anthropic client (Claude Code) to crash or hang.
- **MEDIUM (Plan 01-01):** The plan introduces a `[HUMAN CHECKPOINT]` to restore routing and restart tiers. If this phase is meant to be executed autonomously by an agent or CI pipeline, this manual step will cause the workflow to stall.
- **LOW (Plan 01-02):** The condition `body.thinking && typeof body.thinking === 'object'` is functionally fine, but could throw an error if `body` is somehow null or undefined (though upstream handlers likely guarantee a body object).

### Suggestions

- **Rewrite Plan 01-03 Logic:** Modify the target fix to ensure *any* currently open block is closed when a new tool index is encountered:
  ```javascript
  if (toolCall.function?.name && !state.toolIndexMap.has(openaiIdx)) {
      if (state.blockStarted) {
          // Close whatever block was open previously (text OR previous parallel tool)
          events.push({ type: "content_block_stop", index: state.blockIndex });
          state.blockIndex++;
          state.blockStarted = false;
      }
      state.toolIndexMap.set(openaiIdx, state.blockIndex);
      state.blockStarted = true;
      state.currentBlockType = 'tool_use';
      // ... proceed to emit content_block_start
  }
  ```
- **Automate Checkpoints (Plan 01-01):** Replace the human checkpoint with explicit script commands. For example, use `sed` to update `claude-mode.sh` and restart the proxy via defined CLI commands.
- **Require Unit Tests (Plan 01-03):** Add a test case in `tests/unit/` that mocks an OpenAI stream containing both duplicate empty-name tool chunks *and* parallel tool calls to prevent future regressions.

### Risk Assessment

**Overall Risk: MEDIUM**

**Justification:** While the configuration and header manipulation in Wave 1 and Wave 2 (part 1) are low-risk, the defect in Plan 01-03's state machine elevates the overall risk. If deployed as written, Plan 01-03 would successfully fix the empty-name bug but introduce a critical regression that breaks all agentic workflows utilizing parallel tool execution. Applying the suggested state machine fix reduces the total phase risk back to LOW.

---

## Consensus Summary

Only one external reviewer was available (Gemini). Claude is the current runtime and was skipped for independence.

### Agreed Strengths (from Gemini)

- Wave 1 → Wave 2 dependency ordering is correct
- Multi-beta array join approach in 01-02 is the right pattern
- `X-Accel-Buffering: "no"` is the correct SSE unbuffering mechanism
- Verification criteria are concrete and observable

### Critical Finding

**Plan 01-03 has a HIGH severity flaw that must be fixed before execution.**

The plan removes the `else if (state.blockStarted && state.toolIndexMap.has(openaiIdx))` branch with the comment that it is "unreachable" — but this is incorrect. When a parallel tool call starts (a new `openaiIdx` that is not yet in `toolIndexMap`), the outer `!toolIndexMap.has(openaiIdx)` guard will pass, but the inner check `state.currentBlockType !== 'tool_use'` will be false (previous block was tool_use). Without the removed else-if branch, the previous tool block is never closed before the new one opens. This violates the Anthropic SSE protocol.

**Correct fix for 01-03 (consolidates both branches):**
```javascript
if (toolCall.function?.name && !state.toolIndexMap.has(openaiIdx)) {
    if (state.blockStarted) {
        // Closes text blocks AND previous parallel tool blocks
        events.push({ type: "content_block_stop", index: state.blockIndex });
        state.blockIndex++;
        state.blockStarted = false;
    }
    state.toolIndexMap.set(openaiIdx, state.blockIndex);
    state.blockStarted = true;
    state.currentBlockType = 'tool_use';
    events.push({
        type: "content_block_start",
        index: state.blockIndex,
        content_block: { type: "tool_use", id: toolCall.id || `tool_${uuidv4()}`, name: toolCall.function.name, input: {} }
    });
}
```

This single `if (state.blockStarted)` replaces both the original `if (currentBlockType !== 'tool_use')` and `else if (toolIndexMap.has(openaiIdx))` branches — simpler and correct for all cases.

### Action Required Before Executing

1. **Fix 01-03-PLAN.md:** Update the target code to use `if (state.blockStarted)` (not `if (state.currentBlockType !== 'tool_use')`) as the block-close guard. This handles both text→tool and parallel-tool→tool transitions.
2. **Add parallel-tool test:** Add a unit test covering the parallel tool call scenario before committing the 01-03 change.
3. **01-01 and 01-02:** Safe to execute as planned.

To incorporate feedback into planning:
  /gsd-plan-phase 1 --reviews
