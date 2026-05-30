#!/usr/bin/env node
/**
 * live-verify.cjs — Accurate, quota-safe live verification for AIClient2API.
 *
 * WHY THIS EXISTS
 *   The older smoke scripts (master-smoke-test.cjs, omni-test.cjs) report false
 *   positives: they pass on HTTP 200 + loose string matching (e.g. accepting any
 *   reply containing "30" as a passing tool test), so a model that fails in real
 *   Claude Code use still shows green. This suite instead makes a real, minimal
 *   call to each model on the exact path Claude Code uses (/v1/messages) and
 *   PASSES only on semantically valid output.
 *
 * WHAT "ACCURATE" MEANS HERE
 *   - chat PASS  ⟺ HTTP 200 AND the Anthropic response has a non-empty text block.
 *                  Empty content [], error payloads wrapped in 200, and timeouts FAIL.
 *   - tool PASS  ⟺ the model emits a well-formed tool_use block (name + numeric
 *                  inputs). A text answer that merely contains the number FAILS.
 *   - We distinguish "config loaded" (the id is in the catalog) from "responded"
 *     (the model actually produced valid output) — only the latter is a PASS.
 *
 * ROUTING-IDENTITY CAVEAT (verified 2026-05-30)
 *   X-Proxy-Actual-Provider and X-Proxy-Fallback-Used are NOT reliable: they echo
 *   the requested provider/“true” even on direct hits, and X-Proxy-Actual-Model
 *   echoes the requested id. So this suite does NOT trust them as a served-by
 *   signal. It reports X-Proxy-Actual-Model only as an advisory note when it
 *   clearly differs from the requested model. The trustworthy signals are the
 *   HTTP status and the semantic validity of the body.
 *
 * QUOTA SAFETY
 *   - max_tokens is small but non-trivial (16 chat / 64 tool) so the model really
 *     generates rather than returning a cached/empty stub.
 *   - Calls are rate-limited (default 2s; 1.2s in --quick).
 *   - --quick tests ONE representative model per provider instead of the full set.
 *   - Providers with zero healthy accounts are skipped (unless --include-unhealthy).
 *   - The tool probe is a single lightweight call; it never executes the tool.
 *
 * USAGE
 *   node scripts/live-verify.cjs                 # full: chat + tool, every model
 *   node scripts/live-verify.cjs --quick         # one model per provider, chat only
 *   node scripts/live-verify.cjs --no-tool       # chat only, every model
 *   node scripts/live-verify.cjs --provider=claude-kiro-oauth
 *   node scripts/live-verify.cjs --model=opus-4-8
 *   node scripts/live-verify.cjs --include-unhealthy
 *   node scripts/live-verify.cjs --json          # machine-readable report to stdout
 */

'use strict';

const http = require('http');
const { execSync } = require('child_process');

// ── memory safety guard ───────────────────────────────────────────────────────────
// This 16GB Mac has crashed via a jetsam / WindowServer-watchdog kernel panic when a
// workload pushed resident memory past the threshold while RAM was already saturated by
// the background node/MCP + IDE fleet (see CLAUDE.md, Troubleshooting Issue 10). A live
// sweep adds gateway load (adapter rotation, reasoning-model generation), so this suite
// refuses to start — and aborts mid-run — when reclaimable RAM falls below a floor.
// Mirrors scripts/safe-restart.sh. Override for headless/non-mac use with MEM_FLOOR_MB=0.
const MEM_FLOOR_MB = process.env.MEM_FLOOR_MB !== undefined ? Number(process.env.MEM_FLOOR_MB) : 2048;
const PAGE_SIZE = (() => {
    try { return parseInt(execSync('sysctl -n hw.pagesize', { encoding: 'utf8' }).trim(), 10) || 4096; }
    catch { return 4096; }
})();
function reclaimableMB() {
    try {
        const vm = execSync('vm_stat', { encoding: 'utf8' });
        const pages = re => { const m = vm.match(re); return m ? parseInt(m[1].replace(/[.,]/g, ''), 10) : 0; };
        // free + speculative + inactive + purgeable = the set the kernel reclaims under
        // pressure (must match safe-restart.sh and zshrc _ensure_gateways).
        const reclaimable = pages(/Pages free:\s+(\d+)/) + pages(/Pages speculative:\s+(\d+)/) + pages(/Pages inactive:\s+(\d+)/) + pages(/Pages purgeable:\s+(\d+)/);
        return Math.round((reclaimable * PAGE_SIZE) / (1024 * 1024));
    } catch { return null; } // non-macOS / unavailable → can't measure, don't block
}

// ── config ──────────────────────────────────────────────────────────────────────
const API_KEY  = process.env.AICLIENT_TOKEN || 'sk-a60f3efdf9b97e63c84ab4a3583f9d1c';
const HOST      = '127.0.0.1';
const PORT      = 3000;
const TIMEOUT   = 30000;

const RED='\x1b[31m', GREEN='\x1b[32m', YELLOW='\x1b[33m', BLUE='\x1b[34m',
      CYAN='\x1b[36m', DIM='\x1b[2m', BOLD='\x1b[1m', RESET='\x1b[0m';

// ── args ────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const QUICK            = args.includes('--quick');
const NO_TOOL          = args.includes('--no-tool') || QUICK; // --quick is chat-only
const INCLUDE_UNHEALTHY= args.includes('--include-unhealthy');
const JSON_OUT         = args.includes('--json');
const FILTER_PROVIDER  = (args.find(a => a.startsWith('--provider=')) || '').split('=')[1] || null;
const FILTER_MODEL     = (args.find(a => a.startsWith('--model=')) || '').split('=')[1] || null;
const RATE_MS          = QUICK ? 1200 : 2000;

// Cheap/representative model (by id suffix) to use for --quick, per provider.
const QUICK_PREF = {
    'claude-kiro-oauth':   'claude-haiku-4-5',
    'gemini-cli-oauth':    'gemini-2.5-flash-lite',
    'gemini-antigravity':  'gemini-2.5-flash-lite',
    'github-models':       'gpt-4o-mini',
    'nvidia-nim':          'openai/gpt-oss-20b',
    'openai-codex-oauth':  'gpt-5.4-mini',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

// ── low-level request helper ──────────────────────────────────────────────────────
function request(path, method, body) {
    return new Promise((resolve) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
            host: HOST, port: PORT, path, method,
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
            timeout: TIMEOUT,
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
        });
        req.on('error', e => resolve({ status: 0, headers: {}, data: '', error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, data: '', error: 'timeout' }); });
        if (payload) req.write(payload);
        req.end();
    });
}

// ── catalog + health ──────────────────────────────────────────────────────────────
async function getCatalog() {
    const res = await request('/v1/models', 'GET');
    if (res.status !== 200) throw new Error(`/v1/models returned HTTP ${res.status}${res.error ? ' (' + res.error + ')' : ''}`);
    const data = JSON.parse(res.data).data || [];
    // Claude Code's /model picker uses the claude-prefixed ids; test exactly those.
    // Dedupe by (owned_by, model-part) so we test each underlying model once.
    const seen = new Set();
    const out = [];
    for (const m of data) {
        if (typeof m.id !== 'string' || !m.id.startsWith('claude-')) continue;
        const provider = m.owned_by || m.id.split(':')[0];
        const modelPart = m.id.split(':').slice(1).join(':');
        const key = `${provider}::${modelPart}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id: m.id, provider, model: modelPart, display: m.display_name || m.id });
    }
    return out;
}

async function getHealth() {
    try {
        const res = await request('/provider_health', 'GET');
        const d = JSON.parse(res.data);
        const by = {};
        for (const it of d.items) {
            by[it.provider] = by[it.provider] || { healthy: 0, total: 0 };
            by[it.provider].total++;
            if (it.isHealthy) by[it.provider].healthy++;
        }
        return by;
    } catch (e) {
        log(`${YELLOW}[health] could not fetch /provider_health: ${e.message}${RESET}`);
        return {};
    }
}

// ── probes ────────────────────────────────────────────────────────────────────────
function describeError(res) {
    if (res.error) return res.error;
    try { return JSON.parse(res.data).error?.message || res.data.slice(0, 120); }
    catch { return (res.data || '').slice(0, 120); }
}

// Evaluate a single /v1/messages response. Returns a verdict plus `truncatedReasoning`
// when the model emitted only a <thinking> block that was cut off by max_tokens —
// the one case where a larger-budget retry is warranted (reasoning models).
function evalChatResponse(res) {
    const actual = res.headers['x-proxy-actual-model'];
    if (res.status !== 200) return { status: 'FAIL', reason: `HTTP ${res.status}: ${describeError(res)}`, actual };
    let j;
    try { j = JSON.parse(res.data); } catch { return { status: 'FAIL', reason: 'invalid JSON body', actual }; }
    if (j.type === 'error' || j.error) return { status: 'FAIL', reason: `error payload: ${j.error?.message || ''}`, actual };
    const blocks = Array.isArray(j.content) ? j.content : [];
    const text = (blocks.find(b => b.type === 'text')?.text || '').trim();
    if (text) return { status: 'PASS', reason: text.slice(0, 40), actual, upstream: j.model };
    const thinking = blocks.find(b => b.type === 'thinking' && String(b.thinking || '').trim());
    if (thinking && j.stop_reason === 'max_tokens') {
        return { status: 'FAIL', reason: 'reasoning truncated by budget', actual, truncatedReasoning: true };
    }
    return { status: 'FAIL', reason: 'empty content (200 but no text)', actual };
}

function chatBody(id, maxTok) {
    return { model: id, max_tokens: maxTok, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] };
}

// chat: PASS only on a non-empty Anthropic text block. Reasoning-model aware — a tiny
// default budget, with a single larger-budget retry when (and only when) the model
// produced a truncated <thinking> block and no text yet.
async function probeChat(id) {
    const first = evalChatResponse(await request('/v1/messages', 'POST', chatBody(id, 24)));
    if (first.status === 'PASS' || !first.truncatedReasoning) return first;
    // Reasoning model starved by the 24-token budget — give it room to finish, once.
    const second = evalChatResponse(await request('/v1/messages', 'POST', chatBody(id, 400)));
    if (second.status === 'PASS') return { ...second, reason: `${second.reason} (reasoning model)` };
    return { status: 'FAIL', reason: 'reasoning-only, no text even at 400 tokens', actual: second.actual };
}

// tool: PASS only on a well-formed tool_use block (name + numeric inputs). No text shortcut.
async function probeTool(id) {
    const res = await request('/v1/messages', 'POST', {
        model: id, max_tokens: 64,
        tools: [{
            name: 'calculate_sum',
            description: 'Add two numbers and return the sum.',
            input_schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
        }],
        messages: [{ role: 'user', content: 'Use the calculate_sum tool to add 2 and 3. Call the tool; do not answer in text.' }],
    });
    if (res.status !== 200) return { status: 'FAIL', reason: `HTTP ${res.status}: ${describeError(res)}` };
    let j;
    try { j = JSON.parse(res.data); } catch { return { status: 'FAIL', reason: 'invalid JSON body' }; }
    const tu = Array.isArray(j.content) ? j.content.find(b => b.type === 'tool_use') : null;
    if (!tu) return { status: 'FAIL', reason: 'no tool_use block (model answered in text or refused)' };
    if (tu.name !== 'calculate_sum') return { status: 'FAIL', reason: `wrong tool: ${tu.name}` };
    const a = tu.input?.a, b = tu.input?.b;
    if (typeof a !== 'number' || typeof b !== 'number') return { status: 'FAIL', reason: `malformed input: ${JSON.stringify(tu.input)}` };
    return { status: 'PASS', reason: `tool_use a=${a} b=${b}` };
}

// ── run ─────────────────────────────────────────────────────────────────────────
async function run() {
    log(`${BOLD}AIClient2API live-verify${RESET} ${DIM}(${QUICK ? 'quick' : NO_TOOL ? 'chat-only' : 'full'}, rate ${RATE_MS}ms)${RESET}`);

    // Memory pre-flight: refuse to start if reclaimable RAM is below the floor.
    // Mirrors scripts/safe-restart.sh — a full sweep on a saturated Mac risks a
    // jetsam memory panic. Override with MEM_FLOOR_MB=0.
    const memMB = reclaimableMB();
    if (MEM_FLOOR_MB > 0 && memMB !== null && memMB < MEM_FLOOR_MB) {
        const msg = `Insufficient reclaimable RAM: ${memMB}MB available, ${MEM_FLOOR_MB}MB required. Refusing to start sweep (would risk a jetsam memory panic). Override with MEM_FLOOR_MB=0.`;
        if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: msg }));
        else console.error(`${RED}${msg}${RESET}`);
        process.exit(2);
    }

    // Gateway reachable?
    const help = await request('/api/help', 'GET');
    if (help.status !== 200) {
        const msg = `Gateway not reachable at http://${HOST}:${PORT} (HTTP ${help.status}${help.error ? ', ' + help.error : ''}). Start it: ./scripts/safe-restart.sh`;
        if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: msg }));
        else console.error(`${RED}${msg}${RESET}`);
        process.exit(2);
    }

    const [catalog, health] = await Promise.all([getCatalog(), getHealth()]);

    // Group by provider.
    const byProvider = {};
    for (const m of catalog) {
        if (FILTER_PROVIDER && m.provider !== FILTER_PROVIDER) continue;
        if (FILTER_MODEL && !m.id.includes(FILTER_MODEL)) continue;
        (byProvider[m.provider] = byProvider[m.provider] || []).push(m);
    }

    const results = [];
    let tested = 0, skipped = 0;

    for (const provider of Object.keys(byProvider).sort()) {
        // Mid-run memory check: abort if RAM drops below the floor during the sweep.
        const midMem = reclaimableMB();
        if (MEM_FLOOR_MB > 0 && midMem !== null && midMem < MEM_FLOOR_MB) {
            log(`\n${RED}${BOLD}Memory dropped below ${MEM_FLOOR_MB}MB floor (${midMem}MB). Aborting sweep to prevent a system crash.${RESET}`);
            break;
        }

        const h = health[provider];
        const healthy = h ? h.healthy > 0 : true; // unknown health → attempt
        log(`\n${BLUE}${BOLD}▌ ${provider}${RESET} ${DIM}${h ? `[${h.healthy}/${h.total} healthy]` : '[health unknown]'}${RESET}`);

        if (!healthy && !INCLUDE_UNHEALTHY) {
            log(`  ${DIM}skipped — 0 healthy accounts (use --include-unhealthy to force)${RESET}`);
            byProvider[provider].forEach(() => skipped++);
            continue;
        }

        let models = byProvider[provider];
        if (QUICK) {
            const pref = QUICK_PREF[provider];
            const pick = (pref && models.find(m => m.model === pref || m.id.endsWith(pref))) || models[0];
            models = pick ? [pick] : [];
        }

        for (const m of models) {
            const r = { provider, id: m.id, display: m.display, chat: null, tool: { status: 'SKIP' } };
            const chat = await probeChat(m.id);
            r.chat = chat;
            tested++;

            let toolStr = '';
            if (!NO_TOOL && chat.status === 'PASS') {
                await sleep(RATE_MS);
                r.tool = await probeTool(m.id);
                toolStr = r.tool.status === 'PASS'
                    ? `  ${DIM}tool ${GREEN}✓${RESET}`
                    : `  ${DIM}tool ${RED}✗ ${r.tool.reason}${RESET}`;
            }

            const icon = chat.status === 'PASS' ? `${GREEN}✓ PASS${RESET}` : `${RED}✗ FAIL${RESET}`;
            const advisory = (chat.actual && m.model && chat.actual !== m.model && !chat.actual.endsWith(m.model))
                ? ` ${YELLOW}⚠ served-as=${chat.actual}${RESET}` : '';
            log(`  ${icon} ${m.id.replace(/^claude-/, '')} ${DIM}— ${chat.reason}${RESET}${advisory}${toolStr}`);
            results.push(r);
            await sleep(RATE_MS);
        }
    }

    // ── report ────────────────────────────────────────────────────────────────────
    const chatPass = results.filter(r => r.chat.status === 'PASS').length;
    const chatFail = results.filter(r => r.chat.status === 'FAIL');
    const toolTested = results.filter(r => r.tool.status !== 'SKIP');
    const toolPass = toolTested.filter(r => r.tool.status === 'PASS').length;

    if (JSON_OUT) {
        console.log(JSON.stringify({
            ok: chatFail.length === 0,
            mode: QUICK ? 'quick' : NO_TOOL ? 'chat-only' : 'full',
            tested, skipped,
            chat: { pass: chatPass, fail: chatFail.length },
            tool: { tested: toolTested.length, pass: toolPass },
            results: results.map(r => ({
                provider: r.provider, id: r.id,
                chat: r.chat.status, chatReason: r.chat.reason,
                tool: r.tool.status, toolReason: r.tool.reason || null,
            })),
            failures: chatFail.map(r => ({ id: r.id, reason: r.chat.reason })),
        }, null, 2));
        return;
    }

    log(`\n${BOLD}${YELLOW}═══ Summary ═══${RESET}`);
    log(`  responded (chat): ${chatPass}/${tested} ${chatPass === tested ? GREEN + 'all PASS' : RED + (tested - chatPass) + ' FAIL'}${RESET}`);
    if (toolTested.length) log(`  tool-use:         ${toolPass}/${toolTested.length} passed`);
    if (skipped) log(`  ${DIM}skipped (unhealthy/not selected): ${skipped}${RESET}`);
    log(`  ${DIM}note: "responded" = model produced valid output, not just that the config loaded.${RESET}`);

    if (chatFail.length) {
        log(`\n${RED}${BOLD}Failures (config-loaded but did NOT respond correctly):${RESET}`);
        for (const r of chatFail) log(`  ${RED}✗${RESET} ${r.id} ${DIM}— ${r.chat.reason}${RESET}`);
    } else {
        log(`\n${GREEN}${BOLD}All tested models responded with valid output.${RESET}`);
    }

    process.exit(chatFail.length === 0 ? 0 : 1);
}

run().catch(e => {
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: e.message }));
    else console.error(`${RED}live-verify crashed: ${e.message}${RESET}`);
    process.exit(2);
});
