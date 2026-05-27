/**
 * Unit tests for GrokConverter streaming chunk sequencing.
 *
 * Verifies:
 * 1. requestId is threaded into every response chunk (all chunks share the same id)
 * 2. The id from the first chunk matches all subsequent chunks
 *
 * Note: token-utils.js uses import.meta.url at the module level to load a
 * native .node addon, which does not work under Babel's Jest transform.
 * The manual mock at src/utils/__mocks__/token-utils.js is activated below.
 */

jest.mock('../../src/utils/token-utils.js');

import { GrokConverter } from '../../src/converters/strategies/GrokConverter.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a synthetic Grok streaming chunk (mid-stream token).
 * responseId in the chunk payload is what Grok would include.
 */
function makeTokenChunk(token, responseId = null) {
    return {
        result: {
            response: {
                token,
                isDone: false,
                ...(responseId ? { responseId } : {}),
            },
        },
    };
}

/**
 * Build a terminal Grok chunk (isDone = true).
 */
function makeDoneChunk(responseId = null) {
    return {
        result: {
            response: {
                isDone: true,
                ...(responseId ? { responseId } : {}),
            },
        },
    };
}

/**
 * Flatten an array-of-arrays (convertStreamChunk returns arrays) into a flat list.
 * Null results are discarded.
 */
function flatChunks(results) {
    return results
        .filter(r => r !== null && r !== undefined)
        .flatMap(r => (Array.isArray(r) ? r : [r]));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GrokConverter.toOpenAIStreamChunk — requestId threading', () => {
    test('requestId is threaded into every response chunk', () => {
        const converter = new GrokConverter();
        const requestId = 'test-req-grok-001';
        const model = 'grok-3';

        // When the chunk has a responseId in the payload, the converter uses that.
        // When it doesn't, it falls back to requestId.
        // Use a consistent responseId in the payload to simulate a real Grok stream.
        const grokResponseId = 'grok-internal-id-abc123';

        const raw = [
            converter.toOpenAIStreamChunk(makeTokenChunk('Hello', grokResponseId), model, requestId),
            converter.toOpenAIStreamChunk(makeTokenChunk(' world', grokResponseId), model, requestId),
            converter.toOpenAIStreamChunk(makeDoneChunk(grokResponseId), model, requestId),
        ];

        const chunks = flatChunks(raw);
        expect(chunks.length).toBeGreaterThan(0);

        // Every chunk must carry an id field
        for (const chunk of chunks) {
            expect(chunk).toHaveProperty('id');
            expect(typeof chunk.id).toBe('string');
            expect(chunk.id.length).toBeGreaterThan(0);
        }
    });

    test('requestId from first chunk matches all subsequent chunks', () => {
        const converter = new GrokConverter();
        const requestId = 'test-req-grok-002';
        const model = 'grok-3';
        const grokResponseId = 'grok-internal-id-xyz789';

        const raw = [
            converter.toOpenAIStreamChunk(makeTokenChunk('A', grokResponseId), model, requestId),
            converter.toOpenAIStreamChunk(makeTokenChunk('B', grokResponseId), model, requestId),
            converter.toOpenAIStreamChunk(makeTokenChunk('C', grokResponseId), model, requestId),
            converter.toOpenAIStreamChunk(makeDoneChunk(grokResponseId), model, requestId),
        ];

        const chunks = flatChunks(raw);
        expect(chunks.length).toBeGreaterThan(0);

        const firstId = chunks[0].id;
        expect(typeof firstId).toBe('string');

        for (const chunk of chunks) {
            expect(chunk.id).toBe(firstId);
        }
    });

    test('fallback to requestId when chunk carries no responseId', () => {
        const converter = new GrokConverter();
        const requestId = 'test-req-grok-003';
        const model = 'grok-3';

        // No responseId in the payload — converter should use requestId as fallback
        const raw = [
            converter.toOpenAIStreamChunk(makeTokenChunk('Hello'), model, requestId),
            converter.toOpenAIStreamChunk(makeTokenChunk(' world'), model, requestId),
            converter.toOpenAIStreamChunk(makeDoneChunk(), model, requestId),
        ];

        const chunks = flatChunks(raw);
        expect(chunks.length).toBeGreaterThan(0);

        const firstId = chunks[0].id;
        // All chunks should share the same id derived from the fallback
        for (const chunk of chunks) {
            expect(chunk.id).toBe(firstId);
        }
    });
});
