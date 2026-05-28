<!-- generated-by: gsd-doc-writer -->
# Architecture & Proxy Integration

This document defines the architectural routing rules, proxy constraints, and official Anthropic gateway specifications necessary for 100% compatibility between the Claude Code CLI and our custom 3-Tier AI Gateway.

## 1. Gateway Toplogy & Tool Discovery

Claude Code contains hardcoded internal logic that alters its behavior based on the `ANTHROPIC_BASE_URL`. If the URL does not point to an official Anthropic endpoint (e.g., `api.anthropic.com`), the CLI assumes it is hitting an AWS Bedrock or Vertex endpoint and disables several native features—most importantly, **Tool Search**.

To bypass this internal limitation and restore full functionality when routing through our custom proxy (`http://127.0.0.1:3000`), you **must** export the following environment variables globally in the ZSH initialization profile. Note: `ANTHROPIC_BASE_URL` is currently set to `http://127.0.0.1:3000` (Tier 1 direct). LiteLLM (`:4000`) still runs but was removed from the active Claude Code request path to eliminate SSE stream corruption caused by LiteLLM re-wrapping streaming chunks.

```bash
# Force the CLI to enable the Tool Search capability despite a custom Base URL
export ENABLE_TOOL_SEARCH=true

# Allow the CLI to fetch available models from LiteLLM's /v1/models endpoint
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

## 2. Server-Sent Events (SSE) Buffering Rules

A common cause of JSON corruption during tool-use execution is middleware buffering. As Claude Code streams multi-step tool calls, intermediate proxy layers (like NGINX, LiteLLM, or AIClient2API) often attempt to buffer the Server-Sent Events (SSE) chunks. This delays delivery and concatenates multiple `data:` frames, causing the CLI's JSON parser to crash.

**Critical Rule:** Every proxy layer in the chain MUST inject the following header on all streaming responses:
`X-Accel-Buffering: no`

## 3. Official Anthropic Gateway Specifications

To guarantee compliance, the Gateway must adhere to the following Anthropic API specifications:

### Header Pass-Through
The Gateway must seamlessly pass the following headers from the Claude Code CLI to the downstream provider (or handle them appropriately if translating to OpenAI format):
* `anthropic-version`: Identifies the API version (e.g., `2023-06-01`).
* `anthropic-beta`: Contains beta feature flags (e.g., `tools-2024-04-04`). **Do not strip this header**, as it is strictly required for advanced tool usage.

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
* **400 Bad Request**: Thrown immediately if required fields (`model`, `messages`, `max_tokens`) are missing, or if the `anthropic-version` header is absent.
* **429 Too Many Requests**: Thrown when Tier 1 pool exhaustion occurs and Tier 2 has no fallback models remaining.
* **502 Bad Gateway**: Thrown when upstream connection fails and no fallbacks are available.

### Connection Resilience
The gateway should implement HTTP Keep-Alive and configure appropriate read/write timeouts (minimum 300 seconds) to accommodate long-running agentic tool-use loops without aggressively dropping the connection.
