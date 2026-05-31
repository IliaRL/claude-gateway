import { test, expect } from '@jest/globals';
import { HealthGuard } from '../../src/utils/health-guard.js';

test('HealthGuard can be instantiated', () => {
  const hg = new HealthGuard();
  expect(hg).toBeDefined();
  expect(typeof hg.recordAuthFailure).toBe('function');
  expect(typeof hg.recordSuccess).toBe('function');
  expect(typeof hg.attach).toBe('function');
});

test('counter increments on each auth failure', () => {
  const hg = new HealthGuard();
  hg.recordAuthFailure('uuid-1', 'openai-custom', {});
  hg.recordAuthFailure('uuid-1', 'openai-custom', {});
  expect(hg._failures.get('uuid-1').count).toBe(2);
});

test('counter resets to zero on success', () => {
  const hg = new HealthGuard();
  hg.recordAuthFailure('uuid-1', 'openai-custom', {});
  hg.recordAuthFailure('uuid-1', 'openai-custom', {});
  hg.recordSuccess('uuid-1');
  expect(hg._failures.has('uuid-1')).toBe(false);
});

test('auto-disables after threshold consecutive failures', () => {
  const hg = new HealthGuard({ maxConsecutive401s: 3, permanentFailureWindowMs: 600_000 });
  const mockPool = { disableProvider: jest.fn() };
  hg.attach(mockPool);

  hg.recordAuthFailure('uuid-1', 'openai-custom', { uuid: 'uuid-1' });
  hg.recordAuthFailure('uuid-1', 'openai-custom', { uuid: 'uuid-1' });
  expect(mockPool.disableProvider).not.toHaveBeenCalled();

  hg.recordAuthFailure('uuid-1', 'openai-custom', { uuid: 'uuid-1' });
  expect(mockPool.disableProvider).toHaveBeenCalledWith('openai-custom', { uuid: 'uuid-1' });
});

test('does NOT auto-disable before threshold', () => {
  const hg = new HealthGuard({ maxConsecutive401s: 3, permanentFailureWindowMs: 600_000 });
  const mockPool = { disableProvider: jest.fn() };
  hg.attach(mockPool);

  hg.recordAuthFailure('uuid-1', 'openai-custom', {});
  hg.recordAuthFailure('uuid-1', 'openai-custom', {});
  expect(mockPool.disableProvider).not.toHaveBeenCalled();
});

test('window expiry resets the counter', () => {
  const hg = new HealthGuard({ maxConsecutive401s: 3, permanentFailureWindowMs: 1 }); // 1ms window
  const mockPool = { disableProvider: jest.fn() };
  hg.attach(mockPool);

  hg.recordAuthFailure('uuid-1', 'openai-custom', {});
  // Manually backdate firstSeen so window has "expired"
  hg._failures.get('uuid-1').firstSeen = Date.now() - 100;

  hg.recordAuthFailure('uuid-1', 'openai-custom', {});
  expect(hg._failures.get('uuid-1').count).toBe(1); // Reset to 1, not 2
  expect(mockPool.disableProvider).not.toHaveBeenCalled();
});

test('counter is per-uuid, does not bleed between accounts', () => {
  const hg = new HealthGuard({ maxConsecutive401s: 3, permanentFailureWindowMs: 600_000 });
  const mockPool = { disableProvider: jest.fn() };
  hg.attach(mockPool);

  hg.recordAuthFailure('uuid-A', 'openai-custom', {});
  hg.recordAuthFailure('uuid-A', 'openai-custom', {});
  hg.recordAuthFailure('uuid-B', 'openai-custom', {});
  expect(mockPool.disableProvider).not.toHaveBeenCalled();
  expect(hg._failures.get('uuid-A').count).toBe(2);
  expect(hg._failures.get('uuid-B').count).toBe(1);
});
