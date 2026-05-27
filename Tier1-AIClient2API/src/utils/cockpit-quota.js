import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';

// Polling the report triggers Cockpit's OAuth refresh for all accounts (10 min = Cockpit's auth window)
const REPORT_URL   = 'http://127.0.0.1:18081/report?token=C-Code-CLI-Model-API';
const REFRESH_MS   = 10 * 60 * 1000;

// File fallback when Cockpit is closed / HTTP unreachable
const COCKPIT_DIR    = path.join(os.homedir(), '.antigravity_cockpit');
const ACCOUNTS_INDEX = path.join(COCKPIT_DIR, 'accounts.json');
const ACCOUNTS_DIR   = path.join(COCKPIT_DIR, 'accounts');

// Antigravity report uses human-readable display names; map them to the model IDs
// that _toCockpitId() produces from proxy model IDs.
const ANTIGRAVITY_DISPLAY_TO_ID = {
    'claude sonnet 4.6 (thinking)': 'claude-sonnet-4-6',
    'claude opus 4.6 (thinking)':   'claude-opus-4-6-thinking',
    'gemini 3.1 pro (high)':        'gemini-3.1-pro-high',
    'gemini 3.1 pro (low)':         'gemini-3.1-pro-low',
    'gemini 3 flash':               'gemini-3-flash',
    'gemini 2.5 pro':               'gemini-2.5-pro',
    'gemini 3.5 flash (high)':      'gemini-3-flash-agent',
    'gemini 3.5 flash (medium)':    'gemini-3.5-flash-low',
    'gemini 3.5 flash (low)':       'gemini-3.5-flash-extra-low',
    'gemini 3.1 flash image':       'gemini-3.1-flash-image',
    'gemini 3.1 flash lite':        'gemini-3.1-flash-lite',
};

let _cache = new Map();
let _lastReportText = '';
let _timer = null;
let _started = false;

// 'gemini-claude-sonnet-4-6' → 'claude-sonnet-4-6'; Gemini model IDs pass through unchanged
function _toCockpitId(proxyModelId) {
    if (!proxyModelId) return null;
    return proxyModelId.startsWith('gemini-claude-') ? proxyModelId.slice(7) : proxyModelId;
}

/**
 * Parse the Markdown table into Map<email, Map<cockpitModelId, remainingPercentage>>.
 * Uses minimum remaining% when the same account+model appears in multiple rows.
 */
function _parseReport(text) {
    const result = new Map();
    for (const line of text.split('\n')) {
        if (!line.startsWith('| ') || line.startsWith('| ---') || line.startsWith('| Service')) continue;
        const [, service, rawEmail, rawMetric, , remaining] = line.split('|').map(s => s.trim());
        const email  = rawEmail?.toLowerCase();
        const metric = rawMetric?.toLowerCase();
        if (!email || !metric || !remaining) continue;

        const pct = parseInt(remaining, 10);
        if (isNaN(pct)) continue;

        let modelId;
        if (service === 'Antigravity IDE' || service === 'Antigravity') {
            modelId = ANTIGRAVITY_DISPLAY_TO_ID[metric];
        } else if (service === 'Gemini') {
            // Gemini CLI rows use model IDs directly; Antigravity uses display names
            modelId = metric;
        }
        if (!modelId) continue;

        if (!result.has(email)) result.set(email, new Map());
        const modelMap = result.get(email);
        const existing = modelMap.get(modelId);
        if (existing === undefined || pct < existing) modelMap.set(modelId, pct);
    }
    return result;
}

// Returns parsed Map on new data, null if text unchanged (HTTP healthy, no update needed), throws on error
async function _refreshFromHttp() {
    const res = await fetch(REPORT_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`report HTTP ${res.status}`);
    const text = await res.text();
    if (text === _lastReportText) return null;
    _lastReportText = text;
    return _parseReport(text);
}

async function _readJson(p) {
    try { return JSON.parse(await fsp.readFile(p, 'utf-8')); } catch { return null; }
}

async function _refreshFromFiles() {
    const index = await _readJson(ACCOUNTS_INDEX);
    if (!Array.isArray(index?.accounts)) return null;

    const result = new Map();
    await Promise.allSettled(index.accounts.map(async ({ id, email }) => {
        if (!id || !email) return;
        const data = await _readJson(path.join(ACCOUNTS_DIR, `${id}.json`));
        if (!data?.quota?.models) return;
        const modelMap = new Map();
        for (const { name, percentage } of data.quota.models) {
            if (typeof name === 'string' && typeof percentage === 'number') {
                modelMap.set(name, percentage);
            }
        }
        result.set(email.toLowerCase(), modelMap);
    }));
    return result.size > 0 ? result : null;
}

async function _refresh() {
    try {
        const next = await _refreshFromHttp();
        if (next !== null && next.size > 0) _cache = next;
        return; // HTTP was reachable; skip file fallback
    } catch { /* HTTP unavailable */ }
    try {
        const fb = await _refreshFromFiles();
        if (fb && fb.size > 0) _cache = fb;
    } catch { }
}

export function start() {
    if (_started) return;
    _started = true;
    setImmediate(() => _refresh().catch(() => {}));
    _timer = setInterval(() => _refresh().catch(() => {}), REFRESH_MS);
    if (_timer.unref) _timer.unref();
}

export function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    _started = false;
}

/**
 * Score penalty: 0 (full quota / unknown) → 1e11 (exhausted).
 * Scale: (100 - remaining%) × 1e9. Sits between base scores (~1.7e12) and
 * health/concurrency tiers (1e15+) — nudges account order without overriding either.
 */
export function getQuotaPenalty(email, proxyModelId) {
    if (!email || !proxyModelId || _cache.size === 0) return 0;
    const modelMap = _cache.get(email.toLowerCase());
    if (!modelMap) return 0;
    const pct = modelMap.get(_toCockpitId(proxyModelId));
    return typeof pct === 'number' ? (100 - pct) * 1e9 : 0;
}

export function getCacheSnapshot() {
    const out = {};
    for (const [email, m] of _cache) out[email] = Object.fromEntries(m);
    return out;
}
