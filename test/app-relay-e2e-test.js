// APP 릴레이 E2E 테스트: 가짜 APP 방송자(kind:'app', slot 미지정 → 슬롯 3 자동 배정)를 ws로 등록하고
// fallback-start + JPEG dataURL frame 전송으로 모니터 #slot3 패널 반영 검증 (헤드리스라 실제 창 캡처 불가)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const { startServer } = require('../server/server');

const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const certDir = path.join(os.tmpdir(), 'phonecam-e2e-cert');

function step(label) {
  console.log(`  OK ${label}`);
}

// JSON 메시지 큐 + 조건 대기 헬퍼가 붙은 WS 클라이언트 (가짜 방송자용)
function createWsClient(url) {
  const ws = new WebSocket(url, { rejectUnauthorized: false });
  const queue = [];
  const waiters = [];

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });

  return {
    ws,
    opened: new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    send(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    // match(msg)가 참인 메시지를 (이미 도착했으면 큐에서) 꺼내 반환
    wait(match, timeoutMs, label) {
      const qi = queue.findIndex(match);
      if (qi >= 0) return Promise.resolve(queue.splice(qi, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${label} 대기 시간 초과 (${timeoutMs}ms)`)),
          timeoutMs,
        );
        waiters.push({ match, resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
      });
    },
  };
}

(async () => {
  const server = await startServer({ certDir, preferredPort: 9666 });
  const origin = `https://127.0.0.1:${server.port}`;
  let browser = null;
  let appCaster = null;
  let frameTimer = null;

  try {
    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: [
        '--ignore-certificate-errors',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });

    // 1. 관제 모니터 열기 → 대기 상태 진입
    const monitorCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const monitor = await monitorCtx.newPage();
    await monitor.goto(`${origin}/monitor`);
    await monitor.waitForFunction(() => {
      const el = document.getElementById('connText');
      const t = el ? el.textContent.trim() : '';
      // 'STANDBY' / 'N FEED(S) LIVE'만 인정 (초기값 'CONNECTING…' 제외)
      return t === 'STANDBY' || /FEEDS? LIVE$/.test(t);
    }, null, { timeout: 15000 });
    step('모니터가 서버에 등록되고 대기 상태 진입');

    // 테스트용 1×1 JPEG dataURL을 브라우저 캔버스로 생성 (Node에는 인코더가 없음)
    const jpeg = await monitor.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 1, 1);
      return c.toDataURL('image/jpeg', 0.9);
    });

    // 2. 가짜 APP 방송자 등록 (slot·name 미지정 → 슬롯 3 + 기본 이름 "APP" 배정 확인)
    appCaster = createWsClient(`wss://127.0.0.1:${server.port}/ws`);
    await appCaster.opened;
    appCaster.send({ type: 'register', role: 'broadcaster', kind: 'app' });
    const reg = await appCaster.wait((m) => m.type === 'registered', 8000, 'registered');
    if (reg.slot !== 3) throw new Error(`APP 방송자 슬롯 배정 오류: ${reg.slot} (기대: 3)`);
    step('APP 방송자(slot 미지정)가 슬롯 3에 자동 배정됨');

    // 3. 모니터 #slot3 패널에 방송자 이름 표시
    await monitor.waitForFunction(() => {
      const name = document.querySelector('#slot3 .feed-name');
      return name && name.textContent.trim() === 'APP';
    }, null, { timeout: 10000 });
    step('모니터 #slot3 패널에 이름 "APP" 표시됨');

    // 4. 보조 모드 프레임 릴레이: fallback-start 후 10fps로 frame 전송
    appCaster.send({ type: 'fallback-start' });
    frameTimer = setInterval(() => appCaster.send({ type: 'frame', jpeg }), 100);

    await monitor.waitForFunction((expected) => {
      const img = document.querySelector('#slot3 img.feed-frame');
      const mode = document.querySelector('#slot3 .feed-mode');
      if (!img || !mode) return false;
      const st = getComputedStyle(img);
      return st.display !== 'none' && st.visibility !== 'hidden' &&
        img.src === expected && img.naturalWidth > 0 &&
        mode.textContent.trim() === 'RELAY';
    }, jpeg, { timeout: 15000 });
    step('전송한 JPEG 프레임이 #slot3 img.feed-frame에 RELAY로 반영됨');

    // 5. 방송자 퇴장 → 슬롯 3이 NO SIGNAL로 복귀
    clearInterval(frameTimer);
    frameTimer = null;
    appCaster.ws.close();
    await monitor.waitForFunction(() => {
      const el = document.querySelector('#slot3 .nosignal');
      if (!el) return false;
      const st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && el.getClientRects().length > 0;
    }, null, { timeout: 10000 });
    step('방송자 퇴장 시 슬롯 3이 NO SIGNAL로 복귀');

    console.log('\nAPP 릴레이 E2E 테스트 통과');
    process.exitCode = 0;
  } catch (err) {
    console.error('\nAPP 릴레이 E2E 테스트 실패:', err.message);
    process.exitCode = 1;
  } finally {
    clearInterval(frameTimer);
    if (appCaster) appCaster.ws.terminate();
    if (browser) await browser.close().catch(() => {});
    await server.close();
    setTimeout(() => process.exit(process.exitCode), 500).unref();
  }
})();
