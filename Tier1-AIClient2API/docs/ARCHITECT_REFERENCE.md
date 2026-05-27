# Architect Reference

Detailed overview of the AIClient2API architecture, key files, and internal systems.

## Architecture & Key Files
| Concept | File | What it does |
|---|---|---|
| Adapter registry | `src/providers/adapter.js` | Registers every provider; must be updated when adding new ones |
| Static model catalog | `src/providers/provider-models.js` | Authoritative list of all models; sync/static only (no await) |
| Fallback chains | `configs/config.json` (`modelFallbackMapping`, `providerFallbackChain`) | Per-model and per-provider cross-provider fallback order |
| Pool manager | `src/providers/provider-pool-manager.js` | Account rotation, 429 cooldowns, per-model cooldowns, scoring, SQLite state |
| SQLite pool state | `src/utils/db.js` | Persistent health/cooldown state across restarts; overlaid onto pool at startup |
| File lock | `src/utils/file-lock.js` | Atomic writes for `provider_pools.json`; prevents concurrent-write corruption |
| Protocol conversion | `src/converters/strategies/` | OpenAI ↔ Anthropic ↔ Gemini translation |
| Converter utils | `src/converters/utils.js` | `flattenToolArguments` (shared by all converters), `cleanJsonSchemaForOpenAI` |
| Converter registration | `src/converters/register-converters.js` | Wires converter strategies into the dispatch table |
| Routing | `src/services/service-manager.js` | Model→provider resolution, AUTO mode, prefix routing, catalog reverse-lookup |
| Request dispatch | `src/handlers/api-handlers.js` | HTTP request entry point; delegates to stream/unary handlers |
| Error handling | `src/utils/common.js` | Stream/unary error → cooldown → retry logic; `_applyBadRequestCooldown` |
| Provider health config | `src/utils/provider-utils.js` | `PROVIDER_MAPPINGS` — health check models and credential path keys per provider |
| Credentials | `configs/provider_pools.json` | Live tokens/OAuth; never commit carelessly |
| OpenRouter models | `configs/custom_models.json` | Only source for `openai-custom` models |
| Antigravity core | `src/providers/gemini/antigravity-core.js` | `geminiToAntigravity()`, `callApi()`, `streamApi()` |
| Kiro core | `src/providers/claude/claude-kiro.js` | `buildCodewhispererRequest()` ~:1047; model name map :205-212 |
| Gemini CLI core | `src/providers/gemini/gemini-core.js` | OAuth refresh, stream parsing, anti-truncation loop |

## Error Propagation System

1.  **Low-Level Rejection**: Provider adapter (e.g., `gemini-core.js`) receives an error from the upstream API.
2.  **Cooldown Trigger**: `common.js` or `provider-pool-manager.js` catches the error.
    *   **429 (Rate Limit)**: Triggers a 5-minute cooldown for the specific account/model pair.
    *   **400 (Bad Request)**: Triggers a 60-second cooldown via `_applyBadRequestCooldown`.
3.  **State Persistence**: Cooldowns and health status are updated in the in-memory pool and persisted to the SQLite database (`src/utils/db.js`).
4.  **Fallback/Rotation**: `service-manager.js` looks for the next healthy account or falls back to a different provider according to `config.json`.
5.  **Identity Tracking**: The final response includes `X-Proxy-Actual-Model` and `X-Proxy-Actual-Provider` headers to indicate which path was eventually taken.
