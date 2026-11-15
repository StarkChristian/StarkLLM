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
