const http = require('http');
const fs   = require('fs');
const path = require('path');
const store = require('./store');

const PORT = process.env.DASHBOARD_PORT ?? 3001;
const FRONTEND = path.join(__dirname, '../../frontend/index.html');

const server = http.createServer((req, res) => {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');

  // GET /api/logs  — full history as JSON
  if (req.url === '/api/logs') {
    const body = JSON.stringify(store.all());
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
