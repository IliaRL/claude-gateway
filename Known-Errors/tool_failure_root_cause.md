# Tool-Use Failure in Proxy Mode — Root Cause Analysis

> **Scope:** Read-only investigation. No code has been changed.
> **Symptom:** When Claude Code is running through the proxy stack
> (`ANTHROPIC_BASE_URL=http://127.0.0.1:3000`), agents silently stop
> calling tools (MCP tools, built-in tools, subagents) or call far fewer
> tools than they should, even though the model is responding normally.

---

## 1. The Architectural Context

The active routing path (confirmed from `CLAUDE.md` line 126 and `settings.json` line 8):

```
Claude Code CLI
  → ANTHROPIC_BASE_URL = http://127.0.0.1:3000   ← Tier 1 only (Tier 2 bypassed)
  → AIClient2API (port 3000) — OpenAI format wire, Anthropic wrapper
  → External providers (Kiro, Antigravity, Gemini, Codex, …)
```

LiteLLM (port 4000) is running but **is not in the active Claude Code request path**.
The bypass happened to fix SSE stream corruption from LiteLLM re-wrapping chunks.

This single decision — pointing `ANTHROPIC_BASE_URL` at `:3000` (Tier 1) instead of
`:4000` (Tier 2) — is the root trigger for every tool-use failure below.

---

## 2. Root Cause #1 — Tool Search Auto-Disabled by Proxy URL

### What happens

Claude Code has a built-in security guard documented in the official gateway spec
(`docs/Architectural Routing and Proxy Integration for Claude Code Functionality.md`,
section "Advanced Tool Discovery and Context Window Management", paragraph 3):

> *By default, the internal security logic of Claude Code dictates that if the
> `ANTHROPIC_BASE_URL` environment variable is configured to point to any
> non-first-party proxy host, the application automatically and silently disables
> the tool search feature.*

"Tool Search" is the mechanism that suppresses all MCP tool definitions from the
context window and instead loads tools on-demand based on semantic relevance.
When it is **disabled**, Claude Code reverts to the legacy behaviour: it force-loads
**every single MCP tool definition** into the context window at the start of every
turn.

### Why this breaks tool use

The user's `settings.json` enables a large plugin ecosystem
(22 plugins: `context7`, `playwright`, `github`, `linear`, `sentry`, `aikido`,
`ai-devkit`, `supabase`, `data-agent-kit-starter-pack`, etc.) plus 6 project-scoped
MCP servers (`.mcp.json`). With Tool Search disabled, all their definitions hit the
context window simultaneously — potentially 20-50 % of the total token budget
before the first user message is even seen.

Results observed in this failure mode:
- Agent reasoning is truncated because the context window is already heavily occupied.
- Older tool results and conversation history get evicted, causing the agent to lose
  track of what it was doing.
- Claude stops calling tools mid-task not because tools are broken, but because it
  has run out of context space to formulate the tool call.
- The CLI may return "context length exceeded" errors or silently degrade.

### Where the attempted fix lives — and why it is insufficient

`settings.json` line 12:
```json
"ENABLE_TOOL_SEARCH": "true"
```

`zshrc` lines 322 and 340:
```bash
ENABLE_TOOL_SEARCH=true claude --model "$MODEL"
```

The official routing spec (`docs/Architectural Routing and Proxy Integration …`,
section "Advanced Tool Discovery", last paragraph) explicitly warns:

> *Due to initialization sequence complexities, this specific variable must be exported
> directly into the command-line execution environment; placing it inside the persistent
> settings configuration file frequently fails to apply the necessary overrides.*

This is the exact scenario here. The variable **is in `settings.json`** but that
placement is documented to be unreliable for this particular override. The zshrc
call-site injection (`ENABLE_TOOL_SEARCH=true claude …`) is the correct approach, but
only applies when `claude-pick` or `claude-swap` launches the session. Any subsequent
`claude --continue`, `claude --resume`, subagent spawning, or sessions opened from
an IDE do **not** inherit this inline env injection — they pick up only the
`settings.json` env block, which is the unreliable path.

**Net effect:** Tool Search is unreliably enabled. In some launch paths it works; in
others (especially subagents and IDE-launched sessions) the proxy URL guard wins and
Tool Search is silently off.

---

## 3. Root Cause #2 — `anthropic-beta` Header Stripping by AIClient2API

### What the spec requires

`docs/ANTHROPIC_GATEWAY_SPEC.md` lines 26-33 (official Anthropic spec):

> *The gateway must forward request headers: `anthropic-beta`, `anthropic-version`*
>
> *Failure to forward headers or preserve body fields may result in reduced
> functionality or inability to use Claude Code features.*

`docs/Architectural Routing and Proxy Integration …`, section "Gateway API Compliance":

> *Claude Code relies continuously on experimental, versioned, and beta-tier features
> to execute complex autonomous tasks. The proxy infrastructure must accurately forward
> specific client headers to the upstream provider verbatim, without dropping,
> sanitizing, or mutating them. The `anthropic-beta` header … serves as the key to
> unlocking the framework's most advanced capabilities, including computer use
> protocols, streaming schemas, prompt caching, and the extended thinking algorithms.*

### What AIClient2API is doing

AIClient2API is designed as an OpenAI-format adapter. Its primary job is to translate
Claude Code's Anthropic-format requests into the native API calls each provider
expects (OpenAI format, Gemini format, etc.). Crucially, the proxy does the following:

- Receives an Anthropic `/v1/messages` request.
- Translates it into OpenAI `/v1/chat/completions` or provider-native format.
- Forwards it to the provider.

During this translation, `anthropic-beta` header values (e.g.
`tools-2024-04-04`, `prompt-caching-2024-07-31`, `interleaved-thinking-2025-05-14`,
`computer-use-2024-10-22`) are **Anthropic-specific headers that have no meaning
in the translated OpenAI-format call** going downstream. Whether AIClient2API
strips them or forwards them depends on whether each provider adapter's code
explicitly preserves them.

For providers like Kiro (which IS a real Claude endpoint), the anthropic-beta headers
should be forwarded. For Gemini/Antigravity/Codex (which are NOT Anthropic-native),
they must be stripped before forwarding but then the Anthropic-format response coming
back must still include the correct capability markers. If the headers are stripped
without re-injecting the expected beta capability responses, Claude Code's internal
state machine doesn't "unlock" the advanced tool-use modes.

### The resulting tool-use failure

Without the `tools-2024-04-04` beta being correctly processed end-to-end:
- Claude Code's tool-use streaming schema may not activate.
- Cache-control metadata (`prompt-caching-2024-07-31`) gets dropped, causing every
  turn to re-process the full system prompt and all tool definitions at full cost and
  latency.
- Extended thinking (`interleaved-thinking-2025-05-14`) does not engage for
  "Thinking" model variants even when explicitly requested.

---

## 4. Root Cause #3 — OpenAI-to-Anthropic Tool Schema Translation Errors

### The structural problem

`docs/Architectural Routing and Proxy Integration …`, section "Protocol Translation
and Schema Mapping Architectures" (lines 49–52) describes this as a known failure
class:

> *The structural mismatch in tool calling is the primary source of failure. …
> The most destructive issue involves empty tool name duplication during asynchronous
> streaming. OpenAI-compatible streaming endpoints often broadcast tool calls across
> multiple network frames where the initial delta contains the function name, but
> subsequent argument deltas transmit empty name fields. Poorly configured or
> rudimentary proxy translators misinterpret these subsequent empty fields as entirely
> new, distinct tool events. Consequently, the proxy emits multiple Anthropic content
> block start events populated with empty tool names. This structurally invalidates
> the payload schema, instantly crashing Claude Code's internal tool execution engine
> and halting the agentic loop.*

### How this applies to the current stack

The flow is:
```
Claude Code (Anthropic tool schema)
  → AIClient2API (translates to OpenAI tool schema)
  → Provider returns OpenAI-format tool call response (streamed)
  → AIClient2API translates back to Anthropic format
  → Claude Code receives Anthropic-format tool use block
```

The translation layer in `src/converters/` (Tier 1) does this round-trip. The bug
manifests specifically when:
1. A provider streams tool call responses across multiple chunks.
2. The converter in `src/converters/` emits `content_block_start` with `type: "tool_use"`
   on the first chunk (correct), but then emits additional `content_block_start` events
   on subsequent empty-name chunks (incorrect).
3. Claude Code's SSE parser encounters tool events with empty `name` fields and
   either crashes the tool loop silently or ignores subsequent tool calls in that turn.

This is specifically the `src/converters/` / `src/convert/` code path identified in
`CLAUDE.md` line 71:
> *Most LiteLLM-related format errors originate here.*

---

## 5. Root Cause #4 — `drop_params: true` in LiteLLM Destroying Tool Metadata

### The paradox

Even though LiteLLM is currently bypassed from the active Claude Code path, it still
exists in the architecture. More importantly, the LiteLLM config (`CLAUDE.md` line 102)
shows:

```yaml
litellm_settings:
  drop_params: true
```

The official LiteLLM best-practices doc (`docs/LiteLLM BP.md`, line 185) explains:

> *`drop_params: True`: strips provider-specific params from responses to maintain
> OpenAI format; useful for compatibility with OpenAI-expecting clients like Claude Code.*

But the routing spec (`docs/Architectural Routing …`, lines 51–52) identifies the
catastrophic cost:

> *Translation layers that are heavily focused on basic cross-compatibility blindly
> drop these Anthropic-specific metadata tags during the payload conversion process.
> Consequently, the translation layer unintentionally obliterates prompt caching
> efficiency, resulting in significantly higher financial expenditures and exponentially
> slower inference times.*

`cache_control` blocks on tool definitions and system prompts are Anthropic-specific
fields. With `drop_params: true`, LiteLLM strips them. This means:
- Every tool definition costs full token-processing on every turn.
- Every system prompt costs full token-processing on every turn.
- Context window fills up faster because cached segments aren't being reused.

This makes Root Cause #1 (context bloat) significantly worse whenever a session
does route through LiteLLM (e.g. when restoring the full two-tier path).

---

## 6. Root Cause #5 — `ANTHROPIC_BASE_URL` in `settings.json` Bypasses Tier 2

### The critical CLAUDE.md note

`CLAUDE.md` line 126 (the operational mode note):

> *Current operational mode: `claude-proxy` sets `ANTHROPIC_BASE_URL=http://127.0.0.1:3000`,
> routing Claude Code directly to Tier 1. LiteLLM (`:4000`) still runs and is healthy,
> but is not in the active Claude Code request path — it was bypassed to eliminate SSE
> stream corruption caused by LiteLLM re-wrapping streaming chunks.*

### Why this compounds everything

`settings.json` line 8 permanently sets:
```json
"ANTHROPIC_BASE_URL": "http://127.0.0.1:3000"
```

This means **all** Claude Code sessions — including IDE sessions, subagents, `--continue`,
`--resume`, and non-interactive agent calls — point at Tier 1 directly. None of them
go through LiteLLM's `fallbacks`, `num_retries`, or `context_window_fallbacks`.

The consequence:
- Tier 2's Level 3 fallback (tiered model downgrade) never triggers.
- Tier 2's silent retry on 429/500/502 never triggers.
- Every session is exposed to raw provider errors with no shock-absorber.
- Every session is one hop closer to the providers where schema translation bugs
  (Root Cause #3) are most likely to manifest.

The SSE buffering problem that caused the bypass is a separate, solvable issue.
By permanently routing at `:3000`, the architecture trades a streaming cosmetic bug
for structural agentic reliability losses.

---

## 7. Summary Table

| # | Root Cause | Trigger | Effect on Tool Use |
|---|---|---|---|
| 1 | Tool Search silently disabled | Any non-`api.anthropic.com` `ANTHROPIC_BASE_URL` | Context window exhausted by bulk tool definitions; agent stops calling tools |
| 2 | `anthropic-beta` headers not reliably forwarded | OpenAI-format translation in AIClient2API | Tool-use schema, caching, thinking modes don't activate |
| 3 | Empty tool name in streaming chunks | Round-trip OpenAI ↔ Anthropic translation | Tool execution engine crashes silently; agentic loop halts |
| 4 | `drop_params: true` strips `cache_control` | LiteLLM translation layer | Context window fills faster; cache miss on every turn |
| 5 | `ANTHROPIC_BASE_URL` hardcoded to `:3000` | `settings.json` env block | All sessions bypass Tier 2 retry/fallback; raw provider errors reach agent |

---

## 8. Precise Fix Plan (No Code Changes Made)

### Fix 1 — Ensure `ENABLE_TOOL_SEARCH=true` is truly environment-level for every session path

**Problem:** `settings.json` placement is documented as unreliable for this variable.

**Required change (settings.json only):**
The env block already has `"ENABLE_TOOL_SEARCH": "true"`. Per the official spec caveat,
this must *also* be set as a true shell export that survives subshell and subagent
spawning. The current `zshrc` injection only works for `claude-pick`/`claude-swap` launch.

**Fix:** Export `ENABLE_TOOL_SEARCH=true` as a **global** shell export in `zshrc`
(alongside the other `AICLIENT_*` exports), not inline-only at `claude-pick` call sites.
This ensures it is always present in any child process, subagent, or IDE-launched shell.

---

### Fix 2 — Re-route Claude Code through LiteLLM (`:4000`) and fix the SSE buffering

**Problem:** The bypass of Tier 2 was done to fix SSE stream corruption. That fix
removed the shock-absorber and re-exposed all tool-schema translation issues to
Claude Code directly.

**Required change:**
Restore `ANTHROPIC_BASE_URL=http://127.0.0.1:4000` in `settings.json`. The SSE buffering
issue in LiteLLM must be resolved separately at the LiteLLM config level with
`X-Accel-Buffering: no` header injection or by configuring `stream_timeout` properly —
not by bypassing Tier 2 entirely.

---

### Fix 3 — Verify and fix `anthropic-beta` header pass-through in AIClient2API

**Target files:** `Tier1-AIClient2API/src/handlers/request-handler.js` and
the provider adapters in `src/providers/claude/`.

**Required audit (no changes yet):**
For Kiro (`claude-kiro-oauth`) — a real Anthropic-backed endpoint — the
`anthropic-beta` and `anthropic-version` headers MUST be forwarded verbatim to the
upstream. Verify the request-handler does not strip them before forwarding.

For non-Anthropic providers (Gemini, Codex, etc.), beta headers must be stripped
before the outgoing call, but the response translator must still synthesize the
correct Anthropic-format response blocks (including `cache_control` metadata).

---

### Fix 4 — Remove or scope `drop_params: true` in LiteLLM config

**Target file:** `Tier2-LiteLLM/litellm_config.yaml`

**Required change:**
`drop_params: true` must be removed or replaced with a provider-specific exclusion
list that preserves `cache_control`, `anthropic-beta`, and `anthropic-version` fields.

The correct setting is `drop_params: false` with explicit `litellm_settings.allowed_params`
if needed, OR using LiteLLM's pass-through Anthropic endpoint mode so these fields
are never touched.

---

### Fix 5 — Fix the empty-tool-name streaming bug in AIClient2API converters

**Target files:** `Tier1-AIClient2API/src/converters/` and `src/convert/`

**Required audit:**
Inspect the streaming response translation path. Specifically: when an OpenAI
streaming chunk arrives with a `tool_calls` delta that has an empty `function.name`
(subsequent argument chunk), the converter must NOT emit a new `content_block_start`
event. It must accumulate the delta into the already-open tool block.

The fix is to track open tool-call blocks by `index` and only emit
`content_block_start` once per `index`, emitting `content_block_delta` for all
subsequent chunks with the same index regardless of whether `name` is empty.

---

## 9. Priority Order

| Priority | Fix | Why First |
|---|---|---|
| 🔴 P0 | Fix 2 (restore Tier 2 routing + fix SSE) | Structural; all other fixes are less effective while Tool Search is unreliably engaged |
| 🔴 P0 | Fix 1 (global `ENABLE_TOOL_SEARCH` export) | Quick; closes the most immediate failure path with minimal risk |
| 🟠 P1 | Fix 5 (empty-tool-name streaming bug) | Causes hard crashes in agentic loops; must be fixed before tool-heavy tasks |
| 🟠 P1 | Fix 3 (beta header pass-through audit) | Required for thinking models and caching to work correctly |
| 🟡 P2 | Fix 4 (`drop_params` removal) | Important for cost and context efficiency; lower urgency than crashes |

---

## 10. Verification Approach (After Fixes)

Once fixes are applied, verify with the following sequence:

1. Run `proxy-status` — confirm both `:3000` and `:4000` healthy.
2. Launch Claude via `claude-pick` → select any Claude model.
3. Inside session, run `/tools` (or equivalent diagnostic) — confirm output shows
   "MCP tools: loaded on-demand" (not a static token count).
4. Trigger a tool-heavy task (e.g. ask for a file search + web search combo).
5. Observe that tools are called sequentially without the agent stalling.
6. Run `proxy-repair` skill for a full automated diagnostic.
