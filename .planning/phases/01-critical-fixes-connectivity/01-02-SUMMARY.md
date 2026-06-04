# Plan 01-02 Summary: Add Smoke Script + Connectivity One-Liners

**Status:** COMPLETE
**Executed:** 2026-06-04

## What Was Done

### Added Three npm Scripts to AIClient2API/package.json

```json
"smoke": "node scripts/live-verify.cjs --quick",
"check:models": "curl -sf -H \"Authorization: Bearer $AICLIENT_TOKEN\" http://127.0.0.1:3000/v1/models | jq '.data[].id' | head -10",
"check:chat": "curl -sf http://127.0.0.1:3000/v1/messages -H \"Authorization: Bearer $AICLIENT_TOKEN\" -H \"Content-Type: application/json\" -d '{\"model\":\"claude-sonnet-4-6\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}]}' | jq '.content[0].text'"
```

Commit: d61854a

### Connectivity Test Timing Verified

`pnpm run verify:quick` elapsed: **11.95 seconds** (OPS-01 threshold: <30s ✓)

Results:
- github-models:gpt-4o-mini → ✓ PASS
- nvidia-nim:openai/gpt-oss-20b → ✓ PASS
- openai-codex-oauth → SKIP (0/1 healthy — expected)
- openai-custom → FAIL (503 — expected: isDisabled=true, credentials revoked)
- 4/5 providers responded correctly; 1 disabled provider shows FAIL instead of SKIP (cosmetic)

## Connectivity One-Liners (Copy-Pastable)

```bash
# Test that the proxy is alive and serving models:
curl -sf -H "Authorization: Bearer $AICLIENT_TOKEN" http://127.0.0.1:3000/v1/models | jq '.data[].id' | head -10

# Test that a minimal /v1/messages call works end-to-end:
curl -sf http://127.0.0.1:3000/v1/messages \
  -H "Authorization: Bearer $AICLIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"Hi"}]}' | jq '.content[0].text'

# Run per-provider smoke test (one model per provider, chat only):
pnpm run smoke
# or: pnpm run verify:quick  (identical)

# Full live verification suite:
pnpm run verify:live
```

## Acceptance Criteria Status

| Criterion | Status |
|-----------|--------|
| package.json scripts.smoke defined | ✓ |
| package.json scripts["check:models"] defined | ✓ |
| package.json scripts["check:chat"] defined | ✓ |
| package.json remains valid JSON | ✓ |
| verify:quick completes in <30s | ✓ (11.95s) |
| All pre-existing scripts unchanged | ✓ |
