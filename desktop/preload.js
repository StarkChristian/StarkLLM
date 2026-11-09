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
  localToken,
});
