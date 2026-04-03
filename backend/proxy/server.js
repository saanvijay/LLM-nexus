const http = require('http');
const tls  = require('tls');
const config = require('../config/proxy.config.json');
const { handleRequest } = require('./handler');
const { getCertForHost } = require('./certManager');
require('../dashboard/server');

if (process.env.PORT) config.port = parseInt(process.env.PORT);
if (process.env.HOST) config.host = process.env.HOST;
if (process.env.REQUEST_TIMEOUT) config.requestTimeout = parseInt(process.env.REQUEST_TIMEOUT);

// Internal server that receives already-decrypted HTTPS connections
const interceptServer = http.createServer(handleRequest);

// Main proxy server
const server = http.createServer(handleRequest);

server.on('connect', (req, clientSocket, _head) => {
  const [hostname] = req.url.split(':');

  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

  const hostCert = getCertForHost(hostname);
  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key:  hostCert.key,
    cert: hostCert.cert,
    rejectUnauthorized: false,
  });

  interceptServer.emit('connection', tlsSocket);
});

server.listen(config.port, config.host, () => {
  console.log(`Proxy running on http://${config.host}:${config.port}`);
  console.log(`  export HTTP_PROXY=http://${config.host}:${config.port}`);
  console.log(`  export HTTPS_PROXY=http://${config.host}:${config.port}`);
});
