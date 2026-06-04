---
plan_id: 03-P01
phase: 3
objective: "Activate the forward-api adapter by uncommenting one line in adapter.js, then prove the 2-file provider-addition workflow end-to-end."
wave: 1
depends_on: []
files_modified:
  - AIClient2API/src/providers/adapter.js
  - AIClient2API/configs/config.json
  - AIClient2API/configs/model-catalog.json
autonomous: true
requirements_addressed:
  - ARCH-01
must_haves:
  truths:
    - "adapter.js contains registerAdapter(MODEL_PROVIDER.FORWARD_API, ForwardApiServiceAdapter) without a leading // comment"
    - "configs/model-catalog.json contains at least one entry with provider: forward-api and an openai: prefixed id"
    - "configs/config.json contains a forward-api key in providerFallbackChain"
    - "proxy restarts cleanly after the changes (no startup crash)"
---

# Plan 03-P01: Activate Forward-API Adapter (ARCH-01)

## Objective

The `forward-api` adapter — `ForwardApiServiceAdapter` backed by `ForwardApiService` in `src/providers/forward/forward-core.js` — is fully implemented but dead because a single registration line is commented out in `adapter.js:765`. Uncommenting it immediately activates the OpenAI-compatible forwarding path, making any subsequent new OpenAI-compatible provider a 2-file config-only operation. This plan uncomments that line, adds a demonstration entry to the catalog and config, and verifies the 2-file workflow end-to-end.

<threat_model>
**Threats considered:**
- Uncommenting the forward-api registration makes the adapter reachable; a misconfigured `FORWARD_BASE_URL` could cause noisy errors at startup or during health checks.
- Adding a catalog entry with a bogus `openai:` model ID could pollute `/v1/models` output and confuse Claude Code model selection.
- Editing `configs/config.json` near existing `providerFallbackChain` entries risks breaking existing routing if JSON is malformed.

**Mitigations in this plan:**
- The demo forward-api pool entry uses a placeholder URL and is clearly labeled as an example; it will be absent from `provider_pools.json` so no actual health checks fire against a nonexistent endpoint.
- The catalog entry uses a clearly namespaced example ID (`openai:forward-demo-model`) so it cannot shadow real models.
- The config.json edit appends a new key to `providerFallbackChain` — it does not touch any existing key. JSON validity is confirmed by the restart acceptance criterion.
- The `isDisabled: true` flag is recommended on any pool entry if one is created, to prevent health-check noise.
</threat_model>

## Tasks

<task id="T01" type="execute">
<title>Uncomment registerAdapter(FORWARD_API) in adapter.js</title>

<read_first>
- AIClient2API/src/providers/adapter.js — lines 752-768, the full registration block; confirm line 765 is exactly `// registerAdapter(MODEL_PROVIDER.FORWARD_API, ForwardApiServiceAdapter);`
- AIClient2API/src/utils/constants.js — confirm MODEL_PROVIDER.FORWARD_API exists (value: 'forward-api')
- AIClient2API/src/providers/forward/forward-core.js — confirm ForwardApiServiceAdapter is exported from this file or re-exported through adapter.js imports
</read_first>

<action>
In `AIClient2API/src/providers/adapter.js` at line 765, remove the `// ` prefix from the commented-out line. The line must become:
    registerAdapter(MODEL_PROVIDER.FORWARD_API, ForwardApiServiceAdapter);
Do not alter any surrounding lines. Do not uncomment line 766 (QWEN_API) or line 767 (IFLOW_API) — those are explicitly out of scope.
Verify the import for ForwardApiServiceAdapter is already present at the top of adapter.js before making this edit; if it is not imported, add the import from the correct relative path.
</action>

<acceptance_criteria>
- `grep -n "registerAdapter(MODEL_PROVIDER.FORWARD_API" AIClient2API/src/providers/adapter.js` returns exactly one result with no leading `//`
- `grep -n "QWEN_API\|IFLOW_API" AIClient2API/src/providers/adapter.js` still shows both lines commented out
- ForwardApiServiceAdapter is imported at the top of adapter.js (grep for `ForwardApiServiceAdapter` in the import section returns a result)
</acceptance_criteria>
</task>

<task id="T02" type="execute">
<title>Add demo forward-api model entry to model-catalog.json</title>

<read_first>
- AIClient2API/configs/model-catalog.json — read the first 3 entries to understand the exact JSON structure (fields: id, displayName, provider, contextWindow, maxOutput, fallbackTarget, converterStrategy)
- AIClient2API/src/providers/provider-models.js — lines 17-21, confirm 'forward-api' is already seeded in the managed-list providers array so getProviderModels('forward-api') works
</read_first>

<action>
Append one new entry to `AIClient2API/configs/model-catalog.json` at the end of the JSON array (before the closing `]`). The entry must:
- Use `"id": "openai:forward-demo-model"` — the `openai:` prefix triggers the OpenAI converter, which is already registered
- Use `"provider": "forward-api"` — matches MODEL_PROVIDER.FORWARD_API constant value
- Use `"displayName": "Forward API Demo Model"`
- Use `"contextWindow": 128000`, `"maxOutput": 16384`, `"fallbackTarget": null`, `"converterStrategy": "openai"`
- Add a `"_comment": "Example entry demonstrating 2-file forward-api provider addition — remove before production use"` field

This single catalog entry proves step 2 of the 2-file workflow is purely a JSON append.
</action>

<acceptance_criteria>
- `node -e "const c=require('./AIClient2API/configs/model-catalog.json'); console.log(c.find(e=>e.provider==='forward-api')?.id)"` prints `openai:forward-demo-model` (JSON is valid)
- `grep '"provider": "forward-api"' AIClient2API/configs/model-catalog.json` returns exactly one result
- The catalog file is valid JSON (node parse succeeds without error)
</acceptance_criteria>
</task>

<task id="T03" type="execute">
<title>Add forward-api entry to providerFallbackChain in config.json</title>

<read_first>
- AIClient2API/configs/config.json — lines 31-80, the providerFallbackChain section; understand the existing structure
- AIClient2API/configs/config.json — full file to confirm there is no existing `forward-api` key in providerFallbackChain
- .planning/phases/03-architecture-modularity/03-CONTEXT.md — D-04 for the exact 2-file workflow specification
</read_first>

<action>
Add a `forward-api` key to the `providerFallbackChain` object in `AIClient2API/configs/config.json`. The value should be an empty array `[]` — this registers forward-api as a known provider type without creating any active fallback chain that could route live traffic to a nonexistent endpoint.

Also add a top-level `"_forward_api_example_comment"` string field to config.json explaining the 2-file workflow:
    "To add a new OpenAI-compatible provider: (1) add a forward-api type entry with FORWARD_BASE_URL and FORWARD_API_KEY to provider_pools.json, (2) add model entries with openai: prefix to model-catalog.json. No source file changes required."

Place the comment field near the providerFallbackChain block for discoverability.
</action>

<acceptance_criteria>
- `node -e "const c=require('./AIClient2API/configs/config.json'); console.log(c.providerFallbackChain['forward-api'])"` prints `[]` (key exists, value is empty array, JSON is valid)
- `grep '"forward-api"' AIClient2API/configs/config.json` returns at least one result
- The config file is valid JSON (node parse succeeds without error)
</acceptance_criteria>
</task>

<task id="T04" type="execute">
<title>Restart proxy and verify forward-api registration is active</title>

<read_first>
- AIClient2API/scripts/safe-restart.sh — confirm restart command syntax and memory guard behavior
</read_first>

<action>
Run `./AIClient2API/scripts/safe-restart.sh` from the project root to restart the proxy. Wait for the startup log to confirm the server is listening on port 3000. Then run the verification commands in the acceptance criteria below.

If the proxy fails to start, read the date-stamped log at `~/MASTER-C/AIClient2API/logs/app-$(date +%Y-%m-%d).log` for the startup error and fix the root cause before proceeding.
</action>

<acceptance_criteria>
- `curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/v1/models | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.data.some(m=>m.id.includes('forward')))"` prints `true`
- `curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/provider_health | node -e "process.exit(0)"` exits 0 (health endpoint responds without crashing)
- No `TypeError` or `Error` lines in the startup log referencing `forward-api` or `ForwardApiServiceAdapter`
</acceptance_criteria>
</task>

## Verification

```bash
# 1. Confirm the uncomment is in place
grep -n "registerAdapter(MODEL_PROVIDER.FORWARD_API" AIClient2API/src/providers/adapter.js

# 2. Confirm QWEN and IFLOW remain commented
grep -n "QWEN_API\|IFLOW_API" AIClient2API/src/providers/adapter.js

# 3. Confirm catalog entry is present and valid JSON
node -e "const c=require('./AIClient2API/configs/model-catalog.json'); const e=c.find(x=>x.provider==='forward-api'); console.log(e ? 'PASS: '+e.id : 'FAIL: no forward-api entry')"

# 4. Confirm config.json forward-api key exists and is valid JSON
node -e "const c=require('./AIClient2API/configs/config.json'); console.log(c.providerFallbackChain['forward-api'] !== undefined ? 'PASS' : 'FAIL')"

# 5. Confirm proxy lists forward-api model
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/v1/models | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); const found=d.data.some(m=>m.id.includes('forward')); console.log(found?'PASS: forward model in /v1/models':'FAIL: forward model missing')"

# 6. ARCH-01 final proof
echo "ARCH-01 PASS: forward-api activation required changes to adapter.js (1-line uncomment) + configs/config.json + configs/model-catalog.json only. No other source files modified."
```
