---
last_mapped_commit: $(git rev-parse HEAD)
---
# Testing Practices (2026-05-31)

## Framework
- **Jest**: Version 29.7.0 is the primary testing framework, integrated with Babel (`babel-jest`) for comprehensive ESM support.

## Test Suites
1. **Unit Tests (`tests/unit/`)**: 
   - Execute entirely offline using mocked HTTP interfaces and adapters.
   - Deeply tests specific schema validation edge-cases (e.g., `openai-converter-tool-call-integrity.test.js`, `claude-converter-tool-use.test.js`, `codex-reactive-refresh.test.js`).
   - Ensures tool-use boundaries and SSE stream chunking maintain state without corrupting output.
2. **Integration Tests (`tests/api-integration.test.js`)**:
   - Run against a locally live gateway (`http://127.0.0.1:3000`).
   - Use `supertest` or raw `fetch` commands to simulate Claude Code requesting completions via standard HTTP interfaces.
3. **Smoke Tests (`scripts/master-smoke-test.cjs`)**:
   - Quickly verifies live external AI providers are reachable.
4. **Live Verification (`scripts/live-verify.cjs`)**:
   - Invoked dynamically during `safe-restart.sh` to structurally validate that proxying logic successfully returns LLM reasoning without 404/500 errors.

## Workflow
- Run offline validation: `pnpm test:unit`
- Run the full suite locally: `pnpm test` (ensuring the server is running).
- For PRs and major regressions: `node scripts/unified-test-suite.cjs`.
