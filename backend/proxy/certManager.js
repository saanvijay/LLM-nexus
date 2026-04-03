const forge = require('node-forge');
const fs = require('fs');
const path = require('path');

const CERTS_DIR   = path.join(__dirname, '../certs');
const CA_CERT_PATH = path.join(CERTS_DIR, 'ca.crt');
const CA_KEY_PATH  = path.join(CERTS_DIR, 'ca.key');

if (!fs.existsSync(CERTS_DIR)) fs.mkdirSync(CERTS_DIR, { recursive: true });

let caCert, caKey;

if (fs.existsSync(CA_CERT_PATH) && fs.existsSync(CA_KEY_PATH)) {
  caCert = forge.pki.certificateFromPem(fs.readFileSync(CA_CERT_PATH, 'utf8'));
  caKey  = forge.pki.privateKeyFromPem(fs.readFileSync(CA_KEY_PATH, 'utf8'));
  console.log('Loaded existing CA cert from', CERTS_DIR);
} else {
  console.log('Generating CA certificate (one-time, ~5s)...');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  caCert = forge.pki.createCertificate();
  caCert.publicKey   = keys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter  = new Date();
  caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 10);
  const attrs = [{ name: 'commonName', value: 'LLM-nexus Proxy CA' },
                 { name: 'organizationName', value: 'LLM-nexus' }];
  caCert.setSubject(attrs);
  caCert.setIssuer(attrs);
  caCert.setExtensions([{ name: 'basicConstraints', cA: true },
                        { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
  caCert.sign(keys.privateKey, forge.md.sha256.create());
  caKey = keys.privateKey;

  fs.writeFileSync(CA_CERT_PATH, forge.pki.certificateToPem(caCert));
  fs.writeFileSync(CA_KEY_PATH,  forge.pki.privateKeyToPem(keys.privateKey));
  console.log(`CA cert saved → ${CA_CERT_PATH}`);
  console.log('Trust this CA on macOS (run once):');
  console.log(`  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${CA_CERT_PATH}\n`);
}

const certCache = {};

function getCertForHost(hostname) {
  if (certCache[hostname]) return certCache[hostname];

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey    = keys.publicKey;
  cert.serialNumber = String(Date.now());
  cert.validity.notBefore = new Date();
  cert.validity.notAfter  = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  cert.setSubject([{ name: 'commonName', value: hostname }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] }]);
  cert.sign(caKey, forge.md.sha256.create());

  certCache[hostname] = {
    key:  forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
  return certCache[hostname];
}

module.exports = { getCertForHost };
