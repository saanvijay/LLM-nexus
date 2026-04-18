# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Start the proxy:**
```bash
node backend/proxy/server.js
```
Starts proxy on port 3000 and dashboard on port 3001 simultaneously.

**Run tests (all standalone, no test runner):**
```bash
node backend/tests/test-cache.js
node backend/tests/test-redactor.js
node backend/tests/test-compressor.js
node backend/tests/test-proxy-chain.js   # makes live network request to httpbin.org
```

**Install dependencies:**
```bash
cd backend && npm install
```

## Architecture

The proxy is a MITM HTTPS proxy. Requests flow through this pipeline in `backend/proxy/handler.js`:

```
AI Client → [PII Redact] → [Compress] → [Simple-Op?] → [Cache?] → Upstream LLM
```

1. **CONNECT interception** (`proxy/server.js`) — intercepts HTTPS CONNECT, generates per-host TLS cert via `proxy/certManager.js`, wraps socket so the client believes it's talking to the real server.
2. **PII redaction** (`utils/redactor.js`) — regex rules loaded from `config/pii.config.json`; replaces values with `[RULENAME]` placeholders before anything is logged or forwarded.
3. **Prompt compression** (`utils/compressor.js`) — 16 sequential text transformation rules (whitespace, filler phrases, verbose connectives, deduplication). Each rule is `{ name, desc, enabled, fn }` applied in order.
4. **Simple-op interception** (`utils/simpleOps.js`) — detects file-system commands (create/delete/move/rename/copy/comment) and short-circuits with a fake LLM response, skipping the upstream call entirely.
5. **Cache lookup** (`utils/cache.js`) — tries exact key match first, then Jaccard similarity ≥ 0.75 across cached token sets. MAX_SIZE=500 with FIFO eviction.
6. **Upstream dispatch** — direct HTTPS, plain HTTP, or CONNECT tunnel through an upstream proxy if `config.upstreamProxy.enabled`.

**Dashboard** (`dashboard/server.js`) serves REST API + SSE feed on port 3001. All log entries are pushed to an in-memory circular buffer (`dashboard/store.js`, MAX=200) and broadcast to SSE subscribers in real time.

**MCP server** (`mcp/server.js`) exposes 4 read-only tools (`get_logs`, `get_stats`, `get_cache_info`, `search_logs`) over stdio for MCP-compatible AI agents (Claude Desktop, etc.).

## Key Files

| File | Purpose |
|------|---------|
| `backend/proxy/handler.js` | Full request/response pipeline |
| `backend/utils/compressor.js` | Prompt compression rules |
| `backend/utils/cache.js` | Similarity-based prompt cache |
| `backend/utils/redactor.js` | PII detection & replacement |
| `backend/utils/logger.js` | Prompt/response extraction + token counting |
| `backend/utils/tokenizer.js` | tiktoken BPE wrapper |
| `config/config.json` | Runtime config |
| `config/pii.config.json` | PII regex rules |

## Config (`config/config.json`)

Notable flags:
- `redactPII` — enable/disable PII redaction
- `compressPrompts` — enable/disable prompt compression
- `saveToken` — enable/disable simple-op interception
- `upstreamProxy.enabled` — route through a parent proxy (chain mode)
- `rejectUnauthorized` — set `false` to skip upstream TLS cert verification

## Conventions

- **CommonJS throughout** — `require()`/`module.exports` everywhere; no ES modules.
- **No test framework** — tests use a hand-rolled `assert(label, condition)` helper and exit non-zero on failure.
- **Token counting is real BPE** via tiktoken, not estimates. Model→encoding map is in `utils/tokenizer.js`.
- **Compression rules** are pure functions; adding a new rule means appending `{ name, desc, enabled, fn }` to the `RULES` array in `compressor.js`. Order matters — structural passes run before phrase substitution.
- **PII rules** live in `config/pii.config.json` and are compiled at startup. Set `enabled: false` to disable without deleting.
- The `npm start` script in `backend/package.json` points to a wrong path; use `node backend/proxy/server.js` directly.
