# Maintenance & Upstream Updates

This proxy is a customized fork of `justlovemaki/AIClient-2-API`. When upstream releases updates, apply them using this procedure to avoid losing customizations.

## Git Remote Topology
- `origin` — your personal fork (`IliaRL/AIClient2API-personal`) — push your work here
- `upstream` — public upstream repo (`justlovemaki/AIClient-2-API`) — pull updates from here
- `mine` — same as `origin` but with PAT embedded for push-protection bypass (e.g., pushing `provider_pools.json` via Contents API)

## Customization Inventory

These customizations **must survive every upstream merge**. Verify each after merging.

| File | Customization | Verification |
|---|---|---|
| `src/providers/provider-pool-manager.js:51-65` | `DEFAULT_HEALTH_CHECK_MODELS`: nvidia=`meta/llama-3.3-70b-instruct`, codex=`gpt-5.4` | `grep -n 'nvidia-nim\|openai-codex' src/providers/provider-pool-manager.js \| head -5` |
| `src/providers/persistence-manager.js:112` | SQLite overlay guard: `typeof config.modelCooldowns !== 'object' \|\| Array.isArray(...)` | `grep -n 'typeof config.modelCooldowns' src/providers/persistence-manager.js` |
| `src/utils/provider-utils.js:55` | antigravity `defaultCheckModel: 'gemini-3-flash'` | `grep -n 'defaultCheckModel' src/utils/provider-utils.js` |
| `src/utils/provider-utils.js:99` | nvidia `defaultCheckModel: 'meta/llama-3.3-70b-instruct'` | (same grep above) |
| `src/providers/provider-models.js` | gemini-cli: 6 models (no gemma), antigravity: 5 models, github: 10 models, nvidia: 10 models | visual diff or `grep -c "'" src/providers/provider-models.js` |
| `configs/config.json` | 28 entries in `modelFallbackMapping` including `claude-haiku-4-5` | `python3 -c "import json; c=json.load(open('configs/config.json')); print(len(c['modelFallbackMapping']), 'entries,', 'haiku ok' if 'claude-haiku-4-5' in c['modelFallbackMapping'] else 'MISSING haiku')"` |

> `configs/config.json`, `configs/provider_pools.json`, and `configs/custom_models.json` are config-only files — upstream never touches them, so they never conflict.

## Merge Procedure (step by step)

```bash
# Step 1: Checkpoint — tag your current working state
git tag "pre-upstream-$(date +%Y%m%d)" HEAD

# Step 2: Fetch upstream (do NOT merge yet)
git fetch upstream

# Step 3: Review what changed in upstream since last merge
git log upstream/main --oneline | head -20
# Focus on changes to: provider-pool-manager.js, provider-models.js,
# provider-utils.js, common.js, service-manager.js

# Step 4: Preview conflicts in customized source files
git diff HEAD upstream/main -- src/

# Step 5: Merge — resolve conflicts keeping your customizations
git merge upstream/main
# If conflicts: resolve each conflict manually. For the files in the
# Customization Inventory above, always preserve YOUR version of those lines.
# git rerere is enabled and will auto-resolve previously-seen conflicts.

# Step 6: Run each verification from the Customization Inventory table above

# Step 7: Restart and run the full test suite
./scripts/safe-restart.sh
node scripts/unified-test-suite.cjs

# Step 8: Verify health (expect 30/32 — 2 gemini-cli may be on 429 cooldown)
curl -s http://127.0.0.1:3000/provider_health | python3 -c "
import sys,json; d=json.load(sys.stdin)
bad=[i for i in d['items'] if not i['isHealthy']]
print(f'{len(d[\"items\"])-len(bad)}/{len(d[\"items\"])} healthy')
[print(f'  UNHEALTHY: {i[\"provider\"]} — {str(i.get(\"lastErrorMessage\",\"\"))[:80]}') for i in bad]"

# Step 9: Tag the merged state
git tag "post-upstream-$(date +%Y%m%d)"
```

## If a Merge Breaks Something

1. Check the Customization Inventory first — most regressions are one of those 6 rows being overwritten
2. Compare against the pre-merge tag: `git diff pre-upstream-YYYYMMDD HEAD -- <file>`
3. If mid-merge and badly conflicted: `git merge --abort` (returns to pre-merge state, no data lost)
   If merge completed but proxy broken: `git reset --hard pre-upstream-YYYYMMDD` (destroys the merge commit)
4. Re-apply fixes from the Customization Inventory manually
