import logger from './logger.js';

export class HealthGuard {
  constructor() {
    this._failures = new Map(); // uuid → { count, firstSeen }
    this._poolManager = null;
  }

  /** Attach to the live pool manager instance after it is created. */
  attach(poolManager) {
    this._poolManager = poolManager;
  }

  recordAuthFailure(_uuid, _providerType, _providerConfig) {}

  recordSuccess(_uuid) {}
}

/** Singleton — import this in all integration points. */
export const healthGuard = new HealthGuard();
