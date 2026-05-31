import { readFileSync, writeFileSync } from 'fs';
import logger from './logger.js';

/**
 * Validates provider_pools.json at startup and repairs known corruption patterns.
 *
 * CLAUDE.md Rule 10: `modelCooldowns` must be a plain object.
 * It can become the string "[object Object]", null, or an array due to
 * serialization bugs. This repairs those cases before the pool manager loads.
 *
 * @param {string} poolsFilePath  Absolute or relative path to provider_pools.json
 */
export function validateAndRepairProviderPools(poolsFilePath) {
  let data;
  try {
    data = JSON.parse(readFileSync(poolsFilePath, 'utf8'));
  } catch (err) {
    // Missing file or parse error — pool manager will handle it; nothing to repair
    logger.warn(`[PoolsValidator] Skipping validation: ${err.message}`);
    return;
  }

  let repaired = 0;

  for (const [providerType, accounts] of Object.entries(data)) {
    if (!Array.isArray(accounts)) continue;

    for (const account of accounts) {
      if (!account || typeof account !== 'object') continue;

      const cd = account.modelCooldowns;
      const isBroken =
        cd === null ||
        Array.isArray(cd) ||
        typeof cd === 'string' ||
        typeof cd === 'number';

      if (isBroken) {
        logger.warn(
          `[PoolsValidator] Repaired modelCooldowns for ${account.uuid ?? 'unknown'} ` +
          `(${providerType}): was ${JSON.stringify(cd)}`
        );
        account.modelCooldowns = {};
        repaired++;
      }
    }
  }

  if (repaired > 0) {
    try {
      writeFileSync(poolsFilePath, JSON.stringify(data, null, 2), 'utf8');
      logger.info(`[PoolsValidator] Wrote ${repaired} repair(s) back to ${poolsFilePath}`);
    } catch (writeErr) {
      logger.error(`[PoolsValidator] Write failed after repair: ${writeErr.message}`);
    }
  }
}
