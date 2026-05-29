# Debugging Guide

Use these steps to diagnose and fix issues with the AIClient2API proxy.

## Step 1 — Always run the 3-signal triage first:
```bash
# Signal 1: proxy alive?
lsof -nP -i :3000 -t && curl -s http://127.0.0.1:3000/api/help -o /dev/null -w "%{http_code}\n"

# Signal 2: pool health
curl -s http://127.0.0.1:3000/provider_health | python3 -c "
import sys,json; d=json.load(sys.stdin)
bad=[i for i in d['items'] if not i['isHealthy']]
print(f'{len(d[\"items\"])-len(bad)}/{len(d[\"items\"])} healthy')
[print(f'  UNHEALTHY: {i[\"provider\"]} — {str(i.get(\"lastErrorMessage\",\"\"))[:80]}') for i in bad]"

# Signal 3: model count (expect 45)
curl -s http://127.0.0.1:3000/v1/models \
  -H "Authorization: Bearer sk-a60f3efdf9b97e63c84ab4a3583f9d1c" \
  | python3 -c "import sys,json; print('models:', len(json.load(sys.stdin)['data']))"
```

## Error → Cause → Fix quick-reference

| Error | Cause | Fix |
|---|---|---|
| `ECONNREFUSED :3000` | Proxy not running | `npm start` or `./scripts/safe-restart.sh` |
| `Invalid JSON in request body` | zsh curl quoting | Use `--data-raw` not `-d` |
| `401` on `/v1/*` | Wrong Bearer token | Use `sk-a60f3efdf9b97e63c84ab4a3583f9d1c` |
| `no healthy provider supporting model X` | Model not in catalog OR all accounts unhealthy | Check `/provider_health`; grep model in `provider-models.js` |
| `429` quota exhausted | Rate limit | Normal — proxy rotates automatically |
| `400` on Antigravity | Per-account rejection | 60s model cooldown → other accounts rotate; auto-recovers |
| All models unhealthy after restart | `startupRun:true` caused 429 storm | Set `startupRun:false` in `config.json`, reset pool state |
| gemini-cli unary "empty content" | Thinking model returned no text in unary mode | Use streaming instead; this is upstream model behavior |
| Tool use returns text, no `tool_use` block | Converter or adapter issue | Enable `PROMPT_LOG_MODE: "file"` in `config.json`, inspect `logs/prompt_log_*.log` |

## Enable prompt logging for deep debugging
```bash
# In configs/config.json set: "PROMPT_LOG_MODE": "file"
# Restart, reproduce the issue, then:
ls -lt logs/prompt_log_*.log | head -5
cat logs/prompt_log_<timestamp>.log
```
