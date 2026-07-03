// 휴대폰 송출 페이지. 기본 WebRTC(P2P), 연결 실패 시 WebSocket 프레임 릴레이(보조 모드)로 전환.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const preview = $('preview');
  const previewOverlay = $('previewOverlay');
  const statusBadge = $('statusBadge');
  const statusText = $('statusText');
  const modeBadge = $('modeBadge');
  const modeText = $('modeText');
  const slotBadge = $('slotBadge');
  const slotText = $('slotText');
  const slotTag = $('slotTag');
  const nameInput = $('nameInput');
  const audioCheck = $('audioCheck');
  const startBtn = $('startBtn');
  const stopBtn = $('stopBtn');
  const flipBtn = $('flipBtn');
  const liveControls = $('liveControls');

  const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const CONNECT_TIMEOUT_MS = 10000; // 이 시간 안에 WebRTC 연결이 안 되면 보조 모드
  const FRAME_INTERVAL_MS = 100;    // 보조 모드 10fps
  const FRAME_MAX_WIDTH = 640;
  const FRAME_QUALITY = 0.55;

  let ws = null;
  let stream = null;
  let broadcasting = false;
  let fallback = false;
  let facing = 'environment';
  let reconnectTimer = null;
  let frameTimer = null;
  let wakeLock = null;

  const pcs = new Map();        // viewerId -> RTCPeerConnection
  const watchdogs = new Map();  // viewerId -> timeout id
  const pendingIce = new Map(); // viewerId -> candidate[]

  nameInput.value = localStorage.getItem('phonecam-name') || '';

  // 슬롯 지정 접속 (?slot=1|2). 1|2 외의 값은 무시.
  const slot = (() => {
    const v = new URLSearchParams(location.search).get('slot');
    return v === '1' || v === '2' ? Number(v) : null;
  })();
  if (slot) {
    slotTag.textContent = `CAM ${slot}`;
    slotTag.classList.remove('hidden');
    nameInput.placeholder = `CAM ${slot}`;
  }

  // UI
  function setStatus(kind, text) {
    statusBadge.className = 'badge ' + kind;
    statusText.textContent = text;
  }
  function setMode(text) {
    if (!text) {
      modeBadge.classList.add('hidden');
      return;
    }
    modeBadge.classList.remove('hidden');
    modeBadge.className = 'badge ' + (fallback ? 'warn' : 'ok');
    modeText.textContent = text;
  }
  // 서버가 배정한 슬롯 배지
  function setSlotBadge(n) {
    if (!n) {
      slotBadge.classList.add('hidden');
      return;
    }
    slotBadge.className = 'badge ok';
    slotText.textContent = `SLOT ${n}`;
  }

  // 카메라
  function videoConstraints(f = facing, exact = false) {
    return {
      facingMode: exact ? { exact: f } : { ideal: f },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    };
  }

  function explainGetUserMediaError(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
        return '카메라 권한이 거부되었습니다. 브라우저 설정에서 이 사이트의 카메라 권한을 허용해 주세요.';
      case 'NotFoundError':
        return '사용할 수 있는 카메라를 찾지 못했습니다.';
      case 'NotReadableError':
        return '다른 앱이 카메라를 사용 중입니다. 카메라를 쓰는 앱을 종료한 뒤 다시 시도해 주세요.';
      case 'OverconstrainedError':
        return '요청한 해상도/카메라를 지원하지 않는 기기입니다.';
      default:
        return '카메라를 열 수 없습니다: ' + (err && err.message ? err.message : err);
    }
  }

  async function openCamera() {
    const constraints = { video: videoConstraints(), audio: audioCheck.checked };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    preview.srcObject = stream;
    try { await preview.play(); } catch (_) { /* autoplay 정책 - muted라 대부분 통과 */ }
    previewOverlay.classList.add('hidden');
  }

  // 새 스트림을 프리뷰와 모든 피어에 교체 (iOS는 오디오 트랙도 함께 교체 필요)
  async function installStream(newStream) {
    const newVideo = newStream.getVideoTracks()[0] || null;
    const newAudio = newStream.getAudioTracks()[0] || null;
    for (const pc of pcs.values()) {
      for (const sender of pc.getSenders()) {
        if (!sender.track) continue;
        if (sender.track.kind === 'video' && newVideo) await sender.replaceTrack(newVideo);
        else if (sender.track.kind === 'audio' && newAudio) await sender.replaceTrack(newAudio);
      }
    }
    for (const t of stream.getTracks()) t.stop();
    stream = newStream;
    preview.srcObject = stream;
    try { await preview.play(); } catch (_) {}
  }

  async function flipCamera() {
    if (!stream) return;
    const prevFacing = facing;
    const target = facing === 'environment' ? 'user' : 'environment';
    const wantAudio = audioCheck.checked;
    flipBtn.disabled = true;

    // 다수 Android 기기는 전/후면 동시 오픈이 불가 → 기존 비디오 트랙을 먼저 정지
    const oldVideo = stream.getVideoTracks()[0];
    if (oldVideo) {
      oldVideo.stop();
      stream.removeTrack(oldVideo);
    }

    let acquired = null;
    try {
      acquired = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(target, true), audio: wantAudio });
    } catch (_) {
      try {
        acquired = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(target, false), audio: wantAudio });
      } catch (_) {}
    }

    if (acquired) {
      facing = target;
    } else {
      // 반대편 카메라를 못 열면 원래 카메라로 복구
      try {
        acquired = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(prevFacing, false), audio: wantAudio });
        facing = prevFacing;
        alert('이 기기에서 반대쪽 카메라를 열 수 없어 기존 카메라를 유지합니다.');
      } catch (err) {
        flipBtn.disabled = false;
        alert('카메라 전환 실패: ' + explainGetUserMediaError(err));
        return;
      }
    }

    await installStream(acquired);
    flipBtn.disabled = false;
  }

  // 화면 꺼짐 방지
  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (_) { /* 미지원/저전력 모드 등은 무시 */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && broadcasting) acquireWakeLock();
  });

  // WebSocket
  function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function connectWS() {
    ws = new WebSocket(`wss://${location.host}/ws`);

    ws.onopen = () => {
      wsSend({
        type: 'register',
        role: 'broadcaster',
        name: nameInput.value.trim() || undefined,
        slot: slot || undefined,
      });
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      handleMessage(msg);
    };

    ws.onclose = (ev) => {
      cleanupPeers();
      // 서버가 등록을 거부한 경우: 재연결하지 않고 송출을 종료한다
      if (ev.code === 4002) {
        alert('다른 기기가 이 슬롯으로 접속하여 송출이 종료되었습니다.');
        stopBroadcast();
        return;
      }
      if (ev.code === 4003) {
        alert('모든 카메라 슬롯이 사용 중입니다.');
        stopBroadcast();
        return;
      }
      if (!broadcasting) return;
      setStatus('warn', '연결 끊김 · 재연결 중…');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWS, 3000);
    };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'registered':
        setStatus('ok', fallback ? '송출 중 (보조 모드)' : '송출 중');
        setMode(fallback ? '보조 모드' : 'WebRTC');
        if (msg.slot) setSlotBadge(msg.slot);
        // 재연결 시 보조 모드였다면 그대로 이어서 방송
        if (fallback) wsSend({ type: 'fallback-start' });
        break;
      case 'watch':
        // 보조 모드 중에도 새 watch가 오면 WebRTC 복귀 시도
        startPeer(msg.from);
        break;
      case 'answer':
        onAnswer(msg.from, msg.sdp);
        break;
      case 'ice':
        onRemoteIce(msg.from, msg.candidate);
        break;
      case 'viewer-left':
        closePeer(msg.id);
        break;
      default:
        break;
    }
  }

  // WebRTC
  async function startPeer(viewerId) {
    closePeer(viewerId);
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcs.set(viewerId, pc);
    pendingIce.set(viewerId, []);

    for (const track of stream.getTracks()) pc.addTrack(track, stream);

    pc.onicecandidate = (e) => {
      if (e.candidate) wsSend({ type: 'ice', target: viewerId, candidate: e.candidate });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        clearTimeout(watchdogs.get(viewerId));
        watchdogs.delete(viewerId);
        if (fallback) exitFallback();
        setStatus('ok', '송출 중');
        setMode('WebRTC');
      } else if (state === 'failed') {
        enterFallback();
      }
    };

    // P2P 미연결 시 보조 모드로 전환. 이미 보조 모드면 재시도 피어만 정리.
    watchdogs.set(viewerId, setTimeout(() => {
      if (pc.connectionState !== 'connected') {
        if (fallback) closePeer(viewerId);
        else enterFallback();
      }
    }, CONNECT_TIMEOUT_MS));

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend({ type: 'offer', target: viewerId, sdp: pc.localDescription });
    } catch (_) {
      enterFallback();
    }
  }

  async function onAnswer(viewerId, sdp) {
    const pc = pcs.get(viewerId);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(sdp);
      const queued = pendingIce.get(viewerId) || [];
      pendingIce.set(viewerId, []);
      for (const c of queued) await pc.addIceCandidate(c).catch(() => {});
    } catch (_) {
      enterFallback();
    }
  }

  async function onRemoteIce(viewerId, candidate) {
    const pc = pcs.get(viewerId);
    if (!pc || !candidate) return;
    if (!pc.remoteDescription) {
      (pendingIce.get(viewerId) || []).push(candidate);
      return;
    }
    await pc.addIceCandidate(candidate).catch(() => {});
  }

  function closePeer(viewerId) {
    clearTimeout(watchdogs.get(viewerId));
    watchdogs.delete(viewerId);
    pendingIce.delete(viewerId);
    const pc = pcs.get(viewerId);
    if (pc) {
      pcs.delete(viewerId);
      try { pc.close(); } catch (_) {}
    }
  }

  function cleanupPeers() {
    for (const id of [...pcs.keys()]) closePeer(id);
  }

  // 보조 모드 (프레임 전송)
  const frameCanvas = document.createElement('canvas');
  const frameCtx = frameCanvas.getContext('2d');

  function enterFallback() {
    if (fallback || !broadcasting) return;
    fallback = true;
    cleanupPeers();
    wsSend({ type: 'fallback-start' });
    setStatus('ok', '송출 중 (보조 모드)');
    setMode('보조 모드');

    frameTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 1_000_000) return; // 네트워크가 밀리면 프레임 건너뜀
      if (preview.readyState < 2 || !preview.videoWidth) return;
      const scale = Math.min(1, FRAME_MAX_WIDTH / preview.videoWidth);
      frameCanvas.width = Math.round(preview.videoWidth * scale);
      frameCanvas.height = Math.round(preview.videoHeight * scale);
      frameCtx.drawImage(preview, 0, 0, frameCanvas.width, frameCanvas.height);
      wsSend({ type: 'frame', jpeg: frameCanvas.toDataURL('image/jpeg', FRAME_QUALITY) });
    }, FRAME_INTERVAL_MS);
  }

  function stopFallback() {
    clearInterval(frameTimer);
    frameTimer = null;
    fallback = false;
  }

  // WebRTC 복귀 성공 시: 프레임 전송을 멈추고 뷰어에게 알린다
  function exitFallback() {
    if (!fallback) return;
    stopFallback();
    wsSend({ type: 'fallback-stop' });
    setStatus('ok', '송출 중');
    setMode('WebRTC');
  }

  // 시작/종료
  async function startBroadcast() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('이 브라우저는 카메라 접근을 지원하지 않습니다.\nHTTPS 주소로 접속했는지, 최신 브라우저인지 확인해 주세요.');
      return;
    }
    startBtn.disabled = true;
    setStatus('warn', '카메라 여는 중…');
    try {
      await openCamera();
    } catch (err) {
      alert(explainGetUserMediaError(err));
      setStatus('err', '대기 중');
      startBtn.disabled = false;
      return;
    }
    localStorage.setItem('phonecam-name', nameInput.value.trim());
    broadcasting = true;
    fallback = false;
    setStatus('warn', '서버 연결 중…');
    connectWS();
    acquireWakeLock();

    startBtn.classList.add('hidden');
    liveControls.classList.remove('hidden');
    nameInput.disabled = true;
    audioCheck.disabled = true;
  }

  function stopBroadcast() {
    broadcasting = false;
    clearTimeout(reconnectTimer);
    stopFallback();
    cleanupPeers();
    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
      stream = null;
    }
    preview.srcObject = null;
    previewOverlay.classList.remove('hidden');
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
    setStatus('', '대기 중');
    setMode('');
    setSlotBadge(null);
    startBtn.classList.remove('hidden');
    startBtn.disabled = false;
    liveControls.classList.add('hidden');
    nameInput.disabled = false;
    audioCheck.disabled = false;
  }

  startBtn.addEventListener('click', startBroadcast);
  stopBtn.addEventListener('click', stopBroadcast);
  flipBtn.addEventListener('click', flipCamera);
})();
