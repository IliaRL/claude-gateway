# AIClient2API Perfection Plan — 2026-05-16

## Original Goal

Optimize the AIClient2API proxy for 100% Claude Code CLI compatibility by:
1. Modularizing CLAUDE.md into a lean decision-making guide with routed reference docs
2. Replacing hard-coded tool-use flattening with a schema-aware dynamic system
3. Enriching the IDE status line with per-model context window and token limit data
4. Adding model-aware defaults to converters (replacing flat fallback values)

Session that initiated this work: `eaeac44d-6dd5-4ec2-9dde-ebaf6c37e255`

---

## What Was Implemented (Original Session)

### Task 1 — CLAUDE.md Modularization ✅
- CLAUDE.md slimmed from ~280 lines to 33 lines
- Detailed content extracted to:
  - `docs/ARCHITECT_REFERENCE.md` — architecture, file map, error propagation
  - `docs/DEBUGGING.md` — 3-signal triage, error lookup table, tool-use diagnosis
  - `docs/MAINTENANCE.md` — upstream merge workflow, customization inventory
- CLAUDE.md retains only: Non-Negotiable Rules, Reference Docs links, Quick Commands, Implicit Learning

### Task 2 — Dynamic Tool-Use Schema Guards ✅
- `src/converters/utils.js`: Added `ToolStateManager` class and `toolStateManager` singleton
- `src/converters/utils.js`: Added `dynamicFlattenToolArguments(toolName, input, schema)` — schema-aware replacement for the old `flattenToolArguments` (hard-coded Set of known tool names)
- `ClaudeConverter.js` and `OpenAIConverter.js`: Switched to `dynamicFlattenToolArguments`; both now call `toolStateManager.storeToolSchema()` on every inbound tool definition so response flattening has schema context
- Bug fixed: `ClaudeConverter.toOpenAIRequest()` now accepts `targetProtocol` param — required for enabling `strict: true` on NVIDIA/GitHub tool definitions

### Task 3 — Per-Model Token Limits & Status Line Enrichment ✅
- `src/converters/utils.js`: Added `MODEL_MAX_OUTPUT_TOKENS` table (all 45 models) and `MODEL_CONTEXT_WINDOWS` table (all 45 models); added `getModelMaxOutputTokens()` helper
- `ClaudeConverter.js`: Uses `getModelMaxOutputTokens()` for per-model `max_tokens` defaults (replaces flat `OPENAI_DEFAULT_MAX_TOKENS`)
- `OpenAIConverter.js`: `buildGeminiGenerationConfig()` uses `getModelMaxOutputTokens()` for Gemini targets
- `src/utils/common.js`: `updateLastModelFile()` now writes JSON `{model, maxOutput, contextWindow}` instead of plain model name string — powers IDE status line with per-model context window display
- `scripts/claude-mode.sh`: Added `PROXY_CLI_MODEL`/`NATIVE_CLI_MODEL` variables; proxy-on mode saves and restores the CLI `model` setting in `~/.claude/settings.json`
- `src/providers/gemini/antigravity-core.js`: Clarified comment on why non-Claude Antigravity models must drop `maxOutputTokens`

### Commit
`40a0627` on branch `my-v3.0.7`

---

## Why the Original Session Crashed

Error: `API Error: 400 messages.3.content.0.tool_use.signature: Extra inputs are not permitted`

Root cause: The session was using `gemini-2.5-flash` (via the AIClient2API proxy) as the Claude Code orchestrator model. When Claude Code dispatched a subagent using the Agent tool, it generated a `tool_use` block with an Anthropic-specific `signature` field. The Gemini model (acting as Claude) produced a response that had extra/invalid properties in that signature field. On the next message, the Anthropic API validated the conversation history and rejected it.

This is a permanent session corruption — the session cannot be resumed once this error occurs.

**Lesson:** Always use a native Claude model (not a proxy-routed Gemini model) as the orchestrator when dispatching subagents that use the Agent tool. The Agent tool generates tool_use blocks with Anthropic-specific signature fields that only Claude can produce correctly.

---

## What Was Completed (Follow-Up Session — 2026-05-16)

### Task A — CLAUDE.md Expansion ✅
Expanded from 33 lines to ~130-150 lines. Added sections:
- "What This Proxy Is & Success Criteria" — operational definition of success/failure
- "AI Behavior Guidance" — 4 rules for reasoning before acting
- "Session Protocol & Handoff Rules" — selective handoff criteria and format
- "Commit & Code Safety Rules" — explicit commit discipline
- "Documentation Routing" — table routing tasks to the correct doc

### Task B — claude-mode.sh Antigravity Settings Sync ✅
- Added `ANTIGRAVITY_SETTINGS_FILE` variable (env-overrideable, defaults to known Antigravity profile path)
- Proxy-on and proxy-off now also update `claude.model` in Antigravity IDE settings.json
- Fixes: native mode was leaving `claude.model: gemini-claude-sonnet-4-6` in Antigravity settings, so the IDE kept using the proxy model even after switching to native

### Task C — :free Suffix Context Window Fix ✅
- `src/utils/common.js` `updateLastModelFile()`: now strips OpenRouter variant suffixes (`:free`, `:nitro`, `:beta`) before looking up `MODEL_CONTEXT_WINDOWS` and `MODEL_MAX_OUTPUT_TOKENS`
- Fixes: `openai/gpt-oss-120b:free` was resolving to wrong contextWindow (200000 instead of 128000)

### Task D — This Plan File ✅
Created `docs/superpowers/plans/2026-05-16-aiclient-perfection.md`

---

## System State After Both Sessions

- **45 models**, 7 providers: 6 gemini-cli + 5 antigravity + 10 NIM + 6 OpenRouter + 10 GitHub + 5 Codex + 3 Kiro
- **30/32 healthy** (2 gemini-cli on 429 cooldown, auto-recovers)
- **Tool use ✅** on all providers (verified with get_weather test)
- **Status line** shows correct per-model context windows for all 45 models including :free suffix variants
- **Mode switching** syncs both `~/.claude/settings.json` and Antigravity IDE settings atomically
