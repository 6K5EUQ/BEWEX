// Mission Monitor 메인 프로세스.
// 로컬 접속 화면(monitor-connect.html)을 띄우고, 사용자가 지정한 허브 호스트에
// 한해 자체 서명 인증서를 허용한 뒤 https://허브:포트/monitor 를 로드한다.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// 모니터의 <video>가 사용자 클릭 없이도 재생되도록 허용
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
// 사용자가 접속을 지시한 허브 호스트 — 이 호스트(+ 로컬)에 한해서만 인증서 오류 허용
let targetHost = null;

function isLocalHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

// IPC는 로컬 접속 화면(file://)에서 온 요청만 신뢰한다
// (허브가 서빙하는 원격 페이지가 인증서 허용 대상을 바꾸지 못하게 함)
function isTrustedSender(event) {
  try {
    return new URL(event.senderFrame.url).protocol === 'file:';
  } catch (_) {
    return false;
  }
}

function loadConnectPage(query) {
  if (!win) return;
  // loadFile의 상대 경로는 app root 기준이라, 실행 방식과 무관하게 절대 경로 사용
  const page = path.join(__dirname, 'monitor-connect.html');
  win.loadFile(page, query ? { query } : undefined).catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'BEWE Mission Monitor',
    backgroundColor: '#05070a',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'monitor-preload.js'),
    },
  });
  win.setMenuBarVisibility(false);
  win.on('closed', () => { win = null; });

  // 허브 로드 실패(주소 오타, 서버 꺼짐 등) → 접속 화면으로 복귀 + 에러 메시지 전달
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED — 사용자 이동 등 정상 취소
    if (!/^https?:/i.test(validatedURL || '')) return; // 접속 화면 자체의 실패는 무시
    loadConnectPage({
      error: `${errorDescription || 'LOAD FAILED'} (${errorCode})`,
      url: validatedURL || '',
    });
  });

  loadConnectPage();
}

// app.quit()는 비동기라 락 획득 실패 후에도 whenReady가 실행되므로,
// 나머지 초기화 전체를 락 획득 성공 분기 안에 둔다
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 자체 서명 인증서는 사용자가 지정한 허브 호스트(+ 127.0.0.1/localhost)에 한해서만 허용
  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    let allowed = false;
    try {
      const u = new URL(url);
      allowed = isLocalHostname(u.hostname) || (targetHost !== null && u.hostname === targetHost);
    } catch (_) {}
    if (allowed) {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  });

  // 대상 호스트 등록 (인증서 허용 목록)
  ipcMain.handle('monitor:set-target', (event, host) => {
    if (!isTrustedSender(event)) return false;
    const h = String(host || '').trim();
    if (!h) return false;
    targetHost = h;
    return true;
  });

  // set-target 이후 허브의 /monitor 페이지 로드
  ipcMain.handle('monitor:connect', async (event, host, port) => {
    if (!isTrustedSender(event)) throw new Error('허용되지 않은 요청입니다');
    const h = String(host || '').trim();
    const p = Number(port) || 8443;
    if (!/^[A-Za-z0-9.-]+$/.test(h)) throw new Error('잘못된 호스트 형식입니다');
    if (!(p >= 1 && p <= 65535)) throw new Error('잘못된 포트입니다');
    targetHost = h;
    if (!win) return;
    // 로드 실패는 did-fail-load 핸들러가 접속 화면 복귀로 처리한다
    await win.loadURL(`https://${h}:${p}/monitor`).catch(() => {});
  });

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
