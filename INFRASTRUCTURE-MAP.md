# AIClient2API Shared Infrastructure Map

## Overview
This document maps the shared infrastructure layers that ALL providers depend on in AIClient2API. Focus: retry logic, HTTP client setup, error handling, and auth middleware.

**Status**: Read-only reconnaissance complete. Plan mode.

---

## 1. Entry Point & Initialization

### Master.js
- **Path**: `/Users/ilialiston/MASTER-C/AIClient2API/src/core/master.js`
- **Size**: ~12.8 KB
- **Role**: Master process entry point, initializes worker processes

---

## 2. Request Handler

### request-handler.js
- **Path**: `/Users/ilialiston/MASTER-C/AIClient2API/src/handlers/request-handler.js`
- **Size**: ~22.2 KB
- **Role**: Main HTTP request dispatcher and entry point for all requests

---

## 3. Provider Pool Manager (Core Retry & Fallback Logic)

### provider-pool-manager.js
- **Path**: `/Users/ilialiston/MASTER-C/AIClient2API/src/providers/provider-pool-manager.js`
- **Size**: ~36-37 KB
- **Role**: Central orchestrator for provider selection, retry logic, health checks, and fallback

### Retry Configuration
- `REQUEST_MAX_RETRIES`: 3 (default, configurable via CLI flag `--request-max-retries`)
- `CREDENTIAL_SWITCH_MAX_RETRIES`: 5 (for bad credential switching during auth errors)
- `RETRY.MAX_RETRIES`: 100 (upper limit for config validation)
- `NETWORK.DEFAULT_TIMEOUT`: 120000 ms (120 seconds)

---

## 4. Error Handling

### error-handling.js
- **Path**: `/Users/ilialiston/MASTER-C/AIClient2API/src/utils/error-handling.js`
- **Size**: ~17.7 KB
- **Role**: Protocol-aware error formatting and handling

### Network Utils

### network-utils.js
- **Path**: `/Users/ilialiston/MASTER-C/AIClient2API/src/utils/network-utils.js`
- **Size**: ~10.9 KB
- **Role**: Shared HTTP client configuration, network error classification

### Shared HTTP Agents Configuration
```javascript
sharedHttpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 120000
});

sharedHttpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 120000
});
```

### Retryable Network Errors
ECONNRESET, ETIMEDOUT, ECONNREFUSED, ENOTFOUND, ENETUNREACH, EHOSTUNREACH, EPIPE, EAI_AGAIN, ECONNABORT

---

## 5. Service Adapter Pattern

### adapter.js
- **Path**: `/Users/ilialiston/MASTER-C/AIClient2API/src/providers/adapter.js`
- **Size**: ~26-27 KB
- **Role**: Abstract adapter pattern for unified provider interface

### Base Interface
- `generateContent(model, requestBody)`
- `generateContentStream(model, requestBody)`
- `listModels()`
- `refreshToken()`
- `forceRefreshToken()`
- `isExpiryDateNear()`

---

## 6. Configuration

### config-manager.js
- **Path**: `/Users/ilialiston/MASTER-C/AIClient2API/src/core/config-manager.js`
- **Size**: ~17.2 KB
- **Role**: Configuration loading, validation, CLI flag parsing

### constants.js
- **Path**: `/Users/ilialiston/MASTER-C/AIClient2API/src/utils/constants.js`
- **Size**: ~2.6 KB
- **Role**: Centralized constant definitions

---

## 7. HTTP Clients

### Shared Agent Providers
openai-core.js, claude-core.js, grok-core.js, forward-core.js, openai-responses-core.js, codex-core.js, qwen-core.js, iflow-core.js

### Custom Agent Providers
gemini-core.js, antigravity-core.js, claude-kiro.js

---

## 8. Error Propagation Flow

Provider Core → axios error → Pool Manager classification → cooldown/retry → next provider → error-handling.js → protocol-compliant response

---

## Key Files Summary

| Component | Path | Size |
|-----------|------|------|
| Master | src/core/master.js | 12.8 KB |
| Request Handler | src/handlers/request-handler.js | 22.2 KB |
| Pool Manager | src/providers/provider-pool-manager.js | 36+ KB |
| Error Handling | src/utils/error-handling.js | 17.7 KB |
| Network Utils | src/utils/network-utils.js | 10.9 KB |
| Adapter | src/providers/adapter.js | 26+ KB |
| Config Manager | src/core/config-manager.js | 17.2 KB |
| Constants | src/utils/constants.js | 2.6 KB |

---

**Status**: Reconnaissance complete.
