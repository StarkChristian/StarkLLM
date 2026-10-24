const http = require('http');
const { execFile } = require('child_process');

const OLLAMA_URL = 'http://127.0.0.1:11434/api/tags';
const HEALTH_URL = `http://127.0.0.1:${process.env.STARKLLM_API_PORT || 8000}/health`;

const LINKS = {
  docker: 'https://www.docker.com/products/docker-desktop/',
  ollama: 'https://ollama.com/download',
  guide: 'https://www.starkllm.com/download'
};

function probe(url) {
  // Docker publishes the ports on 127.0.0.1; 'localhost' may resolve to ::1 first on Windows.
  url = url.replace('//localhost:', '//127.0.0.1:');
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        if (body.length < 65536) body += chunk;
      });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, body }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false, body: '' }));
  });
}

function dockerState() {
  return new Promise((resolve) => {
    execFile('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 10000, windowsHide: true }, (err) => {
      if (!err) return resolve('running');
      resolve(err.code === 'ENOENT' ? 'missing' : 'stopped');
    });
  });
}

async function diagnose(engine = {}) {
  let [docker, ollama, backend] = await Promise.all([dockerState(), probe(OLLAMA_URL), probe(HEALTH_URL)]);
  // The engine start knows better (it also finds docker.exe when it is not on PATH yet).
  if (engine.stage === 'docker-missing') docker = 'missing';
  else if (engine.stage === 'docker-stopped') docker = 'stopped';
  else if (engine.stage) docker = 'running';
  let models = [];
  try {
    models = (JSON.parse(ollama.body).models || []).map((m) => m.name);
  } catch (e) {
    // Ollama not reachable or not JSON: handled via ollama.ok below
  }
  const missingModels = [];
  if (ollama.ok) {
    if (!models.some((n) => n.startsWith('nomic-embed-text'))) missingModels.push('nomic-embed-text');
    if (!models.some((n) => !n.startsWith('nomic-embed-text'))) missingModels.push('qwen2.5:7b');
  }
  return { docker, ollama: ollama.ok, missingModels, backend: backend.ok, engine };
}

function buildRows(d) {
  const rows = [];

  if (d.docker === 'running') {
    rows.push({ ok: true, title: 'Docker is running' });
  } else if (d.docker === 'missing') {
    rows.push({
      ok: false,
      title: 'Docker Desktop is not installed',
      detail: 'StarkLLM runs its services in Docker. Install Docker Desktop (with WSL2), start it, then press Retry.',
      link: { href: LINKS.docker, label: 'Download Docker Desktop' }
    });
  } else {
    rows.push({
      ok: false,
      title: 'Docker Desktop is not running',
      detail: 'StarkLLM tried to start Docker Desktop but its engine did not come up. Open Docker Desktop, wait until it says "Engine running" (on a new PC it may ask to finish its setup or to enable WSL2 and restart), then press Retry.'
    });
  }

  if (!d.ollama) {
    rows.push({
      ok: false,
      title: 'Ollama is not running',
      detail: 'Install and start Ollama on this PC. StarkLLM expects it at 127.0.0.1:11434.',
      link: { href: LINKS.ollama, label: 'Download Ollama' }
    });
  } else if (d.missingModels.length) {
    rows.push({
      ok: false,
      title: 'Ollama is missing models',
      detail: 'StarkLLM could not download them automatically. Open a terminal and run:',
      code: d.missingModels.map((m) => 'ollama pull ' + m)
    });
  } else {
    rows.push({ ok: true, title: 'Ollama is running with models' });
  }

  if (d.engine.ok) {
    rows.push({ ok: true, title: 'StarkLLM engine is running' });
  } else if (d.docker === 'running') {
    rows.push({
      ok: false,
      title: 'The StarkLLM engine could not be started',
      detail: (d.engine.detail || 'The engine containers did not start.') + ' The full log is in ' + d.engine.logFile + '.',
      code: d.engine.log && d.engine.log.length ? d.engine.log : null
    });
  }
  for (const w of d.engine.warnings || []) rows.push({ ok: false, title: 'Warning', detail: w });

  return rows;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function buildErrorPage(d) {
  const rows = buildRows(d)
    .map((r) => {
      const code = r.code ? '<pre>' + r.code.map(esc).join('\n') + '</pre>' : '';
      const link = r.link ? '<a class="link" href="' + esc(r.link.href) + '" target="_blank">' + esc(r.link.label) + '</a>' : '';
      return (
        '<li class="' + (r.ok ? 'ok' : 'fail') + '"><span class="mark">' + (r.ok ? '&#10003;' : '&#10007;') + '</span>' +
        '<div><strong>' + esc(r.title) + '</strong>' +
        (r.detail ? '<p>' + esc(r.detail) + '</p>' : '') + code + link + '</div></li>'
      );
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>StarkLLM</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #05070a; color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1.5rem; }
  .card { width: 560px; max-width: 100%; padding: 2rem; border-radius: 20px; background: rgba(18, 22, 34, 0.7); border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6); }
  h1 { font-size: 1.4rem; margin-bottom: 0.3rem; }
  .sub { font-size: 0.85rem; color: #94a3b8; margin-bottom: 1.4rem; }
  ul { list-style: none; display: flex; flex-direction: column; gap: 0.9rem; margin-bottom: 1.6rem; }
  li { display: flex; gap: 0.8rem; font-size: 0.88rem; }
  .mark { flex: none; width: 22px; height: 22px; border-radius: 50%; text-align: center; line-height: 22px; font-size: 0.8rem; }
  li.ok .mark { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
  li.fail .mark { background: rgba(248, 113, 113, 0.15); color: #f87171; }
  p { color: #cbd5e1; margin-top: 0.2rem; line-height: 1.45; }
  pre { margin-top: 0.4rem; padding: 0.5rem 0.7rem; border-radius: 8px; background: #0b0f17; color: #a5b4fc; font-size: 0.8rem; user-select: text; }
  .link { display: inline-block; margin-top: 0.4rem; color: #818cf8; }
  .actions { display: flex; gap: 0.8rem; align-items: center; }
  .btn { padding: 0.55rem 1.1rem; border-radius: 10px; background: #6366f1; color: #fff; text-decoration: none; font-size: 0.88rem; font-weight: 600; }
  .actions .link { margin: 0; font-size: 0.85rem; }
</style>
</head>
<body>
<div class="card">
  <h1>${d.engine.ok ? 'StarkLLM is running without its AI runtime' : 'StarkLLM could not start'}</h1>
  <p class="sub">Here is what this PC is missing:</p>
  <ul>${rows}</ul>
  <div class="actions">
    <a class="btn" href="starkllm-retry:">Retry</a>
    ${d.engine.ok ? '<a class="link" href="starkllm-continue:">Open StarkLLM anyway</a>' : ''}
    <a class="link" href="${LINKS.guide}" target="_blank">Setup guide</a>
  </div>
</div>
</body>
</html>`;
}

module.exports = { probe, diagnose, buildErrorPage, HEALTH_URL };
