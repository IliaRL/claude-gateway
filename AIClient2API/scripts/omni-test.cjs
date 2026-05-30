#!/usr/bin/env node
'use strict';

/**
 * AIClient2API Quota-Safe Omni-Test Suite
 *
 * ⚠️ DEPRECATED (2026-05-30) — low-confidence / false positives.
 * max_tokens=3 is too small for the model to actually generate (reasoning models in
 * particular emit nothing usable), and it only checks HTTP 200 + that a "content"
 * field exists, so an empty 200 passes. Use the accurate, quota-safe replacement:
 *     node scripts/live-verify.cjs            # full
 *     node scripts/live-verify.cjs --quick    # one model per provider
 * Kept only for the shell-alias / proxy-health checks; do not trust its model results.
 *
 * One lightweight request per active provider (max_tokens=3, 2s delay between tests).
 * Tests: proxy health, shell aliases, tool-calling, per-provider latency.
 * Never triggers 429 or burns through quota.
 */

console.warn('\x1b[33m[deprecated] omni-test.cjs is low-confidence — use scripts/live-verify.cjs\x1b[0m');

const { execSync } = require('child_process');
const { readFileSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');

const PROXY_URL = 'http://127.0.0.1:3000';
const BEARER = process.env.AICLIENT_TOKEN || 'sk-a60f3efdf9b97e63c84ab4a3583f9d1c';
const DELAY_MS = 2000;

// One representative model per active provider — use provider:model prefix for direct routing
const PROVIDER_TESTS = [
  { provider: 'gemini-antigravity',  model: 'gemini-antigravity:gemini-3-flash' },
  { provider: 'gemini-cli-oauth',    model: 'gemini-cli-oauth:gemini-2.5-flash' },
  { provider: 'claude-kiro-oauth',   model: 'claude-kiro-oauth:claude-sonnet-4-6' },
  { provider: 'github-models',       model: 'github-models:gpt-4o' },
  { provider: 'nvidia-nim',          model: 'nvidia-nim:meta/llama-3.3-70b-instruct' },
  { provider: 'openai-custom',       model: 'openai-custom:deepseek/deepseek-v4-flash:free' },
];

const GREEN  = (s) => `\x1b[32m${s}\x1b[0m`;
const RED    = (s) => `\x1b[31m${s}\x1b[0m`;
const CYAN   = (s) => `\x1b[36m${s}\x1b[0m`;
const BOLD   = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM    = (s) => `\x1b[2m${s}\x1b[0m`;

function pass(label) { console.log(`  ${GREEN('✓')} ${label}`); }
function fail(label, reason) { console.log(`  ${RED('✗')} ${label}${reason ? ': ' + reason : ''}`); }
function section(title) { console.log(`\n${BOLD(CYAN(`── ${title} ──`))}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function chatRequest(model, messages, tools = null) {
  const body = { model, messages, max_tokens: 3, stream: false };
  if (tools) { body.tools = tools; body.max_tokens = 10; }
  const t0 = Date.now();
  const res = await fetch(`${PROXY_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BEARER}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const ttft = Date.now() - t0;
  const data = await res.json();
  return { status: res.status, data, ttft };
}

// ─── Section 1: Proxy health ──────────────────────────────────────────────────

async function checkProxyHealth() {
  section('1. Proxy Health');
  try {
    const res = await fetch(`${PROXY_URL}/api/help`);
    if (res.status === 200) pass(`Proxy alive at ${PROXY_URL}`);
    else fail('Proxy alive', `HTTP ${res.status}`);
  } catch (e) {
    fail('Proxy alive', e.message);
    console.log(RED('  FATAL: proxy offline — run ./scripts/safe-restart.sh'));
    process.exit(1);
  }

  const modelsRes = await fetch(`${PROXY_URL}/v1/models`, {
    headers: { 'Authorization': `Bearer ${BEARER}` },
  });
  const models = await modelsRes.json();
  const count = models.data?.length ?? 0;
  if (count >= 45) pass(`Model catalog: ${count} models`);
  else fail('Model catalog', `Only ${count} (expected ≥45)`);

  const healthRes = await fetch(`${PROXY_URL}/provider_health`);
  const health = await healthRes.json();
  const items = health.items ?? [];
  const healthy = items.filter(i => i.isHealthy).length;
  if (healthy >= 25) pass(`Pool health: ${healthy}/${items.length} accounts healthy`);
  else fail('Pool health', `${healthy}/${items.length} — below threshold of 25`);
}

// ─── Section 2: Shell alias verification ─────────────────────────────────────

async function checkShellAliases() {
  section('2. Shell Aliases');
  const rcPaths = [
    join(homedir(), 'dotfiles', 'zsh', 'zshrc'),
    join(homedir(), '.zshrc'),
  ];

  let rcContent = '';
  let rcFound = '';
  for (const p of rcPaths) {
    try { rcContent = readFileSync(p, 'utf8'); rcFound = p; break; } catch {}
  }

  if (!rcContent) { fail('zshrc / dotfiles/zsh/zshrc', 'not found'); return; }
  pass(DIM(`Using ${rcFound}`));

  const REQUIRED = ['claude-pick', 'claude-swap', 'claude-proxy', 'claude-native', 'claude-mode-status'];
  for (const alias of REQUIRED) {
    if (rcContent.includes(alias)) pass(`alias defined: ${alias}`);
    else fail(`alias missing`, alias);
  }

  try {
    execSync('zsh -c "source ~/dotfiles/zsh/zshrc 2>/dev/null; type claude-pick"', { stdio: 'pipe' });
    pass('claude-pick is shell-invokable');
  } catch {
    fail('claude-pick', 'not callable after sourcing zshrc');
  }
}

// ─── Section 3: Tool-calling test ────────────────────────────────────────────

async function checkToolCalling() {
  section('3. Tool-Calling (claude-kiro-oauth)');
  const tools = [{
    name: 'get_weather',
    description: 'Get current weather for a city',
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
  }];

  try {
    const { status, data, ttft } = await chatRequest('claude-kiro-oauth:claude-sonnet-4-6', [
      { role: 'user', content: 'What is the weather in Paris?' },
    ], tools);

    if (status !== 200) { fail('Tool-call', `HTTP ${status}: ${JSON.stringify(data).slice(0, 100)}`); return; }
    const hasToolUse = data.content?.some(b => b.type === 'tool_use');
    if (hasToolUse) pass(`Tool-use block received  ${DIM('TTFT: ' + ttft + 'ms')}`);
    else fail('Tool-use block', `Got type: ${data.content?.[0]?.type ?? 'unknown'} — proxy may be converting incorrectly`);
  } catch (e) {
    fail('Tool-call request', e.message);
  }
  await sleep(DELAY_MS);
}

// ─── Section 4: Per-provider latency ─────────────────────────────────────────

async function checkProviders() {
  section('4. Per-Provider Latency  ' + DIM('(max_tokens=3, 2s delay)'));
  const results = [];

  for (const { provider, model } of PROVIDER_TESTS) {
    try {
      const { status, data, ttft } = await chatRequest(model, [
        { role: 'user', content: 'Reply with "ok" only.' },
      ]);

      if (status === 200 && data.content) {
        const bars = GREEN('█'.repeat(Math.min(Math.round(ttft / 250), 20)));
        pass(`${provider.padEnd(24)} ${bars}  ${ttft}ms`);
        results.push({ provider, ttft, ok: true });
      } else {
        fail(provider, `HTTP ${status} — ${JSON.stringify(data).slice(0, 80)}`);
        results.push({ provider, ttft, ok: false });
      }
    } catch (e) {
      fail(provider, e.message);
      results.push({ provider, ttft: null, ok: false });
    }
    await sleep(DELAY_MS);
  }

  const passed = results.filter(r => r.ok).length;
  const total  = results.length;
  console.log(`\n  ${passed === total ? GREEN('All') : RED(`${passed}/${total}`)} providers responded`);

  if (passed < total) {
    console.log(`\n  ${DIM('Failed providers — run: tail -50 /tmp/aiclient.log')}`);
    results.filter(r => !r.ok).forEach(r => console.log(`    ${RED('→')} ${r.provider}`));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(BOLD('\n  AIClient2API Quota-Safe Omni-Test Suite'));
  console.log(DIM('  max_tokens=3 per request · 2s delay between providers\n'));

  await checkProxyHealth();
  await checkShellAliases();
  await checkToolCalling();
  await checkProviders();

  console.log(BOLD('\n  Done.\n'));
})();
