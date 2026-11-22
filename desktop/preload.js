// The only bridge from the web UI to the desktop app: an update check for Settings > About, opening the knowledge-base
// folder, and the local session
// (single user, no sign-up), which is placed before the web UI starts so it opens signed in.
const { contextBridge, ipcRenderer } = require('electron');

const localToken = () => ipcRenderer.sendSync('desktop:local-token') || null;

try {
  const t = localToken();
  if (t && !window.localStorage.getItem('token')) window.localStorage.setItem('token', t);
} catch (e) {
  // the web UI shows its login instead
}

contextBridge.exposeInMainWorld('starkllmDesktop', {
  // the interface language the user chose: dialogs and the tray menu of the desktop app follow it
  setLanguage: (code) => ipcRenderer.send('desktop:set-language', String(code || '')),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  // a chat or an answer as PDF: printed by the desktop app, saved where the user chooses (docs/roadmap-2026-12.md, R1)
  exportPdf: (html, name) => ipcRenderer.invoke('export:pdf', String(html || ''), String(name || '')),
  // tool servers (MCP) of the user (docs/roadmap-2026-12.md, R6): Settings and the tool card in the chat
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    add: (s) => ipcRenderer.invoke('mcp:add', {
      name: String((s && s.name) || ''), transport: s && s.transport === 'http' ? 'http' : 'stdio', command: String((s && s.command) || ''),
      args: String((s && s.args) || ''), url: String((s && s.url) || ''),
      env: s && s.env && typeof s.env === 'object' ? Object.fromEntries(Object.entries(s.env).map(([k, v]) => [String(k), String(v)])) : {},
    }),
    remove: (id) => ipcRenderer.invoke('mcp:remove', String(id || '')),
    start: (id) => ipcRenderer.invoke('mcp:start', String(id || '')),
    stop: (id) => ipcRenderer.invoke('mcp:stop', String(id || '')),
    setTool: (id, tool, on) => ipcRenderer.invoke('mcp:set-tool', String(id || ''), String(tool || ''), Boolean(on)),
    enabledTools: () => ipcRenderer.invoke('mcp:enabled-tools'),
    call: (name, args) => ipcRenderer.invoke('mcp:call', String(name || ''), args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : {}),
  },
  openKnowledgeFolder: () => ipcRenderer.invoke('kb:open-folder'),
  // download progress of an update: cb({ phase: 'downloading' | 'done', percent }); returns an unsubscribe function
  onUpdateStatus: (cb) => {
    const handler = (_event, status) => cb(status);
    ipcRenderer.on('updates:status', handler);
    return () => ipcRenderer.removeListener('updates:status', handler);
  },
  // Settings > Privacy: the fully offline switch of the app and the list of its outgoing connections
  getPrivacy: () => ipcRenderer.invoke('privacy:get'),
  setOffline: (on) => ipcRenderer.invoke('privacy:set-offline', Boolean(on)),
  getNetworkLog: (limit) => ipcRenderer.invoke('privacy:log', limit),
  clearNetworkLog: () => ipcRenderer.invoke('privacy:clear-log'),
  localToken,
  // Settings > Protection: the key is created, wrapped and handed to the engine by the desktop app; the page only
  // gets the recovery key (once, to show it) and answers.
  // Settings > Backup: automatic weekly backup into a folder the user chooses (backup-schedule.js)
  backup: {
    status: () => ipcRenderer.invoke('backup:status'),
    chooseFolder: () => ipcRenderer.invoke('backup:choose-folder'),
    configure: (settings) => ipcRenderer.invoke('backup:configure', settings),
    runNow: () => ipcRenderer.invoke('backup:run-now'),
    disable: () => ipcRenderer.invoke('backup:disable'),
  },
  // Settings > Phone: the phone link (phonelink.js). The page gets the QR code as squares to draw; the device tokens
  // never leave the desktop app.
  phoneLink: {
    status: () => ipcRenderer.invoke('phone:status'),
    setEnabled: (on) => ipcRenderer.invoke('phone:enable', Boolean(on)),
    startPairing: () => ipcRenderer.invoke('phone:pair'),
    cancelPairing: () => ipcRenderer.invoke('phone:cancel-pair'),
    removeDevice: (id) => ipcRenderer.invoke('phone:remove', String(id || '')),
    setLevel: (id, level) => ipcRenderer.invoke('phone:set-level', String(id || ''), String(level || '')),
    onChange: (cb) => {
      const handler = () => cb();
      ipcRenderer.on('phone:changed', handler);
      return () => ipcRenderer.removeListener('phone:changed', handler);
    },
  },
  // Web tasks (docs/web-tasks.md): StarkLLM does a task on websites in its own browser window. Each step, each
  // question for the user and the answer come as events; the page answers questions with reply().
  webTask: {
    start: (opts) => ipcRenderer.invoke('webtask:start', {
      task: String((opts && opts.task) || ''), model: String((opts && opts.model) || ''), language: String((opts && opts.language) || ''),
      previous: opts && opts.previous ? { task: String(opts.previous.task || ''), answer: String(opts.previous.answer || '') } : null,
      folder: opts && opts.folder ? String(opts.folder) : '',
    }),
    // the terminal: the project folder (chosen in the folder dialog), and undoing the file changes of the last task
    chooseFolder: () => ipcRenderer.invoke('webtask:choose-folder'),
    undo: () => ipcRenderer.invoke('webtask:undo'),
    reply: (qid, answer) => ipcRenderer.invoke('webtask:reply', String(qid || ''), {
      ok: Boolean(answer && answer.ok), text: String((answer && answer.text) || ''), remember: Boolean(answer && answer.remember),
    }),
    // the user's site rules (Settings): { rules: { host: 'allow' | 'block' } }; rule null removes one
    sites: () => ipcRenderer.invoke('webtask:sites'),
    setSiteRule: (host, rule) => ipcRenderer.invoke('webtask:site-rule', String(host || ''), rule === 'allow' || rule === 'block' ? rule : null),
    stop: () => ipcRenderer.invoke('webtask:stop'),
    // the user takes over the window and hands it back
    pause: () => ipcRenderer.invoke('webtask:pause'),
    resume: () => ipcRenderer.invoke('webtask:resume'),
    // the text of the page the window shows, to save it to the workspace
    pageText: () => ipcRenderer.invoke('webtask:page'),
    showWindow: () => ipcRenderer.invoke('webtask:show'),
    // scheduled web tasks (docs/roadmap-2026-12.md, R5): looking only, run by the desktop app
    schedules: {
      list: () => ipcRenderer.invoke('webtask:schedules'),
      add: (opts) => ipcRenderer.invoke('webtask:schedule-add', {
        task: String((opts && opts.task) || ''), model: String((opts && opts.model) || ''), language: String((opts && opts.language) || ''),
        rule: opts && opts.rule ? { every: String(opts.rule.every || ''), time: String(opts.rule.time || ''), weekday: Number(opts.rule.weekday) } : null,
        workspaceId: Number(opts && opts.workspaceId) || null,
      }),
      setEnabled: (id, enabled) => ipcRenderer.invoke('webtask:schedule-enabled', String(id || ''), Boolean(enabled)),
      remove: (id) => ipcRenderer.invoke('webtask:schedule-remove', String(id || '')),
      runNow: (id) => ipcRenderer.invoke('webtask:schedule-run', String(id || '')),
      onChange: (cb) => {
        const handler = () => cb();
        ipcRenderer.on('webtask:schedules-changed', handler);
        return () => ipcRenderer.removeListener('webtask:schedules-changed', handler);
      },
    },
    clearData: () => ipcRenderer.invoke('webtask:clear-data'),
    onEvent: (cb) => {
      const handler = (_event, e) => cb(e);
      ipcRenderer.on('webtask:event', handler);
      return () => ipcRenderer.removeListener('webtask:event', handler);
    },
  },
  protection: {
    status: () => ipcRenderer.invoke('protection:status'),
    createKey: () => ipcRenderer.invoke('protection:create-key'),
    unlock: (passphrase) => ipcRenderer.invoke('protection:unlock', passphrase),
    recover: (recoveryKey) => ipcRenderer.invoke('protection:recover', recoveryKey),
    storeKey: (keyBase64) => ipcRenderer.invoke('protection:store-key', keyBase64),
    setPassphrase: (passphrase) => ipcRenderer.invoke('protection:set-passphrase', passphrase),
    removePassphrase: (passphrase) => ipcRenderer.invoke('protection:remove-passphrase', passphrase),
    forgetKey: () => ipcRenderer.invoke('protection:forget-key'),
  },
});

// The start-up passphrase page (unlock.html) is a local file, not the app: it gets its own two calls and nothing else.
if (window.location.protocol === 'file:' && /unlock\.html$/.test(window.location.pathname)) {
  contextBridge.exposeInMainWorld('starkllmUnlock', {
    submit: (passphrase) => ipcRenderer.invoke('unlock:submit', passphrase),
    recover: (recoveryKey) => ipcRenderer.invoke('unlock:recover', recoveryKey),
  });
}
