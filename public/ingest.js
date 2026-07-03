// Ingest Hub 렌더러 (Electron 창에서 /ingest 로 열림).
// QR 카드(슬롯1/2) + 창 캡처(슬롯3, WebRTC/보조 모드) + observer WS 상태판/뷰어 수.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const connBadge = $('connBadge');
  const addrLabel = $('addrLabel');
  const addrSelect = $('addrSelect');
  const pickBtn = $('pickBtn');
  const resumeBtn = $('resumeBtn');
  const winList = $('winList');
  const appMsg = $('appMsg');
  const appIdle = $('appIdle');
  const appLive = $('appLive');
  const appPreview = $('appPreview');
  const appTitle = $('appTitle');
  const stopCaptureBtn = $('stopCaptureBtn');
  const missionClockEl = $('missionClock');
  const localClockEl = $('localClock');
  const utcClockEl = $('utcClock');

  const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const CONNECT_TIMEOUT_MS = 10000; // 이 시간 안에 WebRTC 연결이 안 되면 보조 모드
  const FRAME_INTERVAL_MS = 100;    // 보조 모드 10fps
  const FRAME_MAX_WIDTH = 640;
  const FRAME_QUALITY = 0.55;

  const SLOT_LABEL = { 1: 'CAM 1', 2: 'CAM 2', 3: 'APP' };

  // 서버 주소: Electron이 주입한 window.__BEWE__ 우선, 없으면 페이지 origin(원격 로드 호환)
  const SERVER = (window.__BEWE__ && window.__BEWE__.host)
    ? `${window.__BEWE__.host}:${window.__BEWE__.port}`
    : location.host;
  const API = `https://${SERVER}`;

  let serverPort = null;
  let currentIp = null;

  function setConn(kind) {
    connBadge.className = 'badge ' + kind;
  }

  // 접속 주소 선택 + QR
  const isTailscale = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
  const ipLabel = (ip) => {
    if (isTailscale(ip)) return 'Tailscale — 외부(LTE)에서 접속';
    if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return '같은 네트워크(Wi-Fi)용';
    return '유선/공인망용';
  };

  // 선택한 주소로 두 슬롯의 QR을 갱신
  async function applyAddress(ip) {
    localStorage.setItem('phonecam-addr-ip', ip);
    currentIp = ip;
    await Promise.all([1, 2].map(async (n) => {
      try {
        const r = await fetch(`${API}/api/qr?ip=${encodeURIComponent(ip)}&slot=${n}`);
        const d = await r.json();
        if (d.qr) $(`qr${n}`).src = d.qr;
      } catch (_) { /* QR 갱신 실패 시 주소 텍스트는 이미 갱신됨 */ }
    }));
  }

  // 슬롯 상태판 (observer WS)
  let obsWs = null;
  let obsReconnectTimer = null;
  const slotState = new Map(); // slot(1|2|3) -> {id, name, kind, fallback}
  const idToSlot = new Map();  // broadcasterId -> slot

  function renderSlots() {
    for (const n of [1, 2, 3]) {
      const badge = $(`slotBadge${n}`);
      const text = $(`slotText${n}`);
      const st = slotState.get(n);
      if (!st) {
        badge.className = 'badge';
        text.textContent = '대기';
      } else if (st.fallback) {
        badge.className = 'badge warn';
        text.textContent = `보조모드 · ${st.name}`;
      } else {
        badge.className = 'badge ok';
        text.textContent = `WebRTC · ${st.name}`;
      }
    }
  }

  function addBroadcaster(b) {
    const slot = Number(b.slot);
    if (slot !== 1 && slot !== 2 && slot !== 3) return; // 슬롯 미배정(구버전) 방송자는 상태판에서 무시
    slotState.set(slot, {
      id: String(b.id),
      name: b.name || SLOT_LABEL[slot],
      kind: b.kind,
      fallback: !!b.fallback,
    });
    idToSlot.set(String(b.id), slot);
    renderSlots();
  }

  function removeBroadcaster(id) {
    const slot = idToSlot.get(String(id));
    if (slot === undefined) return;
    idToSlot.delete(String(id));
    const st = slotState.get(slot);
    if (st && st.id === String(id)) slotState.delete(slot);
    renderSlots();
  }

  function handleObserverMessage(msg) {
    switch (msg.type) {
      case 'registered':
        setConn('ok');
        slotState.clear();
        idToSlot.clear();
        for (const b of msg.broadcasters || []) addBroadcaster(b);
        renderSlots();
        break;
      case 'broadcaster-joined':
        addBroadcaster(msg);
        break;
      case 'broadcaster-left':
        removeBroadcaster(msg.id);
        break;
      case 'fallback-start':
      case 'fallback-stop': {
        const slot = idToSlot.get(String(msg.from));
        const st = slot !== undefined ? slotState.get(slot) : null;
        if (st) {
          st.fallback = msg.type === 'fallback-start';
          renderSlots();
        }
        break;
      }
      default:
        break; // observer는 watch를 보내지 않으므로 offer/frame 등은 오지 않음
    }
  }

  function connectObserver() {
    obsWs = new WebSocket(`wss://${SERVER}/ws`);
    obsWs.onopen = () => {
      // observer: 이벤트만 받고 frame 릴레이·viewer-count에서 제외되는 상태판 전용 뷰어
      obsWs.send(JSON.stringify({ type: 'register', role: 'viewer', observer: true }));
    };
    obsWs.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      handleObserverMessage(msg);
    };
    obsWs.onclose = () => {
      setConn('err');
      clearTimeout(obsReconnectTimer);
      obsReconnectTimer = setTimeout(connectObserver, 3000);
    };
  }

  // APP 캡처 (슬롯3 방송, 두 번째 WS)
  let capturing = false;
  let capStream = null;
  let capWs = null;
  let capFallback = false;
  let capName = '';
  let capFrameTimer = null;
  let capReconnectTimer = null;
  const capPcs = new Map();        // viewerId -> RTCPeerConnection
  const capWatchdogs = new Map();  // viewerId -> timeout id
  const capPendingIce = new Map(); // viewerId -> candidate[]

  const frameCanvas = document.createElement('canvas');
  const frameCtx = frameCanvas.getContext('2d');

  function capSend(msg) {
    if (capWs && capWs.readyState === WebSocket.OPEN) capWs.send(JSON.stringify(msg));
  }

  function closeCapPeer(viewerId) {
    clearTimeout(capWatchdogs.get(viewerId));
    capWatchdogs.delete(viewerId);
    capPendingIce.delete(viewerId);
    const pc = capPcs.get(viewerId);
    if (pc) {
      capPcs.delete(viewerId);
      try { pc.close(); } catch (_) {}
    }
  }

  function cleanupCapPeers() {
    for (const id of [...capPcs.keys()]) closeCapPeer(id);
  }

  async function startCapPeer(viewerId) {
    if (!capStream) return;
    closeCapPeer(viewerId);
    const pc = new RTCPeerConnection(RTC_CONFIG);
    capPcs.set(viewerId, pc);
    capPendingIce.set(viewerId, []);

    for (const track of capStream.getTracks()) pc.addTrack(track, capStream);

    pc.onicecandidate = (e) => {
      if (e.candidate) capSend({ type: 'ice', target: viewerId, candidate: e.candidate });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        clearTimeout(capWatchdogs.get(viewerId));
        capWatchdogs.delete(viewerId);
        if (capFallback) exitCapFallback();
      } else if (state === 'failed') {
        enterCapFallback();
      }
    };

    // P2P 미연결 시 보조 모드로 전환. 이미 보조 모드면 재시도 피어만 정리.
    capWatchdogs.set(viewerId, setTimeout(() => {
      if (pc.connectionState !== 'connected') {
        if (capFallback) closeCapPeer(viewerId);
        else enterCapFallback();
      }
    }, CONNECT_TIMEOUT_MS));

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      capSend({ type: 'offer', target: viewerId, sdp: pc.localDescription });
    } catch (_) {
      enterCapFallback();
    }
  }

  async function onCapAnswer(viewerId, sdp) {
    const pc = capPcs.get(viewerId);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(sdp);
      const queued = capPendingIce.get(viewerId) || [];
      capPendingIce.set(viewerId, []);
      for (const c of queued) await pc.addIceCandidate(c).catch(() => {});
    } catch (_) {
      enterCapFallback();
    }
  }

  async function onCapIce(viewerId, candidate) {
    const pc = capPcs.get(viewerId);
    if (!pc || !candidate) return;
    if (!pc.remoteDescription) {
      (capPendingIce.get(viewerId) || []).push(candidate);
      return;
    }
    await pc.addIceCandidate(candidate).catch(() => {});
  }

  // 보조 모드: 캡처 프리뷰 <video>를 canvas로 인코딩해 프레임 릴레이
  function enterCapFallback() {
    if (capFallback || !capturing) return;
    capFallback = true;
    cleanupCapPeers();
    capSend({ type: 'fallback-start' });

    capFrameTimer = setInterval(() => {
      if (!capWs || capWs.readyState !== WebSocket.OPEN) return;
      if (capWs.bufferedAmount > 1_000_000) return; // 네트워크가 밀리면 프레임 건너뜀
      if (appPreview.readyState < 2 || !appPreview.videoWidth) return;
      const scale = Math.min(1, FRAME_MAX_WIDTH / appPreview.videoWidth);
      frameCanvas.width = Math.round(appPreview.videoWidth * scale);
      frameCanvas.height = Math.round(appPreview.videoHeight * scale);
      frameCtx.drawImage(appPreview, 0, 0, frameCanvas.width, frameCanvas.height);
      capSend({ type: 'frame', jpeg: frameCanvas.toDataURL('image/jpeg', FRAME_QUALITY) });
    }, FRAME_INTERVAL_MS);
  }

  function stopCapFallback() {
    clearInterval(capFrameTimer);
    capFrameTimer = null;
    capFallback = false;
  }

  // WebRTC 복귀 성공 시: 프레임 전송을 멈추고 뷰어에게 알린다
  function exitCapFallback() {
    if (!capFallback) return;
    stopCapFallback();
    capSend({ type: 'fallback-stop' });
  }

  function connectCapWS() {
    capWs = new WebSocket(`wss://${SERVER}/ws`);

    capWs.onopen = () => {
      capSend({ type: 'register', role: 'broadcaster', slot: 3, kind: 'app', name: capName });
    };

    capWs.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      switch (msg.type) {
        case 'registered':
          // 재연결 시 보조 모드였다면 그대로 이어서 방송
          if (capFallback) capSend({ type: 'fallback-start' });
          break;
        case 'watch':
          startCapPeer(msg.from);
          break;
        case 'answer':
          onCapAnswer(msg.from, msg.sdp);
          break;
        case 'ice':
          onCapIce(msg.from, msg.candidate);
          break;
        case 'viewer-left':
          closeCapPeer(msg.id);
          break;
        default:
          break;
      }
    };

    capWs.onclose = (ev) => {
      cleanupCapPeers();
      // 다른 송출자가 슬롯3을 가져간 경우(last-wins): 재연결하지 않고 캡처 종료
      if (ev.code === 4002) {
        stopCapture();
        appMsg.textContent = '다른 송출자가 APP 슬롯으로 접속하여 캡처가 종료되었습니다.';
        return;
      }
      if (!capturing) return;
      clearTimeout(capReconnectTimer);
      capReconnectTimer = setTimeout(connectCapWS, 3000);
    };
  }

  async function startCapture(sourceId, title) {
    if (capturing || !window.ingestAPI) return;
    closeWinList();
    appMsg.textContent = '';
    pickBtn.disabled = true;
    try {
      // Wayland: OS picker가 대상을 고르므로 selectSource 생략(sourceId 없음).
      // X11: 앱 목록에서 고른 창 id를 메인에 저장한 뒤 캡처.
      if (!window.ingestAPI.isWayland) await window.ingestAPI.selectSource(sourceId);
      capStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: false,
      });
    } catch (_) {
      // getDisplayMedia 거부: 사용자가 picker를 취소했거나 창이 닫힌 경우 등.
      appMsg.textContent = '창을 캡처할 수 없습니다. (취소했거나 창이 닫혔을 수 있음) 다시 선택해 주세요.';
      pickBtn.disabled = false;
      updateResumeBtn();
      return;
    }
    pickBtn.disabled = false;

    const track = capStream.getVideoTracks()[0];
    if (track) {
      try { track.contentHint = 'detail'; } catch (_) {} // 텍스트 위주 창 선명도 우선
      track.addEventListener('ended', stopCapture);      // 캡처 대상 창이 사라진 경우
    }
    // Wayland는 title이 없다(OS picker가 골랐다) → 트랙 라벨에서 창 이름을 얻는다.
    if (!title && track && track.label) title = track.label;

    capturing = true;
    capFallback = false;
    capName = String(title || 'APP').trim().slice(0, 30) || 'APP';
    localStorage.setItem('ingest-last-window', String(title || ''));

    appPreview.srcObject = capStream;
    appPreview.play().catch(() => {});
    appTitle.textContent = title || 'APP';
    appIdle.classList.add('hidden');
    appLive.classList.remove('hidden');

    connectCapWS();
  }

  function stopCapture() {
    capturing = false;
    clearTimeout(capReconnectTimer);
    stopCapFallback();
    cleanupCapPeers();
    if (capWs) {
      try { capWs.close(); } catch (_) {}
      capWs = null;
    }
    if (capStream) {
      for (const t of capStream.getTracks()) t.stop();
      capStream = null;
    }
    appPreview.srcObject = null;
    appLive.classList.add('hidden');
    appIdle.classList.remove('hidden');
    appMsg.textContent = '';
    updateResumeBtn();
  }

  // 창 목록 그리드
  let listOpen = false;
  let listTimer = null;

  async function refreshWinList() {
    let wins;
    try { wins = await window.ingestAPI.listWindows(); } catch (_) { return; }
    if (!listOpen) return; // 조회 중 목록이 닫힌 경우
    winList.innerHTML = '';
    if (!wins.length) {
      const empty = document.createElement('div');
      empty.className = 'win-empty';
      empty.textContent = '캡처할 수 있는 창이 없습니다.';
      winList.appendChild(empty);
      return;
    }
    for (const w of wins) {
      const item = document.createElement('div');
      item.className = 'win-item';
      const img = document.createElement('img');
      img.src = w.thumbnail;
      img.alt = '';
      const name = document.createElement('div');
      name.className = 'win-name';
      name.textContent = w.name;
      name.title = w.name;
      item.appendChild(img);
      item.appendChild(name);
      item.addEventListener('click', () => startCapture(w.id, w.name));
      winList.appendChild(item);
    }
  }

  function openWinList() {
    listOpen = true;
    winList.classList.remove('hidden');
    pickBtn.textContent = '목록 닫기';
    refreshWinList();
    clearInterval(listTimer);
    listTimer = setInterval(refreshWinList, 3000); // 열려 있는 동안만 3초마다 갱신
  }

  function closeWinList() {
    listOpen = false;
    clearInterval(listTimer);
    listTimer = null;
    winList.classList.add('hidden');
    winList.innerHTML = '';
    pickBtn.textContent = '창 선택';
  }

  // 지난 실행에서 캡처하던 창이 아직 열려 있으면 원클릭 재개 버튼 표시 (자동 시작은 안 함)
  async function updateResumeBtn() {
    resumeBtn.classList.add('hidden');
    if (!window.ingestAPI || capturing) return;
    const last = localStorage.getItem('ingest-last-window');
    if (!last) return;
    try {
      const wins = await window.ingestAPI.listWindows();
      if (wins.some((w) => w.name === last)) {
        resumeBtn.textContent = `이전 창 다시 캡처: ${last}`;
        resumeBtn.classList.remove('hidden');
      }
    } catch (_) {}
  }

  pickBtn.addEventListener('click', () => {
    // Wayland: 앱 자체 목록은 반쪽만 잡히므로 건너뛰고 OS picker를 바로 띄운다.
    if (window.ingestAPI && window.ingestAPI.isWayland) {
      startCapture(null, '');
      return;
    }
    if (listOpen) closeWinList();
    else openWinList();
  });

  resumeBtn.addEventListener('click', async () => {
    if (!window.ingestAPI) return;
    const last = localStorage.getItem('ingest-last-window');
    if (!last) return;
    let wins = [];
    try { wins = await window.ingestAPI.listWindows(); } catch (_) {}
    const hit = wins.find((w) => w.name === last); // 창 id는 실행마다 바뀌므로 제목으로 재탐색
    if (!hit) {
      appMsg.textContent = '이전에 캡처하던 창을 찾을 수 없습니다.';
      resumeBtn.classList.add('hidden');
      return;
    }
    startCapture(hit.id, hit.name);
  });

  stopCaptureBtn.addEventListener('click', stopCapture);

  // 시작
  async function init() {
    renderSlots();

    // APP 캡처는 Electron 앱(preload) 안에서만 가능
    if (!window.ingestAPI) {
      pickBtn.disabled = true;
      appMsg.textContent = 'APP 캡처는 Ingest Hub 앱 창에서만 사용할 수 있습니다.';
    }

    let info;
    try {
      const res = await fetch(`${API}/api/info`);
      info = await res.json();
    } catch (_) {
      setConn('err');
      return;
    }
    serverPort = info.port;

    const ips = info.ips || [];
    if (ips.length === 0) {
      addrLabel.classList.add('hidden');
      addrSelect.classList.add('hidden');
    } else {
      // 인터페이스가 여러 개면(예: 학교망 + Tailscale) 골라서 두 QR을 함께 바꿀 수 있다
      for (const ip of ips) {
        const opt = document.createElement('option');
        opt.value = ip;
        opt.textContent = `${ip} — ${ipLabel(ip)}`;
        addrSelect.appendChild(opt);
      }
      const saved = localStorage.getItem('phonecam-addr-ip');
      const current = ips.includes(saved) ? saved : ips[0];
      addrSelect.value = current;
      addrSelect.addEventListener('change', () => applyAddress(addrSelect.value));
      if (ips.length <= 1) {
        addrLabel.classList.add('hidden');
        addrSelect.classList.add('hidden');
      }
      await applyAddress(current);
    }

    connectObserver();
    updateResumeBtn();
  }

  // 미션 클록 + 시계
  // 미션 클록: 좌클릭 = 시작/일시정지 토글, 우클릭 = 리셋(확인)
  let clockRunning = false;
  let clockStartedAt = 0;    // 현재 구간 시작 시각 (epoch ms)
  let clockAccumulated = 0;  // 일시정지로 누적된 경과 (ms)

  function elapsedMs() {
    return clockAccumulated + (clockRunning ? Date.now() - clockStartedAt : 0);
  }

  missionClockEl.addEventListener('click', () => {
    if (clockRunning) {
      // 일시정지: 현재 구간을 누적에 합산
      clockAccumulated += Date.now() - clockStartedAt;
      clockRunning = false;
    } else {
      // 시작/재개
      clockStartedAt = Date.now();
      clockRunning = true;
    }
    missionClockEl.classList.toggle('armed', clockRunning);
    renderClocks();
  });

  missionClockEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!confirm('미션 클록을 리셋하시겠습니까?')) return;
    clockRunning = false;
    clockStartedAt = 0;
    clockAccumulated = 0;
    missionClockEl.classList.remove('armed');
    missionClockEl.textContent = 'T+ 00:00:00';
  });

  const two = (n) => String(n).padStart(2, '0');

  function renderClocks() {
    if (clockRunning || clockAccumulated > 0) {
      let s = Math.max(0, Math.floor(elapsedMs() / 1000));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      missionClockEl.textContent = `T+ ${two(h)}:${two(m)}:${two(s % 60)}`;
    }
    const now = new Date();
    localClockEl.textContent = `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
    utcClockEl.textContent = `${two(now.getUTCHours())}:${two(now.getUTCMinutes())}:${two(now.getUTCSeconds())}`;
  }
  setInterval(renderClocks, 250);
  renderClocks();

  init();
})();
