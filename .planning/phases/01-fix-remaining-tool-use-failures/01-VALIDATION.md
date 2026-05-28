---
phase: 01
slug: fix-remaining-tool-use-failures
status: complete
nyquist_compliant: true
created: 2026-05-28
audited: 2026-05-28
---

# Phase 01 — Validation Strategy

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Jest 29 (ESM, `"type": "module"`) |
| **Config file** | `Tier1-AIClient2API/jest.config.js` |
| **Quick run command** | `cd ~/AIClient2API && pnpm test -- --testPathPattern=unit` |
| **Full suite command** | `cd ~/AIClient2API && pnpm test` |
| **Estimated runtime** | ~16 seconds |

---

## Sampling Rate

- **After every task commit:** Run unit suite (~1s)
- **After every plan wave:** Run full suite including integration tests
- **Before `/gsd:verify-work`:** Full suite must be green (73/73)
- **Max feedback latency:** ~16 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Requirement | Test Type | Automated Command | File | Status |
|---------|------|-------------|-----------|-------------------|------|--------|
| 01-01-T1 | 01-01 | REQ-05: Gemini 1M context injection | integration | `pnpm test -- --testPathPattern=api-integration` L486 `/v1/models` | `tests/api-integration.test.js` | ✅ green |
| 01-01-T2 | 01-01 | REQ-05: LiteLLM SSE buffering config committed | integration | `grep stream_timeout Tier2-LiteLLM/litellm_config.yaml` | `Tier2-LiteLLM/litellm_config.yaml` | ✅ green |
| 01-01-T3 | 01-01 | REQ-05: Tier 2 SSE passthrough verified | manual | `curl -N -sf http://127.0.0.1:4000/v1/chat/completions` | N/A | ✅ verified |
| 01-02-T1 | 01-02 | REQ-02: Kiro anthropic-beta multi-beta header | integration | `pnpm test -- --testPathPattern=api-integration` L359/381 | `tests/api-integration.test.js` | ✅ green |
| 01-03-T1 | 01-03 | REQ-03: No duplicate content_block_start same index | unit | `pnpm test -- --testPathPattern=openai-converter-block-dedup` | `tests/unit/openai-converter-block-dedup.test.js` | ✅ green |
| 01-03-T2 | 01-03 | REQ-03: Parallel tool each get distinct block_start | unit | `pnpm test -- --testPathPattern=openai-converter-block-dedup` | `tests/unit/openai-converter-block-dedup.test.js` | ✅ green |
| BUG-1-T1 | — | BUG-1: Gemini /v1beta/ returns candidates format | integration | `pnpm test -- --testPathPattern=api-integration` L425 | `tests/api-integration.test.js` | ✅ green |
| BUG-1-T2 | — | BUG-1: Cache key isolation (no cross-protocol hits) | integration | Full suite sequential run (no 12ms cache hit) | `tests/api-integration.test.js` | ✅ green |
| BUG-2-T1 | — | BUG-2: Worker process exits cleanly | integration | `pnpm test` — no "force exited" warning | `tests/api-integration.test.js` afterAll | ✅ green |
| F-03-T1 | — | F-03: toGeminiResponse handles malformed JSON args | unit | `pnpm test -- --testPathPattern=openai-converter-gemini-response-json-guard` | `tests/unit/openai-converter-gemini-response-json-guard.test.js` | ✅ green |

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Kiro anthropic-beta header value in outgoing request | REQ-02 | Requires live Kiro endpoint + request capture (mitmproxy) | Start proxy with PROMPT_LOG_MODE=file, issue Kiro tool call, check log for `anthropic-beta: tools-2024-04-04` |
| LiteLLM SSE X-Accel-Buffering passthrough | REQ-05 | Header check requires HTTP layer inspection | `curl -v http://127.0.0.1:4000/v1/chat/completions` — assert `X-Accel-Buffering: no` in response headers |
| End-to-end tool loop (10+ tool calls) | REQ-03 | Requires live Claude Code session with sub-agent | Run a deep agentic task (e.g., file-search loop) and confirm no stall or crash after 10 rounds |

---

## Validation Audit 2026-05-28

| Metric | Count |
|--------|-------|
| Gaps found | 3 |
| Resolved | 3 (F-03 test + REQ-03 dedup test + impl bug fix) |
| Escalated | 3 (manual-only) |
| Total tests after phase | 73 (was 62 pre-phase) |
| All tests green | ✅ |

---

## Validation Sign-Off

- [x] All tasks have automated verify or documented manual fallback
- [x] No 3 consecutive tasks without automated coverage
- [x] No Wave 0 references outstanding
- [x] No `--watch` flags in any test command
- [x] Feedback latency < 16s (full suite)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-05-28
