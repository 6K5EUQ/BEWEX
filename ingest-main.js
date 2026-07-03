// Ingest Hub 메인 프로세스: 내장 서버를 켜고 연결 허브 UI 창을 띄운다.
// 창 캡처(APP 슬롯)를 위해 desktopCapturer 창 목록/선택 IPC를 제공한다.
const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session } = require('electron');
const path = require('path');
const { startServer } = require('./server/server');

// 허브 페이지의 <video>가 사용자 클릭 없이도 재생되도록 허용
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let serverInfo = null;
let selectedSourceId = null; // 렌더러가 '창 선택'으로 고른 desktopCapturer 소스 id

async function createWindow() {
  // activate(macOS Dock 클릭) 등으로 재호출돼도 서버는 한 번만 기동
  if (!serverInfo) {
    try {
      serverInfo = await startServer({
        certDir: path.join(app.getPath('userData'), 'cert'),
      });
    } catch (err) {
      dialog.showErrorBox('서버 시작 실패', `내장 서버를 시작할 수 없습니다.\n\n${err.message}`);
      app.quit();
      return;
    }
  }

  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    title: 'BEWE Ingest Hub',
    backgroundColor: '#111318',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'ingest-preload.js'),
    },
  });
  win.setMenuBarVisibility(false);
  win.on('closed', () => { win = null; });

  await win.loadURL(`https://127.0.0.1:${serverInfo.port}/ingest`);
}

// app.quit()는 비동기라 락 획득 실패 후에도 whenReady가 실행되므로,
// 나머지 초기화 전체를 락 획득 성공 분기 안에 둔다 (두 번째 인스턴스의 서버 기동 방지)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 자체 서명 인증서는 우리 내장 서버(localhost:포트)에 한해서만 허용
  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    let allowed = false;
    try {
      const u = new URL(url);
      allowed =
        serverInfo !== null &&
        (u.hostname === '127.0.0.1' || u.hostname === 'localhost') &&
        Number(u.port) === serverInfo.port;
    } catch (_) {}
    if (allowed) {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  });

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // 실행 중인 창 목록 (자기 자신 = Ingest Hub 창은 제외) — 렌더러의 '창 선택' 그리드용
    ipcMain.handle('ingest:list-windows', async () => {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 320, height: 180 },
      });
      let selfId = null;
      try { selfId = win ? win.getMediaSourceId() : null; } catch (_) {}
      return sources
        .filter((s) => s.id !== selfId)
        .map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
    });

    // 다음 getDisplayMedia 요청이 캡처할 창 id 저장
    ipcMain.handle('ingest:select-source', (e, id) => {
      selectedSourceId = typeof id === 'string' && id ? id : null;
      return true;
    });

    // 렌더러의 getDisplayMedia 요청 → 저장된 id의 창을 재조회해 넘겨준다.
    // 창이 이미 닫혀 목록에 없으면 빈 응답 → 렌더러의 getDisplayMedia가 reject된다.
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      if (!selectedSourceId) {
        callback({});
        return;
      }
      desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const source = sources.find((s) => s.id === selectedSourceId);
          callback(source ? { video: source } : {});
        })
        .catch(() => callback({}));
    });

    createWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
