// 접속 화면(monitor-connect.html)에서 쓰는 최소 브리지.
// connect(host, port): 메인 프로세스가 인증서 허용 대상(set-target)을 등록한 뒤
// https://host:port/monitor 를 로드한다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitorAPI', {
  connect: async (host, port) => {
    await ipcRenderer.invoke('monitor:set-target', host);
    await ipcRenderer.invoke('monitor:connect', host, port);
  },
});
