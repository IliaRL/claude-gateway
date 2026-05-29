/**
 * Unit tests for KiroApiService thinking-prefix generation (WR-06).
 *
 * Bug: _generateThinkingPrefix emitted literal escape sequences ("\x3Cthinking_mode>")
 * instead of real tag characters ("<thinking_mode>"). Because KIRO_THINKING.MODE_TAG
 * (used by _hasThinkingPrefix) is the real tag, the generated prefix never matched —
 * breaking dedup and sending malformed markup to Kiro.
 *
 * Fix: _generateThinkingPrefix must emit real "<thinking_mode>" markup so that
 * _hasThinkingPrefix(_generateThinkingPrefix(...)) === true.
 */

// token-utils.js uses createRequire(import.meta.url) for a native tokenizer addon,
// which does not load under jest's CJS interop. The methods under test never touch
// it, so mock it to make the claude-kiro import chain resolvable.
jest.mock('../../src/utils/token-utils.js', () => ({
    countTextTokens: () => 0,
    estimateInputTokens: () => 0,
    countTokensAnthropic: () => 0,
    processContent: (x) => x,
    getContentText: (x) => (typeof x === 'string' ? x : ''),
}));
// proxy-utils.js -> tls-sidecar.js also uses import.meta.url; mock the surface used here.
jest.mock('../../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: () => {},
    configureTLSSidecar: () => {},
    isTLSSidecarEnabledForProvider: () => false,
}));
// service-manager.js pulls in the adapter/gemini-core chain (ESM-only "open" pkg).
// The methods under test don't need the pool manager; stub it.
jest.mock('../../src/services/service-manager.js', () => ({
    getProviderPoolManager: () => null,
}));

import { KiroApiService } from '../../src/providers/claude/claude-kiro.js';

const kiro = new KiroApiService({});

describe('KiroApiService._generateThinkingPrefix (WR-06)', () => {
    test('enabled prefix contains the real <thinking_mode> tag and not the literal \\x3C', () => {
        const prefix = kiro._generateThinkingPrefix({ type: 'enabled', budget_tokens: 8000 });
        expect(prefix).toContain('<thinking_mode>');
        expect(prefix).not.toContain('\\x3C');
        expect(prefix).not.toContain('x3C');
    });

    test('_hasThinkingPrefix detects the generated enabled prefix', () => {
        const prefix = kiro._generateThinkingPrefix({ type: 'enabled', budget_tokens: 8000 });
        expect(kiro._hasThinkingPrefix(prefix)).toBe(true);
    });

    test('adaptive prefix contains real <thinking_mode> and <thinking_effort> tags', () => {
        const prefix = kiro._generateThinkingPrefix({ type: 'adaptive', effort: 'medium' });
        expect(prefix).toContain('<thinking_mode>');
        expect(prefix).toContain('<thinking_effort>');
        expect(prefix).not.toContain('\\x3C');
    });

    test('_hasThinkingPrefix detects the generated adaptive prefix (dedup works)', () => {
        const prefix = kiro._generateThinkingPrefix({ type: 'adaptive', effort: 'high' });
        expect(kiro._hasThinkingPrefix(prefix)).toBe(true);
    });
});
