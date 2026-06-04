# AIClient2API System Overview

Reference document for operators and developers onboarding to this system. Explains how all components connect: traffic flow, provider selection, logging/retry/timeout, and security-sensitive areas.

**Start here after reading `docs/GETTING-STARTED.md`.** For operational commands, see `AIClient2API/OPERATION.md`. For architecture decisions, see `docs/ARCHITECTURE.md`.

---

## 1. Traffic Flow

The system is 2-tier: a ZSH env injection layer (Tier 2) and an AIClient2API proxy (Tier 1).

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Code CLI                                            │
│  (sends Anthropic-format requests)                          │
└─────────────────────┬───────────────────────────────────────┘
                      │  ANTHROPIC_BASE_URL=http://127.0.0.1:3000
                      │  (set by claude-proxy / claude-pick / start-proxies)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Tier 2 — ZSH CLI Router  (~/dotfiles/zsh/zshrc)           │
│  - Injects ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY per exec   │
│  - Provides: claude-proxy, claude-native, claude-pick,      │
│    claude-swap, start-proxies commands                      │
└─────────────────────┬───────────────────────────────────────┘
                      │  Routes to Tier 1
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Tier 1 — AIClient2API  (:3000)                             │
│  ├── /v1/messages     → Anthropic-format handler           │
│  ├── /v1/models       → Model catalog endpoint             │
│  └── /provider_health → Health/status endpoint             │
│                                                             │
│  Core logic:                                               │
│  ├── src/handlers/request-handler.js  (protocol translate) │
│  ├── src/providers/provider-pool-manager.js  (selection)   │
│  └── src/providers/  (provider adapters per type)          │
└─────────────────────┬───────────────────────────────────────┘
                      │  selectProviderWithFallback(model)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  External Providers                                         │
│  ├── claude-kiro-oauth    (Claude via Kiro CLI / AWS)      │
│  ├── gemini-antigravity   (Gemini via Antigravity CLI)     │
│  ├── github-models        (OpenAI-compatible via GitHub)   │
│  ├── nvidia-nim           (NVIDIA inference via API key)   │
│  ├── openai-codex-oauth   (Codex via OAuth)               │
│  ├── gemini-cli-oauth     (Gemini via local CLI OAuth)    │
│  └── openai-custom        [DISABLED — credential revoked] │
└─────────────────────────────────────────────────────────────┘
```

**Request lifecycle:**

1. Claude Code sends an Anthropic-format `/v1/messages` request to `http://127.0.0.1:3000`
2. AIClient2API's request-handler.js receives it, determines the target model
3. `selectProviderWithFallback(model)` picks a healthy provider/account (see Section 2)
4. The provider adapter translates the Anthropic payload to the provider's native format
5. Response streams back through AIClient2API to Claude Code (SSE, no re-wrapping)

**Key design constraint:** AIClient2API passes the SSE stream directly — no intermediate re-wrapping. This is why a middle-tier gateway (like LiteLLM, which was removed in v2.0) cannot be re-introduced: re-wrapping corrupts the Anthropic SSE protocol.

---

## 2. Provider Selection Logic

All selection logic lives in `src/providers/provider-pool-manager.js`.

### Step 1: Model → Provider mapping

The requested model ID is looked up in `configs/config.json`:

```
modelFallbackMapping: {
  "claude-sonnet-4-6": { "targetModel": "...", "targetProviderType": "gemini-antigravity" }
}
```

If found: uses the mapped canonical model + provider as the primary target.
If not found: uses the model ID as-is and tries providers in `providerFallbackChain` order.

### Step 2: Account filtering

`selectProvider()` applies three mandatory filters — only accounts passing all three are candidates:

| Filter | Field | Condition |
|--------|-------|-----------|
| Health | `isHealthy` | Must be `true` |
| Admin disable | `isDisabled` | Must be `false` (or absent) |
| OAuth validity | `needsRefresh` | Must be `false` (or absent) |

Accounts failing any filter score `1e18` (effectively infinity) and are never selected.

### Step 3: Score-based selection

Remaining candidates are scored based on recent error rate, active connections, and quota usage. The lowest-score healthy account wins. Accounts in cooldown score `1e18`.

### Step 4: 429 → Cooldown → Cascade

When a provider returns 429 (rate limit):

```
Provider returns 429
  → Account enters cooldown for RATE_LIMIT_COOLDOWN_MS (30s base)
  → Cooldown escalates each 429 up to RATE_LIMIT_COOLDOWN_MAX_MS (5 min max)
  → During cooldown: account scores 1e18 → skipped
  → selectProviderWithFallback() tries next provider in providerFallbackChain
```

**providerFallbackChain** example (in `configs/config.json`):
```json
"github-models": ["gemini-antigravity", "nvidia-nim", "claude-kiro-oauth"]
```

If all accounts for `github-models` are exhausted or in cooldown, the cascade moves to `gemini-antigravity`, then `nvidia-nim`, then `claude-kiro-oauth`.

---

## 3. Logging, Retry, and Timeout

### Log output

| Setting | Value | Location |
|---------|-------|----------|
| Log directory | `logs/` (relative to AIClient2API/) | `configs/config.json → LOG_DIR` |
| Effective path | `~/MASTER-C/AIClient2API/logs/app-YYYY-MM-DD.log` | Date-stamped, rotated daily |
| Log level | `info` | `configs/config.json → LOG_LEVEL` |
| Max file size | 10 MB | `configs/config.json → LOG_MAX_FILE_SIZE` |
| Max files | 10 (10 days rolling) | `configs/config.json → LOG_MAX_FILES` |

**What's logged per request:** provider selected, model ID, response status, latency. **What's never logged:** credential values, OAuth tokens, API keys — these are always redacted.

### Retry behavior

| Setting | Value | Effect |
|---------|-------|--------|
| `REQUEST_MAX_RETRIES` | 5 | Max attempts per provider before cascading |
| `CREDENTIAL_SWITCH_MAX_RETRIES` | 5 | Max credential switches within one provider's pool |

On 429: retry count resets and the provider enters cooldown (see Section 2).

### Timeout

| Setting | Value | Effect |
|---------|-------|--------|
| `STREAM_TIMEOUT_MS` | 120000 (2 min) | SSE stream stall → fail → try next provider |

### Startup behavior

`startupRun: false` in `configs/config.json` — prevents health-check storms on startup. Do not change this. The proxy does NOT pre-warm all providers at boot; health is established lazily on first use.

---

## 4. Security-Sensitive Areas

### Credential locations

| Location | What's stored | Risk | Handling rule |
|----------|---------------|------|---------------|
| `configs/provider_pools.json` | Live OAuth tokens + API keys | **CRITICAL** — never commit | Excluded from commits; written by sync scripts only |
| `MASTER-C/Credentials/` | Canonical credential files | High — filesystem secrets | Read by sync scripts; never hardcode in source |
| `~/.kiro/` | Kiro CLI session state | High — live OAuth session | Never modify; managed by Kiro CLI |
| `~/.antigravity_cockpit/` | Antigravity session credentials | High — live OAuth | Never modify |

**Credential flow (OAuth providers):**

```
Kiro CLI / Antigravity CLI / Codex CLI
  → generates OAuth token
  → sync-kiro-credentials.py / sync-credentials.js
  → writes to MASTER-C/Credentials/ AND configs/provider_pools.json
  → proxy loads provider_pools.json at startup
```

**Credential flow (static API keys):**

```
API key (e.g., GitHub PAT, NVIDIA API key)
  → stored in MASTER-C/Credentials/
  → sync-credentials.js reads → writes to configs/provider_pools.json
  → proxy loads provider_pools.json at startup
```

`configs/provider_pools.json` is the runtime source of truth for all credentials. It is **not version-controlled** (only committed when explicitly instructed — and even then, use targeted `git add`, never `git add -A`).

### Shell exec call sites

| File | exec usage | Input source | Risk |
|------|-----------|--------------|------|
| `src/ui-modules/update-api.js` | `execFile('git', ...)` for version updates | `body.version` validated by `isValidVersionTag` regex + `execFile` array args | Low — no shell injection |
| `src/core/master.js` | `fork(workerScript, args)` for child process | App config file only (not HTTP) | Low — config-driven |
| `src/core/plugin-security.js` | Scans for exec patterns in third-party plugins | N/A — it's a detection guard | Positive security control |

No user-supplied HTTP request data reaches any `exec()` call without validation. (Phase 2 security audit, 2026-06-05.)

### Security audit results (Phase 2, 2026-06-05)

- **SEC-01:** No hardcoded external API keys or OAuth tokens in source files. One low-severity finding: `REQUIRED_API_KEY` in `configs/config.json` — mitigated by runtime override from `AICLIENT_TOKEN` env var.
- **SEC-02:** No command injection paths. All exec calls use system-controlled inputs or validated version strings.
- **SEC-03:** `sync-credentials.js` has path traversal guard. `sync-kiro-credentials.py` corrected stale path (Tier1-AIClient2API → AIClient2API).

Full report: `.planning/phases/02-documentation-security/02-01-SECURITY-FINDINGS.md`
