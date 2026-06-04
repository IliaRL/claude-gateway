# AIClient2API Operation Guide

Quick-reference runbook for the AIClient2API proxy. Covers the three operations you'll actually need: adding a provider or model, testing connectivity, and diagnosing failures.

All commands run from `~/MASTER-C/AIClient2API/` unless noted.

---

## 1. Adding a Provider or Model

### Adding an OpenAI-compatible provider (3-file operation)

**Step 1 — Add credentials to `configs/provider_pools.json`**

> ⚠ This file contains live OAuth tokens. Never `git add -A`. Stage this file only explicitly if needed — and in general, do not commit it.

Add a new array under your provider's key name:

```json
"my-provider": [
  {
    "OPENAI_API_KEY": "your-api-key-here",
    "isHealthy": true,
    "isDisabled": false,
    "customName": "My Provider"
  }
]
```

For providers with multiple accounts, add multiple objects to the array. The pool manager load-balances across them.

**Step 2 — Add to routing in `configs/config.json → providerFallbackChain`**

`providerFallbackChain` maps each provider to a list of fallback providers in priority order (first = most preferred):

```json
"providerFallbackChain": {
  "my-provider": ["gemini-antigravity", "nvidia-nim"],
  "github-models": ["my-provider", "gemini-antigravity", "nvidia-nim"]
}
```

Adding `"my-provider"` as a fallback for `"github-models"` means: if github-models fails, try my-provider next.

**Step 3 — Add model IDs to `configs/model-catalog.json`** *(only if adding new models)*

Each entry is an object in the top-level array:

```json
{
  "id": "my-provider-model-id",
  "displayName": "My Model Name",
  "provider": "my-provider",
  "contextWindow": 128000,
  "maxOutput": 16384,
  "fallbackTarget": null,
  "converterStrategy": "openai"
}
```

`converterStrategy`: use `"openai"` for OpenAI-compatible APIs, `"gemini"` for Gemini-native, `"anthropic"` for Anthropic-native.

**Step 4 — Restart the proxy**

```bash
./scripts/safe-restart.sh
```

`safe-restart.sh` kills only the port-3000 listener and enforces a 2 GB free RAM floor before restarting. Never bypass it by running `node src/core/master.js` directly.

Alternative from any shell: `start-proxies`

**Step 5 — Validate**

```bash
pnpm run smoke
```

Expected output: your new provider appears with `✓ PASS`. If it shows `✗ FAIL`, see Section 3 (Troubleshooting).

---

### Adding a model to an existing provider

Only Steps 3 and 4 are needed — no credential or routing changes required.

After adding the model catalog entry and restarting, verify:

```bash
pnpm run check:models | grep "my-provider-model-id"
```

---

### Disabling a provider

In `configs/provider_pools.json`, set `"isDisabled": true` on every account for that provider:

```json
"openai-custom": [
  {
    "OPENAI_API_KEY": "...",
    "isDisabled": true,
    "isHealthy": false
  }
]
```

The pool manager skips any account with `isDisabled: true` at all selection points. No config.json changes needed. Restart to apply.

---

## 2. Testing Connectivity

### Quick smoke test (per-provider pass/fail)

```bash
pnpm run smoke
# or equivalently:
pnpm run verify:quick
```

Runs one chat call per active provider, prints `✓ PASS`, `✗ FAIL`, or `⊘ SKIP` per provider. Completes in ~12 seconds. This is the primary connectivity check.

### Model catalog check

```bash
pnpm run check:models
```

Lists all model IDs the proxy exposes via `/v1/models`. Verifies the catalog endpoint is responding.

### End-to-end message test

```bash
pnpm run check:chat
```

Sends a minimal `/v1/messages` call using the default model. Expected: `"Hi"` or a short response — confirms routing works end-to-end.

### Provider health endpoint

```bash
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/provider_health | python3 -m json.tool
```

Shows per-provider health status: healthy account count, cooldown state, `isDisabled` flag.

### Manual curl one-liners

```bash
# Test /v1/models — confirms proxy is alive and serving the catalog:
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/v1/models | jq '.data[].id' | head -10

# Test /v1/messages — end-to-end round-trip with minimal prompt:
curl -sf http://127.0.0.1:3000/v1/messages \
  -H "Authorization: Bearer $AICLIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"Hi"}]}' \
  | jq '.content[0].text'
```

---

## 3. Troubleshooting

### Symptom: Connection refused / proxy not responding

**Diagnostic:**
```bash
ps aux | grep "master.js" | grep -v grep
```

If no output: proxy is not running.

**Fix:**
```bash
./scripts/safe-restart.sh
```

If `safe-restart.sh` reports "insufficient free RAM": close other applications first. The proxy requires 2 GB reclaimable RAM before it will start (enforced by the memory guard to prevent kernel panics).

---

### Symptom: "no healthy provider" / all providers failing

**Diagnostic:**
```bash
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/provider_health | python3 -m json.tool
```

Look for providers with `healthyCount: 0` or accounts in cooldown.

**Likely causes:**
- **429 quota exhaustion** — Provider returned too many rate-limit errors. Cooldown: 30s base, up to 5 minutes max (`RATE_LIMIT_COOLDOWN_MS` / `RATE_LIMIT_COOLDOWN_MAX_MS` in `configs/config.json`). Wait for cooldown to expire, then retry.
- **Expired credentials** — Provider returning 401. Refresh the API key or OAuth token in `configs/provider_pools.json` using the `aiclient-credentials` skill.
- **All providers disabled** — Check `configs/provider_pools.json` for `"isDisabled": true` on all accounts.

**Quick check for quota reset:**
```bash
# After waiting, re-run smoke test:
pnpm run smoke
```

---

### Symptom: Wrong model / unexpected fallback

**Diagnostic:**
```bash
# Check what model the last request actually used:
cat /tmp/aiclient_last_model 2>/dev/null | python3 -m json.tool
```

This shows: `model`, `provider`, `requestedModel`, `fallbackCount`. If `fallbackCount > 0`, the original model was unavailable and the system fell back.

**Check routing config:**
```bash
python3 -c "
import json
c = json.load(open('configs/config.json'))
model = 'claude-sonnet-4-6'  # replace with your model
mfm = c.get('modelFallbackMapping', {})
pfc = c.get('providerFallbackChain', {})
print('modelFallbackMapping:', mfm.get(model, 'direct'))
print('providerFallbackChain for primary:', pfc.get(list(pfc.keys())[0], [])[:4])
"
```

**Common fix:** Verify the model ID string exactly matches the `id` field in `configs/model-catalog.json`. Model ID mismatches are the #1 cause of silent 404s that trigger unexpected fallbacks.

---

### Log locations

```bash
# Today's gateway log (date-stamped):
tail -50 ~/MASTER-C/AIClient2API/logs/app-$(date +%Y-%m-%d).log

# Verbose test output:
pnpm test --verbose 2>&1 | tail -30
```

Log config: `LOG_DIR`, `LOG_LEVEL`, `LOG_MAX_FILE_SIZE` (10 MB), `LOG_MAX_FILES` (10) in `configs/config.json`.

---

### Complete restart procedure

```bash
# 1. Kill proxy (port 3000 only — safe-restart.sh never kills the Claude Code parent process):
./scripts/safe-restart.sh

# 2. Verify it came back:
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/health | python3 -m json.tool

# 3. Run smoke test:
pnpm run smoke
```
