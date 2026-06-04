# Phase 1: Critical Fixes + Connectivity Tests - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in 01-CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-04
**Phase:** 01-critical-fixes-connectivity
**Mode:** --auto (all areas auto-selected, recommended defaults chosen)
**Areas discussed:** SyntaxError fix scope, Disabled provider handling, Connectivity test entry point, Curl one-liner documentation

---

## SyntaxError Fix Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal surgical patch | Use node --check to find exact error, fix only that, run tests | ✓ |
| Broader inspection + cleanup | Read surrounding context, refactor adjacent code | |

**Auto selection:** Minimal surgical patch (recommended)
**Notes:** The handoff notes cite line 1830 but lines 1820–1845 scan clean. Use `node --check` to locate the actual error position. Karpathy principle: touch only what's broken.

---

## Disabled Provider Handling

| Option | Description | Selected |
|--------|-------------|----------|
| Mark disabled in pool config | Set enabled: false or status: disabled in provider_pools.json | ✓ |
| Remove from all fallback chains | Edit providerFallbackChain in config.json to remove openai-custom | |
| Leave as-is (document) | No change, just document that it's disabled | |

**Auto selection:** Mark disabled in pool config (recommended)
**Notes:** openai-custom appears in 5 fallback chain entries. The pool manager already skips providers with zero healthy accounts. Marking disabled is reversible if credentials come back.

---

## Connectivity Test Entry Point

| Option | Description | Selected |
|--------|-------------|----------|
| Alias pnpm run smoke → live-verify.cjs --quick | Reuse existing accurate script | ✓ |
| Write new smoke script from scratch | New purpose-built one-liner runner | |

**Auto selection:** Alias to live-verify.cjs --quick (recommended)
**Notes:** live-verify.cjs is already accurate, quota-safe, semantically validates responses, and has --quick mode for per-provider testing. Adding a new script would be redundant.

---

## Curl One-Liner Documentation Home

| Option | Description | Selected |
|--------|-------------|----------|
| Document in package.json scripts section | As npm run comments | ✓ |
| Add to OPERATION.md (Phase 2) | Formal runbook location | |
| Add to live-verify.cjs header | Where existing usage docs live | |

**Auto selection:** Document in package.json as comments now; formalize in OPERATION.md in Phase 2
**Notes:** Phase 2 owns the runbook. Phase 1 defines the commands. Capture them in package.json so they're findable immediately.

---

## Claude's Discretion

- Exact flag name for disabling openai-custom in pool config (use whatever the pool manager already supports)
- Whether to add `# DISABLED — credential revoked` comments to fallback chain entries

## Deferred Ideas

- OPERATION.md runbook → Phase 2
- Module boundary improvements → Phase 3  
- Security audit of credential sync scripts → Phase 2
- Observability/latency tracking → v2 requirements backlog
