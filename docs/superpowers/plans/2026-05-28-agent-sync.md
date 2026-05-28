# Agent Sync — Claude Code ↔ Antigravity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert all Claude Code agents (`.md` format in `~/.claude/agents/`) into Antigravity-compatible `agent.json` files in the SSoT (`~/.gemini/config/agents/`), and extend the sync daemon to keep both sides in sync automatically going forward.

**Architecture:** The SSoT for agents is `~/.gemini/config/agents/` — already symlinked to `antigravity-cli/agents` and `antigravity-ide/agents`. Claude Code reads `.md` files from `~/.claude/agents/`. These two formats are incompatible (YAML frontmatter vs JSON), so we maintain both: Antigravity agents live as `agent.json` in the SSoT, Claude Code agents live as `.md` files. The sync script is extended with a `syncAgents()` function that converts Claude Code `.md` agents into `agent.json` entries in the SSoT on every run. New agents added to `~/.claude/agents/` automatically appear in Antigravity within ~1 second via the launchd watcher.

**Tech Stack:** Node.js (v20), `~/.gemini/sync-ai-resources.js` (existing sync daemon), launchd plist at `~/Library/LaunchAgents/com.antigravity.sync.plist`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `~/.gemini/sync-ai-resources.js` | Modify | Add `syncAgents()` function + call it in the main try block |
| `~/.gemini/config/agents/` | Populate | SSoT for Antigravity agents — `agent.json` per subdirectory |
| `~/Library/LaunchAgents/com.antigravity.sync.plist` | Modify | Add `~/.claude/agents/` to `WatchPaths` so daemon fires on new Claude agents |

## Agent Conversion Reference

Claude Code `.md` frontmatter → Antigravity `agent.json` field mapping:

| Claude Code field | Antigravity field | Notes |
|---|---|---|
| `name` | directory name | Used as the folder name under `config/agents/` |
| `description` | `customAgent.description` | Direct copy |
| Body text (after frontmatter) | `customAgent.systemInstruction.parts[0].text` | Strip leading/trailing whitespace |
| `tools` (ignored) | `customAgent.tools` / `toolNames` / `tool_names` | Always use the full default tool set (see below) |
| `model` (ignored) | not in Antigravity schema | Antigravity doesn't support per-agent model selection |

**Default Antigravity tool set** (used for all converted agents):
```json
["read_file", "write_file", "replace_file_content", "multi_replace_file_content",
 "grep_search", "list_dir", "run_command", "search_web", "call_mcp_tool"]
```

**Default Antigravity MCP set** (used for all converted agents):
```json
["brave-search", "context7", "fetch", "filesystem", "git", "github-mcp-server", "memory"]
```

---

### Task 1: Convert the 4 project-specific Claude Code agents to `agent.json` in the SSoT

These 4 agents exist in `~/.claude/agents/` but have no `agent.json` in `~/.gemini/config/agents/`. They are the ones you authored for this project. The GSD agents (34 of them) are framework-internal and don't need to be in Antigravity.

**Files:**
- Create: `~/.gemini/config/agents/proxy-debugger/agent.json` (already exists — verify and update)
- Create: `~/.gemini/config/agents/security-reviewer/agent.json`
- Create: `~/.gemini/config/agents/severity-triage/agent.json`
- Create: `~/.gemini/config/agents/tier-config-auditor/agent.json`

- [ ] **Step 1: Verify proxy-debugger already exists and matches**

```bash
cat ~/.gemini/config/agents/proxy-debugger/agent.json | python3 -c "
import json, sys
d = json.load(sys.stdin)
text = d['customAgent']['systemInstruction']['parts'][0]['text']
print('systemInstruction preview:', text[:80])
"
```

Expected: prints the first 80 chars of the proxy-debugger system instruction. If it matches the Claude Code `.md` body, this agent is already synced — skip to Step 3.

- [ ] **Step 2: Write security-reviewer/agent.json**

```bash
mkdir -p ~/.gemini/config/agents/security-reviewer
cat > ~/.gemini/config/agents/security-reviewer/agent.json << 'EOF'
{
  "customAgent": {
    "displayName": "Security Reviewer",
    "description": "Use at the end of Phase 1 and Phase 3 to audit credential handling code, env var injection patterns, and any file that reads from Credentials/. Returns structured findings: confirmed issues, risks, and clean items.",
    "systemInstruction": {
      "parts": [
        {
          "text": "You are a security code reviewer specialising in credential handling and environment variable security. You review code for: hardcoded credentials, insecure env var injection that could leak into child processes or logs, files that read credentials and log or expose them, API keys present in config values that should be read from env at runtime, and shell scripts that export sensitive variables globally instead of scoping them per-execution. You report only confirmed issues with file and line references. No speculative findings."
        }
      ]
    },
    "tools": ["read_file", "write_file", "replace_file_content", "multi_replace_file_content", "grep_search", "list_dir", "run_command", "search_web", "call_mcp_tool"],
    "toolNames": ["read_file", "write_file", "replace_file_content", "multi_replace_file_content", "grep_search", "list_dir", "run_command", "search_web", "call_mcp_tool"],
    "tool_names": ["read_file", "write_file", "replace_file_content", "multi_replace_file_content", "grep_search", "list_dir", "run_command", "search_web", "call_mcp_tool"],
    "mcpServers": ["brave-search", "context7", "fetch", "filesystem", "git", "github-mcp-server", "memory"],
    "mcp_servers": ["brave-search", "context7", "fetch", "filesystem", "git", "github-mcp-server", "memory"]
  }
}
EOF
echo "Written: security-reviewer/agent.json"
```

Expected: `Written: security-reviewer/agent.json`

- [ ] **Step 3: Write severity-triage/agent.json**

```bash
mkdir -p ~/.gemini/config/agents/severity-triage
cat > ~/.gemini/config/agents/severity-triage/agent.json << 'EOF'
{
  "customAgent": {
    "displayName": "Severity Triage",
    "description": "Automated severity triage agent for issues and vulnerabilities",
    "systemInstruction": {
      "parts": [
        {
          "text": "You are a severity triage agent that automatically classifies incoming issues, bug reports, and vulnerability findings using the S1-S4 severity framework.\n\nCapabilities:\n- Analyze issue descriptions and context to determine severity\n- Cross-reference against known vulnerability databases and patterns\n- Provide consistent, justified severity classifications\n- Recommend escalation paths based on severity level\n\nTriage Workflow:\n1. Intake — Read the issue or finding in full\n2. Context Gathering — Search the codebase for related files and recent changes\n3. Impact Assessment — Determine blast radius and affected components\n4. Severity Assignment — Classify using S1-S4 framework\n5. Action Routing — Recommend next steps based on severity\n\nSeverity Decision Matrix:\n- S1: Data loss risk HIGH, all users impacted, active exploit, no workaround, revenue/trust impact\n- S2: Data loss risk MEDIUM, many users impacted, exploitable, impractical workaround, major feature impact\n- S3: Data loss risk LOW, some users impacted, theoretical exposure, workaround available, minor feature impact\n- S4: No data loss risk, few users impacted, informational, trivial workaround, cosmetic impact\n\nOutput: Provide a structured triage report with severity level, rationale, recommended actions, and escalation guidance."
        }
      ]
    },
    "tools": ["read_file", "write_file", "replace_file_content", "multi_replace_file_content", "grep_search", "list_dir", "run_command", "search_web", "call_mcp_tool"],
    "toolNames": ["read_file", "write_file", "replace_file_content", "multi_replace_file_content", "grep_search", "list_dir", "run_command", "search_web", "call_mcp_tool"],
    "tool_names": ["read_file", "write_file", "replace_file_content", "multi_replace_file_content", "grep_search", "list_dir", "run_command", "search_web", "call_mcp_tool"],
    "mcpServers": ["brave-search", "context7", "fetch", "filesystem", "git", "github-mcp-server", "memory"],
    "mcp_servers": ["brave-search", "context7", "fetch", "filesystem", "git", "github-mcp-server", "memory"]
  }
}
EOF
echo "Written: severity-triage/agent.json"
```

Expected: `Written: severity-triage/agent.json`

- [ ] **Step 4: Write tier-config-auditor/agent.json**

```bash
mkdir -p ~/.gemini/config/agents/tier-config-auditor
cat > ~/.gemini/config/agents/tier-config-auditor/agent.json << 'EOF'
{
  "customAgent": {
    "displayName": "Tier Config Auditor",
    "description": "Use when verifying that AIClient2API provider configs, LiteLLM model lists, and Credentials are consistent with each other — no missing keys, no model ID mismatches, no orphaned providers.",
    "systemInstruction": {
      "parts": [
        {
          "text": "You are a configuration consistency auditor for a 3-tier AI gateway. You read Tier1-AIClient2API provider configs, Tier2-LiteLLM litellm_config.yaml, and the Credentials directory. You verify: every credential has a matching provider config, every provider config references valid model IDs from src/providers/provider-models.js, and LiteLLM's model list is reachable via Tier 1. You output a structured report: what's consistent, what's missing, what's mismatched. Read-only. No modifications."
        }
      ]
    },
    "tools": ["read_file", "write_file", "replace_file_content", "multi_replace_file_content", "grep_search", "list_dir", "run_command", "search_web", "call_mcp_tool"],
    "toolNames": ["read_file", "write_file", "replace_file_content", "multi_replace_file_content", "grep_search", "list_dir", "run_command", "search_web", "call_mcp_tool"],
    "tool_names": ["read_file", "write_file", "replace_file_content", "multi_replace_file_content", "grep_search", "list_dir", "run_command", "search_web", "call_mcp_tool"],
    "mcpServers": ["brave-search", "context7", "fetch", "filesystem", "git", "github-mcp-server", "memory"],
    "mcp_servers": ["brave-search", "context7", "fetch", "filesystem", "git", "github-mcp-server", "memory"]
  }
}
EOF
echo "Written: tier-config-auditor/agent.json"
```

Expected: `Written: tier-config-auditor/agent.json`

- [ ] **Step 5: Verify all 4 agent.json files are valid JSON**

```bash
for name in proxy-debugger security-reviewer severity-triage tier-config-auditor; do
  f="$HOME/.gemini/config/agents/$name/agent.json"
  python3 -c "import json; json.load(open('$f')); print('PASS: $name')" 2>&1
done
```

Expected:
```
PASS: proxy-debugger
PASS: security-reviewer
PASS: severity-triage
PASS: tier-config-auditor
```

- [ ] **Step 6: Verify Antigravity can see the agents by listing the SSoT**

```bash
ls ~/.gemini/config/agents/ | grep -v '\.md$'
```

Expected output includes all of: `claude-code-guide`, `code-simplifier`, `explore`, `general-purpose`, `plan`, `proxy-debugger`, `security-reviewer`, `severity-triage`, `statusline-setup`, `tier-config-auditor`

---

### Task 2: Add `syncAgents()` to the sync daemon

This function reads every `.md` file from `~/.claude/agents/`, parses the YAML frontmatter, and writes a corresponding `agent.json` into `~/.gemini/config/agents/<name>/`. It only writes if the content has changed (idempotent). It skips GSD framework agents (those starting with `gsd-`) since they are Claude Code-internal and not useful in Antigravity.

**Files:**
- Modify: `~/.gemini/sync-ai-resources.js` — add `syncAgents()` function and call it in the main try block
- Modify: `~/Library/LaunchAgents/com.antigravity.sync.plist` — add `~/.claude/agents/` to `WatchPaths`

- [ ] **Step 1: Back up the sync script**

```bash
cp ~/.gemini/sync-ai-resources.js ~/.gemini/sync-ai-resources.js.bak-$(date +%Y%m%d-%H%M%S)
echo "Backed up."
```

Expected: `Backed up.`

- [ ] **Step 2: Add the `syncAgents()` function to `~/.gemini/sync-ai-resources.js`**

Open `~/.gemini/sync-ai-resources.js` and insert the following block immediately before the final `try {` block at the bottom of the file:

```javascript
const CLAUDE_AGENTS_DIR = path.join(HOME, '.claude', 'agents');
const ANTIGRAVITY_AGENTS_DIR = path.join(CONFIG_DIR, 'agents');

// Agents prefixed with 'gsd-' are Claude Code framework internals — skip them.
// They are spawned programmatically by GSD skills and have no value as
// interactive Antigravity agents.
const SKIP_AGENT_PREFIXES = ['gsd-'];

function parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return { meta: {}, body: content.trim() };
    const meta = {};
    match[1].split('\n').forEach(line => {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) return;
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        meta[key] = value;
    });
    return { meta, body: match[2].trim() };
}

function buildAgentJson(name, meta, body) {
    const displayName = name
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    const tools = [
        'read_file', 'write_file', 'replace_file_content',
        'multi_replace_file_content', 'grep_search', 'list_dir',
        'run_command', 'search_web', 'call_mcp_tool'
    ];
    const mcpServers = [
        'brave-search', 'context7', 'fetch', 'filesystem',
        'git', 'github-mcp-server', 'memory'
    ];
    return {
        customAgent: {
            displayName,
            description: meta.description || '',
            systemInstruction: { parts: [{ text: body }] },
            tools,
            toolNames: tools,
            tool_names: tools,
            mcpServers,
            mcp_servers: mcpServers
        }
    };
}

function syncAgents() {
    console.log('\n--- Phase 4: Syncing Agents (Claude Code -> Antigravity) ---');

    if (!fs.existsSync(CLAUDE_AGENTS_DIR)) {
        console.log('[SKIP] ~/.claude/agents/ not found.');
        return;
    }

    ensureDirSync(ANTIGRAVITY_AGENTS_DIR);

    const files = fs.readdirSync(CLAUDE_AGENTS_DIR).filter(f => f.endsWith('.md'));

    for (const file of files) {
        const name = file.replace(/\.md$/, '');

        if (SKIP_AGENT_PREFIXES.some(prefix => name.startsWith(prefix))) {
            continue;
        }

        const mdPath = path.join(CLAUDE_AGENTS_DIR, file);
        const agentDir = path.join(ANTIGRAVITY_AGENTS_DIR, name);
        const jsonPath = path.join(agentDir, 'agent.json');

        const content = fs.readFileSync(mdPath, 'utf8');
        const { meta, body } = parseFrontmatter(content);
        const agentJson = buildAgentJson(name, meta, body);
        const newContent = JSON.stringify(agentJson, null, 2);

        const existing = fs.existsSync(jsonPath)
            ? fs.readFileSync(jsonPath, 'utf8')
            : null;

        if (existing === newContent) {
            continue;
        }

        ensureDirSync(agentDir);
        fs.writeFileSync(jsonPath, newContent, 'utf8');
        console.log(`[SYNC] Claude -> Antigravity agent: ${name}`);
    }

    console.log('[OK] Agent sync complete.');
}
```

- [ ] **Step 3: Call `syncAgents()` in the main try block**

Find the existing `try {` block at the bottom of `~/.gemini/sync-ai-resources.js`:

```javascript
try {
    setupSymlinksAndMerge();
    syncClaudeCode();
    compileSkillsForClaude();
    console.log('\n✅ Synchronization complete.');
} catch (e) {
    console.error('Fatal error during sync:', e);
}
```

Replace it with:

```javascript
try {
    setupSymlinksAndMerge();
    syncClaudeCode();
    compileSkillsForClaude();
    syncAgents();
    console.log('\n✅ Synchronization complete.');
} catch (e) {
    console.error('Fatal error during sync:', e);
}
```

- [ ] **Step 4: Syntax-check the modified script**

```bash
node --check ~/.gemini/sync-ai-resources.js && echo "PASS: syntax OK"
```

Expected: `PASS: syntax OK`

- [ ] **Step 5: Run the sync script and verify agent sync output**

```bash
node ~/.gemini/sync-ai-resources.js 2>&1
```

Expected output includes a `Phase 4` section. On first run it will show `[SYNC]` lines for any agents not yet converted. On subsequent runs it will show `[OK] Agent sync complete.` with no `[SYNC]` lines (idempotent).

Example first-run output:
```
--- Phase 4: Syncing Agents (Claude Code -> Antigravity) ---
[SYNC] Claude -> Antigravity agent: code-simplifier
[SYNC] Claude -> Antigravity agent: proxy-debugger
[SYNC] Claude -> Antigravity agent: security-reviewer
[SYNC] Claude -> Antigravity agent: severity-triage
[SYNC] Claude -> Antigravity agent: tier-config-auditor
[OK] Agent sync complete.
```

- [ ] **Step 6: Add `~/.claude/agents/` to the launchd WatchPaths**

Open `~/Library/LaunchAgents/com.antigravity.sync.plist` and find the `<key>WatchPaths</key>` array. It currently contains:

```xml
<array>
    <string>/Users/ilialiston/.gemini/config/mcp_config.json</string>
    <string>/Users/ilialiston/.gemini/config/skills</string>
    <string>/Users/ilialiston/.claude.json</string>
</array>
```

Replace it with:

```xml
<array>
    <string>/Users/ilialiston/.gemini/config/mcp_config.json</string>
    <string>/Users/ilialiston/.gemini/config/skills</string>
    <string>/Users/ilialiston/.claude.json</string>
    <string>/Users/ilialiston/.claude/agents</string>
</array>
```

- [ ] **Step 7: Reload the daemon**

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.antigravity.sync.plist 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.antigravity.sync.plist
sleep 1 && launchctl list | grep com.antigravity.sync
```

Expected: a line with `com.antigravity.sync` (PID column may be `-` since it's event-driven, not persistent — that's normal).

---

### Task 3: End-to-end verification

- [ ] **Step 1: Verify all expected agents exist in the SSoT**

```bash
for name in proxy-debugger security-reviewer severity-triage tier-config-auditor code-simplifier; do
  f="$HOME/.gemini/config/agents/$name/agent.json"
  if [ -f "$f" ]; then
    display=$(python3 -c "import json; print(json.load(open('$f'))['customAgent']['displayName'])")
    echo "PASS: $name -> $display"
  else
    echo "FAIL: $name — agent.json missing"
  fi
done
```

Expected:
```
PASS: proxy-debugger -> Proxy Debugger
PASS: security-reviewer -> Security Reviewer
PASS: severity-triage -> Severity Triage
PASS: tier-config-auditor -> Tier Config Auditor
PASS: code-simplifier -> Code Simplifier
```

- [ ] **Step 2: Verify symlinks still resolve correctly**

```bash
ls ~/.gemini/antigravity-cli/agents/ | grep -E "proxy-debugger|security-reviewer|severity-triage|tier-config-auditor"
```

Expected: all 4 names appear (they resolve through the symlink to the SSoT).

- [ ] **Step 3: Live test — add a new Claude Code agent and verify it auto-appears in Antigravity**

```bash
cat > ~/.claude/agents/__test-agent.md << 'EOF'
---
name: __test-agent
description: Temporary test agent for sync verification
tools: Read
model: sonnet
---
You are a test agent. Say hello.
EOF
sleep 3
ls ~/.gemini/config/agents/__test-agent/agent.json 2>/dev/null && echo "PASS: auto-synced" || echo "FAIL: not synced"
```

Expected: `PASS: auto-synced`

- [ ] **Step 4: Clean up the test agent**

```bash
rm ~/.claude/agents/__test-agent.md
rm -rf ~/.gemini/config/agents/__test-agent/
echo "Cleanup done."
```

Expected: `Cleanup done.`

- [ ] **Step 5: Check sync log for errors**

```bash
tail -30 ~/.gemini/sync.log && echo "---ERR---" && cat ~/.gemini/sync_err.log 2>/dev/null | tail -5 || echo "(no errors)"
```

Expected: log ends with `✅ Synchronization complete.` and no error output.

---

## How to add a new agent going forward

**To add an agent that appears in both Claude Code and Antigravity:**
Create a `.md` file in `~/.claude/agents/<name>.md` with the standard Claude Code frontmatter. The daemon converts it to `agent.json` in the SSoT within ~1 second, and Antigravity picks it up via the existing symlinks.

**To add an Antigravity-only agent:**
Create `~/.gemini/config/agents/<name>/agent.json` directly. It will appear in Antigravity but not in Claude Code.

**GSD agents (`gsd-*`) are intentionally excluded** from Antigravity — they are spawned programmatically by GSD skills and are not useful as interactive agents.
