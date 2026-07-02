// 시그널링 서버 통합 테스트: 가짜 휴대폰/뷰어 WebSocket 클라이언트로
// 등록 → 중계(watch/offer/answer/ice) → 보조 모드(frame) → 퇴장 흐름을 검증한다.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const https = require('https');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { startServer } = require('../server/server');

const certDir = path.join(os.tmpdir(), 'phonecam-test-cert');

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

class TestClient {
  constructor(url) {
    this.ws = new WebSocket(url, { rejectUnauthorized: false });
    this.queue = [];
    this.waiters = [];
    this.closed = null;
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data);
      const i = this.waiters.findIndex((w) => w.type === msg.type);
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
      else this.queue.push(msg);
    });
    this.ws.on('close', (code) => { this.closed = code; });
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  waitFor(type, ms = 4000) {
    const i = this.queue.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for '${type}'`)), ms);
      this.waiters.push({ type, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }
  waitClose(ms = 4000) {
    if (this.closed !== null) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for close')), ms);
      this.ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
    });
  }
}

function assert(cond, label) {
  if (!cond) throw new Error(`검증 실패: ${label}`);
  console.log(`  ✓ ${label}`);
}

(async () => {
  console.log('서버 시작...');
  const server = await startServer({ certDir, preferredPort: 9443 });
  const base = `wss://127.0.0.1:${server.port}/ws`;

  try {
    // 1. /api/info — localhost에는 토큰 포함
    const info = await getJSON(`https://127.0.0.1:${server.port}/api/info`);
    assert(typeof info.viewerToken === 'string' && info.viewerToken.length === 32, 'localhost /api/info에 뷰어 토큰 포함');
    assert(info.mobileUrl.startsWith('https://'), 'mobileUrl은 https 주소');
    assert(info.qr.startsWith('data:image/png'), 'QR 코드 데이터 생성됨');

    // 2. 잘못된 토큰의 뷰어는 거부
    const badViewer = new TestClient(base);
    await badViewer.open();
    badViewer.send({ type: 'register', role: 'viewer', token: 'wrong' });
    assert((await badViewer.waitClose()) === 4001, '잘못된 토큰 뷰어는 4001로 종료');

    // 3. 정상 뷰어 등록
    const viewer = new TestClient(base);
    await viewer.open();
    viewer.send({ type: 'register', role: 'viewer', token: info.viewerToken });
    const vReg = await viewer.waitFor('registered');
    assert(Array.isArray(vReg.broadcasters) && vReg.broadcasters.length === 0, '뷰어 등록 시 방송자 목록(빈 배열) 수신');

    // 4. 방송자 등록 → 뷰어에게 broadcaster-joined
    const phone = new TestClient(base);
    await phone.open();
    phone.send({ type: 'register', role: 'broadcaster', name: '테스트폰' });
    const bReg = await phone.waitFor('registered');
    const joined = await viewer.waitFor('broadcaster-joined');
    assert(joined.id === bReg.id && joined.name === '테스트폰', '뷰어가 broadcaster-joined 수신');

    // 5. watch → offer → answer → ice 중계
    viewer.send({ type: 'watch', target: bReg.id });
    const watch = await phone.waitFor('watch');
    assert(watch.from === vReg.id, '방송자가 watch 수신 (from=뷰어 id)');

    phone.send({ type: 'offer', target: vReg.id, sdp: { type: 'offer', sdp: 'x' } });
    const offer = await viewer.waitFor('offer');
    assert(offer.from === bReg.id && offer.sdp.type === 'offer', '뷰어가 offer 수신');

    viewer.send({ type: 'answer', target: bReg.id, sdp: { type: 'answer', sdp: 'y' } });
    const answer = await phone.waitFor('answer');
    assert(answer.from === vReg.id && answer.sdp.type === 'answer', '방송자가 answer 수신');

    phone.send({ type: 'ice', target: vReg.id, candidate: { candidate: 'c1' } });
    const ice1 = await viewer.waitFor('ice');
    assert(ice1.from === bReg.id && ice1.candidate.candidate === 'c1', '뷰어가 ICE 수신');

    viewer.send({ type: 'ice', target: bReg.id, candidate: { candidate: 'c2' } });
    const ice2 = await phone.waitFor('ice');
    assert(ice2.from === vReg.id && ice2.candidate.candidate === 'c2', '방송자가 ICE 수신');

    // 6. 보조 모드: fallback-start와 frame이 뷰어에게 전달
    phone.send({ type: 'fallback-start' });
    const fb = await viewer.waitFor('fallback-start');
    assert(fb.from === bReg.id, '뷰어가 fallback-start 수신');

    phone.send({ type: 'frame', jpeg: 'data:image/jpeg;base64,AAAA' });
    const frame = await viewer.waitFor('frame');
    assert(frame.from === bReg.id && frame.jpeg.startsWith('data:image/jpeg'), '뷰어가 frame 수신');

    // 7. 늦게 들어온 뷰어는 fallback 상태 포함 목록 수신
    const viewer2 = new TestClient(base);
    await viewer2.open();
    viewer2.send({ type: 'register', role: 'viewer', token: info.viewerToken });
    const v2Reg = await viewer2.waitFor('registered');
    assert(v2Reg.broadcasters.length === 1 && v2Reg.broadcasters[0].fallback === true, '늦게 등록한 뷰어가 fallback=true 목록 수신');

    // 8. 방송자 퇴장 → 뷰어에게 broadcaster-left
    phone.ws.close();
    const left = await viewer.waitFor('broadcaster-left');
    assert(left.id === bReg.id, '뷰어가 broadcaster-left 수신');

    console.log('\n모든 시그널링 테스트 통과 ✅');
    process.exitCode = 0;
  } catch (err) {
    console.error('\n테스트 실패 ❌:', err.message);
    process.exitCode = 1;
  } finally {
    await server.close();
    setTimeout(() => process.exit(process.exitCode), 300).unref();
  }
})();
