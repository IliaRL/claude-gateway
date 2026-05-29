# Model-Guide.md
# 3-Tier AI Gateway — System Reference & Architecture Guide

> **Purpose:** This is an informational reference for agents and developers working on the gateway. Use it to locate critical files, understand routing logic, and source exact model ID strings. It is not a strict specification — the authoritative source for any value is always the actual project file it points to.

> **Naming note:** The subsections within Parts 1 and 2 use Priority Levels (P1, P2, P3) to indicate read-order importance. These are NOT the same as gateway Tiers 1/2/3.

---

## Part 1: LiteLLM — Tier 2 Gateway Router

**Project root:** `/Users/ilialiston/MASTER-C/Tier2-LiteLLM/`

LiteLLM is the primary entry point for Claude Code CLI. It receives Anthropic-format `/v1/messages` requests, normalizes payloads, handles load balancing and fallback level 3 (tiered model downgrade), and forwards OpenAI-format requests downstream to Tier 1.

### Priority Reading
- `CLAUDE.md`: Conventions, patterns, and structure through a Claude lens.
- `litellm_config.yaml`: **The active master config.** Defines model routing, API keys, fallback chains, and middleware.
- `litellm/proxy/proxy_server.py`: FastAPI entrypoint.
- `litellm/router.py`: Multi-model routing, load balancing, and Level 3 downgrade fallback logic.

---

## Part 2: AIClient2API — Tier 1 Provider Proxy

**Project root:** `/Users/ilialiston/MASTER-C/AIClient2API/`

AIClient2API sits behind LiteLLM and translates OpenAI-format requests from LiteLLM into native authenticated API calls for each provider (Gemini, Kiro, Codex, Grok, Antigravity, iFlow, Qwen, and custom providers).

> ⚠️ **Critical — Model ID Mismatch:** The model string LiteLLM sends to AIClient2API **must exactly match** the model ID defined in that provider's adapter inside `src/providers/`. Verify the exact string in `src/providers/provider-models.js`.

### Priority Reading
- `src/providers/provider-models.js`: **The canonical model ID map.** Every valid model string for every provider lives here.
- `configs/`: All configuration templates defining endpoints, provider pools, and routing rules.
- `src/converters/` & `src/convert/`: Format translation between native provider APIs and OpenAI spec. Most LiteLLM-related format errors originate here.

---

## Part 3: Provider Model Directory

> ⚠️ **Always verify model IDs against `src/providers/provider-models.js` before configuring.**

### Kiro / Claude
**AIClient2API provider type:** `claude-kiro-oauth`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/claude-kiro-oauth/`

| Model ID | Tier |
|---|---|
| `claude-opus-4-7` | Flagship |
| `claude-sonnet-4-6` | Balanced |
| `claude-haiku-4-5` | Fast |

### Antigravity
**AIClient2API provider type:** `gemini-antigravity`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/gemini-antigravity/`

| Model ID | Notes |
|---|---|
| `gemini-3-flash` | |
| `gemini-3.5-flash-high` | Alias → `gemini-3-flash-agent` (Antigravity "High" tier) |
| `gemini-3.1-pro-low` | |
| `gemini-2.5-flash-thinking` | Extended reasoning |
| `gemini-claude-sonnet-4-6` | Claude model via Antigravity |

### Gemini CLI OAuth
**AIClient2API provider type:** `gemini-cli-oauth`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/gemini-cli-oauth/`

| Model ID | Notes |
|---|---|
| `gemini-3.1-pro-preview` | |
| `gemini-3.5-flash` | |

### OpenAI Codex
**AIClient2API provider type:** `openai-codex-oauth`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/openai-codex-oauth/`

| Model ID | Notes |
|---|---|
| `gpt-5.5` | |
| `gpt-5.4-mini` | |

### Custom Providers
AIClient2API supports dynamic provider types that accept whatever model ID you define in their config templates:

| Provider Type | Use Case |
|---|---|
| `forward-custom` | Generic OpenAI-compatible endpoint pass-through. Used for GitHub Models, NVIDIA NIM, OpenRouter. |
| `claude-custom` | Custom Claude-compatible endpoint. |
| `openai-custom` | Custom OpenAI-compatible endpoint. |

For `forward-custom` providers, the model ID in your config is whatever model string the target provider's API accepts.

---

## Part 4: Fallback Downgrade Chain (Tier 2 — LiteLLM)

LiteLLM owns Level 3 fallback (tiered model downgrade). Configure this in `litellm_config.yaml` using LiteLLM's `fallbacks` router setting. The downgrade chain must always descend — never upgrade:

```text
claude-opus-4-7  →  claude-sonnet-4-6  →  claude-haiku-4-5
gemini-pro (alias)  →  gemini-flash  (gemini-3.1-pro-high has no fallback entry)
gpt-5 (alias)  →  openai-codex-oauth:gpt-5.4  →  openai-codex-oauth:gpt-5.2  (gpt-5.5 has no fallback entry)
grok models — no fallback chains configured in LiteLLM
```
