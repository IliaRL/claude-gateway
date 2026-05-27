#!/usr/bin/env node
/**
 * fix-staging-api.mjs
 *
 * Fixes: "Gemini for Google Cloud API (Staging) has not been used in project X"
 *
 * ROOT CAUSE
 * ----------
 * Each Google account has an auto-created ephemeral GCP project. The proxy calls
 * daily-cloudcode-pa.sandbox.googleapis.com which requires "Gemini for Google Cloud
 * API (Staging)" to be enabled in that project. For brand-new accounts this API has
 * never been activated.
 *
 * FIX
 * ---
 * Calling loadCodeAssist → onboardUser (same bootstrap sequence the proxy uses)
 * on the SANDBOX endpoint triggers the first-time API enablement for each account.
 * After this script runs successfully for an account, the proxy will work normally.
 *
 * USAGE
 * -----
 *   node scripts/fix-staging-api.mjs
 *
 * The script reads refresh tokens from the inline ACCOUNTS list (or you can point it
 * at your configs/antigravity directory), then bootstraps every account sequentially.
 */

import { OAuth2Client } from 'google-auth-library';

// ─── Antigravity OAuth credentials (same as antigravity-core.js) ─────────────
const OAUTH_CLIENT_ID     = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';

// The SANDBOX endpoint is the one that requires the staging API enablement
const BASE_URL      = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const API_VERSION   = 'v1internal';
const USER_AGENT    = 'antigravity/1.104.0 darwin/arm64';

// ─── All 13 accounts ─────────────────────────────────────────────────────────
const ACCOUNTS = [
  { email: 'xxiliarlxx@gmail.com',        refresh_token: '1//0cnUphM0yHx7RCgYIARAAGAwSNwF-L9IryY1WgiYVoZck7kpxKI9-HbtkXM8Ca1bgRHyf132uEYuCn9CPHfwSbJ3Oni-VSgHsxA4' },
  { email: 'iliarl353@gmail.com',          refresh_token: '1//0cKaID8TDO9IkCgYIARAAGAwSNwF-L9IreLNnNfKNNQFBwz7PKqzlKl-d7gEhk5KgOAxfhs594hyRfkGcgcLUaCPXePecxVi9iOU' },
  { email: 'ourneeds.inc@gmail.com',       refresh_token: '1//0c4LcHKZZhfjFCgYIARAAGAwSNwF-L9IrubCtxxVJEKjf5jADWks8Pk2G3pBKE1lXKh4cOZvu9yXqjcXvv2d_WiMN9A_5bsSl8so' },
  { email: 'alvarbtchmnnn@gmail.com',      refresh_token: '1//0czZN7zgPpocICgYIARAAGAwSNwF-L9IrrBDdE_rmHWs4lbDVFcal7uARAdgFeNr1z3HgKAUbzFsh2JkOlOENOVQRjlzsYMDMXL0' },
  { email: '252iliarl@gmail.com',          refresh_token: '1//0crxRkgYivB2vCgYIARAAGAwSNwF-L9IrYjY2b8WiF3jH2BldKFGZp36nCfambBLgPcRnk1vu91ilGPGij6C5Vdzu8Mvi9mLjXq4' },
  { email: 'slots2472@gmail.com',          refresh_token: '1//0cqOYnsl_YG6QCgYIARAAGAwSNwF-L9IrK6PPv_rGFajQ9pCP6tZPGuaA6RRdCNag2NbenuERZ5_Wk8pha6FL4PorY_2OycHOZmY' },
  { email: 'rightatyourdoor33@gmail.com',  refresh_token: '1//0ce7mC6oPKOmRCgYIARAAGAwSNwF-L9Irohymq6ekkY_WidHOod5C22sUJ_mRxEQlss0VBj5KNiNHl_z9fgDegn9LnNtV_t3AbJc' },
  { email: 'rlmusic05@gmail.com',          refresh_token: '1//0c99VVb1EV0l3CgYIARAAGAwSNwF-L9IrcOTqm7ykzq1EpK3v9ImYOfYbirHZOuhiQtEEwJmuuJPASOGhDjQOhTYCoGq5cM02ILg' },
  { email: 'izzyrlmusic@gmail.com',        refresh_token: '1//0cI8YoltqFOGWCgYIARAAGAwSNwF-L9IrgHRWZT_dz_2iB4X8uqwcHSdcqQYs3MW0d1EtdSQVhgbngy-fKhlkLrVZbu1j9s03zxY' },
  { email: 'u3804759745@gmail.com',        refresh_token: '1//0cFnS-mVhnt3mCgYIARAAGAwSNgF-L9IrC3_cKaGtSEEcunPT0Imlv-IF2epJyAiEQCk4MZaCHgWFrYMH19JCH1W_pA5gWpAo-Q' },
  { email: 'bagginsb577@gmail.com',        refresh_token: '1//0cEf_xTEn1eVzCgYIARAAGAwSNwF-L9IrqExYqKBGK7msi3zvDXRj19n1s_DsAQRM6nwuNe5OxiZ9Bh4GiEWr7gIFm3N_UjS91xE' },
  { email: 'leenakata88@gmail.com',        refresh_token: '1//0cjsmh9tq3zYJCgYIARAAGAwSNwF-L9Ir1ulu-UPh5YYX6yWryIa5pzJhYgMRcgPdBPCG7tRm0LLnQDpyfHMkRo-6VJ0hrpgKF0Q' },
  { email: 'j34114095@gmail.com',          refresh_token: '1//0cwLYAFr2jKsvCgYIARAAGAwSNwF-L9IrVgNoBAHVD8w-2hnQ8-JGsILXaEMnUpgLrJlhR2Xzly3q32gzLHjZRh-nVSCHgXBAUyU' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(emoji, msg)   { console.log(`${emoji}  ${msg}`); }
function ok(msg)           { log('✅', msg); }
function warn(msg)         { log('⚠️ ', msg); }
function fail(msg)         { log('❌', msg); }
function info(msg)         { log('ℹ️ ', msg); }
function section(msg)      { console.log(`\n${'─'.repeat(60)}\n   ${msg}\n${'─'.repeat(60)}`); }

/**
 * Call any v1internal method on the Antigravity sandbox API.
 */
async function callApi(authClient, method, body) {
  const url = `${BASE_URL}/${API_VERSION}:${method}`;
  const res = await authClient.request({
    url,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    responseType: 'json',
    body: JSON.stringify(body),
  });
  return res.data;
}

/**
 * Bootstrap a single account:
 *  1. Refresh the access token
 *  2. Call loadCodeAssist  → discovers existing GCP project OR returns allowedTiers
 *  3. If no project yet, call onboardUser to create one (enables the Staging API)
 *  4. Return summary
 */
async function bootstrapAccount(account) {
  const { email, refresh_token } = account;

  const authClient = new OAuth2Client({
    clientId:     OAUTH_CLIENT_ID,
    clientSecret: OAUTH_CLIENT_SECRET,
  });

  // Load the refresh token — no need for an existing access_token
  authClient.setCredentials({ refresh_token });

  // ── Step 1: Refresh access token ──────────────────────────────────────────
  info(`[${email}] Refreshing access token...`);
  let newCredentials;
  try {
    const { credentials } = await authClient.refreshAccessToken();
    newCredentials = credentials;
    authClient.setCredentials(newCredentials);
    ok(`[${email}] Access token refreshed — expires ${new Date(newCredentials.expiry_date).toISOString()}`);
  } catch (err) {
    const msg = err.response?.data?.error_description || err.message;
    fail(`[${email}] Token refresh FAILED: ${msg}`);
    return { email, success: false, error: `Token refresh: ${msg}` };
  }

  const clientMetadata = {
    ideType:    'IDE_UNSPECIFIED',
    platform:   'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
    duetProject: '',
  };

  // ── Step 2: loadCodeAssist ─────────────────────────────────────────────────
  info(`[${email}] Calling loadCodeAssist on sandbox endpoint...`);
  let loadResponse;
  try {
    loadResponse = await callApi(authClient, 'loadCodeAssist', {
      cloudaicompanionProject: '',
      metadata: clientMetadata,
    });
  } catch (err) {
    const status  = err.response?.status;
    const errData = err.response?.data || err.message;
    const errMsg  = typeof errData === 'object' ? JSON.stringify(errData) : String(errData);

    // A 403 with "has not been used in project" during loadCodeAssist means the
    // staging API was NEVER enabled — onboardUser is the fix, but we need a
    // working access token first. If we get this here, try onboarding anyway.
    if (status === 403 && errMsg.toLowerCase().includes('has not been used in project')) {
      warn(`[${email}] Staging API not yet enabled (expected for new accounts). Attempting onboardUser...`);
      // Fall through to onboarding below by pretending loadResponse is empty
      loadResponse = null;
    } else {
      fail(`[${email}] loadCodeAssist FAILED (${status}): ${errMsg}`);
      return { email, success: false, error: `loadCodeAssist (${status}): ${errMsg}` };
    }
  }

  // If we already have a project, the staging API is already enabled.
  if (loadResponse?.cloudaicompanionProject) {
    ok(`[${email}] Already bootstrapped! Project: ${loadResponse.cloudaicompanionProject}`);
    return { email, success: true, projectId: loadResponse.cloudaicompanionProject, action: 'already_enabled' };
  }

  // ── Step 3: onboardUser ────────────────────────────────────────────────────
  // This is the call that creates the GCP project and enables the Staging API.
  const allowedTiers  = loadResponse?.allowedTiers || [];
  const defaultTier   = allowedTiers.find(t => t.isDefault);
  const tierId        = defaultTier?.id || 'free-tier';

  info(`[${email}] No project found. Running onboardUser (tier: ${tierId})...`);
  let lroResponse;
  try {
    lroResponse = await callApi(authClient, 'onboardUser', {
      tierId,
      cloudaicompanionProject: '',
      metadata: clientMetadata,
    });
  } catch (err) {
    const status  = err.response?.status;
    const errData = err.response?.data || err.message;
    const errMsg  = typeof errData === 'object' ? JSON.stringify(errData) : String(errData);
    fail(`[${email}] onboardUser FAILED (${status}): ${errMsg}`);
    return { email, success: false, error: `onboardUser (${status}): ${errMsg}` };
  }

  // ── Step 4: Poll until the LRO completes ──────────────────────────────────
  const MAX_POLLS    = 60;
  const POLL_DELAY   = 1000; // ms
  let pollCount      = 0;

  while (!lroResponse.done && pollCount < MAX_POLLS) {
    await new Promise(r => setTimeout(r, POLL_DELAY));
    try {
      lroResponse = await callApi(authClient, 'onboardUser', {
        tierId,
        cloudaicompanionProject: '',
        metadata: clientMetadata,
      });
    } catch (err) {
      warn(`[${email}] Poll ${pollCount + 1}: ${err.message}`);
    }
    pollCount++;
  }

  if (!lroResponse.done) {
    warn(`[${email}] onboardUser LRO did not complete within ${MAX_POLLS}s — try running again.`);
    return { email, success: false, error: 'onboardUser LRO timeout' };
  }

  const projectId = lroResponse.response?.cloudaicompanionProject?.id || '(unknown)';
  ok(`[${email}] Onboarding complete! Project: ${projectId} — Staging API is now ENABLED 🎉`);
  return { email, success: true, projectId, action: 'onboarded' };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  section('Antigravity Staging API Bootstrap');
  console.log('This script enables "Gemini for Google Cloud API (Staging)" for');
  console.log('each account by running the same loadCodeAssist → onboardUser');
  console.log('bootstrap sequence the proxy uses internally.\n');
  console.log(`Accounts to process: ${ACCOUNTS.length}`);

  const results = [];

  for (let i = 0; i < ACCOUNTS.length; i++) {
    const account = ACCOUNTS[i];
    section(`Account ${i + 1}/${ACCOUNTS.length}: ${account.email}`);
    const result = await bootstrapAccount(account);
    results.push(result);
    // Small gap between accounts to avoid rate limiting
    if (i < ACCOUNTS.length - 1) {
      await new Promise(r => setTimeout(r, 800));
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  section('Summary');

  const succeeded = results.filter(r => r.success);
  const failed    = results.filter(r => !r.success);

  console.log(`\n  Total:   ${results.length}`);
  console.log(`  ✅ OK:   ${succeeded.length}`);
  console.log(`  ❌ Fail: ${failed.length}\n`);

  if (succeeded.length > 0) {
    console.log('Successful accounts:');
    for (const r of succeeded) {
      const tag = r.action === 'already_enabled' ? '(was already enabled)' : '(newly bootstrapped)';
      console.log(`  ✅  ${r.email.padEnd(35)} project: ${r.projectId}  ${tag}`);
    }
  }

  if (failed.length > 0) {
    console.log('\nFailed accounts:');
    for (const r of failed) {
      console.log(`  ❌  ${r.email.padEnd(35)} error: ${r.error}`);
    }
    console.log('\nFor failed accounts: the refresh token may have expired or been revoked.');
    console.log('Re-authorize those accounts through the proxy UI and run this script again.');
  }

  if (failed.length === 0) {
    console.log('\n🎉  All accounts are now ready! Restart your proxy to pick up the changes.');
  }
}

main().catch(err => {
  console.error('\n💥  Unhandled error:', err.message);
  process.exit(1);
});
