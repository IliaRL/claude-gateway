import { test, expect } from '@jest/globals';
import { writeFileSync, readFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateAndRepairProviderPools } from '../../src/utils/provider-pools-validator.js';

function writeTempPools(data) {
  const dir = mkdtempSync(join(tmpdir(), 'pools-test-'));
  const p = join(dir, 'provider_pools.json');
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  return p;
}

test('returns without error when file does not exist', () => {
  expect(() => validateAndRepairProviderPools('/nonexistent/path.json')).not.toThrow();
});

test('returns without error on clean pools file', () => {
  const path = writeTempPools({
    'openai-custom': [{ uuid: 'abc', isHealthy: true, modelCooldowns: {} }]
  });
  expect(() => validateAndRepairProviderPools(path)).not.toThrow();
});

test('cleans modelCooldowns that became the string "[object Object]"', () => {
  const path = writeTempPools({
    'openai-custom': [{ uuid: 'abc', isHealthy: true, modelCooldowns: '[object Object]' }]
  });
  validateAndRepairProviderPools(path);
  const result = JSON.parse(readFileSync(path, 'utf8'));
  expect(result['openai-custom'][0].modelCooldowns).toEqual({});
});

test('cleans modelCooldowns that is null', () => {
  const path = writeTempPools({
    'gemini-antigravity': [{ uuid: 'xyz', modelCooldowns: null }]
  });
  validateAndRepairProviderPools(path);
  const result = JSON.parse(readFileSync(path, 'utf8'));
  expect(result['gemini-antigravity'][0].modelCooldowns).toEqual({});
});

test('cleans modelCooldowns that is an array', () => {
  const path = writeTempPools({
    'nvidia-nim': [{ uuid: 'nim1', modelCooldowns: ['bad', 'data'] }]
  });
  validateAndRepairProviderPools(path);
  const result = JSON.parse(readFileSync(path, 'utf8'));
  expect(result['nvidia-nim'][0].modelCooldowns).toEqual({});
});

test('does not modify a valid modelCooldowns object', () => {
  const cooldowns = { 'gpt-4o': 1234567890 };
  const path = writeTempPools({
    'openai-custom': [{ uuid: 'abc', modelCooldowns: cooldowns }]
  });
  validateAndRepairProviderPools(path);
  const result = JSON.parse(readFileSync(path, 'utf8'));
  expect(result['openai-custom'][0].modelCooldowns).toEqual(cooldowns);
});
