const { contextBridge, ipcRenderer } = require('electron');

// main이 additionalArguments로 넘긴 central 서버 주소 (--bewe-server=host:port)
function readServer() {
  const arg = process.argv.find((a) => a.startsWith('--bewe-server='));
  if (!arg) return null;
  const [host, port] = arg.slice('--bewe-server='.length).split(':');
  return { host, port: Number(port) };
}

// UI(ingest.html)가 file://로 떠도 WS/API 대상을 알 수 있도록 서버 주소를 노출한다.
contextBridge.exposeInMainWorld('__BEWE__', readServer() || {});

contextBridge.exposeInMainWorld('ingestAPI', {
  isWayland: process.env.XDG_SESSION_TYPE === 'wayland',
  listWindows: () => ipcRenderer.invoke('ingest:list-windows'),
  selectSource: (id) => ipcRenderer.invoke('ingest:select-source', id),
  enableLoopbackAudio: () => ipcRenderer.invoke('ingest:enable-loopback-audio'),
  disableLoopbackAudio: () => ipcRenderer.invoke('ingest:disable-loopback-audio'),
});
