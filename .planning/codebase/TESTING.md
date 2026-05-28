# Testing Strategy

## Tier 1 (AIClient2API)
- Executed via `pnpm test`
- Commands available: `test:unit`, `test:integration`, `test:coverage`, `test:verbose`
- Current state: 37/37 tests passing (noted in session memory)

## Tier 2 (LiteLLM)
- Upstream testing conventions apply (see `Tier2-LiteLLM/CLAUDE.md`).
- Do not run `pytest` directly against the vendored LiteLLM directory.
