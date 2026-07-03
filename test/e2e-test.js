// E2E 테스트: /mobile?slot=1 방송 → WebRTC 연결 → 모니터 #slot1 영상 프레임 도착 → 방송 종료까지 검증 (Chrome 2 컨텍스트)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const { startServer } = require('../server/server');

const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const certDir = path.join(os.tmpdir(), 'phonecam-e2e-cert');

function step(label) {
  console.log(`  OK ${label}`);
}

// 모니터 WS 등록 완료 대기: 'STANDBY' / 'N FEED(S) LIVE'만 인정 (초기값 'CONNECTING…' 제외)
function waitMonitorReady(page) {
  return page.waitForFunction(() => {
    const el = document.getElementById('connText');
    const t = el ? el.textContent.trim() : '';
    return t === 'STANDBY' || /FEEDS? LIVE$/.test(t);
  }, null, { timeout: 15000 });
}

(async () => {
  const server = await startServer({ certDir, preferredPort: 9555 });
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

    // 1. 관제 모니터 열기 (인증 없음 — 바로 뷰어 등록)
    const monitorCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const monitor = await monitorCtx.newPage();
    await monitor.goto(`${origin}/monitor`);
    await waitMonitorReady(monitor);
    step('모니터가 서버에 등록되고 대기 상태 진입');

    // 빈 슬롯에는 NO SIGNAL 표시
    await monitor.waitForFunction(() => {
      const el = document.querySelector('#slot1 .nosignal');
      if (!el) return false;
      const st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && el.getClientRects().length > 0;
    }, null, { timeout: 10000 });
    step('빈 슬롯 1에 NO SIGNAL 표시됨');

    // 2. 휴대폰(가짜 카메라) 슬롯 1로 접속 → 방송 시작
    const phoneCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const phone = await phoneCtx.newPage();
    await phone.goto(`${origin}/mobile?slot=1`);
    await phone.fill('#nameInput', 'E2E폰');
    await phone.click('#startBtn');
    await phone.waitForFunction(
      () => document.getElementById('statusText').textContent.includes('송출 중'),
      null, { timeout: 15000 },
    );
    step('휴대폰이 카메라를 열고 슬롯 1로 송출 시작');

    // 3. 모니터 #slot1 패널에 영상 프레임 도착 (videoWidth > 0 = 실제 디코딩됨)
    await monitor.waitForFunction(() => {
      const v = document.querySelector('#slot1 video.feed-video');
      return v && v.videoWidth > 0 && !v.paused;
    }, null, { timeout: 20000 });
    step('WebRTC 영상이 모니터 #slot1에서 실제 재생됨 (videoWidth > 0)');

    const feedName = await monitor.locator('#slot1 .feed-name').textContent();
    if (feedName.trim() !== 'E2E폰') throw new Error(`피드 이름 불일치: ${feedName}`);
    step('카메라 이름이 #slot1 패널에 표시됨');

    // 4. 방송 종료 → 슬롯 1이 NO SIGNAL로 복귀
    await phone.click('#stopBtn');
    await monitor.waitForFunction(() => {
      const el = document.querySelector('#slot1 .nosignal');
      if (!el) return false;
      const st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && el.getClientRects().length > 0;
    }, null, { timeout: 10000 });
    step('방송 종료 시 슬롯 1이 NO SIGNAL로 복귀');

    console.log('\nE2E 테스트 통과');
    process.exitCode = 0;
  } catch (err) {
    console.error('\nE2E 테스트 실패:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.close();
    setTimeout(() => process.exit(process.exitCode), 500).unref();
  }
})();
