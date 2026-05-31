/**
 * Bug 1: nvidia-nim DEFAULT_HEALTH_CHECK_MODEL references a dead model.
 *
 * meta/llama-3.3-70b-instruct was explicitly removed from the nvidia-nim catalog
 * on 2026-05-26 (see provider-models.js comment). DEFAULT_HEALTH_CHECK_MODELS
 * still points to it, so any health check invocation will 404 at NVIDIA and
 * mark the account unhealthy.
 *
 * Fix: Change to meta/llama-3.2-3b-instruct (the fastest model in the current
 * catalog, consistent with provider_pools.json checkModelName).
 */

// Stub heavy dependencies that the pool-manager import chain pulls in.
jest.mock('../../src/utils/file-lock.js', () => ({
    withFileLock: async (_, fn) => fn(),
    atomicWriteFile: async () => {},
}));
jest.mock('../../src/utils/cockpit-quota.js', () => ({
    getQuotaScore: () => 0,
    markQuotaUsed: () => {},
    initCockpitPoller: () => {},
}));
jest.mock('../../src/converters/utils.js', () => ({
    MODEL_CONTEXT_WINDOWS: {},
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
jest.mock('../../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: () => {},
}));
jest.mock('../../src/providers/adapter.js', () => ({
    getServiceAdapter: () => ({}),
    getRegisteredProviders: () => [],
    invalidateServiceAdapter: () => {},
}));

import { ProviderPoolManager } from '../../src/providers/provider-pool-manager.js';
import { PROVIDER_MODELS } from '../../src/providers/provider-models.js';

describe('Bug 1: nvidia-nim DEFAULT_HEALTH_CHECK_MODELS references a live catalog entry', () => {
    test('DEFAULT_HEALTH_CHECK_MODELS.nvidia-nim is present in PROVIDER_MODELS[nvidia-nim]', () => {
        const healthModel = ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS['nvidia-nim'];
        const catalogModels = PROVIDER_MODELS['nvidia-nim'] || [];

        expect(healthModel).toBeTruthy();
        expect(catalogModels).toContain(healthModel);
    });

    test('PROVIDER_MODELS[nvidia-nim] does not contain the removed meta/llama-3.3-70b-instruct', () => {
        const catalogModels = PROVIDER_MODELS['nvidia-nim'] || [];
        // This model was explicitly removed 2026-05-26 due to cold-start latency > 30s.
        expect(catalogModels).not.toContain('meta/llama-3.3-70b-instruct');
    });

    test('DEFAULT_HEALTH_CHECK_MODELS.nvidia-nim is the fastest available model', () => {
        // meta/llama-3.2-3b-instruct is listed first (fastest-first ordering) in the catalog.
        const healthModel = ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS['nvidia-nim'];
        const catalogModels = PROVIDER_MODELS['nvidia-nim'] || [];
        const firstInCatalog = catalogModels[0];
        // The health check model should be the fastest (first) model, minimising check latency.
        expect(healthModel).toBe(firstInCatalog);
    });
});
