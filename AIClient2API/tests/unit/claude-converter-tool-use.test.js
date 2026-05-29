/**
 * Unit tests for ClaudeConverter.toGeminiRequest() — multi-turn tool-use path.
 *
 * Root cause: Anthropic IDs (toolu_xxx) are opaque. The converter must resolve
 * functionResponse.name from the prior functionCall.name via tcID2Name, not
 * by parsing the ID string.
 */

import ClaudeConverter from '../../src/converters/strategies/ClaudeConverter.js';

const converter = new ClaudeConverter();

function getContents(claudeMessages, extraFields = {}) {
    const result = converter.toGeminiRequest({ messages: claudeMessages, ...extraFields });
    const contents = result.contents || [];
    // Gemini requires strictly alternating roles
    for (let i = 1; i < contents.length; i++) {
        if (contents[i].role === contents[i - 1].role) {
            throw new Error(
                `Gemini alternating-role violation at index ${i}: ` +
                `consecutive "${contents[i].role}" messages`
            );
        }
    }
    return contents;
}

function findFunctionResponse(parts) {
    return parts.find(p => p.functionResponse);
}

function findFunctionCall(parts) {
    return parts.find(p => p.functionCall);
}

// ─── Primary fix: toolu_ IDs must resolve to real names ──────────────────────

test('tool_result with toolu_ ID resolves to function name, not opaque ID', () => {
    const messages = [
        { role: 'user', content: [{ type: 'text', text: 'Run ls' }] },
        {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_01ABCdef', name: 'Bash', input: { command: 'ls' } }]
        },
        {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_01ABCdef', content: 'file1.txt\nfile2.txt' }]
        }
    ];

    const contents = getContents(messages);
    const userParts = contents.filter(c => c.role === 'user');
    const lastUserParts = userParts[userParts.length - 1].parts;
    const fr = findFunctionResponse(lastUserParts);

    expect(fr).toBeDefined();
    expect(fr.functionResponse.name).toBe('Bash');
    expect(fr.functionResponse.name).not.toMatch(/^toolu_/);
    expect(fr.functionResponse.response.result).toBe('file1.txt\nfile2.txt');
});

test('functionCall name in assistant message matches functionResponse name in user message', () => {
    const messages = [
        { role: 'user', content: [{ type: 'text', text: 'Read file' }] },
        {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_ReadXYZ', name: 'Read', input: { file_path: '/tmp/x' } }]
        },
        {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_ReadXYZ', content: 'file contents' }]
        }
    ];

    const contents = getContents(messages);
    const modelTurn = contents.find(c => c.role === 'model');
    const userTurns = contents.filter(c => c.role === 'user');

    const fcName = findFunctionCall(modelTurn.parts)?.functionCall?.name;
    const frName = findFunctionResponse(userTurns[userTurns.length - 1].parts)?.functionResponse?.name;

    expect(fcName).toBe('Read');
    expect(frName).toBe('Read');
    expect(fcName).toBe(frName); // must match for Gemini to continue conversation
});

// ─── Multiple tool calls in one turn ─────────────────────────────────────────

test('multiple tool calls with toolu_ IDs all resolve correctly', () => {
    const messages = [
        { role: 'user', content: [{ type: 'text', text: 'Do two things' }] },
        {
            role: 'assistant',
            content: [
                { type: 'tool_use', id: 'toolu_001', name: 'Bash', input: { command: 'echo a' } },
                { type: 'tool_use', id: 'toolu_002', name: 'Read', input: { file_path: '/x' } }
            ]
        },
        {
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: 'toolu_001', content: 'a' },
                { type: 'tool_result', tool_use_id: 'toolu_002', content: 'contents' }
            ]
        }
    ];

    const contents = getContents(messages);
    const userTurns = contents.filter(c => c.role === 'user');
    const lastUserParts = userTurns[userTurns.length - 1].parts;
    const frs = lastUserParts.filter(p => p.functionResponse);

    expect(frs).toHaveLength(2);
    const names = frs.map(p => p.functionResponse.name);
    expect(names).toContain('Bash');
    expect(names).toContain('Read');
    expect(names.some(n => n.startsWith('toolu_'))).toBe(false);
});

// ─── Multi-turn: two tool-use rounds ─────────────────────────────────────────

test('multi-turn conversation with two consecutive tool-use rounds resolves both correctly', () => {
    const messages = [
        { role: 'user', content: [{ type: 'text', text: 'Start' }] },
        {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_A1', name: 'Bash', input: { command: 'pwd' } }]
        },
        {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_A1', content: '/home/user' }]
        },
        {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_A2', name: 'Read', input: { file_path: '/home/user/.zshrc' } }]
        },
        {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_A2', content: 'export PATH=...' }]
        }
    ];

    const contents = getContents(messages);
    const userTurns = contents.filter(c => c.role === 'user');

    // First tool result
    const fr1 = findFunctionResponse(userTurns[userTurns.length - 2].parts);
    expect(fr1?.functionResponse?.name).toBe('Bash');

    // Second tool result
    const fr2 = findFunctionResponse(userTurns[userTurns.length - 1].parts);
    expect(fr2?.functionResponse?.name).toBe('Read');
});

// ─── Array content in tool_result ────────────────────────────────────────────

test('tool_result with array content is flattened to string', () => {
    const messages = [
        { role: 'user', content: [{ type: 'text', text: 'Go' }] },
        {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_img', name: 'ScreenShot', input: {} }]
        },
        {
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: 'toolu_img',
                content: [
                    { type: 'text', text: 'Line1' },
                    { type: 'text', text: 'Line2' }
                ]
            }]
        }
    ];

    const contents = getContents(messages);
    const userTurns = contents.filter(c => c.role === 'user');
    const fr = findFunctionResponse(userTurns[userTurns.length - 1].parts);

    expect(fr?.functionResponse?.name).toBe('ScreenShot');
    expect(fr?.functionResponse?.response?.result).toBe('Line1\nLine2');
});

// ─── Mismatched ID fallback (graceful degradation) ───────────────────────────

test('mismatched tool_use_id falls back gracefully and produces non-empty functionResponse', () => {
    // Assistant used "toolu_correct", but tool_result references a wrong ID.
    // The converter should not crash; it should fall back to using the ID string.
    const messages = [
        { role: 'user', content: [{ type: 'text', text: 'Go' }] },
        {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_correct', name: 'Bash', input: { command: 'ls' } }]
        },
        {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_wrong_id', content: 'result' }]
        }
    ];

    expect(() => getContents(messages)).not.toThrow();

    const contents = getContents(messages);
    const userTurns = contents.filter(c => c.role === 'user');
    const fr = findFunctionResponse(userTurns[userTurns.length - 1].parts);

    // Result is present (not silently dropped)
    expect(fr).toBeDefined();
    expect(fr.functionResponse.response.result).toBe('result');
    // Name falls back to the ID string (not ideal, but not a crash)
    expect(fr.functionResponse.name).toBeTruthy();
});
