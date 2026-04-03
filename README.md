# LLM-PAYG

Large Language Model Pay As You Go — a lightweight MITM proxy that intercepts GitHub Copilot (and any OpenAI-compatible) traffic, logs prompts and completions with accurate token counts, caches responses to avoid redundant LLM calls, and exposes everything through a real-time observability dashboard and an MCP server for AI agent integration.

---

## Project Structure

```
backend/
├── config/
│   └── config.json     # All proxy settings
├── proxy/
│   ├── server.js             # Entry point — proxy + dashboard startup
│   ├── handler.js            # Request / response forwarding logic
│   └── certManager.js        # CA + per-host TLS cert generation & cache
├── dashboard/
│   ├── server.js             # HTTP server for dashboard UI + REST API (port 3001)
│   └── store.js              # In-memory log store with SSE broadcast
├── mcp/
│   └── server.js             # MCP stdio server — AI agent tool integration
└── utils/
    ├── logger.js             # Prompt/response extraction and log formatting
    ├── cache.js              # In-memory prompt cache (exact + similarity matching)
    ├── tokenizer.js          # Real BPE token counting via tiktoken
    └── simpleOps.js          # Simple file-op detection and interception

frontend/
└── index.html                # Observability dashboard (single-file, no build step)
```

---

## Setup

**1. Install dependencies**

```bash
cd backend && npm install
```

**2. Start the proxy**

```bash
node proxy/server.js
```

This starts two servers simultaneously:
- **Proxy** on `http://localhost:3000` — intercepts all LLM traffic
- **Dashboard** on `http://localhost:3001` — observability UI + REST API

On first run a self-signed CA certificate is generated and saved to `backend/certs/`. The startup output prints the exact command to trust it.

**3. Trust the CA cert (macOS, run once)**

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  backend/certs/ca.crt
```

**4. Tell Node.js about the CA cert**

Add to `~/.zprofile` (not `~/.zshrc` — GUI apps like VS Code don't read `~/.zshrc`):

```bash
export NODE_EXTRA_CA_CERTS="/Users/vijay/LLM-PAYG/backend/certs/ca.crt"
```

Apply immediately:

```bash
launchctl setenv NODE_EXTRA_CA_CERTS "/Users/vijay/LLM-PAYG/backend/certs/ca.crt"
```

**5. Export proxy env vars**

Add to `~/.zprofile`:

```bash
export HTTP_PROXY=http://localhost:3000
export HTTPS_PROXY=http://localhost:3000
```

Apply immediately:

```bash
launchctl setenv HTTP_PROXY "http://localhost:3000"
launchctl setenv HTTPS_PROXY "http://localhost:3000"
source ~/.zprofile
```

**6. VS Code setting** (catches anything Electron still rejects)

Add to VS Code `settings.json`:

```json
"http.proxyStrictSSL": false
```

**7. Restart VS Code** (Cmd+Q — not just close the window) so Copilot picks up all changes.

---

## Observability Dashboard

Open `http://localhost:3001` in any browser after starting the proxy.

### Stats bar

| Metric | Description |
|---|---|
| Total Calls | All intercepted requests |
| Total Tokens | Cumulative tokens across all LLM calls |
| Cache Hits | Exact + similarity hits served from cache |
| Avg Latency | Mean round-trip time for upstream LLM calls |

### Filter tabs

- **All** — every intercepted event
- **LLM Calls** — upstream completions with full prompt/response detail
- **Cache Hits** — requests served from cache, including similarity score
- **Simple Ops** — file operations intercepted before reaching the LLM

### Detail panel

Clicking any entry in the list opens a detail panel showing:
- Model name, HTTP status, latency
- Token breakdown cards — System / Input / Output / Total
- Full system prompt, user input, and LLM output with syntax-highlighted sections

### Live feed

The dashboard connects to the proxy via Server-Sent Events and updates in real time without polling or page refresh. The green dot in the header indicates an active SSE connection.

---

## REST API

The dashboard server exposes a REST API on port 3001 that any HTTP client or agent can call.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/logs` | All stored log entries (newest first) |
| `GET` | `/api/logs?type=llm` | Filter by type: `llm`, `cache_hit`, `simple_op` |
| `GET` | `/api/logs?query=async` | Full-text search across all log fields |
| `GET` | `/api/logs?limit=20` | Limit result count (max 200) |
| `GET` | `/api/stats` | Aggregate statistics (calls, tokens, cache hits, latency) |
| `GET` | `/api/cache` | Cache entry count, similarity threshold, key previews |
| `DELETE` | `/api/cache` | Clear the entire prompt cache |
| `GET` | `/api/config` | Current proxy configuration |
| `GET` | `/api/stream` | SSE live feed of new log entries |

Parameters can be combined: `/api/logs?type=llm&query=async&limit=10`

---

## MCP Server (AI Agent Integration)

The MCP (Model Context Protocol) server lets any MCP-compatible AI agent — Claude Desktop, custom agents, or agent frameworks — call this proxy's functions as tools.

### Start the MCP server

```bash
node backend/mcp/server.js
```

The MCP server communicates over **stdio** (standard MCP convention) and talks to the dashboard REST API on `localhost:3001`. The proxy must be running first.

### Available tools

| Tool | Description |
|---|---|
| `get_logs` | Retrieve proxy logs — filterable by `type`, `query`, `limit` |
| `get_stats` | Aggregate stats: calls, tokens, cache hits, avg latency |
| `get_cache_info` | Cache entry count, similarity threshold, key previews |
| `clear_cache` | Wipe the in-memory prompt cache |
| `get_proxy_config` | Current proxy configuration |
| `search_logs` | Full-text search across all log entries |

### Connect to Claude Desktop

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "llm-payg": {
      "command": "node",
      "args": ["/Users/vijay/LLM-PAYG/backend/mcp/server.js"]
    }
  }
}
```

Restart Claude Desktop. The tools will appear automatically under the llm-payg server.

### Connect to any MCP-compatible agent

Any agent that supports the Model Context Protocol can connect by launching the server as a subprocess and communicating via stdin/stdout. The server name is `llm-payg`, version `1.0.0`.

---

## Features

### Token counting

Every intercepted request is tokenised with [tiktoken](https://github.com/openai/tiktoken) — the same BPE tokeniser used by OpenAI models. Token counts are computed locally from the actual prompt and response text.

The model is read from the request body and the correct encoding is selected automatically:

| Model prefix | Encoding |
|---|---|
| `gpt-4o` | `o200k_base` |
| `gpt-4`, `gpt-3.5` | `cl100k_base` |
| `text-davinci` | `p50k_base` |
| Unknown | `cl100k_base` (fallback) |

### Prompt cache

Identical and similar prompts are served from an in-memory cache, skipping the upstream LLM call entirely.

**Exact match** — the full prompt text is the cache key. Same prompt → instant replay.

**Similarity match** — prompts are tokenised into word sets and compared with Jaccard similarity. Any prompt scoring ≥ 75% against a cached entry is a hit. The threshold is configurable via `SIMILARITY_THRESHOLD` in [backend/utils/cache.js](backend/utils/cache.js).

### Simple-op interception

Prompts describing trivial file-system operations are intercepted before reaching the LLM. Enabled only when `saveToken: true` is set in config (default: `false`).

| Prompt contains | Operation |
|---|---|
| `create/add/make a file` | Create / Add File |
| `delete/remove a file` | Delete / Remove File |
| `move file/directory` | Move File / Directory |
| `rename file/directory` | Rename File / Directory |
| `copy file/directory` | Copy File / Directory |
| `add a comment` | Add Comment |

### Log levels

Set `logLevel` in `config.json` or via the `LOG_LEVEL` environment variable.

| Level | Behaviour |
|---|---|
| `INFO` (default) | Only LLM calls — prompts, responses, cache hits, simple ops |
| `DEBUG` | Everything including raw HTTP traffic, telemetry, REST requests |

---

## Request pipeline

```
1. Simple-op check   →  intercept immediately, return manual instruction (if saveToken: true)
2. Exact cache hit   →  replay stored response, skip LLM
3. Similar cache hit →  replay best matching cached response, skip LLM
4. Upstream LLM call →  forward request, cache response, push to dashboard store
```

---

## Configuration

Edit [backend/config/config.json](backend/config/config.json):

| Key | Default | Env override | Description |
|---|---|---|---|
| `port` | `3000` | `PORT` | Proxy listen port |
| `host` | `localhost` | `HOST` | Proxy bind address |
| `requestTimeout` | `30000` | `REQUEST_TIMEOUT` | Upstream timeout (ms) |
| `logLevel` | `"INFO"` | `LOG_LEVEL` | `INFO` or `DEBUG` |
| `saveToken` | `false` | — | Enable simple-op interception |
| `defaultPorts.http` | `80` | — | Default HTTP port |
| `defaultPorts.https` | `443` | — | Default HTTPS port |

Dashboard port can be changed via the `DASHBOARD_PORT` environment variable (default `3001`).

---

## Troubleshooting

### Certificate signature failure

If you see `certificate signature failure`, the CA cert in the keychain no longer matches the key on disk:

```bash
# 1. Remove old certs
rm backend/certs/ca.crt backend/certs/ca.key

# 2. Remove old trusted cert from keychain
sudo security delete-certificate -c "LLM-PAYG Proxy CA" /Library/Keychains/System.keychain

# 3. Restart the server — new CA is generated automatically
node proxy/server.js

# 4. Trust the new CA
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  backend/certs/ca.crt

# 5. Re-apply env vars and fully restart VS Code
launchctl setenv NODE_EXTRA_CA_CERTS "/Users/vijay/LLM-PAYG/backend/certs/ca.crt"
```

### Error reference

| Error | Fetcher | Fix |
|---|---|---|
| `ERR_CERT_AUTHORITY_INVALID` | `electron-fetch` | macOS keychain trust (step 3) |
| `fetch failed` | `node-fetch` | `NODE_EXTRA_CA_CERTS` in `~/.zprofile` + `launchctl` (step 4) |
| `unable to verify first certificate` | `node-http` | `NODE_EXTRA_CA_CERTS` in `~/.zprofile` + `launchctl` (step 4) |
| `certificate signature failure` | `node-http` | Regenerate certs (see above) |
