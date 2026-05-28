<!-- generated-by: gsd-doc-writer -->
# Architecture

This document describes the system architecture of the 3-Tier AI Gateway: a production-grade local proxy stack that routes Claude Code CLI traffic to any external AI provider.

---

## System Overview

The gateway is a three-tier local proxy stack. Claude Code CLI sends Anthropic-format API requests that travel through three layers before reaching an external provider: a ZSH environment injection layer (Tier 3), a Python payload normalization and fallback router (Tier 2, LiteLLM on port 4000), and a Node.js provider proxy that performs authentication and protocol translation (Tier 1, AIClient2API on port 3000). Each tier has a distinct responsibility, and fallback routing responsibility is split explicitly between tiers for maximum efficiency.

---

## Request Flow

```
Claude Code CLI
    │
    ▼
[Tier 3] ZSH dotfiles (~/dotfiles/zsh/zshrc)
    Injects: ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, CLAUDE_MODEL
    Commands: claude-pick, claude-swap
    │
    ▼
[Tier 2] LiteLLM — port 4000
    Tier2-LiteLLM/litellm_config.yaml
    Receives: Anthropic /v1/messages format
    Performs: Anthropic → OpenAI payload translation
    Owns: Level 3 fallback (tiered model downgrade)
    Forwards: OpenAI-format requests to Tier 1
    │
    ▼
[Tier 1] AIClient2API — port 3000
    Tier1-AIClient2API/src/
    Receives: OpenAI /v1/chat/completions format
    Performs: provider auth, OAuth lifecycle, protocol translation
    Owns: Level 1 fallback (vertical account rotation)
             Level 2 fallback (horizontal provider rotation)
    │
    ▼
External Provider
    (Kiro, Antigravity, Gemini CLI, OpenAI Codex, Grok, GitHub Models,
     NVIDIA NIM, OpenRouter, iFlow, Qwen)
```

---

## Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│  TIER 3 — ZSH CLI Router                                    │
│  ~/dotfiles/zsh/zshrc                                       │
│  claude-pick  │  claude-swap  │  start-proxies              │
└──────────────────────┬──────────────────────────────────────┘
                       │ env injection (per-execution scope)
┌──────────────────────▼──────────────────────────────────────┐
│  TIER 2 — LiteLLM Gateway  :4000                            │
│  Tier2-LiteLLM/                                             │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  litellm_config.yaml  (85 model entries, 7 providers)  │ │
│  │  FastAPI / litellm/proxy/proxy_server.py               │ │
│  │  Router / litellm/router.py  (Level 3 fallback chain)  │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────┬──────────────────────────────────────┘
                       │ OpenAI /v1/chat/completions
┌──────────────────────▼──────────────────────────────────────┐
│  TIER 1 — AIClient2API Provider Proxy  :3000                │
│  Tier1-AIClient2API/src/                                    │
│  ┌─────────────────┐  ┌──────────────────────────────────┐ │
│  │  core/          │  │  providers/                      │ │
│  │  master.js      │  │  provider-models.js (model map)  │ │
│  │  config-mgr     │  │  claude/ gemini/ openai/ grok/   │ │
│  │  plugin-mgr     │  │  forward/ (pass-through)         │ │
│  └─────────────────┘  └──────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  providers/provider-pool-manager.js                  │   │
│  │  Level 1: vertical account rotation                  │   │
│  │  Level 2: horizontal provider rotation               │   │
│  │  Cockpit quota tracking + penalty scoring            │   │
│  │  getCachedAvailableModels() — 30s TTL model list     │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  converters/ & convert/   (format translation)       │   │
│  │  auth/                    (key injection/validation) │   │
│  │  handlers/request-handler.js                         │   │
│  │  utils/request-handlers.js (Gemini format detection) │   │
│  │  services/response-cache.js (provider-prefixed keys) │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────────────┘
                       │ Native provider API calls
┌──────────────────────▼──────────────────────────────────────┐
│  External Providers                                         │
│  Kiro  │  Antigravity  │  Gemini CLI  │  OpenAI Codex       │
│  Grok  │  GitHub Models  │  NVIDIA NIM  │  OpenRouter       │
└─────────────────────────────────────────────────────────────┘
```

---

## Tier Responsibilities

### Tier 3 — ZSH CLI Router

**Location:** `~/dotfiles/zsh/zshrc` (not in this repo)

Tier 3 is the user-facing entry point. It intercepts Claude CLI launches and injects scoped environment variables without polluting the global shell environment.

Key responsibilities:
- Present an interactive model selection menu (`claude-pick`, `claude-swap`)
- Verify Tier 1 and Tier 2 health, spinning them up if not running
- Inject `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, and `CLAUDE_MODEL` per-execution
- Launch Claude Code with `claude --resume` for history continuity (`claude-swap`)

Required env vars injected into every Claude Code session:

| Variable | Value | Purpose |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:4000` | Routes CLI to Tier 2 (LiteLLM) |
| `ENABLE_TOOL_SEARCH` | `true` | Restores Tool Search disabled by non-Anthropic base URLs |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` | Allows `/v1/models` discovery from LiteLLM |

---

### Tier 2 — LiteLLM Gateway (port 4000)

**Location:** `Tier2-LiteLLM/`
**Active config:** `Tier2-LiteLLM/litellm_config.yaml`
**Runtime:** Python 3.12.11, litellm 1.87.0, `.venv/` managed by `uv sync`

Tier 2 is the shock-absorber between Claude Code CLI and Tier 1. It normalizes the Anthropic-format requests from the CLI into OpenAI-format requests for Tier 1.

Key responsibilities:
- Serve `/v1/messages` in Anthropic format to Claude Code
- Translate Anthropic → OpenAI payloads (via `openai/` model prefix in `litellm_params`)
- Silent retry on 429s, 500s, and 502s (`num_retries: 3`) before triggering fallback
- Own Level 3 fallback (tiered model downgrade — always descend, never upgrade)
- Forward normalized traffic to `http://127.0.0.1:3000/v1`

**Model config pattern:**
```yaml
model_list:
  - model_name: "claude-sonnet-4-6"
    litellm_params:
      model: "openai/claude-sonnet-4-6"
      api_base: "http://127.0.0.1:3000/v1"
      api_key: "os.environ/AICLIENT_TOKEN"
```

The `openai/` prefix is mandatory — it instructs LiteLLM to perform Anthropic → OpenAI translation and avoid double-translation by Tier 1.

**Level 3 fallback downgrade chains:**
```
claude-opus-4-7    →  claude-opus-4-6  →  claude-sonnet-4-6  →  claude-haiku-4-5
gemini-3.1-pro-high  →  gemini-3.1-pro-low  →  gemini-3-flash
gpt-5.5            →  gpt-5.4          →  gpt-5.4-mini
grok-4.20-heavy    →  grok-4.20        →  grok-4.1-mini
```

**Critical constraint:** Never set `drop_params: true` globally. Claude Code injects nested tool-use schemas that LiteLLM misidentifies as unsupported parameters, silently stripping tool definitions and breaking agentic functionality.

---

### Tier 1 — AIClient2API Provider Proxy (port 3000)

**Location:** `Tier1-AIClient2API/` (symlink to `~/AIClient2API/`)
**Entrypoint:** `src/core/master.js`
**Config:** `configs/config.json`, `configs/provider_pools.json`

Tier 1 is the heavy-lifting backend. It receives OpenAI-format requests from LiteLLM and translates them into authenticated native API calls for each provider.

Key responsibilities:
- Provider authentication and OAuth token lifecycle management
- Protocol translation (OpenAI spec → native provider API format)
- Multi-account pool load-balancing with persistent cooldown state
- Level 1 fallback: vertical account rotation (exhaust all accounts for the selected model)
- Level 2 fallback: horizontal provider rotation (exhaust all providers for the same model)
- Cockpit Quota Tracking: polls `http://127.0.0.1:18081/report` to maintain account quota state and pre-filter exhausted accounts before attempting them

---

## Directory Structure

### Tier 1 — `Tier1-AIClient2API/src/`

| Path | Role |
|---|---|
| `core/master.js` | Process entrypoint — starts all services |
| `core/config-manager.js` | Loads and validates config at startup |
| `core/plugin-manager.js` | Provider plugin orchestration |
| `providers/provider-models.js` | Canonical model ID map — the source of truth for valid model strings |
| `providers/provider-pool-manager.js` | Account pool load-balancing, cooldown state, and 30s TTL model list cache |
| `providers/claude/` | Kiro/Claude provider adapter |
| `providers/gemini/` | Gemini CLI and Antigravity adapters |
| `providers/openai/` | OpenAI Codex adapter |
| `providers/grok/` | Grok adapter |
| `providers/forward/` | Generic pass-through for GitHub Models, NVIDIA NIM, OpenRouter |
| `handlers/request-handler.js` | OpenAI-compatible endpoint handlers (what LiteLLM hits) |
| `converters/` and `convert/` | Format translation between OpenAI spec and native provider APIs |
| `auth/` | API key injection and validation |
| `services/api-server.js` | Standalone API server entrypoint |
| `services/response-cache.js` | Response cache with provider-protocol-prefixed keys |
| `utils/request-handlers.js` | Gemini-protocol format detection and OpenAI → Gemini response conversion |
| `utils/` | Error formatters and logging |

### Tier 1 — `Tier1-AIClient2API/configs/`

| File | Purpose |
|---|---|
| `config.json` | Main runtime config: `REQUIRED_API_KEY`, `CRON_REFRESH_TOKEN`, rate-limit cooldown settings |
| `provider_pools.json` | Multi-account credential pools per provider |
| `custom_models.json` | Dynamically-added model definitions |
| `input_system_prompt.txt` | Identity override prompt injected into provider requests |

### Tier 2 — `Tier2-LiteLLM/` (safe files)

| File | Purpose |
|---|---|
| `litellm_config.yaml` | Active master config — 85 model entries across 7 providers |
| `pyrightconfig.json` | Type-checking config for IDE support |

---

## Fallback Routing Strategy

Fallback ownership is split between tiers to maximize efficiency:

```
Request arrives at Tier 2 (LiteLLM)
    │
    ▼
Tier 1 — Level 1: Vertical Rotation
    Exhaust all account credentials for the selected model
    on the current primary provider.
    Cockpit penalty scorer pre-filters quota-exhausted accounts.
    │
    ▼ (if Level 1 exhausted)
Tier 1 — Level 2: Horizontal Rotation
    Exhaust all accounts for that identical model
    across all other available providers.
    │
    ▼ (if Level 2 exhausted — Tier 1 returns total failure signal)
Tier 2 — Level 3: Tiered Downgrade
    LiteLLM falls back to the next lower-tier model.
    Always descend (Opus → Sonnet → Haiku). Never upgrade.
    │
    ▼ (if no fallback models remain)
429 Too Many Requests returned to Claude Code CLI
```

---

## Key Abstractions

| Abstraction | Location | Description |
|---|---|---|
| Model ID map | `src/providers/provider-models.js` | Canonical source of truth for all valid model strings per provider. LiteLLM model strings must exactly match entries here. |
| Provider pool manager | `src/providers/provider-pool-manager.js` | Manages multi-account credential pools, cooldown state, penalty scoring, and a 30s TTL cache for available model lists (`getCachedAvailableModels()`). Cache is invalidated on provider health changes. |
| Request handler | `src/handlers/request-handler.js` | Exposes the OpenAI-compatible `/v1/chat/completions` endpoint that LiteLLM targets. |
| Format converters | `src/converters/` and `src/convert/` | Translate between OpenAI spec and native provider wire formats. Most format errors originate here. |
| Response cache | `src/services/response-cache.js` | Caches responses with cache keys prefixed by provider protocol (e.g., `gemini:sha256hash`). Prefix isolation prevents OpenAI-format cached responses from being served to Gemini-protocol callers for the same model and content. |
| Gemini format detection | `src/utils/request-handlers.js` | Detects when a Gemini-protocol caller would receive an OpenAI-format response due to protocol prefix collision (`gemini` and `gemini-cli-oauth` both resolve to `gemini`). Explicitly converts via `OpenAIConverter.toGeminiResponse()` before responding. |
| LiteLLM router | `litellm/router.py` (Tier 2 source) | Multi-model routing, load balancing, and Level 3 downgrade fallback logic. |
| LiteLLM config | `Tier2-LiteLLM/litellm_config.yaml` | Declares all 85 model entries, their `openai/` prefixed routing strings, and the fallback chain. |
| Credentials | `Credentials/` (repo root) | One subfolder per provider. Never hardcode credentials elsewhere. |

---

## SSE Streaming Rules

Claude Code streams tool-use execution via Server-Sent Events (SSE). Buffering by any middleware layer concatenates `data:` frames and corrupts the JSON parser.

**Rule:** Every proxy layer must inject `X-Accel-Buffering: no` on all streaming responses.

Additional tolerance setting: `CLAUDE_CODE_STREAM_DELAY=50` can be exported to absorb minor chunking jitter.

---

## Supported Providers

| Provider | AIClient2API Type | Credential Folder |
|---|---|---|
| Kiro (Claude models) | `claude-kiro-oauth` | `Credentials/claude-kiro-oauth/` |
| Antigravity (Gemini) | `gemini-antigravity` | `Credentials/gemini-antigravity/` |
| Gemini CLI OAuth | `gemini-cli-oauth` | `Credentials/gemini-cli-oauth/` |
| OpenAI Codex | `openai-codex-oauth` | `Credentials/openai-codex-oauth/` |
| GitHub Models | `forward-custom` | `Credentials/github-models/` |
| NVIDIA NIM | `forward-custom` | `Credentials/nvidia-nim/` |
| OpenRouter | `forward-custom` | — |
| Custom OpenAI-compatible | `openai-custom` | `Credentials/openai-custom/` |

---

## Test Suite

Tier 1 ships 73 tests across 8 suites, covering unit and integration scenarios for provider adapters, format converters, pool management, and request handling.

```bash
pnpm test             # all 73 tests
pnpm run test:unit
pnpm run test:integration
pnpm run test:coverage
pnpm run test:verbose
```

---

## Startup Order

Tier 1 must be healthy before Tier 2 starts. Starting them in parallel causes LiteLLM to fire up to 80 concurrent health-check requests at port 3000 before it is ready, spiking CPU.

```bash
# Step 1 — Start Tier 1
cd ~/AIClient2API && npm start

# Step 2 — Start Tier 2 (only after Tier 1 is healthy)
/Users/ilialiston/MASTER-C/Tier2-LiteLLM/.venv/bin/litellm \
  --config /Users/ilialiston/MASTER-C/Tier2-LiteLLM/litellm_config.yaml \
  --port 4000

# Or use the shell alias (enforces correct startup order)
start-proxies
```

---

## Reference Documents

| Document | Purpose |
|---|---|
| `docs/ULTIMATE-GOAL.md` | Full requirements spec and success criteria |
| `docs/Model-Guide.md` | Canonical model IDs, provider strings, context windows, fallback chains |
| `docs/AIClient-BP.md` | AIClient2API configuration best practices and error diagnostics |
| `docs/LiteLLM-BP.md` | LiteLLM configuration best practices and macOS CPU stability notes |
| `docs/Architecture-and-Proxy-Integration.md` | SSE buffering rules, env var requirements, Anthropic gateway spec compliance |
| `docs/Troubleshooting-and-Fixes.md` | Known issues registry with root causes and fix status |
| `docs/ANTHROPIC_GATEWAY_SPEC.md` | Saved official Claude Code LLM gateway wire protocol spec |
