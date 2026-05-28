# MCP Sync Fix — Claude Code + Gemini/Antigravity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 4 broken MCP entries in `~/.claude.json`, remove the duplicate `vercel` conflict, and rewrite the sync script so it never copies Antigravity-native remote configs into Claude Code again.

**Architecture:** The Single Source of Truth is `~/.gemini/config/mcp_config.json`. Gemini/Antigravity variants are symlinked to it (already working). Claude Code gets a filtered one-way push from the SSoT — entries that use ravity's `serverUrl`/`authProviderType`/`oauth` schema are skipped because Claude Code cannot parse them. The sync script is rewritten with an explicit allowlist/denylist so the filter is transparent and maintainable.

**Tech Stack:** Node.js (v20, already installed), macOS launchd (plist already exists), `~/.claude.json` (Claude Code user config), `~/.gemini/config/mcp_config.json` (SSoT)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `~/.gemini/sync-ai-resources.js` | Modify | Add Claude-incompatible entry filter to `syncClaudeCode()` |
| `~/.claude.json` | Modify | Remove 4 broken entries + duplicate `vercel` |
| `~/.gemini/config/mcp_config.json` | Read-only | SSoT — not modified by this plan |

---

### Task 1: Remove broken entries from `~/.claude.json`

The 4 entries below use Antigravity's `serverUrl`/`authProviderType` schema — Claude Code requires `command` (stdio) or `url` (HTTP). They will never work and produce warnings on every startup. The duplicate `vercel` in user scope also conflicts with the project-scope entry that has the correct Bearer token.

**Files:**
- Modify: `~/.claude.json` (the `mcpServers` object)

- [ ] **Step 1: Back up the current config**

```bash
cp ~/.claude.json ~/.claude.json.bak-$(date +%Y%m%d-%H%M%S)
```

Expected: silent success, backup file created.

- [ ] **Step 2: Remove the 5 bad entries with a Node.js one-liner**

```bash
node -e '
const fs = require("fs");
const f = process.env.HOME + "/.claude.json";
const d = JSON.parse(fs.readFileSync(f, "utf8"));

// These 4 use Antigravity serverUrl/authProviderType schema — incompatible with Claude Code
const REMOVE = [
  "datacloud_knowledge_catalog_remote",
  "datacloud_dataproc_remote",
  "datacloud_bigquery_remote",
  "google-drive",
  // duplicate vercel — project scope has the correct Bearer token version
  "vercel"
];

REMOVE.forEach(k => {
  if (d.mcpServers[k]) {
    console.log("Removing:", k);
    delete d.mcpServers[k];
  }
});

fs.writeFileSync(f, JSON.stringify(d, null, 2), "utf8");
console.log("Done. Remaining MCP count:", Object.keys(d.mcpServers).length);
'
```

Expected output:
```
Removing: datacloud_knowledge_catalog_remote
Removing: datacloud_dataproc_remote
Removing: datacloud_bigquery_remote
Removing: google-drive
Removing: vercel
Done. Remaining MCP count: 28
```

- [ ] **Step 3: Verify no broken entries remain**

```bash
node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.env.HOME + "/.claude.json", "utf8"pServers).filter((and && !v.url);
if (broken.length === 0) {
  console.log("PASS: No broken entries.");
} else {
  console.log("FAIL — still broken:", broken.map(([k]) => k).join(", "));
}
'
```

Expected: `PASS: No broken entries.`

---

### Task 2: Rewrite `syncClaudeCode()` in the sync script to filter incompatible entries

The current script does a blind two-way merge — it copies every key from the SSoT into `~/.claude.json` including Antigravity-native remote configs. The fix adds a `isClaudeCompatible()` guard that skips any entry missing both `command` and `url`.

**Files:**
- Modify: `~/.gemini/sync-ai-resources.js`

- [ ] **Step 1: Back up the current sync script**

```bash
cp ~/.gemini/sync-ai-resources.js ~/.gemini/sync-ai-resources.js.bak-$(date +%Y%m%d-%H%M%S)
```

Expected: silent success.

- [ ] **Step 2: Replace `syncClaudeCode()` with the filtered version**

Open `~/.gemini/sync-ai-resources.js` and replace the entire `syncClaudeCode` function (from `function syncClaudeCode()` through its closing `}`) with:

```javascript
// Claude Code requires either `command` (stdio) or `url` (HTTP).
// Antigravity-native remote entries use `serverUrl`/`authProviderType`/`oauth` —
// that schema is incompatible and causes "command: expected string" warnings.
function isClaudeCompatible(entry) {
  return typeof entry.command === 'string' || typeof entry.url === 'string';
}

function syncClaudeCode() {
  console.log('\n--- Phase 3: Syncing Claude Code (filtered) ---');
  const ssotData = readJsonSafe(SSoT_MCP_FILE);
  if (!ssotData || !ssotData.mcpServers) {
    console.log('[SKIP] No MCP servers in SSoT to sync.');
    return;
  }

  const claudeData = readJsonSafe(CLAUDE_CONFIG_FILE) || {};
  if (!claudeData.mcpServers) claudeData.mcpServers = {};

  let claudeChanged = false;

  // One-way push: SSoT -> Claude Code (filtered)
  // We do NOT push Claude-only entries back into the SSoT — Claude Code has
  // project-scoped MCPs (in .mcp.json) that don't belong in the global SSoT.
  for (const [key, value] of Object.entries(ssotData.mcpServers)) {
    if (!isClaudeCompatible(value)) {
      console.log(`[SKIP] Incompatible schema (no command/url): ${key}`);
      continue;
    }
    if (JSON.stringify(claudeData.mcpServers[key]) !== JSON.stringify(value)) {
      claudeData.mcpServers[key] = value;
      claudeChanged = true;
      console.log(`[SYNC] SSoT -> Claude: ${key}`);
    }
  }

  if (claudeChanged) {
    try {
      fs.copyFileSync(CLAUDE_CONFIG_FILE, `${CLAUDE_CONFIG_FILE}.backup.${Date.now()}`);
    } catch (e) {}
    console.log(`[WRITE] Updating Claude config: ${CLAUDE_CONFIG_FILE}`);
    writeJsonSafe(CLAUDE_CONFIG_FILE, claudeData);
  } else {
    console.log('[OK] Claude config is already in sync.');
  }
}
```

- [ ] **Step 3: Verify the script parses without errors**

```bash
node --check ~/.gemini/sync-ai-resources.js && echo "PASS: syntax OK"
```

Expected: `PASS: syntax OK`

- [ ] **Step 4: Do a dry-run of the sync script**

```bash
node ~/.gemini/sync-ai-resources.js 2>&1
```

Expected output should contain lines like:
```
--- Phase 1 & 2: SSoT and Symlinks ---
[OK] Symlink exists: ...antigravity-ide/mcp_config.json
[OK] Symlink exists: ...antigravity-cli/mcp_config.json
...
--- Phase 3: Syncing Claude Code (filtered) ---
[SKIP] Incompatible schema (no command/url): datacloud_knowledge_catalog_remote
[SKIP] Incompatible schema (no command/url): datacloud_dataproc_remote
[SKIP] Incompatible schema (no command/url): datacloud_bigquery_remote
[SKIP] Incompatible schema (no command/url): google-drive
[OK] Claude config is already in sync.
✅ Synchronization complete.
```

The 4 incompatible entries must appear as `[SKIP]` lines. If any appear as `[SYNC]`, the filter is not working — stop and debug.

- [ ] **Step 5: Verify no broken entries were re-introduced into `~/.claude.json`**

```bash
node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.env.HOME + "/.claude.json", "utf8"));
const broken = Object.entries(d.mcpServers).filter(([k,v]) => !v.command && !v.url);
if (broken.length === 0) {
  console.log("PASS: No broken entries.");
} else {
  console.log("FAIL — broken entries found:", broken.map(([k]) => k).join(", "));
  process.exit(1);
}
'
```

Expected: `PASS: No broken entries.`

---

### Task 3: Restart the launchd daemon with the fixed script

The daemon is already loaded and watching `~/.gemini/config/mcp_config.json`. It needs a reload to pick up the rewritten `syncClaudeCode()`.

**Files:**
- No file changes — launchd plist at `~/Library/LaunchAgents/com.antigravity.sync.plist` is unchanged.

- [ ] **Step 1: Reload the daemon**

```bash
launchctl unload ~/Library/LaunchAgents/com.antigravity.sync.plist
launchctl load -w ~/Library/LaunchAgents/com.antigravity.sync.plist
```

Expected: silent success (no error output).

- [ ] **Step 2: Confirm it loaded**

```bash
launchctl list | grep com.antigravity.sync
```

Expected: a line with `com.antigravity.sync` and a PID (first column is not `-`).

- [ ] **Step 3: Check the sync log for errors**

```bash
tail -20 ~/.gemini/sync.log && echo "---ERR---" && tail -5 ~/.gemini/sync_err.log
```

Expected: log ends with `✅ Synchronization complete.` and the err log is empty or shows only old entries.

---

### Task 4: End-to-end verification — add a test MCP to SSoT and confirm it propagates correctly

This confirms the full pipeline works: SSoT → Claude Code (compatible entries only), and incompatible entries stay filtered.

**Files:**
- Temporary edit to `~/.gemini/config/mcp_config.json` (reverted at end of task)

- [ ] **Step 1: Inject a compatible test entry into the SSoT**

```bash
node -e '
const fs = require("fs");
const f = process.env.HOME + "/.gemini/config/mcp_config.json";
const d = JSON.parse(fs.readFileSync(f, "utf8"));
d.mcpServers["__test-sync-mcp__"] = { command: "echo", args: ["sync-test"] };
fs.writeFileSync(f, JSON.stringify(d, null, 2));
console.log("Injected test entry.");
'
```

- [ ] **Step 2: Wait 2 seconds for the daemon to fire, then verify it appeared in Claude Code**

```bash
sleep 2 && node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.env.HOME + "/.claude.json", "utf8"));
if (d.mcpServers["__test-sync-mcp__"]) {
  console.log("PASS: test entry propagated to Claude Code.");
} else {
  console.log("FAIL: test entry not found in ~/.claude.json");
  process.exit(1);
}
'
```

Expected: `PASS: test entry propagated to Claude Code.`

- [ ] **Step 3: Inject an incompatible test entry into the SSoT**

```bash
node -e '
const fs = require("fs");
const f = process.env.HOME + "/.gemini/config/mcp_config.json";
const d = JSON.parse(fs.readFileSync(f, "utf8"));
d.mcpServers["__test-remote-mcp__"] = {
  serverUrl: "https://example.googleapis.com/mcp",
  authProviderType: "google_credentials",
  oauth: { scopes: ["https://www.googleapis.com/auth/cloud-platform"] }
};
fs.writeFileSync(f, JSON.stringify(d, null, 2));
console.log("Injected incompatible test entry.");
'
```

- [ ] **Step 4: Wait 2 seconds and verify it did NOT appear in Claude Code**

```bash
sleep 2 && node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.env.HOME + "/.claude.json", "utf8"));
if (!d.mcpServers["__test-remote-mcp__"]) {
  console.log("PASS: incompatible entry correctly bloc.");
} else {
  console.log("FAIL: incompatible entry leaked into ~/.claude.json — filter not working.");
  process.exit(1);
}
'
```

Expected: `PASS: incompatible entry correctly blocked from Claude Code.`

- [ ] **Step 5: Clean up both test entries from SSoT and Claude Code**

```bash
node -e '
const fs = require("fs");
const ssot = process.env.HOME + "/.gemini/config/mcp_config.json";
const claude = process.env.HOME + "/.claude.json";
[ssot, claude].forEach(f => {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  delete d.mcpServers["__test-sync-mcp__"];
  delete d.mcpServers["__test-remote-mcp__"];
  fs.writeFileSync(f, JSON.stringify(d, null, 2));
});
console.log("Cleanup complete.");
'
```

Expected: `Cleanup complete.`

- [ ] **Step 6: Final broken-entry check**

```bash
node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.env.HOME + "/.claude.json",utf8"));
const broken = Object.entries(d.mcpServers).filter(([k,v]) => !v.command && !v.url);
console.log("Broken entries:", broken.length === 0 ? "NONE ✅" : broken.map(([k]) => k).join(", "));
console.log("Total MCP count:", Object.keys(d.mcpServers).length);
'
```

Expected:
```
Broken entries: NONE ✅
Total MCP count: 28
```

---

## How to add a new MCP server going forward

**For a server that works in all three CLIs (stdio/HTTP):**
Add it to `~/.gemini/config/mcp_config.json` only. The daemon propagates it to Antigravity (via symlinks) and Claude Code (via filtered sync) automatically within ~1 second.

**For a Claude Code-only server (e.g. project-scoped in `.mcp.json`):**
Add it directly to the project's `.mcp.json`. Do not add it to the SSoT — the sync script no longer pushes Claude-only entries back into the SSoT.

**For an Antigravity-only remote server (serverUrl/authProviderType):**
Add it to `~/.gemini/config/mcp_config.json`. It will appear in Antigravity/Gemini via symlinks and be silently skipped when syncing to Claude Code.
