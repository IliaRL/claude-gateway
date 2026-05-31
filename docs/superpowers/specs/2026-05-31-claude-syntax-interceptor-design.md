# Claude Syntax Interceptor Design

## Overview
To ensure all models behave normally within the Claude Code environment, the `AIClient2API` gateway will enforce strict output syntax compatibility. Because different models (e.g., Qwen, Gemini, DeepSeek) occasionally hallucinate tool-calling formats (using markdown JSON or incorrect XML tags) instead of Anthropic's native format, the gateway must intercept and correct these errors on the fly.

## Architecture & Data Flow
- **Placement:** A new stream transformation layer called `ClaudeSyntaxInterceptor` will sit between the provider adapter (e.g., `qwen-core.js`) and the final HTTP response stream sent to Claude Code.
- **Responsibility:** It will inspect incoming Server-Sent Event (SSE) text chunks in real-time. If it detects non-compliant tool syntax, it will intercept those chunks, rewrite them into Anthropic's exact `<invoke name="tool_name">...</invoke>` format, and push the corrected stream to the client.
- **Isolation:** This keeps the core routing logic (`provider-pool-manager`) clean and allows individual provider adapters to remain simple, offloading syntax correction to this dedicated middleware.

## Stream Buffering & Parsing Strategy
Because the gateway streams responses in real-time, the interceptor must handle partial chunks without breaking the user experience.

1. **State Machine:** The `ClaudeSyntaxInterceptor` will utilize a lightweight state machine that monitors the stream for known "bad" trigger tokens (e.g., ` ```json`, `<tool>`, `<action>`).
2. **Buffering:** When a trigger sequence is detected, the interceptor temporarily pauses forwarding and starts buffering the incoming chunks.
3. **Transformation:** Once the full hallucinated block is captured, the interceptor parses the payload, rewrites it into a valid Anthropic `<invoke>` XML block, and flushes it to Claude Code as a continuous stream.
4. **Bypass/Fallback:** If a trigger is detected but the subsequent content proves to be normal text (e.g., the model is legitimately writing a markdown block explaining JSON), the buffer is flushed unmodified to prevent data loss.

## Testing Strategy (Test-Driven Development)
As explicitly requested, the implementation will be heavily driven by TDD.
- We will write extensive unit tests for the `ClaudeSyntaxInterceptor` state machine before integrating it.
- Tests will simulate various streaming chunk patterns, including broken chunks, perfectly formatted responses, and hallucinated JSON tool calls, verifying that the output stream perfectly matches Anthropic specifications.

## Next Steps
This design will serve as the foundation for the `/writing-plans` phase, where a concrete, step-by-step implementation plan will be created.
