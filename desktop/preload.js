// The only bridge from the web UI to the desktop app: lets Settings > About start an update check.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('starkllmDesktop', {
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
});
