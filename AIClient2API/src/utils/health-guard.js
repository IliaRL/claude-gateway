// src/utils/health-guard.js
import logger from './logger.js';

const DEFAULTS = {
  maxConsecutive401s: 3,
  permanentFailureWindowMs: 600_000, // 10 minutes
};

export class HealthGuard {
  constructor(config = {}) {
    this._config = { ...DEFAULTS, ...config };
    this._failures = new Map(); // uuid → { count, firstSeen }
    this._poolManager = null;
  }

  /** Call once the pool manager is initialized. */
  attach(poolManager) {
    this._poolManager = poolManager;
  }

  /**
   * Record an auth failure (HTTP 401) for an account.
   * Auto-disables the account after maxConsecutive401s consecutive failures
   * within permanentFailureWindowMs.
   */
  recordAuthFailure(uuid, providerType, providerConfig) {
    const now = Date.now();
    const existing = this._failures.get(uuid);

    if (existing && (now - existing.firstSeen) > this._config.permanentFailureWindowMs) {
      // Window expired — treat this as the first failure in a new window
      this._failures.set(uuid, { count: 1, firstSeen: now });
      return;
    }

    const count = (existing?.count ?? 0) + 1;
    this._failures.set(uuid, { count, firstSeen: existing?.firstSeen ?? now });

    if (count >= this._config.maxConsecutive401s) {
      this._autoDisable(uuid, providerType, providerConfig, count);
    }
  }

  /** Call on any successful response — resets the failure counter for that account. */
  recordSuccess(uuid) {
    this._failures.delete(uuid);
  }

  _autoDisable(uuid, providerType, providerConfig, count) {
    if (!this._poolManager) {
      logger.warn(`[HealthGuard] No pool manager attached — cannot disable ${uuid}`);
      return;
    }
    try {
      this._poolManager.disableProvider(providerType, providerConfig);
      logger.warn(`[HealthGuard] Auto-disabled ${uuid} (${providerType}): 401 ×${count} consecutive. Use /provider_health reset to re-enable.`);
      this._failures.delete(uuid);
    } catch (err) {
      logger.error(`[HealthGuard] Auto-disable failed for ${uuid}: ${err.message}`);
    }
  }
}

/** Singleton — import this wherever auth failures are caught. */
export const healthGuard = new HealthGuard();
