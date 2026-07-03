const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ingestAPI', {
  isWayland: process.env.XDG_SESSION_TYPE === 'wayland',
  listWindows: () => ipcRenderer.invoke('ingest:list-windows'),
  selectSource: (id) => ipcRenderer.invoke('ingest:select-source', id),
});
