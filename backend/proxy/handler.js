const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');
const config = require('../../config/config.json');
const { log, logCacheHit, logSimpleOp, extractPrompt, extractResponse, isDebug } = require('../utils/logger');
const promptCache = require('../utils/cache');
const { detectSimpleOp, buildInterceptResponse } = require('../utils/simpleOps');
const { redactBuffer } = require('../utils/redactor');

// ── Upstream proxy helpers ────────────────────────────────────────────────────

function getUpstream() {
  const u = config.upstreamProxy;
  return (u && u.enabled && u.host && u.port) ? u : null;
}

function upstreamProxyAuth(upstream) {
  if (!upstream.auth) return {};
  return { 'proxy-authorization': `Basic ${Buffer.from(upstream.auth).toString('base64')}` };
}

// Opens a CONNECT tunnel through the upstream proxy to targetHost:targetPort.
// Calls back with (err, rawSocket).
function openTunnel(upstream, targetHost, targetPort, cb) {
  const connectReq = http.request({
    hostname: upstream.host,
    port: upstream.port,
    method: 'CONNECT',
    path: `${targetHost}:${targetPort}`,
    headers: { host: `${targetHost}:${targetPort}`, ...upstreamProxyAuth(upstream) },
    timeout: config.requestTimeout,
  });
  connectReq.on('connect', (_res, socket) => cb(null, socket));
  connectReq.on('error', cb);
  connectReq.end();
}

// Agent used for all direct outgoing HTTPS requests.
// rejectUnauthorized is read from config so it can be toggled without code changes.
const outboundAgent = new https.Agent({ rejectUnauthorized: config.rejectUnauthorized ?? false });

function replayHeaders(hit) {
  const h = { ...hit.headers };
  delete h['transfer-encoding'];
  delete h['connection'];
  h['content-length'] = hit.rawBuffer.length;
  return h;
}

function handleRequest(req, res) {
  const startTime = Date.now();
  const reqChunks = [];

  req.on('data', c => reqChunks.push(c));
  req.on('end', () => {
    const reqBuffer = Buffer.concat(reqChunks);

    const base = req.url.startsWith('http') ? req.url : `https://${req.headers.host}${req.url}`;
    let parsed;
    try { parsed = new URL(base); }
    catch { res.writeHead(400); res.end('Bad Request'); return; }

    const isHttps  = parsed.protocol === 'https:';
    const upstream = getUpstream();
    const targetPort = parseInt(parsed.port) || (isHttps ? config.defaultPorts.https : config.defaultPorts.http);
    const reqHeaders = { ...req.headers, host: parsed.hostname };
    delete reqHeaders['proxy-connection'];

    const contentType = req.headers['content-type'];

    // PII guardrail — redact before logging, caching, or forwarding upstream
    const { buffer: safeBuffer, redactions } = config.redactPII
      ? redactBuffer(reqBuffer, contentType)
      : { buffer: reqBuffer, redactions: [] };

    if (redactions.length) {
      const summary = redactions.map(r => `${r.type}×${r.count}${r.role ? `(${r.role})` : ''}`).join(', ');
      console.log(`[REDACT] PII removed from request: ${summary}`);
    }

    const reqData = extractPrompt(safeBuffer);
    const method  = req.method;
    const url     = `${parsed.hostname}${parsed.pathname}`;

    // Simple-op interception: only active when saveToken is enabled in config
    const simpleOp = config.saveToken && detectSimpleOp(safeBuffer, contentType);
    if (simpleOp) {
      const duration = Date.now() - startTime;
      logSimpleOp(method, url, reqData, simpleOp.opName, simpleOp.instruction, simpleOp.estimatedTokens, duration);
      if (!res.headersSent) {
        const body = buildInterceptResponse(simpleOp.opName, simpleOp.instruction, simpleOp.estimatedTokens);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
        res.end(body);
      }
      return;
    }

    const cacheKey = promptCache.getCacheKey(safeBuffer, contentType);

    // Cache lookup: exact match first, then similarity-based fallback
    if (cacheKey) {
      const exactHit = promptCache.get(cacheKey);
      if (exactHit) {
        logCacheHit(method, url, reqData, exactHit.resData, null, Date.now() - startTime);
        if (!res.headersSent) {
          res.writeHead(exactHit.statusCode, replayHeaders(exactHit));
          res.end(exactHit.rawBuffer);
        }
        return;
      }

      const similarHit = promptCache.findSimilar(cacheKey);
      if (similarHit) {
        logCacheHit(method, url, reqData, similarHit.entry.resData, similarHit.score, Date.now() - startTime);
        if (!res.headersSent) {
          res.writeHead(similarHit.entry.statusCode, replayHeaders(similarHit.entry));
          res.end(similarHit.entry.rawBuffer);
        }
        return;
      }
    }

    function dispatchRequest(socket) {
      const options = {
        hostname: upstream ? upstream.host       : parsed.hostname,
        port:     upstream ? upstream.port       : targetPort,
        path:     upstream && !socket ? `${parsed.protocol}//${parsed.hostname}:${targetPort}${parsed.pathname}${parsed.search}` : parsed.pathname + parsed.search,
        method:   req.method,
        headers:  { ...reqHeaders, ...(upstream && !socket ? upstreamProxyAuth(upstream) : {}) },
        timeout:  config.requestTimeout,
      };

      let lib;
      if (socket) {
        // HTTPS through CONNECT tunnel — inject the pre-built TLS socket directly
        lib = https;
        options.agent = false;
        options.createConnection = () => socket;
      } else if (isHttps) {
        // Direct HTTPS — use the module-level agent (honours rejectUnauthorized)
        lib = https;
        options.agent = outboundAgent;
      } else {
        lib = http;
      }

      const proxyReq = lib.request(options, (proxyRes) => {
        const resChunks = [];
        proxyRes.on('data', c => resChunks.push(c));
        proxyRes.on('end', () => {
          const duration  = Date.now() - startTime;
          const resBuffer = Buffer.concat(resChunks);
          const resData   = extractResponse(resBuffer, proxyRes.headers['content-type'], proxyRes.headers['content-encoding'], reqData?.model);
          if (!resData && reqData && isDebug) {
            console.log(`[DEBUG] content-type: ${proxyRes.headers['content-type']}`);
            console.log(`[DEBUG] response body (first 500 chars):\n${resBuffer.toString('utf8').slice(0, 500)}`);
          }
          log(method, url, proxyRes.statusCode, reqData, resData, duration);
          if (cacheKey) {
            promptCache.set(cacheKey, resBuffer, proxyRes.statusCode, proxyRes.headers, resData);
          }
          if (!res.headersSent) {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            res.end(resBuffer);
          }
        });
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) { res.writeHead(504); res.end('Gateway Timeout'); }
      });

      proxyReq.on('error', (_err) => {
        if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); }
      });

      if (safeBuffer.length) proxyReq.write(safeBuffer);
      proxyReq.end();
    }

    if (upstream && isHttps) {
      // Chain via CONNECT tunnel, then TLS-wrap the socket
      openTunnel(upstream, parsed.hostname, targetPort, (err, socket) => {
        if (err) {
          if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); }
          return;
        }
        const tlsSocket = tls.connect({ socket, servername: parsed.hostname, rejectUnauthorized: false });
        dispatchRequest(tlsSocket);
      });
    } else {
      // Direct or plain HTTP through upstream proxy (no tunnel needed)
      dispatchRequest(null);
    }
  });
}

module.exports = { handleRequest };
