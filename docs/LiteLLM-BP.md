# LiteLLM Best Practices (Tier 2)

This document outlines the optimal configuration and performance tuning for LiteLLM running as the Tier 2 router.

## 1. Core Configuration (`litellm_config.yaml`)

LiteLLM sits on port `4000`. Its sole responsibility is payload normalization, absorbing transient errors, and executing the final Level 3 fallback (tiered model downgrade) before failing the request.

```yaml
model_list:
  - model_name: "claude-kiro-oauth:claude-opus-4-7"
    litellm_params:
      model: "openai/claude-kiro-oauth:claude-opus-4-7"
      api_base: "http://127.0.0.1:3000/v1"
      api_key: "os.environ/AICLIENT_TOKEN"
```

**Key Directives:**
* **`model` prefix:** Always use the `openai/` prefix in the `litellm_params.model` field. This instructs LiteLLM to perform the Anthropic-to-OpenAI translation and send standard OpenAI JSON to Tier 1.
* **`api_base`:** Always point to Tier 1's standard `/v1` endpoint (`http://127.0.0.1:3000/v1`).
* **Telemetry:** Disable telemetry to reduce background noise and latency. Add `litellm.telemetry=False` to the environment.

## 2. macOS CPU Crash Analysis & Mitigation

On macOS, running LiteLLM with specific aggressive configurations causes the Python Uvicorn worker process to spike to 100% CPU, resulting in a gateway freeze. 

**Mitigations:**
1. **Disable Latency-Based Routing:** Do not use `router_settings: {"routing_strategy": "latency-based"}`. This strategy actively polls upstream endpoints. If Tier 1 is slow or returning 429s, the polling mechanism enters a tight loop on macOS, spiking the CPU and crashing the process. Use standard ordered routing.
2. **Worker Count:** Limit the number of Uvicorn workers. Use `uvicorn main:app --workers 2` rather than relying on auto-scaling, which can thrash the macOS scheduler.
3. **Database Connections:** If using a Postgres DB for LiteLLM logging/caching, ensure the connection pool is constrained. Idle transaction timeouts will crash the gateway under heavy async load.

## 3. The `drop_params` Danger Zone

LiteLLM supports a `drop_params: true` configuration flag that strips unsupported parameters from payloads before forwarding them. 

**CRITICAL WARNING:** You must **never** apply `drop_params: true` globally when routing Claude Code traffic. 

Claude Code injects complex nested schemas for Tool Use. The `drop_params` flag frequently misidentifies these nested tool schemas as "unsupported parameters" and aggressively strips them. The request will successfully reach the upstream provider, but the provider will not receive the tool definitions, causing it to return standard text instead of invoking the required tools. This completely breaks Claude Code's functionality.

If parameter dropping is necessary for a specific obscure provider, apply it exclusively to that model's specific `litellm_params` block, never at the global router level.

## 4. Fallback Configuration

Configure Level 3 fallbacks within the router settings. Always downgrade, never upgrade. 

```yaml
router_settings:
  fallbacks:
    - {"claude-opus-4-7": ["claude-sonnet-4-6", "claude-haiku-4-5"]}
```

Ensure `num_retries: 3` is set to allow Tier 1 sufficient time to rotate its internal accounts (Level 1/2 fallbacks) before Tier 2 assumes total failure and drops to a lower-tier model.
