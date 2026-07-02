// 화면 공유 E2E 테스트:
// 실제 Electron 앱에서 [화면 공유]를 켜고, 외부 기기(LAN IP로 접속하는 Chrome)가
// 잘못된 PIN → 거부, 올바른 PIN → 'PC 화면' 스트림 시청까지 되는지 검증한다.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const path = require('path');
const { chromium, _electron } = require('playwright-core');
const { getLanIPs } = require('../server/server');

const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const PROJECT = path.join(__dirname, '..');

function step(label) {
  console.log(`  ✓ ${label}`);
}

(async () => {
  let app = null;
  let browser = null;
  try {
    // 1. 데스크톱 앱 실행 (내장 서버 자동 기동)
    const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':1' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: path.join(PROJECT, 'node_modules', '.bin', 'electron'),
      args: [PROJECT],
      env,
    });
    const win = await app.firstWindow();
    await win.waitForFunction(
      () => document.getElementById('connText').textContent.includes('대기 중'),
      null, { timeout: 20000 },
    );
    const port = new URL(win.url()).port;
    const pin = await win.locator('#pinText').textContent();
    if (!/^\d{6}$/.test(pin)) throw new Error(`PIN이 표시되지 않음: "${pin}"`);
    step(`데스크톱 앱 기동, 시청 PIN 표시됨 (포트 ${port})`);

    // 2. 화면 공유 시작
    await win.click('#shareBtn');
    await win.waitForFunction(
      () => document.getElementById('shareBtn').textContent.includes('공유 중지'),
      null, { timeout: 10000 },
    );
    step('화면 공유 시작됨 (getDisplayMedia 성공)');

    // 자기 화면은 자기 그리드에 나오지 않아야 함
    await win.waitForTimeout(1500);
    const selfTiles = await win.locator('.tile').count();
    if (selfTiles !== 0) throw new Error(`데스크톱 앱에 자기 화면 타일이 생김 (${selfTiles}개)`);
    step('내 화면 공유가 내 그리드에는 표시되지 않음');

    // 3. 외부 기기 시뮬레이션: LAN IP로 접속 (localhost가 아니므로 PIN 게이트)
    const lanIp = getLanIPs()[0];
    if (!lanIp) throw new Error('LAN IP 없음');
    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'],
    });
    const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
    await page.goto(`https://${lanIp}:${port}/viewer`);
    await page.waitForSelector('#pinGate:not(.hidden)', { timeout: 10000 });
    step('외부 접속 시 PIN 입력 게이트 표시됨');

    // 4. 잘못된 PIN → 거부
    const wrongPin = pin === '000000' ? '111111' : '000000';
    await page.fill('#pinInput', wrongPin);
    await page.click('#pinBtn');
    await page.waitForFunction(
      () => document.getElementById('pinMsg').textContent.includes('올바르지'),
      null, { timeout: 8000 },
    );
    step('잘못된 PIN은 거부됨');

    // 5. 올바른 PIN → 'PC 화면' 스트림 시청
    await page.fill('#pinInput', pin);
    await page.click('#pinBtn');
    await page.waitForFunction(() => {
      const tile = document.querySelector('.tile');
      if (!tile) return false;
      const v = tile.querySelector('video');
      const name = tile.querySelector('.name');
      return v && v.videoWidth > 0 && !v.paused && name && name.textContent === 'PC 화면';
    }, null, { timeout: 25000 });
    step('올바른 PIN으로 PC 화면 스트림 실시간 시청 (videoWidth > 0)');

    // 6. 공유 중지 → 외부 기기에서 타일 제거
    await win.click('#shareBtn');
    await page.waitForFunction(
      () => document.querySelectorAll('.tile').length === 0,
      null, { timeout: 10000 },
    );
    step('공유 중지 시 외부 기기 화면에서 타일 제거');

    console.log('\n화면 공유 E2E 테스트 통과 ✅');
    process.exitCode = 0;
  } catch (err) {
    console.error('\n화면 공유 E2E 테스트 실패 ❌:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (app) await app.close().catch(() => {});
    setTimeout(() => process.exit(process.exitCode), 500).unref();
  }
})();
