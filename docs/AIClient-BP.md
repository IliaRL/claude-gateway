# AIClient2API Best Practices (Tier 1)

This document covers best practices for configuring and operating AIClient2API as the Tier 1 proxy in the 3-Tier AI Gateway architecture. AIClient2API translates standard OpenAI or Anthropic requests into authenticated, provider-specific calls.

## 1. Core Architecture

AIClient2API acts as a local bridge that translates client-only API protocols (like Gemini CLI, Antigravity, Kiro, Codex, and Grok) into standard OpenAI or Anthropic REST interfaces. 

In the 3-Tier stack, it receives OpenAI-formatted requests from Tier 2 (LiteLLM) on `http://127.0.0.1:3000/v1` and maps them directly to the native APIs of the designated upstream providers.

## 2. Configuration & Reliability 

To achieve 99.9% uptime and prevent rate-limiting bottlenecks, implement the following configurations in `configs/config.json` and `configs/provider_pools.json`:

* **OAuth Token Auto-Refresh**: Tokens for providers like Gemini, Antigravity, and Codex expire rapidly. Enable `CRON_REFRESH_TOKEN: true` in `configs/config.json`.
* **Provider Account Pools**: Never rely on a single account. Configure `PROVIDER_POOLS_FILE_PATH` to point at `configs/provider_pools.json` — this enables multi-account polling and Level 1/Level 2 intelligent load balancing.
* **Rate Limit Cooldowns**: Set `RATE_LIMIT_COOLDOWN_ENABLED: true` and define `RATE_LIMIT_COOLDOWN_MS`. This ensures accounts hitting rate limits are temporarily removed from the rotation pool and recover automatically.
* **TLS Sidecar (For Strict Providers)**: If routing to providers with strict Cloudflare JA3/JA4 fingerprinting (like Grok), set `TLS_SIDECAR_ENABLED: true` and `TLS_SIDECAR_PORT: 9090` to simulate browser fingerprints and bypass 403 blocks.

## 3. Critical Pitfalls

* **API Key Alignment**: The proxy relies on a static API key for AI inference requests (the "AI Business Path"). You must define `REQUIRED_API_KEY` in `configs/config.json`.
* **Do Not Mix Auth Tokens**: The proxy utilizes two distinct authentication paths. Do not use the dynamic Admin Token (used for management endpoints) for AI inference. 
* **Model ID Exact Match**: The model string sent from LiteLLM must perfectly match the string expected by AIClient2API's `src/providers/provider-models.js`. A mismatch results in a 404.

## 4. Error Diagnostics

* **401 Unauthorized**: The incoming request (from Tier 2) failed to pass the `Authorization` header, or the key does not match `REQUIRED_API_KEY`.
* **403 Forbidden**: The upstream provider blocked the proxy. This is typically an expired OAuth token (ensure Auto-Refresh is active) or a blocked TLS fingerprint (ensure TLS Sidecar is enabled).
* **404 Not Found**: A routing mismatch. Verify the model ID matches the internal map, and ensure the URL path does not contain duplicated segments (e.g., `/v1/v1/chat/completions`).
* **429 Too Many Requests**: The provider pool is exhausted. Add more accounts or increase `RATE_LIMIT_COOLDOWN_MS`.
* **No available and healthy providers for type**: The requested model has been filtered out via the `notSupportedModels` array in the pool config, or all pre-loaded OAuth credentials have expired simultaneously.
