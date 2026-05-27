# Enhanced Model Fallback Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a two-tiered model fallback strategy that first exhausts a specific model across all its available providers/accounts before falling back to the next high-quality model, enhancing robustness and efficiency.

**Architecture:** The core logic will reside within `src/providers/provider-pool-manager.js`, modifying `selectProviderWithFallback`. It will use new internal helpers (`_getAllProvidersSupportingModel`, `_getProviderConfigForAccount`) to identify all providers supporting a given model, iterate through their accounts, and implement circular fallback detection. `configs/config.json`'s `modelFallbackMapping` will define model-to-model fallbacks.

**Tech Stack:** Node.js, `ProviderPoolManager`, `DynamicProviderModels`, `deepmerge`, `fs`.

---

### Task 1: Create `_getAllProvidersSupportingModel` and `_getProviderConfigForAccount` helpers

**Files:**
- Modify: `src/providers/provider-pool-manager.js`
- Modify: `src/providers/provider-models.js`

- [ ] **Step 1: Add a helper method to `DynamicProviderModels` to efficiently find providers supporting a model.**
  This helper will iterate through all registered providers and their models to identify which providers offer the requested model.

  ```javascript
  // src/providers/provider-models.js
  // Add to DynamicProviderModels class
  
  /**
   * Finds all providerTypes that offer a specific model.
   * @param {string} modelId - The ID of the model to search for.
   * @returns {Array<{providerType: string, isManaged: boolean}>} An array of objects containing providerType and if it's a managed list.
   */
  getAllProviderTypesForModel(modelId) {
      const supportingProviders = new Map(); // Use a Map to store unique providerTypes and their managed status
  
      // Iterate through statically defined models
      for (const providerType in this._staticProviderModels) {
          if (this._staticProviderModels[providerType].includes(modelId)) {
              supportingProviders.set(providerType, { providerType, isManaged: false });
          }
      }
  
      // Iterate through dynamically managed models
      for (const providerType in this.managedProviderModels) {
          if (this.managedProviderModels[providerType].includes(modelId)) {
              supportingProviders.set(providerType, { providerType, isManaged: true });
          }
      }
  
      return Array.from(supportingProviders.values());
  }
  
  // Add a helper method to check if a provider supports a model
  doesProviderSupportModel(providerStatus, modelId) {
      const providerType = providerStatus.type;
      // Get all models for this specific providerStatus (account)
      const models = this.getProviderModels(providerType, providerStatus.config);
      return models.includes(modelId);
  }
  ```

- [ ] **Step 2: Add `_getAllProvidersSupportingModel` and `_getProviderConfigForAccount` to `ProviderPoolManager`.**
  These internal helpers will leverage the `DynamicProviderModels` methods created in Step 1 and provide granular account selection.

  ```javascript
  // src/providers/provider-pool-manager.js
  // Add to ProviderPoolManager class
  
  import { dynamicProviderModels } from './provider-models.js'; // Ensure this import exists
  
  // ... existing methods ...
  
  /**
   * Retrieves all providers that claim to support a given model ID.
   * This is used for tiered fallback to find all potential candidates.
   * @param {string} modelId - The model ID to find supporting providers for.
   * @returns {Array<Object>} A list of providerStatus objects that support the model, containing type and config.
   */
  _getAllProvidersSupportingModel(modelId) {
      const allSupportingProviderTypes = dynamicProviderModels.getAllProviderTypesForModel(modelId);
      const candidates = [];
  
      for (const { providerType } of allSupportingProviderTypes) {
          const providerStatuses = this.providerStatus[providerType];
          if (providerStatuses) {
              for (const providerStatus of providerStatuses) {
                  // Only consider healthy and enabled providers that actually support the model
                  if (providerStatus.config.isHealthy && !providerStatus.config.isDisabled && dynamicProviderModels.doesProviderSupportModel(providerStatus, modelId)) {
                      candidates.push(providerStatus);
                  }
              }
          }
      }
  
      // Sort candidates: prioritize those with more recent successful usage or fewer errors.
      // This sorting can be used across all potential accounts regardless of providerType.
      return candidates.sort((a, b) => {
          if (a.config.lastUsed && b.config.lastUsed) {
              return new Date(b.config.lastUsed).getTime() - new Date(a.config.lastUsed).getTime();
          }
          if (a.config.lastUsed) return -1;
          if (b.config.lastUsed) return 1;
          return a.config.errorCount - b.config.errorCount;
      });
  }
  
  /**
   * Attempts to get a provider configuration for a specific account (providerStatus).
   * It checks health, disabled status, and model support.
   * @param {Object} providerStatus - The specific providerStatus object (account) to try.
   * @param {string} requestedModel - The model requested.
   * @param {boolean} skipUsageCount - Whether to skip incrementing usage count.
   * @returns {Object|null} The selected provider configuration if successful, otherwise throws an error.
   * @throws {Error} if the specific provider account cannot serve the model.
   */
  async _getProviderConfigForAccount(providerStatus, requestedModel, skipUsageCount) {
      const providerType = providerStatus.type;
      const uuid = providerStatus.config.uuid;
  
      if (!providerStatus.config.isHealthy) {
          throw new Error(`Provider account ${uuid} (${providerType}) is unhealthy.`);
      }
      if (providerStatus.config.isDisabled) {
          throw new Error(`Provider account ${uuid} (${providerType}) is disabled.`);
      }
      if (!dynamicProviderModels.doesProviderSupportModel(providerStatus, requestedModel)) {
          throw new Error(`Provider account ${uuid} (${providerType}) does not support model ${requestedModel}.`);
      }
  
      // Mark as used if not skipped
      if (!skipUsageCount) {
          this.markProviderUsed(providerType, uuid);
      }
  
      // Update selection sequence for round-robin logic if it was selected this way
      // This is a direct selection, so just assign a high sequence to push it back
      providerStatus.config._lastSelectionSeq = this._nextSelectionSeq++;
  
      return {
          config: providerStatus.config,
          actualProviderType: providerStatus.type,
          uuid: providerStatus.config.uuid
      };
  }
  
  // The original selectProvider function should be updated to use _getProviderConfigForAccount
  // Remove the old _selectProviderInternal as it's replaced by the detailed iteration in selectProviderWithFallback
  async selectProvider(providerType, requestedModel, options = {}) {
      const { skipUsageCount } = options;
      const providerStatuses = this.providerStatus[providerType];
      if (!providerStatuses || providerStatuses.length === 0) {
          throw new Error(`No providers configured for type: ${providerType}`);
      }
  
      // Filter healthy and enabled providers that support the requested model
      let availableProviders = providerStatuses.filter(ps =>
          ps.config.isHealthy && !ps.config.isDisabled && dynamicProviderModels.doesProviderSupportModel(ps, requestedModel)
      );
  
      if (availableProviders.length === 0) {
          throw new Error(`No healthy provider for ${providerType} supports model: ${requestedModel}`);
      }
  
      // Apply custom provider-level fallback chain if exists
      const providerFallback = this.globalConfig.providerFallbackChain[providerType]; // Use globalConfig
      if (providerFallback && availableProviders.length > 1) {
          availableProviders = this._applyProviderFallbackOrdering(availableProviders, providerFallback);
      } else {
          // Default selection: round-robin
          availableProviders.sort((a, b) => a.config._lastSelectionSeq - b.config._lastSelectionSeq);
      }
  
      const selectedProviderStatus = availableProviders[0];
      const result = await this._getProviderConfigForAccount(selectedProviderStatus, requestedModel, skipUsageCount);
      return result.config; // Return just the config for selectProvider
  }
  ```

- [ ] **Step 3: Commit**

```bash
git add src/providers/provider-models.js src/providers/provider-pool-manager.js
git commit -m "feat: Add helpers to find all providers supporting a model and select specific accounts"
```

### Task 2: Implement Refined Tiered Fallback Logic in `selectProviderWithFallback`

**Files:**
- Modify: `src/providers/provider-pool-manager.js`

- [ ] **Step 1: Update `selectProviderWithFallback` to implement the refined tiered fallback logic.**
  This involves:
    1.  Trying all accounts of the `initialProviderType` for the `requestedModel`.
    2.  If `requestedModel` is not found within `initialProviderType`, then trying all accounts of *other* providers for `requestedModel` (from `_getAllProvidersSupportingModel`).
    3.  If `requestedModel` is completely exhausted across all providers/accounts, consulting `modelFallbackMapping` for a `targetModel`.
    4.  Recursively calling `selectProviderWithFallback` for the `targetModel`.
    5.  Implementing circular fallback detection using a `Set` of `fallbackChain`.

  ```javascript
  // src/providers/provider-pool-manager.js
  // Modify the existing selectProviderWithFallback method
  
  async selectProviderWithFallback(initialProviderType, requestedModel, options = {}, fallbackChain = new Set()) {
      const { skipUsageCount, monitorRequestId } = options;
  
      // Circular fallback detection
      if (fallbackChain.has(requestedModel)) {
          this._log('warn', `[Fallback] Circular dependency detected for model: ${requestedModel}. Aborting fallback.`);
          return null;
      }
      fallbackChain.add(requestedModel);
  
      this._log('debug', `[Fallback] Attempting to select provider for model: ${requestedModel} (initial: ${initialProviderType})`);
  
      let selectedProviderConfig = null;
      let actualProviderType = initialProviderType;
      let isFallback = false;
      let actualModel = requestedModel;
  
      // Tier 1, Phase 1: Exhaust accounts within the initialProviderType for the requestedModel
      const initialProviderAccounts = this.providerStatus[initialProviderType];
      if (initialProviderAccounts) {
          const healthyInitialAccounts = initialProviderAccounts.filter(ps =>
              ps.config.isHealthy && !ps.config.isDisabled && dynamicProviderModels.doesProviderSupportModel(ps, requestedModel)
          ).sort((a, b) => {
              // Apply the same sorting as in _getAllProvidersSupportingModel for consistency
              if (a.config.lastUsed && b.config.lastUsed) {
                  return new Date(b.config.lastUsed).getTime() - new Date(a.config.lastUsed).getTime();
              }
              if (a.config.lastUsed) return -1;
              if (b.config.lastUsed) return 1;
              return a.config.errorCount - b.config.errorCount;
          });
  
          for (const account of healthyInitialAccounts) {
              try {
                  selectedProviderConfig = await this._getProviderConfigForAccount(account, requestedModel, skipUsageCount);
                  if (selectedProviderConfig) {
                      actualProviderType = initialProviderType;
                      isFallback = false; // Not a fallback if selected from initial provider's accounts
                      this._log('debug', `[Fallback] Selected account ${account.config.uuid} from initial provider ${initialProviderType} for model ${requestedModel}`);
                      break;
                  }
              } catch (error) {
                  this._log('debug', `[Fallback] Account ${account.config.uuid} from initial provider ${initialProviderType} failed for ${requestedModel}: ${error.message}`);
              }
          }
      }
  
      // Tier 1, Phase 2: If model not found in initialProviderType accounts, exhaust accounts from other providers for the same model
      if (!selectedProviderConfig) {
          this._log('debug', `[Fallback] Initial provider ${initialProviderType} exhausted for model ${requestedModel}. Trying other providers for the same model.`);
          const allSupportingProviders = this._getAllProvidersSupportingModel(requestedModel); // This list is already sorted by health/usage
          
          // Filter out accounts belonging to the initialProviderType, as they've already been tried
          const otherProviderAccounts = allSupportingProviders.filter(ps => ps.type !== initialProviderType);
  
          for (const providerStatus of otherProviderAccounts) {
              try {
                  selectedProviderConfig = await this._getProviderConfigForAccount(providerStatus, requestedModel, skipUsageCount);
                  if (selectedProviderConfig) {
                      actualProviderType = providerStatus.type;
                      isFallback = true; // This is a fallback to a different providerType
                      this._log('info', `[Fallback] Successfully found fallback provider ${actualProviderType} for model ${requestedModel} (account ${providerStatus.config.uuid})`);
                      break;
                  }
              } catch (error) {
                  this._log('debug', `[Fallback] Provider account ${providerStatus.config.uuid} from ${providerStatus.type} failed for ${requestedModel}: ${error.message}`);
              }
          }
      }
  
      // Tier 2: Fallback to next high-quality model if current model exhausted across all providers
      if (!selectedProviderConfig && this.globalConfig.modelFallbackMapping) {
          const fallbackEntry = this.globalConfig.modelFallbackMapping[requestedModel];
          if (fallbackEntry && fallbackEntry.targetModel) {
              const { targetModel, targetProviderType } = fallbackEntry;
              this._log('info', `[Fallback] Model ${requestedModel} exhausted across all providers/accounts. Falling back to target model: ${targetModel} (provider: ${targetProviderType || 'any'})`);
  
              const fallbackResult = await this.selectProviderWithFallback(
                  targetProviderType || initialProviderType, // Use targetProviderType if specified, else keep original
                  targetModel,
                  options,
                  fallbackChain // Pass the current fallback chain to detect circular dependencies
              );
  
              if (fallbackResult) {
                  return { ...fallbackResult, isFallback: true }; // Propagate isFallback status
              }
          } else {
              this._log('debug', `[Fallback] No modelFallbackMapping entry found for ${requestedModel}`);
          }
      }
  
      if (selectedProviderConfig) {
          return {
              config: selectedProviderConfig.config,
              actualProviderType: selectedProviderConfig.actualProviderType,
              isFallback,
              actualModel,
              uuid: selectedProviderConfig.uuid
          };
      }
  
      this._log('error', `[Fallback] No healthy provider found after all fallback attempts for model: ${requestedModel}`);
      throw new Error(`No healthy provider found for model: ${requestedModel} after fallback attempts.`);
  }
  ```

- [ ] **Step 2: Commit**

```bash
git add src/providers/provider-pool-manager.js
git commit -m "feat: Implement refined tiered model fallback logic in selectProviderWithFallback"
```

### Task 3: Add Unit Tests for Tiered Fallback Logic

**Files:**
- Create: `tests/unit/provider-pool-manager.test.js` (or modify an existing test file)

- [ ] **Step 1: Write failing unit tests for `ProviderPoolManager.selectProviderWithFallback`.**
  These tests should cover:
    *   Successful selection from initial provider, first account.
    *   Fallback to a *second account within the same initial provider* if the first fails.
    *   Fallback to another provider for the same model if all accounts of the initial provider fail.
    *   Fallback to a different model as defined in `modelFallbackMapping`.
    *   Multi-step fallback chains.
    *   Circular fallback detection.
    *   No healthy provider found after all fallbacks.

  ```javascript
  // tests/unit/provider-pool-manager.test.js
  import { ProviderPoolManager } from '../../src/providers/provider-pool-manager.js';
  import { dynamicProviderModels } from '../../src/providers/provider-models.js';
  import { jest } from '@jest/globals';
  
  // Mock logger to prevent console output during tests
  jest.mock('../../src/utils/logger.js', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      initialize: jest.fn(),
      cleanupOldLogs: jest.fn(),
  }));
  
  // Mock dynamicProviderModels
  jest.mock('../../src/providers/provider-models.js', () => ({
      dynamicProviderModels: {
          getAllProviderTypesForModel: jest.fn(),
          getProviderModels: jest.fn(),
          getAllProviderModels: jest.fn(),
          doesProviderSupportModel: jest.fn(), // Mock this new helper
      },
  }));
  
  describe('ProviderPoolManager Tiered Fallback', () => {
      let manager;
      let mockConfig;
  
      beforeEach(() => {
          mockConfig = {
              modelFallbackMapping: {
                  'model-A': { targetModel: 'model-B', targetProviderType: 'provider-Y' },
                  'model-B': { targetModel: 'model-C', targetProviderType: 'provider-Z' },
                  'model-C': { targetModel: 'model-A', targetProviderType: 'provider-X' }, // Circular fallback
              },
              providerFallbackChain: {
                  'provider-X': ['provider-Y', 'provider-Z'],
              },
          };
  
          manager = new ProviderPoolManager({}, {
              globalConfig: mockConfig,
              maxErrorCount: 10,
              providerFallbackChain: mockConfig.providerFallbackChain,
          });
  
          // Reset mocks
          jest.clearAllMocks();
  
          // Mock providerStatus structure (different accounts for a provider)
          manager.providerStatus = {
              'provider-X': [
                  { type: 'provider-X', config: { uuid: 'uuid-X1', isHealthy: true, isDisabled: false, lastUsed: new Date(), errorCount: 0 } },
                  { type: 'provider-X', config: { uuid: 'uuid-X2', isHealthy: true, isDisabled: false, lastUsed: null, errorCount: 0 } },
              ],
              'provider-Y': [
                  { type: 'provider-Y', config: { uuid: 'uuid-Y1', isHealthy: true, isDisabled: false, lastUsed: new Date(), errorCount: 0 } },
                  { type: 'provider-Y', config: { uuid: 'uuid-Y2', isHealthy: true, isDisabled: false, lastUsed: null, errorCount: 0 } },
              ],
              'provider-Z': [
                  { type: 'provider-Z', config: { uuid: 'uuid-Z1', isHealthy: true, isDisabled: false, lastUsed: null, errorCount: 0 } },
              ],
          };
  
          // Mock dynamicProviderModels.doesProviderSupportModel
          dynamicProviderModels.doesProviderSupportModel.mockReturnValue(true);
  
          // Mock _getProviderConfigForAccount (internal helper)
          manager._getProviderConfigForAccount = jest.fn(async (providerStatus, modelId, skipUsage) => {
              if (!providerStatus.config.isHealthy || providerStatus.config.isDisabled || !dynamicProviderModels.doesProviderSupportModel(providerStatus, modelId)) {
                  throw new Error(`Account ${providerStatus.config.uuid} unavailable`);
              }
              return {
                  config: providerStatus.config,
                  actualProviderType: providerStatus.type,
                  uuid: providerStatus.config.uuid
              };
          });
      });
  
      test('should select provider from initial type, first healthy account', async () => {
          const result = await manager.selectProviderWithFallback('provider-X', 'model-A');
          expect(result.uuid).toBe('uuid-X1');
          expect(result.actualProviderType).toBe('provider-X');
          expect(result.isFallback).toBe(false);
          expect(result.actualModel).toBe('model-A');
      });
  
      test('should fallback to second account within initial provider if first fails', async () => {
          // Mock uuid-X1 to fail
          manager._getProviderConfigForAccount.mockImplementationOnce(async (providerStatus, modelId, skipUsage) => {
              if (providerStatus.config.uuid === 'uuid-X1') {
                  throw new Error('uuid-X1 failed');
              }
              return {
                  config: providerStatus.config,
                  actualProviderType: providerStatus.type,
                  uuid: providerStatus.config.uuid
              };
          });
  
          const result = await manager.selectProviderWithFallback('provider-X', 'model-A');
          expect(result.uuid).toBe('uuid-X2'); // Should fallback to uuid-X2
          expect(result.actualProviderType).toBe('provider-X');
          expect(result.isFallback).toBe(false); // Still not considered a fallback if within same initial providerType
          expect(result.actualModel).toBe('model-A');
      });
  
      test('should fallback to another provider type for the same model if initial provider accounts fail', async () => {
          // Mock all provider-X accounts to fail
          manager._getProviderConfigForAccount.mockImplementation(async (providerStatus, modelId, skipUsage) => {
              if (providerStatus.type === 'provider-X') {
                  throw new Error('provider-X account failed');
              }
              return {
                  config: providerStatus.config,
                  actualProviderType: providerStatus.type,
                  uuid: providerStatus.config.uuid
              };
          });
  
          // Mock _getAllProvidersSupportingModel to return all healthy accounts, sorted as expected
          manager._getAllProvidersSupportingModel = jest.fn((modelId) => {
              const allAccounts = [
                  { type: 'provider-X', config: { uuid: 'uuid-X1', isHealthy: true, isDisabled: false } },
                  { type: 'provider-X', config: { uuid: 'uuid-X2', isHealthy: true, isDisabled: false } },
                  { type: 'provider-Y', config: { uuid: 'uuid-Y1', isHealthy: true, isDisabled: false } }, // Y1 is next in sorted list
                  { type: 'provider-Y', config: { uuid: 'uuid-Y2', isHealthy: true, isDisabled: false } },
              ];
              return allAccounts.filter(ps => dynamicProviderModels.doesProviderSupportModel(ps, modelId));
          });
  
          const result = await manager.selectProviderWithFallback('provider-X', 'model-A');
          expect(result.uuid).toBe('uuid-Y1'); // Should fallback to provider-Y, first account
          expect(result.actualProviderType).toBe('provider-Y');
          expect(result.isFallback).toBe(true); // Now it's a fallback
          expect(result.actualModel).toBe('model-A');
      });
  
      test('should fallback to target model if requested model exhausted across all providers and accounts', async () => {
          // Mock all accounts for model-A to fail
          manager._getProviderConfigForAccount.mockImplementation(async (providerStatus, modelId, skipUsage) => {
              if (modelId === 'model-A') {
                  throw new Error('All accounts for model-A failed');
              }
              return {
                  config: providerStatus.config,
                  actualProviderType: providerStatus.type,
                  uuid: providerStatus.config.uuid
              };
          });
  
          // Mock _getAllProvidersSupportingModel for model-A
          manager._getAllProvidersSupportingModel = jest.fn((modelId) => {
              if (modelId === 'model-A') {
                  return [ // All these will fail
                      { type: 'provider-X', config: { uuid: 'uuid-X1', isHealthy: true, isDisabled: false } },
                      { type: 'provider-Y', config: { uuid: 'uuid-Y1', isHealthy: true, isDisabled: false } },
                  ];
              }
              // For model-B, say provider-Z supports it
              if (modelId === 'model-B') {
                  return [
                      { type: 'provider-Z', config: { uuid: 'uuid-Z1', isHealthy: true, isDisabled: false } },
                  ];
              }
              return [];
          });
  
          const result = await manager.selectProviderWithFallback('provider-X', 'model-A');
          expect(result.uuid).toBe('uuid-Z1'); // Should fallback to provider-Z for model-B
          expect(result.actualProviderType).toBe('provider-Z');
          expect(result.isFallback).toBe(true);
          expect(result.actualModel).toBe('model-B');
      });
  
      test('should detect and prevent circular fallbacks (model-A -> model-B -> model-C -> model-A)', async () => {
          // Mock all accounts for any model to fail (to force model fallback)
          manager._getProviderConfigForAccount.mockImplementation(async (providerStatus, modelId, skipUsage) => {
              throw new Error('Account failed, forcing model fallback');
          });
  
          // Ensure _getAllProvidersSupportingModel always returns some candidates, but they fail
          dynamicProviderModels.doesProviderSupportModel.mockReturnValue(true);
          manager._getAllProvidersSupportingModel.mockImplementation((modelId) => {
              if (modelId === 'model-A') return [{ type: 'provider-X', config: { uuid: 'uuid-X1', isHealthy: true, isDisabled: false } }];
              if (modelId === 'model-B') return [{ type: 'provider-Y', config: { uuid: 'uuid-Y1', isHealthy: true, isDisabled: false } }];
              if (modelId === 'model-C') return [{ type: 'provider-Z', config: { uuid: 'uuid-Z1', isHealthy: true, isDisabled: false } }];
              return [];
          });
  
          const result = await manager.selectProviderWithFallback('provider-X', 'model-A');
          expect(result).toBeNull(); // Circular fallback should return null
          expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[Fallback] Circular dependency detected for model: model-A. Aborting fallback.'));
      });
  
      test('should throw error if no healthy provider found after all attempts', async () => {
          // Mock all internal helpers to fail/return empty
          manager._getProviderConfigForAccount.mockImplementation(async () => { throw new Error('No account available'); });
          dynamicProviderModels.doesProviderSupportModel.mockReturnValue(false);
          manager._getAllProvidersSupportingModel.mockReturnValue([]);
  
          await expect(manager.selectProviderWithFallback('provider-X', 'model-D'))
              .rejects
              .toThrow('No healthy provider found for model: model-D after fallback attempts.');
      });
  });
  ```

- [ ] **Step 2: Run tests and confirm they fail as expected.**

```bash
npm test tests/unit/provider-pool-manager.test.js
```
Expected: Tests will initially fail because the implementation changes are not yet applied.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/provider-pool-manager.test.js
git commit -m "test: Add unit tests for refined tiered fallback logic in ProviderPoolManager"
```