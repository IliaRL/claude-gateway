# Thinking Mode Detection Fix

**Date:** 2026-05-20  
**File Modified:** `src/providers/gemini/antigravity-core.js:72-105`

## Goal
Enable extended thinking mode for `gemini-claude-sonnet-4-6`, which Antigravity labels as "(thinking)" but the proxy was stripping thinking configuration from.

## Finding
The `modelSupportsThinking()` function only checked for:
1. Models starting with `gemini-3*` or `gemini-2.5-*`
2. Models with explicit `-thinking` suffix

This missed `gemini-claude-sonnet-4-6` because:
- It starts with `gemini-claude-` (not `gemini-3`)
- It doesn't have the `-thinking` suffix

## Fix
Implemented version-aware Claude model detection:

```javascript
function modelSupportsThinking(modelName) {
    if (!modelName) return false;
    const name = modelName.toLowerCase();

    // 1. Explicit -thinking suffix (highest priority)
    if (name.includes('-thinking')) return true;

    // 2. Gemini models that support thinking
    if (name.startsWith('gemini-3') || name.startsWith('gemini-2.5-')) return true;

    // 3. Claude models: only Opus/Sonnet 4.6+ support thinking (Haiku never does)
    if (name.includes('claude')) {
        // Haiku never supports thinking
        if (name.includes('haiku')) return false;

        // Extract version numbers (e.g., "4-6" or "4-5")
        const versionMatch = name.match(/(\d+)-(\d+)/);
        if (versionMatch) {
            const major = parseInt(versionMatch[1], 10);
            const minor = parseInt(versionMatch[2], 10);

            // Opus and Sonnet 4.6+ support thinking
            if ((name.includes('opus') || name.includes('sonnet')) &&
                (major > 4 || (major === 4 && minor >= 6))) {
                return true;
            }
        }
    }

    return false;
}
```

## Verification Results

All 11 test cases passed:

| Model | Thinking Support | Reason |
|-------|-----------------|--------|
| `gemini-claude-sonnet-4-6` | ✓ YES | Claude Sonnet 4.6 (FIXED) |
| `gemini-claude-opus-4-6-thinking` | ✓ YES | Explicit -thinking suffix |
| `gemini-3-flash` | ✓ YES | Gemini 3.x |
| `gemini-3.1-pro-high` | ✓ YES | Gemini 3.x |
| `gemini-2.5-flash-lite` | ✓ YES | Gemini 2.5.x |
| `claude-haiku-4-5` | ✗ NO | Haiku never supports thinking |
| `claude-haiku-4-6` | ✗ NO | Haiku never supports thinking (even 4.6) |
| `claude-sonnet-4-5` | ✗ NO | Sonnet 4.5 (before 4.6) |
| `claude-sonnet-4-5-20250929` | ✗ NO | Sonnet 4.5 (before 4.6) |
| `claude-sonnet-4-7` | ✓ YES | Sonnet 4.7 (future-proof) |
| `claude-opus-5-0` | ✓ YES | Opus 5.0 (future-proof) |

## Impact

- **Fixed:** `gemini-claude-sonnet-4-6` now properly supports extended thinking mode
- **Safe:** No false positives - Haiku and pre-4.6 models correctly excluded
- **Future-proof:** Automatically supports future Claude Opus/Sonnet versions ≥4.6

## Next Step
Complete. Proxy restarted and verified working.
