<!-- generated-by: gsd-doc-writer -->
# Architecture & Proxy Integration

This document defines the architectural routing rules, proxy constraints, and official Anthropic gateway specifications necessary for 100% compatibility between the Claude Code CLI and our custom 3-Tier AI Gateway.

## 1. Request Flow

The full active request path is:

```
Claude Code CLI → Tier 2 LiteLLM (:4000) → Tier 1 AIClient2API (:3000) → External provider
```

Both tiers are active. The previous bypass of Tier 2 (routing directly to `:3000`) was resolved in commit `a093426` after SSE passthrough was verified clean. The active path now goes through LiteLLM for payload normalization before reaching AIClient2API for provider auth and protocol translation.

**Startup order is mandatory:** Tier 1 must be healthy before Tier 2 starts. LiteLLM fires ~80 concurrent health-check requests at `:3000` on startup — if Tier 1 is still initializing, this causes an immediate CPU spike. Use `start-proxies` (the `_ensure_gateways` alias) or `safereset`; never start both tiers in parallel manually.

## 2. Gateway Topology & Tool Discovery

Claude Code contains hardcoded internal logic that alters its behavior based on the `ANTHROPIC_BASE_URL`. If the URL does not point to an official Anthropic endpoint (e.g., `api.anthropic.com`), the CLI assumes it is hitting an AWS Bedrock or Vertex endpoint and disables several native features — most importantly, **Tool Search**.

To bypass this internal limitation and restore full functionality when routing through the proxy, export the following environment variables in the ZSH initialization profile. `claude-proxy` writes `ANTHROPIC_BASE_URL=http://127.0.0.1:4000` (Tier 2 LiteLLM) to `~/.claude/settings.json`.

```bash
# Force the CLI to enable the Tool Search capability despite a custom Base URL
export ENABLE_TOOL_SEARCH=true

# Allow the CLI to fetch available models from LiteLLM's /v1/models endpoint
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

The `claude-proxy` shell function (defined in `~/AIClient2API/scripts/claude-mode.sh`, sourced by `~/dotfiles/zsh/zshrc`) sets:

| Variable | Value | Purpose |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:4000` | Routes Claude Code through Tier 2 LiteLLM |
| `ANTHROPIC_API_KEY` | `$PROXY_TOKEN` | Proxy auth token |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1` | Enables model list fetch from `/v1/models` |
| `ENABLE_TOOL_SEARCH` | `true` | Restores Tool Search on non-Anthropic base URL |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | `0` | Suppresses attribution header injection |

## 3. Server-Sent Events (SSE) Buffering Rules

A common cause of JSON corruption during tool-use execution is middleware buffering. As Claude Code streams multi-step tool calls, intermediate proxy layers (like NGINX, LiteLLM, or AIClient2API) often attempt to buffer the Server-Sent Events (SSE) chunks. This delays delivery and concatenates multiple `data:` frames, causing the CLI's JSON parser to crash.

**Critical Rule:** Every proxy layer in the chain MUST inject the following header on all streaming responses:
`X-Accel-Buffering: no`

### Tier 2 SSE Configuration

The following settings in `Tier2-LiteLLM/litellm_config.yaml` ensure clean SSE passthrough through LiteLLM (verified by SSE_PASSTHROUGH test — unbroken `data:` lines, `text/event-stream` content type, no corruption):

```yaml
litellm_settings:
  drop_params: false
  stream_timeout: 600
  default_team_settings:
    headers:
      X-Accel-Buffering: "no"
```

- `stream_timeout: 600` — 600-second stream timeout accommodates long agentic tool-use loops without dropping the connection.
- `drop_params: false` — passes all request parameters to Tier 1 without stripping.
- `X-Accel-Buffering: "no"` — disables NGINX-level buffering on all responses.

## 4. Official Anthropic Gateway Specifications

To guarantee compliance, the Gateway must adhere to the following Anthropic API specifications:

### Header Pass-Through

The Gateway must seamlessly pass the following headers from the Claude Code CLI to the downstream provider (or handle them appropriately if translating to OpenAI format):

- `anthropic-version`: Identifies the API version (e.g., `2023-06-01`).
- `anthropic-beta`: Contains beta feature flags (e.g., `tools-2024-04-04`). **Do not strip this header**, as it is strictly required for advanced tool usage.

### Kiro anthropic-beta Header Forwarding

The Kiro adapter (`src/providers/claude/claude-kiro.js`) dynamically constructs the `anthropic-beta` header from request body signals at both unary and streaming call sites. This ensures Kiro receives correct beta flags without requiring the caller to set them explicitly.

**Detection logic (applied identically in both call sites):**

| Signal | Beta value added |
|---|---|
| `body.tools` is a non-empty array | `tools-2024-04-04` |
| Any `content` block in `body.messages` or `body.system` has `cache_control` | `prompt-caching-2024-07-31` |
| `body.thinking` is an object | `interleaved-thinking-2025-05-14` |

Multiple values are comma-joined into a single header value (e.g., `tools-2024-04-04,prompt-caching-2024-07-31`).

**Header name selection:** When the model ID starts with `amazonq`, the header is sent as `x-amzn-kiro-amazonq-beta` instead of `anthropic-beta` to match the Amazon Q endpoint's expected header name.

### Error Standardization

All generated errors must match the Anthropic error format:

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "Gateway error description"
  }
}
```

- **400 Bad Request**: Thrown immediately if required fields (`model`, `messages`, `max_tokens`) are missing, or if the `anthropic-version` header is absent.
- **429 Too Many Requests**: Thrown when Tier 1 pool exhaustion occurs and Tier 2 has no fallback models remaining.
- **502 Bad Gateway**: Thrown when upstream connection fails and no fallbacks are available.

### Connection Resilience

The gateway implements HTTP Keep-Alive and configures appropriate read/write timeouts (minimum 300 seconds, 600 seconds for streaming via `stream_timeout`) to accommodate long-running agentic tool-use loops without aggressively dropping the connection.
