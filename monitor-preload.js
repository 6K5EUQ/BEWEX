// 접속 화면(monitor-connect.html)에서 쓰는 최소 브리지
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitorAPI', {
  connect: async (host, port) => {
    await ipcRenderer.invoke('monitor:set-target', host);
    await ipcRenderer.invoke('monitor:connect', host, port);
  },
});
