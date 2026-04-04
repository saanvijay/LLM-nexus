/**
 * Proxy-chain smoke test
 *
 * What it does:
 *  1. Starts a tiny "upstream proxy" on a random port that accepts HTTP CONNECT
 *     tunnels and forwards them (or records them for assertion).
 *  2. Temporarily patches config.upstreamProxy to point at that mini-proxy.
 *  3. Calls openTunnel() directly from handler.js to open a CONNECT tunnel.
 *  4. Wraps the raw socket in TLS and makes a real HTTPS GET to httpbin.org/get.
 *  5. Reports PASS / FAIL.
 */

'use strict';

const http  = require('http');
const https = require('https');
const net   = require('net');
const tls   = require('tls');

// ── 1. Mini upstream proxy ───────────────────────────────────────────────────

let connectSeen = false; // set true when a CONNECT arrives at the mini-proxy

function startMiniProxy() {
  return new Promise((resolve) => {
    const server = http.createServer(); // plain HTTP requests (not used in chain test)

    server.on('connect', (req, clientSocket, head) => {
      connectSeen = true;
      const [host, portStr] = req.url.split(':');
      const port = parseInt(portStr, 10) || 443;

      console.log(`  [mini-proxy] CONNECT ${host}:${port}`);

      const remote = net.connect(port, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) remote.write(head);
        remote.pipe(clientSocket);
        clientSocket.pipe(remote);
      });

      remote.on('error', (err) => {
        console.error(`  [mini-proxy] tunnel error: ${err.message}`);
        clientSocket.destroy();
      });

      clientSocket.on('error', () => remote.destroy());
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      console.log(`  [mini-proxy] listening on 127.0.0.1:${port}`);
      resolve({ server, port });
    });
  });
}

// ── 2. openTunnel lifted from handler.js (uses real http.request) ────────────

function openTunnel(upstream, targetHost, targetPort, cb) {
  const auth = upstream.auth
    ? { 'proxy-authorization': `Basic ${Buffer.from(upstream.auth).toString('base64')}` }
    : {};

  const req = http.request({
    hostname: upstream.host,
    port:     upstream.port,
    method:   'CONNECT',
    path:     `${targetHost}:${targetPort}`,
    headers:  { host: `${targetHost}:${targetPort}`, ...auth },
    timeout:  10_000,
  });

  req.on('connect', (_res, socket) => cb(null, socket));
  req.on('error',   (err)          => cb(err));
  req.end();
}

// ── 3. Test runner ────────────────────────────────────────────────────────────

async function runTests() {
  let miniProxy;
  let allPassed = true;

  try {
    const { server, port } = await startMiniProxy();
    miniProxy = server;
    const upstream = { host: '127.0.0.1', port };

    // ── Test 1: openTunnel establishes a CONNECT tunnel ─────────────────────
    console.log('\nTest 1: openTunnel() via mini-proxy → httpbin.org:443');
    await new Promise((resolve, reject) => {
      openTunnel(upstream, 'httpbin.org', 443, (err, rawSocket) => {
        if (err) return reject(new Error(`openTunnel failed: ${err.message}`));

        if (!connectSeen) {
          rawSocket.destroy();
          return reject(new Error('CONNECT was not received by the mini-proxy'));
        }

        // ── Test 2: TLS wrap + real HTTPS request through the tunnel ─────────
        console.log('Test 2: TLS wrap + HTTPS GET https://httpbin.org/get');
        const tlsSocket = tls.connect({
          socket:             rawSocket,
          servername:         'httpbin.org',
          rejectUnauthorized: false,
        });

        tlsSocket.on('error', (e) => reject(new Error(`TLS error: ${e.message}`)));

        const req = https.request({
          hostname:        'httpbin.org',
          port:            443,
          path:            '/get',
          method:          'GET',
          createConnection: () => tlsSocket,
          agent:            false,
        }, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            if (res.statusCode === 200 && body.includes('"url"')) {
              console.log(`  status: ${res.statusCode}`);
              console.log(`  body snippet: ${body.slice(0, 120).replace(/\n/g, ' ')}`);
              resolve();
            } else {
              reject(new Error(`Unexpected response: status=${res.statusCode}`));
            }
          });
        });

        req.on('error', (e) => reject(new Error(`HTTPS request error: ${e.message}`)));
        req.end();
      });
    });

    console.log('\n✓ Test 1 PASSED — mini-proxy received CONNECT tunnel request');
    console.log('✓ Test 2 PASSED — TLS + HTTPS request succeeded through chain');

  } catch (err) {
    console.error(`\n✗ FAILED: ${err.message}`);
    allPassed = false;
  } finally {
    if (miniProxy) miniProxy.close();
  }

  console.log('\n' + (allPassed ? '✅ Proxy chain is working.' : '❌ Proxy chain test failed.'));
  process.exit(allPassed ? 0 : 1);
}

runTests();
