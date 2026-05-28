<!-- generated-by: gsd-doc-writer -->
# CONFIGURATION.md

Complete configuration reference for the MASTER-C 3-Tier AI Gateway. This document covers all configuration files, environment variables, and runtime settings across Tier 1 (AIClient2API) and Tier 2 (LiteLLM).

---

## Environment Variables

These variables are injected by the shell layer (`~/dotfiles/zsh/zshrc`) before either tier starts. They are not set in any file inside this repository — they come from the shell environment.

| Variable | Required | Default | Description |
|---|---|---|---|
| `AICLIENT_TOKEN` | Required | — | Shared bearer token for Tier 1 and Tier 2. Must match `REQUIRED_API_KEY` in `configs/config.json`. Also used by integration tests (see Testing section below). <!-- VERIFY: exact token value --> |
| `ANTHROPIC_BASE_URL` | Required | — | Set to `http://127.0.0.1:4000` (via Tier 2 LiteLLM) by `claude-proxy`. Controls which tier Claude Code CLI hits. Can be manually set to `http://127.0.0.1:3000` to route directly to Tier 1, bypassing LiteLLM. |
| `ANTHROPIC_API_KEY` | Required | — | Set to `$AICLIENT_TOKEN` by `claude-proxy`. Used by Claude Code CLI to authenticate against the gateway. |
| `CLAUDE_MODEL` | Optional | — | Model ID injected by `claude-pick` / `claude-swap` when selecting a model from the menu. |
| `ENABLE_TOOL_SEARCH` | Required | — | Must be `true` to restore Claude Code Tool Search capability when using a non-Anthropic base URL. |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | Required | — | Must be `1` to allow Claude Code to fetch the model list from `/v1/models`. |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH` | Required | — | Must be `1` to prevent SigV4 signing attempts on the custom gateway URL. |
| `CLAUDE_CODE_STREAM_DELAY` | Optional | `0` | Set to `50` (ms) to add jitter tolerance for SSE chunk delivery. Helps with occasional stream parse errors. |

**Setting these variables:** All of the above are set automatically by the `claude-proxy`, `claude-pick`, or `start-proxies` shell functions defined in `~/dotfiles/zsh/zshrc`. Do not set them manually in `.env` files — the shell functions are the single source of truth.

### Testing Environment Variables

Integration tests (`tests/api-integration.test.js`) require an auth token to be present in the environment. There is no hardcoded fallback — if neither variable is set, the test suite fails with an error.

| Variable | Description |
|---|---|
| `AICLIENT_TOKEN` | Primary source. Set automatically by the shell environment if `claude-proxy` has been run. |
| `TEST_API_KEY` | Alternative override. Takes precedence over `AICLIENT_TOKEN` if both are set. |

Before running `pnpm test`, ensure one of these is exported in your shell session:

```bash
export AICLIENT_TOKEN="your-token-here"
# or
export TEST_API_KEY="your-token-here"
```

The `TEST_SERVER_BASE_URL` env var defaults to `http://127.0.0.1:3000` if unset — the integration test suite requires Tier 1 to be running at that address.

---

## Tier 1 — AIClient2API Config File

**File:** `Tier1-AIClient2API/configs/config.json`  
**Source of defaults:** `Tier1-AIClient2API/src/core/config-manager.js`  
**Example:** `Tier1-AIClient2API/configs/config.json.example`

The config file is loaded at startup. CLI flags override values from the file; the file overrides the defaults baked into `config-manager.js`.

### Core Settings

| Key | Required | Default | Description |
|---|---|---|---|
| `REQUIRED_API_KEY` | Required | `"123456"` | Bearer token that all incoming requests must supply. **Must match `AICLIENT_TOKEN`.** A startup warning is emitted if this is still `"123456"`. |
| `SERVER_PORT` | Required | `3000` | Listening port. **Hardcoded invariant — any other value is forced back to `3000` at startup.** |
| `HOST` | Optional | `"0.0.0.0"` | Bind address for the HTTP server. |
| `MODEL_PROVIDER` | Optional | `"gemini-cli-oauth"` | Default provider when none is specified in the request. Accepts a comma-separated list; the first becomes the active provider. Valid values match provider type strings in `src/providers/provider-models.js`. |
| `UI_ENABLED` | Optional | `true` | Enables the built-in web management UI. Pass `--no-ui` to disable. |

### Retry and Rate Limit Settings

| Key | Required | Default | Description |
|---|---|---|---|
| `REQUEST_MAX_RETRIES` | Optional | `3` | Maximum upstream request retries before returning an error. |
| `REQUEST_BASE_DELAY` | Optional | `1000` | Base delay in milliseconds between retries. |
| `CREDENTIAL_SWITCH_MAX_RETRIES` | Optional | `5` | How many times to cycle to a different credential on authentication errors before giving up. |
| `RATE_LIMIT_COOLDOWN_ENABLED` | Optional | `false` | When `true`, places a timed cooldown on accounts that receive 429 responses. |
| `RATE_LIMIT_COOLDOWN_MS` | Optional | `30000` | Default cooldown duration in milliseconds after a 429. |
| `RATE_LIMIT_COOLDOWN_JITTER_MS` | Optional | `5000` | Random jitter added to the cooldown (prevents thundering-herd on recovery). |
| `RATE_LIMIT_COOLDOWN_MAX_MS` | Optional | `300000` | Maximum cooldown to honor from a `Retry-After` header. |
| `MAX_ERROR_COUNT` | Optional | `10` | Consecutive errors before a provider account is flagged as unhealthy. |

### Scheduled Health Check

| Key | Required | Default | Description |
|---|---|---|---|
| `SCHEDULED_HEALTH_CHECK.enabled` | Optional | `false` | Enables periodic background health checks across the account pool. |
| `SCHEDULED_HEALTH_CHECK.interval` | Optional | `600000` | Interval between health checks in milliseconds (default: 10 minutes). |
| `SCHEDULED_HEALTH_CHECK.startupRun` | Optional | `false` | **Must remain `false`.** Setting this to `true` triggers 80 concurrent health-check requests at startup, causing a 429 storm. Forced back to `false` at startup if set. |

### System Prompt Settings

| Key | Required | Default | Description |
|---|---|---|---|
| `SYSTEM_PROMPT_FILE_PATH` | Optional | `"configs/input_system_prompt.txt"` | Path to a file whose contents are injected as the system prompt. |
| `SYSTEM_PROMPT_MODE` | Optional | `"append"` | How the prompt file is applied: `"append"` (adds to existing) or `"overwrite"` (replaces). |
| `SYSTEM_PROMPT_REPLACEMENTS` | Optional | `[]` | Array of `{"old": "...", "new": "..."}` substitution rules applied to the system prompt content. |

### Prompt Logging (Debug Only)

| Key | Required | Default | Description |
|---|---|---|---|
| `PROMPT_LOG_MODE` | Optional | `"none"` | `"none"` disables logging. `"console"` prints to stdout. `"file"` writes to a timestamped file. **Disable after debugging — active file logging fills disk.** |
| `PROMPT_LOG_BASE_NAME` | Optional | `"prompt_log"` | Base filename for log files when `PROMPT_LOG_MODE` is `"file"`. |

### Proxy Pass-Through (Optional)

| Key | Required | Default | Description |
|---|---|---|---|
| `PROXY_URL` | Optional | `null` | HTTP/HTTPS/SOCKS5 upstream proxy address (e.g., `http://127.0.0.1:7890`). Applied to outbound provider requests. |
| `PROXY_ENABLED_PROVIDERS` | Optional | `[]` | Array of provider type strings that should route through `PROXY_URL`. Others bypass the proxy. |

### TLS Sidecar (Advanced)

| Key | Required | Default | Description |
|---|---|---|---|
| `TLS_SIDECAR_ENABLED` | Optional | `false` | Enables the Go uTLS sidecar binary for providers that enforce browser-grade TLS fingerprinting. |
| `TLS_SIDECAR_ENABLED_PROVIDERS` | Optional | `[]` | Providers to route through the sidecar. |
| `TLS_SIDECAR_PORT` | Optional | `9090` | Sidecar listen port. |
| `TLS_SIDECAR_BINARY_PATH` | Optional | `null` | Custom path to the compiled sidecar binary. Defaults to auto-discovery. |
| `TLS_SIDECAR_PROXY_URL` | Optional | `null` | Separate upstream proxy for the TLS sidecar (independent of `PROXY_URL`). |

### Session and Login Settings

| Key | Required | Default | Description |
|---|---|---|---|
| `LOGIN_EXPIRY` | Optional | `3600` | UI session expiry in seconds (default: 1 hour). |
| `LOGIN_MAX_ATTEMPTS` | Optional | `5` | Maximum failed login attempts before lockout. |
| `LOGIN_LOCKOUT_DURATION` | Optional | `1800` | Lockout duration in seconds (default: 30 minutes). |
| `LOGIN_MIN_INTERVAL` | Optional | `5000` | Minimum milliseconds between successive login attempts. |
| `TRUST_PROXY` | Optional | `false` | When `true`, trusts `X-Forwarded-For` headers from `TRUSTED_PROXY_IPS`. |
| `TRUSTED_PROXY_IPS` | Optional | `["127.0.0.1", "::1"]` | IP addresses allowed to supply `X-Forwarded-For`. |

### Token Refresh (OAuth Providers)

| Key | Required | Default | Description |
|---|---|---|---|
| `CRON_REFRESH_TOKEN` | Optional | `false` | Enables a background cron job that proactively refreshes OAuth tokens before expiry. |
| `CRON_NEAR_MINUTES` | Optional | `15` | How many minutes before token expiry to trigger a refresh. |

### Logging Settings

| Key | Required | Default | Description |
|---|---|---|---|
| `LOG_ENABLED` | Optional | `true` | Master switch for the structured logger. |
| `LOG_OUTPUT_MODE` | Optional | `"all"` | Where log output goes. `"all"` = both console and file. |
| `LOG_LEVEL` | Optional | `"info"` | Log verbosity: `"debug"`, `"info"`, `"warn"`, `"error"`. |
| `LOG_DIR` | Optional | `"logs"` | Directory for log file output (relative to the `Tier1-AIClient2API/` root). |
| `LOG_INCLUDE_REQUEST_ID` | Optional | `true` | Adds a request correlation ID to every log line. |
| `LOG_INCLUDE_TIMESTAMP` | Optional | `true` | Adds ISO timestamps to every log line. |
| `LOG_MAX_FILE_SIZE` | Optional | `10485760` | Maximum log file size in bytes before rotation (default: 10 MB). |
| `LOG_MAX_FILES` | Optional | `10` | Maximum number of rotated log files to retain. |

### Fallback Chain Settings

| Key | Required | Default | Description |
|---|---|---|---|
| `providerFallbackChain` | Optional | `{}` | Cross-provider fallback map. Keys are provider type strings; values are ordered arrays of fallback providers. Example: `{"gemini-cli-oauth": ["gemini-antigravity"]}`. |
| `modelFallbackMapping` | Optional | `{}` | Per-model cross-provider remapping. Maps a model ID to a `{targetProviderType, targetModel}` object for cases where a model is served by a different provider under a different name. |

### External File Paths

| Key | Required | Default | Description |
|---|---|---|---|
| `PROVIDER_POOLS_FILE_PATH` | Optional | `null` (runtime fallback applies the path) | Path to the provider pools credential file. **Contains live OAuth tokens — never commit.** |
| `CUSTOM_MODELS_FILE_PATH` | Optional | `null` (runtime fallback applies the path) | Path to the custom models definition file. Used by the `openai-custom` (OpenRouter) provider. |

### Model List Cache

The `/v1/models` endpoint response is cached in memory by `provider-pool-manager.js` for up to 30 seconds. The cache is auto-invalidated on any pool health change (account added, removed, or flagged as unhealthy) and also when `initializeProviderStatus()` runs (provider config reload). There is no configuration knob for this TTL — it is hardcoded in the pool manager source.

### Minimal Working Config

```json
{
    "REQUIRED_API_KEY": "your-strong-token-here",
    "SERVER_PORT": 3000,
    "HOST": "0.0.0.0",
    "MODEL_PROVIDER": "claude-kiro-oauth",
    "PROMPT_LOG_MODE": "none",
    "RATE_LIMIT_COOLDOWN_ENABLED": false,
    "SCHEDULED_HEALTH_CHECK": {
        "enabled": false,
        "interval": 600000,
        "startupRun": false
    },
    "UI_ENABLED": true,
    "LOG_ENABLED": true,
    "LOG_LEVEL": "info"
}
```

---

## Tier 1 — CLI Flags

All `config.json` keys can also be set via command-line flags when starting the process directly. Flags override the config file.

```bash
node src/core/master.js \
  --api-key your-token \
  --port 3000 \
  --model-provider claude-kiro-oauth \
  --log-prompts none \
  --rate-limit-cooldown-enabled false \
  --no-ui
```

| Flag | Config Key | Type |
|---|---|---|
| `--api-key` | `REQUIRED_API_KEY` | string |
| `--port` | `SERVER_PORT` | int |
| `--host` | `HOST` | string |
| `--model-provider` | `MODEL_PROVIDER` | string |
| `--log-prompts` | `PROMPT_LOG_MODE` | enum: `console`, `file`, `none` |
| `--system-prompt-file` | `SYSTEM_PROMPT_FILE_PATH` | string |
| `--system-prompt-mode` | `SYSTEM_PROMPT_MODE` | enum: `overwrite`, `append` |
| `--request-max-retries` | `REQUEST_MAX_RETRIES` | int |
| `--rate-limit-cooldown-enabled` | `RATE_LIMIT_COOLDOWN_ENABLED` | bool |
| `--rate-limit-cooldown-ms` | `RATE_LIMIT_COOLDOWN_MS` | int |
| `--rate-limit-cooldown-jitter-ms` | `RATE_LIMIT_COOLDOWN_JITTER_MS` | int |
| `--rate-limit-cooldown-max-ms` | `RATE_LIMIT_COOLDOWN_MAX_MS` | int |
| `--provider-pools-file` | `PROVIDER_POOLS_FILE_PATH` | string |
| `--custom-models-file` | `CUSTOM_MODELS_FILE_PATH` | string |
| `--max-error-count` | `MAX_ERROR_COUNT` | int |
| `--trust-proxy` | `TRUST_PROXY` | bool |
| `--trusted-proxy-ips` | `TRUSTED_PROXY_IPS` | comma-separated list |
| `--cron-refresh-token` | `CRON_REFRESH_TOKEN` | bool |
| `--cron-near-minutes` | `CRON_NEAR_MINUTES` | int |
| `--no-ui` | `UI_ENABLED` = false | flag |
| `--ui` | `UI_ENABLED` | bool |

---

## Tier 1 — Credentials Directory

**Path:** `Credentials/` (repo root)

Each provider has its own subdirectory. The credential file format differs per provider type; see each provider's adapter source for the expected schema.

| Directory | Provider | Auth Method |
|---|---|---|
| `Credentials/claude-kiro-oauth/` | Kiro (Amazon Q) | OAuth session tokens <!-- VERIFY: exact file names and schema --> |
| `Credentials/gemini-antigravity/` | Antigravity (Gemini) | Antigravity OAuth credentials |
| `Credentials/gemini-cli-oauth/` | Gemini CLI | Google OAuth tokens |
| `Credentials/github-models/` | GitHub Models | GitHub personal access token |
| `Credentials/nvidia-nim/` | NVIDIA NIM | NVIDIA API key <!-- VERIFY: exact env var or file name --> |
| `Credentials/openai-codex-oauth/` | OpenAI Codex | OAuth session tokens <!-- VERIFY: exact file names and schema --> |
| `Credentials/openai-custom/` | OpenRouter | OpenRouter API key |

**Important:** The live operational credential pools (with OAuth tokens for all rotating accounts) are in `Tier1-AIClient2API/configs/provider_pools.json`, not in `Credentials/`. The `Credentials/` directory holds the per-provider bootstrap credentials used during initial authentication or token refresh. `provider_pools.json` must never be committed to git.

---

## Tier 2 — LiteLLM Config File

**File:** `Tier2-LiteLLM/litellm_config.yaml`  
**Runtime:** Python 3.12.11, litellm 1.87.0, in `.venv/`

The LiteLLM config is the single configuration file for Tier 2. It defines the model catalog, routing behavior, retry policy, and SSE settings.

### Model Entries

Each model entry follows this pattern:

```yaml
- model_name: "<provider>:<model-id>"
  litellm_params:
    model: "openai/<provider>:<model-id>"
    api_base: "http://127.0.0.1:3000/v1"
    api_key: "os.environ/AICLIENT_TOKEN"
```

**Critical rules:**
- `model_name` is what callers (including Claude Code) send as the `model` field.
- `model` under `litellm_params` uses `openai/` prefix — this tells LiteLLM to use the OpenAI adapter and route to Tier 1's OpenAI-compatible endpoint, avoiding the `/v1/messages` path that does not exist in AIClient2API.
- The string after `openai/` must **exactly match** the provider adapter's internal model map in `Tier1-AIClient2API/src/providers/provider-models.js`. A mismatch causes silent 404s.
- `api_key` uses the `os.environ/` prefix so LiteLLM reads `AICLIENT_TOKEN` from the environment at runtime.

### Router Settings

Configured under `router_settings:` in `litellm_config.yaml`:

| Key | Value | Description |
|---|---|---|
| `routing_strategy` | `"usage-based-routing-v2"` | Routes to least-used model group. |
| `num_retries` | `3` | Retries before surfacing an error to the caller. |
| `retry_after` | `1` | Seconds to wait between retries. |
| `timeout` | `120` | Per-request timeout in seconds. |
| `allowed_fails` | `2` | Failures allowed before a model group is temporarily deprioritized. |
| `retry_policy.AuthenticationErrorRetries` | `0` | Auth errors (401) surface immediately — never retried. |
| `retry_policy.RateLimitErrorRetries` | `3` | 429s are retried up to 3 times. |
| `retry_policy.TimeoutErrorRetries` | `2` | Timeout errors get 2 retries. |
| `retry_policy.ServiceUnavailableErrorRetries` | `3` | 503s are retried up to 3 times. |

### Fallback Chains

Configured under `router_settings.fallbacks:` in `litellm_config.yaml`. These are LiteLLM-level fallbacks, independent of Tier 1's `providerFallbackChain`.

Rules enforced by configuration:
- Fallbacks only downgrade — Opus → Sonnet → Haiku. Never upgrade.
- Both versioned bare names (e.g., `claude-opus-4-7`) and generic aliases (e.g., `claude-opus`) have fallback entries. Versioned entries are required because Claude Code sends specific version strings for subagent and background tasks.
- GitHub Models fall back to NVIDIA NIM (larger context window, fewer 413s) then to `claude-haiku`.
- OpenRouter free-tier models (`openai-custom`) fall back to equivalent NVIDIA NIM models then `claude-haiku`.

### LiteLLM Settings

Configured under `litellm_settings:` in `litellm_config.yaml`:

| Key | Value | Description |
|---|---|---|
| `drop_params` | `false` | Preserve all request parameters — never silently strip tool schemas or nested params. Surface mismatches as errors rather than hiding them. |
| `set_verbose` | `false` | Disable LiteLLM verbose logging in production. |
| `stream_timeout` | `600` | SSE stream timeout in seconds (10 minutes — supports long agentic loops). |
| `request_timeout` | `600` | Total request timeout in seconds. Matches `stream_timeout` to prevent premature connection closes on long streaming responses. |
| `response_headers.X-Accel-Buffering` | `"no"` | Disables NGINX/proxy buffering on all responses. Required to prevent SSE chunk concatenation and JSON corruption during tool-use streaming. |

### General Settings

Configured under `general_settings:`:

| Key | Value | Description |
|---|---|---|
| `port` | `4000` | LiteLLM gateway listen port. |

**Note:** `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` is set as a shell environment variable in the `_ensure_gateways` function in `~/dotfiles/zsh/zshrc` — not in this config file.

---

## Tier 1 — Provider Pools File

**File:** `Tier1-AIClient2API/configs/provider_pools.json`  
**Example:** `Tier1-AIClient2API/configs/provider_pools.json.example`

This file holds the full list of rotating accounts for each provider. It is the live credential store — it contains active OAuth tokens, session cookies, and API keys for all accounts across all providers.

**Security rules:**
- `provider_pools.json` must never be staged with `git add -A` or `git add .`.
- Only commit it when explicitly instructed, and only via the GitHub Contents API (bypasses push protection).
- See the `aiclient-credentials` skill before modifying any account entry.

---

## Active Routing Mode

**Current operational mode:** `claude-proxy` sets `ANTHROPIC_BASE_URL=http://127.0.0.1:4000`, routing Claude Code CLI through Tier 2 (LiteLLM) before reaching Tier 1.

To switch between modes:
- `claude-proxy` — sets `ANTHROPIC_BASE_URL=http://127.0.0.1:4000` (via Tier 2 LiteLLM, the active path)
- To route directly to Tier 1, bypassing LiteLLM — manually set `ANTHROPIC_BASE_URL=http://127.0.0.1:3000` in the shell session

See `docs/Troubleshooting-and-Fixes.md` before changing the active routing path.

---

## Per-Environment Notes

There are no `.env.development`, `.env.staging`, or `.env.production` files in this repository. All environment-specific configuration is controlled by:

1. The shell functions in `~/dotfiles/zsh/zshrc` (`claude-proxy`, `claude-native`, `start-proxies`)
2. The `configs/config.json` file in Tier 1 (single file, no environment variants)
3. The `Tier2-LiteLLM/litellm_config.yaml` file (single file, no environment variants)

Production values (API keys, OAuth tokens) live exclusively in `configs/provider_pools.json` and the `Credentials/` directory — neither of which is committed with live credentials.
