// StarkLLM's own connector for OBS Studio (docs/connections.md): a small MCP server over stdio that talks to OBS's
// built-in obs-websocket (protocol v5) on this PC. Written for StarkLLM because it needs only a few, clearly limited
// tools: no generic "send any request", no file access, no settings changes.
// Started by the desktop app with Electron as Node (ELECTRON_RUN_AS_NODE); needs Node's WebSocket (Node 22+).
// Environment: OBS_WEBSOCKET_PORT (default 4455), OBS_WEBSOCKET_PASSWORD (from Windows Credential Manager).
const crypto = require('crypto');
const readline = require('readline');

const PORT = Number(process.env.OBS_WEBSOCKET_PORT) || 4455;
const HOST = '127.0.0.1'; // never another computer
const PASSWORD = process.env.OBS_WEBSOCKET_PASSWORD || '';
delete process.env.OBS_WEBSOCKET_PASSWORD;

const TOOLS = [
  { name: 'obs_get_status', description: 'Current scene of OBS Studio, and whether it is recording or streaming.', inputSchema: { type: 'object', properties: {} } },
  { name: 'obs_list_scenes', description: 'The scenes of the current OBS Studio scene collection.', inputSchema: { type: 'object', properties: {} } },
  { name: 'obs_set_scene', description: 'Switch OBS Studio to another scene (program output).', inputSchema: { type: 'object', properties: { scene: { type: 'string', description: 'Name of the scene' } }, required: ['scene'] } },
  { name: 'obs_start_recording', description: 'Start recording in OBS Studio.', inputSchema: { type: 'object', properties: {} } },
  { name: 'obs_stop_recording', description: 'Stop recording in OBS Studio; returns the file it wrote.', inputSchema: { type: 'object', properties: {} } },
  { name: 'obs_start_streaming', description: 'Start the live stream of OBS Studio (goes out to the internet).', inputSchema: { type: 'object', properties: {} } },
  { name: 'obs_stop_streaming', description: 'Stop the live stream of OBS Studio.', inputSchema: { type: 'object', properties: {} } },
];

// obs-websocket v5 authentication: base64(sha256(base64(sha256(password + salt)) + challenge))
function authString(password, salt, challenge) {
  const secret = crypto.createHash('sha256').update(password + salt).digest('base64');
  return crypto.createHash('sha256').update(secret + challenge).digest('base64');
}

class Obs {
  constructor({ host = HOST, port = PORT, password = PASSWORD, WebSocketImpl = globalThis.WebSocket } = {}) {
    this.url = `ws://${host}:${port}`;
    this.password = password;
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null;
    this.ready = null;
    this.pending = new Map();
    this.next = 1;
  }

  connect() {
    if (this.ready) return this.ready;
    if (!this.WebSocketImpl) return Promise.reject(new Error('this Node has no WebSocket'));
    this.ready = new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.url, 'obswebsocket.json');
      this.ws = ws;
      const fail = (why) => {
        this.ready = null;
        reject(new Error(why));
        for (const p of this.pending.values()) p.reject(new Error(why));
        this.pending.clear();
      };
      ws.onerror = () => fail('OBS Studio is not reachable: is it open, with Tools › WebSocket Server Settings › "Enable WebSocket server" ticked?');
      ws.onclose = (ev) => fail(ev && ev.code === 4009 ? 'OBS refused the password (Tools › WebSocket Server Settings › Show Connect Info)' : 'the connection to OBS Studio ended');
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }
        if (msg.op === 0) {
          const d = { rpcVersion: 1, eventSubscriptions: 0 };
          const a = msg.d && msg.d.authentication;
          if (a) {
            if (!this.password) { fail('OBS asks for a password: add it in Settings › Connections'); ws.close(); return; }
            d.authentication = authString(this.password, a.salt, a.challenge);
          }
          ws.send(JSON.stringify({ op: 1, d }));
        } else if (msg.op === 2) {
          resolve();
        } else if (msg.op === 7) {
          const p = this.pending.get(msg.d.requestId);
          if (!p) return;
          this.pending.delete(msg.d.requestId);
          const st = msg.d.requestStatus || {};
          if (st.result) p.resolve(msg.d.responseData || {});
          else p.reject(new Error(`OBS: ${st.comment || `request failed (${st.code})`}`));
        }
      };
    });
    return this.ready;
  }

  async request(requestType, requestData) {
    await this.connect();
    const requestId = `r${this.next++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('OBS did not answer')); }, 15000);
      this.pending.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  close() { try { if (this.ws) this.ws.close(); } catch (e) { /* closed */ } }
}

async function callTool(obs, name, args = {}) {
  switch (name) {
    case 'obs_get_status': {
      const [scene, rec, stream] = await Promise.all([obs.request('GetCurrentProgramScene'), obs.request('GetRecordStatus'), obs.request('GetStreamStatus')]);
      return `Scene: ${scene.currentProgramSceneName || scene.sceneName || '?'}\nRecording: ${rec.outputActive ? 'yes' : 'no'}\nStreaming: ${stream.outputActive ? 'yes' : 'no'}`;
    }
    case 'obs_list_scenes': {
      const r = await obs.request('GetSceneList');
      const names = (r.scenes || []).map((s) => s.sceneName).reverse();
      return `Current: ${r.currentProgramSceneName || '?'}\nScenes:\n${names.map((n) => `- ${n}`).join('\n')}`;
    }
    case 'obs_set_scene': {
      const scene = String(args.scene || '').slice(0, 200);
      if (!scene) throw new Error('scene is required');
      await obs.request('SetCurrentProgramScene', { sceneName: scene });
      return `Switched to "${scene}".`;
    }
    case 'obs_start_recording': await obs.request('StartRecord'); return 'Recording started.';
    case 'obs_stop_recording': { const r = await obs.request('StopRecord'); return `Recording stopped.${r.outputPath ? ` File: ${r.outputPath}` : ''}`; }
    case 'obs_start_streaming': await obs.request('StartStream'); return 'Live stream started.';
    case 'obs_stop_streaming': await obs.request('StopStream'); return 'Live stream stopped.';
    default: throw new Error(`unknown tool ${name}`);
  }
}

function serve({ input = process.stdin, output = process.stdout, obs = new Obs() } = {}) {
  const send = (msg) => output.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input });
  rl.on('line', async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return; }
    if (msg.id == null) return; // notifications
    try {
      if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'starkllm-obs', version: '1.0.0' } } });
      } else if (msg.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
      } else if (msg.method === 'tools/call') {
        const { name, arguments: a } = msg.params || {};
        try {
          const text = await callTool(obs, name, a || {});
          send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } });
        } catch (e) {
          send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } });
        }
      } else if (msg.method === 'ping') {
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
      }
    } catch (e) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e.message || e) } });
    }
  });
  rl.on('close', () => obs.close());
}

if (require.main === module) serve();

module.exports = { TOOLS, authString, Obs, callTool, serve };
