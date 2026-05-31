---
last_mapped_commit: $(git rev-parse HEAD)
---
# Tech Stack (2026-05-31)

## Core Technologies
- **Runtime**: Node.js v20 (enforced via `.nvmrc` and `engines` locally).
- **Module System**: ESM (`"type": "module"` in `package.json`), with Babel for Jest testing.
- **Language**: JavaScript (ESM). No TypeScript is used in the runtime codebase.
- **Package Manager**: pnpm.

## Backend / Gateway Engine
- **HTTP/Networking**: Node.js native `http` module (`src/services/api-server.js`), combined with `axios` and `undici` for upstream API fetching.
- **Persistence**: `better-sqlite3` (synchronous SQLite) used for the Cockpit quota system (`src/utils/db.js`).
- **Proxy/Agenting**: `http-proxy-agent`, `https-proxy-agent`, and `socks-proxy-agent` for routing requests through corporate proxies if configured.

## Native Dependencies
- **Rust/Cargo**: There is a Rust-based fast tokenization implementation at `src/native/tokenizer-rs` built via `cargo` into a native `.node` extension (`libaiclient_tokenizer.dylib`).

## Development & Tooling
- **Testing**: `jest` (29.7.0) with `supertest` for API integration tests. `babel-jest` provides ESM-to-CommonJS translation for tests.
- **Formatting/Linting**: Custom linting script (`scripts/lint.cjs`).
- **Process Management**: Shell scripts (`scripts/safe-restart.sh`) with strict memory guards (`max-old-space-size=512`).
