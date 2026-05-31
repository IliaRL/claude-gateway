---
last_mapped_commit: $(git rev-parse HEAD)
---
# Conventions (2026-05-31)

## Linting & Formatting
- **Zero-Dependency Linting**: The codebase utilizes a custom, lightweight syntax linter at `scripts/lint.cjs`. It recurses the source tree (skipping `node_modules` strictly to respect CPU/RAM rules) and runs `node --check` against every JavaScript file, then validates JSON structural integrity.
- **ES Modules**: JavaScript files must use `.js` with `"type": "module"` in `package.json`, or explicitly use `.mjs`/`.cjs` for specific contexts.

## Architecture Patterns
- **No Globbing Hot-Paths**: Code must never traverse massive directories dynamically at runtime (especially `AIClient2API/`) to avoid jetsam memory thrashing on macOS. 
- **Graceful Startup**: Processes should utilize `setImmediate` to perform asynchronous pre-warming of OAuth credentials during boot without blocking the main event loop.
- **Fail Fast / Validate Early**: External provider inputs are scrubbed early. The `/v1/messages` endpoint explicitly rejects mismatches between requested model IDs and internally configured provider strings.

## Error Handling
- **Non-Throwing Streams**: Streaming endpoints handle adapter errors natively and coerce them into structured Server-Sent Event (SSE) error payloads rather than hard-crashing the process.
- **Reactive Refresh**: Adapters attempting to use OAuth tokens catch HTTP 401 Unauthorized errors and force a synchronous token refresh pool rotation before retrying the exact request.

## Security
- Tokens are injected exclusively via the gateway's unified pool (`configs/provider_pools.json`) mapped against `Credentials/`.
- Access to the Tier 1 gateway requires matching the `AICLIENT_TOKEN` Bearer header defined in `configs/config.json`.
