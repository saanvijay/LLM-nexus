const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('../config/proxy.config.json');
const { log, extractPrompt, extractResponse } = require('../utils/logger');

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

    const reqData = extractPrompt(reqBuffer, req.headers['content-type']);

    const proxyReq = lib.request(options, (proxyRes) => {
      const resChunks = [];
      proxyRes.on('data', c => resChunks.push(c));
      proxyRes.on('end', () => {
        const resBuffer = Buffer.concat(resChunks);
        log(reqData, extractResponse(resBuffer, proxyRes.headers['content-type'], proxyRes.headers['content-encoding']));
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
