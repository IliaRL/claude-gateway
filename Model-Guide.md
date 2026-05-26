# Model-Guide.md
# 3-Tier AI Gateway — System Reference & Architecture Guide

> **Purpose:** This is an informational reference for agents and developers working on the
> gateway. Use it to locate critical files, understand routing logic, and source exact model
> ID strings. It is not a strict specification — the authoritative source for any value is
> always the actual project file it points to.

> **Naming note:** The subsections within Parts 1 and 2 use Priority Levels (P1, P2, P3)
> to indicate read-order importance. These are NOT the same as gateway Tiers 1/2/3.
> Gateway tiers refer to AIClient2API, LiteLLM, and ZSH. Priority levels refer to which
> files to read first when orienting within a repo.

---

## Part 1: LiteLLM — Tier 2 Gateway Router

**Project root:** `/Users/ilialiston/MASTER-C/Tier2-LiteLLM/` (within the MASTER-C project directory)

LiteLLM is the primary entry point for Claude Code CLI. It receives Anthropic-format
`/v1/messages` requests, normalizes payloads, handles load balancing and fallback level 3
(tiered model downgrade), and forwards OpenAI-format requests downstream to Tier 1.

### P1 — Read First (Orientation)

| File | Role |
|---|---|
| `CLAUDE.md` | The single most important file for agents. Covers conventions, patterns, and structure specifically through a Claude lens. |
| `AGENTS.md` | Explicit instructions for AI agents operating on the repo. Covers navigation and system connections. |
| `ARCHITECTURE.md` | Deep breakdown of proxy server, router, and SDK layer interactions. Essential for understanding request flow. |
| `litellm_config.yaml` | **The active master config.** Defines model routing, API keys, fallback chains, and middleware. This is the file to read and edit. |

### P2 — Proxy & Router Internals

| File | Role |
|---|---|
| `litellm/proxy/proxy_server.py` | FastAPI entrypoint. Controls how `/chat/completions` requests are received and dispatched. |
| `litellm/router.py` | Multi-model routing, load balancing, fallback logic, and retry strategies. Owns Level 3 downgrade behavior. |
| `litellm/proxy/utils.py` | Debugging helpers for token counting, key validation, and error wrapping. |
| `litellm/exceptions.py` | All error types (`AuthenticationError`, `RateLimitError`, etc.). Reference when writing error-handling logic. |

### P3 — Integration & Types

| File | Role |
|---|---|
| `.env.example` | Exact environment variables required for API keys and base URLs. |
| `docker-compose.yml` | Canonical network configuration for reaching the proxy. |
| `litellm/proxy/_types.py` | Pydantic models defining the exact shape of request/response data between Claude Code and the proxy. |
| `litellm/proxy/exception_handler.py` | Maps upstream provider errors to normalized LiteLLM errors. |
| `litellm/main.py` | SDK top-level `completion()` call. |

---

## Part 2: AIClient2API — Tier 1 Provider Proxy

**Project root:** `/Users/ilialiston/MASTER-C/Tier1-AIClient2API/` (within the MASTER-C project directory)

AIClient2API sits behind LiteLLM and acts as the adapter layer. It translates
OpenAI-format requests from LiteLLM into native authenticated API calls for each
provider (Gemini, Kiro, Codex, Grok, Antigravity, iFlow, Qwen, and custom providers).

> ⚠️ **Critical — Model ID Mismatch:** The #1 source of silent failures and 404s is a
> mismatched model ID. The model string LiteLLM sends to AIClient2API **must exactly match**
> the model ID defined in that provider's adapter inside `src/providers/`. Before configuring
> any model in LiteLLM, verify the exact string in `src/providers/provider-models.js`.

### P1 — Read First (Orientation)

| File | Role |
|---|---|
| `README.md` | Documents all providers, model mappings, config options, and API key setup. Start here. |
| `src/providers/provider-models.js` | **The canonical model ID map.** Every valid model string for every provider lives here. This is the authoritative source — not the model lists in this guide. |
| `src/core/` | The brain of the proxy: request routing, rate limiting, key management, and the Cockpit quota module. |
| `src/providers/` | One subfolder per provider adapter (`claude/`, `gemini/`, `openai/`, `grok/`, `forward/`). Critical for debugging auth and format errors. |

### P2 — High Value

| File | Role |
|---|---|
| `configs/` | All configuration templates defining endpoints, provider pools, and routing rules. |
| `src/handlers/` | OpenAI-compatible endpoint handlers — this is what LiteLLM's requests hit. |
| `src/converters/` & `src/convert/` | Format translation between native provider APIs and OpenAI spec. Most LiteLLM-related format errors originate here. |
| `src/services/` | Request dispatching and retry logic. |
| `src/auth/` | API key validation and injection. |
| `src/utils/` | Error formatters and logging helpers. Essential for debugging 401/429 errors. |
| `healthcheck.js` | Health endpoint — used by `claude-pick` and `claude-swap` to verify Tier 1 is live. |
| `package.json` | Dependency versions. |

---

## Part 3: Provider Model Directory

**How to use this section:**
Each provider entry shows:
- The AIClient2API provider type string (used in `configs/` and pool manager setup)
- The confirmed model ID strings for that provider
- Reference links for sourcing updated IDs

> ⚠️ **Always verify model IDs against `src/providers/provider-models.js` before
> configuring.** The strings below are the current known-good list, but the project file
> is authoritative. When in doubt, check the file.

---

### Kiro / Claude
**AIClient2API provider type:** `claude-kiro-oauth`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/claude-kiro-oauth/`

| Model ID | Tier |
|---|---|
| `claude-opus-4-7` | Flagship |
| `claude-opus-4-6` | Flagship |
| `claude-opus-4-5` | Flagship |
| `claude-opus-4-5-20251101` | Flagship (versioned) |
| `claude-sonnet-4-6` | Balanced |
| `claude-sonnet-4-5` | Balanced |
| `claude-sonnet-4-5-20250929` | Balanced (versioned) |
| `claude-haiku-4-5` | Fast |
| `claude-haiku-4-5-20251001` | Fast (versioned) |

**Reference links:**
- Kiro models docs (official): https://kiro.dev/docs/models/
- Kiro models changelog (track new IDs): https://kiro.dev/changelog/models/
- Anthropic models overview (underlying models): https://platform.claude.com/docs/en/about-claude/models/overview
- Community proxy reference: https://github.com/jwadow/kiro-gateway

---

### Antigravity
**AIClient2API provider type:** `gemini-antigravity`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/gemini-antigravity/`

| Model ID | Notes |
|---|---|
| `gemini-3-flash` | |
| `gemini-3.5-flash-low` | |
| `gemini-3.5-flash-high` | |
| `gemini-3.1-pro-low` | |
| `gemini-3.1-pro-high` | |
| `gemini-3.1-flash-image` | Image-capable |
| `gemini-3-flash-agent` | Agent-optimized |
| `gemini-2.5-flash` | |
| `gemini-2.5-flash-lite` | |
| `gemini-2.5-flash-thinking` | Extended reasoning |
| `gemini-claude-sonnet-4-6` | Claude model via Antigravity |
| `gemini-claude-opus-4-6-thinking` | Claude Opus via Antigravity, thinking mode |

**Reference links:**
- Official models page: https://antigravity.google/docs/models
- Antigravity API spec (verified model IDs): https://github.com/NoeFabris/opencode-antigravity-auth/blob/main/docs/ANTIGRAVITY_API_SPEC.md
- Raw spec (programmatic parsing): https://raw.githubusercontent.com/NoeFabris/opencode-antigravity-auth/main/docs/ANTIGRAVITY_API_SPEC.md
- Antigravity home: https://antigravity.google

---

### Gemini CLI OAuth
**AIClient2API provider type:** `gemini-cli-oauth`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/gemini-cli-oauth/`

| Model ID | Notes |
|---|---|
| `gemini-3.1-pro-preview` | |
| `gemini-3-flash-preview` | |
| `gemini-3.1-flash-lite-preview` | |
| `gemini-3.5-flash` | |
| `gemini-2.5-pro` | |
| `gemini-2.5-flash` | |
| `gemini-2.5-flash-lite` | |

**Reference links:**
- Gemini API models (official, all IDs): https://ai.google.dev/gemini-api/docs/models
- Gemini CLI model selection docs: https://geminicli.com/docs/cli/model/
- AI SDK community provider (OAuth model IDs): https://ai-sdk.dev/providers/community-providers/gemini-cli
- Auth setup: https://geminicli.com/docs/get-started/authentication/

---

### OpenAI Codex
**AIClient2API provider type:** `openai-codex-oauth`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/openai-codex-oauth/`

| Model ID | Notes |
|---|---|
| `gpt-5.2` | |
| `gpt-5.3-codex` | |
| `gpt-5.3-codex-spark` | |
| `gpt-5.4` | |
| `gpt-5.4-mini` | |
| `gpt-5.5` | |
| `gpt-image-2` | Image-capable |

**Reference links:**
- Codex models page (with CLI model IDs): https://developers.openai.com/codex/models
- OpenAI API all models: https://developers.openai.com/api/docs/models
- OpenAI REST API list endpoint: https://developers.openai.com/api/reference/resources/models/methods/list/

---

### Grok / xAI
**AIClient2API provider type:** `grok-web`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/` (check for grok or xai subfolder)

| Model ID | Notes |
|---|---|
| `grok-4.1-mini` | |
| `grok-4.1-thinking` | Extended reasoning |
| `grok-4.20` | |
| `grok-4.20-auto` | |
| `grok-4.20-fast` | |
| `grok-4.20-expert` | |
| `grok-4.20-heavy` | Highest capability |
| `grok-imagine-1.0` | Image generation |
| `grok-imagine-1.0-edit` | Image editing |
| `grok-imagine-1.0-fast` | Fast image generation |
| `grok-imagine-1.0-fast-edit` | Fast image editing |

**Reference links:**
- Models overview (official): https://docs.x.ai/docs/models
- REST API list models: https://docs.x.ai/developers/rest-api-reference/inference/models
- xAI console model list: https://console.x.ai/team/default/models
- Pricing: https://x.ai/api

---

### iFlow
**AIClient2API provider type:** `openai-iflow`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/` (check for iflow subfolder)

> ⚠️ **Migration notice:** The iFlow CLI was shut down on April 17, 2026. Check whether
> `openai-iflow` credentials are still active before configuring. If the credential is
> invalid or expired, skip this provider — do not block the build on it.
> The official migration target is Qoder: https://qoder.com

| Model ID | Notes |
|---|---|
| `iflow-rome-30ba3b` | |
| `qwen3-coder-plus` | Also available via Qwen OAuth |
| `qwen3-max` | |
| `qwen3-vl-plus` | Vision |
| `qwen3-max-preview` | |
| `qwen3-32b` | |
| `qwen3-235b-a22b-thinking-2507` | Extended reasoning |
| `qwen3-235b-a22b-instruct` | |
| `qwen3-235b` | |
| `kimi-k2-0905` | |
| `kimi-k2` | |
| `kimi-k2.5` | |
| `glm-4.6` | |
| `glm-4.7` | |
| `glm-5` | |
| `deepseek-v3` | |
| `deepseek-v3.2` | |
| `deepseek-r1` | Extended reasoning |
| `minimax-m2.1` | |
| `minimax-m2.5` | |

**Reference links:**
- iFlow platform docs (still live): https://platform.iflow.cn/en/docs
- iFlow CLI GitHub (archived, model list): https://github.com/iflow-ai/iflow-cli
- Mastra docs — iFlow model IDs (best up-to-date reference): https://mastra.ai/models/providers/iflowcn
- VoltAgent docs — iFlow model IDs: https://voltagent.dev/models-docs/providers/iflowcn/

---

### Qwen OAuth
**AIClient2API provider type:** `openai-qwen-oauth`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/` (check for qwen subfolder)

> ⚠️ **Verify model IDs before configuring.** The current confirmed working strings are
> listed below. `coder-model` and `vision-model` are internal aliases — use the explicit
> model IDs below instead if those aliases fail.

| Model ID | Notes |
|---|---|
| `qwen3-coder-plus` | Primary coding model |
| `qwen3-coder-flash` | Fast coding model |

**Reference links:**
- Model catalog (official): https://www.alibabacloud.com/help/en/model-studio/models
- OpenAI-compatible model IDs: https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope
- Qwen Code model providers (proxy context): https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/
- API quickstart: https://www.alibabacloud.com/help/en/model-studio/first-api-call-to-qwen
- Qwen GitHub org (model releases): https://github.com/QwenLM
- OpenRouter Qwen models: https://openrouter.ai/qwen

---

### GitHub Models
**AIClient2API provider type:** `forward-custom`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/github-models/`

> GitHub Models uses AIClient2API's `forward-custom` provider type with a generic
> OpenAI-compatible pass-through. The model IDs are whatever GitHub Models exposes
> at their inference endpoint. Read the credential file for the active token, then
> query the live catalog endpoint to get current model IDs.

**Reference links:**
- GitHub Models marketplace: https://github.com/marketplace?type=models
- REST API catalog docs: https://docs.github.com/en/rest/models/catalog
- REST API inference docs: https://docs.github.com/en/rest/models/inference
- Live catalog endpoint (requires GitHub token): https://models.github.ai/catalog/models
- GitHub Models changelog: https://github.blog/changelog/2025-05-15-github-models-api-now-available/
- GitHub Copilot supported models: https://docs.github.com/copilot/reference/ai-models/supported-models
- Copilot live models API (requires Copilot OAuth): https://api.githubcopilot.com/v1/models

---

### NVIDIA NIM
**AIClient2API provider type:** `forward-custom`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/nvidia-nim/`

> NVIDIA NIM also uses AIClient2API's `forward-custom` provider type. It exposes an
> OpenAI-compatible endpoint. Read the credential file for the active API key and
> base URL, then query the models endpoint for current available model IDs.

**Reference links:**
- NVIDIA NIM API catalog: https://build.nvidia.com/explore/discover
- NIM API reference: https://docs.api.nvidia.com/nim/reference/
- OpenAI-compatible endpoint docs: https://docs.api.nvidia.com/nim/reference/openai-compatible

---

### OpenRouter (Optional / Pass-Through)
**AIClient2API provider type:** `forward-custom` or `forward-api`

> OpenRouter provides access to models from multiple providers through a single
> OpenAI-compatible endpoint. Configure as `forward-custom` if you want to route
> specific models through it.

**Reference links:**
- Models browser (UI): https://openrouter.ai/models
- Live API all model IDs (no auth required): https://openrouter.ai/api/v1/models
- API reference list models: https://openrouter.ai/docs/api/api-reference/models/get-models
- Models overview: https://openrouter.ai/docs/guides/overview/models
- OpenAPI spec (JSON): https://openrouter.io/openapi.json
- RSS feed (new models): https://openrouter.ai/models/rss

---

## Part 4: Custom Provider Configuration

AIClient2API supports four dynamic provider types that accept whatever model ID you
define in their config templates. Use these for providers not covered by a native adapter:

| Provider Type | Use Case |
|---|---|
| `forward-custom` | Generic OpenAI-compatible endpoint pass-through. Used for GitHub Models, NVIDIA NIM, OpenRouter, and any other provider with an `/v1/chat/completions` endpoint. |
| `forward-api` | Similar to `forward-custom` with additional routing options. |
| `claude-custom` | Custom Claude-compatible endpoint. |
| `openai-custom` | Custom OpenAI-compatible endpoint. Used in `/Users/ilialiston/MASTER-C/Credentials/openai-custom/`. |
| `openaiResponses-custom` | Custom OpenAI Responses API endpoint. |

For `forward-custom` providers, the model ID in your config is whatever model string
the target provider's API accepts. Check the provider's own `/v1/models` endpoint
for the current list.

---

## Part 5: Fallback Downgrade Chain (Tier 2 — LiteLLM)

LiteLLM owns Level 3 fallback (tiered model downgrade). Configure this in
`litellm_config.yaml` using LiteLLM's `fallbacks` router setting. The downgrade
chain must always descend — never upgrade:

```
claude-opus-4-7  →  claude-opus-4-6  →  claude-sonnet-4-6  →  claude-haiku-4-5
gemini-3.1-pro-high  →  gemini-3.1-pro-low  →  gemini-3-flash
gpt-5.5  →  gpt-5.4  →  gpt-5.4-mini
grok-4.20-heavy  →  grok-4.20  →  grok-4.1-mini
```

The exact chain for each provider should be configured based on the models confirmed
active in `src/providers/provider-models.js` at build time.