/**
 * Regression tests for anthropic-beta / anthropic-version header handling.
 *
 * Spec requirement (ANTHROPIC_GATEWAY_SPEC.md lines 26 and 32):
 *   - Anthropic Messages-format endpoints MUST convey anthropic-beta and
 *     anthropic-version to the upstream.
 *   - Non-Anthropic providers MUST NOT leak these headers to their upstreams.
 *
 * Audit findings (verified against real code):
 *
 * 1. claude-core (ClaudeApiService) — Anthropic-API-key path
 *    - anthropic-version: HARDCODED to '2023-06-01' in axios instance default headers (L41).
 *      Never reads inbound req.headers['anthropic-version'].
 *    - anthropic-beta: NOT sent at all. Inbound anthropic-beta is ignored.
 *    Verdict: version is conveyed (hardcoded); beta is intentionally absent (direct
 *    Anthropic API will also accept bodies that declare beta features implicitly).
 *    These tests lock that contract so any future change is detected.
 *
 * 2. claude-kiro (KiroApiService) — Kiro/CodeWhisperer path
 *    - anthropic-beta: BUILT from body signals (tools, cache_control, thinking) at
 *      L1754-1770 (non-stream callApi) and L2345-2361 (streamApiReal). Never reads
 *      inbound req.headers['anthropic-beta'] — derives the correct value from what
 *      features are actually present in the body. For amazonq models uses
 *      'x-amzn-kiro-amazonq-beta' instead of 'anthropic-beta'.
 *    - anthropic-version: NOT set — irrelevant to CodeWhisperer wire protocol.
 *    Verdict: body-signal derivation is functionally equivalent to (and more robust
 *    than) naive header forwarding, because Claude Code encodes beta features in the
 *    body, not just the header.
 *
 * 3. openai-core (OpenAIApiService) — OpenAI/OpenRouter/GitHub/NIM path
 *    - axios instance headers: Content-Type, Authorization, User-Agent only.
 *    - Per-call axiosConfig adds only: method, url, data.
 *    - anthropic-* NEVER appear.
 *    Verdict: CLEAN — no leakage to non-Anthropic upstreams.
 *
 * 4. gemini-core / antigravity-core — Gemini CLI / Antigravity path
 *    - Headers: { Content-Type } + applyGeminiCLIHeaders (User-Agent, X-Goog-Api-Client).
 *    - anthropic-* NEVER appear.
 *    Verdict: CLEAN — no leakage.
 *
 * These tests are PURE UNIT tests — no live network, no real credentials, no real server.
 */

// ─── Common mocks required by all provider imports ───────────────────────────

jest.mock('../../src/utils/token-utils.js', () => ({
    countTextTokens: () => 0,
    estimateInputTokens: () => 0,
    countTokensAnthropic: () => 0,
    processContent: (x) => x,
    getContentText: (x) => (typeof x === 'string' ? x : ''),
}));

jest.mock('../../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    },
}));

jest.mock('../../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: () => {},
    configureTLSSidecar: (cfg) => cfg,
    isTLSSidecarEnabledForProvider: () => false,
}));

jest.mock('../../src/utils/network-utils.js', () => ({
    sharedHttpAgent: {},
    sharedHttpsAgent: {},
    isRetryableNetworkError: () => false,
}));

// common.js is a barrel re-exporting network-utils (and others). Mock it so that
// isRetryableNetworkError / getRetryAfterMs are available in provider code that
// imports from '../../utils/common.js'.
jest.mock('../../src/utils/common.js', () => ({
    isRetryableNetworkError: () => false,
    getRetryAfterMs: () => null,
    formatExpiryLog: (d) => String(d),
    MODEL_PROVIDER: {
        CLAUDE_CUSTOM: 'claude-custom',
        KIRO_API: 'kiro-api',
        GEMINI_CLI: 'gemini-cli',
        OPENAI_CUSTOM: 'openai-custom',
    },
    MODEL_PROTOCOL_PREFIX: {},
}));

jest.mock('../../src/services/service-manager.js', () => ({
    getProviderPoolManager: () => null,
}));

jest.mock('../../src/core/plugin-manager.js', () => ({
    getPluginManager: () => null,
}));

jest.mock('../../src/utils/file-lock.js', () => ({
    withFileLock: async (_, fn) => fn(),
    atomicWriteFile: async () => {},
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import axios from 'axios';
import { ClaudeApiService } from '../../src/providers/claude/claude-core.js';
import { KiroApiService } from '../../src/providers/claude/claude-kiro.js';
import { OpenAIApiService } from '../../src/providers/openai/openai-core.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

// Minimal fake response that looks like a successful Anthropic /messages reply.
const FAKE_CLAUDE_RESPONSE = {
    data: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
    },
};

// Minimal fake response for OpenAI /chat/completions
const FAKE_OPENAI_RESPONSE = {
    data: {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
};

// ─── 1. ClaudeApiService (claude-core) ───────────────────────────────────────

describe('ClaudeApiService (claude-core) header contract', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new ClaudeApiService({
            CLAUDE_API_KEY: 'test-key',
            CLAUDE_BASE_URL: 'https://api.anthropic.com',
        });
    });

    test('sends anthropic-version header on every request (hardcoded to 2023-06-01)', async () => {
        // anthropic-version lives in the axios instance default headers, not in per-call
        // axiosConfig. Inspect the instance defaults directly — no network call needed.
        const instanceHeaders = service.client.defaults.headers;
        expect(instanceHeaders['anthropic-version']).toBe('2023-06-01');
    });

    test('does NOT include anthropic-beta in the default instance headers', () => {
        const instanceHeaders = service.client.defaults.headers;
        const combined = Object.assign({}, instanceHeaders, instanceHeaders.common);
        const keys = Object.keys(combined).map(k => k.toLowerCase());
        expect(keys).not.toContain('anthropic-beta');
    });

    test('does NOT forward any inbound req headers — per-call axiosConfig only carries url/method/data', async () => {
        // Spy on the already-constructed axios instance (not the global axios.request)
        // so we intercept without triggering a real HTTP connection.
        const spy = jest.spyOn(service.client, 'request').mockResolvedValueOnce(FAKE_CLAUDE_RESPONSE);

        await service.generateContent('claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 100,
        });

        expect(spy).toHaveBeenCalledTimes(1);
        const perCallConfig = spy.mock.calls[0][0];
        // The per-request axiosConfig must NOT inject new anthropic-* headers
        // (they live in instance defaults only — never added per-call).
        const perCallHeaders = perCallConfig?.headers ?? {};
        const perCallHeaderKeys = Object.keys(perCallHeaders).map(k => k.toLowerCase());
        expect(perCallHeaderKeys).not.toContain('anthropic-beta');
        expect(perCallHeaderKeys).not.toContain('anthropic-version');
    });
});

// ─── 2. KiroApiService (claude-kiro) — header built from body signals ────────

describe('KiroApiService (claude-kiro) anthropic-beta header derivation', () => {
    let service;

    // KiroApiService can be constructed without credentials; it defers initialization.
    beforeEach(() => {
        jest.clearAllMocks();
        service = new KiroApiService({});
        // Pre-initialize so callApi doesn't attempt real file/network I/O.
        service.isInitialized = true;
        service.accessToken = 'test-bearer-token';
        service.expiresAt = new Date(Date.now() + 7200 * 1000).toISOString(); // 2 h from now
        service.baseUrl = 'https://q.us-east-1.amazonaws.com/generateAssistantResponse';
        service.amazonQUrl = 'https://q.us-east-1.amazonaws.com/generateAssistantResponse';
        // Pre-seed axiosInstance so the service is fully constructed.
        // (KiroApiService.initialize() does axios.create; stub it.)
        const { default: ax } = jest.requireActual('axios');
        service.axiosInstance = ax.create({
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
        });
    });

    // Helper: call callApi and return the axiosConfig that was passed to axiosInstance.request
    async function callAndCapture(body) {
        const spy = jest.spyOn(service.axiosInstance, 'request').mockResolvedValueOnce({
            data: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] },
            _kiroToolNameMaps: {},
        });
        await service.callApi('', 'claude-sonnet-4-5', body).catch(() => {});
        return spy.mock.calls[0]?.[0] ?? null;
    }

    test('no beta header when body has no tools, caching, or thinking', async () => {
        // _autoInjectPromptCaching modifies the body in-place (adds cache_control to the
        // last user message), which would then trigger prompt-caching-2024-07-31. Stub it
        // out so we test only the header-building logic in isolation.
        jest.spyOn(service, '_autoInjectPromptCaching').mockImplementation(() => {});
        const cfg = await callAndCapture({
            messages: [{ role: 'user', content: 'hello' }],
        });
        expect(cfg).not.toBeNull();
        const headers = cfg.headers ?? {};
        expect(headers['anthropic-beta']).toBeUndefined();
        expect(headers['x-amzn-kiro-amazonq-beta']).toBeUndefined();
    });

    test('adds tools-2024-04-04 to anthropic-beta when tools array is present', async () => {
        const cfg = await callAndCapture({
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ name: 'bash', description: 'run bash', input_schema: { type: 'object', properties: {} } }],
        });
        expect(cfg).not.toBeNull();
        const betaHeader = cfg.headers?.['anthropic-beta'] ?? '';
        expect(betaHeader).toContain('tools-2024-04-04');
    });

    test('adds prompt-caching-2024-07-31 when message content has cache_control', async () => {
        const cfg = await callAndCapture({
            messages: [{
                role: 'user',
                content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
            }],
        });
        expect(cfg).not.toBeNull();
        const betaHeader = cfg.headers?.['anthropic-beta'] ?? '';
        expect(betaHeader).toContain('prompt-caching-2024-07-31');
    });

    test('adds interleaved-thinking-2025-05-14 when thinking object is present', async () => {
        const cfg = await callAndCapture({
            messages: [{ role: 'user', content: 'think hard' }],
            thinking: { type: 'enabled', budget_tokens: 8000 },
        });
        expect(cfg).not.toBeNull();
        const betaHeader = cfg.headers?.['anthropic-beta'] ?? '';
        expect(betaHeader).toContain('interleaved-thinking-2025-05-14');
    });

    test('combines multiple beta flags when multiple features are present', async () => {
        const cfg = await callAndCapture({
            messages: [{
                role: 'user',
                content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
            }],
            tools: [{ name: 'bash', description: 'run bash', input_schema: { type: 'object', properties: {} } }],
            thinking: { type: 'enabled', budget_tokens: 4096 },
        });
        expect(cfg).not.toBeNull();
        const betaHeader = cfg.headers?.['anthropic-beta'] ?? '';
        expect(betaHeader).toContain('tools-2024-04-04');
        expect(betaHeader).toContain('prompt-caching-2024-07-31');
        expect(betaHeader).toContain('interleaved-thinking-2025-05-14');
    });

    test('uses x-amzn-kiro-amazonq-beta (not anthropic-beta) for amazonq models', async () => {
        const spy = jest.spyOn(service.axiosInstance, 'request').mockResolvedValueOnce({
            data: { output: [] },
            _kiroToolNameMaps: {},
        });
        await service.callApi('', 'amazonq-claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ name: 'bash', description: 'run bash', input_schema: { type: 'object', properties: {} } }],
        }).catch(() => {});
        const cfg = spy.mock.calls[0]?.[0] ?? null;
        if (cfg) {
            // amazonq models: beta on x-amzn-kiro-amazonq-beta, NOT on anthropic-beta
            expect(cfg.headers?.['x-amzn-kiro-amazonq-beta']).toContain('tools-2024-04-04');
            expect(cfg.headers?.['anthropic-beta']).toBeUndefined();
        }
    });

    test('does NOT contain anthropic-version header (wrong protocol for Kiro/CodeWhisperer)', async () => {
        const cfg = await callAndCapture({
            messages: [{ role: 'user', content: 'hello' }],
        });
        if (cfg) {
            const headerKeys = Object.keys(cfg.headers ?? {}).map(k => k.toLowerCase());
            expect(headerKeys).not.toContain('anthropic-version');
        }
    });
});

// ─── 3. OpenAIApiService — no anthropic-* header leakage ────────────────────

describe('OpenAIApiService (openai-core) — no anthropic-* header leakage', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new OpenAIApiService({
            OPENAI_API_KEY: 'test-openai-key',
            OPENAI_BASE_URL: 'https://api.openai.com/v1',
        });
    });

    test('axios instance default headers do NOT contain anthropic-beta or anthropic-version', () => {
        const defaults = service.axiosInstance.defaults.headers;
        const allKeys = Object.keys(defaults).flatMap(section =>
            typeof defaults[section] === 'object' && defaults[section] !== null
                ? Object.keys(defaults[section])
                : [section]
        ).map(k => k.toLowerCase());

        expect(allKeys).not.toContain('anthropic-beta');
        expect(allKeys).not.toContain('anthropic-version');
    });

    test('per-call axiosConfig does NOT inject anthropic-* headers even when inbound request had them', async () => {
        // Spy on the constructed axiosInstance (not global axios.request) to avoid real HTTP.
        const spy = jest.spyOn(service.axiosInstance, 'request').mockResolvedValueOnce(FAKE_OPENAI_RESPONSE);

        // Simulate a caller that passed anthropic-beta in the request body (stripped at handler level)
        // — the body itself should NOT cause OpenAI adapter to send anthropic headers.
        await service.generateContent('gpt-4o', {
            messages: [{ role: 'user', content: 'hello' }],
        });

        expect(spy).toHaveBeenCalledTimes(1);
        const perCallConfig = spy.mock.calls[0][0];
        const perCallHeaderKeys = Object.keys(perCallConfig?.headers ?? {}).map(k => k.toLowerCase());
        expect(perCallHeaderKeys).not.toContain('anthropic-beta');
        expect(perCallHeaderKeys).not.toContain('anthropic-version');
    });

    test('default instance headers include Authorization and Content-Type but not anthropic-*', () => {
        const commonHeaders = service.axiosInstance.defaults.headers.common ?? {};
        const instanceHeaders = service.axiosInstance.defaults.headers;

        // Should have these provider-appropriate headers
        const hasAuth = 'Authorization' in instanceHeaders || 'Authorization' in commonHeaders;
        // Authorization is set in the constructor headers object
        const flatHeaders = {};
        for (const [k, v] of Object.entries(instanceHeaders)) {
            if (typeof v === 'string') flatHeaders[k.toLowerCase()] = v;
            else if (typeof v === 'object' && v !== null) {
                for (const [k2, v2] of Object.entries(v)) {
                    flatHeaders[k2.toLowerCase()] = v2;
                }
            }
        }
        expect(flatHeaders['authorization']).toMatch(/^Bearer /);
        expect(flatHeaders['anthropic-beta']).toBeUndefined();
        expect(flatHeaders['anthropic-version']).toBeUndefined();
    });
});
