/**
 * Unit tests for three verified OpenAIConverter bugs:
 *
 *  - CR-01: streamParams Map leak — entries for streams that terminate without a
 *           finish_reason chunk are never cleaned up except by the lazy stale sweep.
 *  - WR-05: buildClaudeToolChoice returns { type: undefined } for unknown strings.
 *  - #6:    toClaudeModelList omits `id` and `display_name`.
 *
 * Tests are written against the converter directly (no server required).
 */

import OpenAIConverter from '../../src/converters/strategies/OpenAIConverter.js';

const MODEL = 'claude-sonnet-4-5';

function makeTextChunk(chunkId, text) {
    return {
        id: chunkId,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
    };
}

function makeFinishChunk(chunkId) {
    return {
        id: chunkId,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// CR-01: streamParams cleanup on all terminal paths
// ─────────────────────────────────────────────────────────────────────────────
describe('CR-01: streamParams Map cleanup', () => {
    test('finish_reason stream cleans up its entry exactly once', () => {
        const converter = new OpenAIConverter();
        const reqId = 'cr01-finish-001';
        converter.toClaudeStreamChunk(makeTextChunk('c1', 'hello'), MODEL, reqId);
        expect(converter.streamParams.has(reqId)).toBe(true);

        converter.toClaudeStreamChunk(makeFinishChunk('c1'), MODEL, reqId);
        expect(converter.streamParams.has(reqId)).toBe(false);
    });

    test('a stream that never emits finish_reason can be cleaned up explicitly', () => {
        const converter = new OpenAIConverter();
        const reqId = 'cr01-abort-001';
        // Stream starts and produces text but the client aborts — no finish_reason ever arrives.
        converter.toClaudeStreamChunk(makeTextChunk('c2', 'partial...'), MODEL, reqId);
        expect(converter.streamParams.has(reqId)).toBe(true);

        // A terminal/abort/error hook must reliably clear the entry.
        converter.cleanupStream(reqId);
        expect(converter.streamParams.has(reqId)).toBe(false);
    });

    test('cleanupStream is idempotent — no double-delete error after finish_reason', () => {
        const converter = new OpenAIConverter();
        const reqId = 'cr01-idem-001';
        converter.toClaudeStreamChunk(makeTextChunk('c3', 'hi'), MODEL, reqId);
        converter.toClaudeStreamChunk(makeFinishChunk('c3'), MODEL, reqId);
        expect(converter.streamParams.has(reqId)).toBe(false);

        // Calling cleanup again on an already-cleaned stream must be a safe no-op.
        expect(() => converter.cleanupStream(reqId)).not.toThrow();
        expect(converter.streamParams.has(reqId)).toBe(false);
    });

    test('cleanupStream on an unknown key is a safe no-op', () => {
        const converter = new OpenAIConverter();
        expect(() => converter.cleanupStream('never-registered')).not.toThrow();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// WR-05: buildClaudeToolChoice unknown string handling
// ─────────────────────────────────────────────────────────────────────────────
describe('WR-05: buildClaudeToolChoice string mapping', () => {
    const converter = new OpenAIConverter();

    test("'auto' maps to { type: 'auto' }", () => {
        expect(converter.buildClaudeToolChoice('auto')).toEqual({ type: 'auto' });
    });

    test("'none' maps to { type: 'none' }", () => {
        expect(converter.buildClaudeToolChoice('none')).toEqual({ type: 'none' });
    });

    test("'required' maps to { type: 'any' }", () => {
        expect(converter.buildClaudeToolChoice('required')).toEqual({ type: 'any' });
    });

    test("unknown string returns undefined (omit tool_choice), not { type: undefined }", () => {
        expect(converter.buildClaudeToolChoice('bogus')).toBeUndefined();
    });

    test('object form is preserved', () => {
        expect(converter.buildClaudeToolChoice({ type: 'tool', name: 'Bash' }))
            .toEqual({ type: 'tool', name: 'Bash' });
        expect(converter.buildClaudeToolChoice({ function: { name: 'Read' } }))
            .toEqual({ type: 'tool', name: 'Read' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// #6: toClaudeModelList includes id and display_name while preserving name
// ─────────────────────────────────────────────────────────────────────────────
describe('#6: toClaudeModelList shape', () => {
    const converter = new OpenAIConverter();

    test('each entry has id, display_name, and still has name', () => {
        const input = { data: [{ id: 'claude-x', display_name: 'Claude X' }] };
        const out = converter.toClaudeModelList(input);

        expect(Array.isArray(out.models)).toBe(true);
        const entry = out.models[0];
        expect(entry.id).toBe('claude-x');
        expect(entry.display_name).toBe('Claude X');
        expect(entry.name).toBe('claude-x');
        // description field preserved (existing consumers may rely on it)
        expect(entry).toHaveProperty('description');
    });

    test('display_name falls back to id when missing', () => {
        const input = { data: [{ id: 'claude-y' }] };
        const out = converter.toClaudeModelList(input);
        expect(out.models[0].display_name).toBe('claude-y');
        expect(out.models[0].id).toBe('claude-y');
        expect(out.models[0].name).toBe('claude-y');
    });
});
