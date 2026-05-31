import { test, expect } from '@jest/globals';
import { buildModelEntry } from '../../src/utils/request-handlers.js';

test('buildModelEntry returns Anthropic-compatible schema', () => {
    const model = buildModelEntry('test-model', 'test-provider', 'Test Model');

    // Legacy OpenAI keys
    expect(model.id).toBe('test-model');
    expect(model.object).toBe('model');

    // Required Anthropic Gateway keys
    expect(model.type).toBe('model');
    expect(model.display_name).toBe('Test Model');
    expect(model.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/); // ISO 8601

    // Legacy created field still present
    expect(typeof model.created).toBe('number');
    expect(model.owned_by).toBe('test-provider');
});

test('buildModelEntry falls back to buildFriendlyDisplayName when no displayName given', () => {
    const model = buildModelEntry('gemini-2.5-flash', 'gemini-cli-oauth');
    expect(model.display_name).toBeDefined();
    expect(model.display_name.length).toBeGreaterThan(0);
});
