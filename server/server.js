// 내장 HTTPS 웹 서버 + WebSocket 시그널링 서버 (프로토콜 v2).
//
// 모든 네트워크는 Tailscale 신뢰망 전제 — PIN/토큰 인증 없음.
//
// HTTP 라우트:
//  - /          : /mobile 로 redirect
//  - /mobile    : 휴대폰용 송출 페이지 (슬롯 1·2 카메라)
//  - /ingest    : Ingest Hub UI 페이지
//  - /monitor   : Mission Monitor 관제 페이지
//  - /viewer    : 구버전 호환 — /monitor 로 301 redirect
//  - /api/info  : {port, ips}
//  - /api/qr    : ?ip=<ips 중 하나>&slot=<1|2|생략> → mobile 접속 QR dataURL
//  - /ws        : WebRTC 시그널링 및 보조(프레임 릴레이) 채널
//
// 시그널링 프로토콜 v2 (JSON):
//  방송자 → 서버 : {type:'register', role:'broadcaster', name?, slot?, kind?}
//                  kind ∈ 'camera'|'screen'|'app' (기본 'camera'), slot: 1|2|3 (선택)
//  뷰어   → 서버 : {type:'register', role:'viewer', observer?}
//                  observer:true = Ingest Hub 상태판 — 이벤트는 받지만
//                  frame 릴레이 대상에서 제외되고 viewer-count에도 미포함
//  서버   → 등록자: 방송자 {type:'registered', id, slot} /
//                  뷰어   {type:'registered', id, broadcasters:[{id,name,slot,kind,fallback}]}
//  슬롯 배정: 명시적 slot은 last-wins(기존 방송자 4002 slot-taken 종료),
//             미지정 camera는 1→2 빈 곳(둘 다 차면 4003 slots-full 거부),
//             미지정 app/screen은 슬롯 3(last-wins)
//  이벤트: broadcaster-joined/left → 모든 뷰어(observer 포함),
//          viewer-count → 모든 클라이언트 (observer 아닌 뷰어 수),
//          viewer-left → 모든 클라이언트 (방송자의 피어 정리용)
//  1:1 중계(target 지정): watch / offer / answer / ice / stop → from을 붙여 상대에게 전달
//  방송 상태: fallback-start/stop → 모든 뷰어 / frame → observer 제외 모든 뷰어
const express = require('express');
const https = require('https');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { WebSocketServer, WebSocket } = require('ws');
const { loadOrCreateCert } = require('./cert');

// 가상 인터페이스(도커 브리지, VPN 터널, VM 어댑터 등)는 휴대폰이 접속할 수 없는
// 주소이므로 후순위로 미룬다. Node의 internal 플래그는 루프백만 거르기 때문에 이름으로 판별.
const VIRTUAL_IF = /^(docker|br-|veth|virbr|vmnet|vboxnet|vethernet|tailscale|zt|tun|tap|wg|utun|ham)/i;

function ipScore(ip) {
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 0; // CGNAT (Tailscale 등)
  if (ip.startsWith('169.254.')) return 0; // link-local
  if (ip.startsWith('192.168.')) return 3;
  if (ip.startsWith('10.')) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1; // 도커 기본 브리지 대역과 겹침 → 후순위
  return 2; // 공인 IP 직결 (학교/회사망)
}

function getLanIPs() {
  const physical = [];
  const virtual = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      (VIRTUAL_IF.test(name) ? virtual : physical).push(a.address);
    }
  }
  const byScore = (a, b) => ipScore(b) - ipScore(a);
  return [...physical.sort(byScore), ...virtual.sort(byScore)];
}

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

async function startServer({ certDir, preferredPort = 8443 } = {}) {
  const allIps = getLanIPs();
  // 공개(표시/QR) 주소를 하나로 고정: BEWE_PUBLIC_HOST 가 있으면(예: Tailscale IP)
  // /api/info·QR·mobileUrl 은 그 주소만 노출한다. 인증서(SAN)는 모든 IP를 계속
  // 커버해 localhost·LAN 접속에서도 경고 없이 붙게 한다.
  const publicHost = (process.env.BEWE_PUBLIC_HOST || '').trim();
  const ips = publicHost ? [publicHost] : allIps;
  const certIps =
    publicHost && !allIps.includes(publicHost) ? [...allIps, publicHost] : allIps;
  const { key, cert } = loadOrCreateCert(certDir, certIps);

  const app = express();
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));
  app.get('/', (req, res) => res.redirect('/mobile'));
  app.get('/mobile', (req, res) => res.sendFile(path.join(publicDir, 'mobile.html')));
  app.get('/ingest', (req, res) => res.sendFile(path.join(publicDir, 'ingest.html')));
  app.get('/monitor', (req, res) => res.sendFile(path.join(publicDir, 'monitor.html')));
  // 구버전 호환: 예전 뷰어 주소는 관제 모니터로 안내
  app.get('/viewer', (req, res) => res.redirect(301, '/monitor'));

  const server = https.createServer({ key, cert }, app);

  let port = preferredPort;
  for (let p = preferredPort; p < preferredPort + 20; p++) {
    try {
      await listenOnce(server, p);
      port = p;
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || p === preferredPort + 19) throw err;
    }
  }

  app.get('/api/info', (req, res) => {
    res.json({ port, ips });
  });

  // 접속 주소(예: Wi-Fi ↔ Tailscale)와 슬롯을 골라 해당 mobile 주소의 QR을 생성
  app.get('/api/qr', async (req, res) => {
    const ip = String(req.query.ip || '');
    if (!ips.includes(ip)) return res.status(400).json({ error: 'unknown ip' });
    const slot = req.query.slot === '1' || req.query.slot === '2' ? Number(req.query.slot) : null;
    const url = `https://${ip}:${port}/mobile${slot ? `?slot=${slot}` : ''}`;
    res.json({ qr: await QRCode.toDataURL(url, { margin: 1, width: 240 }) });
  });

  // ---------------- WebSocket 시그널링 ----------------
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024 });
  let nextId = 1;
  const clients = new Map(); // id -> {id, ws, role, name, kind, slot, fallback, observer}

  const send = (client, msg) => {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(msg));
  };
  const broadcasters = () => [...clients.values()].filter((c) => c.role === 'broadcaster');
  const viewers = () => [...clients.values()].filter((c) => c.role === 'viewer'); // observer 포함
  const viewerCount = () => viewers().filter((v) => !v.observer).length;
  const broadcastViewerCount = () => {
    const msg = { type: 'viewer-count', count: viewerCount() };
    for (const c of clients.values()) send(c, msg);
  };

  wss.on('connection', (ws) => {
    const id = String(nextId++);
    let me = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data); } catch (_) { return; }

      if (msg.type === 'register') {
        if (me) return;
        const role = msg.role === 'viewer' ? 'viewer' : 'broadcaster';

        if (role === 'viewer') {
          // 인증 없음 — Tailscale 신뢰망 전제
          me = { id, ws, role, observer: msg.observer === true };
          clients.set(id, me);
          send(me, {
            type: 'registered',
            id,
            broadcasters: broadcasters().map((b) => ({
              id: b.id, name: b.name, slot: b.slot, kind: b.kind, fallback: b.fallback,
            })),
          });
          // observer는 count에 영향이 없으므로 현재 값만 알려 주고,
          // 일반 뷰어는 count가 바뀌므로 모두에게 통지 (본인 포함)
          if (me.observer) send(me, { type: 'viewer-count', count: viewerCount() });
          else broadcastViewerCount();
          return;
        }

        // ---- 방송자 등록: 슬롯 배정 ----
        const requested = Number(msg.slot);
        let slot = [1, 2, 3].includes(requested) ? requested : null;
        const kind = msg.kind === 'screen' || msg.kind === 'app' ? msg.kind : 'camera';
        if (slot === null) {
          if (kind === 'camera') {
            // 카메라는 슬롯 1→2 순서로 빈 곳 배정, 둘 다 차 있으면 거부
            const used = new Set(broadcasters().map((b) => b.slot));
            if (!used.has(1)) slot = 1;
            else if (!used.has(2)) slot = 2;
            else { ws.close(4003, 'slots-full'); return; }
          } else {
            slot = 3; // app/screen 캡처는 슬롯 3
          }
        }
        // last-wins: 같은 슬롯의 기존 방송자를 밀어낸다
        const prev = broadcasters().find((b) => b.slot === slot);
        if (prev) {
          clients.delete(prev.id);
          for (const v of viewers()) send(v, { type: 'broadcaster-left', id: prev.id });
          prev.ws.close(4002, 'slot-taken');
        }
        const defaultName =
          slot === 1 ? 'CAM 1' : slot === 2 ? 'CAM 2' : slot === 3 ? 'APP' : `카메라 ${id}`;
        const name = String(msg.name || '').trim().slice(0, 30) || defaultName;
        me = { id, ws, role, name, kind, slot, fallback: false, observer: false };
        clients.set(id, me);
        send(me, { type: 'registered', id, slot });
        for (const v of viewers()) send(v, { type: 'broadcaster-joined', id, name, slot, kind });
        return;
      }

      if (!me) return;

      switch (msg.type) {
        // 1:1 중계 — 수신자에게 from을 붙여 전달
        case 'watch':
        case 'offer':
        case 'answer':
        case 'ice':
        case 'stop': {
          const target = clients.get(String(msg.target));
          if (target) send(target, { ...msg, target: undefined, from: id });
          break;
        }
        // 방송자 → 모든 뷰어 (observer 포함 — 상태판 갱신용)
        case 'fallback-start':
        case 'fallback-stop': {
          if (me.role !== 'broadcaster') break;
          me.fallback = msg.type === 'fallback-start';
          for (const v of viewers()) send(v, { type: msg.type, from: id });
          break;
        }
        case 'frame': {
          if (me.role !== 'broadcaster' || typeof msg.jpeg !== 'string') break;
          for (const v of viewers()) {
            if (v.observer) continue; // observer는 영상을 받지 않는다
            // 수신이 밀리는 뷰어에는 프레임을 건너뛴다 (실시간성 우선)
            if (v.ws.bufferedAmount > 2 * 1024 * 1024) continue;
            send(v, { type: 'frame', from: id, jpeg: msg.jpeg });
          }
          break;
        }
        default:
          break;
      }
    });

    ws.on('close', () => {
      if (!me) return;
      // last-wins로 이미 밀려난 방송자는 정리·통지가 끝난 상태
      if (clients.get(me.id) !== me) return;
      clients.delete(me.id);
      if (me.role === 'broadcaster') {
        // broadcaster-left는 스펙상 모든 뷰어(observer 포함)에게만 — last-wins 경로와 동일
        const gone = { type: 'broadcaster-left', id: me.id };
        for (const v of viewers()) send(v, gone);
      } else {
        // viewer-left는 방송자의 피어 정리용 — 모든 클라이언트에게
        const gone = { type: 'viewer-left', id: me.id };
        for (const c of clients.values()) send(c, gone);
        if (!me.observer) broadcastViewerCount();
      }
    });
  });

  // 화면이 꺼진 휴대폰 등 죽은 연결 정리
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15000);
  wss.on('close', () => clearInterval(heartbeat));

  return {
    port,
    ips,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        server.close(() => resolve());
      }),
  };
}

module.exports = { startServer, getLanIPs };
