# Phase 2: Documentation + Security Audit - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-05
**Phase:** 02-documentation-security
**Mode:** --auto (all areas auto-selected, recommended options chosen)
**Areas discussed:** OPERATION.md placement, SYSTEM-OVERVIEW.md placement, DOC-03 cleanup depth, security audit approach, OPERATION.md structure

---

## OPERATION.md Placement

| Option | Description | Selected |
|--------|-------------|----------|
| `AIClient2API/OPERATION.md` | Colocated with the service; operators cd into AIClient2API to run commands | ✓ |
| `MASTER-C/docs/OPERATION.md` | Alongside architecture docs; consistent with docs/ structure | |

**Auto-selected:** `AIClient2API/OPERATION.md` (recommended default — colocated with service)
**Notes:** Operators interact with the service from the AIClient2API directory. The runbook belongs where the commands run.

---

## SYSTEM-OVERVIEW.md Placement

| Option | Description | Selected |
|--------|-------------|----------|
| `MASTER-C/docs/SYSTEM-OVERVIEW.md` | Consistent with existing architecture docs (ARCHITECTURE.md, CONFIGURATION.md) | ✓ |
| `AIClient2API/docs/SYSTEM-OVERVIEW.md` | Inside the Tier 1 service; visible without navigating to MASTER-C | |

**Auto-selected:** `MASTER-C/docs/SYSTEM-OVERVIEW.md` (recommended default — consistent with docs/ structure)
**Notes:** ARCHITECTURE.md, ULTIMATE-GOAL.md, and all other system-level docs live in MASTER-C/docs/. SYSTEM-OVERVIEW.md is the same category.

---

## OPERATION.md Structure

| Option | Description | Selected |
|--------|-------------|----------|
| 3-section runbook | (a) Add provider/model, (b) Test connectivity, (c) Troubleshoot | ✓ |
| Flat commands list | All commands in one section, alphabetically sorted | |
| Full design guide | Full narrative with background and rationale | |

**Auto-selected:** 3-section runbook (recommended default — matches DOC-01 requirements exactly)
**Notes:** DOC-01 explicitly names three tasks: add provider, test connectivity, troubleshoot. Sections map 1:1.

---

## DOC-03 Cleanup Depth

| Option | Description | Selected |
|--------|-------------|----------|
| Remove actionable, preserve historical | Remove setup steps / config examples; keep "was removed because..." notes | ✓ |
| Remove all LiteLLM mentions | Complete scrub of every LiteLLM reference | |
| Add deprecation notices only | Leave steps intact but mark them as deprecated | |

**Auto-selected:** Remove actionable, preserve historical (recommended default)
**Notes:** Historical context ("LiteLLM corrupted the Anthropic SSE stream") prevents accidental re-introduction. Actionable steps (install, config, startup) mislead operators. 9 docs identified for audit.

---

## Security Audit Approach

| Option | Description | Selected |
|--------|-------------|----------|
| Grep + manual exec-site review | grep for hardcoded secrets + manual review of 4 identified exec sites | ✓ |
| Grep only | Fast; may miss logic-level injection risks | |
| Full static analysis | Comprehensive but outside scope for this phase | |

**Auto-selected:** Grep + manual exec-site review (recommended default)
**Notes:** 4 exec call sites identified: plugin-security.js, plugin-manager.js, master.js, update-api.js. sync-credentials.js already has path traversal guard. sync-kiro-credentials.py needs focused review.

---

## Claude's Discretion

- Exact wording and formatting within each OPERATION.md section
- Whether to use pseudocode vs prose vs table for provider selection logic in SYSTEM-OVERVIEW.md
- Surgical removal approach for DOC-03 (line-level vs section-level)

## Deferred Ideas

- `/provider_health` SKIP vs FAIL for disabled providers → Phase 3
- Observability / latency tracking in cockpit.db → v2 requirements
- Web dashboard for provider health → out of scope
