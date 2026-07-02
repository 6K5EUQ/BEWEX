// 내장 HTTPS 웹 서버 + WebSocket 시그널링 서버.
//
// 역할:
//  - /mobile   : 휴대폰용 송출 페이지 제공
//  - /viewer   : 데스크톱용 뷰어 페이지 제공
//  - /api/info : 접속 주소·QR 코드 제공 (뷰어 토큰은 localhost 요청에만 포함)
//  - /ws       : WebRTC 시그널링 및 보조(프레임 릴레이) 채널
//
// 시그널링 프로토콜(JSON):
//  휴대폰 → 서버 : {type:'register', role:'broadcaster', name}
//  뷰어   → 서버 : {type:'register', role:'viewer', token}
//  서버   → 등록자: {type:'registered', id, broadcasters?}
//  중계(target 지정): watch / offer / answer / ice / stop  → from을 붙여 상대에게 전달
//  방송 상태: fallback-start / fallback-stop / frame → 모든 뷰어에게 전달
const crypto = require('crypto');
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

function isLocalhost(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

async function startServer({ certDir, preferredPort = 8443 } = {}) {
  const ips = getLanIPs();
  const { key, cert } = loadOrCreateCert(certDir, ips);
  const viewerToken = crypto.randomBytes(16).toString('hex');

  const app = express();
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));
  app.get('/', (req, res) => res.redirect('/mobile'));
  app.get('/mobile', (req, res) => res.sendFile(path.join(publicDir, 'mobile.html')));
  app.get('/viewer', (req, res) => res.sendFile(path.join(publicDir, 'viewer.html')));

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

  const mobileUrl = `https://${ips[0] || 'localhost'}:${port}/mobile`;

  app.get('/api/info', async (req, res) => {
    const info = {
      port,
      ips,
      mobileUrl,
      qr: await QRCode.toDataURL(mobileUrl, { margin: 1, width: 240 }),
    };
    // 스트림 시청 권한은 이 PC(데스크톱 앱)에서 연 뷰어에게만 준다.
    if (isLocalhost(req)) info.viewerToken = viewerToken;
    res.json(info);
  });

  // ---------------- WebSocket 시그널링 ----------------
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024 });
  let nextId = 1;
  const clients = new Map(); // id -> {id, ws, role, name, fallback}

  const send = (client, msg) => {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(msg));
  };
  const byRole = (role) => [...clients.values()].filter((c) => c.role === role);

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
        if (role === 'viewer' && msg.token !== viewerToken) {
          send({ ws }, { type: 'error', reason: 'unauthorized' });
          ws.close(4001, 'unauthorized');
          return;
        }
        const name = String(msg.name || '').trim().slice(0, 30) || `카메라 ${id}`;
        me = { id, ws, role, name, fallback: false };
        clients.set(id, me);
        if (role === 'viewer') {
          send(me, {
            type: 'registered',
            id,
            broadcasters: byRole('broadcaster').map((b) => ({ id: b.id, name: b.name, fallback: b.fallback })),
          });
        } else {
          send(me, { type: 'registered', id });
          for (const v of byRole('viewer')) send(v, { type: 'broadcaster-joined', id, name });
        }
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
        // 방송자 → 모든 뷰어
        case 'fallback-start':
        case 'fallback-stop': {
          if (me.role !== 'broadcaster') break;
          me.fallback = msg.type === 'fallback-start';
          for (const v of byRole('viewer')) send(v, { type: msg.type, from: id });
          break;
        }
        case 'frame': {
          if (me.role !== 'broadcaster' || typeof msg.jpeg !== 'string') break;
          for (const v of byRole('viewer')) {
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
      clients.delete(id);
      const gone = { type: me.role === 'broadcaster' ? 'broadcaster-left' : 'viewer-left', id };
      for (const c of clients.values()) send(c, gone);
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
    mobileUrl,
    viewerToken,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        server.close(() => resolve());
      }),
  };
}

module.exports = { startServer, getLanIPs };
