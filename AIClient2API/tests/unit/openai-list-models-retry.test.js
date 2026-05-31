/**
 * Bug 4: OpenAIApiService.listModels() has no retry logic.
 *
 * openai-custom is in MANAGED_MODEL_LIST_PROVIDERS, so its entire model catalog
 * comes from a live listModels() call. The current implementation throws
 * immediately on any error — a single network hiccup at startup empties the
 * catalog until the next successful fetch.
 *
 * Fix: Wrap the GET in a retry loop matching callApi's pattern (max 3, 1s base
 * delay, exponential backoff) for network errors. Auth errors (401/403) and
 * client errors (404) are not retried.
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

import { OpenAIApiService } from '../../src/providers/openai/openai-core.js';

describe('Bug 4: listModels() retries on transient network errors', () => {
    let service;
    let mockAxiosInstance;

    beforeEach(() => {
        service = new OpenAIApiService({
            OPENAI_API_KEY: 'test-key',
            OPENAI_BASE_URL: 'https://api.test.com',
            REQUEST_MAX_RETRIES: 3,
            REQUEST_BASE_DELAY: 1, // 1ms for test speed
        });
        mockAxiosInstance = { get: jest.fn(), request: jest.fn() };
        service.axiosInstance = mockAxiosInstance;
    });

    test('listModels resolves after one transient network failure', async () => {
        const networkError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        const modelList = { data: [{ id: 'gpt-4o', object: 'model' }] };

        mockAxiosInstance.get
            .mockRejectedValueOnce(networkError)
            .mockResolvedValueOnce({ data: modelList });

        const result = await service.listModels();
        expect(result).toEqual(modelList);
        expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    });

    test('listModels throws after exhausting all retries on persistent network error', async () => {
        const networkError = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
        mockAxiosInstance.get.mockRejectedValue(networkError);

        await expect(service.listModels()).rejects.toThrow();
        // 4 calls: 1 initial + 3 retries (REQUEST_MAX_RETRIES=3)
        expect(mockAxiosInstance.get).toHaveBeenCalledTimes(4);
    });

    test('listModels does not retry on 401 auth error', async () => {
        const authError = Object.assign(new Error('Unauthorized'), {
            response: { status: 401, data: 'Unauthorized' },
        });
        mockAxiosInstance.get.mockRejectedValue(authError);

        await expect(service.listModels()).rejects.toThrow();
        expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });

    test('listModels does not retry on 404 not found', async () => {
        const notFoundError = Object.assign(new Error('Not Found'), {
            response: { status: 404, data: 'Not Found' },
        });
        mockAxiosInstance.get.mockRejectedValue(notFoundError);

        await expect(service.listModels()).rejects.toThrow();
        expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });
});
