# Coding Conventions

## Core Rules
1. **Never mutate Tier 2 directly**: The `.venv` is managed exclusively via `uv sync`.
2. **CPU Safety**: Sequential startup enforced (`safereset`). Tier 1 must be healthy before Tier 2 starts to avoid LiteLLM health-check floods.
3. **Model ID Strictness**: Provider model strings in Tier 1 (`src/providers/provider-models.js`) must *exactly* match the `model:` values in LiteLLM config.

## Tier 1 (Node)
- Model mappings are centralized per-provider.
- Provider fallback chains are strictly defined (Vertical -> Horizontal -> Tier Downgrade).
