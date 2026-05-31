---
last_mapped_commit: $(git rev-parse HEAD)
---
# Concerns & Technical Debt (2026-05-31)

## Architecture & Memory Constraints
- **Jetsam Crashes on Apple Silicon**: The Node.js proxy environment can trigger macOS WindowServer panics if memory exceeds reclaimable floors. 
  - *Mitigation*: The `safe-restart.sh` script enforces a strict 2 GB reclaimable-RAM guard.
  - *Constraint*: Avoid any globbing or full-directory scanning during runtime inside the `AIClient2API` tree. The `.claudesignore` explicitly bans iterating `node_modules` or `.git`.

## Streaming Stability
- **SSE Chunk Corruption**: The Claude Code CLI's parser is highly sensitive to concatenated Server-Sent Events (`data: `) frames.
  - *Mitigation*: The legacy LiteLLM Tier 2 router was completely removed (down to a 2-tier architecture) because re-serializing the streams corrupted output and introduced latency. `X-Accel-Buffering: no` must be respected.

## Provider Nuances
- **Model Identification Mismatches**: A primary source of silent `404` errors is when the string supplied by the Claude CLI does not precisely map to the canonical strings inside `src/providers/provider-models.js`. 
- **Kiro Identity Override**: Kiro occasionally responds identifying as "Amazon Q" on the first request. The gateway appends a system prompt override (`configs/input_system_prompt.txt`), but Kiro's internal instruction sometimes wins the first turn. Subsequent turns operate normally.

## Observability
- While `live-verify.cjs` and the statusline hooks provide robust latency tracking, TTFT, and fallback detection, the system lacks centralized off-host logging. Tracing relies heavily on local SQLite `.db` persistence.
