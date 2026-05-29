// response-cache.js — In-memory LRU cache for non-streaming AI responses.
//
// Purpose: prevent quota drain when identical non-streaming requests are retried
// or repeated within a short window (e.g. tool retry storms, duplicate client sends).
//
// Constraints:
//   - Only caches non-streaming requests (stream: true is never cached)
//   - Never caches non-deterministic requests (temperature > 0)
//   - Never caches tool_result turns (upstream responses depend on prior tool execution)
//   - No external dependencies — pure in-process LRU Map
//   - Cache hit returns stored body immediately with X-Cache: HIT header

import { createHash } from 'crypto';

const MAX_ENTRIES = 200;
const TTL_MS = 30_000; // 30 seconds

// Map<key, {body: string, cachedAt: number}> — insertion order = LRU order
const _cache = new Map();

/**
 * Compute a stable cache key from the request parameters.
 * Returns null if the request should not be cached.
 *
 * @param {object} requestBody  Parsed request body (already processed)
 * @param {string} model        Resolved model ID
 * @returns {string|null}
 */
export function getCacheKey(requestBody, model) {
    if (!requestBody || !model) return null;
    // Never cache streaming requests
    if (requestBody.stream === true) return null;
    // Never cache non-deterministic requests — only cache when temperature is explicitly 0
    const temp = requestBody.temperature;
    if (temp == null || temp !== 0) return null;
    // Never cache turns that include tool_result blocks — responses depend on prior tool execution
    const messages = requestBody.messages;
    if (Array.isArray(messages)) {
        for (const msg of messages) {
            const content = msg.content;
            if (Array.isArray(content) && content.some(c => c.type === 'tool_result')) return null;
            if (typeof content === 'string' && msg.role === 'tool') return null;
        }
    }
    // Stable key: hash of model + messages/contents + tools (system prompt intentionally excluded —
    // it's injected at the adapter layer and not visible in requestBody here).
    // Include `contents` for Gemini-format requests where `messages` is absent.
    const hashInput = JSON.stringify({
        model,
        messages: requestBody.messages,
        contents: requestBody.contents,
        tools: requestBody.tools ?? null,
    });
    return createHash('sha256').update(hashInput).digest('hex');
}

/**
 * Look up a cached response.
 * Returns the cached body string, or null on miss / expiry.
 *
 * @param {string} key
 * @returns {string|null}
 */
export function getCache(key) {
    if (!key) return null;
    const entry = _cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > TTL_MS) {
        _cache.delete(key);
        return null;
    }
    // Refresh LRU position: delete + re-insert
    _cache.delete(key);
    _cache.set(key, entry);
    return entry.body;
}

/**
 * Store a response in the cache.
 *
 * @param {string} key
 * @param {string} body  JSON string of the response body
 */
export function setCache(key, body) {
    if (!key || !body) return;
    // Evict oldest entry if at capacity
    if (_cache.size >= MAX_ENTRIES) {
        const oldest = _cache.keys().next().value;
        _cache.delete(oldest);
    }
    _cache.set(key, { body, cachedAt: Date.now() });
}

/**
 * Return current cache statistics for health/debug endpoints.
 * @returns {{ size: number, maxEntries: number, ttlMs: number }}
 */
export function getCacheStats() {
    return { size: _cache.size, maxEntries: MAX_ENTRIES, ttlMs: TTL_MS };
}
