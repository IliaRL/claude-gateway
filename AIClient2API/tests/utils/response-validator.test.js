import { test, expect } from '@jest/globals';
import { validateAndRepair } from '../../src/utils/response-validator.js';

const CTX = { requestId: 'test-req', provider: 'test', model: 'test-model' };

function validResponse(overrides = {}) {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

test('valid response passes through unmodified', () => {
  const r = validResponse();
  const original = JSON.parse(JSON.stringify(r));
  validateAndRepair(r, CTX);
  expect(r).toEqual(original);
});

test('null content is replaced with empty array', () => {
  const r = validResponse({ content: null });
  validateAndRepair(r, CTX);
  expect(r.content).toEqual([]);
});

test('undefined content is replaced with empty array', () => {
  const r = validResponse({ content: undefined });
  validateAndRepair(r, CTX);
  expect(r.content).toEqual([]);
});

test('string content is wrapped in a text block', () => {
  const r = validResponse({ content: 'Hello world' });
  validateAndRepair(r, CTX);
  expect(r.content).toEqual([{ type: 'text', text: 'Hello world' }]);
});

test('missing usage is injected as zeros', () => {
  const r = validResponse({ usage: undefined });
  validateAndRepair(r, CTX);
  expect(r.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
});

test('null usage is injected as zeros', () => {
  const r = validResponse({ usage: null });
  validateAndRepair(r, CTX);
  expect(r.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
});

test('NaN input_tokens is replaced with 0', () => {
  const r = validResponse({ usage: { input_tokens: NaN, output_tokens: 5 } });
  validateAndRepair(r, CTX);
  expect(r.usage.input_tokens).toBe(0);
});

test('OpenAI stop → end_turn', () => {
  const r = validResponse({ stop_reason: 'stop' });
  validateAndRepair(r, CTX);
  expect(r.stop_reason).toBe('end_turn');
});

test('OpenAI length → max_tokens', () => {
  const r = validResponse({ stop_reason: 'length' });
  validateAndRepair(r, CTX);
  expect(r.stop_reason).toBe('max_tokens');
});

test('OpenAI tool_calls → tool_use', () => {
  const r = validResponse({ stop_reason: 'tool_calls' });
  validateAndRepair(r, CTX);
  expect(r.stop_reason).toBe('tool_use');
});

test('unknown stop_reason falls back to end_turn', () => {
  const r = validResponse({ stop_reason: 'FINISH' });
  validateAndRepair(r, CTX);
  expect(r.stop_reason).toBe('end_turn');
});

test('null stop_reason is mapped to end_turn', () => {
  const r = validResponse({ stop_reason: null });
  validateAndRepair(r, CTX);
  expect(r.stop_reason).toBe('end_turn');
});

test('returns the same object reference (mutates in place)', () => {
  const r = validResponse();
  const result = validateAndRepair(r, CTX);
  expect(result).toBe(r);
});

test('null response is returned as-is without throwing', () => {
  expect(() => validateAndRepair(null, CTX)).not.toThrow();
  expect(validateAndRepair(null, CTX)).toBeNull();
});
