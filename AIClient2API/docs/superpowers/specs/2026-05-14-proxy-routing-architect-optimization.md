# Spec: Proxy Routing Architect Optimization (Absolute Master)

**Date:** 2026-05-14
**Status:** Draft
**Topic:** Optimizing the `proxy-routing-architect` subagent for peak performance, reliability, and Claude Code CLI compatibility.

## 1. Objective
Transform the `proxy-routing-architect` subagent into an "absolute master" of the AIClient2API proxy. It must be capable of handling complex routing, protocol conversion, and provider management while maintaining a stable connection for the Claude Code CLI.

## 2. Success Criteria
- **Zero Downtime Workflow**: The agent can restart the proxy without disconnecting the Claude Code session.
- **Protocol Perfection**: 100% successful translation of Tool Use and Streaming across all supported providers.
- **Antigravity Stability**: Elimination of "false positive" errors caused by OAuth warmup delays.
- **Model List Accuracy**: The proxy only exposes models that are actually available and functional on the backend.

## 3. Architecture & Components

### 3.1. Enhanced Agent Definition (`proxy-routing-architect.md`)
The subagent's system prompt will be updated with:
- **Operational Guardrails**: Explicit rules for port management and testing.
- **Domain Knowledge**: Deep insight into provider-specific quirks (Antigravity delay, GitHub model availability).
- **Verification Workflow**: Mandatory use of smoke tests before claiming success.

### 3.2. Verification Tooling
- **`scripts/safe-restart.sh`**: A utility to restart the proxy atomically.
- **`scripts/master-smoke-test.js`**: A Node.js script to verify:
    - Tool use translation (request and response).
    - Streaming consistency and chunking.
    - Warmup status for OAuth providers.
- **`configs/provider_ground_truth.json`**: A reference file defining the *actual* capabilities and model availability for every provider.

## 4. Implementation Details

### 4.1. Operational Rules (The "Master Rules")
1. **Connectivity**: Always use `kill $(lsof -t -i:3000) 2>/dev/null; npm start > /tmp/aiclient.log 2>&1 &` (or the safe-restart script) to ensure the port is reclaimed immediately.
2. **Testing**: Never rely on a single success message. Perform at least one "warmup" and one "verification" call for OAuth providers.
3. **Refactoring**: When updating converters, audit for `tool_calls` and `tool_outputs` preservation. Use `scripts/master-smoke-test.js` to verify.
4. **Cleanup**: Proactively remove deprecated models or inefficient routing paths.

### 4.2. Handling Antigravity
- Implement a "Warmup First" check in the agent's logic.
- If a request to Antigravity fails with a timeout on the first try, retry *once* before reporting failure.
- Ensure the `streamApi` logic in `antigravity-core.js` is optimized for high-latency initial responses.

### 4.3. GitHub & NVIDIA NIM Optimization
- Sync `src/providers/provider-models.js` with the specific list provided by the user:
    - **GitHub**: `GPT-5 mini`, `Claude Haiku 4.5`, `GPT-4.1`, `GPT-4o`.
- Remove all other non-functional entries to reduce routing overhead.

## 5. Security & Risk
- **Secrets Management**: The agent must continue to avoid adding `configs/provider_pools.json` to git.
- **Port Conflict**: Atomic restarts minimize risk, but if the port is busy, the agent must know how to identify and resolve the process.

## 6. Self-Review Checklist
- [ ] Does the plan avoid long downtime? (Yes, via atomic restarts)
- [ ] Is Antigravity specifically addressed? (Yes, via warmup logic and retries)
- [ ] Is Tool Use covered? (Yes, via converter auditing and smoke tests)
- [ ] Are the GitHub models correctly listed? (Yes, in section 4.3)
- [ ] Is the agent definition updated? (Yes, in section 3.1)
