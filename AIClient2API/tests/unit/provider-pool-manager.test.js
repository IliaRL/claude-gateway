/**
 * Unit tests for ProviderPoolManager — account rotation + 3-level fallback.
 *
 * Design notes:
 * - Constructor: new ProviderPoolManager(providerPools, options)
 *   providerPools = { [providerType]: [accountConfig, ...] }
 *   options.globalConfig.providerFallbackChain / modelFallbackMapping supply L2/L3 config
 * - Cold-start clears modelCooldowns, usageCount, errorCount; sets isHealthy/isDisabled defaults.
 * - selectProvider returns the raw account config object (or null).
 * - selectProviderWithFallback returns { config, actualProviderType, isFallback, actualModel } (or null).
 * - Per-pool model cooldowns: account.modelCooldowns[model] = ISO expiry string.
 * - Provider-wide model cooldowns: manager._cooldownManager (CooldownManager).
 */

// ── Stub every heavy dependency that the pool-manager import chain pulls in ──

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
jest.mock('../../src/utils/health-guard.js', () => ({
    healthGuard: { check: () => Promise.resolve(true) },
}));
jest.mock('../../src/utils/request-handlers.js', () => ({
    buildFriendlyDisplayName: (m) => m,
    buildModelEntry: (m) => ({ id: m }),
}));
jest.mock('../../src/convert/convert.js', () => ({
    convertData: () => ({}),
    convertStream: () => ({}),
}));
// provider-models: return empty model lists so no catalog filtering blocks accounts
jest.mock('../../src/providers/provider-models.js', () => ({
    getConfiguredSupportedModels: () => [],
    getCustomModelListProvider: () => null,
    getProviderModels: () => [],
    normalizeModelIds: (m) => m,
    PROVIDER_MODELS: {},
    MANAGED_MODEL_LIST_PROVIDERS: [],
    getManagedModelListProviderType: () => null,
    usesManagedModelList: () => false,
    getCustomModelActualProvider: () => null,
    getCustomModelConfig: () => null,
    extractModelIdsFromNativeList: () => [],
    customModelMatchesProvider: () => false,
}));

import { ProviderPoolManager } from '../../src/providers/provider-pool-manager.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Make a minimal account config. Defaults to healthy, enabled, no cooldowns.
 */
function makeAccount(overrides = {}) {
    return {
        uuid: `uuid-${Math.random().toString(36).slice(2)}`,
        customName: 'test-account',
        isHealthy: true,
        isDisabled: false,
        usageCount: 0,
        errorCount: 0,
        modelCooldowns: {},
        notSupportedModels: [],
        needsRefresh: false,
        ...overrides,
    };
}

/**
 * Build a ProviderPoolManager with the given pools and optional globalConfig.
 * Silences background timers by keeping bufferDelay=0.
 */
function makeManager(providerPools, globalConfig = {}) {
    return new ProviderPoolManager(providerPools, {
        globalConfig: {
            providerFallbackChain: {},
            modelFallbackMapping: {},
            REFRESH_BUFFER_DELAY: 0,
            WARMUP_TARGET: 0,
            ...globalConfig,
        },
        maxErrorCount: 10,
        saveDebounceTime: 0,
    });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ProviderPoolManager — construction & initialization', () => {
    test('constructs without throwing given a valid pool', () => {
        expect(() =>
            makeManager({ 'gemini-cli-oauth': [makeAccount()] })
        ).not.toThrow();
    });

    test('auto-generates uuid when account is missing one', () => {
        const acct = makeAccount();
        delete acct.uuid;
        const mgr = makeManager({ 'gemini-cli-oauth': [acct] });
        const status = mgr.providerStatus['gemini-cli-oauth'];
        expect(status[0].config.uuid).toBeTruthy();
    });

    test('defaults isHealthy=true and isDisabled=false when missing', () => {
        const acct = { customName: 'bare-acct' }; // no health flags
        const mgr = makeManager({ 'gemini-cli-oauth': [acct] });
        const cfg = mgr.providerStatus['gemini-cli-oauth'][0].config;
        expect(cfg.isHealthy).toBe(true);
        expect(cfg.isDisabled).toBe(false);
    });

    test('cold-start resets modelCooldowns, usageCount, errorCount to zero', () => {
        const acct = makeAccount({ usageCount: 99, errorCount: 5, modelCooldowns: { 'gemini-2.0-flash': new Date(Date.now() + 9999).toISOString() } });
        const mgr = makeManager({ 'gemini-cli-oauth': [acct] });
        const cfg = mgr.providerStatus['gemini-cli-oauth'][0].config;
        expect(cfg.usageCount).toBe(0);
        expect(cfg.errorCount).toBe(0);
        expect(cfg.modelCooldowns).toEqual({});
    });

    test('empty provider pool is accepted (no status entries)', () => {
        const mgr = makeManager({ 'gemini-cli-oauth': [] });
        expect(mgr.providerStatus['gemini-cli-oauth']).toEqual([]);
    });
});

// ── selectProvider ──────────────────────────────────────────────────────────

describe('ProviderPoolManager.selectProvider — basic selection', () => {
    test('returns config for a healthy, enabled account', async () => {
        const acct = makeAccount({ customName: 'ok-account' });
        const mgr = makeManager({ 'gemini-cli-oauth': [acct] });
        const result = await mgr.selectProvider('gemini-cli-oauth');
        expect(result).toBeTruthy();
        expect(result.customName).toBe('ok-account');
    });

    test('returns null for an unknown providerType', async () => {
        const mgr = makeManager({ 'gemini-cli-oauth': [makeAccount()] });
        const result = await mgr.selectProvider('does-not-exist');
        expect(result).toBeNull();
    });

    test('returns null when pool is empty', async () => {
        const mgr = makeManager({ 'gemini-cli-oauth': [] });
        const result = await mgr.selectProvider('gemini-cli-oauth');
        expect(result).toBeNull();
    });

    test('skips disabled account (isDisabled=true)', async () => {
        const disabled = makeAccount({ customName: 'disabled', isDisabled: true });
        const mgr = makeManager({ 'gemini-cli-oauth': [disabled] });
        const result = await mgr.selectProvider('gemini-cli-oauth');
        expect(result).toBeNull();
    });

    test('skips unhealthy account (isHealthy=false)', async () => {
        const sick = makeAccount({ customName: 'sick', isHealthy: false });
        const mgr = makeManager({ 'gemini-cli-oauth': [sick] });
        const result = await mgr.selectProvider('gemini-cli-oauth');
        expect(result).toBeNull();
    });

    test('skips needsRefresh account', async () => {
        const stale = makeAccount({ customName: 'stale', needsRefresh: true });
        const mgr = makeManager({ 'gemini-cli-oauth': [stale] });
        const result = await mgr.selectProvider('gemini-cli-oauth');
        expect(result).toBeNull();
    });

    test('selects healthy account when pool contains mixed healthy/disabled', async () => {
        const disabled = makeAccount({ customName: 'disabled', isDisabled: true });
        const healthy = makeAccount({ customName: 'healthy' });
        const mgr = makeManager({ 'gemini-cli-oauth': [disabled, healthy] });
        const result = await mgr.selectProvider('gemini-cli-oauth');
        expect(result).toBeTruthy();
        expect(result.customName).toBe('healthy');
    });

    test('increments usageCount on selection (without skipUsageCount)', async () => {
        const acct = makeAccount();
        const mgr = makeManager({ 'gemini-cli-oauth': [acct] });
        await mgr.selectProvider('gemini-cli-oauth');
        const cfg = mgr.providerStatus['gemini-cli-oauth'][0].config;
        expect(cfg.usageCount).toBe(1);
    });

    test('does NOT increment usageCount when skipUsageCount=true', async () => {
        const acct = makeAccount();
        const mgr = makeManager({ 'gemini-cli-oauth': [acct] });
        await mgr.selectProvider('gemini-cli-oauth', null, { skipUsageCount: true });
        const cfg = mgr.providerStatus['gemini-cli-oauth'][0].config;
        expect(cfg.usageCount).toBe(0);
    });
});

// ── Per-account model cooldowns ─────────────────────────────────────────────

describe('ProviderPoolManager.selectProvider — per-account model cooldowns', () => {
    test('skips account whose modelCooldowns[model] is in the future', async () => {
        const futureExpiry = new Date(Date.now() + 60_000).toISOString();
        // Bypass cold-start reset by using syncFromConfig path
        const mgr = makeManager({ 'gemini-cli-oauth': [] });
        // Inject account after construction to avoid cold-start clear
        const acct = makeAccount({
            customName: 'cooled',
            modelCooldowns: { 'gemini-2.0-flash': futureExpiry },
        });
        mgr.providerStatus['gemini-cli-oauth'] = [{
            config: acct,
            uuid: acct.uuid,
            type: 'gemini-cli-oauth',
            state: { activeCount: 0, waitingCount: 0, queue: [] },
        }];

        const result = await mgr.selectProvider('gemini-cli-oauth', 'gemini-2.0-flash');
        expect(result).toBeNull();
    });

    test('selects account when modelCooldowns[model] expiry is in the past', async () => {
        const pastExpiry = new Date(Date.now() - 1000).toISOString();
        const mgr = makeManager({ 'gemini-cli-oauth': [] });
        const acct = makeAccount({
            customName: 'cooled-expired',
            modelCooldowns: { 'gemini-2.0-flash': pastExpiry },
        });
        mgr.providerStatus['gemini-cli-oauth'] = [{
            config: acct,
            uuid: acct.uuid,
            type: 'gemini-cli-oauth',
            state: { activeCount: 0, waitingCount: 0, queue: [] },
        }];

        const result = await mgr.selectProvider('gemini-cli-oauth', 'gemini-2.0-flash');
        expect(result).toBeTruthy();
        expect(result.customName).toBe('cooled-expired');
    });

    test('selects uncooled account when another account for same provider has model on cooldown', async () => {
        const futureExpiry = new Date(Date.now() + 60_000).toISOString();
        const mgr = makeManager({ 'gemini-cli-oauth': [] });
        const cooled = makeAccount({ customName: 'cooled', modelCooldowns: { 'gemini-2.0-flash': futureExpiry } });
        const fine = makeAccount({ customName: 'fine', modelCooldowns: {} });

        mgr.providerStatus['gemini-cli-oauth'] = [
            { config: cooled, uuid: cooled.uuid, type: 'gemini-cli-oauth', state: { activeCount: 0, waitingCount: 0, queue: [] } },
            { config: fine, uuid: fine.uuid, type: 'gemini-cli-oauth', state: { activeCount: 0, waitingCount: 0, queue: [] } },
        ];

        const result = await mgr.selectProvider('gemini-cli-oauth', 'gemini-2.0-flash');
        expect(result).toBeTruthy();
        expect(result.customName).toBe('fine');
    });

    test('markModelCooldownForAccount sets per-account model cooldown', async () => {
        const mgr = makeManager({ 'gemini-cli-oauth': [] });
        const acct = makeAccount({ customName: 'to-cool' });
        mgr.providerStatus['gemini-cli-oauth'] = [{
            config: acct,
            uuid: acct.uuid,
            type: 'gemini-cli-oauth',
            state: { activeCount: 0, waitingCount: 0, queue: [] },
        }];

        mgr.markModelCooldownForAccount('gemini-cli-oauth', acct.uuid, 'gemini-2.0-flash', 60_000);
        expect(acct.modelCooldowns['gemini-2.0-flash']).toBeTruthy();

        const expiry = Date.parse(acct.modelCooldowns['gemini-2.0-flash']);
        expect(expiry).toBeGreaterThan(Date.now());
    });
});

// ── Provider-wide model cooldowns (CooldownManager) ─────────────────────────

describe('ProviderPoolManager — provider-wide model cooldowns', () => {
    test('isModelOnCooldown returns false when no cooldown is set', () => {
        const mgr = makeManager({ 'gemini-cli-oauth': [makeAccount()] });
        expect(mgr.isModelOnCooldown('gemini-cli-oauth', 'gemini-2.0-flash')).toBe(false);
    });

    test('selectProvider returns null when provider-wide model cooldown is active', async () => {
        const mgr = makeManager({ 'gemini-cli-oauth': [makeAccount()] });
        // Mark provider-wide cooldown via the CooldownManager
        mgr._cooldownManager.mark('gemini-cli-oauth', 'gemini-2.0-flash', 60_000);
        const result = await mgr.selectProvider('gemini-cli-oauth', 'gemini-2.0-flash');
        expect(result).toBeNull();
    });

    test('selectProvider succeeds for a different model when one model is on provider-wide cooldown', async () => {
        const mgr = makeManager({ 'gemini-cli-oauth': [makeAccount({ customName: 'ok' })] });
        mgr._cooldownManager.mark('gemini-cli-oauth', 'gemini-2.0-flash', 60_000);
        // Request a different model — not on cooldown
        const result = await mgr.selectProvider('gemini-cli-oauth', 'gemini-1.5-pro');
        expect(result).toBeTruthy();
        expect(result.customName).toBe('ok');
    });
});

// ── L1 exhaustion ───────────────────────────────────────────────────────────

describe('ProviderPoolManager — L1 exhaustion', () => {
    test('selectProvider returns null when ALL accounts are disabled', async () => {
        const pool = [
            makeAccount({ isDisabled: true }),
            makeAccount({ isDisabled: true }),
        ];
        const mgr = makeManager({ 'gemini-cli-oauth': pool });
        expect(await mgr.selectProvider('gemini-cli-oauth')).toBeNull();
    });

    test('selectProvider returns null when ALL accounts are unhealthy', async () => {
        const pool = [
            makeAccount({ isHealthy: false }),
            makeAccount({ isHealthy: false }),
        ];
        const mgr = makeManager({ 'gemini-cli-oauth': pool });
        expect(await mgr.selectProvider('gemini-cli-oauth')).toBeNull();
    });

    test('isAllProvidersUnhealthy returns true when all accounts are disabled/unhealthy', () => {
        const pool = [makeAccount({ isHealthy: false }), makeAccount({ isDisabled: true })];
        const mgr = makeManager({ 'gemini-cli-oauth': pool });
        expect(mgr.isAllProvidersUnhealthy('gemini-cli-oauth')).toBe(true);
    });

    test('isAllProvidersUnhealthy returns false when at least one account is healthy+enabled', () => {
        const pool = [makeAccount({ isHealthy: false }), makeAccount()];
        const mgr = makeManager({ 'gemini-cli-oauth': pool });
        expect(mgr.isAllProvidersUnhealthy('gemini-cli-oauth')).toBe(false);
    });
});

// ── L2 — horizontal provider fallback chain ─────────────────────────────────

describe('ProviderPoolManager.selectProviderWithFallback — L2 provider chain', () => {
    test('returns primary provider result when healthy', async () => {
        const primary = makeAccount({ customName: 'primary' });
        const mgr = makeManager(
            { 'gemini-cli-oauth': [primary], 'gemini-antigravity': [makeAccount({ customName: 'fallback' })] },
            { providerFallbackChain: { 'gemini-cli-oauth': ['gemini-antigravity'] } }
        );
        const result = await mgr.selectProviderWithFallback('gemini-cli-oauth');
        expect(result).toBeTruthy();
        expect(result.actualProviderType).toBe('gemini-cli-oauth');
        expect(result.isFallback).toBe(false);
        expect(result.config.customName).toBe('primary');
    });

    test('falls back to next provider in chain when primary is exhausted', async () => {
        const sick = makeAccount({ customName: 'sick', isHealthy: false });
        const fallback = makeAccount({ customName: 'fallback' });
        const mgr = makeManager(
            { 'gemini-cli-oauth': [sick], 'gemini-antigravity': [fallback] },
            { providerFallbackChain: { 'gemini-cli-oauth': ['gemini-antigravity'] } }
        );
        const result = await mgr.selectProviderWithFallback('gemini-cli-oauth');
        expect(result).toBeTruthy();
        expect(result.actualProviderType).toBe('gemini-antigravity');
        expect(result.isFallback).toBe(true);
        expect(result.config.customName).toBe('fallback');
    });

    test('returns null when primary AND all fallback providers are exhausted', async () => {
        const mgr = makeManager(
            {
                'gemini-cli-oauth': [makeAccount({ isHealthy: false })],
                'gemini-antigravity': [makeAccount({ isDisabled: true })],
            },
            { providerFallbackChain: { 'gemini-cli-oauth': ['gemini-antigravity'] } }
        );
        const result = await mgr.selectProviderWithFallback('gemini-cli-oauth');
        expect(result).toBeNull();
    });

    test('result shape contains config, actualProviderType, isFallback, actualModel', async () => {
        const acct = makeAccount({ customName: 'single' });
        const mgr = makeManager({ 'gemini-cli-oauth': [acct] });
        const result = await mgr.selectProviderWithFallback('gemini-cli-oauth', 'gemini-2.0-flash');
        expect(result).toHaveProperty('config');
        expect(result).toHaveProperty('actualProviderType');
        expect(result).toHaveProperty('isFallback');
        expect(result).toHaveProperty('actualModel');
        expect(result.actualModel).toBe('gemini-2.0-flash');
    });
});

// ── L3 — model fallback mapping ─────────────────────────────────────────────

describe('ProviderPoolManager.selectProviderWithFallback — L3 model downgrade', () => {
    test('downgrades model when primary model is exhausted across all providers', async () => {
        // Strategy: build the manager first (cold-start clears all accounts),
        // then REPLACE providerStatus entries with fresh objects that have the desired
        // cooldown/notSupportedModels already set — bypassing the constructor's cold-start clear.
        //
        // provider-alpha: account has 'model-a' in per-account cooldown → cannot serve it.
        // provider-beta:  account has notSupportedModels=['model-a'] so the horizontal
        //                 exhaustion guard (_hasAnyHealthyAccountForModel) sees no healthy
        //                 slot for 'model-a' anywhere → model downgrade is allowed.
        // modelFallbackMapping maps 'model-a' → provider-beta / 'model-b'.

        const mgr = makeManager(
            {
                'provider-alpha': [makeAccount()], // placeholder — will be replaced below
                'provider-beta':  [makeAccount()], // placeholder — will be replaced below
            },
            {
                providerFallbackChain: {},
                modelFallbackMapping: {
                    'model-a': { targetProviderType: 'provider-beta', targetModel: 'model-b' },
                },
            }
        );

        // Build fresh account objects AFTER construction so cold-start mutations don't touch them
        const futureExpiry = new Date(Date.now() + 60_000).toISOString();
        const modelAAcct = {
            uuid: 'uuid-alpha-001',
            customName: 'model-a-acct',
            isHealthy: true,
            isDisabled: false,
            needsRefresh: false,
            usageCount: 0,
            errorCount: 0,
            notSupportedModels: [],
            modelCooldowns: { 'model-a': futureExpiry }, // future → account skipped for model-a
        };
        const modelBAcct = {
            uuid: 'uuid-beta-001',
            customName: 'model-b-acct',
            isHealthy: true,
            isDisabled: false,
            needsRefresh: false,
            usageCount: 0,
            errorCount: 0,
            // Signals this account cannot serve 'model-a', so the horizontal guard
            // won't count it as a healthy slot for 'model-a'.
            notSupportedModels: ['model-a'],
            modelCooldowns: {},
        };

        mgr.providerStatus['provider-alpha'] = [{
            config: modelAAcct,
            uuid: modelAAcct.uuid,
            type: 'provider-alpha',
            state: { activeCount: 0, waitingCount: 0, queue: [] },
        }];
        mgr.providerStatus['provider-beta'] = [{
            config: modelBAcct,
            uuid: modelBAcct.uuid,
            type: 'provider-beta',
            state: { activeCount: 0, waitingCount: 0, queue: [] },
        }];

        const result = await mgr.selectProviderWithFallback('provider-alpha', 'model-a');
        expect(result).toBeTruthy();
        expect(result.actualModel).toBe('model-b');
        expect(result.actualProviderType).toBe('provider-beta');
        expect(result.isFallback).toBe(true);
    });
});

// ── Cycle guard ──────────────────────────────────────────────────────────────

describe('ProviderPoolManager — cycle guard', () => {
    test(
        'circular modelFallbackMapping terminates without infinite loop',
        async () => {
            // model-x -> model-y -> model-x (cycle)
            const mgr = makeManager(
                { 'provider-alpha': [makeAccount({ isHealthy: false })] },
                {
                    providerFallbackChain: {},
                    modelFallbackMapping: {
                        'model-x': { targetProviderType: 'provider-alpha', targetModel: 'model-y' },
                        'model-y': { targetProviderType: 'provider-alpha', targetModel: 'model-x' },
                    },
                }
            );

            const result = await mgr.selectProviderWithFallback('provider-alpha', 'model-x');
            // Cycle guard should break the loop and return null (no healthy accounts)
            expect(result).toBeNull();
        },
        5000 // safety timeout
    );

    test('invalid providerType string returns null without throwing', async () => {
        const mgr = makeManager({});
        const result = await mgr.selectProviderWithFallback('');
        expect(result).toBeNull();
    });
});

// ── getFallbackChain / setFallbackChain ─────────────────────────────────────

describe('ProviderPoolManager — fallback chain management', () => {
    test('getFallbackChain returns empty array when none configured', () => {
        const mgr = makeManager({});
        expect(mgr.getFallbackChain('gemini-cli-oauth')).toEqual([]);
    });

    test('setFallbackChain updates the chain and getFallbackChain reflects it', () => {
        const mgr = makeManager({});
        mgr.setFallbackChain('gemini-cli-oauth', ['gemini-antigravity', 'nvidia-nim']);
        expect(mgr.getFallbackChain('gemini-cli-oauth')).toEqual(['gemini-antigravity', 'nvidia-nim']);
    });
});
