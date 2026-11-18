// A self-signed certificate for the phone link (phonelink.js), made with Node's own crypto: no package and no
// certificate authority. The phone does not trust it because of who signed it but because the QR code it scanned holds
// its SHA-256 fingerprint (certificate pinning), so the certificate only needs to be well formed.
//
// The certificate is written by hand in DER (ASN.1): an EC P-256 key, ECDSA with SHA-256, basicConstraints CA:FALSE.
const crypto = require('crypto');

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);

function oid(dotted) {
  const n = dotted.split('.').map(Number);
  const out = [40 * n[0] + n[1]];
  for (const v of n.slice(2)) {
    const groups = [v & 0x7f];
    for (let rest = Math.floor(v / 128); rest > 0; rest = Math.floor(rest / 128)) groups.unshift((rest & 0x7f) | 0x80);
    out.push(...groups);
  }
  return tlv(0x06, Buffer.from(out));
}

function integer(buf) {
  let b = buf;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

// UTCTime up to 2049, GeneralizedTime from 2050 on (RFC 5280, 4.1.2.5)
function time(d) {
  const p = (v) => String(v).padStart(2, '0');
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const y = d.getUTCFullYear();
  return y < 2050 ? tlv(0x17, Buffer.from(String(y).slice(2) + rest)) : tlv(0x18, Buffer.from(String(y) + rest));
}

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const COMMON_NAME = '2.5.4.3';
const BASIC_CONSTRAINTS = '2.5.29.19';

/**
 * Returns { keyPem, certPem, fingerprint } where fingerprint is the SHA-256 of the certificate (DER) in base64url.
 * name: the common name; years: how long it is valid.
 */
function createSelfSigned({ name = 'StarkLLM phone link', years = 20, now = new Date() } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  const notAfter = new Date(now.getTime());
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + years);
  const dn = seq(set(seq(oid(COMMON_NAME), tlv(0x0c, Buffer.from(name, 'utf8')))));
  const algorithm = seq(oid(ECDSA_SHA256));
  const extensions = tlv(0xa3, seq(seq(oid(BASIC_CONSTRAINTS), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq()))));
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),              // version 3
    integer(serial),
    algorithm,
    dn,
    seq(time(notBefore), time(notAfter)),
    dn,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions
  );
  const signature = crypto.sign('sha256', tbs, privateKey);   // DER-encoded ECDSA signature
  const der = seq(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), certPem, fingerprint: fingerprintOf(der) };
}

// SHA-256 of a certificate (DER bytes or PEM text) in base64url, the form the QR code carries
function fingerprintOf(cert) {
  const der = Buffer.isBuffer(cert) ? cert : Buffer.from(String(cert).replace(/-----[^-]+-----|\s/g, ''), 'base64');
  return crypto.createHash('sha256').update(der).digest('base64url');
}

module.exports = { createSelfSigned, fingerprintOf };
