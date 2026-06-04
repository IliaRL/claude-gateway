---
plan_id: 03-P03
phase: 3
objective: "Produce the ARCH-02 module dependency audit artifact, fix the provider_health endpoint to surface disabled providers as 'disabled' instead of silently dropping them, and confirm all phase success criteria are met."
wave: 2
depends_on:
  - 03-P01
  - 03-P02
files_modified:
  - AIClient2API/src/services/service-manager.js
  - AIClient2API/docs/ARCH-AUDIT.md
autonomous: true
requirements_addressed:
  - ARCH-02
must_haves:
  truths:
    - "docs/ARCH-AUDIT.md exists and documents pre-existing cycle clusters with PASS verdict for core/providers/handlers/auth boundaries"
    - "service-manager.js provider_health output includes disabled provider entries with status field of 'disabled'"
    - "disabled providers are NOT counted in unhealthyCount"
    - "proxy restarts cleanly after service-manager.js changes"
    - "curl /provider_health returns JSON with disabledCount field"
---

# Plan 03-P03: Module Audit + provider_health Enhancement (ARCH-02)

## Objective

ARCH-02 requires confirming no circular imports between the core, routing, logging, and auth module groups. Research found 22+ pre-existing circular cycles — all within the `utils/` layer — while the four named groups (core/, providers/, auth/, handlers/) have clean one-way dependencies. This plan runs a fresh madge audit, writes `docs/ARCH-AUDIT.md` documenting the findings and verdict, and fixes the `provider_health` endpoint to surface disabled providers as `"status":"disabled"` instead of silently dropping them (a deferred Phase 2 item confirmed in scope by CONTEXT.md). Runs in Wave 2 after P01 and P02 complete.

<threat_model>
**Threats considered:**
- Modifying the provider_health slimArr builder in service-manager.js could change the response shape expected by clients (e.g., Claude Code status line parser).
- Adding disabled providers to the response could inflate the `count` field, changing `unhealthyRatio` calculations.
- The madge audit command may not be available in the project's pnpm environment.

**Mitigations in this plan:**
- The provider_health response shape is extended, not changed: a new `"status"` field and `disabledCount` counter are added. Existing fields are unchanged. Clients that ignore unknown fields are unaffected.
- Disabled providers are explicitly excluded from `unhealthyCount`. The `unhealthyRatio` denominator covers all providers including disabled, which correctly lowers the ratio (disabled ≠ unhealthy).
- If `npx madge` fails, fall back to the targeted grep-based cross-import checks documented in RESEARCH.md D-09 fallback. The audit artifact must be written either way.
</threat_model>

## Tasks

<task id="T01" type="execute">
<title>Run madge circular dependency audit and save report</title>

<read_first>
- AIClient2API/package.json — check if madge is listed as a dev dependency; if so, use pnpm exec; if not, use npx
- .planning/phases/03-architecture-modularity/03-RESEARCH.md — ARCH-02 section listing the 4 cycle clusters (C-01 through C-04) and their root causes
- .planning/phases/03-architecture-modularity/03-CONTEXT.md — D-09, D-10, D-11 defining audit scope and fallback method
</read_first>

<action>
From the AIClient2API directory, run the madge circular scan:
    cd AIClient2API && npx madge --circular --extensions js src/ --json > ../.planning/phases/03-architecture-modularity/madge-report.json 2>&1

If madge is not available (command not found), run the fallback grep-based cross-import checks instead and write their output to the same file:
    grep -rn "require.*providers\|from.*providers" AIClient2API/src/core/ > .planning/phases/03-architecture-modularity/madge-report.json 2>&1
    grep -rn "require.*handlers\|from.*handlers" AIClient2API/src/providers/ >> .planning/phases/03-architecture-modularity/madge-report.json 2>&1
    grep -rn "require.*providers\|from.*providers" AIClient2API/src/auth/ >> .planning/phases/03-architecture-modularity/madge-report.json 2>&1
    echo "GREP_FALLBACK: madge not available" >> .planning/phases/03-architecture-modularity/madge-report.json

Do NOT run madge from /Users/ilialiston/MASTER-C root — it would scan the entire monorepo. Run from AIClient2API/ only, targeting src/ subdirectory.
</action>

<acceptance_criteria>
- `.planning/phases/03-architecture-modularity/madge-report.json` exists and is non-empty (`wc -c` returns > 0)
- If madge succeeded: the file is parseable JSON (`node -e "require('./.planning/phases/03-architecture-modularity/madge-report.json')"` exits 0)
- If grep fallback was used: file contains grep output lines (may be empty if no cross-group imports found, which is the expected PASS result)
</acceptance_criteria>
</task>

<task id="T02" type="execute">
<title>Write docs/ARCH-AUDIT.md with audit findings and verdict</title>

<read_first>
- .planning/phases/03-architecture-modularity/madge-report.json — raw cycle data from T01
- .planning/phases/03-architecture-modularity/03-RESEARCH.md — full ARCH-02 section: 4 cycle clusters, clean cross-import grep results, verdict language
- .planning/phases/03-architecture-modularity/03-CONTEXT.md — D-11: scope is core/, providers/, auth/, utils/ groups; pre-existing cycles are documented not fixed
- AIClient2API/docs/ — list to understand existing doc naming conventions
</read_first>

<action>
Create `AIClient2API/docs/ARCH-AUDIT.md` with the following sections:

1. **Header:** `# Module Dependency Audit — Phase 3` with audit date and method.

2. **Audit Scope:** State the four module groups examined (src/core/, src/providers/ + src/converters/, src/auth/, src/utils/) and the pass definition: no circular imports BETWEEN these groups.

3. **Audit Method:** State the command run (npx madge --circular --extensions js src/ or grep fallback), tool version if available, and the grep-based cross-import checks.

4. **Clean Boundaries (PASS):** Document the four clean cross-group boundaries:
   - `src/core/` → `src/providers/`: 0 imports (core does not import provider internals)
   - `src/providers/` → `src/handlers/`: 0 imports (providers do not import handler logic)
   - `src/auth/` → `src/providers/`: 0 direct imports (auth does not import provider internals)
   - `src/handlers/` → `src/providers/`: mediated via service-manager.js (clean intermediary, not a cycle)
   **Verdict for ARCH-02: PASS**

5. **Pre-existing Cycles in utils/ (documented, not fixed):** Document the 4 cycle clusters from RESEARCH.md:
   - C-01: utils/ → providers/provider-models → convert/ → converters/ConverterFactory → utils/
   - C-02: utils/ → utils/model-utils → providers/*-strategy.js → utils/
   - C-03: utils/request-handlers → services/service-manager → providers/adapter → utils/
   - C-04: auth/codex-oauth → core/config-manager → utils/ → providers/ → auth/
   State clearly: these 22+ cycles are pre-existing structural debt within the `utils/` layer, predating Phase 3. They do NOT violate ARCH-02 (which scopes to cross-GROUP boundaries, not intra-utils). Remediation is deferred.

6. **Remediation Plan:** Note C-01 through C-04 should be resolved by splitting `src/utils/` into sub-modules. Deferred to a future phase.

7. **ARCH-02 Verdict:** `PASS` — the four named module groups have clean one-way dependency boundaries.
</action>

<acceptance_criteria>
- `ls AIClient2API/docs/ARCH-AUDIT.md` exits 0 (file exists)
- `grep -c "PASS" AIClient2API/docs/ARCH-AUDIT.md` returns at least 2
- `grep "C-01\|C-02\|C-03\|C-04" AIClient2API/docs/ARCH-AUDIT.md` returns 4 results
- `grep "pre-existing\|deferred" AIClient2API/docs/ARCH-AUDIT.md` returns results
</acceptance_criteria>
</task>

<task id="T03" type="execute">
<title>Fix provider_health to surface disabled providers as "disabled" status</title>

<read_first>
- AIClient2API/src/services/service-manager.js — lines 710-785 (full slimArr builder function; focus on lines 739-784 containing the filter, map, count logic, and return object)
- .planning/phases/03-architecture-modularity/03-RESEARCH.md — the "provider_health SKIP vs FAIL" section describing exact lines to change (~741) and the three changes required
- AIClient2API/tests/ — search for any test asserting on the /provider_health response shape to understand breakage risk
</read_first>

<action>
In `AIClient2API/src/services/service-manager.js`, modify the slimArr builder block (lines 739-785) to include disabled providers with a `"status": "disabled"` field instead of silently filtering them out:

Change 1 — Remove the `isDisabled` blind filter. Find the line `if (item.isDisabled) return false;` around line 741 and remove it. Disabled items should pass through the filter into the slimmed output.

Change 2 — Add status field. In the .map() callback, after building the `slim` object, add:
    slim.status = item.isDisabled ? 'disabled' : (slim.isHealthy === false ? 'unhealthy' : 'healthy');

Change 3 — Exclude disabled from unhealthyCount. Find the `if (slim.isHealthy === false)` counting block and add an `isDisabled` guard:
    if (!item.isDisabled && slim.isHealthy === false) { unhealthyCount++; ... }

Change 4 — Track disabledCount. Declare `let disabledCount = 0;` before the loop. Add `if (item.isDisabled) disabledCount++;` inside the map callback. Add `disabledCount` to the return object alongside `count`, `unhealthyCount`, and `unhealthyRatio`.

These 4 changes are surgical: ~5 lines added, ~3 lines modified. Do not restructure the function or change any other logic.
</action>

<acceptance_criteria>
- `grep -n "isDisabled.*return false" AIClient2API/src/services/service-manager.js` returns zero results (blind filter removed)
- `grep -n "status.*disabled\|disabled.*status" AIClient2API/src/services/service-manager.js` returns at least one result
- `grep -n "disabledCount" AIClient2API/src/services/service-manager.js` returns at least 3 results (declaration, increment, return)
- Proxy restarts cleanly after this change
- `curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/provider_health` returns JSON without crashing
</acceptance_criteria>
</task>

<task id="T04" type="execute">
<title>Restart proxy and run full verification suite</title>

<read_first>
- AIClient2API/scripts/safe-restart.sh — restart command and memory guard
- AIClient2API/tests/ — list all test files to run
</read_first>

<action>
Run the complete verification sequence:

1. Restart proxy: `./AIClient2API/scripts/safe-restart.sh`

2. Check startup log: `grep -i "error\|TypeError\|Cannot" ~/MASTER-C/AIClient2API/logs/app-$(date +%Y-%m-%d).log | tail -20`

3. Check provider_health disabled status:
   `curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/provider_health`
   Verify response includes `disabledCount` field. If all current providers are enabled, confirm the code change is in place via grep and note the test condition.

4. Run all tests: `cd AIClient2API && pnpm test`

5. ARCH-01 smoke check: `grep -n "registerAdapter(MODEL_PROVIDER.FORWARD_API" AIClient2API/src/providers/adapter.js`

6. ARCH-03 zero-hardcoded-model check: `grep -rn "hardcoded model" AIClient2API/src/`

7. Confirm ARCH-AUDIT.md: `ls -la AIClient2API/docs/ARCH-AUDIT.md`
</action>

<acceptance_criteria>
- `./AIClient2API/scripts/safe-restart.sh` exits without error
- `grep -i "TypeError\|Cannot find\|SyntaxError" ~/MASTER-C/AIClient2API/logs/app-$(date +%Y-%m-%d).log` returns zero results after restart
- `cd AIClient2API && pnpm test` exits 0
- `grep -rn "hardcoded model" AIClient2API/src/` returns zero results
- `grep -n "registerAdapter(MODEL_PROVIDER.FORWARD_API" AIClient2API/src/providers/adapter.js` returns one uncommented result
- `ls AIClient2API/docs/ARCH-AUDIT.md` exits 0
- `curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/provider_health | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('count:', d.count, 'unhealthy:', d.unhealthyCount, 'disabled:', d.disabledCount)"` exits 0 with all three fields
</acceptance_criteria>
</task>

## Verification

```bash
# ARCH-01: 2-file workflow confirmed (from P01)
grep -n "registerAdapter(MODEL_PROVIDER.FORWARD_API" AIClient2API/src/providers/adapter.js
# Expected: one result, not commented

# ARCH-02: clean boundary confirmation
grep -rn "require.*providers\|from.*providers" AIClient2API/src/core/
# Expected: zero results
grep -rn "require.*handlers\|from.*handlers" AIClient2API/src/providers/
# Expected: zero results
ls AIClient2API/docs/ARCH-AUDIT.md
# Expected: file exists

# ARCH-03: zero hardcoded model IDs (from P02)
grep -rn "hardcoded model" AIClient2API/src/
# Expected: zero results

# provider_health disabled status
grep -n "status.*disabled" AIClient2API/src/services/service-manager.js
# Expected: at least one result
grep -n "disabledCount" AIClient2API/src/services/service-manager.js
# Expected: at least 3 results

# Full test suite
cd AIClient2API && pnpm test
# Expected: all pass

# Live health check with all Phase 3 fields
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/provider_health | \
  node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); \
    console.log('count:', d.count, '| unhealthy:', d.unhealthyCount, '| disabled:', d.disabledCount)"
# Expected: JSON with count, unhealthyCount, disabledCount fields present
```
