/**
 * Manual Jest mock for token-utils.js.
 *
 * token-utils.js uses import.meta.url at the module level to load a native
 * .node addon, which fails under Babel's ESM → CJS transform in the Jest
 * environment. This stub exports no-op versions of all public functions so
 * that GrokConverter (and any other module that imports token-utils) can be
 * unit-tested without hitting the native build artefact.
 */

export async function initNativeTokenizer() {
    return false;
}

export function getContentText(message) {
    if (!message) return '';
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(p => (typeof p === 'string' ? p : p?.text || '')).join('');
    return String(message);
}

export function processContent(content) {
    return getContentText(content);
}

export function countTextTokens(text) {
    // Rough approximation: 1 token ≈ 4 characters
    return Math.ceil((text || '').length / 4);
}

export function estimateInputTokens() {
    return 0;
}

export function countTokensAnthropic() {
    return 0;
}
