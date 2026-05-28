# Architecture

**Analysis Date:** 2026-05-28

## Pattern Overview

**Overall:** 3-tier gateway — ZSH CLI router → LiteLLM payload normalizer → Node.js provider proxy

**Key Characteristics:**
- Each tier is independently deployable and communicates over HTTP
- Tier 1 (AIClient2API) is the stateful component; it owns all credentials, pool state, and OAuth sessions
- Protocol translation happens in Tier 1 converters; Tier 2 uses `openai/*` prefix for all models to avoid path conflicts
- Active routing mode bypasses Tier 2: Claude Code CLI points directly at Tier 1 (`ANTHROPIC_BASE_URL=http://127.0.0.1:3000`) to eliminate SSE stream corruption from LiteLLM re-wrapping

## Tiers

**Tier 3 — ZSH CLI Router:**
- Purpose: Environment injection and model selection UI for Claude Code CLI
- Location: `~/dotfiles/zsh/zshrc` (outside this repo)
- Contains: `claude-pick`, `claude-swap`, `claude-proxy`, `claude-native`, `start-proxies` shell functions
- Depends on: Tier 1 and Tier 2 being live before forwarding traffic
- Used by: Developer launching Claude Code sessions

**Tier 2 — LiteLLM Gateway:**
- Purpose: OpenAI-compatible payload normalization, retry, and fallback before reaching Tier 1
- Location: `Tier2-LiteLLM/` (upstream LiteLLM source + local config only)
- Active config: `Tier2-LiteLLM/litellm_config.yaml` — 85 named model entries across 7 providers, 8 section groups
- Port: 4000
- Depends on: Tier 1 at `http://127.0.0.1:3000/v1`
- Critical rule: All model entries use `openai/*` litellm prefix (not `anthropic/`) so LiteLLM does not append `/v1/messages` — a path AIClient2API does not expose
- Used by: Claude Code CLI when LiteLLM is in the active path

**Tier 1 — AIClient2API (Node.js):**
- Purpose: Account-rotation load balancer and protocol translator for 30+ external AI provider accounts
- Location: `Tier1-AIClient2API/src/` (symlink to `~/AIClient2API/`)
- Port: 3000
- Process model: Master process forks a worker (`src/core/master.js` → `src/services/api-server.js`). Worker handles all HTTP; master provides IPC restart management on port 3100.
- Depends on: External providers (Kiro, Antigravity, Gemini CLI, OpenRouter, Codex, NVIDIA NIM, GitHub Models, Grok)
- Used by: LiteLLM (Tier 2) or Claude Code CLI directly

## Tier 1 Layers

**Core / Startup:**
- Purpose: Process bootstrap, config loading, plugin discovery
- Location: `Tier1-AIClient2API/src/core/`
- Key files:
  - `master.js` — process entrypoint; forks `api-server.js` worker; manages restarts via IPC
  - `config-manager.js` — loads and validates `configs/config.json` at startup; exports `CONFIG` singleton
  - `plugin-manager.js` — discovers, validates, and lifecycle-manages plugins from `src/plugins/` and `src/plugins-user/`
  - `plugin-security.js` — sandbox validation for plugin exports
  - `security-hardening.js` — imported first by both master and worker

**Request Handler:**
- Purpose: Entry point for all inbound HTTP — authenticates, routes, and delegates
- Location: `Tier1-AIClient2API/src/handlers/request-handler.js`
- Responsibilities: per-request trace setup, plugin middleware chain, UI/API routing, endpoint dispatch (health, `/provider_health`, `/api/quota`, `/v1/...`, `/v1beta/...`)
- Depends on: plugin-manager, service-manager, ui-manager, api-manager

**Services:**
- Purpose: Server startup wiring and cross-cutting service initialization
- Location: `Tier1-AIClient2API/src/services/`
- Key files:
  - `api-server.js` — worker process; initializes config, pool manager, request handler, Cockpit quota, preflight health; starts HTTP server
  - `service-manager.js` — vends `getApiService()`, `getProviderPoolManager()`, `getProviderStatus()`
  - `preflight-health.js` — background health monitor that warms OAuth adapters via `setImmediate` at startup
  - `ui-manager.js` — serves the built-in web UI static files
  - `api-manager.js` — handles `/api/*` management endpoints

**Provider Pool Manager:**
- Purpose: Account-rotation load balancer — selects healthy accounts, applies cooldowns, implements exhaustive fallback
- Location: `Tier1-AIClient2API/src/providers/provider-pool-manager.js`
- Key behaviors:
  - Vertical rotation: exhaust all accounts for the requested model on the primary provider
  - Horizontal rotation: exhaust all accounts across `providerFallbackChain` providers
  - Tiered downgrade: after full exhaustion, fall to next model in `modelFallbackMapping`
  - Cockpit quota integration: penalty scoring via `src/utils/cockpit-quota.js`; polls `http://127.0.0.1:18081/report?token=C-Code-CLI-Model-API` sub-10-minute; falls back to `~/.antigravity_cockpit/accounts.json`
  - SQLite state persistence: `src/utils/db.js` overlaid on in-memory pool at startup

**Provider Adapters:**
- Purpose: Per-provider API clients implementing `ApiServiceAdapter` interface
- Location: `Tier1-AIClient2API/src/providers/`
- Interface: `adapter.js` defines `ApiServiceAdapter` base class with `generateContent()`, `generateContentStream()`, `listModels()`, `refreshToken()`
- Registry: `adapterRegistry` Map in `adapter.js`; adapters registered by provider string from `MODEL_PROVIDER` constant
- Provider implementations:
  - `claude/claude-core.js` — Anthropic Claude API
  - `claude/claude-kiro.js` — Kiro (Amazon Q backend with Claude models)
  - `gemini/gemini-core.js` — Gemini CLI OAuth
  - `gemini/antigravity-core.js` — Antigravity (Google internal Gemini)
  - `openai/openai-core.js` — OpenRouter / OpenAI-compatible
  - `openai/openai-responses-core.js` — OpenAI Responses API variant
  - `openai/codex-core.js` — OpenAI Codex OAuth
  - `openai/qwen-core.js` — Qwen OAuth
  - `openai/iflow-core.js` — iFlow OpenAI-compatible
  - `grok/grok-core.js` — Grok web
  - `forward/forward-core.js` — Generic forward adapter

**Converters:**
- Purpose: Bidirectional protocol translation between OpenAI/Anthropic/Gemini wire formats
- Location: `Tier1-AIClient2API/src/converters/`
- Pattern: Factory + Strategy. `ConverterFactory` (singleton) maps protocol prefix string → converter class instance (cached). Registered via `register-converters.js`.
- Strategies:
  - `ClaudeConverter.js` — Anthropic Messages API ↔ internal format
  - `GeminiConverter.js` — Gemini generateContent API ↔ internal format
  - `OpenAIConverter.js` — OpenAI Chat Completions ↔ internal format
  - `OpenAIResponsesConverter.js` — OpenAI Responses API ↔ internal format
  - `CodexConverter.js` — Codex-specific transformations
  - `GrokConverter.js` — Grok-specific transformations
- Protocol prefix (from `MODEL_PROTOCOL_PREFIX` constants): `gemini`, `openai`, `openaiResponses`, `claude`, `codex`, `forward`, `grok`

**Auth:**
- Purpose: OAuth token management and refresh per provider
- Location: `Tier1-AIClient2API/src/auth/`
- Files: `kiro-oauth.js`, `gemini-oauth.js`, `codex-oauth.js`, `grok-auth.js`, `iflow-oauth.js`, `qwen-oauth.js`, `oauth-handlers.js`, `index.js`

**Plugins:**
- Purpose: Optional feature modules loaded at startup
- Location: `Tier1-AIClient2API/src/plugins/` (built-in), `src/plugins-user/` (user-installed)
- Config: `configs/plugins.json`
- Default disabled: `api-potluck`, `ai-monitor`, `model-usage-stats`, `ip-node-proxy`
- Plugin types: `auth` (participates in auth chain) or `middleware` (request interceptor)
- Built-in plugins: `default-auth/`, `api-potluck/`, `ai-monitor/`, `model-usage-stats/`

**Utils:**
- Purpose: Shared utilities — logging, caching, DB, token counting, network, tracing
- Location: `Tier1-AIClient2API/src/utils/`
- Key files:
  - `constants.js` — `MODEL_PROVIDER`, `MODEL_PROTOCOL_PREFIX`, `ENDPOINT_TYPE`, `NETWORK` enums
  - `model-utils.js` — `ENDPOINT_TYPE` definitions, `getProtocolPrefix()`, model routing resolution
  - `response-cache.js` — in-process 30s LRU cache (200 entries) for non-streaming `temperature=0` requests
  - `cockpit-quota.js` — Antigravity Cockpit quota polling and penalty scoring
  - `trace-buffer.js` — per-request diagnostic trace; exposed via `X-Proxy-Trace` header when `x-debug-trace: 1`
  - `logger.js` — request-context-aware logger
  - `db.js` — SQLite state persistence for pool/cooldown state

## Data Flow

**Standard Request (direct Tier 1 mode):**

1. Claude Code CLI sends Anthropic Messages API request to `http://127.0.0.1:3000/v1/messages` with `Authorization: Bearer $AICLIENT_TOKEN`
2. `request-handler.js` receives request, generates trace, runs plugin middleware chain
3. Auth plugin validates `AICLIENT_TOKEN`
4. Request dispatched to `provider-pool-manager.js` which selects healthy account
5. `ConverterFactory.getConverter(protocolPrefix)` translates Anthropic format → provider-native format
6. Adapter calls external provider API (streaming or unary)
7. Provider response translated back → Anthropic SSE stream or JSON
8. Response returned; trace written to `/tmp/aiclient_last_model` JSON for IDE status line

**Via Tier 2 (LiteLLM mode):**

1. Claude Code CLI sends to `http://127.0.0.1:4000/v1/messages`
2. LiteLLM matches `model_name` in `litellm_config.yaml`, translates to `openai/<provider>:<model>` with `api_base: http://127.0.0.1:3000/v1`
3. LiteLLM forwards as OpenAI Chat request to Tier 1
4. Tier 1 routes via `openai/*` converter chain; returns OpenAI-compatible response
5. LiteLLM re-wraps response into Anthropic format for Claude Code CLI

**Fallback Chain:**

1. Vertical rotation: try all accounts in pool for requested provider+model
2. Horizontal rotation: consult `providerFallbackChain` in `configs/config.json`; try each fallback provider's accounts
3. Tiered downgrade: consult `modelFallbackMapping` in `configs/config.json`; select next lower-tier model (never upgrade)

## Key Abstractions

**MODEL_PROVIDER constants:**
- Purpose: Canonical string IDs for each provider — used as keys throughout pool manager, adapter registry, health checks
- Location: `Tier1-AIClient2API/src/utils/constants.js`
- Values: `gemini-cli-oauth`, `gemini-antigravity`, `openai-custom`, `openaiResponses-custom`, `claude-custom`, `claude-kiro-oauth`, `openai-qwen-oauth`, `openai-iflow`, `openai-codex-oauth`, `forward-api`, `grok-web`, `nvidia-nim`, `github-models`

**Model ID format in LiteLLM config:**
- `model_name`: what Claude Code sends (e.g. `claude-kiro-oauth:claude-sonnet-4-6`)
- `litellm_params.model`: what LiteLLM sends to Tier 1 (e.g. `openai/claude-kiro-oauth:claude-sonnet-4-6`)
- These must match exactly; mismatches cause silent 404s

**provider-models.js:**
- Purpose: Static, synchronous model catalog — the source of truth for valid model strings
- Location: `Tier1-AIClient2API/src/providers/provider-models.js`
- Rule: Must NOT use `await` or live API calls; `listModels()` is synchronous

## Entry Points

**Tier 1 Production Start:**
- Location: `Tier1-AIClient2API/src/core/master.js`
- Triggers: `pnpm start` (or `npm start` from `~/AIClient2API`)
- Responsibilities: Forks `src/services/api-server.js` as worker, manages restarts, exposes IPC on port 3100

**Tier 1 Worker:**
- Location: `Tier1-AIClient2API/src/services/api-server.js`
- Responsibilities: Config init, pool manager init, plugin discovery, Cockpit quota warmup, HTTP server on port 3000

**Tier 2 Start:**
- Command: `/Users/ilialiston/MASTER-C/Tier2-LiteLLM/.venv/bin/litellm --config /Users/ilialiston/MASTER-C/Tier2-LiteLLM/litellm_config.yaml --port 4000`
- Must start after Tier 1 is healthy to avoid 80 concurrent health-check requests at an unready port

## Error Handling

**Strategy:** Retry with exponential backoff + jitter at pool manager level; per-provider cooldowns on 429/500

**Patterns:**
- 429 responses trigger `RATE_LIMIT_COOLDOWN_MS` + jitter; account enters cooldown; next account selected
- Pool exhaustion triggers horizontal provider rotation via `providerFallbackChain`
- Full model exhaustion triggers tiered downgrade via `modelFallbackMapping`
- Cooldown state persisted in SQLite (`db.js`); survives restarts but can be corrupted — compare in-memory state vs SQLite on corruption
- Response cache (`response-cache.js`): non-streaming `temperature=0` requests cached 30s; returns `X-Cache: HIT`

## Cross-Cutting Concerns

**Logging:** `src/utils/logger.js` — request-context-aware via `requestContext.run()`; configurable to file or console via `LOG_OUTPUT_MODE` in `configs/config.json`; prompt logging via `PROMPT_LOG_MODE: "file"` writes to `logs/prompt_log_*.log`

**Validation:** Config validated at startup by `config-manager.js`; model IDs validated against `provider-models.js`; plugins validated by `plugin-security.js`

**Authentication:** `REQUIRED_API_KEY` in `configs/config.json` checked against `Authorization: Bearer` header or `x-goog-api-key` or `?key=` query param; OAuth tokens per-provider managed by `src/auth/` modules with automatic refresh

**Tracing:** `src/utils/trace-buffer.js` — per-request diagnostic trace captured in `createTrace(requestId)`; serialized into `X-Proxy-Trace` response header when client sends `x-debug-trace: 1`; Claude Code session attribution captured from `x-claude-code-session-id`, `x-claude-code-agent-id`, `x-claude-code-parent-agent-id` headers

---

*Architecture analysis: 2026-05-28*
