# Technical Concerns & Debt

## Known Issues
- **Streaming Corruption**: LiteLLM re-wrapping SSE chunks caused corruption; currently bypassed by routing Claude Code directly to Tier 1 (`claude-proxy`).
- **Antigravity Routing**: Sonnet 4.6 empty-response routing issue (pending fix as of 2026-05-25).
- **First-Call Identity**: Kiro occasionally responds as "Kiro" or "Amazon Q" on the first request despite system prompt overrides.

## Security Considerations
- LITELLM_KEY exposure risk (flagged in recent audits).
- Credentials managed externally (`Credentials/` folder) must map exactly to Tier 1 configurations.
