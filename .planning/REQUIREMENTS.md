# Requirements: Perfect, Modular API Proxy Routing for Claude Code

**Defined:** 2026-06-04
**Core Value:** Any OpenAI-compatible model can be routed through AIClient2API with zero friction — add a provider, validate connectivity in one command, trust the fallback chain.

## v1 Requirements

### Bug Fixes

- [ ] **BUG-01**: The SyntaxError in `antigravity-core.js:1830` is fixed and the Antigravity provider path works end-to-end
- [ ] **BUG-02**: Disabled providers (openai-custom) are clearly marked or removed from the fallback chain so they don't silently fail

### Connectivity & Diagnostics

- [ ] **DIAG-01**: A one-liner `curl` command tests `/v1/models` against `ANTHROPIC_BASE_URL` with `ANTHROPIC_AUTH_TOKEN` and prints pass/fail
- [ ] **DIAG-02**: A one-liner `curl` command sends a minimal `/v1/messages` prompt and validates the response contains expected fields
- [ ] **DIAG-03**: A smoke-test script runs one call per active provider and reports status (pass/fail/skip) per provider
- [ ] **DIAG-04**: The proxy health endpoint (`/provider_health`) output is human-readable and indicates which providers are healthy/cooling/failing

### Documentation

- [ ] **DOC-01**: `OPERATION.md` is written with copy-pastable instructions for: (a) adding a new provider/model, (b) testing provider connectivity, (c) what to check when things break
- [ ] **DOC-02**: `docs/SYSTEM-OVERVIEW.md` is written describing traffic flow (Claude Code → proxy → providers), provider selection logic, logging/retry/timeout paths, and security-sensitive areas (API keys, shell exec)
- [ ] **DOC-03**: Existing `docs/` are updated to reflect 2-tier architecture (no LiteLLM references in active docs)

### Architecture & Modularity

- [ ] **ARCH-01**: Adding a new provider requires changes in ≤2 files (provider adapter + config entry) — no scattered registration in 5+ places
- [ ] **ARCH-02**: Config, routing, logging, and security are in clearly separated source modules with no cross-cutting pollution
- [ ] **ARCH-03**: The model-catalog.json → provider-models.js pipeline is the single source of truth for model IDs (no hardcoded strings outside the catalog)

### Operations

- [ ] **OPS-01**: `pnpm run verify:quick` completes in under 30s and gives a clear pass/fail for proxy health
- [ ] **OPS-02**: `./scripts/safe-restart.sh` restarts the gateway without killing the parent Claude process (existing behavior preserved and documented)
- [ ] **OPS-03**: A `pnpm run smoke` command (or alias) runs provider smoke tests and reports per-provider status

### Security Audit

- [ ] **SEC-01**: No API keys or OAuth tokens are hardcoded in source files (all sourced from `Credentials/` or env vars)
- [ ] **SEC-02**: No shell exec paths that could inject user-controlled input (command injection audit)
- [ ] **SEC-03**: Credential sync scripts (`sync-credentials.js`, `sync-kiro-credentials.py`) are reviewed for secure patterns

## v2 Requirements

### Observability

- **OBS-01**: Per-provider request latency and error rate tracked in cockpit.db
- **OBS-02**: A simple dashboard command shows provider health trends over last 24h
- **OBS-03**: Structured logs include provider, model, latency, status for every request

### Advanced Routing

- **ROUT-01**: Per-model cost tracking so the cheapest healthy provider is preferred
- **ROUT-02**: Circuit-breaker pattern for providers with >N failures in M minutes
- **ROUT-03**: Sticky routing option (pin a session to a specific provider account)

## Out of Scope

| Feature | Reason |
|---------|--------|
| LiteLLM re-introduction | Removed intentionally — corrupted Anthropic SSE stream |
| Cloud/remote deployment | Localhost-only by design (Apple Silicon safety constraints) |
| Web UI for proxy management | CLI/script-based operation is sufficient |
| Kiro identity override fix | Pre-existing Kiro provider behavior, not configurable |
| Multi-machine sync | Single-machine use case only |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| BUG-01 | Phase 1 | Pending |
| BUG-02 | Phase 1 | Pending |
| DIAG-01 | Phase 1 | Pending |
| DIAG-02 | Phase 1 | Pending |
| DIAG-03 | Phase 1 | Pending |
| DIAG-04 | Phase 1 | Pending |
| DOC-01 | Phase 2 | Pending |
| DOC-02 | Phase 2 | Pending |
| DOC-03 | Phase 2 | Pending |
| ARCH-01 | Phase 3 | Pending |
| ARCH-02 | Phase 3 | Pending |
| ARCH-03 | Phase 3 | Pending |
| OPS-01 | Phase 1 | Pending |
| OPS-02 | Phase 1 | Pending |
| OPS-03 | Phase 1 | Pending |
| SEC-01 | Phase 2 | Pending |
| SEC-02 | Phase 2 | Pending |
| SEC-03 | Phase 2 | Pending |

**Coverage:**
- v1 requirements: 18 total
- Mapped to phases: 18
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-04*
*Last updated: 2026-06-04 after initial definition*
