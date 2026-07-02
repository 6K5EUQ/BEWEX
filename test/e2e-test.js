// E2E 테스트: 실제 Chrome 두 컨텍스트(가짜 카메라 휴대폰 / 뷰어)로
// 방송 시작 → WebRTC 연결 → 뷰어에 영상 프레임 도착 → 방송 종료까지 검증한다.
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

    // 1. 뷰어 열기 (localhost라 토큰을 받아 시청 가능)
    const viewerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const viewer = await viewerCtx.newPage();
    await viewer.goto(`${origin}/viewer`);
    await viewer.waitForFunction(
      () => document.getElementById('connText').textContent.includes('대기 중'),
      null, { timeout: 10000 },
    );
    step('뷰어가 서버에 등록되고 대기 상태 진입');

    // QR/주소 표기 확인
    const addr = await viewer.locator('#addrBig').textContent();
    if (!addr.startsWith('https://')) throw new Error('접속 주소가 표시되지 않음');
    const qrSrc = await viewer.locator('#qrImg').getAttribute('src');
    if (!qrSrc || !qrSrc.startsWith('data:image/png')) throw new Error('QR 코드가 표시되지 않음');
    step('QR 코드와 접속 주소 표시됨');

    // 2. 휴대폰(가짜 카메라) 접속 → 방송 시작
    const phoneCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const phone = await phoneCtx.newPage();
    await phone.goto(`${origin}/mobile`);
    await phone.fill('#nameInput', 'E2E폰');
    await phone.click('#startBtn');
    await phone.waitForFunction(
      () => document.getElementById('statusText').textContent.includes('송출 중'),
      null, { timeout: 15000 },
    );
    step('휴대폰이 카메라를 열고 송출 시작');

    // 3. 뷰어에 타일 생성 + 영상 프레임 도착 (videoWidth > 0 = 실제 디코딩됨)
    await viewer.waitForSelector('.tile', { timeout: 10000 });
    step('뷰어에 스트림 타일 생성됨');

    await viewer.waitForFunction(() => {
      const v = document.querySelector('.tile video');
      return v && v.videoWidth > 0 && !v.paused;
    }, null, { timeout: 20000 });
    step('WebRTC 영상이 뷰어에서 실제 재생됨 (videoWidth > 0)');

    const tileName = await viewer.locator('.tile .name').textContent();
    if (tileName !== 'E2E폰') throw new Error(`타일 이름 불일치: ${tileName}`);
    step('카메라 이름이 타일에 표시됨');

    // 4. 방송 종료 → 뷰어에서 타일 제거, 대기 화면 복귀
    await phone.click('#stopBtn');
    await viewer.waitForFunction(
      () => document.querySelectorAll('.tile').length === 0 &&
            !document.getElementById('emptyState').classList.contains('hidden'),
      null, { timeout: 10000 },
    );
    step('방송 종료 시 뷰어가 대기 화면으로 복귀');

    console.log('\nE2E 테스트 통과 ✅');
    process.exitCode = 0;
  } catch (err) {
    console.error('\nE2E 테스트 실패 ❌:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.close();
    setTimeout(() => process.exit(process.exitCode), 500).unref();
  }
})();
