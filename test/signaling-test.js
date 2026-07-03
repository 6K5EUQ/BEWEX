// 시그널링 서버 v2 통합 테스트: 등록/슬롯 배정/observer/viewer-count/중계/보조 모드/퇴장/인증서 SAN 검증
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { X509Certificate } = require('crypto');
const WebSocket = require('ws');
const { startServer } = require('../server/server');
const { loadOrCreateCert } = require('../server/cert');

const certDir = path.join(os.tmpdir(), 'bewe-streaming-test-cert');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) { /* redirect 등 비 JSON 응답 */ }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    }).on('error', reject);
  });
}

class TestClient {
  constructor(url) {
    this.ws = new WebSocket(url, { rejectUnauthorized: false });
    this.queue = [];
    this.all = []; // 수신 순서 검증용 전체 기록
    this.waiters = [];
    this.closed = null;
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data);
      this.all.push(msg);
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
  console.log(`  OK ${label}`);
}

(async () => {
  // 0. cert.js — SAN 커버리지 검사 (IP가 늘어나면 유효기간 남아도 재생성)
  console.log('인증서 SAN 커버리지 검사...');
  const sanDir = path.join(os.tmpdir(), `bewe-cert-san-test-${Date.now()}`);
  try {
    const certA = loadOrCreateCert(sanDir, ['192.0.2.1']);
    const certB = loadOrCreateCert(sanDir, ['192.0.2.1']);
    assert(certA.cert === certB.cert, '같은 IP 목록이면 기존 인증서 재사용');
    const certC = loadOrCreateCert(sanDir, ['192.0.2.1', '192.0.2.9']);
    assert(certC.cert !== certA.cert, 'SAN에 없는 IP가 생기면 인증서 재생성');
    const sanText = String(new X509Certificate(certC.cert).subjectAltName || '');
    assert(sanText.includes('192.0.2.9'), '재생성된 인증서 SAN에 새 IP 포함');
  } finally {
    fs.rmSync(sanDir, { recursive: true, force: true });
  }

  console.log('서버 시작...');
  const server = await startServer({ certDir, preferredPort: 9443 });
  const base = `wss://127.0.0.1:${server.port}/ws`;
  const httpBase = `https://127.0.0.1:${server.port}`;

  try {
    // 1. /api/info — 토큰·PIN 없음, ips 배열
    const info = (await httpGet(`${httpBase}/api/info`)).json;
    assert(info.viewerToken === undefined && info.watchPin === undefined, '/api/info에 토큰·PIN 없음 (구 v1 필드 회귀 검증)');
    assert(Array.isArray(info.ips), '/api/info에 ips 배열 포함');
    assert(info.port === server.port, '/api/info의 port 일치');

    // 1-2. 구버전 호환: /viewer → /monitor 301
    const redir = await httpGet(`${httpBase}/viewer`);
    assert(redir.status === 301 && redir.headers.location === '/monitor', '/viewer는 /monitor로 301 redirect');

    // 2. /api/qr — slot 파라미터
    if (server.ips.length > 0) {
      const ip = server.ips[0];
      const qrSlot = (await httpGet(`${httpBase}/api/qr?ip=${ip}&slot=1`)).json;
      assert(qrSlot.qr.startsWith('data:image/png'), '/api/qr slot=1 QR 생성');
      const qrPlain = (await httpGet(`${httpBase}/api/qr?ip=${ip}`)).json;
      assert(qrPlain.qr.startsWith('data:image/png'), '/api/qr slot 생략 QR 생성');
      assert(qrSlot.qr !== qrPlain.qr, 'slot 유무에 따라 QR 내용이 다름');
    } else {
      console.log('  - (LAN IP 없음: /api/qr 생성 검증 생략)');
    }
    const badQr = await httpGet(`${httpBase}/api/qr?ip=203.0.113.9`);
    assert(badQr.status === 400, '/api/qr 알 수 없는 ip는 400');

    // 3+4. observer 등록 — 무인증, viewer-count에 미포함
    const observer = new TestClient(base);
    await observer.open();
    observer.send({ type: 'register', role: 'viewer', observer: true });
    const oReg = await observer.waitFor('registered');
    assert(Array.isArray(oReg.broadcasters) && oReg.broadcasters.length === 0, 'observer 무인증 등록 + 빈 방송자 목록');
    const oCount0 = await observer.waitFor('viewer-count');
    assert(oCount0.count === 0, 'observer는 viewer-count에 미포함 (count=0)');

    // 일반 뷰어 무인증 등록
    const viewer = new TestClient(base);
    await viewer.open();
    viewer.send({ type: 'register', role: 'viewer' });
    const vReg = await viewer.waitFor('registered');
    assert(Array.isArray(vReg.broadcasters) && vReg.broadcasters.length === 0, '뷰어 무인증 등록 + 빈 방송자 목록');
    const oCount1 = await observer.waitFor('viewer-count');
    assert(oCount1.count === 1, '일반 뷰어 등록 시 viewer-count=1 통지');
    const vCount1 = await viewer.waitFor('viewer-count');
    assert(vCount1.count === 1, '새 뷰어 본인도 viewer-count 수신');

    // 5. 슬롯 자동 배정: camera → 1 → 2, 세 번째는 4003
    const cam1 = new TestClient(base);
    await cam1.open();
    cam1.send({ type: 'register', role: 'broadcaster', name: '폰1' });
    const cam1Reg = await cam1.waitFor('registered');
    assert(cam1Reg.slot === 1, '첫 camera는 슬롯 1 자동 배정 (registered에 slot 포함)');
    const j1 = await viewer.waitFor('broadcaster-joined');
    assert(j1.id === cam1Reg.id && j1.slot === 1 && j1.kind === 'camera' && j1.name === '폰1',
      '뷰어가 broadcaster-joined(id,name,slot,kind) 수신');
    const oj1 = await observer.waitFor('broadcaster-joined');
    assert(oj1.id === cam1Reg.id, 'observer도 broadcaster-joined 수신');

    const cam2 = new TestClient(base);
    await cam2.open();
    cam2.send({ type: 'register', role: 'broadcaster', kind: 'camera' });
    const cam2Reg = await cam2.waitFor('registered');
    assert(cam2Reg.slot === 2, '두 번째 camera는 슬롯 2 자동 배정');
    const j2 = await viewer.waitFor('broadcaster-joined');
    assert(j2.id === cam2Reg.id && j2.name === 'CAM 2', 'name 미지정 슬롯2 기본 이름은 CAM 2');

    const cam3 = new TestClient(base);
    await cam3.open();
    cam3.send({ type: 'register', role: 'broadcaster', kind: 'camera' });
    assert((await cam3.waitClose()) === 4003, '슬롯 1·2 모두 차면 4003 slots-full 거부');

    // 6. 명시적 slot 충돌 — last-wins (기존 방송자 4002, 뷰어에 left → joined 순서)
    const cam1b = new TestClient(base);
    await cam1b.open();
    cam1b.send({ type: 'register', role: 'broadcaster', slot: 1, name: '새폰' });
    const cam1bReg = await cam1b.waitFor('registered');
    assert(cam1bReg.slot === 1, '명시적 slot=1 새 방송자 등록');
    assert((await cam1.waitClose()) === 4002, '기존 슬롯1 방송자는 4002 slot-taken으로 종료');
    const left1 = await viewer.waitFor('broadcaster-left');
    assert(left1.id === cam1Reg.id, '뷰어가 기존 방송자의 broadcaster-left 수신');
    const j1b = await viewer.waitFor('broadcaster-joined');
    assert(j1b.id === cam1bReg.id && j1b.slot === 1 && j1b.name === '새폰', '뷰어가 새 방송자의 broadcaster-joined 수신');
    const leftIdx = viewer.all.findIndex((m) => m.type === 'broadcaster-left' && m.id === cam1Reg.id);
    const joinIdx = viewer.all.findIndex((m) => m.type === 'broadcaster-joined' && m.id === cam1bReg.id);
    assert(leftIdx >= 0 && joinIdx > leftIdx, 'left → joined 순서 보장');

    // 7. kind:'app' slot 미지정 → 슬롯 3
    const appB = new TestClient(base);
    await appB.open();
    appB.send({ type: 'register', role: 'broadcaster', kind: 'app' });
    const appReg = await appB.waitFor('registered');
    assert(appReg.slot === 3, "kind:'app' slot 미지정은 슬롯 3 배정");
    const jApp = await viewer.waitFor('broadcaster-joined');
    assert(jApp.id === appReg.id && jApp.kind === 'app' && jApp.name === 'APP', '슬롯3 기본 이름은 APP');

    // 8. watch → offer → answer → ice 중계 (from 부착)
    viewer.send({ type: 'watch', target: cam1bReg.id });
    const watch = await cam1b.waitFor('watch');
    assert(watch.from === vReg.id, '방송자가 watch 수신 (from=뷰어 id)');

    cam1b.send({ type: 'offer', target: vReg.id, sdp: { type: 'offer', sdp: 'x' } });
    const offer = await viewer.waitFor('offer');
    assert(offer.from === cam1bReg.id && offer.sdp.type === 'offer', '뷰어가 offer 수신');

    viewer.send({ type: 'answer', target: cam1bReg.id, sdp: { type: 'answer', sdp: 'y' } });
    const answer = await cam1b.waitFor('answer');
    assert(answer.from === vReg.id && answer.sdp.type === 'answer', '방송자가 answer 수신');

    cam1b.send({ type: 'ice', target: vReg.id, candidate: { candidate: 'c1' } });
    const ice1 = await viewer.waitFor('ice');
    assert(ice1.from === cam1bReg.id && ice1.candidate.candidate === 'c1', '뷰어가 ICE 수신');

    viewer.send({ type: 'ice', target: cam1bReg.id, candidate: { candidate: 'c2' } });
    const ice2 = await cam1b.waitFor('ice');
    assert(ice2.from === vReg.id && ice2.candidate.candidate === 'c2', '방송자가 ICE 수신');

    // 9. 보조 모드: fallback-start/frame 뷰어 전달, observer에는 frame 미전달
    cam1b.send({ type: 'fallback-start' });
    const fb = await viewer.waitFor('fallback-start');
    assert(fb.from === cam1bReg.id, '뷰어가 fallback-start 수신');
    const ofb = await observer.waitFor('fallback-start');
    assert(ofb.from === cam1bReg.id, 'observer도 fallback-start 수신 (상태판용)');

    cam1b.send({ type: 'frame', jpeg: 'data:image/jpeg;base64,AAAA' });
    const frame = await viewer.waitFor('frame');
    assert(frame.from === cam1bReg.id && frame.jpeg.startsWith('data:image/jpeg'), '뷰어가 frame 수신');
    await new Promise((r) => setTimeout(r, 300));
    assert(!observer.all.some((m) => m.type === 'frame'), 'observer에는 frame 미전달');

    // 10. 늦게 등록한 뷰어 — fallback·slot 포함 목록 수신
    const viewer2 = new TestClient(base);
    await viewer2.open();
    viewer2.send({ type: 'register', role: 'viewer' });
    const v2Reg = await viewer2.waitFor('registered');
    assert(v2Reg.broadcasters.length === 3, '늦은 뷰어가 방송자 3개 목록 수신');
    const slot1Entry = v2Reg.broadcasters.find((b) => b.id === cam1bReg.id);
    assert(slot1Entry && slot1Entry.fallback === true && slot1Entry.slot === 1, '목록 항목에 fallback=true·slot 포함');
    assert(v2Reg.broadcasters.every((b) => typeof b.slot === 'number' && typeof b.kind === 'string'),
      '모든 목록 항목에 slot·kind 포함');
    const vCount2 = await viewer.waitFor('viewer-count');
    assert(vCount2.count === 2, '두 번째 뷰어 등록 시 viewer-count=2');

    // 11. 방송자 퇴장 → broadcaster-left
    cam1b.ws.close();
    const left = await viewer.waitFor('broadcaster-left');
    assert(left.id === cam1bReg.id, '뷰어가 broadcaster-left 수신');

    // 11-2. 뷰어 퇴장 → viewer-left(모든 클라이언트) + viewer-count 갱신
    viewer2.ws.close();
    const vLeft = await cam2.waitFor('viewer-left');
    assert(vLeft.id === v2Reg.id, '방송자가 viewer-left 수신');
    const vCountAfter = await viewer.waitFor('viewer-count');
    assert(vCountAfter.count === 1, '뷰어 퇴장 시 viewer-count 갱신');

    console.log('\n모든 시그널링 테스트 통과');
    process.exitCode = 0;
  } catch (err) {
    console.error('\n테스트 실패:', err.message);
    process.exitCode = 1;
  } finally {
    await server.close();
    setTimeout(() => process.exit(process.exitCode), 300).unref();
  }
})().catch((err) => {
  console.error('\n테스트 실패:', err.message);
  process.exit(1);
});
