---
plan_id: 03-P02
phase: 3
objective: "Eliminate all hardcoded model IDs from the routing pipeline: replace claude-core.js listModels() hardcoded array with a catalog-sourced call, and annotate DEFAULT_HEALTH_CHECK_MODELS with catalog-compliance documentation."
wave: 1
depends_on: []
files_modified:
  - AIClient2API/src/providers/claude/claude-core.js
  - AIClient2API/src/providers/provider-pool-manager.js
autonomous: true
requirements_addressed:
  - ARCH-03
must_haves:
  truths:
    - "claude-core.js listModels() no longer contains any hardcoded model ID strings in an array literal"
    - "claude-core.js listModels() calls getProviderModels('claude-custom') imported from ../provider-models.js"
    - "provider-pool-manager.js DEFAULT_HEALTH_CHECK_MODELS has a JSDoc block explaining exact-match vs borrowed entries"
    - "grep -rn 'hardcoded model' AIClient2API/src/ returns zero results"
    - "pnpm test passes with no regressions from the listModels change"
---

# Plan 03-P02: Fix Hardcoded Model IDs (ARCH-03)

## Objective

Two locations in the source violate the model-catalog.json single-source-of-truth requirement. First, `claude-core.js:276-285` hardcodes 8 Claude model IDs in `listModels()` — these IDs will silently diverge from the catalog as models are added or removed. Second, `provider-pool-manager.js:78-94` has a `DEFAULT_HEALTH_CHECK_MODELS` map with 5 entries that borrow model IDs from other providers, which is correct behavior for managed-list providers but needs documentation to pass a catalog-compliance audit. This plan fixes the first violation with a code change and resolves the second with a JSDoc annotation.

<threat_model>
**Threats considered:**
- Replacing the hardcoded listModels array with getProviderModels('claude-custom') could return an empty array if the catalog has no claude-custom entries, causing /v1/models to return fewer models than expected.
- If getProviderModels is not already imported in claude-core.js, adding the import creates a new module dependency that could introduce a circular import.
- The JSDoc annotation on DEFAULT_HEALTH_CHECK_MODELS is documentation-only, but inaccurate documentation is worse than none.

**Mitigations in this plan:**
- Before replacing the hardcoded array, verify that model-catalog.json has claude-custom entries. If it does not, getProviderModels returns [] for managed-list providers — this is correct behavior (models come from live API calls, not a static fallback).
- Check existing imports in claude-core.js before adding getProviderModels import to avoid duplicates.
- Circular import risk is pre-existing (utils/ cycles documented in RESEARCH.md); adding one import within providers/ layer does not create a new cross-layer cycle.
- JSDoc annotation is written to be accurate per RESEARCH.md findings.
</threat_model>

## Tasks

<task id="T01" type="execute">
<title>Replace hardcoded listModels() array in claude-core.js with catalog-sourced call</title>

<read_first>
- AIClient2API/src/providers/claude/claude-core.js — lines 265-295 (full listModels method and class context); also lines 1-20 to see existing imports
- AIClient2API/src/providers/provider-models.js — lines 1-25 to see module exports; lines 172-195 to understand getProviderModels signature and return type
- AIClient2API/configs/model-catalog.json — grep for `"provider": "claude-custom"` to confirm entries exist before switching to catalog-sourced call
</read_first>

<action>
In `AIClient2API/src/providers/claude/claude-core.js`:

Step 1 — Add the import. If `getProviderModels` is not already imported near the top of the file, add:
    import { getProviderModels } from '../provider-models.js';

Step 2 — Replace the listModels() method body. The current body (lines 276-287) contains a multi-line `const models = [...]` array literal with 8 hardcoded objects plus a `return { models: models.map(...) }` line.

Replace the entire method body with:
    logger.info('[ClaudeApiService] Listing available models.');
    const ids = getProviderModels('claude-custom');
    return { models: ids.map(id => ({ name: id })) };

The logger.info call is preserved. The return shape `{ models: [{name: string}] }` is preserved. The hardcoded array is removed entirely.

Do NOT modify the JSDoc comment above listModels() or any other method in the class.
</action>

<acceptance_criteria>
- `grep -n "claude-4-sonnet\|claude-opus-4\|claude-3-7\|claude-3-5-sonnet\|claude-3-5-haiku\|claude-3-opus\|claude-3-haiku" AIClient2API/src/providers/claude/claude-core.js` returns zero results (all hardcoded IDs gone)
- `grep -n "getProviderModels" AIClient2API/src/providers/claude/claude-core.js` returns at least 2 results (one import, one call in listModels)
- `grep -n "getProviderModels('claude-custom')" AIClient2API/src/providers/claude/claude-core.js` returns exactly one result
- The listModels method still has a valid return statement (grep for `return { models:` returns a result)
</acceptance_criteria>
</task>

<task id="T02" type="execute">
<title>Add JSDoc annotation to DEFAULT_HEALTH_CHECK_MODELS documenting catalog-compliance</title>

<read_first>
- AIClient2API/src/providers/provider-pool-manager.js — lines 72-95 (comment block above the static field and the full DEFAULT_HEALTH_CHECK_MODELS map)
- .planning/phases/03-architecture-modularity/03-RESEARCH.md — the DEFAULT_HEALTH_CHECK_MODELS section listing exactly which 5 providers are "borrowed" and which 10 are exact catalog matches
</read_first>

<action>
In `AIClient2API/src/providers/provider-pool-manager.js`, replace the existing single-line comment above DEFAULT_HEALTH_CHECK_MODELS (around lines 76-77) with a multi-line JSDoc block:

    /**
     * Default health-check model per provider type.
     * Keys MUST match MODEL_PROVIDER constant values exactly.
     *
     * Catalog compliance:
     * - EXACT MATCH (model ID owned by provider in model-catalog.json):
     *   gemini-cli-oauth, gemini-antigravity, nvidia-nim, github-models,
     *   claude-kiro-oauth, openai-qwen-oauth, openai-iflow, openai-codex-oauth,
     *   grok-cli-oauth, grok-web
     * - BORROWED (managed-list providers with no static catalog entries;
     *   model ID is borrowed from another provider for health-check purposes only):
     *   openai-custom ('gpt-4o-mini' from github-models)
     *   atlascloud ('gpt-4o-mini' from github-models)
     *   claude-custom ('claude-sonnet-4-5-20250929' from claude-kiro-oauth)
     *   openaiResponses-custom ('gpt-4o-mini' from github-models)
     *   forward-api ('gpt-4o-mini' from github-models)
     *
     * Managed-list providers discover their models dynamically at runtime via live API calls.
     * Keep in sync with configs/model-catalog.json when catalog models are added or removed.
     */

Place this block immediately above the `static DEFAULT_HEALTH_CHECK_MODELS = {` line. Do not change any of the key-value pairs in the map itself — this edit is documentation only.
</action>

<acceptance_criteria>
- `grep -n "EXACT MATCH\|BORROWED\|managed-list" AIClient2API/src/providers/provider-pool-manager.js` returns results
- `grep -n "DEFAULT_HEALTH_CHECK_MODELS" AIClient2API/src/providers/provider-pool-manager.js` returns the static field declaration (map is still present, unchanged)
- `grep -c "gpt-4o-mini" AIClient2API/src/providers/provider-pool-manager.js` returns the same count as before the edit (no values changed)
- The file is valid JavaScript (proxy restarts cleanly in T03)
</acceptance_criteria>
</task>

<task id="T03" type="execute">
<title>Run tests and verify zero hardcoded-model grep</title>

<read_first>
- AIClient2API/tests/providers/model-catalog.test.js — lines 1-66, catalog structure tests most likely to exercise listModels
- AIClient2API/tests/unit/provider-pool-manager.test.js — lines 1-50, tests referencing DEFAULT_HEALTH_CHECK_MODELS
</read_first>

<action>
From the AIClient2API directory, run:
    cd AIClient2API && pnpm test -- tests/providers/model-catalog.test.js tests/unit/provider-pool-manager.test.js

If both pass, run the full test suite:
    pnpm test

If any test fails referencing listModels or DEFAULT_HEALTH_CHECK_MODELS, diagnose:
- A listModels test failure likely expects specific model IDs in the response — update the test to assert on the catalog-driven list rather than hardcoded strings.
- A DEFAULT_HEALTH_CHECK_MODELS failure from the JSDoc change is unexpected (JSDoc does not change runtime behavior) — if it occurs, read the test and fix root cause.

After tests pass, run the ARCH-03 success criterion:
    grep -rn "hardcoded model" AIClient2API/src/
</action>

<acceptance_criteria>
- `cd AIClient2API && pnpm test -- tests/providers/model-catalog.test.js` exits 0
- `cd AIClient2API && pnpm test -- tests/unit/provider-pool-manager.test.js` exits 0
- `grep -rn "hardcoded model" AIClient2API/src/` returns zero results
- Proxy restarts cleanly: `./scripts/safe-restart.sh` exits without error
</acceptance_criteria>
</task>

## Verification

```bash
# ARCH-03 success criterion
grep -rn "hardcoded model" AIClient2API/src/
# Expected: zero results

# Confirm hardcoded model IDs gone from claude-core.js
grep -n "claude-4-sonnet\|claude-sonnet-4\|claude-opus-4\|claude-3-7\|claude-3-5\|claude-3-haiku\|claude-3-opus" AIClient2API/src/providers/claude/claude-core.js
# Expected: zero results

# Confirm catalog-sourced call in place
grep -n "getProviderModels('claude-custom')" AIClient2API/src/providers/claude/claude-core.js
# Expected: one result

# Confirm JSDoc annotation added
grep -n "EXACT MATCH\|BORROWED" AIClient2API/src/providers/provider-pool-manager.js
# Expected: results in the JSDoc block

# Run targeted tests
cd AIClient2API && pnpm test -- tests/providers/model-catalog.test.js tests/unit/provider-pool-manager.test.js
# Expected: all pass

# Full test suite
cd AIClient2API && pnpm test
# Expected: all pass
```
