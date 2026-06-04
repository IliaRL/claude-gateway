# Phase 2: Documentation + Security Audit - Context

**Gathered:** 2026-06-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Write the runbook operators actually need (`OPERATION.md`), document the 2-tier architecture in a new `SYSTEM-OVERVIEW.md`, remove stale LiteLLM references from active docs, and audit source code for credential handling anti-patterns (hardcoded secrets, command injection paths, insecure credential sync scripts).

**In scope:**
- Create `AIClient2API/OPERATION.md` — 3-section runbook: (a) add provider/model, (b) test connectivity, (c) troubleshoot
- Create `MASTER-C/docs/SYSTEM-OVERVIEW.md` — traffic flow, provider selection logic, logging/retry/timeout, security-sensitive areas
- Update 9 active docs in `MASTER-C/docs/` that contain stale LiteLLM references
- SEC-01: grep source + configs for hardcoded API keys/OAuth tokens
- SEC-02: audit exec/execSync/spawn call sites in src/ for command injection risk
- SEC-03: review sync-credentials.js and sync-kiro-credentials.py for secure patterns

**Out of scope:**
- Architecture refactoring (Phase 3)
- Writing new provider adapters
- Adding observability/metrics (v2 requirements)
- Modifying routing or fallback chains
- The `AIClient2API/docs/` subdirectory — those docs are secondary; focus is `MASTER-C/docs/`

</domain>

<decisions>
## Implementation Decisions

### OPERATION.md

- **D-01:** File location: `AIClient2API/OPERATION.md` — colocated with the service it documents. Operators `cd` into AIClient2API to run commands; the runbook must live there.
  `[auto] Selected: colocated at AIClient2API/OPERATION.md (recommended default)`

- **D-02:** Structure — 3 top-level sections matching DOC-01 requirements:
  1. **Adding a provider/model** — step-by-step with file paths, what to edit, how to validate
  2. **Testing connectivity** — copy-pastable curl one-liners (migrated from package.json), `pnpm run smoke` usage, interpreting `/provider_health` output
  3. **Troubleshooting** — symptom → diagnostic → fix table for the most common failure modes (429s, ECONNREFUSED, wrong model, SSE corruption)
  `[auto] Selected: 3-section structure (recommended default)`

- **D-03:** Depth — medium. Each section has: a brief "what this does" sentence, numbered steps, and copy-pastable commands with `$AICLIENT_TOKEN` env var. No more than ~150 lines total — this is a quick-reference runbook, not a design document.
  `[auto] Selected: medium depth with copy-pastable commands (recommended default)`

- **D-04:** The curl one-liners from `package.json` (DIAG-01, DIAG-02) should be reproduced verbatim in OPERATION.md Section 2 ("Testing connectivity") so operators can use them without reading package.json.

### SYSTEM-OVERVIEW.md

- **D-05:** File location: `MASTER-C/docs/SYSTEM-OVERVIEW.md` — consistent with existing docs (ARCHITECTURE.md, CONFIGURATION.md, etc. all live here).
  `[auto] Selected: MASTER-C/docs/SYSTEM-OVERVIEW.md (recommended default)`

- **D-06:** Content scope — 4 subsections:
  1. Traffic flow diagram (ASCII) — Claude Code → Tier 2 env injection → AIClient2API :3000 → external providers
  2. Provider selection logic — how the pool manager picks healthy accounts, fallback chain, cooldowns
  3. Logging/retry/timeout paths — where errors are caught, what gets logged, retry behavior
  4. Security-sensitive areas — where API keys live (Credentials/), what the pool manager sees, shell exec locations
  Must NOT reference LiteLLM (removed in v2.0).
  `[auto] Selected: 4-subsection scope covering traffic, selection, logging, security (recommended default)`

### DOC-03: Removing Stale LiteLLM References

- **D-07:** Audit scope — all 9 identified active docs:
  `ARCHITECTURE.md`, `Troubleshooting-and-Fixes.md`, `TESTING.md`, `ANTHROPIC_GATEWAY_SPEC.md`,
  `GETTING-STARTED.md`, `Model-Guide.md`, `ULTIMATE-GOAL.md`, `CONFIGURATION.md`, `DEVELOPMENT.md`
  `[auto] Selected: audit all 9 identified docs (recommended default)`

- **D-08:** What to remove vs preserve:
  - **Remove:** actionable LiteLLM steps (install instructions, config examples, startup commands, port references for :8000/:8080)
  - **Preserve:** historical notes that explain *why* LiteLLM was removed ("LiteLLM was removed in v2.0 because it corrupted the Anthropic SSE stream")
  - **Reason:** The historical context prevents re-introduction; the actionable steps mislead operators.
  `[auto] Selected: preserve historical notes, remove actionable steps (recommended default)`

### Security Audit Approach

- **D-09 (SEC-01):** Run `grep -rn "sk-\|ghp_\|AIza\|OPENAI_API_KEY\s*=\|Bearer sk" src/ configs/*.json` and verify zero results for real tokens. Env var references (`process.env.X`) are fine — hardcoded string literals are not.
  `[auto] Selected: grep-first with targeted patterns (recommended default)`

- **D-10 (SEC-02):** Identified exec call sites to review (from codebase scout):
  - `src/core/plugin-security.js` — already has exec-detection pattern scanning (this is a security *guard*, not a vulnerability)
  - `src/core/plugin-manager.js` — uses child_process; check if user-controlled input flows to spawn args
  - `src/core/master.js` — uses child_process; check if external data reaches exec calls
  - `src/ui-modules/update-api.js` — update logic; verify version strings don't come from untrusted sources
  For each: confirm whether user-controlled input can reach the exec call. If yes → flag. If no (internal/config-driven only) → PASS.
  `[auto] Selected: manual review of 4 identified exec sites (recommended default)`

- **D-11 (SEC-03):** sync-credentials.js already has path traversal protection (`absPath.startsWith(PROJECT_DIR)` guard). sync-kiro-credentials.py reads from a local SQLite DB path — check that it doesn't accept user input for the DB path or write path. Both scripts should be reviewed for: (a) hardcoded tokens, (b) unchecked write destinations, (c) sensitive data in logs.
  `[auto] Selected: focused review on 3 risk areas per script (recommended default)`

### Claude's Discretion

- Exact wording and formatting of OPERATION.md — structure is locked (D-02), tone and verbosity within each section is Claude's call
- How to present the provider selection logic in SYSTEM-OVERVIEW.md — pseudocode vs prose vs table
- Whether to restructure DOC-03 docs or only remove the specific stale lines — prefer surgical removal, not restructuring

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source Files to Inspect

- `AIClient2API/src/core/plugin-manager.js` — exec/spawn usage; confirm input sanitization
- `AIClient2API/src/core/master.js` — exec/spawn usage; confirm input sanitization
- `AIClient2API/src/ui-modules/update-api.js` — update logic with child_process; verify no user-controlled exec args
- `AIClient2API/src/core/plugin-security.js` — exec-detection guard (already a security control; confirm it's not itself vulnerable)
- `AIClient2API/scripts/sync-credentials.js` — credential sync; review path traversal guard + hardcoded token risk
- `AIClient2API/scripts/sync-kiro-credentials.py` — Kiro OAuth sync; review write paths + sensitive log exposure
- `AIClient2API/src/providers/provider-pool-manager.js` — provider selection logic for SYSTEM-OVERVIEW.md accuracy

### Documentation to Create

- `AIClient2API/OPERATION.md` — new file; 3-section runbook (add provider, test connectivity, troubleshoot)
- `MASTER-C/docs/SYSTEM-OVERVIEW.md` — new file; 2-tier architecture traffic flow + security areas

### Documentation to Update (DOC-03)

All 9 of these contain stale LiteLLM references — each must be audited and cleaned:
- `MASTER-C/docs/ARCHITECTURE.md`
- `MASTER-C/docs/Troubleshooting-and-Fixes.md`
- `MASTER-C/docs/TESTING.md`
- `MASTER-C/docs/ANTHROPIC_GATEWAY_SPEC.md`
- `MASTER-C/docs/GETTING-STARTED.md`
- `MASTER-C/docs/Model-Guide.md`
- `MASTER-C/docs/ULTIMATE-GOAL.md`
- `MASTER-C/docs/CONFIGURATION.md`
- `MASTER-C/docs/DEVELOPMENT.md`

### Architecture Context

- `.planning/REQUIREMENTS.md` — DOC-01, DOC-02, DOC-03, SEC-01, SEC-02, SEC-03 define success criteria
- `.planning/ROADMAP.md` Phase 2 — 3 success criteria (OPERATION.md add-provider, SYSTEM-OVERVIEW.md 2-tier, grep secrets = zero)
- `MASTER-C/CLAUDE.md` — Memory guard rules, Credentials/ directory location, hard rules
- `.planning/phases/01-critical-fixes-connectivity/01-CONTEXT.md` — Phase 1 decisions (esp. D-10: curl one-liners to migrate to OPERATION.md)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `AIClient2API/scripts/live-verify.cjs` — Smoke test script; Section 2 of OPERATION.md should document `pnpm run smoke` as the primary connectivity test tool
- `AIClient2API/scripts/safe-restart.sh` — Restart script; reference in OPERATION.md troubleshooting section
- `AIClient2API/src/core/plugin-security.js` — Already audits for exec calls in plugins; this is a positive security control

### Established Patterns

- **Surgical edits for DOC-03:** Remove only stale LiteLLM lines — do not restructure docs. The docs may have headings, config tables, or startup steps that assume a 3-tier architecture. Remove or update those specific lines only.
- **No secrets in commits:** `AIClient2API/configs/provider_pools.json` contains live OAuth tokens — SEC-01 grep must NOT match it (it's in .gitignore context)
- **Credentials/ is the canonical location:** `MASTER-C/Credentials/` holds all credential files — SYSTEM-OVERVIEW.md must reflect this
- **pnpm only:** All npm script examples in OPERATION.md must use `pnpm`, never `npm`

### Integration Points

- OPERATION.md Section 1 connects to: `configs/config.json` (providerFallbackChain), `configs/model-catalog.json` (model IDs), `configs/provider_pools.json` (credentials)
- OPERATION.md Section 2 connects to: `pnpm run smoke`, `pnpm run check:models`, `pnpm run check:chat`, `/provider_health` endpoint
- OPERATION.md Section 3 connects to: `scripts/safe-restart.sh`, `logs/app-YYYY-MM-DD.log`, `pnpm test`

</code_context>

<specifics>
## Specific Ideas

- The curl one-liners from Phase 1 (D-11 in Phase 1 CONTEXT) should be migrated verbatim into OPERATION.md Section 2. They work and are already validated.
- OPERATION.md troubleshooting section should cover the 3 most common failure modes observed: (1) ECONNREFUSED (proxy not running), (2) 429/quota exceeded (pool cooldown), (3) wrong model routing (model ID mismatch in fallback chain)
- SYSTEM-OVERVIEW.md should include an ASCII traffic diagram — it's the fastest way to communicate the 2-tier topology to a new operator
- For DOC-03, the most egregious stale references are likely in GETTING-STARTED.md and DEVELOPMENT.md (they have setup steps). ARCHITECTURE.md and ULTIMATE-GOAL.md may just have historical mentions that can be kept.

</specifics>

<deferred>
## Deferred Ideas

- Add per-provider latency tracking to cockpit.db → v2 requirements (OBS-01–03), not this project
- Web dashboard for provider health → out of scope (CLI-only by design)
- Fix /provider_health to show SKIP instead of FAIL for isDisabled providers → Phase 3 (architecture)
- Observability and structured logging → v2 requirements

</deferred>

---

*Phase: 2-Documentation-Security*
*Context gathered: 2026-06-05*
