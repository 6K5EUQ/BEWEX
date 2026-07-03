// Mission Monitor: 시작 시 곧바로 central의 /monitor 를 로드하고, 실패 시 접속 화면으로 폴백해 5초마다 재시도한다.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// 중앙 서버 주소 (환경변수로 재정의 가능)
const CENTRAL_HOST = process.env.BEWE_CENTRAL || '100.123.59.3';
const CENTRAL_PORT = Number(process.env.BEWE_PORT) || 8443;

// 두 앱이 같은 package.json name을 공유하면 single-instance lock이 겹치므로 앱별 이름으로 분리한다.
app.setName('bewe-monitor');

// <video>가 사용자 클릭 없이 재생되도록 허용
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
// 현재 접속 대상 호스트/포트 — 이 호스트(+ 로컬)에 한해서만 인증서 오류 허용
let targetHost = CENTRAL_HOST;
let targetPort = CENTRAL_PORT;
let retryTimer = null;

function isLocalHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

// IPC는 로컬 접속 화면(file://)에서 온 요청만 신뢰 (원격 페이지가 인증서 허용 대상을 못 바꾸게 함)
function isTrustedSender(event) {
  try {
    return new URL(event.senderFrame.url).protocol === 'file:';
  } catch (_) {
    return false;
  }
}

function loadConnectPage(query) {
  if (!win) return;
  // loadFile 상대 경로는 app root 기준이라 절대 경로 사용
  const page = path.join(__dirname, 'monitor-connect.html');
  win.loadFile(page, query ? { query } : undefined).catch(() => {});
}

// 대상 호스트/포트의 /monitor 로드 (대기 중인 자동 재시도는 취소)
function loadMonitor(host, port) {
  if (!win) return;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  targetHost = host;
  targetPort = port;
  win.loadURL(`https://${host}:${port}/monitor`).catch(() => {});
}

// UI는 로컬 소스(public/monitor.html)에서 로드하고, WS/시그널링만 central 서버로 붙는다.
// central 주소는 preload가 additionalArguments로 받아 window.__BEWE__ 로 노출한다.
function loadLocalMonitor() {
  if (!win) return;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  win.loadFile(path.join(__dirname, 'public', 'monitor.html')).catch(() => {});
}

// 로드 실패 후 5초 뒤 현재 대상으로 재접속
function scheduleRetry() {
  if (retryTimer || !win) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    loadMonitor(targetHost, targetPort);
  }, 5000);
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
      // UI(file://)에 central 서버 주소를 전달 → WS를 이 주소로 연결
      additionalArguments: [`--bewe-server=${targetHost}:${targetPort}`],
    },
  });
  win.setMenuBarVisibility(false);
  win.on('closed', () => { win = null; });

  // 로드 실패 시 접속 화면으로 폴백 + 5초마다 자동 재시도
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED: 정상 취소
    if (!/^https?:/i.test(validatedURL || '')) return; // 접속 화면 자체의 실패는 무시
    loadConnectPage({
      error: `${errorDescription || 'LOAD FAILED'} (${errorCode})`,
      url: validatedURL || '',
      retry: '1',
    });
    scheduleRetry();
  });

  // 시작 시 로컬 UI를 곧바로 로드 (WS만 central 로 접속)
  loadLocalMonitor();
}

// 락 획득 실패 후에도 whenReady가 실행되므로 초기화 전체를 락 획득 분기 안에 둔다
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 자체 서명 인증서는 대상 호스트(+ 127.0.0.1/localhost)에만 허용
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
    if (!win) return;
    loadMonitor(h, p);
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
