// Ingest Hub 렌더러에 창 캡처 IPC를 노출하는 preload.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ingestAPI', {
  // 실행 중인 창 목록: [{id, name, thumbnail(dataURL)}] (Ingest Hub 자신은 제외)
  listWindows: () => ipcRenderer.invoke('ingest:list-windows'),
  // 다음 getDisplayMedia가 캡처할 창 id 지정
  selectSource: (id) => ipcRenderer.invoke('ingest:select-source', id),
});
