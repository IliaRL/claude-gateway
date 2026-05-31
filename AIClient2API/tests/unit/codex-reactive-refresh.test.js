/**
 * Bug 3: CodexApiService has no reactive 401 token refresh.
 *
 * Current behavior: On 401, the adapter calls triggerBackgroundRefresh() (async,
 * scheduled via pool manager) then throws with shouldSwitchCredential=true. With
 * a single account in the pool there is no other credential to switch to, so the
 * provider becomes unavailable until the background refresh completes.
 *
 * Fix: Before falling back to background refresh + credential switch, attempt an
 * inline synchronous refreshAccessToken() call. If it succeeds, retry the request
 * once. If it fails, fall through to the existing behavior (mark unhealthy + switch).
 * A hasRetriedOn401 flag prevents infinite loops.
 */

jest.mock('../../src/utils/file-lock.js', () => ({
    withFileLock: async (_, fn) => fn(),
    atomicWriteFile: async () => {},
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
}));
jest.mock('../../src/services/service-manager.js', () => ({
    getProviderPoolManager: () => ({
        markProviderNeedRefresh: () => {},
        resetProviderRefreshStatus: () => {},
    }),
}));
jest.mock('../../src/auth/oauth-handlers.js', () => ({
    refreshCodexTokensWithRetry: jest.fn(),
}));
// plugin-manager is dynamically imported inside prepareRequestBody; stub it.
jest.mock('../../src/core/plugin-manager.js', () => ({
    getPluginManager: () => null,
}));

import axios from 'axios';
import { CodexApiService } from '../../src/providers/openai/codex-core.js';
import { refreshCodexTokensWithRetry } from '../../src/auth/oauth-handlers.js';

// Minimal valid config — enough to construct the service without touching the FS.
const makeService = () => {
    const svc = new CodexApiService({
        CODEX_OAUTH_CREDS_FILE_PATH: '/tmp/test-codex-creds.json',
        uuid: 'test-uuid-001',
    });
    // Pre-populate in-memory state to skip file I/O in tests.
    svc.accessToken = 'access-token-old';
    svc.refreshToken = 'refresh-token-old';
    svc.accountId = 'acct-123';
    svc.email = 'test@example.com';
    svc.expiresAt = new Date(Date.now() + 7200 * 1000); // 2h from now — not near expiry
    svc.isInitialized = true;
    return svc;
};

describe('Bug 3: CodexApiService reactive 401 token refresh', () => {
    let service;
    let axiosSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        service = makeService();
    });

    test('generateContent retries once after 401 when inline token refresh succeeds', async () => {
        const auth401 = Object.assign(new Error('Unauthorized'), {
            response: { status: 401, data: 'Unauthorized' },
        });
        const successResponse = {
            data: 'data: {"type":"response.completed","response":{"id":"test-id","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}\n\n',
        };

        // Simulate: axios first 401, then success after refresh.
        axiosSpy = jest.spyOn(axios, 'request')
            .mockRejectedValueOnce(auth401)
            .mockResolvedValueOnce(successResponse);

        // refreshCodexTokensWithRetry succeeds and returns new tokens.
        refreshCodexTokensWithRetry.mockResolvedValueOnce({
            access_token: 'access-token-new',
            refresh_token: 'refresh-token-new',
            account_id: 'acct-123',
            email: 'test@example.com',
            expired: new Date(Date.now() + 3600 * 1000).toISOString(),
        });

        // Mock saveCredentials so we don't hit the filesystem.
        service.saveCredentials = jest.fn().mockResolvedValue(undefined);

        await service.generateContent('gpt-5.5', { messages: [{ role: 'user', content: 'hi' }] });

        // Must have called axios twice: once for the 401, once for the retry.
        expect(axiosSpy).toHaveBeenCalledTimes(2);
        // Must have attempted token refresh exactly once.
        expect(refreshCodexTokensWithRetry).toHaveBeenCalledTimes(1);
        // Access token must be updated to the new value.
        expect(service.accessToken).toBe('access-token-new');
    });

    test('generateContent propagates 401 immediately when token refresh fails', async () => {
        const auth401 = Object.assign(new Error('Unauthorized'), {
            response: { status: 401, data: 'Unauthorized' },
        });
        axiosSpy = jest.spyOn(axios, 'request').mockRejectedValue(auth401);

        // refreshCodexTokensWithRetry fails.
        refreshCodexTokensWithRetry.mockRejectedValueOnce(new Error('Refresh failed'));

        service.saveCredentials = jest.fn().mockResolvedValue(undefined);

        await expect(
            service.generateContent('gpt-5.5', { messages: [{ role: 'user', content: 'hi' }] })
        ).rejects.toThrow();

        // Only 1 axios call — no retry after failed refresh.
        expect(axiosSpy).toHaveBeenCalledTimes(1);
        expect(refreshCodexTokensWithRetry).toHaveBeenCalledTimes(1);
    });

    test('generateContent does not enter infinite 401 retry loop', async () => {
        const auth401 = Object.assign(new Error('Unauthorized'), {
            response: { status: 401, data: 'Unauthorized' },
        });
        // Both requests return 401 (refresh "succeeds" but token is still invalid).
        axiosSpy = jest.spyOn(axios, 'request').mockRejectedValue(auth401);

        refreshCodexTokensWithRetry.mockResolvedValue({
            access_token: 'still-invalid-token',
            refresh_token: 'refresh-token-new',
            account_id: 'acct-123',
            email: 'test@example.com',
            expired: new Date(Date.now() + 3600 * 1000).toISOString(),
        });

        service.saveCredentials = jest.fn().mockResolvedValue(undefined);

        await expect(
            service.generateContent('gpt-5.5', { messages: [{ role: 'user', content: 'hi' }] })
        ).rejects.toThrow();

        // Must not loop: 1 initial attempt + 1 post-refresh retry = 2 total, never more.
        expect(axiosSpy).toHaveBeenCalledTimes(2);
        // Refresh attempted exactly once.
        expect(refreshCodexTokensWithRetry).toHaveBeenCalledTimes(1);
    });
});
