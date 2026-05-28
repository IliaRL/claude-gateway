# REQUIREMENTS.md

## Phase 1 Requirements

| ID | Requirement | Priority | Phase |
|----|-------------|----------|-------|
| REQ-01 | ENABLE_TOOL_SEARCH exported globally in zshrc for all session paths | P0 | 1 |
| REQ-02 | anthropic-beta headers forwarded verbatim through AIClient2API to Kiro | P1 | 1 |
| REQ-03 | Streaming converter does not emit duplicate content_block_start for empty tool name chunks | P1 | 1 |
| REQ-04 | drop_params does not strip cache_control blocks in LiteLLM config | P2 | 1 |
| REQ-05 | ANTHROPIC_BASE_URL routes through Tier 2 LiteLLM :4000 with SSE buffering fixed | P0 | 1 |
