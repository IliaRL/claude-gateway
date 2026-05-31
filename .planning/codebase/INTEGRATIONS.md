---
last_mapped_commit: $(git rev-parse HEAD)
---
# Integrations (2026-05-31)

## AI Model Providers
The gateway (Tier 1) connects to the following external APIs:
- **Anthropic / Kiro**: Native integration.
- **Google Antigravity / Gemini CLI**: Uses `google-auth-library` and REST endpoints.
- **OpenAI / Codex**: Uses the official `openai` SDK and `axios`.
- **OpenRouter / OpenAI-Custom**: Handled via standard OpenAI-compatible REST endpoints.
- **NVIDIA NIM / GitHub Models**: Integrated through OpenAI-compatible converters.

## Local Persistence
- **SQLite DB**: Local `.db` files (`pool_state.db`, `cockpit.db`) used for tracking quota exhaustion, request traces, and fallback health.

## Infrastructure Hooks
- **Tier 2 Interop**: Shell hooks in `~/dotfiles/zsh/zshrc` dynamically inject `ANTHROPIC_BASE_URL` to route the `claude` CLI through this gateway on port 3000.
