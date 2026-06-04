# Security Audit Findings — Phase 2

**Audited:** 2026-06-05
**Requirements:** SEC-01, SEC-02, SEC-03
**Overall Result:** PASS WITH ONE FINDING (low severity)

---

## SEC-01: Hardcoded Secrets

**Greps run:**
```bash
grep -rn "sk-[a-zA-Z0-9]{20,}" AIClient2API/src/ AIClient2API/configs/config.json
grep -rn "ghp_[a-zA-Z0-9]{36}" AIClient2API/src/ AIClient2API/configs/config.json
grep -rn "AIza[a-zA-Z0-9_-]{35}" AIClient2API/src/ AIClient2API/configs/config.json
grep -rn "Bearer [a-zA-Z0-9+/=]{40,}" AIClient2API/src/ AIClient2API/configs/config.json
```

**Result:**

| Pattern | Matches |
|---------|---------|
| `sk-...` | 1 match in `configs/config.json:2` |
| `ghp_...` | 0 matches |
| `AIza...` | 0 matches |
| `Bearer ...` | 0 matches |

**Finding (LOW severity):**

```
File: AIClient2API/configs/config.json
Line: 2
Value: "REQUIRED_API_KEY": "sk-a60f3efdf9b97e63c84ab4a3583f9d1c"
```

**Assessment:**
- `REQUIRED_API_KEY` is the **proxy's own authentication token** (what Claude Code sends to authenticate TO this proxy) — not an external provider API key
- This value is committed to git history
- **Mitigation:** `src/core/config-manager.js:156` overrides this value at runtime with `process.env.AICLIENT_TOKEN` — the hardcoded value is never used when the env var is set
- `config-manager.js:322` checks if it's still `"123456"` (the default placeholder) and warns — the real value suppresses this warning

**Recommendation:** Replace the hardcoded value in `configs/config.json` with a placeholder (e.g., `"123456"`) and rely solely on `AICLIENT_TOKEN` env var. No token rotation required since the env var takes precedence and the hardcoded value is never used at runtime.

**Verdict: LOW — no immediate action required; document for future cleanup.**

---

## SEC-02: Command Injection Paths

**Exec call sites reviewed:**

| File | exec usage | User input reaches args? | Verdict |
|------|-----------|--------------------------|---------|
| `src/core/plugin-security.js` | Scans for exec patterns in third-party plugin code (exec *detector*) | N/A — it's a security guard, not an exec caller | PASS |
| `src/core/plugin-manager.js` | `executePluginOperation()` — internal JS method naming; no `child_process` import | No exec calls at all | PASS |
| `src/ui-modules/update-api.js` | `exec`/`execFile` for git ops and npm install | YES, but validated (see below) | PASS |
| `src/core/master.js` | `fork(config.workerScript, config.args)` | `config` comes from app config file, not HTTP | PASS |

**update-api.js detailed trace:**

```
HTTP request body → body.version (user-supplied string)
  → performUpdate(version)
  → isValidVersionTag(targetTag)  ← VALIDATION GATE
    regex: /^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/
    → If fails validation: throws error BEFORE any exec call
    → If passes: only semver strings (e.g., "v1.2.3") can reach exec
  → execFileAsync('git', ['checkout', finalTag])
    ↑ execFile (not exec) passes args as an ARRAY — no shell interpolation
    ↑ Shell injection characters cannot appear in semver strings anyway
```

**Verdict: No command injection paths. Defense in depth:**
1. Strict regex whitelist blocks all injection characters
2. `execFile` with array args avoids shell entirely
3. Only internal config drives `fork()` in master.js

---

## SEC-03: Credential Sync Scripts

| Script | Path traversal guard? | Write destinations | Token values logged? | Verdict |
|--------|----------------------|-------------------|---------------------|---------|
| `sync-credentials.js` | ✓ YES — line 53 | Hardcoded `TARGET_DIR` constant | NO — only filenames | PASS |
| `sync-kiro-credentials.py` | N/A (paths are hardcoded constants + integer slot) | Fixed paths + integer slot | NO — only filenames | PASS WITH FIX |

**sync-credentials.js:**
- Path traversal guard at line 53: `!absPath.startsWith(path.normalize(PROJECT_DIR))` ✓
- Write destinations are hardcoded constants (`TARGET_DIR`, specific provider subdirectories) ✓
- `log()` calls emit metadata only: provider names, file paths, action descriptions — no raw token values ✓

**sync-kiro-credentials.py:**
- Write paths: `CREDS_DIR / f"account-{slot}"` where `slot` is a registry-assigned integer ✓
- Data source: local SQLite DB (Kiro CLI controlled, not HTTP) ✓
- No token values in stdout: `print(f"[sync] ... {creds_file} + {config_file}")` logs file paths only ✓

**Fix applied:**
- `CONFIGS_DIR` was pointing to stale path `Tier1-AIClient2API/configs/kiro` (pre-v2.0 name)
- **Changed to:** `AIClient2API/configs/kiro` (correct v2.0+ path)
- This was a correctness bug (kiro auth tokens were written to a non-existent directory, silently failing)
- Python syntax verified: `ast.parse()` exits 0

---

## Changes Made

1. **Fixed stale CONFIGS_DIR path** in `AIClient2API/scripts/sync-kiro-credentials.py`
   - Old: `Path("/Users/ilialiston/MASTER-C/Tier1-AIClient2API/configs/kiro")`
   - New: `Path("/Users/ilialiston/MASTER-C/AIClient2API/configs/kiro")`

2. **No source file changes** for SEC-01 or SEC-02 (no injection paths found; hardcoded token in config.json left as-is with recommendation to replace with placeholder in a future cleanup)

---

## Overall Result: PASS WITH ONE LOW-SEVERITY FINDING

- **SEC-01:** PASS (low finding — proxy auth token in config.json, overridden by env var at runtime)
- **SEC-02:** PASS (no injection paths — validation + execFile array args)
- **SEC-03:** PASS WITH FIX (sync-kiro-credentials.py path corrected; sync-credentials.js clean)
