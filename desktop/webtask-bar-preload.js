// The bridge of the browser bar (webtask-bar.html): these calls, nothing else of Electron or Node. The desktop app
// checks that they come from the bar and checks every value again (webtask.js).
const { contextBridge, ipcRenderer } = require('electron');

// a small plain object: strings, numbers and true/false only
function plain(arg) {
  const out = {};
  if (!arg || typeof arg !== 'object') return out;
  for (const [k, v] of Object.entries(arg).slice(0, 12)) {
    if (typeof v === 'string') out[k] = v.slice(0, 2048);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

contextBridge.exposeInMainWorld('starkllmBar', {
  go: (what) => ipcRenderer.send('webbar:go', String(what || '')),
  open: (text, newTab) => ipcRenderer.send('webbar:open', String(text || '').slice(0, 2048), Boolean(newTab)),
  act: (what, arg) => ipcRenderer.send('webbar:act', String(what || '').slice(0, 40), plain(arg)),
  history: (query) => ipcRenderer.invoke('webbar:history', String(query || '').slice(0, 200)),
  onState: (cb) => ipcRenderer.on('webbar:state', (_e, s) => cb(s)),
  onFocus: (cb) => ipcRenderer.on('webbar:focus', (_e, what) => cb(String(what || ''))),
});
