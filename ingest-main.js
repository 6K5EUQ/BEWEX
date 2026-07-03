// Ingest Hub 메인 프로세스: 중앙 서버(라즈베리파이)의 /ingest 페이지를 띄우는 얇은 클라이언트.
// v3 구조: 서버는 더 이상 이 앱이 켜지 않는다. central(raspb2-central, Tailscale IP)에서 headless로 상시 구동되고,
// 이 앱은 어떤 PC에서 실행하든 central로 붙어 창 캡처(APP 슬롯) 영상을 송신한다.
// 창 캡처를 위해 desktopCapturer 창 목록/선택 IPC와 getDisplayMedia 핸들러를 제공한다.
const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const path = require('path');

// 중앙 서버 주소 (환경변수로 재정의 가능). 브라우저 페이지는 central이 직접 서빙하므로 여기서만 지정한다.
const CENTRAL_HOST = process.env.BEWE_CENTRAL || '100.123.59.3';
const CENTRAL_PORT = Number(process.env.BEWE_PORT) || 8443;
const CENTRAL_URL = `https://${CENTRAL_HOST}:${CENTRAL_PORT}/ingest`;

// 허브 페이지의 <video>가 사용자 클릭 없이도 재생되도록 허용
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let selectedSourceId = null; // 렌더러가 '창 선택'으로 고른 desktopCapturer 소스 id
let retryTimer = null; // central 로드 실패 시 재시도 타이머

const RETRY_MS = 5000;

// central 접속 실패 시 창에 띄우는 간단한 대기/재시도 안내 페이지 (서버가 켜지면 자동으로 다시 붙는다)
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

// central 로드 실패 시: 안내 페이지를 보여준 뒤 5초 후 재시도. 서버가 복구되면 그때 로드가 성공한다.
function scheduleRetry() {
  if (retryTimer || !win) return; // 이미 예약됐거나 창이 없으면 스킵
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (win) win.loadURL(CENTRAL_URL).catch(() => {}); // 실패는 did-fail-load에서 다시 잡는다
  }, RETRY_MS);
}

function createWindow() {
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
  win.on('closed', () => {
    win = null;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  });

  // central 로드 실패(서버 꺼짐/네트워크 단절) 시 대기 안내 후 자동 재시도
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED: 새 loadURL이 이전 로드를 취소한 경우 — 재시도 불필요
    win.loadURL(RETRY_HTML).catch(() => {}); // 대기 안내 표시 (data URL이라 항상 성공)
    scheduleRetry();
  });

  win.loadURL(CENTRAL_URL).catch(() => {}); // 실패는 did-fail-load에서 처리
}

// app.quit()는 비동기라 락 획득 실패 후에도 whenReady가 실행되므로,
// 나머지 초기화 전체를 락 획득 성공 분기 안에 둔다 (두 번째 인스턴스 방지)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 자체 서명 인증서는 central 호스트(+ 로컬 루프백)에 한해서만 허용
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
