/**
 * Unit tests: REQ-03 — blockStarted deduplication in toClaudeStreamChunk
 *
 * When a streaming tool call receives two chunks with the same `index` but the
 * second chunk also carries a non-empty `function.name` (some providers resend
 * the name on every delta), toClaudeStreamChunk must emit exactly ONE
 * content_block_start with type 'tool_use' for that index.
 */

import OpenAIConverter from '../../src/converters/strategies/OpenAIConverter.js';

const MODEL = 'claude-sonnet-4-5';

/**
 * Helper: build a minimal OpenAI streaming chunk that carries a tool_call delta.
 */
function makeToolCallChunk({ id, chunkId, name, args, index }) {
    return {
        id: chunkId || 'chatcmpl-stream-dedup-001',
        object: 'chat.completion.chunk',
        choices: [{
            index: 0,
            delta: {
                role: 'assistant',
                tool_calls: [{
                    index: index ?? 0,
                    id: id || null,
                    type: 'function',
                    function: {
                        ...(name !== undefined ? { name } : {}),
                        ...(args !== undefined ? { arguments: args } : {})
                    }
                }]
            },
            finish_reason: null
        }]
    };
}

function makeFinishChunk(chunkId) {
    return {
        id: chunkId || 'chatcmpl-stream-dedup-001',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
    };
}

/**
 * Collect all events from a sequence of chunks using a fresh converter instance.
 * A fresh converter is used so streamParams state does not bleed between tests.
 */
function collectEvents(chunks, requestId) {
    const converter = new OpenAIConverter();
    const allEvents = [];
    for (const chunk of chunks) {
        const events = converter.toClaudeStreamChunk(chunk, MODEL, requestId);
        if (Array.isArray(events)) {
            allEvents.push(...events);
        }
    }
    return allEvents;
}

// ─────────────────────────────────────────────────────────────────────────────
// REQ-03: Duplicate name chunk for the same tool index must not produce
//         a second content_block_start
// ─────────────────────────────────────────────────────────────────────────────

describe('REQ-03: blockStarted deduplication — same-index tool call chunks', () => {
    const REQ_ID = 'req-dedup-test-001';
    const CHUNK_ID = 'chatcmpl-dedup-001';

    // Chunk 1: first chunk — carries name (opens the tool block)
    const chunk1 = makeToolCallChunk({
        id: 'tool_call_id_abc',
        chunkId: CHUNK_ID,
        name: 'Bash',
        index: 0
    });

    // Chunk 2: same index — provider resends the name on the second delta
    const chunk2 = makeToolCallChunk({
        chunkId: CHUNK_ID,
        name: 'Bash',        // name present again on same index
        args: '{"command":',  // args start arriving
        index: 0
    });

    // Chunk 3: args continuation, no name
    const chunk3 = makeToolCallChunk({
        chunkId: CHUNK_ID,
        args: '"ls"}',
        index: 0
    });

    const finishChunk = makeFinishChunk(CHUNK_ID);

    test('exactly ONE content_block_start with type tool_use is emitted for index 0', () => {
        const events = collectEvents([chunk1, chunk2, chunk3, finishChunk], REQ_ID);

        const blockStarts = events.filter(
            e => e.type === 'content_block_start' &&
                 e.content_block?.type === 'tool_use'
        );

        expect(blockStarts).toHaveLength(1);
    });

    test('no duplicate content_block_start events at the same block index', () => {
        const events = collectEvents([chunk1, chunk2, chunk3, finishChunk], REQ_ID);

        const blockStarts = events.filter(e => e.type === 'content_block_start');
        const startIndices = blockStarts.map(e => e.index);

        // Each block index must appear at most once in start events
        const uniqueIndices = new Set(startIndices);
        expect(startIndices.length).toBe(uniqueIndices.size);
    });

    test('tool args deltas are still emitted after the second name chunk', () => {
        const events = collectEvents([chunk1, chunk2, chunk3, finishChunk], REQ_ID);

        const argDeltas = events.filter(
            e => e.type === 'content_block_delta' &&
                 e.delta?.type === 'input_json_delta'
        );

        // At least the args from chunk2 and chunk3 should produce deltas
        expect(argDeltas.length).toBeGreaterThan(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// REQ-03 baseline: two DIFFERENT tool indices should each get their own
//                  content_block_start (parallel tool calls — correct behavior)
// ─────────────────────────────────────────────────────────────────────────────

describe('REQ-03 baseline: parallel tool calls (different indices) each get one block_start', () => {
    const REQ_ID = 'req-dedup-parallel-001';
    const CHUNK_ID = 'chatcmpl-parallel-001';

    const chunkTool0 = makeToolCallChunk({
        id: 'tool_id_0',
        chunkId: CHUNK_ID,
        name: 'Bash',
        args: '{"command":"ls"}',
        index: 0
    });

    const chunkTool1 = makeToolCallChunk({
        id: 'tool_id_1',
        chunkId: CHUNK_ID,
        name: 'Read',
        args: '{"path":"/tmp"}',
        index: 1
    });

    const finishChunk = makeFinishChunk(CHUNK_ID);

    test('two distinct tool indices each produce exactly one content_block_start', () => {
        const events = collectEvents([chunkTool0, chunkTool1, finishChunk], REQ_ID);

        const toolBlockStarts = events.filter(
            e => e.type === 'content_block_start' &&
                 e.content_block?.type === 'tool_use'
        );

        expect(toolBlockStarts).toHaveLength(2);
    });

    test('parallel tool block_start events carry distinct tool names', () => {
        const events = collectEvents([chunkTool0, chunkTool1, finishChunk], REQ_ID);

        const toolBlockStarts = events.filter(
            e => e.type === 'content_block_start' &&
                 e.content_block?.type === 'tool_use'
        );

        const names = toolBlockStarts.map(e => e.content_block.name);
        expect(names).toContain('Bash');
        expect(names).toContain('Read');
    });
});
