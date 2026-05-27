// scripts/unified-test-suite.cjs
// Sequential, rate-limited validation of every healthy model in the proxy catalog.
//
// What it checks per model (full mode):
//   - chat       : POST /v1/chat/completions returns non-empty content
//   - stream     : POST stream=true emits at least 1 SSE data chunk
//   - tool       : tool_calls returned for a simple sum function (or 30 in text)
//   - identity   : X-Proxy-Actual-Model header equals requested model (or transparent fallback)
//
// Modes (cheapest to most expensive):
//   --smoke        7 calls total  — 1 model per provider (health-check model), chat+identity only.
//                                   Use after every restart or merge to confirm routing works.
//   --chat-only    45 calls total — chat+identity for every model, skips stream + tool.
//                                   Use when verifying all routes are reachable.
//   (default)      up to 135 calls — full chat+stream+tool for every model.
//                                   Use for deep pre-release validation only.
//
// Short-circuit: if chat returns a definitive error (5xx, not 429/503), stream and tool
// are skipped automatically — no point burning quota on a dead route.
//
// CLI flags:
//   --smoke              run smoke mode (1 model per provider, chat only)
//   --chat-only          skip stream and tool tests
//   --no-stream          skip stream test only
//   --no-tool            skip tool test only
//   --provider=<type>    only test models of this provider type
//   --model=<id>         only test this single model id
//   --include-unhealthy  run tests even on providers with 0 healthy accounts

const http = require('http');
const path = require('path');

const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE   = '\x1b[34m';
const DIM    = '\x1b[2m';
const RESET  = '\x1b[0m';

const API_KEY            = process.env.AICLIENT_TOKEN || 'sk-a60f3efdf9b97e63c84ab4a3583f9d1c';
const BASE_URL           = 'http://127.0.0.1:3000';
const REQUEST_TIMEOUT_MS = 25000;

// Smoke model per provider — matches health-check models in CLAUDE.md so we're
// testing the exact same model the proxy uses for its own health checks.
const SMOKE_MODEL = {
    'gemini-cli-oauth':    'gemini-2.5-flash-lite',
    'gemini-antigravity':  'gemini-3-flash',
    'claude-kiro-oauth':   'claude-haiku-4-5',
    'nvidia-nim':          'meta/llama-3.3-70b-instruct',
    'github-models':       'gpt-4o-mini',
    'openai-codex-oauth':  'gpt-5.4',
    'openai-custom':       'openai/gpt-oss-20b:free',
    'grok-web':            'grok-4.1-mini',
    'openai-qwen-oauth':   'qwen3-coder-plus',
    'openai-iflow':        'gpt-4o',
};

const smokeMode      = process.argv.includes('--smoke');
const chatOnly       = process.argv.includes('--chat-only') || smokeMode;
const noStream       = process.argv.includes('--no-stream') || chatOnly;
const noTool         = process.argv.includes('--no-tool')   || chatOnly;
const filterProvider = process.argv.find(a => a.startsWith('--provider='))?.split('=')[1];
const filterModel    = process.argv.find(a => a.startsWith('--model='))?.split('=')[1];
const includeUnhealthy = process.argv.includes('--include-unhealthy');

// Sleep: shorter for low-call modes to keep suite snappy; longer for full mode to avoid 429s.
const SLEEP_MS = smokeMode ? 600 : chatOnly ? 800 : 2000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function makeRequest(options, postData) {
    return new Promise((resolve, reject) => {
        const url = new URL(BASE_URL + options.path);
        const reqOptions = {
            hostname: url.hostname,
            port:     url.port,
            path:     url.pathname + url.search,
            method:   options.method || 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${API_KEY}`,
                ...options.headers
            }
        };

        const req = http.request(reqOptions, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
                if (options.onChunk) options.onChunk(chunk.toString());
            });
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, data }));
        });

        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req.destroy(new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms`));
        });
        req.on('error', (e) => reject(e));
        if (postData) req.write(JSON.stringify(postData));
        req.end();
    });
}

// Returns true if the status code is a definitive failure (not a transient rate-limit).
// On 429/503 we still short-circuit (quota exhausted = test is meaningless) but mark differently.
function isDefinitiveFailure(statusCode) {
    return statusCode >= 500 && statusCode !== 503;
}

async function fetchHealth() {
    try {
        const res = await makeRequest({ path: '/provider_health', method: 'GET' });
        const d = JSON.parse(res.data);
        const byProvider = {};
        for (const item of d.items) {
            const p = item.provider;
            if (!byProvider[p]) byProvider[p] = { healthy: 0, total: 0 };
            byProvider[p].total  += 1;
            if (item.isHealthy) byProvider[p].healthy += 1;
        }
        return byProvider;
    } catch (e) {
        console.warn(`${YELLOW}[health] could not fetch /provider_health: ${e.message}${RESET}`);
        return {};
    }
}

const results = [];

async function testModel(modelId, provider) {
    const r = {
        model:    modelId,
        provider,
        chat:     { status: 'PENDING' },
        stream:   { status: 'SKIP' },
        tool:     { status: 'SKIP' },
        identity: { status: 'PENDING' },
    };
    results.push(r);

    console.log(`\n${BLUE}=== ${modelId}${RESET} ${DIM}(${provider})${RESET}`);

    // ── 1. Chat + identity ──────────────────────────────────────────────────
    let chatDefinitivelyFailed = false;
    try {
        const res = await makeRequest({ path: '/v1/chat/completions' }, {
            model:    modelId,
            messages: [{ role: 'user', content: 'Reply with OK only.' }],
            max_tokens: 15
        });

        const actualHeader   = res.headers['x-proxy-actual-model'];
        const actualProvider = res.headers['x-proxy-actual-provider'];
        const fallbackUsed   = res.headers['x-proxy-fallback-used'] === 'true';

        if (res.statusCode !== 200) {
            const err = (() => {
                try { return JSON.parse(res.data).error?.message || res.data.slice(0, 80); }
                catch { return res.data.slice(0, 80); }
            })();
            r.chat     = { status: 'FAIL', reason: `HTTP ${res.statusCode}: ${err}` };
            r.identity = { status: 'FAIL', reason: 'chat failed' };
            chatDefinitivelyFailed = isDefinitiveFailure(res.statusCode);
        } else {
            const json    = JSON.parse(res.data);
            const content = json.choices?.[0]?.message?.content
                         || json.choices?.[0]?.message?.reasoning_content
                         || json.choices?.[0]?.message?.reasoning;
            if (content && content.length > 0) {
                r.chat = { status: 'PASS' };
            } else if (json.choices?.[0]?.message?.tool_calls?.length) {
                r.chat = { status: 'PASS', details: 'tool_call instead of text' };
            } else {
                r.chat = { status: 'FAIL', reason: 'empty content' };
            }

            const jsonModel = json.model;
            if (actualHeader === modelId) {
                r.identity = { status: 'PASS', details: `provider=${actualProvider || provider}${jsonModel && jsonModel !== modelId ? ` upstream-renamed=${jsonModel}` : ''}` };
            } else if (fallbackUsed && actualHeader) {
                r.identity = { status: 'PASS', details: `fallback→${actualProvider} (served as ${actualHeader})` };
            } else if (!actualHeader) {
                r.identity = { status: 'FAIL', reason: 'no X-Proxy-Actual-Model header' };
            } else {
                r.identity = { status: 'FAIL', reason: `X-Proxy-Actual-Model=${actualHeader} !== requested ${modelId}` };
            }
        }
    } catch (e) {
        r.chat     = { status: 'ERROR', reason: e.message };
        r.identity = { status: 'ERROR', reason: 'chat errored' };
        chatDefinitivelyFailed = true;
    }

    // ── 2. Stream ───────────────────────────────────────────────────────────
    if (!noStream) {
        if (chatDefinitivelyFailed) {
            r.stream = { status: 'SKIP', reason: 'chat failed' };
        } else {
            try {
                let chunkCount = 0;
                const res = await makeRequest({
                    path: '/v1/chat/completions',
                    onChunk: (chunk) => { if (chunk.includes('data:')) chunkCount++; }
                }, {
                    model:    modelId,
                    messages: [{ role: 'user', content: 'Say hi.' }],
                    stream:   true,
                    max_tokens: 15
                });
                if (res.statusCode === 200 && chunkCount > 0) {
                    r.stream = { status: 'PASS', details: `${chunkCount} chunks` };
                } else if (res.statusCode === 200) {
                    r.stream = { status: 'FAIL', reason: 'no SSE chunks' };
                } else {
                    r.stream = { status: 'FAIL', reason: `HTTP ${res.statusCode}` };
                }
            } catch (e) {
                r.stream = { status: 'ERROR', reason: e.message };
            }
        }
    }

    // ── 3. Tool use ─────────────────────────────────────────────────────────
    if (!noTool) {
        if (chatDefinitivelyFailed) {
            r.tool = { status: 'SKIP', reason: 'chat failed' };
        } else {
            try {
                const res = await makeRequest({ path: '/v1/chat/completions' }, {
                    model:    modelId,
                    messages: [{ role: 'user', content: 'Use calculate_sum to compute 10+20.' }],
                    max_tokens: 50,
                    tools: [{
                        type: 'function',
                        function: {
                            name:        'calculate_sum',
                            description: 'Sum two numbers',
                            parameters: {
                                type: 'object',
                                properties: {
                                    a: { type: 'number' },
                                    b: { type: 'number' }
                                },
                                required: ['a', 'b']
                            }
                        }
                    }]
                });
                if (res.statusCode === 200) {
                    const json = JSON.parse(res.data);
                    const tc   = json.choices?.[0]?.message?.tool_calls?.[0];
                    const text = (json.choices?.[0]?.message?.content || '').toLowerCase();
                    if (tc)              r.tool = { status: 'PASS', details: tc.function?.name || 'tool_call' };
                    else if (text.includes('30')) r.tool = { status: 'PASS', details: 'answered in text' };
                    else                 r.tool = { status: 'FAIL', reason: 'no tool_call, no 30 in text' };
                } else {
                    r.tool = { status: 'FAIL', reason: `HTTP ${res.statusCode}` };
                }
            } catch (e) {
                r.tool = { status: 'ERROR', reason: e.message };
            }
        }
    }

    // ── Output ──────────────────────────────────────────────────────────────
    const icon = (s) => s === 'PASS' ? `${GREEN}✓${RESET}` : s === 'SKIP' ? `${DIM}–${RESET}` : `${RED}✗${RESET}`;
    const fmt  = (k) => {
        const t = r[k];
        if (t.status === 'SKIP' && !t.reason) return null; // hide cleanly skipped tests
        return `${icon(t.status)} ${k}${t.reason ? ` ${DIM}(${t.reason})${RESET}` : (t.details ? ` ${DIM}(${t.details})${RESET}` : '')}`;
    };
    const parts = ['chat', 'stream', 'tool', 'identity'].map(fmt).filter(Boolean);
    console.log(`  ${parts.join('  ')}`);
}

async function run() {
    const modeLabel = smokeMode ? 'smoke' : chatOnly ? 'chat-only' : 'full';
    console.log(`${YELLOW}Unified Test Suite — ${modeLabel} mode, sequential, rate-limited${RESET}`);
    console.log(`${DIM}base=${BASE_URL} timeout=${REQUEST_TIMEOUT_MS}ms sleep=${SLEEP_MS}ms${RESET}`);

    let providerModels;
    try {
        const modulePath = path.join(process.cwd(), 'src/providers/provider-models.js');
        const module     = await import('file://' + modulePath);
        providerModels   = module.PROVIDER_MODELS;
    } catch (e) {
        console.error(`${RED}Failed to load provider models: ${e.message}${RESET}`);
        process.exit(1);
    }

    const health = await fetchHealth();
    console.log('\nProvider health snapshot:');
    for (const [p, c] of Object.entries(health)) {
        const colour = c.healthy === c.total ? GREEN : (c.healthy === 0 ? RED : YELLOW);
        console.log(`  ${colour}${p}: ${c.healthy}/${c.total} healthy${RESET}`);
    }

    let totalTested  = 0;
    let totalSkipped = 0;

    for (const [provider, models] of Object.entries(providerModels)) {
        if (filterProvider && provider !== filterProvider) continue;

        const h          = health[provider];
        const hasHealthy = h ? h.healthy > 0 : false;
        if (!hasHealthy && !includeUnhealthy) {
            console.log(`\n${DIM}-- skipping provider ${provider}: ${h ? `${h.healthy}/${h.total} healthy` : 'no accounts'} (--include-unhealthy to force)${RESET}`);
            totalSkipped += models.length;
            continue;
        }

        // In smoke mode: pick one representative model per provider.
        let testModels = models;
        if (smokeMode) {
            const smokeId = SMOKE_MODEL[provider] || models[0];
            if (!smokeId) {
                console.log(`\n${DIM}-- skipping provider ${provider}: no smoke model defined and static list is empty${RESET}`);
                continue;
            }
            testModels = [smokeId];
        }

        for (const modelId of testModels) {
            if (filterModel && modelId !== filterModel) continue;
            await testModel(modelId, provider);
            totalTested += 1;
            await sleep(SLEEP_MS);
        }
    }

    console.log(`\n${YELLOW}=== Summary (${totalTested} tested, ${totalSkipped} skipped) ===${RESET}`);
    const summary = results.map(r => ({
        Model:    r.model,
        Provider: r.provider,
        Chat:     r.chat.status,
        Stream:   r.stream.status,
        Tool:     r.tool.status,
        ID:       r.identity.status
    }));
    if (summary.length > 0) console.table(summary);

    const checks = results.flatMap(r => [r.chat, r.stream, r.tool, r.identity]
        .filter(s => s.status !== 'SKIP'));
    const passed = checks.filter(s => s.status === 'PASS').length;
    const total  = checks.length;
    const colour = passed === total ? GREEN : (passed > total / 2 ? YELLOW : RED);
    console.log(`\n${colour}Score: ${passed}/${total} checks passed${RESET}`);

    if (passed < total) {
        console.log(`\n${RED}Failures:${RESET}`);
        for (const r of results) {
            for (const k of ['chat', 'stream', 'tool', 'identity']) {
                const s = r[k];
                if (s.status !== 'PASS' && s.status !== 'SKIP' && s.status !== 'PENDING') {
                    console.log(`  ${r.model} (${r.provider}) :: ${k} :: ${s.status} :: ${s.reason || '?'}`);
                }
            }
        }
    }

    process.exit(passed === total ? 0 : 1);
}

run().catch(e => {
    console.error(`${RED}Fatal: ${e.message}${RESET}`);
    process.exit(2);
});
