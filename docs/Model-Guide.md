# Model-Guide.md
# 2-Tier AI Gateway — System Reference & Architecture Guide

> **Purpose:** Informational reference for agents and developers working on the gateway. Use it to locate critical files, understand routing logic, and source exact model ID strings. It is not a strict specification — the authoritative source for any value is always the actual project file it points to.

> **Naming note:** Subsection "Priority Levels" (P1, P2, P3) indicate read-order importance. These are NOT the same as gateway Tiers (Tier 1 = AIClient2API gateway; Tier 2 = ZSH CLI router).

---

## Part 1: AIClient2API — Tier 1 Gateway (port 3000)

**Project root:** `/Users/ilialiston/MASTER-C/AIClient2API/`

AIClient2API is the single gateway Claude Code talks to directly. It receives Anthropic-format
`/v1/messages` (and OpenAI-format `/v1/chat/completions`) requests, performs account-pool load
balancing, owns all three fallback levels, and translates each request into native authenticated
API calls per provider (Gemini, Kiro, Codex, Grok, Antigravity, and custom providers).

> ⚠️ **Critical — Model ID Mismatch:** A requested model string **must exactly match** the model ID defined in that provider's adapter inside `src/providers/`. Verify the exact string in `src/providers/provider-models.js`.

### Priority Reading
- `src/providers/provider-models.js`: **The canonical model ID map.** Every valid model string for every provider lives here.
- `configs/config.json`: server config, `providerFallbackChain`, and `modelFallbackMapping` (the fallback ladders).
- `configs/provider_pools.json`: per-account credential pools (live secrets — gitignored).
- `src/providers/provider-pool-manager.js`: account selection + all three fallback levels.
- `src/converters/` & `src/convert/`: format translation between native provider APIs and OpenAI/Anthropic spec. Most format errors originate here.

---

## Part 2: Provider Model Directory

> ⚠️ **Always verify model IDs against `src/providers/provider-models.js` before configuring.**

### Kiro / Claude
**Provider type:** `claude-kiro-oauth`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/claude-kiro-oauth/`

| Model ID | Tier |
|---|---|
| `claude-opus-4-7` | Flagship |
| `claude-sonnet-4-6` | Balanced |
| `claude-haiku-4-5` | Fast |

### Antigravity
**Provider type:** `gemini-antigravity`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/gemini-antigravity/`

| Model ID | Notes |
|---|---|
| `gemini-3-flash` | Always-available terminal fallback model |
| `gemini-3.5-flash-high` | Alias → `gemini-3-flash-agent` (Antigravity "High" tier) |
| `gemini-3.1-pro-low` | |
| `gemini-2.5-flash-thinking` | Extended reasoning |
| `gemini-claude-sonnet-4-6` | Claude model via Antigravity |

### Gemini CLI OAuth
**Provider type:** `gemini-cli-oauth`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/gemini-cli-oauth/`

| Model ID | Notes |
|---|---|
| `gemini-3.1-pro-preview` | |
| `gemini-3.5-flash` | |

### OpenAI Codex
**Provider type:** `openai-codex-oauth`
**Credential folder:** `/Users/ilialiston/MASTER-C/Credentials/openai-codex-oauth/`

| Model ID | Notes |
|---|---|
| `gpt-5.5` | |
| `gpt-5.4-mini` | |

### Custom / static-key providers

| Provider Type | Use Case |
|---|---|
| `openai-custom` | OpenRouter and other OpenAI-compatible endpoints (models from `configs/custom_models.json`) |
| `nvidia-nim` | NVIDIA NIM (static API key) |
| `github-models` | GitHub Models (static PAT, needs `models:read` scope) |

---

## Part 3: Fallback Routing (all owned by Tier 1)

All three levels are implemented in `src/providers/provider-pool-manager.js` and configured by
data in `configs/config.json`:

1. **Vertical (Level 1)** — rotate accounts for the requested model on its provider.
2. **Horizontal (Level 2)** — same model across other compatible providers (`providerFallbackChain`).
3. **Tiered downgrade (Level 3)** — `modelFallbackMapping`: descend to a lower model only after the
   requested model is fully exhausted. Chains must always descend and **terminate at a stable,
   always-available model** (e.g. `gemini-3-flash`) — never cycle. Example ladders:

```text
claude-opus-4-7 → claude-opus-4-6 → claude-opus-4-5 → gemini-claude-opus-4-6-thinking → claude-sonnet-4-5-20250929
claude-sonnet-4-6 → gemini-claude-sonnet-4-6 → gemini-3.1-pro-low → gemini-3-flash (terminal)
gemini-2.5-pro / gemini-3.1-pro-high → gemini-3.1-pro-low → gemini-3-flash (terminal)
```

> The runtime has a cycle-guard, but cyclic config defeats the purpose of level-3 (it bounces then
> returns null instead of degrading). Validate that every `targetModel` resolves to a catalog model
> and that chains terminate. (Verified clean as of this milestone.)
