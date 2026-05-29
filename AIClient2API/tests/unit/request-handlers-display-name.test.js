/**
 * Unit tests for buildFriendlyDisplayName helper.
 * Verifies the "Claude [FriendlyName] ([Provider])" naming convention
 * that Claude Code's /model picker depends on.
 */
import { buildFriendlyDisplayName } from '../../src/utils/request-handlers.js';

describe('buildFriendlyDisplayName', () => {
    test('non-Claude model gets Claude prefix', () => {
        expect(buildFriendlyDisplayName('gemini-2.5-flash', 'gemini-cli-oauth'))
            .toBe('Claude Gemini 2.5 Flash (gemini-cli)');
    });

    test('Claude model ID is not double-prefixed', () => {
        const result = buildFriendlyDisplayName('claude-sonnet-4-6', 'claude-kiro-oauth');
        expect(result).toMatch(/^Claude /);
        expect(result).not.toMatch(/^Claude Claude/);
    });

    test('provider -oauth suffix is stripped', () => {
        expect(buildFriendlyDisplayName('gpt-4o', 'openai-custom-oauth'))
            .toContain('(openai-custom)');
    });

    test('provider claude- prefix is stripped', () => {
        expect(buildFriendlyDisplayName('gemini-3-flash', 'claude-gemini-antigravity'))
            .toContain('(gemini-antigravity)');
    });

    test('version numbers use dot not dash', () => {
        const result = buildFriendlyDisplayName('deepseek-3-2', 'kiro');
        expect(result).toContain('3.2');
    });

    test('alias ID (claude-provider:model) is handled', () => {
        const result = buildFriendlyDisplayName('gemini-2.5-pro', 'gemini-antigravity');
        expect(result).toMatch(/^Claude Gemini 2\.5 Pro \(gemini-antigravity\)$/);
    });

    test('empty modelId falls back gracefully', () => {
        const result = buildFriendlyDisplayName('', 'kiro');
        expect(result).toMatch(/^Claude/);
    });
});
