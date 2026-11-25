// The bridge of the address bar (webtask-bar.html): three calls, nothing else of Electron or Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('starkllmBar', {
  go: (what) => ipcRenderer.send('webbar:go', String(what || '')),
  open: (text) => ipcRenderer.send('webbar:open', String(text || '').slice(0, 2048)),
  onState: (cb) => ipcRenderer.on('webbar:state', (_e, s) => cb(s)),
});
