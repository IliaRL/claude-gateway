# Phase 2: Documentation + Security Audit — Research

**Researched:** 2026-06-05
**Requirements:** DOC-01, DOC-02, DOC-03, SEC-01, SEC-02, SEC-03

---

## DOC-03: LiteLLM Reference Audit

**9 active docs in `MASTER-C/docs/` contain stale LiteLLM/Tier-2 references.**

| Doc | Ref Count | Priority |
|-----|-----------|----------|
| `ANTHROPIC_GATEWAY_SPEC.md` | 25 | High (has LiteLLM section) |
| `Troubleshooting-and-Fixes.md` | 11 | High (actionable steps) |
| `ULTIMATE-GOAL.md` | 5 | Medium (design intent doc) |
| `ARCHITECTURE.md` | 3 | Medium (architecture doc) |
| `TESTING.md` | 1 | Low (1 mention) |
| `GETTING-STARTED.md` | 1 | Low (1 mention) |
| `Model-Guide.md` | 1 | Low (1 mention) |
| `CONFIGURATION.md` | 1 | Low (1 mention) |
| `DEVELOPMENT.md` | 1 | Low (1 mention) |

**Strategy:**
- High-count docs: read in full, remove actionable LiteLLM steps, preserve `"LiteLLM was removed because..."` historical notes
- Low-count docs: targeted find-replace; likely just a stale paragraph or line

---

## SEC-01: Hardcoded Secret Patterns

**grep command to verify:**
```bash
grep -rn "sk-\|ghp_\|AIza\|api_key\s*=\s*['\"]" AIClient2API/src/ AIClient2API/configs/config.json
```

**Pattern used in codebase:** All credentials flow through `configs/provider_pools.json`
(loaded at runtime, not committed) and `Credentials/` folder (read by sync scripts). Source
files read from `process.env.*` or load from config files — never hardcode literal tokens.

**Expected result:** Zero matches for real token strings in `src/` or `configs/config.json`.

---

## SEC-02: Shell Exec Call Sites

Identified exec/spawn/fork usage in `src/`:

| File | Usage | Risk Assessment |
|------|-------|----------------|
| `src/core/plugin-security.js` | Scans for exec *in plugins* — it's a security **guard** | PASS — it's a detector, not a caller |
| `src/core/plugin-manager.js` | `executePluginOperation()` — internal JS method naming, no child_process import | PASS — not actual exec calls |
| `src/ui-modules/update-api.js` | `exec`/`execFile` for git operations (fetch, tag, checkout, tar) | LOW RISK — see below |
| `src/core/master.js` | `fork(config.workerScript, config.args, ...)` | LOW RISK — see below |

**update-api.js exec analysis:**
- Uses `exec('git fetch --tags')`, `exec('git tag --sort=-v:refname')`, `execFile('git', ['checkout', finalTag])`
- `finalTag` is derived from local git tags — not from any HTTP request body or user-supplied string
- `npm install` / `execFile('tar', ...)` — hardcoded args, no user input
- **Verdict:** No command injection path. Inputs are system-controlled (local git, hardcoded args).

**master.js fork analysis:**
- `fork(config.workerScript, config.args, ...)` where `config` comes from the app's own config file
- Not reachable from any HTTP handler
- **Verdict:** No command injection path.

**Conclusion:** No command injection vulnerability found. All exec calls use hardcoded args or
system-controlled inputs. The security pattern is: if user HTTP input never reaches an exec arg,
there is no injection risk. Verified: no req.body/req.query data flows to any exec call.

---

## SEC-03: Credential Sync Scripts

### sync-credentials.js

```
Location: AIClient2API/scripts/sync-credentials.js
```

**Security controls already in place:**
1. **Path traversal guard:** `absPath.startsWith(path.normalize(PROJECT_DIR))` — prevents reading files outside the project root
2. **No hardcoded tokens:** reads from `provider_pools.json` and credential JSON files
3. **Write destinations:** only writes to `TARGET_DIR = '/Users/ilialiston/MASTER-C/Credentials'` (hardcoded constant)
4. **No logging of token values** — only logs provider names and action descriptions

**Verdict:** PASS. No security issues. Consistent with secure patterns.

### sync-kiro-credentials.py

```
Location: AIClient2API/scripts/sync-kiro-credentials.py
```

**Security assessment:**
1. **Write paths:** All hardcoded constants + integer slot number → no path injection possible
   - `CREDS_DIR / f"account-{slot}"` where slot is a registry-assigned integer
2. **Data source:** Local SQLite DB at `~/.kiro-cli/data.sqlite3` — controlled by Kiro CLI, not HTTP requests
3. **No token values logged:** `print(f"[sync] ... {creds_file} + {config_file}")` logs file paths only

**One correctness bug found (not a security issue):**
- `CONFIGS_DIR = Path("/Users/ilialiston/MASTER-C/Tier1-AIClient2API/configs/kiro")` 
- Should be `Path("/Users/ilialiston/MASTER-C/AIClient2API/configs/kiro")` (renamed in v2.0)
- This causes silent write failure to the wrong path — the kiro auth token doesn't reach the proxy
- **Impact:** Security-neutral (no exposure), but operationally broken (Kiro auth not synced)
- **Fix:** Update the hardcoded path constant

**Verdict:** Security PASS. One correctness bug (stale path) to note in audit.

---

## DOC-01: OPERATION.md — "Adding a Provider" Research

**Current add-provider flow (3-file operation):**

1. **`configs/provider_pools.json`** — Add pool entry with credentials:
   ```json
   "new-provider": [{ "OPENAI_API_KEY": "...", "isHealthy": true, "isDisabled": false }]
   ```

2. **`configs/config.json → providerFallbackChain`** — Add to fallback chains:
   ```json
   "claude-sonnet-4-6": ["new-provider", "gemini-antigravity", "nvidia-nim"]
   ```

3. **`configs/model-catalog.json`** — Add model IDs for the provider

**Provider selection logic (from `src/providers/provider-pool-manager.js`):**
- `selectProvider()` at line 1052 filters: `isHealthy && !isDisabled && !needsRefresh`
- Score-based selection: `isDisabled || !isHealthy → score = 1e18` (never selected)
- Cooldown model-level: stored in `config.modelCooldowns[model]`
- Fallback path: `selectProviderWithFallback()` at line 1414 cascades through `providerFallbackChain`

**Validate command (post-add):** `pnpm run smoke` — tests one call per provider

---

## DOC-02: SYSTEM-OVERVIEW.md Architecture Research

**Traffic flow (confirmed from source):**
```
Claude Code CLI
  → ANTHROPIC_BASE_URL=http://127.0.0.1:3000
  → AIClient2API Tier 1 (:3000)
     → src/handlers/request-handler.js  (Anthropic → OpenAI translation)
     → src/providers/provider-pool-manager.js  (selectProviderWithFallback)
     → External provider (Kiro, Antigravity, GitHub, NVIDIA, Codex)
```

**Security-sensitive areas:**
- `configs/provider_pools.json` — live OAuth tokens (never commit, not in git)
- `MASTER-C/Credentials/` — credential files read by sync scripts
- `src/ui-modules/update-api.js` — exec calls for git/npm (system-controlled inputs only)
- `src/core/master.js` — fork for worker processes (config-driven)

**Logging path:**
- Output: `~/MASTER-C/AIClient2API/logs/app-YYYY-MM-DD.log`
- Controlled by: `LOG_DIR`, `LOG_LEVEL` in `configs/config.json`
- No sensitive token values logged (pool manager strips credentials before logging)

**Retry/timeout:**
- `REQUEST_MAX_RETRIES` in `configs/config.json`
- `RATE_LIMIT_COOLDOWN_MS` and `RATE_LIMIT_COOLDOWN_MAX_MS` for 429 handling
- `STREAM_TIMEOUT_MS` for SSE stream timeout

---

## Planning Recommendations

**Wave 1 (parallel — audit/read tasks):**
- `02-01`: SEC-01, SEC-02, SEC-03 — run grep, review findings, document results + fix stale sync path
- `02-02`: DOC-03 — remove stale LiteLLM refs from 9 docs (surgical)

**Wave 2 (parallel — write new docs, informed by Wave 1):**
- `02-03`: DOC-01 — write `AIClient2API/OPERATION.md` (3-section runbook)
- `02-04`: DOC-02 — write `MASTER-C/docs/SYSTEM-OVERVIEW.md` (2-tier architecture)

**Key constraints for planners:**
- `provider_pools.json` must NEVER be committed (`git add` specific files only)
- All npm commands use `pnpm`, never `npm`
- `safe-restart.sh` is the only valid restart mechanism
- OPERATION.md goes in `AIClient2API/` root, SYSTEM-OVERVIEW.md in `MASTER-C/docs/`
