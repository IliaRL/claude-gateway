# Retrospective

---

## Milestone: v2.0 — Proxy Excellence

**Shipped:** 2026-06-05
**Phases:** 3 | **Plans:** 9 | **Commits:** 60

### What Was Built

- Verified proxy stability (BUG-01/02) — both were pre-fixed; verification was pure audit work
- Added one-command proxy validation: `pnpm run smoke` runs in 11.95s
- Security audit passed — 4 exec call sites reviewed, no injection paths; kiro sync script stale path fixed
- Created OPERATION.md (259-line operator runbook) and docs/SYSTEM-OVERVIEW.md (203-line architecture reference)
- Cleaned LiteLLM refs from 9 active docs (7 already clean, 2 needed updates)
- Activated forward-api adapter (1-line uncomment) and proved 2-file provider addition workflow
- Eliminated hardcoded model IDs from claude-core.js; enhanced /provider_health to surface disabled providers

### What Worked

- **Pre-execution research first** — Phase 1 discovered BUG-01 and BUG-02 were pre-fixed before writing any code. Saved time, prevented unnecessary changes.
- **madge audit before claiming ARCH-02** — 72 cycles looked bad in the count, but the audit revealed all are via utils/ intermediary with no direct cross-group boundary imports. Running the tool prevented a false negative conclusion.
- **Security audit in Phase 2 scope** — finding and fixing the sync-kiro-credentials.py stale path was a real correctness bug caught by treating security as a first-class phase deliverable, not an afterthought.
- **Coarse granularity (3 phases for v2.0)** — the system already worked; surgical phases were the right scope. No greenfield architecture to design.

### What Was Inefficient

- **REQUIREMENTS.md checkbox tracking never updated during execution** — all 18 requirements are "Pending" in the traceability table despite being verifiably complete. Future milestones should update REQUIREMENTS.md after each phase or plan completes, not leave it as a documentation artifact.
- **Phase 1 opened a cosmetic issue (DIAG-04) that wasn't fixed until Phase 3** — the openai-custom FAIL→SKIP display issue was noticed in Phase 1 but deferred to Phase 3. Could have been fixed immediately in Phase 1 as a small addition.

### Patterns Established

- **SUMMARY.md files are the authoritative completion evidence** — when REQUIREMENTS.md checkboxes lag behind, the SUMMARY.md per plan is the source of truth. Accept this as a workflow norm.
- **Verify before building** — checking what's pre-existing before coding is always worth the time. Phase 1 found both BUG tasks were already done.
- **forward-api as the canonical "add a provider" example** — the pre-implemented but unregistered adapter became the live proof of the 2-file workflow without adding a real external dependency.

### Key Lessons

1. Check the codebase before assuming a bug fix is needed — "pre-existing" is a valid completion state.
2. Audit the actual output (madge, grep) before declaring architecture pass/fail — counts alone mislead.
3. Update REQUIREMENTS.md traceability table as plans complete, not retroactively at milestone close.
4. The /provider_health endpoint should surface *all* providers (including disabled) — operators need the full picture to debug routing issues.

### Cost Observations

- Model mix: Claude Sonnet 4.6 (primary throughout)
- Sessions: ~6 working sessions over 2 days
- Notable: Phase 1 was the fastest (pre-existing fixes) despite being scoped as the most uncertain

---

## Cross-Milestone Trends

| Metric | v1.0 | v2.0 |
|--------|------|------|
| Phases | 3 | 3 |
| Plans | ~6 | 9 |
| Duration | ~1 week | 2 days |
| Tests | 179 green | 203 green (9 pre-existing cred fails) |
| Primary model | Sonnet 4.x | Sonnet 4.6 |
| Scope | Greenfield architecture | Surgical improvement |
| Surprise | LiteLLM SSE corruption | BUG tasks pre-fixed |
