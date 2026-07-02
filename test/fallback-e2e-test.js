// 보조 모드 E2E 테스트:
// 휴대폰의 첫 RTCPeerConnection만 ICE를 차단해 WebRTC 연결을 실패시키고
//  (1) 워치독이 보조 모드(JPEG 프레임)로 자동 전환하는지
//  (2) 뷰어를 새로고침하면(재-watch) 두 번째 시도에서 WebRTC로 자동 복귀하는지 검증한다.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const { startServer } = require('../server/server');

const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const certDir = path.join(os.tmpdir(), 'phonecam-e2e-cert');

function step(label) {
  console.log(`  ✓ ${label}`);
}

(async () => {
  const server = await startServer({ certDir, preferredPort: 9600 });
  const origin = `https://127.0.0.1:${server.port}`;
  let browser = null;

  try {
    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: [
        '--ignore-certificate-errors',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });

    const viewerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    let viewer = await viewerCtx.newPage();
    await viewer.goto(`${origin}/viewer`);

    // 휴대폰 컨텍스트: 첫 번째 RTCPeerConnection만 ICE를 완전히 차단
    const phoneCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    await phoneCtx.addInitScript(() => {
      const Orig = window.RTCPeerConnection;
      let count = 0;
      window.RTCPeerConnection = function (...args) {
        count += 1;
        const pc = new Orig(...args);
        if (count === 1) {
          pc.addIceCandidate = () => Promise.resolve(); // 원격 후보 무시
          Object.defineProperty(pc, 'onicecandidate', {  // 자체 후보 유출 차단
            get() { return null; },
            set() {},
          });
        }
        return pc;
      };
    });
    const phone = await phoneCtx.newPage();
    await phone.goto(`${origin}/mobile`);
    await phone.fill('#nameInput', '보조모드폰');
    await phone.click('#startBtn');

    // 1. 워치독(10초) 후 보조 모드 진입 → 휴대폰 상태 표시 확인
    await phone.waitForFunction(
      () => document.getElementById('statusText').textContent.includes('보조 모드'),
      null, { timeout: 25000 },
    );
    step('WebRTC 실패 시 휴대폰이 보조 모드로 자동 전환');

    // 2. 뷰어가 JPEG 프레임을 실제로 렌더링
    await viewer.waitForFunction(() => {
      const img = document.querySelector('.tile img.frame');
      const badge = document.querySelector('.tile .mode-text');
      return img && !img.classList.contains('hidden') &&
        img.src.startsWith('data:image/jpeg') && img.naturalWidth > 0 &&
        badge && badge.textContent === '보조 모드';
    }, null, { timeout: 15000 });
    step('뷰어가 보조 모드 프레임(JPEG)을 실시간 표시');

    // 3. 뷰어 새로고침 → 재-watch → 두 번째 pc는 정상이므로 WebRTC로 자동 복귀
    await viewer.reload();
    await viewer.waitForFunction(() => {
      const v = document.querySelector('.tile video');
      const badge = document.querySelector('.tile .mode-text');
      return v && !v.classList.contains('hidden') && v.videoWidth > 0 &&
        badge && badge.textContent.includes('WebRTC');
    }, null, { timeout: 30000 });
    step('뷰어 재접속 시 보조 모드에서 WebRTC로 자동 복귀');

    await phone.waitForFunction(
      () => document.getElementById('statusText').textContent === '송출 중',
      null, { timeout: 10000 },
    );
    step('휴대폰 상태도 WebRTC 송출로 복귀');

    console.log('\n보조 모드 E2E 테스트 통과 ✅');
    process.exitCode = 0;
  } catch (err) {
    console.error('\n보조 모드 E2E 테스트 실패 ❌:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.close();
    setTimeout(() => process.exit(process.exitCode), 500).unref();
  }
})();
