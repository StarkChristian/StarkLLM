// MCP client (mcp-client.js, docs/roadmap-2026-12.md R6): handshake, tools, calls, cleaned descriptions, local only.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const c = require('../mcp-client');
const { cleanServer, serverEnv } = require('../mcp');

const FAKE = path.join(__dirname, '..', 'testdata', 'fake-mcp-server.js'); // not under test/: node --test would run it

test('a stdio server: handshake, its tools (cleaned), a call, an error', async () => {
  const conn = new c.StdioConnection({ command: process.execPath, args: [FAKE], env: process.env });
  try {
    const r = await c.connect(conn);
    assert.deepEqual(r.server, { name: 'fake', version: '1.0' });
    assert.deepEqual(r.tools.map((t) => t.name), ['add', 'weather', 'badname']);
    const poisoned = r.tools.find((t) => t.name === 'weather').description;
    assert.ok(poisoned.length <= 600);
    assert.ok(!poisoned.includes('```'));
    assert.equal(await c.callTool(conn, 'add', { a: 2, b: 40 }), '42');
    await assert.rejects(c.callTool(conn, 'nothing', {}), /unknown tool/);
  } finally {
    conn.close();
  }
});

test('a program that does not exist gives a clear error', async () => {
  const conn = new c.StdioConnection({ command: 'starkllm-no-such-program', args: [], env: process.env });
  await assert.rejects(c.connect(conn), /could not start|ended/);
});

test('HTTP servers only on this PC; an answer as an event stream is read', async () => {
  assert.equal(c.localUrl('http://127.0.0.1:8123/mcp'), 'http://127.0.0.1:8123/mcp');
  assert.equal(c.localUrl('http://localhost:9000/'), 'http://localhost:9000/');
  for (const bad of ['http://192.168.0.5:8000/mcp', 'https://example.com/mcp', 'file:///etc/passwd', 'http://127.0.0.1.evil.example/']) {
    assert.equal(c.localUrl(bad), null, bad);
  }
  assert.throws(() => new c.HttpConnection({ url: 'https://example.com/mcp' }), /only servers on this PC/);
  const calls = [];
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ body, headers: opts.headers });
    const respond = (msg, sse) => ({
      ok: true, status: 200,
      headers: { get: (h) => (h === 'content-type' ? (sse ? 'text/event-stream' : 'application/json') : h === 'mcp-session-id' ? 'sess-1' : null) },
      text: async () => (sse ? `event: message\ndata: ${JSON.stringify(msg)}\n\n` : JSON.stringify(msg)),
    });
    if (!body.id) return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' };
    if (body.method === 'initialize') return respond({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'web' } } }, false);
    if (body.method === 'tools/list') return respond({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'now', description: 'time' }] } }, true);
    return respond({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '12:00' }] } }, true);
  };
  const conn = new c.HttpConnection({ url: 'http://127.0.0.1:8123/mcp', fetchFn });
  const r = await c.connect(conn);
  assert.deepEqual(r.tools.map((t) => t.name), ['now']);
  assert.equal(await c.callTool(conn, 'now', {}), '12:00');
  assert.equal(calls[calls.length - 1].headers['Mcp-Session-Id'], 'sess-1');
});

test('names for the model, and results as text', () => {
  assert.equal(c.externalName('s1ab', 'add'), 'ext__s1ab__add');
  assert.deepEqual(c.parseExternalName('ext__s1ab__add'), { serverId: 's1ab', tool: 'add' });
  assert.equal(c.parseExternalName('list_workspace_files'), null);
  assert.equal(c.parseExternalName('ext__../x__add'), null);
  assert.equal(c.resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: '...' }], isError: true }), 'a\n[image]\n(the tool reported an error)');
});

test('servers from the Settings form are checked; secrets stay out of their environment', () => {
  assert.equal(cleanServer({ name: 'x', transport: 'http', url: 'https://example.com/mcp' }, 's1'), null);
  assert.equal(cleanServer({ name: '', command: 'node' }, 's1'), null);
  const s = cleanServer({ name: 'Files', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem C:\\Projects', env: { ROOT: 'C:\\Projects', 'bad name': 'x' } }, 's1');
  assert.deepEqual(s.args, ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Projects']);
  assert.deepEqual(s.env, { ROOT: 'C:\\Projects' });
  assert.deepEqual(s.enabledTools, []); // every tool is off until the user turns it on
  process.env.GITHUB_TOKEN = 'ghp_secret';
  process.env.STARKLLM_SECRET_X = 'y';
  const env = serverEnv({ MY_SETTING: '1' });
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.STARKLLM_SECRET_X, undefined);
  assert.equal(env.MY_SETTING, '1');
  delete process.env.GITHUB_TOKEN;
  delete process.env.STARKLLM_SECRET_X;
});
