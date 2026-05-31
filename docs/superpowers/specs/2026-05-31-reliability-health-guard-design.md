# Spec A: Reliability & Self-Healing — HealthGuard

## Overview

This spec introduces a `HealthGuard` module that adds three proactive reliability
capabilities to AIClient2API: permanent-failure detection for dead credentials,
a background health pulse, and SQLite startup validation. All three are additive
— no existing interfaces change, and the hot request path is unaffected.

**Problem being solved:** A revoked key (e.g. OpenRouter 401) can remain in the
pool for hours, wasting 11 retry attempts per affected request. Health degradation
is only detected reactively when a real user request fails. SQLite cooldown rows
can carry corrupted timestamps across restarts, silently marking healthy accounts
as unhealthy.

---

## Architecture

```
src/utils/health-guard.js                  ← new (single-responsibility module)
src/utils/db.js                            ← extend: startup validation query
src/providers/provider-pool-manager.js     ← extend: HealthGuard.recordFailure() on 401
src/core/master.js                         ← extend: HealthGuard.init() at boot
configs/config.json                        ← extend: healthGuard config block
tests/utils/health-guard.test.js           ← new
```

---

## Components

### 1. Permanent Failure Detector

Tracks consecutive auth-failure count per account UUID in a `Map<accountId, {count, firstSeen}>`.

**Detection logic (consecutive, not windowed):**
- Any successful request resets `count` to zero for that account
- If `count` reaches `maxConsecutive401s` (default: 3) *without* a success in between, trigger auto-disable
- `permanentFailureWindowMs` is a safety guard only: if `count >= 1` but `firstSeen` is older than the window, reset the counter (the failures are too spread out to indicate a dead key — more likely transient). This prevents a single stale failure from being miscounted.

Example: failures at t=0, t=30s, t=60s → 3 consecutive → auto-disable ✅
Example: failure at t=0, success at t=30s, failure at t=60s → counter resets → no disable ✅
Example: failure at t=0, (no activity for 11min), failure at t=11min → window expired → counter resets → no disable ✅

Calls the pool manager's existing `disableAccount()` and persists `isDisabled: true` to SQLite.

**Why not just extend the cooldown?** A 429 means "come back later." A 401 means
"your key is invalid." They require different responses. Today the system treats
both as cooldowns — HealthGuard differentiates them.

### 2. Background Health Pulse

`setInterval` at `pulseIntervalMs` (default: 300,000ms / 5 min). Calls the existing
per-provider health check logic already in `provider-pool-manager.js` — no new HTTP
client code. Errors are caught per-provider; a failing pulse for one provider never
blocks the others or the request path.

Log output after each pulse (one line):
```
[HealthGuard] Pulse 31/32 healthy — openai-custom: DISABLED (auto, 401×3)
```

The pulse interval must be kept above the Cockpit session keep-alive poll (< 10 min)
to avoid conflicting with quota refresh. 5 min is safe.

### 3. SQLite Startup Validator

Runs once in `HealthGuard.init()` before `poolManager.loadFromSQLite()`. Scans
`pool_state` rows for corruption:

| Condition | Action |
|---|---|
| Cooldown timestamp > now + 24h | Wipe row (impossible future) |
| Cooldown timestamp is NaN or null | Wipe row |
| `isHealthy: false` with cooldown already expired | Reset to healthy |
| `isDisabled: true` set > 7 days ago | Log WARN (may need manual review) |

Logs each repaired row at WARN level: `[HealthGuard] SQLite repair: removed stale
cooldown for accountId=<uuid>, was cooldown until <timestamp>`.

---

## Data Flow

```
BOOT
  master.js
    → HealthGuard.init(poolManager, db, config)
        → db.validateAndRepairPoolState()    // remove corrupted rows
        → poolManager.loadFromSQLite()       // loads clean state
        → HealthGuard.startPulse()           // background setInterval

REQUEST PATH (modification to existing error handler only)
  provider-pool-manager.js catches 401
    → HealthGuard.recordFailure(accountId, 'auth_401')
    → if count >= threshold within window:
        poolManager.disableAccount(accountId)
        db.persistAccountState(accountId, {isDisabled: true})
        logger.warn('[HealthGuard] Auto-disabled: permanent 401 × N')

PULSE (background, every 5 min)
  HealthGuard.pulse()
    → iterates each enabled provider
    → calls existing health check logic per provider
    → updates pool.health[provider]
    → logs one-line summary
```

---

## Error Handling

- **Pulse failure**: `try/catch` per provider. Log and continue. Never throws to main process.
- **Auto-disable is reversible**: The existing `/provider_health` reset endpoint clears
  `isDisabled`, re-enables the account, and resets the consecutive-failure counter.
- **Startup repair failure**: Log WARN, proceed. Blocking startup on SQLite repair would
  be worse than running with slightly dirty state.
- **Init called before pool load**: Always. Order enforced in `master.js`.

---

## Config Block (`configs/config.json`)

```json
"healthGuard": {
  "pulseIntervalMs": 300000,
  "maxConsecutive401s": 3,
  "permanentFailureWindowMs": 600000,
  "enabled": true
}
```

Setting `"enabled": false` disables all three behaviors (pulse, auto-disable, startup
validator) with a single flag — useful for debugging suspected false positives.

---

## Testing

| Test | Type | What it verifies |
|---|---|---|
| Consecutive 401 counter increments correctly | Unit | Counter logic |
| Auto-disable fires at threshold, not before | Unit | Threshold boundary |
| Counter resets to zero on success | Unit | False-positive guard |
| Auto-disable resets after manual pool reset | Unit | Reversibility |
| SQLite validator detects each corruption type | Unit | 4 corruption cases |
| SQLite repair deletes and logs bad rows | Unit | Repair + observability |
| Pulse completes without throwing on provider error | Unit | Fault isolation |
| Integration: 3× 401 errors → account isDisabled | Integration | Full path |
| Integration: 0 regressions on existing 110 tests | Integration | Non-interference |

---

## Dependency Graph

```
health-guard.js
  ← provider-pool-manager.js  (calls recordFailure)
  ← db.js                     (reads/writes pool_state)
  ← logger.js                 (logging only)
  ← config-manager.js         (reads healthGuard config)
  ← master.js                 (calls init() at boot)
```

No circular dependencies. `health-guard.js` imports from `db.js` and `logger.js`
only — both are leaf utilities with no upward dependencies.

---

## Prior Work Relationship

The [Claude Syntax Interceptor design](./2026-05-31-claude-syntax-interceptor-design.md)
proposed stream-layer interception for hallucinated tool syntax. That approach is
**deprioritized** — the architecture assumption (models send `<invoke>` XML over the
wire) does not hold in this JSON-level proxy. Fixes to tool-use syntax belong in the
converter strategies. HealthGuard does not interact with the converter layer.
