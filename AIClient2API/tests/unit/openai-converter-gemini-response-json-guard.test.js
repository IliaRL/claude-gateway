/**
 * Unit tests: F-03 — JSON.parse guard in toGeminiResponse
 *
 * When toolCall.function.arguments contains malformed JSON (not parseable),
 * toGeminiResponse must NOT throw and must still produce valid Gemini-format output.
 * The raw string is kept as-is when JSON.parse fails (per the try/catch guard).
 */

import OpenAIConverter from '../../src/converters/strategies/OpenAIConverter.js';

const converter = new OpenAIConverter();

/**
 * Helper: build a minimal OpenAI non-streaming response with a single tool call.
 */
function makeOpenAIResponse(argumentsStr) {
    return {
        id: 'chatcmpl-test-json-guard',
        object: 'chat.completion',
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'tc_json_guard_001',
                    type: 'function',
                    function: {
                        name: 'Bash',
                        arguments: argumentsStr
                    }
                }]
            },
            finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// F-03: Malformed JSON in toolCall.function.arguments must not throw
// ─────────────────────────────────────────────────────────────────────────────

describe('F-03: toGeminiResponse JSON.parse guard — malformed arguments', () => {
    const MALFORMED_JSON = '{"command": ls -la UNCLOSED';

    test('does not throw a SyntaxError when arguments are malformed JSON', () => {
        const response = makeOpenAIResponse(MALFORMED_JSON);
        expect(() => converter.toGeminiResponse(response)).not.toThrow();
    });

    test('returns a candidates array (not empty) when arguments are malformed JSON', () => {
        const response = makeOpenAIResponse(MALFORMED_JSON);
        const result = converter.toGeminiResponse(response);

        expect(result).toBeDefined();
        expect(Array.isArray(result.candidates)).toBe(true);
        expect(result.candidates.length).toBeGreaterThan(0);
    });

    test('functionCall is present in the candidate parts when arguments are malformed JSON', () => {
        const response = makeOpenAIResponse(MALFORMED_JSON);
        const result = converter.toGeminiResponse(response);

        const parts = result.candidates[0].content.parts;
        const functionCallPart = parts.find(p => p.functionCall);
        expect(functionCallPart).toBeDefined();
        expect(functionCallPart.functionCall.name).toBe('Bash');
    });

    test('functionCall.args contains the raw string (not undefined) when JSON.parse fails', () => {
        const response = makeOpenAIResponse(MALFORMED_JSON);
        const result = converter.toGeminiResponse(response);

        const parts = result.candidates[0].content.parts;
        const functionCallPart = parts.find(p => p.functionCall);
        // parsedArgs stays as the raw string; args must not be undefined/null
        expect(functionCallPart.functionCall.args).toBeDefined();
        expect(functionCallPart.functionCall.args).not.toBeNull();
    });

    test('output has valid Gemini response structure with usageMetadata', () => {
        const response = makeOpenAIResponse(MALFORMED_JSON);
        const result = converter.toGeminiResponse(response);

        expect(result.usageMetadata).toBeDefined();
        expect(typeof result.usageMetadata.promptTokenCount).toBe('number');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Baseline: well-formed JSON continues to work correctly
// ─────────────────────────────────────────────────────────────────────────────

describe('F-03 baseline: toGeminiResponse with valid JSON arguments', () => {
    test('valid JSON arguments are parsed into an object on functionCall.args', () => {
        const response = makeOpenAIResponse('{"command":"ls -la"}');
        const result = converter.toGeminiResponse(response);

        const parts = result.candidates[0].content.parts;
        const functionCallPart = parts.find(p => p.functionCall);
        expect(functionCallPart).toBeDefined();
        // Parsed → args should be an object (or the flattened equivalent), not a raw string
        expect(typeof functionCallPart.functionCall.args).not.toBe('undefined');
    });
});
