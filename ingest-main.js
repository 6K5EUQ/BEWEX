// BEWEX Hub: 로컬 UI를 띄우고 선택한 창 캡처(BEWE 슬롯)를 central로 송신하는 얇은 클라이언트.
const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const path = require('path');

// 중앙 서버 주소 (환경변수로 재정의 가능)
const CENTRAL_HOST = process.env.BEWE_CENTRAL || '100.123.59.3';
const CENTRAL_PORT = Number(process.env.BEWE_PORT) || 8443;
const CENTRAL_URL = `https://${CENTRAL_HOST}:${CENTRAL_PORT}/ingest`;

// 두 앱이 같은 package.json name을 공유하면 single-instance lock이 겹치므로 앱별 이름으로 분리한다.
app.setName('bewe-ingest');

// <video>가 사용자 클릭 없이 재생되도록 허용
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Linux 시스템 오디오 loopback 캡처를 위한 Chromium feature 플래그.
// 이게 있어야 getDisplayMedia 오디오 요청 시 PulseAudio/PipeWire 출력 루프백이 잡힌다.
app.commandLine.appendSwitch('enable-features', 'PulseaudioLoopbackForScreenShare');

// X11 세션에서 Electron 33은 창 목록을 PipeWire/xdg-desktop-portal 경로로 열거하려다
// 실패해 desktopCapturer.getSources({types:['window']})가 빈 목록을 돌려주는 회귀가 있다.
// X11에서는 portal 캡처러를 끄고 raw X11 열거로 돌려 창 목록이 채워지게 한다.
// (Wayland 세션에서는 portal 경로가 정상이므로 건드리지 않는다.)
if (process.env.XDG_SESSION_TYPE !== 'wayland') {
  app.commandLine.appendSwitch('disable-features', 'WebRTCPipeWireCapturer');
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

let win = null;
let selectedSourceId = null;
let retryTimer = null;
// 오디오 loopback 모드: true면 다음 getDisplayMedia에 시스템 오디오를 실어 보낸다.
let audioLoopbackMode = false;

const RETRY_MS = 5000;

// central 접속 실패 시 보여줄 대기/재시도 안내 페이지
const RETRY_HTML =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<style>
  html,body{height:100%;margin:0}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;
    background:#111318;color:#e6e8ee;font-family:system-ui,sans-serif;text-align:center;gap:14px}
  .dot{width:12px;height:12px;border-radius:50%;background:#f0a020;animation:blink 1.2s infinite}
  @keyframes blink{0%,100%{opacity:.3}50%{opacity:1}}
  h1{font-size:18px;font-weight:600;margin:0}
  p{font-size:13px;color:#9aa0ad;margin:0}
  code{color:#c7cbd4}
</style></head><body>
  <div class="dot"></div>
  <h1>central 접속 대기 중</h1>
  <p>서버 <code>${CENTRAL_HOST}:${CENTRAL_PORT}</code> 에 연결할 수 없습니다.</p>
  <p>5초마다 자동으로 다시 시도합니다. 서버가 켜지면 자동 접속됩니다.</p>
</body></html>`);

// central 로드 실패 시 안내 페이지 표시 후 5초 뒤 재시도
function scheduleRetry() {
  if (retryTimer || !win) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (win) win.loadURL(CENTRAL_URL).catch(() => {});
  }, RETRY_MS);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    title: 'BEWEX Hub',
    backgroundColor: '#111318',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'ingest-preload.js'),
      // UI(file://)에 central 서버 주소를 전달 → WS/API를 이 주소로 연결
      additionalArguments: [`--bewe-server=${CENTRAL_HOST}:${CENTRAL_PORT}`],
    },
  });
  win.setMenuBarVisibility(false);
  // 로드되는 페이지의 <title>이 창 제목을 덮어쓰지 않도록 고정한다.
  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('closed', () => {
    win = null;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  });

  // central 로드 실패 시 대기 안내 후 자동 재시도
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED: 새 loadURL이 이전 로드를 취소한 경우
    if (!/^https?:/i.test(validatedURL || '')) return; // 로컬 UI(file://) 로드 실패는 무시
    win.loadURL(RETRY_HTML).catch(() => {});
    scheduleRetry();
  });

  // UI는 로컬 소스(public/ingest.html)에서 로드하고, WS/API/시그널링만 central 서버로 붙는다.
  win.loadFile(path.join(__dirname, 'public', 'ingest.html')).catch(() => {});
}

// 락 획득 실패 후에도 whenReady가 실행되므로 초기화 전체를 락 획득 분기 안에 둔다
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 자체 서명 인증서는 central 호스트(+ 로컬 루프백)에만 허용
  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    let allowed = false;
    try {
      const u = new URL(url);
      const host = u.hostname;
      const port = Number(u.port) || 443;
      allowed =
        (host === CENTRAL_HOST || host === '127.0.0.1' || host === 'localhost') &&
        port === CENTRAL_PORT;
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
    // 실행 중인 창 목록 (자기 자신 창 제외)
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

    // 다음 getDisplayMedia가 캡처할 창 id 저장
    ipcMain.handle('ingest:select-source', (e, id) => {
      selectedSourceId = typeof id === 'string' && id ? id : null;
      return true;
    });

    // 오디오 loopback 모드 토글. renderer가 시스템 오디오를 뽑기 직전 enable을 부르고,
    // getDisplayMedia 호출 뒤 곧바로 disable을 불러 원래(창 캡처) 모드로 되돌린다.
    ipcMain.handle('ingest:enable-loopback-audio', () => { audioLoopbackMode = true; return true; });
    ipcMain.handle('ingest:disable-loopback-audio', () => { audioLoopbackMode = false; return true; });

    // getDisplayMedia() 호출 시 캡처 대상 결정. Electron은 핸들러를 등록하지 않으면
    // getDisplayMedia를 거부하므로(Chromium과 달리 기본 picker가 없다) 양쪽 다 등록한다.
    // Wayland/PipeWire: getSources()가 소스를 딱 1개만 돌려주는데, 그 소스를 callback에
    //   넘기면 xdg-desktop-portal picker가 떠서 사용자가 실제 창을 고른다(창별 id 매칭 불가).
    // X11: 앱 자체 목록에서 고른 selectedSourceId로 OS 창 없이 바로 캡처.
    const isWayland = process.env.XDG_SESSION_TYPE === 'wayland';
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      // 오디오 loopback 모드: 시스템 오디오 + 아무 화면 소스(dummy video). renderer가
      // video 트랙은 버리고 audio 트랙만 사용한다.
      if (audioLoopbackMode) {
        desktopCapturer.getSources({ types: ['screen'] })
          .then((sources) => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
          .catch(() => callback({}));
        return;
      }
      if (isWayland) {
        desktopCapturer.getSources({ types: ['window', 'screen'] })
          .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
          .catch(() => callback({}));
        return;
      }
      if (!selectedSourceId) { callback({}); return; }
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
