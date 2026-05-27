import * as http from 'http';
import * as https from 'https';
import logger from './logger.js';

/**
 * Shared keep-alive HTTP/HTTPS agents for static-key axios providers
 * (OpenAI / OpenRouter / NVIDIA NIM / GitHub Models / OpenAI Responses /
 * Forward / Claude custom). Node v19+ enables keepAlive on http.globalAgent
 * by default, but axios.create() instantiates its own per-request agent
 * unless explicitly given one — bypassing the global default and forcing a
 * fresh TCP+TLS handshake on every call (~150–300 ms wasted per request).
 *
 * Reusing one bounded agent per protocol gives:
 *   - persistent TCP/TLS sessions (lower request latency)
 *   - bounded socket count (maxSockets prevents file-descriptor leaks)
 *   - shared connection pool across providers that hit the same host
 *
 * Kiro and Antigravity have their own per-instance agents because they
 * use different transport (google-auth-library / explicit Connection:close).
 */
export const sharedHttpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 120000,
});

export const sharedHttpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 120000,
});

/**
 * 可重试的网络错误标识列表
 */
export const RETRYABLE_NETWORK_ERRORS = [
    'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'ENETUNREACH',
    'EHOSTUNREACH', 'EPIPE', 'EAI_AGAIN', 'ECONNABORTED', 'ESOCKETTIMEDOUT',
];

/**
 * 检查是否为可重试的网络错误
 */
export function isRetryableNetworkError(error) {
    if (!error) return false;
    const errorCode = error.code || '';
    const errorMessage = error.message || '';
    return RETRYABLE_NETWORK_ERRORS.some(err => errorCode === err || errorMessage.includes(err));
}

/**
 * 确保状态码是有效的 HTTP 状态码
 */
export function ensureValidStatusCode(code) {
    const num = parseInt(code, 10);
    if (!isNaN(num) && num >= 100 && num < 600) return num;
    return 500;
}

export function getErrorStatusCode(error) {
    return error?.response?.status || error?.status || error?.statusCode || error?.code || null;
}

export function getHeaderValue(headers, headerName) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(headerName) || headers.get(headerName.toLowerCase());
    const lowerName = headerName.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lowerName) return Array.isArray(value) ? value[0] : value;
    }
    return null;
}

export function parseRetryAfterMs(value, now = Date.now()) {
    if (value === null || value === undefined) return null;
    const rawValue = Array.isArray(value) ? value[0] : value;
    const text = String(rawValue).trim();
    if (!text) return null;
    const seconds = Number(text);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
    const dateMs = Date.parse(text);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - now);
    return null;
}

export function parseDurationMs(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
    const text = String(value).trim();
    const match = text.match(/^([\d.]+)\s*(ms|s)?$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return null;
    return Math.max(0, Math.round(match[2]?.toLowerCase() === 's' ? amount * 1000 : amount));
}

export function getRetryDelayFromBody(errorBody) {
    try {
        const data = typeof errorBody === 'string' ? JSON.parse(errorBody) : errorBody;
        const directDelay = parseDurationMs(data?.retryDelay ?? data?.retry_delay ?? data?.retryAfterMs);
        if (directDelay !== null) return directDelay;
        const details = data?.error?.details;
        if (Array.isArray(details)) {
            for (const detail of details) {
                const retryDelay = parseDurationMs(detail?.retryDelay || detail?.metadata?.quotaResetDelay);
                if (retryDelay !== null) return retryDelay;
            }
        }
        const message = data?.error?.message;
        if (message) {
            const match = message.match(/after\s+([\d.]+)\s*(ms|s)?\.?/i);
            if (match) {
                const amount = parseFloat(match[1]);
                return Math.max(0, Math.round(match[2]?.toLowerCase() === 'ms' ? amount : amount * 1000));
            }
        }
    } catch {}
    return null;
}

export function getRetryAfterMs(error, now = Date.now()) {
    const headerDelay = parseRetryAfterMs(getHeaderValue(error?.response?.headers, 'retry-after'), now);
    if (headerDelay !== null) return headerDelay;
    const explicitDelay = parseDurationMs(error?.retryAfterMs);
    if (explicitDelay !== null) return explicitDelay;
    const internalRetryAfterDelay = parseDurationMs(error?.retryAfter);
    if (internalRetryAfterDelay !== null) return internalRetryAfterDelay;
    const retryAfterDelay = parseRetryAfterMs(error?.response?.data?.retryAfter ?? error?.response?.data?.retry_after, now);
    if (retryAfterDelay !== null) return retryAfterDelay;
    return getRetryDelayFromBody(error?.response?.data);
}

function getPositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

/**
 * Calculates a scheduled recovery time for optional 429 account cooldown.
 */
export function getRateLimitCooldownRecoveryTime(error, config = {}, now = Date.now()) {
    if (!config?.RATE_LIMIT_COOLDOWN_ENABLED || Number(getErrorStatusCode(error)) !== 429) return null;
    const defaultCooldownMs = getPositiveInteger(config.RATE_LIMIT_COOLDOWN_MS, 30000);
    const maxCooldownMs = getPositiveInteger(config.RATE_LIMIT_COOLDOWN_MAX_MS, 300000);
    const jitterMs = getPositiveInteger(config.RATE_LIMIT_COOLDOWN_JITTER_MS, 0);
    const retryAfterMs = getRetryAfterMs(error, now);
    const baseCooldownMs = retryAfterMs === null ? defaultCooldownMs : retryAfterMs;
    const cappedCooldownMs = Math.min(baseCooldownMs, Math.max(defaultCooldownMs, maxCooldownMs));
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
    return new Date(now + cappedCooldownMs + jitter);
}

function normalizeIpAddress(ip) {
    if (!ip) return null;

    let normalized = String(ip).trim();
    if (!normalized) return null;

    // Clean up IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1 -> 127.0.0.1)
    if (normalized.startsWith('::ffff:')) {
        normalized = normalized.substring('::ffff:'.length);
    }

    return normalized || null;
}

function parseTrustedProxyIps(value) {
    if (Array.isArray(value)) {
        return value
            .flatMap(item => parseTrustedProxyIps(item))
            .filter(Boolean);
    }

    if (typeof value !== 'string') {
        return [];
    }

    return value
        .split(',')
        .map(item => normalizeIpAddress(item))
        .filter(Boolean);
}

function isTrustedProxyIp(ip, trustedProxyIps) {
    const normalizedIp = normalizeIpAddress(ip);
    if (!normalizedIp) return false;

    return parseTrustedProxyIps(trustedProxyIps).some(trustedIp => trustedIp === normalizedIp);
}

/**
 * Get client IP address from request.
 *
 * x-forwarded-for is client-controlled unless the immediate peer is a trusted
 * reverse proxy. Keep TRUST_PROXY disabled by default for login rate limits.
 *
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @param {Object} [config] - Optional server configuration.
 * @returns {string} The client IP address.
 */
export function getClientIp(req, config = {}) {
    const socketIp = normalizeIpAddress(req.socket?.remoteAddress);

    if (config?.TRUST_PROXY === true && isTrustedProxyIp(socketIp, config.TRUSTED_PROXY_IPS)) {
        const forwarded = req.headers?.['x-forwarded-for'];
        const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        const forwardedIp = normalizeIpAddress(forwardedValue?.split(',')[0]);
        if (forwardedIp) {
            return forwardedIp;
        }
    }

    return socketIp || 'unknown';
}

/**
 * Reads the entire request body from an HTTP request.
 */
export function getRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            if (!body) return resolve({});
            try { resolve(JSON.parse(body)); } catch (error) { reject(new Error("Invalid JSON in request body.")); }
        });
        req.on('error', err => { reject(err); });
    });
}

/**
 * Checks if the request is authorized based on API key.
 */
export function isAuthorized(req, requestUrl, REQUIRED_API_KEY) {
    const authHeader = req.headers['authorization'];
    const queryKey = requestUrl.searchParams.get('key');
    const googApiKey = req.headers['x-goog-api-key'];
    const claudeApiKey = req.headers['x-api-key'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        if (authHeader.substring(7) === REQUIRED_API_KEY) return true;
    }
    if (queryKey === REQUIRED_API_KEY || googApiKey === REQUIRED_API_KEY || claudeApiKey === REQUIRED_API_KEY) return true;
    const redact = (v) => v ? `${v.substring(0, 8)}...` : 'N/A';
    logger.info(`[Auth] Unauthorized request denied. Bearer: "${authHeader ? 'present' : 'N/A'}", Query Key: "${redact(queryKey)}", x-goog-api-key: "${redact(googApiKey)}", x-api-key: "${redact(claudeApiKey)}"`);
    return false;
}

/**
 * Handles the common logic for sending API responses (unary and stream).
 */
export async function handleUnifiedResponse(res, responsePayload, isStream, statusCode = 200, metadata = {}) {
    const validatedStatusCode = ensureValidStatusCode(statusCode);

    const headers = {
        "Cache-Control": "no-cache"
    };

    if (isStream) {
        headers["Content-Type"] = "text/event-stream";
        headers["Connection"] = "keep-alive";
        headers["Transfer-Encoding"] = "chunked";
    } else {
        headers["Content-Type"] = "application/json";
    }

    // Inject observability headers
    if (metadata.actualProvider) {
        headers["X-Proxy-Actual-Provider"] = metadata.actualProvider;
    }
    if (metadata.actualModel) {
        headers["X-Proxy-Actual-Model"] = metadata.actualModel;
    }
    if (metadata.isFallback) {
        headers["X-Proxy-Fallback-Used"] = "true";
    }
    if (metadata.uuid) {
        headers["X-Proxy-Credential-Uuid"] = metadata.uuid;
    }
    if (metadata.cacheHit) {
        headers["X-Cache"] = "HIT";
    }

    if (!res.headersSent) {
        res.writeHead(isStream ? 200 : validatedStatusCode, headers);
    }

    if (!isStream) {
        res.end(responsePayload);
    }
}
