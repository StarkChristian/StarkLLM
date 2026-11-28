// Try Settings › Connections (connections.js, mcp.js) in Electron with real packages: install "Files" (npm) and "Git"
// (uv) from the catalog through the runtimes, check that every tool starts off, that read-only holds, that calls need a
// yes, that a read tool can be allowed for the session, that the audit log is written, and that a .mcpb bundle installs.
// Needs a runtime folder like the installer's: <root>/runtime/uv/uv and <root>/runtime/node/{bin/node, lib/node_modules/npm}.
// From desktop/: RUNTIME_ROOT=/tmp/w27rt xvfb-run -a node_modules/electron/dist/electron --no-sandbox tools/connections-try.js
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const zlib = require('zlib');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
app.setPath('userData', tmp('starkllm-conn-'));
app.on('window-all-closed', () => {});
const ok = (cond, what) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${what}`); if (!cond) process.exitCode = 1; };

function zip(files) { // deflated entries, enough for a .mcpb
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content); const body = zlib.deflateRawSync(data); const n = Buffer.from(name);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(body.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(l, n, body); centrals.push(c, n); offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(centrals); const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}

app.whenReady().then(async () => {
  const guard = require('../netguard').initShared(tmp('conn-net-'));
  const mcp = require('../mcp');
  const connections = require('../connections');
  const h = {};
  const ipc = { handle: (n, f) => { h[n] = f; } };
  const ev = { sender: { send: (ch, p) => console.log('  progress', p.step, '/', p.total, p.label) } };
  mcp.register(ipc, { fromApp: () => true, log: (l) => console.log('  log:', l), auditFile: path.join(app.getPath('userData'), 'connections-audit.jsonl') });
  connections.register(ipc, { fromApp: () => true, log: (l) => console.log('  log:', l), resourcesPath: process.env.RUNTIME_ROOT || '/tmp/w27rt' });
  const only = (process.env.ONLY || 'files,git,bundle').split(',');

  const cat = await h['connections:catalog'](ev, 'de');
  ok(cat.entries.length >= 12 && cat.entries.find((e) => e.id === 'files').name === 'Dateien (ausgewählte Ordner)', `catalog in German (${cat.entries.length} entries, secrets: ${cat.secretStore})`);

  if (only.includes('files')) {
    const folder = tmp('conn-files-');
    fs.writeFileSync(path.join(folder, 'hello.txt'), 'Hello from the Files connection');
    const r = await h['connections:install'](ev, 'files', { folder, allowWrite: false }, { lang: 'en' });
    ok(r.ok && !r.startError, `files installed and started ${r.error || ''} ${r.message || ''} ${r.startError || ''}`);
    const s = r.ok && r.servers.find((x) => x.catalogId === 'files');
    if (s) {
      ok(s.running && s.tools.length > 5 && s.enabledTools.length === 0, `files: ${s.tools.length} tools, all off (${s.tools.map((t) => `${t.name}:${t.tier}${t.locked ? '/' + t.locked : ''}`).join(' ')})`);
      ok(s.readOnly && s.tools.find((t) => t.name === 'write_file').locked === 'read-only', 'files: read-only, write_file locked');
      ok((await h['mcp:set-tool'](ev, s.id, 'write_file', true)).error === 'tool-read-only', 'files: write_file cannot be turned on');
      ok((await h['mcp:set-tool'](ev, s.id, 'read_text_file', true)).ok, 'files: read_text_file turned on');
      const name = `ext__${s.id}__read_text_file`;
      const args = { path: path.join(folder, 'hello.txt') };
      ok((await h['mcp:call'](ev, name, args, {})).error === 'needs-approval', 'files: a call without a yes is refused');
      const c1 = await h['mcp:call'](ev, name, args, { confirmed: true, chatId: 'c1' });
      ok(c1.ok && c1.result.includes('Hello from the Files connection'), `files: read_text_file -> ${JSON.stringify(c1).slice(0, 120)}`);
      ok((await h['mcp:allow-session'](ev, name)).ok, 'files: read tool allowed for the session');
      ok((await h['mcp:call'](ev, name, args, { chatId: 'c1' })).ok, 'files: allowed read tool runs without a yes');
      const outside = await h['mcp:call'](ev, name, { path: '/etc/hostname' }, { confirmed: true, chatId: 'c1' });
      ok(!outside.ok || /denied|outside|not allowed/i.test(outside.result || ''), `files: a file outside the folder is refused by the server (${JSON.stringify(outside).slice(0, 100)})`);
      const audit = (await h['mcp:audit'](ev, 10)).entries;
      ok(audit.length >= 3 && audit.some((a) => a.outcome === 'refused') && audit.some((a) => a.auto), `audit log: ${audit.length} entries`);
      ok(fs.readFileSync(path.join(app.getPath('userData'), 'mcp-servers.json'), 'utf8').includes('"pins"'), 'pins saved with the connection');
    }
    ok(guard.list().some((e) => e.feature === 'connection_install' && e.host === 'registry.npmjs.org'), 'the npm download is in the network log');
  }

  if (only.includes('git')) {
    const repo = tmp('conn-git-');
    execFileSync('git', ['init', '-q', repo]);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
    const r = await h['connections:install'](ev, 'git', { repository: repo }, { lang: 'en' });
    ok(r.ok && !r.startError, `git installed and started ${r.error || ''} ${r.message || ''} ${r.startError || ''}`);
    const s = r.ok && r.servers.find((x) => x.catalogId === 'git');
    if (s) {
      ok(s.running && s.enabledTools.length === 0, `git: ${s.tools.map((t) => `${t.name}:${t.tier}`).join(' ')}`);
      await h['mcp:set-tool'](ev, s.id, 'git_status', true);
      const st = await h['mcp:call'](ev, `ext__${s.id}__git_status`, { repo_path: repo }, { confirmed: true });
      ok(st.ok && /a\.txt/.test(st.result), `git_status -> ${JSON.stringify(st).slice(0, 160)}`);
    }
    ok(guard.list().some((e) => e.feature === 'connection_install' && e.host === 'pypi.org'), 'the PyPI download is in the network log');
  }

  if (only.includes('bundle')) {
    const dir = tmp('conn-mcpb-');
    const file = path.join(dir, 'fake.mcpb');
    fs.writeFileSync(file, zip([
      ['manifest.json', JSON.stringify({ manifest_version: '0.3', name: 'fake-bundle', display_name: 'Fake bundle', version: '1.0.0', author: { name: 'Test' },
        server: { type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: { FAKE_ADD_DESCRIPTION: 'Adds.' } } },
        tools: [{ name: 'add' }, { name: 'weather' }] })],
      ['server/index.js', fs.readFileSync(path.join(__dirname, '..', 'testdata', 'fake-mcp-server.js'), 'utf8')],
    ]));
    const p = await h['connections:preview-bundle'](ev, file);
    ok(p.ok && p.manifest.name === 'Fake bundle' && p.manifest.tools.length === 2, `bundle preview: ${p.manifest && p.manifest.tools.map((t) => `${t.name}:${t.tier}`).join(' ')}`);
    const r = await h['connections:install-bundle'](ev, p.token, {});
    ok(r.ok && !r.startError, `bundle installed and started ${r.error || ''} ${r.message || ''} ${r.startError || ''}`);
    const s = r.ok && r.servers.find((x) => x.kind === 'bundle');
    if (s) {
      await h['mcp:set-tool'](ev, s.id, 'add', true);
      const c = await h['mcp:call'](ev, `ext__${s.id}__add`, { a: 2, b: 40 }, { confirmed: true, chatId: 'c2' });
      ok(c.ok && c.result === '42', `bundle tool call -> ${JSON.stringify(c)}`);
      const chk = await h['mcp:check'](ev, `ext__${s.id}__add`, 'c2');
      ok(chk.ok && chk.taintedBy, `after a bundle tool, chat c2 counts as having read outside content (${chk.taintedBy})`);
      const dirOf = mcp.readServers().find((x) => x.id === s.id).bundleDir;
      ok((await h['connections:uninstall'](ev, s.id)).ok && !fs.existsSync(dirOf), 'bundle removed with its files');
    }
  }

  // more catalog entries, installed with their default answers (their apps are not needed to install and list tools)
  for (const id of (process.env.MORE || '').split(',').filter(Boolean)) {
    const r = await h['connections:install'](ev, id, {}, { lang: 'en', acknowledged: true });
    const s = r.ok && r.servers.find((x) => x.catalogId === id);
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${id}: ${r.ok ? `installed; ${r.startError ? `did not start: ${r.startError}` : `${s.tools.length} tools: ${s.tools.map((t) => `${t.name}:${t.tier}${t.locked ? '/' + t.locked : ''}`).join(' ')}`}` : `${r.error} ${r.message || ''}`}`);
  }

  const stopped = await h['mcp:stop-all'](ev);
  ok(stopped.servers.every((s) => !s.running), 'stop all connections');
  for (const s of stopped.servers) await h['connections:uninstall'](ev, s.id);
  ok(mcp.readServers().length === 0, 'everything removed');
  app.exit(process.exitCode || 0);
});
