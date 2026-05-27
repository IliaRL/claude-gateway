// trace-buffer.js — in-memory ring buffer for per-request diagnostic traces.
// Used by the diagnostic framework (see also: request-handler.js, request-handlers.js).
//
// Each trace records timing for a single inbound proxy request:
//   - requestId, model, provider, fallback chain, TTFT, total RTT, error info.
//
// Exposed only when:
//   1) Client sets `X-Debug-Trace: 1` on the inbound request → header attached + buffered
//   2) Client GETs /v1/trace or /v1/trace/:requestId → reads buffer
//
// No production overhead when X-Debug-Trace is absent (trace is still created
// and buffered, but header serialization is skipped — buffer is small/cheap).
//
// Reasoning-model TTFT exemption list lives here so both the timer and the
// trace metadata can reference the same predicate.

const MAX_TRACES = 100;
const buffer = []; // append-only ring; trimmed on push

/**
 * Models whose ID substrings indicate long reasoning/thinking phases.
 * These are exempt from the TTFT abort threshold.
 */
const REASONING_MODEL_PATTERNS = [
    'thinking',
    'reason',
    'o1',
    'o3',
    'r1',
    'deepseek-r1',
    'kimi-k2',
    'nemotron-super',
    'gemini-3.1-pro',
];

/**
 * Returns true if the model is a reasoning/thinking model based on its ID.
 * @param {string} model
 */
export function isReasoningModel(model) {
    if (!model || typeof model !== 'string') return false;
    const lower = model.toLowerCase();
    return REASONING_MODEL_PATTERNS.some(pat => lower.includes(pat));
}

/**
 * Returns true if the request body explicitly enables extended thinking.
 * Handles both Anthropic-style and budget-style flags.
 * @param {object} body
 */
export function isThinkingEnabled(body) {
    if (!body || typeof body !== 'object') return false;
    const t = body.thinking;
    if (!t) return false;
    if (t.type === 'enabled') return true;
    if (typeof t.budget_tokens === 'number' && t.budget_tokens > 0) return true;
    if (typeof t.budgetTokens === 'number' && t.budgetTokens > 0) return true;
    return false;
}

/**
 * Create a fresh trace object for an inbound request.
 * @param {string} requestId
 */
export function createTrace(requestId) {
    return {
        requestId,
        startedAt: Date.now(),
        startedAtIso: new Date().toISOString(),
        model: null,
        provider: null,
        debugRequested: false,
        proxyOverheadMs: null,
        upstreamConnectMs: null,
        upstreamTTFTMs: null,
        totalUpstreamMs: null,
        fallbackCount: 0,
        fallbackReasons: [],
        fallbackSteps: [],         // {step, fromProvider, toProvider, reason, errorCode, penaltyMs, isModelDowngrade}
        ttftWarning: null,
        ttftAborted: false,
        totalRTTMs: null,
        status: 'pending',         // pending | ok | error | timeout | aborted
        errorMessage: null,
        inputTokens: null,         // actual input tokens consumed (from upstream usage field)
        outputTokens: null,        // actual output tokens generated (from upstream usage field)
    };
}

/**
 * Append a trace to the ring buffer; trim oldest if full.
 * @param {object} trace
 */
export function pushTrace(trace) {
    if (!trace) return;
    trace.totalRTTMs = trace.totalRTTMs ?? (Date.now() - trace.startedAt);
    buffer.push(trace);
    while (buffer.length > MAX_TRACES) buffer.shift();
}

/**
 * Get all buffered traces (newest last).
 */
export function getAllTraces() {
    return buffer.slice();
}

/**
 * Look up a single trace by request ID.
 * @param {string} requestId
 */
export function getTrace(requestId) {
    if (!requestId) return null;
    // Search from the end (newest first) — typical lookup is for the most recent request.
    for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i].requestId === requestId) return buffer[i];
    }
    return null;
}

/**
 * Record one fallback step on a trace.
 * @param {object} trace
 * @param {object} step  {fromProvider, toProvider, reason, errorCode, penaltyMs, isModelDowngrade}
 */
export function recordFallbackStep(trace, step) {
    if (!trace || !step) return;
    trace.fallbackCount = (trace.fallbackCount || 0) + 1;
    const stepIndex = trace.fallbackCount;
    const entry = {
        step: stepIndex,
        fromProvider: step.fromProvider ?? null,
        toProvider: step.toProvider ?? null,
        reason: step.reason ?? null,
        errorCode: step.errorCode ?? null,
        penaltyMs: step.penaltyMs ?? null,
        isModelDowngrade: step.isModelDowngrade === true,
        at: Date.now() - trace.startedAt,
    };
    trace.fallbackSteps.push(entry);
    if (entry.reason) trace.fallbackReasons.push(entry.reason);
}

/**
 * Stringify a trace safely for HTTP header transport.
 * Truncates very long fields to keep header under common 8KB limit.
 */
export function serializeTraceForHeader(trace) {
    if (!trace) return '';
    try {
        // Strip fields that may bloat header
        const safe = { ...trace };
        if (safe.fallbackSteps && safe.fallbackSteps.length > 10) {
            safe.fallbackSteps = safe.fallbackSteps.slice(-10);
            safe.fallbackStepsTruncated = true;
        }
        return JSON.stringify(safe);
    } catch (e) {
        return JSON.stringify({ requestId: trace.requestId, serializationError: e.message });
    }
}

/**
 * Clear the buffer (test helper).
 */
export function _clearBuffer() {
    buffer.length = 0;
}
