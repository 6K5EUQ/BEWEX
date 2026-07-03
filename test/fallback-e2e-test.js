// 보조 모드 E2E 테스트:
// 휴대폰의 첫 RTCPeerConnection만 ICE를 차단해 WebRTC 연결을 실패시키고
//  (1) 워치독이 보조 모드(JPEG 프레임 릴레이)로 자동 전환해 모니터 #slot1에 표시되는지
//  (2) 모니터를 새로고침하면(재-watch) 두 번째 시도에서 WebRTC로 자동 복귀하는지 검증한다.
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

    const monitorCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const monitor = await monitorCtx.newPage();
    await monitor.goto(`${origin}/monitor`);

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

    // 2. 모니터 #slot1이 JPEG 프레임을 RELAY 모드로 실제 렌더링
    //    (카메라 slot 미지정 → 서버가 슬롯 1 자동 배정)
    await monitor.waitForFunction(() => {
      const img = document.querySelector('#slot1 img.feed-frame');
      const mode = document.querySelector('#slot1 .feed-mode');
      if (!img || !mode) return false;
      const st = getComputedStyle(img);
      return st.display !== 'none' && st.visibility !== 'hidden' &&
        img.src.startsWith('data:image/jpeg') && img.naturalWidth > 0 &&
        mode.textContent.trim() === 'RELAY';
    }, null, { timeout: 15000 });
    step('모니터가 보조 모드 프레임(JPEG)을 #slot1에 RELAY로 표시');

    // 3. 모니터 새로고침 → 재-watch → 두 번째 pc는 정상이므로 WebRTC로 자동 복귀
    await monitor.reload();
    await monitor.waitForFunction(() => {
      const v = document.querySelector('#slot1 video.feed-video');
      const mode = document.querySelector('#slot1 .feed-mode');
      return v && v.videoWidth > 0 &&
        mode && mode.textContent.trim() === 'WebRTC';
    }, null, { timeout: 30000 });
    step('모니터 재접속 시 보조 모드에서 WebRTC로 자동 복귀');

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
