const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('../config/proxy.config.json');
const { log, logCacheHit, logSimpleOp, extractPrompt, extractResponse } = require('../utils/logger');
const promptCache = require('../utils/cache');
const { detectSimpleOp, buildInterceptResponse } = require('../utils/simpleOps');

// Builds safe headers for replaying a cached response.
// Strips transfer-encoding (body is already fully buffered) and sets an
// explicit content-length so the client knows exactly when the body ends,
// preventing the client from hanging and retrying in a loop.
function replayHeaders(hit) {
  const h = { ...hit.headers };
  delete h['transfer-encoding'];
  delete h['connection'];
  h['content-length'] = hit.rawBuffer.length;
  return h;
}

function handleRequest(req, res) {
  const reqChunks = [];

  req.on('data', c => reqChunks.push(c));
  req.on('end', () => {
    const reqBuffer = Buffer.concat(reqChunks);

    const base = req.url.startsWith('http') ? req.url : `https://${req.headers.host}${req.url}`;
    let parsed;
    try { parsed = new URL(base); }
    catch { res.writeHead(400); res.end('Bad Request'); return; }

    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? config.defaultPorts.https : config.defaultPorts.http),
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: { ...req.headers, host: parsed.hostname },
      timeout: config.requestTimeout,
    };
    delete options.headers['proxy-connection'];

    const contentType = req.headers['content-type'];
    const reqData     = extractPrompt(reqBuffer);
    const method      = req.method;
    const url         = `${parsed.hostname}${parsed.pathname}`;

    // Simple-op interception: human-executable operations skip the LLM entirely
    const simpleOp = detectSimpleOp(reqBuffer, contentType);
    if (simpleOp) {
      logSimpleOp(method, url, reqData, simpleOp.opName, simpleOp.instruction, simpleOp.estimatedTokens);
      if (!res.headersSent) {
        const body = buildInterceptResponse(simpleOp.opName, simpleOp.instruction, simpleOp.estimatedTokens);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
        res.end(body);
      }
      return;
    }

    const cacheKey = promptCache.getCacheKey(reqBuffer, contentType);

    // Cache lookup: exact match first, then similarity-based fallback
    if (cacheKey) {
      const exactHit = promptCache.get(cacheKey);
      if (exactHit) {
        logCacheHit(method, url, reqData, exactHit.resData, null);
        if (!res.headersSent) {
          res.writeHead(exactHit.statusCode, replayHeaders(exactHit));
          res.end(exactHit.rawBuffer);
        }
        return;
      }

      const similarHit = promptCache.findSimilar(cacheKey);
      if (similarHit) {
        logCacheHit(method, url, reqData, similarHit.entry.resData, similarHit.score);
        if (!res.headersSent) {
          res.writeHead(similarHit.entry.statusCode, replayHeaders(similarHit.entry));
          res.end(similarHit.entry.rawBuffer);
        }
        return;
      }
    }

    const proxyReq = lib.request(options, (proxyRes) => {
      const resChunks = [];
      proxyRes.on('data', c => resChunks.push(c));
      proxyRes.on('end', () => {
        const resBuffer  = Buffer.concat(resChunks);
        const resData    = extractResponse(resBuffer, proxyRes.headers['content-type'], proxyRes.headers['content-encoding'], reqData?.model);
        log(method, url, proxyRes.statusCode, reqData, resData);
        // Store in cache for future identical prompts
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

    if (reqBuffer.length) proxyReq.write(reqBuffer);
    proxyReq.end();
  });
}

module.exports = { handleRequest };
