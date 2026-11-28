// HTTPS to a server on this PC that has its own self-signed certificate (the Obsidian Local REST API plugin): the
// certificate is trusted for that one address only, and only the certificate seen at the first connection (its SHA-256
// fingerprint is pinned in the connection's settings). Anything else on that address, or that certificate anywhere
// else, is refused. The TLS connection is opened and checked first; only then is the request (with the API key) sent
// over it. Only addresses on this PC (client.localUrl). Used through netguard's wrapFetch (mcp.js).
const https = require('https');
const tls = require('tls');
const net = require('net');
const { localUrl } = require('./mcp-client');

const norm = (fp) => String(fp || '').replace(/:/g, '').toUpperCase();

function connectChecked({ host, port, pinned, onFirst, connect = tls.connect }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host });
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const fp = norm(cert && cert.fingerprint256);
      if (!fp) { socket.destroy(); reject(new Error('the server sent no certificate')); return; }
      if (pinned && fp !== pinned) {
        socket.destroy();
        reject(new Error('the certificate of this address changed: StarkLLM does not trust it (remove and add the connection again if you set up the plugin anew)'));
        return;
      }
      if (!pinned) onFirst(fp);
      socket.removeListener('error', reject);
      resolve(socket);
    });
  });
}

// -> fetch(url, opts) that resolves like fetch's Response (ok, status, headers.get, text)
// pin: the fingerprint saved before (empty: the first connection pins what it sees and reports it with onPin)
function pinnedFetch({ pin = '', onPin = () => {}, connect } = {}) {
  let pinned = norm(pin);
  return async (url, opts = {}) => {
    const href = localUrl(url);
    if (!href) throw new Error('only servers on this PC (127.0.0.1 or localhost)');
    const u = new URL(href);
    if (u.protocol !== 'https:') throw new Error('a pinned connection needs https');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const port = Number(u.port) || 443;
    const socket = await connectChecked({
      host, port, pinned, connect,
      onFirst: (fp) => { pinned = fp; try { onPin(fp); } catch (e) { /* saved next time */ } },
    });
    const body = opts.body == null ? null : Buffer.from(String(opts.body), 'utf8');
    const headers = { ...(opts.headers || {}), Host: u.host };
    if (body) headers['Content-Length'] = String(body.length);
    return new Promise((resolve, reject) => {
      // no agent: the request goes over the socket that was checked above, not over a new connection
      const req = https.request({ host, port, path: `${u.pathname}${u.search}`, method: opts.method || 'GET', headers, createConnection: () => socket }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          socket.destroy();
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: { get: (h) => { const v = res.headers[String(h).toLowerCase()]; return v == null ? null : [].concat(v).join(', '); } },
            text: async () => text,
          });
        });
        res.on('error', reject);
      });
      if (opts.signal) opts.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
      req.on('error', (e) => { socket.destroy(); reject(e); });
      if (body) req.write(body);
      req.end();
    });
  };
}

module.exports = { pinnedFetch, norm };
