# Technology Stack

## Tier 1 (AIClient2API)
- **Runtime**: Node.js (v20.19.6 via nvm)
- **Package Manager**: pnpm (explicitly mandated, no npm install)
- **Core Frameworks**: Express.js (inferred from common node API setups, or plain http)
- **Key Dependencies**: Axios/node-fetch (for provider communication)
- **Testing**: vitest or jest (pnpm run test)

## Tier 2 (LiteLLM)
- **Runtime**: Python 3.12.11 (via uv)
- **Package Manager**: uv (`uv sync`)
- **Core Frameworks**: FastAPI (underlying LiteLLM proxy)
- **Key Dependencies**: litellm 1.87.0

## Tier 3 (Shell)
- **Environment**: ZSH
- **Key Tooling**: `claude-pick`, `claude-swap`, `start-proxies` functions
