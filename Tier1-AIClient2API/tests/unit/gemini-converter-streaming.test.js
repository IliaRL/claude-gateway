/**
 * Unit tests for GeminiConverter streaming chunk sequencing.
 *
 * Verifies:
 * 1. Chat ID is reused across all chunks (not regenerated per chunk)
 * 2. message_start fires exactly once per stream
 * 3. message_stop fires exactly once at the end of a stream
 * 4. Empty/whitespace-only chunks are not emitted
 */

import GeminiConverter from '../../src/converters/strategies/GeminiConverter.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a synthetic Gemini streaming chunk with text content */
function makeTextChunk(text, finishReason = null) {
    const chunk = {
        candidates: [{
            content: { parts: [{ text }], role: 'model' },
            index: 0,
        }],
    };
    if (finishReason) {
        chunk.candidates[0].finishReason = finishReason;
    }
    return chunk;
}

/** Build a final Gemini chunk (no content, just finishReason) */
function makeFinalChunk() {
    return {
        candidates: [{
            content: { parts: [], role: 'model' },
            index: 0,
            finishReason: 'STOP',
        }],
        usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 20,
            totalTokenCount: 30,
        },
    };
}

// ─── OpenAI stream tests ──────────────────────────────────────────────────────

describe('GeminiConverter.toOpenAIStreamChunk — chat ID consistency', () => {
    test('chat ID is reused across all streaming chunks (not regenerated per chunk)', () => {
        const converter = new GeminiConverter();
        const requestId = 'req-gemini-001';

        const chunk1 = converter.toOpenAIStreamChunk(makeTextChunk('Hello'), 'gemini-2.0-flash', requestId);
        const chunk2 = converter.toOpenAIStreamChunk(makeTextChunk(' world'), 'gemini-2.0-flash', requestId);
        const chunk3 = converter.toOpenAIStreamChunk(makeTextChunk('!', 'STOP'), 'gemini-2.0-flash', requestId);

        expect(chunk1).not.toBeNull();
        expect(chunk2).not.toBeNull();
        expect(chunk3).not.toBeNull();

        expect(chunk1.id).toBe(chunk2.id);
        expect(chunk2.id).toBe(chunk3.id);
    });

    test('empty/whitespace SSE chunks return null and are not emitted', () => {
        const converter = new GeminiConverter();
        const requestId = 'req-gemini-002';

        // Chunk with no text and no finishReason — should return null
        const emptyChunk = {
            candidates: [{
                content: { parts: [], role: 'model' },
                index: 0,
            }],
        };

        const result = converter.toOpenAIStreamChunk(emptyChunk, 'gemini-2.0-flash', requestId);
        expect(result).toBeNull();
    });

    test('different requestIds produce independent chat IDs', () => {
        const converter = new GeminiConverter();

        const chunkA = converter.toOpenAIStreamChunk(makeTextChunk('A'), 'gemini-2.0-flash', 'req-A');
        const chunkB = converter.toOpenAIStreamChunk(makeTextChunk('B'), 'gemini-2.0-flash', 'req-B');

        expect(chunkA).not.toBeNull();
        expect(chunkB).not.toBeNull();
        expect(chunkA.id).not.toBe(chunkB.id);
    });
});

// ─── Claude stream tests ──────────────────────────────────────────────────────

describe('GeminiConverter.toClaudeStreamChunk — message_start / message_stop', () => {
    test('message_start event fires exactly once per stream', () => {
        const converter = new GeminiConverter();
        const requestId = 'req-claude-001';

        const events1 = converter.toClaudeStreamChunk(makeTextChunk('Hello'), 'gemini-2.0-flash', requestId) || [];
        const events2 = converter.toClaudeStreamChunk(makeTextChunk(' world'), 'gemini-2.0-flash', requestId) || [];
        const events3 = converter.toClaudeStreamChunk(makeFinalChunk(), 'gemini-2.0-flash', requestId) || [];

        const allEvents = [...events1, ...events2, ...events3];
        const startEvents = allEvents.filter(e => e.type === 'message_start');

        expect(startEvents).toHaveLength(1);
    });

    test('message_stop event fires exactly once at end of stream', () => {
        const converter = new GeminiConverter();
        const requestId = 'req-claude-002';

        const events1 = converter.toClaudeStreamChunk(makeTextChunk('Hello'), 'gemini-2.0-flash', requestId) || [];
        const events2 = converter.toClaudeStreamChunk(makeTextChunk(' world'), 'gemini-2.0-flash', requestId) || [];
        const events3 = converter.toClaudeStreamChunk(makeFinalChunk(), 'gemini-2.0-flash', requestId) || [];

        const allEvents = [...events1, ...events2, ...events3];
        const stopEvents = allEvents.filter(e => e.type === 'message_stop');

        expect(stopEvents).toHaveLength(1);
    });

    test('message_stop is the last event in the stream', () => {
        const converter = new GeminiConverter();
        const requestId = 'req-claude-003';

        const events1 = converter.toClaudeStreamChunk(makeTextChunk('Hello'), 'gemini-2.0-flash', requestId) || [];
        const events2 = converter.toClaudeStreamChunk(makeFinalChunk(), 'gemini-2.0-flash', requestId) || [];

        const allEvents = [...events1, ...events2];
        const lastEvent = allEvents[allEvents.length - 1];

        expect(lastEvent.type).toBe('message_stop');
    });

    test('message_start is the first event in the stream', () => {
        const converter = new GeminiConverter();
        const requestId = 'req-claude-004';

        const events1 = converter.toClaudeStreamChunk(makeTextChunk('Hello'), 'gemini-2.0-flash', requestId) || [];

        expect(events1.length).toBeGreaterThan(0);
        expect(events1[0].type).toBe('message_start');
    });

    test('empty/whitespace-only Gemini chunks return null (not emitted)', () => {
        const converter = new GeminiConverter();
        const requestId = 'req-claude-005';

        // Emit the first real chunk to initialize state
        converter.toClaudeStreamChunk(makeTextChunk('Hello'), 'gemini-2.0-flash', requestId);

        // Chunk with no parts and no finishReason — should return null
        const emptyChunk = {
            candidates: [{
                content: { parts: [], role: 'model' },
                index: 0,
            }],
        };

        const result = converter.toClaudeStreamChunk(emptyChunk, 'gemini-2.0-flash', requestId);
        // Either null or an empty array — both mean nothing is emitted
        const isEmpty = result === null || (Array.isArray(result) && result.length === 0);
        expect(isEmpty).toBe(true);
    });
});
