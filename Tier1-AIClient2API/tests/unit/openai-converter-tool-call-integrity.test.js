/**
 * Unit tests: Tool Call Integrity — OpenAIConverter (TDD audit Task 2)
 *
 * Covers three sections:
 *   A. tool_result content blocks in user-role messages (toClaudeRequest path)
 *   B. Tool call ID threading through assistant → tool_use → tool_result
 *   C. flattenToolArguments / dynamicFlattenToolArguments behaviour
 */

import OpenAIConverter from '../../src/converters/strategies/OpenAIConverter.js';

const converter = new OpenAIConverter();

/**
 * Helper: call toClaudeRequest and return the messages array.
 */
function getClaudeMessages(openaiMessages, extraFields = {}) {
    const result = converter.toClaudeRequest({ messages: openaiMessages, ...extraFields });
    return result.messages || [];
}

// =============================================================================
// Section A: tool_result content blocks in user-role messages
// =============================================================================

describe('Section A: tool_result in user-role messages (toClaudeRequest)', () => {
    test('tool_result content block in user message is preserved (not dropped)', () => {
        const messages = [
            { role: 'user', content: 'What files are here?' },
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: "I'll check." },
                    { type: 'tool_use', id: 'tu_a1', name: 'Bash', input: { command: 'ls' } }
                ]
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'tu_a1',
                        content: 'src/\ntests/\npackage.json'
                    }
                ]
            }
        ];

        const claudeMessages = getClaudeMessages(messages);

        // There must be a user message that carries the tool_result block
        const toolResultMsg = claudeMessages.find(m =>
            m.role === 'user' &&
            Array.isArray(m.content) &&
            m.content.some(b => b.type === 'tool_result')
        );
        expect(toolResultMsg).toBeDefined();

        const block = toolResultMsg.content.find(b => b.type === 'tool_result');
        expect(block.tool_use_id).toBe('tu_a1');
        expect(block.content).toContain('src/');
    });

    test('multiple tool_results in single user message are all preserved', () => {
        const messages = [
            { role: 'user', content: 'Show files and git status.' },
            {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tu_b1', name: 'Bash', input: { command: 'ls' } },
                    { type: 'tool_use', id: 'tu_b2', name: 'Bash', input: { command: 'git status' } }
                ]
            },
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'tu_b1', content: 'src/ tests/' },
                    { type: 'tool_result', tool_use_id: 'tu_b2', content: 'On branch master' }
                ]
            }
        ];

        const claudeMessages = getClaudeMessages(messages);

        const toolResultMsg = claudeMessages.find(m =>
            m.role === 'user' &&
            Array.isArray(m.content) &&
            m.content.some(b => b.type === 'tool_result')
        );
        expect(toolResultMsg).toBeDefined();

        const toolResultBlocks = toolResultMsg.content.filter(b => b.type === 'tool_result');
        expect(toolResultBlocks).toHaveLength(2);

        const ids = toolResultBlocks.map(b => b.tool_use_id);
        expect(ids).toContain('tu_b1');
        expect(ids).toContain('tu_b2');
    });

    test('non-tool_result user content is unaffected by tool_result handling', () => {
        const messages = [
            { role: 'user', content: 'Hello, can you help me?' },
            { role: 'assistant', content: 'Of course!' },
            { role: 'user', content: 'Great, tell me about Node.js.' }
        ];

        const claudeMessages = getClaudeMessages(messages);

        // No tool_result blocks should appear
        const hasToolResult = claudeMessages.some(m =>
            Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result')
        );
        expect(hasToolResult).toBe(false);

        // Plain text content should be preserved as text blocks
        const lastUserMsg = claudeMessages[claudeMessages.length - 1];
        expect(lastUserMsg.role).toBe('user');
        const textBlock = lastUserMsg.content.find(b => b.type === 'text');
        expect(textBlock).toBeDefined();
        expect(textBlock.text).toContain('Node.js');
    });
});

// =============================================================================
// Section B: Tool call ID threading
// =============================================================================

describe('Section B: Tool call ID threading', () => {
    test('tool call ID is threaded from request through to converted tool_use block', () => {
        const messages = [
            { role: 'user', content: 'Run ls please.' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'tc_thread_001',
                    type: 'function',
                    function: { name: 'Bash', arguments: '{"command":"ls"}' }
                }]
            },
            { role: 'tool', tool_call_id: 'tc_thread_001', content: 'src/ tests/' }
        ];

        const claudeMessages = getClaudeMessages(messages);

        // The assistant turn must carry a tool_use block with the original id
        const assistantMsg = claudeMessages.find(m => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        const toolUseBlock = assistantMsg.content.find(b => b.type === 'tool_use');
        expect(toolUseBlock).toBeDefined();
        expect(toolUseBlock.id).toBe('tc_thread_001');

        // The subsequent user turn must carry a tool_result with the same id
        const toolResultMsg = claudeMessages.find(m =>
            m.role === 'user' &&
            Array.isArray(m.content) &&
            m.content.some(b => b.type === 'tool_result')
        );
        expect(toolResultMsg).toBeDefined();
        const toolResultBlock = toolResultMsg.content.find(b => b.type === 'tool_result');
        expect(toolResultBlock.tool_use_id).toBe('tc_thread_001');
    });

    test('parallel tool calls each get unique IDs in the converted output', () => {
        const messages = [
            { role: 'user', content: 'Run two commands.' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: 'tc_parallel_001',
                        type: 'function',
                        function: { name: 'Bash', arguments: '{"command":"ls"}' }
                    },
                    {
                        id: 'tc_parallel_002',
                        type: 'function',
                        function: { name: 'Bash', arguments: '{"command":"pwd"}' }
                    }
                ]
            },
            { role: 'tool', tool_call_id: 'tc_parallel_001', content: 'src/' },
            { role: 'tool', tool_call_id: 'tc_parallel_002', content: '/home/user' }
        ];

        const claudeMessages = getClaudeMessages(messages);

        // The assistant turn must have both tool_use blocks with distinct IDs
        const assistantMsg = claudeMessages.find(m => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        const toolUseBlocks = assistantMsg.content.filter(b => b.type === 'tool_use');
        expect(toolUseBlocks).toHaveLength(2);

        const toolUseIds = toolUseBlocks.map(b => b.id);
        expect(toolUseIds).toContain('tc_parallel_001');
        expect(toolUseIds).toContain('tc_parallel_002');

        // IDs must be distinct
        expect(new Set(toolUseIds).size).toBe(2);
    });
});

// =============================================================================
// Section C: flattenToolArguments / Schema Guard behaviour
// =============================================================================

describe('Section C: flattenToolArguments behaviour (toClaudeRequest)', () => {
    test('object-valued command arg on Bash tool is flattened to a JSON string', () => {
        // Bash is in the legacy SCHEMA_GUARD_TOOLS set; "command" is in SCHEMA_GUARD_FIELDS.
        // When an upstream model returns an object instead of a string, the Schema Guard
        // must stringify it so Claude (which expects a string) does not choke.
        const messages = [
            { role: 'user', content: 'Run a command.' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'tc_flat_001',
                    type: 'function',
                    function: {
                        name: 'Bash',
                        // "command" is an object — non-Claude models sometimes do this
                        arguments: JSON.stringify({ command: { shell: 'bash', cmd: 'ls' } })
                    }
                }]
            }
        ];

        const claudeMessages = getClaudeMessages(messages);

        const assistantMsg = claudeMessages.find(m => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        const toolUseBlock = assistantMsg.content.find(b => b.type === 'tool_use');
        expect(toolUseBlock).toBeDefined();

        // The "command" input must have been flattened to a string
        expect(typeof toolUseBlock.input.command).toBe('string');

        // And the string must be the JSON-serialised form of the original object
        const parsed = JSON.parse(toolUseBlock.input.command);
        expect(parsed.shell).toBe('bash');
        expect(parsed.cmd).toBe('ls');
    });

    test('tool call with already-flat (string) args is not double-flattened', () => {
        const messages = [
            { role: 'user', content: 'Run ls.' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'tc_flat_002',
                    type: 'function',
                    function: {
                        name: 'Bash',
                        // "command" is already a plain string — should not be re-serialised
                        arguments: JSON.stringify({ command: 'ls -la' })
                    }
                }]
            }
        ];

        const claudeMessages = getClaudeMessages(messages);

        const assistantMsg = claudeMessages.find(m => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        const toolUseBlock = assistantMsg.content.find(b => b.type === 'tool_use');
        expect(toolUseBlock).toBeDefined();

        // Should remain the original string, not wrapped in extra quotes
        expect(toolUseBlock.input.command).toBe('ls -la');
    });

    test('tool NOT in the Schema Guard set passes args through unchanged', () => {
        // "MyCustomTool" is not in SCHEMA_GUARD_TOOLS, so object args must not be flattened
        const nestedArg = { key: 'value', nested: { deep: true } };
        const messages = [
            { role: 'user', content: 'Use a custom tool.' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'tc_flat_003',
                    type: 'function',
                    function: {
                        name: 'MyCustomTool',
                        arguments: JSON.stringify({ data: nestedArg })
                    }
                }]
            }
        ];

        const claudeMessages = getClaudeMessages(messages);

        const assistantMsg = claudeMessages.find(m => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        const toolUseBlock = assistantMsg.content.find(b => b.type === 'tool_use');
        expect(toolUseBlock).toBeDefined();

        // Object should be preserved — not stringified
        expect(typeof toolUseBlock.input.data).toBe('object');
        expect(toolUseBlock.input.data.nested.deep).toBe(true);
    });
});
