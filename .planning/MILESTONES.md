# Milestones

---

## v2.0 — Proxy Excellence ✅

**Shipped:** 2026-06-05
**Phases:** 3 | **Plans:** 9
**Timeline:** 2026-06-03 → 2026-06-05 (2 days, 60 commits)
**Files:** 38 files changed, +3,613/-51 lines

### Delivered

Made the already-working AIClient2API proxy exemplary: one-command connectivity validation, operator runbook, system architecture docs, security audit, and proven 2-file provider addition workflow.

### Key Accomplishments

1. Verified proxy stability — Antigravity SyntaxError pre-fixed (v3.2.0 merge), openai-custom correctly disabled at pool level
2. Added `pnpm run smoke`, `check:models`, `check:chat` — one-command proxy validation completes in 11.95s
3. Security audit passed — no command injection paths in 4 exec call sites, no hardcoded secrets; fixed stale Kiro sync path
4. Created OPERATION.md (259-line operator runbook) and docs/SYSTEM-OVERVIEW.md (203-line architecture reference)
5. Proven 2-file provider addition workflow via forward-api adapter activation (ARCH-01)
6. Eliminated hardcoded model IDs from claude-core.js; `/provider_health` now surfaces disabled providers with `status:"disabled"`

### Archive

- [v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md) — Full phase details and decisions
- [v2.0-REQUIREMENTS.md](milestones/v2.0-REQUIREMENTS.md) — All 18 requirements with outcomes

---

## v1.0 — Gateway Tool-Use Reliability ✅

**Shipped:** 2026-05-28
**Phases:** 3 | **Plans:** ~6
**Key outcomes:** LiteLLM removed, 2-tier architecture established, tool-use headers fixed, 179/179 tests green
