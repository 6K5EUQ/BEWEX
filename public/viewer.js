// 데스크톱 뷰어 페이지 (Electron 창에서 https://127.0.0.1:PORT/viewer 로 열림).
// 연결된 휴대폰마다 타일을 만들고, WebRTC 스트림 또는 보조 모드 프레임을 표시한다.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const grid = $('grid');
  const emptyState = $('emptyState');
  const connBadge = $('connBadge');
  const connText = $('connText');
  const addrEl = $('addr');
  const addrBig = $('addrBig');
  const qrImg = $('qrImg');
  const qrBtn = $('qrBtn');

  const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  let ws = null;
  let viewerToken = null;
  let reconnectTimer = null;
  let showQrAlways = false;

  // broadcasterId -> {id, name, fallback, pc, pendingIce, el, video, img, connecting, modeEl, muteBtn, gotMedia}
  const tiles = new Map();

  function setConn(kind, text) {
    connBadge.className = 'badge ' + kind;
    connText.textContent = text;
  }

  function updateStage() {
    const hasTiles = tiles.size > 0;
    grid.classList.toggle('hidden', !hasTiles);
    emptyState.classList.toggle('hidden', hasTiles && !showQrAlways);
    if (hasTiles) setConn('ok', `카메라 ${tiles.size}대 연결됨`);
    else if (ws && ws.readyState === WebSocket.OPEN) setConn('ok', '휴대폰 연결 대기 중');
  }

  qrBtn.addEventListener('click', () => {
    showQrAlways = !showQrAlways;
    qrBtn.textContent = showQrAlways ? 'QR 닫기' : 'QR 보기';
    updateStage();
  });

  // ---------- 타일 ----------
  function createTile(id, name) {
    removeTile(id);

    const el = document.createElement('div');
    el.className = 'tile';
    el.innerHTML = `
      <video autoplay playsinline></video>
      <img class="frame hidden" alt="" />
      <div class="connecting">연결 중…</div>
      <div class="tile-bar">
        <span class="name"></span>
        <span class="badge mode"><span class="dot"></span><span class="mode-text">연결 중</span></span>
        <div class="spacer"></div>
        <button class="mute" title="소리 켜기/끄기">🔊</button>
        <button class="fs" title="전체 화면">⛶</button>
      </div>`;
    el.querySelector('.name').textContent = name;

    const tile = {
      id,
      name,
      fallback: false,
      pc: null,
      pendingIce: [],
      gotMedia: false,
      el,
      video: el.querySelector('video'),
      img: el.querySelector('img.frame'),
      connecting: el.querySelector('.connecting'),
      modeEl: el.querySelector('.badge.mode'),
      modeTextEl: el.querySelector('.mode-text'),
      muteBtn: el.querySelector('button.mute'),
    };

    tile.muteBtn.addEventListener('click', () => {
      tile.video.muted = !tile.video.muted;
      tile.muteBtn.textContent = tile.video.muted ? '🔇' : '🔊';
    });
    el.querySelector('button.fs').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else el.requestFullscreen().catch(() => {});
    });
    el.addEventListener('dblclick', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else el.requestFullscreen().catch(() => {});
    });

    grid.appendChild(el);
    tiles.set(id, tile);
    updateStage();
    return tile;
  }

  function setTileMode(tile, mode) {
    // mode: 'webrtc' | 'fallback' | 'connecting'
    if (mode === 'connecting') {
      tile.modeEl.className = 'badge mode warn';
      tile.modeTextEl.textContent = '연결 중';
      return;
    }
    tile.connecting.classList.add('hidden');
    tile.gotMedia = true;
    if (mode === 'webrtc') {
      tile.video.classList.remove('hidden');
      tile.img.classList.add('hidden');
      tile.modeEl.className = 'badge mode ok';
      tile.modeTextEl.textContent = '실시간 (WebRTC)';
      tile.muteBtn.classList.remove('hidden');
    } else {
      tile.video.classList.add('hidden');
      tile.img.classList.remove('hidden');
      tile.modeEl.className = 'badge mode warn';
      tile.modeTextEl.textContent = '보조 모드';
      tile.muteBtn.classList.add('hidden'); // 보조 모드는 영상만 전송됨
    }
  }

  function removeTile(id) {
    const tile = tiles.get(id);
    if (!tile) return;
    closePC(tile);
    tile.el.remove();
    tiles.delete(id);
    updateStage();
  }

  function closePC(tile) {
    if (tile.pc) {
      try { tile.pc.close(); } catch (_) {}
      tile.pc = null;
    }
    tile.pendingIce = [];
  }

  // ---------- WebRTC (휴대폰이 offer를 보내고 뷰어가 answer) ----------
  async function onOffer(broadcasterId, sdp) {
    // 보조 모드 중에도 offer를 받는다 — 휴대폰의 WebRTC 복귀 시도
    const tile = tiles.get(broadcasterId);
    if (!tile) return;
    closePC(tile);

    const pc = new RTCPeerConnection(RTC_CONFIG);
    tile.pc = pc;

    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (tile.video.srcObject !== stream) {
        tile.video.srcObject = stream;
        playVideo(tile);
      }
      // 보조 모드 중 복귀 협상이면 fallback-stop이 올 때까지 프레임 표시 유지
      if (!tile.fallback) setTileMode(tile, 'webrtc');
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) wsSend({ type: 'ice', target: broadcasterId, candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (!tile.pc) return;
      if (pc.connectionState === 'failed') {
        // 휴대폰 쪽 워치독이 보조 모드로 전환해 줄 때까지 대기 표시
        setTileMode(tile, 'connecting');
        tile.connecting.classList.remove('hidden');
        tile.connecting.textContent = '연결 재시도 중…';
      }
    };

    try {
      await pc.setRemoteDescription(sdp);
      for (const c of tile.pendingIce) await pc.addIceCandidate(c).catch(() => {});
      tile.pendingIce = [];
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend({ type: 'answer', target: broadcasterId, sdp: pc.localDescription });
    } catch (_) {
      // 실패 시 휴대폰 워치독이 보조 모드로 전환한다
    }
  }

  async function playVideo(tile) {
    try {
      await tile.video.play();
    } catch (_) {
      // 자동 재생이 소리 때문에 막히면 음소거 후 재생
      tile.video.muted = true;
      tile.muteBtn.textContent = '🔇';
      tile.video.play().catch(() => {});
    }
  }

  async function onIce(broadcasterId, candidate) {
    const tile = tiles.get(broadcasterId);
    if (!tile || !candidate) return;
    if (!tile.pc || !tile.pc.remoteDescription) {
      tile.pendingIce.push(candidate);
      return;
    }
    await tile.pc.addIceCandidate(candidate).catch(() => {});
  }

  // ---------- WebSocket ----------
  function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function connectWS() {
    ws = new WebSocket(`wss://${location.host}/ws`);

    ws.onopen = () => {
      wsSend({ type: 'register', role: 'viewer', token: viewerToken });
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      handleMessage(msg);
    };

    ws.onclose = (ev) => {
      for (const id of [...tiles.keys()]) removeTile(id);
      if (ev.code === 4001) {
        setConn('err', '시청 권한 없음 (데스크톱 앱에서만 시청 가능)');
        return;
      }
      setConn('err', '서버 재연결 중…');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWS, 3000);
    };
  }

  function watchBroadcaster(b) {
    const tile = createTile(b.id, b.name);
    tile.fallback = !!b.fallback;
    // 보조 모드 방송자에게도 watch를 보낸다 — 휴대폰이 WebRTC 복귀를 재시도하고,
    // 실패하면 그대로 보조 모드 프레임을 계속 보낸다
    wsSend({ type: 'watch', target: b.id });
    setTileMode(tile, 'connecting');
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'registered':
        setConn('ok', '휴대폰 연결 대기 중');
        for (const b of msg.broadcasters || []) watchBroadcaster(b);
        updateStage();
        break;
      case 'broadcaster-joined':
        watchBroadcaster({ id: msg.id, name: msg.name, fallback: false });
        break;
      case 'broadcaster-left':
        removeTile(msg.id);
        break;
      case 'offer':
        onOffer(msg.from, msg.sdp);
        break;
      case 'ice':
        onIce(msg.from, msg.candidate);
        break;
      case 'fallback-start': {
        const tile = tiles.get(msg.from);
        if (tile) {
          tile.fallback = true;
          closePC(tile);
        }
        break;
      }
      case 'fallback-stop': {
        const tile = tiles.get(msg.from);
        if (!tile) break;
        tile.fallback = false;
        if (tile.pc && tile.video.srcObject) {
          // 복귀 협상이 이미 끝난 상태 — 화면만 WebRTC로 전환
          setTileMode(tile, 'webrtc');
        } else {
          wsSend({ type: 'watch', target: msg.from });
          setTileMode(tile, 'connecting');
          tile.connecting.classList.remove('hidden');
        }
        break;
      }
      case 'frame': {
        const tile = tiles.get(msg.from);
        // 명시적 fallback 신호(fallback-start/등록 목록)가 있을 때만 렌더링 —
        // WebRTC 복귀 직후 도착하는 잔여 프레임이 화면을 되돌리지 않게 한다
        if (!tile || !tile.fallback) break;
        if (!tile.gotMedia || tile.img.classList.contains('hidden')) setTileMode(tile, 'fallback');
        tile.img.src = msg.jpeg;
        break;
      }
      default:
        break;
    }
  }

  // ---------- 시작 ----------
  async function init() {
    let info;
    try {
      const res = await fetch('/api/info');
      info = await res.json();
    } catch (err) {
      setConn('err', '서버 정보를 가져오지 못했습니다');
      return;
    }

    addrEl.textContent = info.mobileUrl;
    addrBig.textContent = info.mobileUrl;
    qrImg.src = info.qr;

    // 접속 주소 선택: 인터페이스가 여러 개면(예: 학교망 + Tailscale) 골라서 QR을 바꿀 수 있다
    const ips = info.ips || [];
    const isTailscale = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
    const ipLabel = (ip) => {
      if (isTailscale(ip)) return 'Tailscale — 외부(LTE)에서 접속';
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return '같은 네트워크(Wi-Fi)용';
      return '유선/공인망용';
    };
    const renderSteps = (ip) => {
      const first = isTailscale(ip)
        ? '1️⃣ 휴대폰에 <b>Tailscale 앱</b>을 설치하고 같은 계정으로 로그인 (연결 켜기)'
        : '1️⃣ 휴대폰을 <b>이 컴퓨터와 같은 Wi-Fi</b>에 연결';
      document.getElementById('steps').innerHTML = `${first}<br />
        2️⃣ 휴대폰 카메라로 위 QR 코드 스캔 (또는 주소 직접 입력)<br />
        3️⃣ 보안 경고가 나오면 <b>고급 → 이동(계속)</b> 선택<br />
        4️⃣ <b>[방송 시작]</b>을 누르고 카메라 권한 허용`;
    };
    const applyAddress = async (ip) => {
      localStorage.setItem('phonecam-addr-ip', ip);
      const url = `https://${ip}:${info.port}/mobile`;
      addrEl.textContent = url;
      addrBig.textContent = url;
      renderSteps(ip);
      try {
        const r = await fetch('/api/qr?ip=' + encodeURIComponent(ip));
        const d = await r.json();
        if (d.qr) qrImg.src = d.qr;
      } catch (_) { /* QR 갱신 실패 시 주소 텍스트는 이미 갱신됨 */ }
    };
    if (ips.length > 1) {
      const sel = document.getElementById('addrSelect');
      for (const ip of ips) {
        const opt = document.createElement('option');
        opt.value = ip;
        opt.textContent = `${ip} — ${ipLabel(ip)}`;
        sel.appendChild(opt);
      }
      const saved = localStorage.getItem('phonecam-addr-ip');
      const current = ips.includes(saved) ? saved : ips[0];
      sel.value = current;
      sel.addEventListener('change', () => applyAddress(sel.value));
      sel.classList.remove('hidden');
      if (current !== ips[0]) await applyAddress(current);
      else renderSteps(current);
    } else if (ips.length === 1) {
      renderSteps(ips[0]);
    }

    if (!info.viewerToken) {
      setConn('err', '이 페이지는 PhoneCam 데스크톱 앱에서만 시청할 수 있습니다');
      return;
    }
    viewerToken = info.viewerToken;
    connectWS();
  }

  init();
})();
