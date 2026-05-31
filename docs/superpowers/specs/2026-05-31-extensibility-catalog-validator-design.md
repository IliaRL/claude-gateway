# Spec C: Extensibility & Modularity — Model Catalog + Response Validator

## Overview

This spec has two parts that solve opposite sides of the same problem:

- **Part 1 — Model Catalog:** Reduces the cost of *adding* a model from a
  3-file edit requiring JS knowledge to a single JSON entry requiring nothing
  but the model's metadata.

- **Part 2 — Response Validator:** Detects when a non-Claude model produces
  output that *silently* violates Anthropic's wire protocol before it reaches
  Claude Code — catching the problem at the converter layer instead of letting
  it propagate as a mysterious client-side failure.

**Problem being solved:** Adding a model today requires editing `provider-models.js`
(JS arrays), `configs/config.json` (fallback chain), and sometimes `converters/utils.js`
(context window map). Non-Claude models (DeepSeek, NIM, GitHub Models) can return
malformed responses — missing `usage` blocks, wrong `stop_reason` values, null
`content` arrays — that pass through the converter silently and break Claude Code
in confusing ways.

---

## Architecture

```
configs/model-catalog.json                       ← new: single source of truth
src/providers/provider-models.js                 ← refactor: thin catalog loader
src/converters/utils.js                          ← refactor: MODEL_CONTEXT_WINDOWS
                                                    auto-generated from catalog

src/utils/response-validator.js                  ← new: pure JS, no new deps
src/converters/strategies/ClaudeConverter.js     ← extend: call validateAndRepair()
src/converters/strategies/GeminiConverter.js     ← extend: call validateAndRepair()
src/converters/strategies/OpenAIConverter.js     ← extend: call validateAndRepair()

tests/providers/model-catalog.test.js            ← new
tests/utils/response-validator.test.js           ← new
```

---

## Part 1: Model Catalog

### Catalog Entry Schema (`configs/model-catalog.json`)

```json
[
  {
    "id": "claude-sonnet-4-5-20250929",
    "displayName": "Claude Sonnet 4.5",
    "provider": "claude-kiro-oauth",
    "contextWindow": 200000,
    "maxOutput": 64000,
    "fallbackTarget": "claude-haiku-4-5-20251001",
    "converterStrategy": "claude",
    "tags": ["claude", "flagship"]
  },
  {
    "id": "gemini-3-flash",
    "displayName": "Gemini 3 Flash",
    "provider": "gemini-antigravity",
    "contextWindow": 1000000,
    "maxOutput": 65536,
    "fallbackTarget": null,
    "converterStrategy": "gemini",
    "tags": ["gemini", "fast"]
  }
]
```

**Fields:**

| Field | Required | Description |
|---|---|---|
| `id` | ✅ | Exact model ID used in requests (must be versioned) |
| `displayName` | ✅ | Human-readable name for `/v1/models` catalog output |
| `provider` | ✅ | Provider key matching `MODEL_PROVIDER` constant |
| `contextWindow` | ✅ | Context window in tokens |
| `maxOutput` | ✅ | Max output tokens |
| `fallbackTarget` | — | Next model ID in fallback chain; null = no fallback |
| `converterStrategy` | ✅ | `"claude"` / `"gemini"` / `"openai"` — selects converter. Note: `"openai"` is shared by `openai-custom`, `nvidia-nim`, and `github-models` — multiple providers can share a strategy |
| `tags` | — | Optional grouping tags for filtering |

### What `provider-models.js` Becomes

A thin loader that reads the catalog and re-exports the same interface callers
already depend on. **No callers change:**

```javascript
// Before: 400+ lines of hardcoded arrays
// After: thin loader
// Note: Node 20.19 supports `with { type: 'json' }` (replaces deprecated `assert`)
import catalog from '../../configs/model-catalog.json' with { type: 'json' };

export const MODEL_CONTEXT_WINDOWS = Object.fromEntries(
  catalog.map(m => [m.id, m.contextWindow])
);

export const MODEL_MAX_OUTPUT_TOKENS = Object.fromEntries(
  catalog.map(m => [m.id, m.maxOutput])
);

export function getProviderModels(providerType) {
  return catalog
    .filter(m => m.provider === providerType)
    .map(m => m.id);
}
// ... rest of existing exported functions, same signatures
```

`converters/utils.js` imports `MODEL_CONTEXT_WINDOWS` from `provider-models.js`
as it does today — the only change is the data source.

### Adding a Model in the Future

Before this spec:
1. Edit `provider-models.js` → add ID to the correct provider array
2. Edit `converters/utils.js` → add entry to `MODEL_CONTEXT_WINDOWS` and `MODEL_MAX_OUTPUT_TOKENS`
3. Edit `configs/config.json` → add fallback chain entry

After this spec:
1. Add one JSON object to `configs/model-catalog.json`

No JS editing required. The fallback chain is derived from `fallbackTarget` fields
at startup rather than duplicated in `config.json`. Existing `modelFallbackMapping`
in `config.json` is preserved as an override layer for non-standard fallback
configurations — the catalog provides sensible defaults, config overrides specific cases.

---

## Part 2: Response Validator

### Design Philosophy: Warn-and-Repair, Not Hard Block

The validator runs **after** converter output but **before** flushing to Claude Code.
It does not return errors. It:
1. Detects schema violations
2. Auto-repairs known fixable cases
3. Logs every violation with full context
4. Passes the (possibly repaired) response through

Hard-blocking would cause user-visible failures that are worse than the original
malformed response. Warn-and-repair means violations are always surfaced in logs
and traces, but Claude Code keeps working.

### Validation Rules

Based on Anthropic's `/v1/messages` response wire protocol:

```
content       → must be Array (not null, not string, not undefined)
content[*]    → each block must have a `type` field
stop_reason   → must be one of: end_turn | max_tokens | tool_use | stop_sequence
usage         → must be object with input_tokens: number, output_tokens: number
```

### Auto-Repair Table

| Violation | Auto-Repair | Log Level |
|---|---|---|
| `usage` is missing | Inject `{input_tokens: 0, output_tokens: 0}` | WARN |
| `usage.input_tokens` is NaN | Replace with 0 | WARN |
| `stop_reason` is unrecognized string | Map to `"end_turn"` | WARN |
| `stop_reason` is null | Map to `"end_turn"` | WARN |
| `content` is a string | Wrap: `[{type: "text", text: content}]` | WARN |
| `content` is null | Replace with `[]` | WARN |
| `content[*]` missing `type` | Log only — cannot safely infer type | ERROR |

### Log Format

Every violation log includes the minimal context needed to diagnose it without
enabling `PROMPT_LOG_MODE`:

```
[ResponseValidator] WARN: missing usage block
  requestId=abc-123 provider=nvidia-nim model=meta/llama-3.2-3b-instruct
  repaired: injected {input_tokens:0, output_tokens:0}
```

This log entry is also captured in the trace store (Spec B) as part of `errorMsg`
if the response is classified as degraded.

### Integration Point

Each converter strategy's output method gains a single call:

```javascript
// In ClaudeConverter.toAnthropicResponse(), GeminiConverter, OpenAIConverter:
const response = buildResponse(/* ... existing logic ... */);
return validateAndRepair(response, {requestId, provider, model});
```

`validateAndRepair` is a pure function — same input always produces same output.
No state, no side effects beyond logging.

---

## Data Flow

```
ADDING A MODEL (new workflow)
  Edit configs/model-catalog.json → add one JSON entry
  Restart proxy → catalog loader reads new entry
  New model appears in /v1/models immediately

RESPONSE VALIDATION (per request)
  Provider adapter → raw response
  Converter strategy → toAnthropicResponse() → response object
  validateAndRepair(response, ctx) → validated/repaired response object
  → flushed to Claude Code

  If violation detected:
    → auto-repair applied (if fixable)
    → WARN logged with requestId + provider + field + received value
    → trace.status set to 'degraded' (queryable via /v1/traces)
```

---

## Backward Compatibility

**Model catalog migration is non-breaking:**
- `provider-models.js` exports exactly the same functions and constants
- All existing callers (`provider-pool-manager.js`, `converters/utils.js`, etc.)
  require zero changes
- `configs/config.json` `modelFallbackMapping` still works as an override

**Response validator is additive:**
- Valid responses from all existing providers pass through with zero mutations
- The 110 existing tests must pass without modification — this is the primary
  acceptance criterion for Part 2

---

## Testing

### Model Catalog Tests

| Test | What it verifies |
|---|---|
| Catalog loads without errors | JSON parse + schema check |
| `getProviderModels('claude-kiro-oauth')` returns correct IDs | Provider filtering |
| `MODEL_CONTEXT_WINDOWS` populated for all catalog entries | Context window map |
| `MODEL_MAX_OUTPUT_TOKENS` populated for all catalog entries | Max output map |
| All IDs are versioned (contain a date string) | Rule 8 from CLAUDE.md |
| No duplicate IDs in catalog | Uniqueness invariant |
| `fallbackTarget` references a valid catalog ID (or null) | Chain integrity |

### Response Validator Tests

| Test | What it verifies |
|---|---|
| Valid Anthropic response passes through unmodified | Non-interference |
| Missing `usage` → injected with zeros + WARN | Auto-repair: usage |
| `stop_reason: "STOP"` (OpenAI format) → mapped to `"end_turn"` + WARN | Auto-repair: stop_reason |
| `content: null` → replaced with `[]` + WARN | Auto-repair: content null |
| `content: "text string"` → wrapped in array + WARN | Auto-repair: content string |
| `content[0]` missing `type` → ERROR logged, passed through | No-repair case |
| All 110 existing tests pass after integration | Zero regressions |

---

## Implementation Order

Part 1 (catalog) should be implemented before Part 2 (validator) because:
1. The catalog migration validates the test suite passes with refactored `provider-models.js`
2. Part 2 adds the validator on top of a verified stable catalog baseline
3. If Part 1 causes an unexpected regression, Part 2 can be paused without losing work

---

## Relationship to Prior Specs

- **[[2026-05-31-reliability-health-guard-design]]** — HealthGuard is a consumer of
  the catalog (reads `healthGuard.pulseIntervalMs` from config). No conflict.
- **[[2026-05-31-observability-trace-store-design]]** — TraceStore captures validator
  WARN events in `errorMsg`. Both specs are additive to `request-handler.js` and
  `db.js` independently.
