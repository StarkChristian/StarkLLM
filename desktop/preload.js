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
    }),
    reply: (qid, answer) => ipcRenderer.invoke('webtask:reply', String(qid || ''), { ok: Boolean(answer && answer.ok), text: String((answer && answer.text) || '') }),
    stop: () => ipcRenderer.invoke('webtask:stop'),
    showWindow: () => ipcRenderer.invoke('webtask:show'),
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
