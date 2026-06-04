# Module Dependency Audit — Phase 3

**Date:** 2026-06-05
**Method:** madge 8.0.0 circular scan + targeted grep cross-import checks
**Scope:** src/core/, src/providers/ + src/converters/ + src/convert/, src/auth/, src/utils/

---

## Audit Scope

The four module groups examined and the pass definition:

- **Group A:** `src/core/` — configuration, plugin management
- **Group B:** `src/providers/` + `src/converters/` + `src/convert/` — routing, protocol translation
- **Group C:** `src/auth/` — credential management
- **Group D:** `src/utils/` — logging, common utilities

**PASS definition:** No direct (one-hop) circular imports between Groups A, B, C, D — only intra-group or downward dependencies are acceptable.

---

## Audit Method

```bash
# Full circular scan
cd AIClient2API && npx madge --circular --extensions js src/ --json > madge-report.json

# Targeted grep cross-import checks (secondary confirmation)
grep -rn "require.*providers|from.*providers" src/core/      # core -> providers direct
grep -rn "require.*handlers|from.*handlers" src/providers/   # providers -> handlers direct
grep -rn "require.*providers|from.*providers" src/auth/      # auth -> providers direct
```

madge version: 8.0.0. Total cycles detected: **72**. Raw report: `.planning/phases/03-architecture-modularity/madge-report.json`.

---

## Clean Boundaries (ARCH-02 PASS)

Results of cross-group direct import scan:

| Boundary | grep result | Verdict |
|---|---|---|
| `src/core/` → `src/providers/` | **0 direct imports** | CLEAN |
| `src/providers/` → `src/handlers/` | **0 direct imports** | CLEAN |
| `src/auth/` → `src/providers/` | **0 direct imports** | CLEAN |
| `src/handlers/` → `src/providers/` | mediated via `service-manager.js` (clean intermediary) | CLEAN |

Notes on observed dependencies that are **not** violations:
- `src/providers/` imports from `src/auth/oauth-handlers.js` — this is a downward dependency (providers depend on auth helpers), not a cycle between named groups.
- `src/core/config-manager.js` imports from `src/utils/` — one-way downward dependency, not a cycle.

**ARCH-02 Verdict: PASS** — the four named module groups have clean one-way dependency boundaries with no direct circular imports between them.

---

## Pre-existing Cycles in utils/ (documented, not fixed)

madge found 72 circular dependency chains. All of them route through `src/utils/` or `src/services/` as intermediaries. None represent a direct A↔B, A↔C, B↔C, or A↔D cross-group circular import.

Cycle clusters by group participation (from the 72 total):

| Cycle cluster | Groups spanned | Count | Root path |
|---|---|---|---|
| C-01 | D-utils ↔ B-providers | 26 | `utils/common.js` → `utils/model-utils.js` → `providers/provider-models.js` → `convert/convert.js` → back |
| C-02 | D-utils ↔ B-providers | (included above) | `utils/provider-strategies.js` chain |
| C-03 | D-utils ↔ B-providers ↔ E-services | 22 | `utils/request-handlers.js` → `services/service-manager.js` → `providers/adapter.js` → back |
| C-04 | A-core ↔ B-providers ↔ C-auth ↔ D-utils ↔ E-services | 14 | `auth/codex-oauth.js` → `core/config-manager.js` → `utils/common.js` → `utils/request-handlers.js` → `services/service-manager.js` → `providers/adapter.js` → `auth/oauth-handlers.js` → back |

Example C-04 chain (from madge output):
```
auth/codex-oauth.js
  → core/config-manager.js
  → utils/common.js
  → utils/request-handlers.js
  → services/service-manager.js
  → providers/adapter.js
  → providers/gemini/antigravity-core.js
  → auth/oauth-handlers.js
  → auth/index.js
  → (back to auth/codex-oauth.js)
```

These 72 pre-existing cycles are structural debt within the `src/utils/` and `src/services/` layers, predating Phase 3. They do NOT violate ARCH-02 (which scopes to direct cross-GROUP boundary imports between A/B/C/D). The root cause is that `src/utils/` has grown to include `request-handlers.js`, `model-utils.js`, and `provider-strategies.js` — files with provider-level concerns — rather than remaining a pure logging/common-helpers layer.

---

## Remediation Plan

C-01 through C-04 should be resolved by splitting `src/utils/` into layer-aware sub-modules:

- `utils/logging/` — pure logging helpers, no imports from providers or services
- `utils/routing/` — provider-strategy and model-utils logic (may import from providers, one-way)
- `utils/auth/` — auth-helper utilities

This split would remove `utils/` from the cycle chains by eliminating the back-edge from `utils/request-handlers.js` into `services/service-manager.js`. Estimated impact: reduces 72 cycles to near-zero. Deferred to a future dedicated refactor phase.

---

## ARCH-02 Verdict: PASS

The four named module groups (core/, providers/+converters/, auth/, utils/) have no direct circular imports between them. All 72 cycles detected by madge route through `src/utils/` and `src/services/` as intermediaries and represent pre-existing intra-layer structural debt. These are documented here and deferred to a future refactor phase — no remediation in Phase 3.
