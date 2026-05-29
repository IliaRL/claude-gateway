'use strict';

import { readFileSync, existsSync } from 'fs';
import { getConfiguredSupportedModels, getProviderModels } from '../providers/provider-models.js';

const POLL_INTERVAL_MS = 30_000;

/**
 * PreflightHealthMonitor — advisory background poller.
 *
 * Polls the provider pool every 30 s and caches per-model availability
 * (healthy account count + available boolean) at account level, respecting
 * per-account model cooldowns.  This is advisory only — real-time routing
 * in selectProviderWithFallback() still validates accounts at request time.
 */
class PreflightHealthMonitor {
    constructor(poolManager) {
        this._poolManager = poolManager;
        // Map<modelId, { available: boolean, checkedAt: number, healthyAccounts: number }>
        this._cache = new Map();
        this._timer = null;
    }

    start() {
        this._poll();
        this._timer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
        this._timer.unref(); // don't block process exit
        console.info('[Preflight] PreflightHealthMonitor started (30s interval).');
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    /** Returns true if model has at least one healthy account, false if none, null if unknown (not yet polled) */
    isAvailable(modelId) {
        const entry = this._cache.get(modelId);
        if (!entry) return null;
        return entry.available;
    }

    healthyAccountCount(modelId) {
        return this._cache.get(modelId)?.healthyAccounts ?? 0;
    }

    getCacheSnapshot() {
        return Object.fromEntries(this._cache);
    }

    _poll() {
        try {
            // providerStatus is keyed by providerType; each value is an array of
            // provider node objects with a .config sub-object (see provider-pool-manager.js).
            const providerStatus = this._poolManager.providerStatus ?? {};
            const modelAvailability = new Map();

            for (const [providerType, accounts] of Object.entries(providerStatus)) {
                if (!Array.isArray(accounts)) continue;
                for (const acct of accounts) {
                    const cfg = acct.config;
                    if (!cfg) continue;
                    if (cfg.isDisabled || cfg.needsReauth || cfg.isHealthy === false) continue;

                    // Proactive OAuth token expiry check for file-based Kiro credentials.
                    // Reads expiresAt from the credential file (not the pool config) every 30s.
                    if (cfg.KIRO_OAUTH_CREDS_FILE_PATH && existsSync(cfg.KIRO_OAUTH_CREDS_FILE_PATH)) {
                        try {
                            const creds = JSON.parse(readFileSync(cfg.KIRO_OAUTH_CREDS_FILE_PATH, 'utf8'));
                            if (creds.expiresAt) {
                                const msUntilExpiry = new Date(creds.expiresAt).getTime() - Date.now();
                                if (msUntilExpiry <= 30_000) {
                                    // Token expired or within 30s buffer — skip; do not count as available.
                                    continue;
                                }
                                if (msUntilExpiry < 30 * 60 * 1000 && !cfg.needsRefresh) {
                                    // Token expiring within 30 minutes — flag for background refresh.
                                    cfg.needsRefresh = true;
                                    console.info(`[Preflight] Kiro token near expiry (${Math.round(msUntilExpiry / 60000)}min) — flagging needsRefresh.`);
                                }
                            }
                        } catch {
                            // Non-critical read error — continue without expiry check.
                        }
                    }

                    // Resolve the models this account supports — prefer per-account config,
                    // fall back to the provider-level model list.
                    const supportedModels =
                        (getConfiguredSupportedModels(providerType, cfg).length > 0
                            ? getConfiguredSupportedModels(providerType, cfg)
                            : getProviderModels(providerType));

                    for (const modelId of supportedModels) {
                        // Skip accounts that have a per-account model cooldown for this model.
                        if (this._poolManager._accountHasModelCooldown?.(cfg, modelId)) continue;

                        const entry = modelAvailability.get(modelId) ?? { available: false, healthyAccounts: 0 };
                        entry.available = true;
                        entry.healthyAccounts += 1;
                        modelAvailability.set(modelId, entry);
                    }
                }
            }

            const now = Date.now();
            for (const [modelId, status] of modelAvailability) {
                this._cache.set(modelId, { ...status, checkedAt: now });
            }
        } catch (err) {
            // Preflight errors must never crash the proxy.
            console.error('[Preflight] Poll error:', err.message);
        }
    }
}

export { PreflightHealthMonitor };
export default PreflightHealthMonitor;
