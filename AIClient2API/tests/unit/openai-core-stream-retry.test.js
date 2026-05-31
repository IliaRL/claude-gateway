/**
 * Bug 2: OpenAIApiService.streamApi uses recursive generator delegation for retries.
 *
 * yield* this.streamApi(..., retryCount + 1) creates a new generator frame on every
 * retry. All frames stay alive simultaneously (via yield* delegation) until the outermost
 * consumer finishes, causing memory growth proportional to retry depth on flaky
 * connections (ECONNRESET, ETIMEDOUT, 5xx).
 *
 * Fix: Replace recursive yield* with a while-loop that wraps the try/catch.
 * The generator yield stays inside the loop body; no frames accumulate.
 */

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
    isRetryableNetworkError: (err) => ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND'].includes(err.code),
}));

import axios from 'axios';
import { OpenAIApiService } from '../../src/providers/openai/openai-core.js';

// Helper: build a mock axios response stream that yields SSE chunks then [DONE].
function makeMockStreamResponse(chunks) {
    const lines = [
        ...chunks.map(c => `data: ${JSON.stringify(c)}\n`),
        'data: [DONE]\n',
    ];
    const fullText = lines.join('\n');
    const asyncIterable = {
        [Symbol.asyncIterator]: async function* () {
            yield Buffer.from(fullText);
        },
    };
    return { data: asyncIterable };
}

describe('Bug 2: streamApi retries without recursive generator nesting', () => {
    let service;
    let mockAxiosInstance;

    beforeEach(() => {
        service = new OpenAIApiService({
            OPENAI_API_KEY: 'test-key',
            OPENAI_BASE_URL: 'https://api.test.com',
            REQUEST_MAX_RETRIES: 3,
            REQUEST_BASE_DELAY: 1, // 1ms so tests run fast
        });
        // Replace the axios instance with a mock
        mockAxiosInstance = { request: jest.fn() };
        service.axiosInstance = mockAxiosInstance;
    });

    test('streamApi retries on ECONNRESET and eventually succeeds', async () => {
        const networkError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        const successChunk = { id: 'c1', choices: [{ delta: { content: 'hello' }, finish_reason: null }] };
        const finishChunk = { id: 'c1', choices: [{ delta: {}, finish_reason: 'stop' }] };

        mockAxiosInstance.request
            .mockRejectedValueOnce(networkError)
            .mockResolvedValueOnce(makeMockStreamResponse([successChunk, finishChunk]));

        const chunks = [];
        for await (const chunk of service.streamApi('/chat/completions', { messages: [] })) {
            chunks.push(chunk);
        }

        expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
        expect(chunks).toHaveLength(2);
        expect(chunks[0]).toEqual(successChunk);
    });

    test('streamApi retries on 5xx server error and eventually succeeds', async () => {
        const serverError = Object.assign(new Error('Internal Server Error'), {
            response: { status: 503, data: 'Service Unavailable' },
        });
        const successChunk = { id: 'c2', choices: [{ delta: { content: 'world' }, finish_reason: null }] };
        const finishChunk = { id: 'c2', choices: [{ delta: {}, finish_reason: 'stop' }] };

        mockAxiosInstance.request
            .mockRejectedValueOnce(serverError)
            .mockResolvedValueOnce(makeMockStreamResponse([successChunk, finishChunk]));

        const chunks = [];
        for await (const chunk of service.streamApi('/chat/completions', { messages: [] })) {
            chunks.push(chunk);
        }

        expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
        expect(chunks).toHaveLength(2);
    });

    test('streamApi throws after exhausting all retries on persistent network error', async () => {
        const networkError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        // maxRetries=3, so 4 total attempts (first + 3 retries)
        mockAxiosInstance.request.mockRejectedValue(networkError);

        const gen = service.streamApi('/chat/completions', { messages: [] });
        await expect(gen.next()).rejects.toThrow();
        // 4 calls: 1 initial + 3 retries
        expect(mockAxiosInstance.request).toHaveBeenCalledTimes(4);
    });

    test('streamApi does not retry on 401 auth failure', async () => {
        const authError = Object.assign(new Error('Unauthorized'), {
            response: { status: 401, data: 'Unauthorized' },
        });
        mockAxiosInstance.request.mockRejectedValue(authError);

        const gen = service.streamApi('/chat/completions', { messages: [] });
        await expect(gen.next()).rejects.toThrow();
        // Must not retry on 401 — only 1 attempt
        expect(mockAxiosInstance.request).toHaveBeenCalledTimes(1);
    });

    test('streamApi does not retry 429 with Retry-After header (throws to upper layer)', async () => {
        const rateLimitError = Object.assign(new Error('Rate Limited'), {
            response: {
                status: 429,
                data: 'Too Many Requests',
                headers: { 'retry-after': '60' },
            },
        });
        mockAxiosInstance.request.mockRejectedValue(rateLimitError);

        const gen = service.streamApi('/chat/completions', { messages: [] });
        await expect(gen.next()).rejects.toThrow();
        expect(mockAxiosInstance.request).toHaveBeenCalledTimes(1);
    });
});
