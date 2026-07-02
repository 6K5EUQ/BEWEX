// 휴대폰 송출 페이지.
// 기본은 WebRTC(P2P) 전송이고, 일정 시간 안에 연결되지 않으면
// 캔버스 캡처 프레임을 WebSocket으로 릴레이하는 보조 모드로 자동 전환한다.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const preview = $('preview');
  const previewOverlay = $('previewOverlay');
  const statusBadge = $('statusBadge');
  const statusText = $('statusText');
  const modeBadge = $('modeBadge');
  const modeText = $('modeText');
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

  // ---------- UI ----------
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

  // ---------- 카메라 ----------
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

  // 새 스트림을 프리뷰와 모든 피어 연결에 갈아끼운다.
  // (iOS는 새 getUserMedia가 기존 캡처를 죽이므로 오디오 트랙도 함께 교체해야 한다)
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

  // ---------- 화면 꺼짐 방지 ----------
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

  // ---------- WebSocket ----------
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
      });
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      handleMessage(msg);
    };

    ws.onclose = () => {
      cleanupPeers();
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
        // 재연결 시 보조 모드였다면 그대로 이어서 방송
        if (fallback) wsSend({ type: 'fallback-start' });
        break;
      case 'watch':
        // 보조 모드 중이어도 뷰어가 새로 watch를 보내면 WebRTC 복귀를 시도한다
        // (연결이 붙으면 exitFallback, 실패하면 워치독이 재시도 피어만 정리)
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

  // ---------- WebRTC ----------
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

    // 일정 시간 안에 P2P가 안 붙으면 보조 모드로 전환.
    // 이미 보조 모드라면(=복귀 재시도 실패) 재시도 피어만 조용히 정리한다.
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

  // ---------- 보조 모드 (프레임 전송) ----------
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

  // ---------- 시작/종료 ----------
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
