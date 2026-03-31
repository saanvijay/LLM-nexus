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
    └── logger.js             # Log formatting and body summarisation
```

## Local Proxy Server

A lightweight Node.js MITM (man-in-the-middle) proxy that intercepts HTTP and HTTPS traffic, logs request/response content (including prompts and completions), and is designed to route VS Code GitHub Copilot requests for observability.

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

### Log Output

```
[2026-03-30T10:00:01.123Z]
  PROMPT: [{"role":"user","content":"complete this function..."}]
  RESPONSE (total tokens: 312): [{"text":"function foo() { return 42; }","index":0}]
```
