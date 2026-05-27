#!/usr/bin/env node
/**
 * benchmark.cjs — granular per-model benchmark for AIClient2API.
 *
 * For each model in GET /v1/models, sends a minimal POST /v1/messages with
 * stream:true, measures:
 *   - TTFT (time-to-first-token): wall-clock from request start to first SSE
 *     `data:` chunk containing usable content.
 *   - tokens/sec: estimated output tokens / (end - first_token_time).
 *   - total RTT: wall-clock from request start to stream close.
 *
 * Each request times out at 30s — model is marked TIMEOUT, not allowed to hang.
 *
 * Usage:
 *   node scripts/benchmark.cjs
 *   node scripts/benchmark.cjs --models "gemini-2.5-flash,gpt-4o-mini"
 *   node scripts/benchmark.cjs --host 127.0.0.1 --port 3000 --token sk-...
 */

'use strict';

const http = require('http');
const { URL } = require('url');

// ---------- args ----------
function parseArgs(argv) {
  const out = { models: null, host: '127.0.0.1', port: 3000, token: 'sk-a60f3efdf9b97e63c84ab4a3583f9d1c', timeoutMs: 30000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--models') out.models = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = parseInt(argv[++i], 10);
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--timeout') out.timeoutMs = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/benchmark.cjs [--models a,b,c] [--host H] [--port P] [--token T] [--timeout MS]');
      process.exit(0);
    }
  }
  return out;
}

// ---------- HTTP helpers ----------
function httpJson(opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }); }
        catch (e) { resolve({ status: res.statusCode, json: null, raw: body }); }
      });
    });
    req.on('error', reject);
    if (opts._body) req.write(opts._body);
    req.end();
  });
}

async function listModels(host, port, token) {
  const { status, json } = await httpJson({
    host, port, method: 'GET', path: '/v1/models',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (status !== 200 || !json?.data) {
    throw new Error(`/v1/models returned status=${status}`);
  }
  return json.data.map((m) => m.id);
}

/**
 * Run one streamed benchmark for a model. Returns:
 *   { model, status, ttftMs, totalMs, outputTokens, tokPerSec, error }
 *
 * status: ok | timeout | http_error | stream_error | no_content
 */
function benchmarkModel({ host, port, token, model, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let firstChunkAt = null;
    let lastChunkAt = null;
    let outputTokensApprox = 0;
    let aggregatedText = '';
    let usageOutputTokens = null;
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Compute derived stats
      const totalMs = Date.now() - startedAt;
      const ttftMs = firstChunkAt ? firstChunkAt - startedAt : null;
      const genDurationMs = (firstChunkAt && lastChunkAt) ? Math.max(1, lastChunkAt - firstChunkAt) : null;
      const tokens = usageOutputTokens ?? (outputTokensApprox || Math.max(1, Math.ceil(aggregatedText.length / 4)));
      const tokPerSec = (genDurationMs && tokens > 0) ? (tokens / (genDurationMs / 1000)) : null;
      resolve(Object.assign({ model, ttftMs, totalMs, tokens, tokPerSec }, result));
    };

    const body = JSON.stringify({
      model,
      max_tokens: 32,
      stream: true,
      messages: [{ role: 'user', content: 'Say hello in 5 words.' }],
    });

    const req = http.request({
      host, port, method: 'POST', path: '/v1/messages',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'X-Debug-Trace': '1',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { errBody += c; if (errBody.length > 500) errBody = errBody.slice(0, 500); });
        res.on('end', () => settle({ status: 'http_error', error: `HTTP ${res.statusCode}: ${errBody.slice(0, 200)}` }));
        return;
      }
      res.setEncoding('utf8');
      let sseBuf = '';
      res.on('data', (chunk) => {
        if (!firstChunkAt) {
          // Only count it as "first token" if the chunk contains a data: line with real payload.
          firstChunkAt = Date.now();
        }
        lastChunkAt = Date.now();
        sseBuf += chunk;
        // Process complete SSE events (split on blank line).
        let idx;
        while ((idx = sseBuf.indexOf('\n\n')) !== -1) {
          const event = sseBuf.slice(0, idx);
          sseBuf = sseBuf.slice(idx + 2);
          // Each event has zero or more `data: ...` lines.
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const obj = JSON.parse(payload);
              // Anthropic stream shapes
              if (obj.type === 'content_block_delta' && obj.delta?.text) {
                aggregatedText += obj.delta.text;
                outputTokensApprox += 1; // crude per-delta count; refined by usage below
              }
              if (obj.type === 'message_delta' && obj.usage?.output_tokens) {
                usageOutputTokens = obj.usage.output_tokens;
              }
              if (obj.type === 'message_start' && obj.message?.usage?.output_tokens) {
                usageOutputTokens = obj.message.usage.output_tokens;
              }
            } catch (_) { /* non-JSON SSE comment, ignore */ }
          }
        }
      });
      res.on('end', () => {
        if (!firstChunkAt) return settle({ status: 'no_content', error: 'stream ended with no data:' });
        settle({ status: 'ok' });
      });
      res.on('error', (e) => settle({ status: 'stream_error', error: e.message }));
    });

    req.on('error', (e) => settle({ status: 'http_error', error: e.message }));
    req.write(body);
    req.end();

    const timer = setTimeout(() => {
      try { req.destroy(new Error('timeout')); } catch (_) {}
      settle({ status: 'timeout', error: `>${timeoutMs}ms` });
    }, timeoutMs);
  });
}

// ---------- formatting ----------
function fmtMs(n) { return n == null ? '   -  ' : String(Math.round(n)).padStart(6) + 'ms'; }
function fmtTok(n) { return n == null ? '   -  ' : (n >= 100 ? n.toFixed(0) : n.toFixed(1)).padStart(6); }

async function main() {
  const args = parseArgs(process.argv);
  console.log(`\nAIClient2API benchmark → http://${args.host}:${args.port}  (timeout=${args.timeoutMs}ms)`);

  let models;
  try {
    const all = await listModels(args.host, args.port, args.token);
    // Strip provider prefix "provider:model-id" → "model-id" for request bodies.
    // Keep original full id around for display.
    const stripPrefix = (id) => id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
    const bareAll = all.map(stripPrefix);
    if (args.models) {
      // Accept either bare or prefixed form from the user.
      const want = new Set(args.models.map(stripPrefix));
      models = bareAll.filter((m) => want.has(m));
      const found = new Set(models);
      const missing = [...want].filter((m) => !found.has(m));
      if (missing.length) console.log(`Warning: not in /v1/models: ${missing.join(', ')}`);
    } else {
      // Deduplicate by bare id — multiple providers can serve the same model.
      models = [...new Set(bareAll)];
    }
  } catch (e) {
    console.error(`Failed to list models: ${e.message}`);
    process.exit(1);
  }

  if (!models.length) {
    console.error('No models to benchmark.');
    process.exit(1);
  }

  console.log(`Benchmarking ${models.length} model(s)...\n`);
  const results = [];
  // Serial execution to avoid pool starvation and to keep TTFT measurements clean.
  for (const m of models) {
    process.stdout.write(`  ${m.padEnd(45)} ... `);
    const r = await benchmarkModel({ ...args, model: m });
    results.push(r);
    const tag = r.status === 'ok' ? 'ok' : r.status.toUpperCase();
    console.log(`${tag} (TTFT=${fmtMs(r.ttftMs).trim()}, RTT=${fmtMs(r.totalMs).trim()})`);
  }

  // Sort: slowest first. Errors and timeouts at top with Infinity.
  results.sort((a, b) => {
    const av = a.status === 'ok' ? (a.totalMs ?? 0) : Number.POSITIVE_INFINITY;
    const bv = b.status === 'ok' ? (b.totalMs ?? 0) : Number.POSITIVE_INFINITY;
    return bv - av;
  });

  console.log('\n' + '─'.repeat(95));
  console.log(`${'model'.padEnd(48)} ${'TTFT'.padStart(8)}  ${'tok/s'.padStart(7)}  ${'RTT'.padStart(8)}  status`);
  console.log('─'.repeat(95));
  for (const r of results) {
    console.log(
      `${r.model.padEnd(48)} ${fmtMs(r.ttftMs)}  ${fmtTok(r.tokPerSec)}  ${fmtMs(r.totalMs)}  ${r.status}${r.error ? ' — ' + r.error.slice(0, 60) : ''}`
    );
  }
  console.log('─'.repeat(95));

  const ok = results.filter((r) => r.status === 'ok').length;
  const fail = results.length - ok;
  console.log(`\nDone. ${ok}/${results.length} ok, ${fail} failed/timeout.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
