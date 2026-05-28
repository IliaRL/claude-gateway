# Codebase Structure

**Analysis Date:** 2026-05-28

## Directory Layout

```
/Users/ilialiston/MASTER-C/
├── Credentials/                      # All provider credentials (must use this path)
│   ├── claude-kiro-oauth/            # Kiro credentials
│   ├── gemini-antigravity/           # Antigravity session files
│   ├── gemini-cli-oauth/             # Gemini CLI credentials
│   ├── github-models/                # GitHub Models tokens
│   ├── nvidia-nim/                   # NVIDIA NIM tokens
│   ├── openai-codex-oauth/           # Codex credentials
│   └── openai-custom/                # Custom OpenAI-compatible credentials
├── Tier1-AIClient2API/               # Node.js proxy — connects to providers
│   ├── configs/                      # Configuration files
│   ├── src/                          # Core proxy source code
│   │   ├── auth/                     # OAuth token management and refresh
│   │   ├── convert/                  # (Legacy/utility) conversion logic
│   │   ├── converters/               # Protocol translation (OpenAI/Gemini/Anthropic)
│   │   ├── core/                     # Process startup, config, plugins
│   │   ├── handlers/                 # HTTP request routing
│   │   ├── plugins/                  # Built-in features (auth, potluck, stats)
│   │   ├── providers/                # Provider-specific API adapters
│   │   ├── services/                 # Cross-cutting services (API, UI, health)
│   │   └── utils/                    # Shared helpers (logging, db, constants)
│   ├── logs/                         # Application and prompt logs
│   ├── memory/                       # Local state/cache storage
│   ├── scripts/                      # Restart, test, and utility scripts
│   └── build/                        # Build output / native dependencies
├── Tier2-LiteLLM/                    # Python gateway (port 4000)
│   ├── litellm_config.yaml           # Primary routing configuration (85 model entries)
│   └── .venv/                        # Python virtual environment (managed by uv)
├── docs/                             # Architecture specs and best practices
│   ├── AIClient BP.md                # Tier 1 best practices
│   ├── LiteLLM BP.md                 # Tier 2 best practices
│   ├── Model-Guide.md                # Master reference for model IDs
│   ├── ULTIMATE-GOAL.MD              # Full architecture spec
│   └── ANTHROPIC_GATEWAY_SPEC.md     # Official Claude Code gateway protocol spec
└── .claude/                          # Claude Code project tooling (skills, agents)
    ├── skills/                       # Project-scoped skills
    └── agents/                       # Project-scoped custom agents
```

## Directory Purposes

**Tier1-AIClient2API/src/providers/:**
- Purpose: Provider-specific API adapters and model catalog
- Contains: `adapter.js` (base class), `provider-models.js` (static model catalog), `provider-pool-manager.js` (load balancer)
- Subdirectories per provider: `claude/`, `gemini/`, `openai/`, `grok/`, `forward/`
- Key files: `claude-core.js`, `gemini-core.js`, `openai-core.js`

**Tier1-AIClient2API/src/converters/:**
- Purpose: Bidirectional protocol translation between OpenAI, Anthropic, and Gemini wire formats
- Contains: `ConverterFactory.js`, `BaseConverter.js`, `register-converters.js`
- Strategies directory: Contains implementation for each protocol (`ClaudeConverter.js`, `GeminiConverter.js`, `OpenAIConverter.js`, etc.)

**Tier1-AIClient2API/src/core/:**
- Purpose: Process startup, configuration, and plugin management
- Contains: `master.js`, `config-manager.js`, `plugin-manager.js`, `plugin-security.js`

**Tier1-AIClient2API/src/utils/:**
- Purpose: Shared utilities, constants, and persistence
- Contains: `constants.js`, `model-utils.js`, `cockpit-quota.js`, `trace-buffer.js`, `db.js`, `logger.js`

## Key File Locations

**Entry Points:**
- `Tier1-AIClient2API/src/core/master.js`: Process entrypoint, forks worker, manages port 3100 IPC
- `Tier1-AIClient2API/src/services/api-server.js`: Worker process, starts port 3000 HTTP server
- `Tier2-LiteLLM/litellm_config.yaml`: Configuration that drives the LiteLLM gateway on port 4000

**Configuration:**
- `Tier1-AIClient2API/configs/config.json`: Core Tier 1 proxy config (`providerFallbackChain`, `modelFallbackMapping`, ports, limits)
- `Tier1-AIClient2API/configs/provider_pools.json`: Live OAuth tokens and credentials — NEVER commit
- `Tier1-AIClient2API/configs/custom_models.json`: Configuration for OpenRouter (`openai-custom`) models
- `Tier1-AIClient2API/configs/plugins.json`: Plugin enable/disable state
- `Tier2-LiteLLM/litellm_config.yaml`: 85 model routing entries mapping to Tier 1

**Core Logic:**
- `Tier1-AIClient2API/src/providers/provider-pool-manager.js`: Load balancer, cooldown logic, exhaustive fallback
- `Tier1-AIClient2API/src/handlers/request-handler.js`: Main HTTP router, tracing setup, plugin hook execution
- `Tier1-AIClient2API/src/providers/provider-models.js`: Static model catalog (source of truth for valid model IDs)
- `Tier1-AIClient2API/src/converters/ConverterFactory.js`: Protocol translation registry

**Testing:**
- `Tier1-AIClient2API/scripts/master-smoke-test.cjs`: Quick smoke test (90s) — use first
- `Tier1-AIClient2API/scripts/unified-test-suite.cjs`: Full 39-model suite — use after major changes
- `Tier1-AIClient2API/scripts/validate-skills.sh`: Validates skill reference points are accurate

## Naming Conventions

**Files:**
- Node.js source: `kebab-case.js` (e.g., `request-handler.js`, `config-manager.js`)
- Converter strategies: `PascalCase.js` (e.g., `ClaudeConverter.js`, `GeminiConverter.js`)
- API endpoints/methods: `camelCase` (e.g., `generateContent`, `listModels`)

**Model IDs:**
- Must be fully versioned, e.g., `claude-sonnet-4-5-20250929`, not shorthand like `claude-sonnet-4-6`

**Protocol Prefixes:**
- Use `MODEL_PROTOCOL_PREFIX` constants: `gemini`, `openai`, `claude`, `codex`, `forward`, `grok`

**Provider Identifiers:**
- Use `MODEL_PROVIDER` constants: `gemini-cli-oauth`, `gemini-antigravity`, `openai-custom`, `claude-kiro-oauth`, etc.

## Where to Add New Code

**New Provider Adapter:**
- Implementation: `Tier1-AIClient2API/src/providers/[provider]/[provider]-core.js`
- Registration: Update `adapterRegistry` via `registerAdapter`
- Model catalog: Add models to `Tier1-AIClient2API/src/providers/provider-models.js`
- Auth: If OAuth, add to `Tier1-AIClient2API/src/auth/`
- Constants: Add to `MODEL_PROVIDER` in `Tier1-AIClient2API/src/utils/constants.js`

**New Protocol Converter:**
- Implementation: `Tier1-AIClient2API/src/converters/strategies/[Protocol]Converter.js`
- Registration: `Tier1-AIClient2API/src/converters/register-converters.js`
- Constants: Add to `MODEL_PROTOCOL_PREFIX` in `Tier1-AIClient2API/src/utils/constants.js`

**New Plugin:**
- Implementation: `Tier1-AIClient2API/src/plugins/[plugin-name]/` (for built-in) or `plugins-user/`
- Configuration: Add to `Tier1-AIClient2API/configs/plugins.json`

## Special Directories

**`Tier1-AIClient2API/`:**
- Purpose: The core proxy application
- Important: This is a symlink to `~/AIClient2API/` on the host machine. Never glob/scan inside heavily due to `node_modules`.

**`Tier2-LiteLLM/litellm/` and `.venv/`:**
- Purpose: Upstream LiteLLM source and local Python environment
- Important: NEVER glob, find, or list files inside `litellm/`, `.venv/`, `tests/`, `ui/`, `enterprise/`, `cookbook/`. NEVER run `pip install` or `uv sync`.

**`Credentials/`:**
- Purpose: Local credentials for providers
- Important: All credentials MUST be sourced from here. Never hardcode. Never commit changes to live token files.

---

*Structure analysis: 2026-05-28*
