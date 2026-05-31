---
last_mapped_commit: $(git rev-parse HEAD)
---
# Directory Structure (2026-05-31)

## `/` (Root)
- `README.md`, `CLAUDE.md`, `.mcp.json` — High-level configuration and agent memory for the `MASTER-C` tree.

## `/Credentials`
- Git-ignored directories holding static keys and dynamic OAuth tokens (`oauth_creds.json`) grouped by provider (e.g., `claude-kiro-oauth`, `gemini-cli-oauth`).

## `/docs`
- Contains deep architectural specs, troubleshooting guides, testing protocols, and historical context.

## `/AIClient2API`
The primary Tier 1 Node.js gateway application.

### `/AIClient2API/configs`
- **`config.json`**: Primary system configuration (ports, fallbacks, retry parameters).
- **`provider_pools.json`**: Backing file mapping tokens/directories to specific models and pools.
- **`model-catalog.json`**: Central catalog mapping API strings to specific underlying providers.

### `/AIClient2API/src`
- **`/auth`**: Identity resolution, key validation, and OAuth token refreshes.
- **`/convert` & `/converters`**: Schema transformation logic (Claude API → Gemini, OpenAI → Claude, etc.).
- **`/core`**: Master process daemon logic, configuration loading (`config-manager.js`), and plugin systems.
- **`/handlers`**: The Express-like routing logic that binds HTTP endpoints to specific actions.
- **`/providers`**: Provider-specific adapter logic. Contains `provider-models.js` which is the absolute source of truth for routing.
- **`/scripts`**: Helper scripts for the app, including testing drivers (`unified-test-suite.cjs`).
- **`/services`**: Orchestrates `api-server.js` (Worker) and background monitoring (preflight).
- **`/utils`**: Common logic for database interaction (`db.js`), logging (`logger.js`), and rate-limit parsing.

### `/AIClient2API/scripts`
- Shell deployment scripts, notably `safe-restart.sh` (includes jetsam memory bounds checking) and `claude-mode.sh` (which configures the ZSH Tier 2 router).
