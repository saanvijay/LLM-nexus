# LLM-PAYG

Large Language Model Pay As You Go

## Project Structure

```
backend/
├── config/
│   └── proxy.config.json     # All proxy settings
├── proxy/
│   ├── server.js             # Entry point — server setup, CONNECT handler, listen
│   ├── handler.js            # Request / response forwarding logic
│   └── certManager.js        # CA + per-host TLS cert generation & cache
└── utils/
    ├── logger.js             # Log formatting, prompt/response extraction
    ├── cache.js              # In-memory prompt cache (exact + similarity matching)
    ├── tokenizer.js          # Real BPE token counting via tiktoken
    └── simpleOps.js          # Simple file-op detection and interception
```

## Local Proxy Server

A lightweight Node.js MITM (man-in-the-middle) proxy that intercepts HTTP and HTTPS traffic, logs prompts and completions with accurate token counts, caches responses to avoid redundant LLM calls, and intercepts trivial file operations that a human can perform manually.

### Setup

**1. Install dependencies**

```bash
cd backend && npm install
```

**2. Start the proxy**

```bash
node proxy/server.js
```

On first run, a self-signed CA certificate is generated and saved to `backend/certs/`. The startup output will print the exact command to trust it.

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

Also apply it immediately to the running session and all new GUI processes:

```bash
launchctl setenv NODE_EXTRA_CA_CERTS "/Users/vijay/LLM-PAYG/backend/certs/ca.crt"
```

**5. Export proxy env**

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

### Features

#### Token counting

Every intercepted request is tokenised with [tiktoken](https://github.com/openai/tiktoken) — the same BPE tokeniser used by OpenAI models. Token counts are computed locally from the actual prompt and response text, so they are accurate even when the upstream API omits the `usage` field.

The model is read from the request body (`json.model`) and the correct encoding is selected automatically:

| Model prefix | Encoding |
|---|---|
| `gpt-4o` | `o200k_base` |
| `gpt-4`, `gpt-3.5` | `cl100k_base` |
| `text-davinci` | `p50k_base` |
| Unknown | `cl100k_base` (fallback) |

#### Prompt cache

Identical and similar prompts are served from an in-memory cache, skipping the upstream LLM call entirely. The cache logs how many tokens would have been consumed.

**Exact match** — the full prompt text is used as a cache key. If the same prompt arrives again, the stored response is replayed instantly.

**Similarity match** — prompts are tokenised into word sets and compared with Jaccard similarity. Any prompt scoring ≥ 75% against a cached entry is treated as a hit. The threshold can be changed by editing `SIMILARITY_THRESHOLD` in [backend/utils/cache.js](backend/utils/cache.js).

#### Simple-op interception

Prompts that describe trivial file-system operations are intercepted before reaching the LLM. The proxy returns a plain-English instruction telling the user to perform the action manually, and logs how many tokens were saved.

Detected operations:

| Prompt contains | Operation |
|---|---|
| `create/add/make a file` | Create / Add File |
| `delete/remove a file` | Delete / Remove File |
| `move file/directory` | Move File / Directory |
| `rename file/directory` | Rename File / Directory |
| `copy file/directory` | Copy File / Directory |
| `add a comment` | Add Comment |

---

### Request pipeline

Each request passes through these stages in order:

```
1. Simple-op check   →  intercept immediately, return manual instruction, skip LLM
2. Exact cache hit   →  replay stored response, skip LLM
3. Similar cache hit →  replay best matching cached response, skip LLM
4. Upstream LLM call →  forward request, cache the response, return to client
```

---

### Log output

Every request produces at least one log line. Prompt and response details are appended when the body can be parsed.

**Normal LLM call**
```
[2026-04-01T10:00:00.000Z] POST api.openai.com/v1/chat/completions → 200
  PROMPT  [42 tokens] : [{"role":"user","content":"explain async/await"}]
  RESPONSE [output: 87 tokens] : Async/await is syntactic sugar over Promises...
```

**Exact cache hit**
```
[2026-04-01T10:00:01.000Z] POST api.openai.com/v1/chat/completions → CACHE HIT (exact)
  PROMPT  [42 tokens] : [{"role":"user","content":"explain async/await"}]
  CACHED RESPONSE [input: 42, output: 87, total: 129 tokens] : Async/await is...
```

**Similar cache hit**
```
[2026-04-01T10:00:02.000Z] POST api.openai.com/v1/chat/completions → CACHE HIT (similar 81.3%)
  PROMPT  [39 tokens] : [{"role":"user","content":"what is async/await?"}]
  CACHED RESPONSE [input: 42, output: 87, total: 129 tokens] : Async/await is...
```

**Simple-op interception**
```
[2026-04-01T10:00:03.000Z] POST api.openai.com/v1/chat/completions → SIMPLE OP INTERCEPTED — LLM call skipped
  PROMPT  [27 tokens] : [{"role":"user","content":"create a new file called config.yaml"}]
  OPERATION        : Create / Add File
  ESTIMATED TOKENS : 27 (saved by skipping LLM)
  DO MANUALLY      : Run in your terminal:  touch <filename>
```

---

### Troubleshooting

#### Certificate signature failure / regenerating certs

If you see `certificate signature failure`, the CA cert in the keychain no longer matches the key on disk. Regenerate from scratch:

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

# 5. Re-apply launchctl env vars and fully restart VS Code
launchctl setenv NODE_EXTRA_CA_CERTS "/Users/vijay/LLM-PAYG/backend/certs/ca.crt"
```

#### Error reference

| Error | Fetcher | Fix |
|---|---|---|
| `ERR_CERT_AUTHORITY_INVALID` | `electron-fetch` | macOS keychain trust (step 3) |
| `fetch failed` | `node-fetch` | `NODE_EXTRA_CA_CERTS` in `~/.zprofile` + `launchctl` (step 4) |
| `unable to verify first certificate` | `node-http` | `NODE_EXTRA_CA_CERTS` in `~/.zprofile` + `launchctl` (step 4) |
| `certificate signature failure` | `node-http` | Regenerate certs (see above) |

---

### Configuration

Edit [backend/config/proxy.config.json](backend/config/proxy.config.json) to change defaults:

| Key | Default | Env override |
|---|---|---|
| `port` | `3000` | `PORT` |
| `host` | `localhost` | `HOST` |
| `requestTimeout` | `30000` (ms) | `REQUEST_TIMEOUT` |
| `defaultPorts.http` | `80` | — |
| `defaultPorts.https` | `443` | — |
