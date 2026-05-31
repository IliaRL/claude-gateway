---
last_mapped_commit: $(git rev-parse HEAD)
---
# Architecture (2026-05-31)

## System Overview
AIClient2API is a 2-tier AI proxy gateway. It intercepts Anthropic-native CLI commands (`/v1/messages`), applies configuration-driven routing, and maps requests to external API providers.

## Core Processes
1. **Master Process (`src/core/master.js`)**: 
   - Runs on port 3100 (if active).
   - Manages child process lifecycles, IPC communication, and daemon monitoring.
2. **Worker Process (`src/services/api-server.js`)**:
   - Runs on port 3000.
   - Hosts the primary HTTP server and handles live API traffic.
   - Dynamically pre-warms connections via `setImmediate` and performs preflight health checks (`src/services/preflight-health.js`).

## Request Flow
1. **Ingress**: `src/handlers/request-handler.js` receives `POST /v1/messages` (Claude native) or `/v1/chat/completions` (OpenAI).
2. **Translation**: Handlers use the `src/converters/` logic to coerce inputs from Claude/OpenAI specifications into the format required by the target provider.
3. **Routing/Pool Management**: `src/providers/provider-pool-manager.js` assigns an active credential from the provider pool, performing rotation and tracking L1/L2/L3 fallback sequences if a provider returns HTTP 429 or 503.
4. **Adapter Execution**: Specific adapters inside `src/providers/` (e.g., `claude/claude-kiro.js`) construct the HTTP request using `axios` or native fetch/SDKs and return SSE streams directly.
5. **Egress**: Streams are piped back cleanly to the client without aggressive re-buffering (preventing latency spikes).

## State Management
- **Runtime Pool**: `provider-pool-manager.js` maintains transient health state, rotating tokens on rate limits.
- **SQLite Database**: `cockpit.db` tracks consumption metrics and issues synchronized penalty scores (`src/utils/cockpit-quota.js`) to limit abuse across restarts.
- **In-Memory Caching**: `response-cache.js` caches deterministic non-streaming endpoints (e.g., `/v1/models`) for 30s.

## Recent Capabilities
- **HealthGuard**: Built into `scripts/safe-restart.sh` and `src/utils/health-guard.js`, automatically pulsing and verifying API sanity paths before the gateway fully binds.
