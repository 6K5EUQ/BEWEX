// 접속 화면(monitor-connect.html)에서 쓰는 최소 브리지
const { contextBridge, ipcRenderer } = require('electron');

// main이 additionalArguments로 넘긴 central 서버 주소 (--bewe-server=host:port)
function readServer() {
  const arg = process.argv.find((a) => a.startsWith('--bewe-server='));
  if (!arg) return null;
  const [host, port] = arg.slice('--bewe-server='.length).split(':');
  return { host, port: Number(port) };
}

// UI(monitor.html)가 file://로 떠도 WS/API 대상을 알 수 있도록 서버 주소를 노출한다.
contextBridge.exposeInMainWorld('__BEWE__', readServer() || {});

contextBridge.exposeInMainWorld('monitorAPI', {
  connect: async (host, port) => {
    await ipcRenderer.invoke('monitor:set-target', host);
    await ipcRenderer.invoke('monitor:connect', host, port);
  },
});
