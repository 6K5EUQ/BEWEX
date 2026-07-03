const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ingestAPI', {
  listWindows: () => ipcRenderer.invoke('ingest:list-windows'),
  selectSource: (id) => ipcRenderer.invoke('ingest:select-source', id),
});
