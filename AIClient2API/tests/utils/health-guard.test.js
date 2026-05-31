import { test, expect } from '@jest/globals';
import { HealthGuard } from '../../src/utils/health-guard.js';

test('HealthGuard can be instantiated', () => {
  const hg = new HealthGuard();
  expect(hg).toBeDefined();
  expect(typeof hg.recordAuthFailure).toBe('function');
  expect(typeof hg.recordSuccess).toBe('function');
  expect(typeof hg.attach).toBe('function');
});
