# Claude Syntax Interceptor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a stream interceptor that catches and corrects hallucinated tool-calling syntax (e.g., markdown JSON) from models on-the-fly, converting it to Anthropic's native `<invoke>` XML format.

**Architecture:** A lightweight Node.js stream transform class (`ClaudeSyntaxInterceptor`) that sits in the response pipeline. It monitors the Server-Sent Event (SSE) chunks, buffers them when a known bad trigger is detected, and rewrites the payload into strict XML before flushing to Claude Code.

**Tech Stack:** Node.js Streams, Mocha/Jest (or standard test runner for the project).

---

### Task 1: Interceptor Pass-Through Scaffold

**Files:**
- Create: `AIClient2API/src/utils/claude-syntax-interceptor.js`
- Create: `AIClient2API/tests/utils/claude-syntax-interceptor.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// AIClient2API/tests/utils/claude-syntax-interceptor.test.js
const assert = require('assert');
const { ClaudeSyntaxInterceptor } = require('../../src/utils/claude-syntax-interceptor');

describe('ClaudeSyntaxInterceptor', () => {
  it('should pass through normal text unmodified', () => {
    const interceptor = new ClaudeSyntaxInterceptor();
    const result = interceptor.processChunk('Hello world!');
    assert.strictEqual(result, 'Hello world!');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/utils/claude-syntax-interceptor.test.js`
Expected: FAIL with "Cannot find module" or "ClaudeSyntaxInterceptor is not a constructor"

- [ ] **Step 3: Write minimal implementation**

```javascript
// AIClient2API/src/utils/claude-syntax-interceptor.js
class ClaudeSyntaxInterceptor {
  constructor() {
    this.buffer = '';
    this.isBuffering = false;
  }

  processChunk(chunk) {
    return chunk;
  }
}

module.exports = { ClaudeSyntaxInterceptor };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test tests/utils/claude-syntax-interceptor.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add AIClient2API/src/utils/claude-syntax-interceptor.js AIClient2API/tests/utils/claude-syntax-interceptor.test.js
git commit -m "test(interceptor): add pass-through scaffold for ClaudeSyntaxInterceptor"
```

---

### Task 2: Detect Triggers and Buffer

**Files:**
- Modify: `AIClient2API/src/utils/claude-syntax-interceptor.js`
- Modify: `AIClient2API/tests/utils/claude-syntax-interceptor.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// Add to AIClient2API/tests/utils/claude-syntax-interceptor.test.js
  it('should buffer when a trigger token is detected and return empty string', () => {
    const interceptor = new ClaudeSyntaxInterceptor();
    const result1 = interceptor.processChunk('Sure, I will use a tool:\\n');
    const result2 = interceptor.processChunk('```json\\n{');
    
    assert.strictEqual(result1, 'Sure, I will use a tool:\\n');
    assert.strictEqual(result2, ''); // Buffered, so nothing emitted yet
    assert.strictEqual(interceptor.isBuffering, true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/utils/claude-syntax-interceptor.test.js`
Expected: FAIL with "Expected '' but got '```json\\n{'"

- [ ] **Step 3: Write minimal implementation**

```javascript
// Update AIClient2API/src/utils/claude-syntax-interceptor.js
class ClaudeSyntaxInterceptor {
  constructor() {
    this.buffer = '';
    this.isBuffering = false;
    this.triggers = ['```json'];
  }

  processChunk(chunk) {
    if (this.isBuffering) {
      this.buffer += chunk;
      return '';
    }

    // Check if the chunk contains a trigger
    const triggerFound = this.triggers.some(t => chunk.includes(t));
    if (triggerFound) {
      this.isBuffering = true;
      this.buffer += chunk;
      return '';
    }

    return chunk;
  }
}
module.exports = { ClaudeSyntaxInterceptor };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test tests/utils/claude-syntax-interceptor.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add AIClient2API/src/utils/claude-syntax-interceptor.js AIClient2API/tests/utils/claude-syntax-interceptor.test.js
git commit -m "feat(interceptor): detect trigger tokens and buffer stream"
```

---

### Task 3: Parse and Transform Block

**Files:**
- Modify: `AIClient2API/src/utils/claude-syntax-interceptor.js`
- Modify: `AIClient2API/tests/utils/claude-syntax-interceptor.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// Add to AIClient2API/tests/utils/claude-syntax-interceptor.test.js
  it('should transform buffered markdown JSON to Anthropic XML when block closes', () => {
    const interceptor = new ClaudeSyntaxInterceptor();
    interceptor.processChunk('```json\\n');
    interceptor.processChunk('{"tool": "ls", "args": {"dir": "."}}\\n');
    const result = interceptor.processChunk('```\\n');
    
    const expectedXml = '<invoke name="ls">\\n<parameter name="dir">.</parameter>\\n</invoke>\\n';
    assert.ok(result.includes('<invoke name="ls">'), 'Should contain invoke tag');
    assert.strictEqual(interceptor.isBuffering, false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/utils/claude-syntax-interceptor.test.js`
Expected: FAIL. Result is empty or unmodified, not XML.

- [ ] **Step 3: Write minimal implementation**

```javascript
// Update processChunk in AIClient2API/src/utils/claude-syntax-interceptor.js
  processChunk(chunk) {
    if (this.isBuffering) {
      this.buffer += chunk;
      // If the block ends
      if (this.buffer.endsWith('```\\n') || this.buffer.endsWith('```')) {
        const fullBlock = this.buffer;
        this.buffer = '';
        this.isBuffering = false;
        
        // Extract JSON
        const jsonMatch = fullBlock.match(/```json\\s*([\\s\\S]*?)\\s*```/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[1]);
            const toolName = parsed.tool || parsed.name;
            const args = parsed.args || parsed.parameters || {};
            
            let xml = `<invoke name="${toolName}">\\n`;
            for (const [key, val] of Object.entries(args)) {
              const strVal = typeof val === 'object' ? JSON.stringify(val) : val;
              xml += `<parameter name="${key}">${strVal}</parameter>\\n`;
            }
            xml += `</invoke>\\n`;
            return xml;
          } catch (e) {
            // Fallback if not valid JSON
            return fullBlock;
          }
        }
        return fullBlock;
      }
      return '';
    }

    const triggerFound = this.triggers.some(t => chunk.includes(t));
    if (triggerFound) {
      this.isBuffering = true;
      this.buffer += chunk;
      return '';
    }

    return chunk;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test tests/utils/claude-syntax-interceptor.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add AIClient2API/src/utils/claude-syntax-interceptor.js AIClient2API/tests/utils/claude-syntax-interceptor.test.js
git commit -m "feat(interceptor): parse JSON blocks and rewrite to XML"
```

---

### Task 4: Integrate Interceptor into Provider Pool

**Files:**
- Modify: `AIClient2API/src/providers/provider-pool-manager.js` (or `adapter.js` where streams are handled)

- [ ] **Step 1: Identify Integration Point**
*(Since we don't know the exact stream handling syntax inside `provider-pool-manager.js`, the first step for the executing agent will be to `view_file` the file and find the `response.on('data')` or `.pipe()` logic.)*

- [ ] **Step 2: Write failing test (or integration test)**
Add a test in `AIClient2API/tests/providers/provider-pool-manager.test.js` that mocks an SSE stream returning ` ```json ` and asserts that the manager outputs XML.

- [ ] **Step 3: Run test**
Run: `npm test tests/providers/provider-pool-manager.test.js`

- [ ] **Step 4: Minimal implementation**
Instantiate `ClaudeSyntaxInterceptor` inside the stream handler. For every incoming chunk, pipe it through `interceptor.processChunk()` before forwarding it to the `res.write()` or SSE handler.

- [ ] **Step 5: Run test**
Run: `npm test tests/providers/provider-pool-manager.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add AIClient2API/src/providers/provider-pool-manager.js
git commit -m "feat(stream): integrate ClaudeSyntaxInterceptor into provider pool"
```
