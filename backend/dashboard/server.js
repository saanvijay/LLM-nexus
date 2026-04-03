const http = require('http');
const fs   = require('fs');
const path = require('path');
const store = require('./store');
const cache = require('../utils/cache');
const config = require('../config/config.json');

const PORT = process.env.DASHBOARD_PORT ?? 3001;
const FRONTEND = path.join(__dirname, '../../frontend/index.html');

const server = http.createServer((req, res) => {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');

  // GET /api/logs  — full history as JSON (supports ?type=&limit=&query=)
  if (req.url.startsWith('/api/logs')) {
    const u = new URL(req.url, 'http://localhost');
    let logs = store.all();
    const type  = u.searchParams.get('type');
    const query = u.searchParams.get('query');
    const limit = parseInt(u.searchParams.get('limit') ?? '200', 10);
    if (type)  logs = logs.filter(l => l.type === type);
    if (query) {
      const q = query.toLowerCase();
      logs = logs.filter(l => JSON.stringify(l).toLowerCase().includes(q));
    }
    logs = logs.slice(0, limit);
    const body = JSON.stringify(logs);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  // GET /api/stats  — aggregate statistics
  if (req.method === 'GET' && req.url === '/api/stats') {
    const logs = store.all();
    const llm       = logs.filter(l => l.type === 'llm');
    const cacheHits = logs.filter(l => l.type === 'cache_hit');
    const simpleOps = logs.filter(l => l.type === 'simple_op');
    const totalTokens = llm.reduce((s, l) => s + (l.totalTokens ?? 0), 0);
    const avgLatency  = llm.length
      ? Math.round(llm.reduce((s, l) => s + (l.duration ?? 0), 0) / llm.length)
      : 0;
    const body = JSON.stringify({
      totalCalls: logs.length,
      llmCalls: llm.length,
      cacheHits: cacheHits.length,
      simpleOps: simpleOps.length,
      totalTokens,
      avgLatencyMs: avgLatency,
      cacheSize: cache.size(),
    });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  // GET /api/cache  — cache entry count + keys preview
  if (req.method === 'GET' && req.url === '/api/cache') {
    const body = JSON.stringify({
      size: cache.size(),
      threshold: cache.SIMILARITY_THRESHOLD,
      keys: cache.keys().map(k => k.slice(0, 120)),   // truncated for readability
    });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  // DELETE /api/cache  — clear the prompt cache
  if (req.method === 'DELETE' && req.url === '/api/cache') {
    cache.clear();
    const body = JSON.stringify({ ok: true, message: 'Cache cleared' });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  // GET /api/config  — current proxy config
  if (req.method === 'GET' && req.url === '/api/config') {
    const body = JSON.stringify(config);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  // GET /api/stream — SSE live feed
  if (req.url === '/api/stream') {
    res.writeHead(200, {
      'content-type':  'text/event-stream',
      'cache-control': 'no-cache',
      'connection':    'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');
    const unsub = store.subscribe(res);
    req.on('close', unsub);
    return;
  }

  // GET / — serve the dashboard HTML
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(FRONTEND, (err, data) => {
      if (err) { res.writeHead(404); res.end('Frontend not found'); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Dashboard  →  http://localhost:${PORT}`);
});

module.exports = server;
