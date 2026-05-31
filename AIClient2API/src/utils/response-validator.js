import logger from './logger.js';

const VALID_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'tool_use', 'stop_sequence']);

// Map OpenAI finish_reason values to Anthropic stop_reason
const STOP_REASON_MAP = {
  'stop':           'end_turn',
  'length':         'max_tokens',
  'tool_calls':     'tool_use',
  'content_filter': 'end_turn',
  'function_call':  'tool_use',
};

/**
 * Validate an assembled Anthropic-format response object and auto-repair
 * known violations from non-Claude providers.
 *
 * Strategy: warn + repair, never hard-block. Claude Code sees a valid response
 * even if upstream sent something malformed. Every repair is logged with
 * enough context to diagnose the upstream provider.
 *
 * @param {object} response  Assembled Anthropic message response
 * @param {object} ctx       { requestId, provider, model }
 * @returns {object}         The same object (mutated), or the original if null/non-object
 */
export function validateAndRepair(response, ctx = {}) {
  if (!response || typeof response !== 'object') return response;

  const tag = `[ResponseValidator] requestId=${ctx.requestId ?? '?'} provider=${ctx.provider ?? '?'} model=${ctx.model ?? '?'}`;

  // ── 1. content ──────────────────────────────────────────────────────────────
  if (response.content === null || response.content === undefined) {
    logger.warn(`${tag} — content is ${response.content}: replaced with []`);
    response.content = [];
  } else if (typeof response.content === 'string') {
    logger.warn(`${tag} — content is a string: wrapped as [{type:"text",text:...}]`);
    response.content = [{ type: 'text', text: response.content }];
  } else if (Array.isArray(response.content)) {
    for (const block of response.content) {
      if (block && typeof block === 'object' && !block.type) {
        logger.error(`${tag} — content block missing type field: ${JSON.stringify(block).slice(0, 80)}`);
        // Cannot safely infer type — pass through but log as ERROR
      }
    }
  }

  // ── 2. stop_reason ───────────────────────────────────────────────────────────
  if (!VALID_STOP_REASONS.has(response.stop_reason)) {
    const repaired = STOP_REASON_MAP[response.stop_reason] ?? 'end_turn';
    logger.warn(`${tag} — stop_reason "${response.stop_reason}" → "${repaired}"`);
    response.stop_reason = repaired;
  }

  // ── 3. usage ─────────────────────────────────────────────────────────────────
  if (!response.usage || typeof response.usage !== 'object') {
    logger.warn(`${tag} — missing usage: injected {input_tokens:0, output_tokens:0}`);
    response.usage = { input_tokens: 0, output_tokens: 0 };
  } else {
    if (typeof response.usage.input_tokens !== 'number' || isNaN(response.usage.input_tokens)) {
      logger.warn(`${tag} — invalid input_tokens (${response.usage.input_tokens}): set to 0`);
      response.usage.input_tokens = 0;
    }
    if (typeof response.usage.output_tokens !== 'number' || isNaN(response.usage.output_tokens)) {
      logger.warn(`${tag} — invalid output_tokens (${response.usage.output_tokens}): set to 0`);
      response.usage.output_tokens = 0;
    }
  }

  return response;
}
