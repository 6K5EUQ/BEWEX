// Electron 메인 프로세스: 내장 서버를 켜고 뷰어 창을 띄운다.
const { app, BrowserWindow, desktopCapturer, dialog, session } = require('electron');
const path = require('path');
const { startServer } = require('./server/server');

// 뷰어의 <video>가 사용자 클릭 없이도 소리와 함께 재생되도록 허용
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let serverInfo = null;

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
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'PhoneCam Viewer',
    backgroundColor: '#111318',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.on('closed', () => { win = null; });

  await win.loadURL(`https://127.0.0.1:${serverInfo.port}/viewer`);
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
    // 뷰어 페이지의 화면 공유(getDisplayMedia) 요청 시 주 화면을 캡처해 준다
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] })
        .then((sources) => callback(sources.length ? { video: sources[0] } : {}))
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
