// 관제 모니터 페이지 (허브가 https://허브IP:PORT/monitor 로 서빙).
// 순수 웹 페이지 — Electron 전용 API를 쓰지 않으므로 일반 브라우저에서 열어도 동일하게 동작한다.
// 고정 3슬롯(CAM 1 / CAM 2 / APP)에 WebRTC 스트림 또는 보조 모드(RELAY) 프레임을 표시한다.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const layoutRoot = $('layoutRoot');
  const reconnectBanner = $('reconnectBanner');
  const connText = $('connText');
  const viewerCountEl = $('viewerCount');
  const unassignedEl = $('unassignedText');
  const hubAddrEl = $('hubAddr');
  const missionClockEl = $('missionClock');
  const clockBtn = $('clockBtn');
  const localClockEl = $('localClock');
  const utcClockEl = $('utcClock');
  const layoutBtn = $('layoutBtn');

  const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const SLOT_LABELS = { 1: 'CAM 1', 2: 'CAM 2', 3: 'APP' };

  let ws = null;
  let wsOpen = false;         // registered 수신 후 true
  let reconnectTimer = null;

  // ---------- 슬롯(피드) 상태 ----------
  const feeds = new Map();              // slot(1|2|3) -> feed 객체
  const slotOfBroadcaster = new Map();  // broadcasterId -> slot
  const unassigned = new Set();         // slot 없는 구버전 방송자 id (표시만)

  function feedOf(broadcasterId) {
    const slot = slotOfBroadcaster.get(broadcasterId);
    return slot ? feeds.get(slot) : null;
  }

  function makeFeed(slot) {
    const el = $('slot' + slot);
    const feed = {
      slot,
      el,
      video: el.querySelector('video.feed-video'),
      img: el.querySelector('img.feed-frame'),
      nameEl: el.querySelector('.feed-name'),
      modeEl: el.querySelector('.feed-mode'),
      statsEl: el.querySelector('.feed-stats'),
      nosignalEl: el.querySelector('.nosignal'),
      acquiringEl: el.querySelector('.acquiring'),
      statusEl: el.querySelector('.feed-status'),
      statusTextEl: el.querySelector('.feed-status-text'),
      muteBtn: el.querySelector('button.feed-mute'),
      id: null,          // 현재 이 슬롯을 점유한 방송자 id
      fallback: false,   // 보조 모드(RELAY) 여부
      pc: null,
      pendingIce: [],
      gotMedia: false,   // 실제 미디어(비디오 프레임/보조 프레임) 수신 여부 = LIVE
      // 텔레메트리 누적값 (1초 주기 델타 계산용)
      lastBytes: 0,
      lastFramesDecoded: 0,
      lastStatsTime: 0,
      relayFrames: 0,
      relayLastFrames: 0,
    };

    // WebRTC 비디오의 첫 프레임 도착 → LIVE
    feed.video.addEventListener('loadeddata', () => {
      if (!feed.id || feed.fallback || !feed.pc) return;
      setFeedMode(feed, 'webrtc');
      markLive(feed);
    });

    feed.muteBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // 패널 클릭(메인 승격)과 분리
      feed.video.muted = !feed.video.muted;
      feed.muteBtn.textContent = feed.video.muted ? 'MUTED' : 'AUDIO';
      feed.muteBtn.classList.toggle('on', !feed.video.muted);
    });

    // 사이드 패널 클릭 → 메인으로 승격 (layout-main 전용)
    el.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (layout === 'main' && mainSlot !== feed.slot) {
        mainSlot = feed.slot;
        applyLayout();
      }
    });

    // 더블클릭 → 해당 패널 전체화면
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      if (document.fullscreenElement) document.exitFullscreen();
      else el.requestFullscreen().catch(() => {});
    });

    return feed;
  }

  for (const slot of [1, 2, 3]) feeds.set(slot, makeFeed(slot));

  // ---------- 피드 표시 상태 ----------
  function setFeedStatus(feed, kind) {
    // kind: 'live' | 'acq' | 'off'
    feed.statusEl.className = 'feed-status ' + kind;
    feed.statusTextEl.textContent =
      kind === 'live' ? 'LIVE' : kind === 'acq' ? 'ACQUIRING' : 'NO SIGNAL';
  }

  function setFeedMode(feed, mode) {
    // mode: 'webrtc' | 'relay'
    if (mode === 'webrtc') {
      feed.video.classList.remove('hidden');
      feed.img.classList.add('hidden');
      feed.modeEl.textContent = 'WebRTC';
      feed.muteBtn.classList.remove('hidden');
    } else {
      feed.video.classList.add('hidden');
      feed.img.classList.remove('hidden');
      feed.modeEl.textContent = 'RELAY';
      feed.muteBtn.classList.add('hidden'); // 보조 모드는 영상만 전송됨
    }
  }

  function markLive(feed) {
    feed.gotMedia = true;
    feed.acquiringEl.classList.add('hidden');
    feed.nosignalEl.classList.add('hidden');
    setFeedStatus(feed, 'live');
    updateConn();
  }

  function attachFeed(feed, b) {
    if (feed.id && feed.id !== b.id) detachFeed(feed); // last-wins 방어 (서버가 left를 먼저 보냄)
    feed.id = b.id;
    slotOfBroadcaster.set(b.id, feed.slot);
    feed.nameEl.textContent = b.name || SLOT_LABELS[feed.slot];
    feed.fallback = !!b.fallback;
    feed.gotMedia = false;
    feed.nosignalEl.classList.add('hidden');
    feed.acquiringEl.classList.remove('hidden');
    setFeedStatus(feed, 'acq');
    // 보조 모드 방송자에게도 watch를 보낸다 — WebRTC 복귀 재시도,
    // 실패하면 그대로 보조 모드 프레임을 계속 받는다
    wsSend({ type: 'watch', target: b.id });
    updateConn();
  }

  function detachFeed(feed) {
    if (feed.id) slotOfBroadcaster.delete(feed.id);
    closePC(feed);
    feed.id = null;
    feed.fallback = false;
    feed.gotMedia = false;
    feed.video.srcObject = null;
    feed.video.classList.add('hidden');
    feed.img.classList.add('hidden');
    feed.img.removeAttribute('src');
    feed.nameEl.textContent = SLOT_LABELS[feed.slot];
    feed.modeEl.textContent = '';
    feed.statsEl.textContent = '';
    feed.muteBtn.classList.add('hidden');
    feed.lastBytes = 0;
    feed.lastFramesDecoded = 0;
    feed.lastStatsTime = 0;
    feed.relayFrames = 0;
    feed.relayLastFrames = 0;
    feed.acquiringEl.classList.add('hidden');
    feed.nosignalEl.classList.remove('hidden');
    setFeedStatus(feed, 'off');
    updateConn();
  }

  function closePC(feed) {
    if (feed.pc) {
      try { feed.pc.close(); } catch (_) {}
      feed.pc = null;
    }
    feed.pendingIce = [];
  }

  // ---------- WebRTC (방송자가 offer를 보내고 모니터가 answer) ----------
  async function onOffer(broadcasterId, sdp) {
    // 보조 모드 중에도 offer를 받는다 — 방송자의 WebRTC 복귀 시도
    const feed = feedOf(broadcasterId);
    if (!feed || feed.id !== broadcasterId) return;
    closePC(feed);

    const pc = new RTCPeerConnection(RTC_CONFIG);
    feed.pc = pc;

    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (feed.video.srcObject !== stream) {
        feed.video.srcObject = stream;
        playVideo(feed);
      }
      // 보조 모드 중 복귀 협상이면 fallback-stop이 올 때까지 프레임 표시 유지
      if (!feed.fallback) setFeedMode(feed, 'webrtc');
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) wsSend({ type: 'ice', target: broadcasterId, candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (feed.pc !== pc) return;
      if (pc.connectionState === 'failed' && !feed.fallback) {
        // 방송자 쪽 워치독이 보조 모드로 전환해 줄 때까지 대기 표시
        feed.gotMedia = false;
        feed.acquiringEl.classList.remove('hidden');
        setFeedStatus(feed, 'acq');
        updateConn();
      }
    };

    try {
      await pc.setRemoteDescription(sdp);
      for (const c of feed.pendingIce) await pc.addIceCandidate(c).catch(() => {});
      feed.pendingIce = [];
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend({ type: 'answer', target: broadcasterId, sdp: pc.localDescription });
    } catch (_) {
      // 실패 시 방송자 워치독이 보조 모드로 전환한다
    }
  }

  async function onIce(broadcasterId, candidate) {
    const feed = feedOf(broadcasterId);
    if (!feed || !candidate) return;
    if (!feed.pc || !feed.pc.remoteDescription) {
      feed.pendingIce.push(candidate);
      return;
    }
    await feed.pc.addIceCandidate(candidate).catch(() => {});
  }

  async function playVideo(feed) {
    try {
      await feed.video.play();
    } catch (_) {
      // 자동 재생이 소리 때문에 막히면 음소거 후 재생
      feed.video.muted = true;
      feed.muteBtn.textContent = 'MUTED';
      feed.muteBtn.classList.remove('on');
      feed.video.play().catch(() => {});
    }
  }

  // ---------- 텔레메트리 (1초 주기 getStats) ----------
  function formatBitrate(bps) {
    if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' Mbps';
    return Math.round(bps / 1000) + ' kbps';
  }

  async function pollStats(feed) {
    if (!feed.id) return;

    if (feed.fallback) {
      // 보조 모드: 수신 프레임 수로 fps만 추정
      const fps = feed.relayFrames - feed.relayLastFrames;
      feed.relayLastFrames = feed.relayFrames;
      feed.statsEl.textContent = feed.gotMedia ? `≈ ${fps}fps` : '';
      return;
    }
    if (!feed.pc) return;

    let stats;
    try { stats = await feed.pc.getStats(); } catch (_) { return; }

    let w = 0, h = 0, fps = null, bytes = 0, framesDecoded = 0, rtt = null;
    stats.forEach((r) => {
      if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
        w = r.frameWidth || 0;
        h = r.frameHeight || 0;
        if (typeof r.framesPerSecond === 'number') fps = Math.round(r.framesPerSecond);
        bytes = r.bytesReceived || 0;
        framesDecoded = r.framesDecoded || 0;
      } else if (
        r.type === 'candidate-pair' &&
        (r.nominated || r.selected) &&
        r.state === 'succeeded' &&
        typeof r.currentRoundTripTime === 'number'
      ) {
        rtt = Math.round(r.currentRoundTripTime * 1000);
      }
    });

    const now = performance.now();
    let bitrateText = '—';
    if (feed.lastStatsTime && bytes >= feed.lastBytes) {
      const bps = ((bytes - feed.lastBytes) * 8000) / (now - feed.lastStatsTime);
      bitrateText = formatBitrate(bps);
    }
    // framesPerSecond 미지원 브라우저 → framesDecoded 델타로 추정
    if (fps === null) {
      fps = feed.lastStatsTime
        ? Math.max(0, Math.round(((framesDecoded - feed.lastFramesDecoded) * 1000) / (now - feed.lastStatsTime)))
        : 0;
    }
    feed.lastBytes = bytes;
    feed.lastFramesDecoded = framesDecoded;
    feed.lastStatsTime = now;

    if (!w || !feed.gotMedia) {
      feed.statsEl.textContent = '';
      return;
    }
    const rttText = rtt === null ? 'RTT —' : `RTT ${rtt}ms`;
    feed.statsEl.textContent = `${w}×${h} · ${fps}fps · ${bitrateText} · ${rttText}`;
  }

  setInterval(() => {
    for (const feed of feeds.values()) pollStats(feed);
  }, 1000);

  // ---------- 레이아웃 (layout-main / layout-triple) ----------
  let layout = localStorage.getItem('monitor-layout') === 'triple' ? 'triple' : 'main';
  let mainSlot = parseInt(localStorage.getItem('monitor-main-slot'), 10);
  if (![1, 2, 3].includes(mainSlot)) mainSlot = 3; // 기본 메인 = slot3(APP)

  function applyLayout() {
    layoutRoot.classList.toggle('layout-main', layout === 'main');
    layoutRoot.classList.toggle('layout-triple', layout === 'triple');
    for (const feed of feeds.values()) {
      feed.el.classList.toggle('is-main', layout === 'main' && feed.slot === mainSlot);
    }
    layoutBtn.textContent = layout === 'main' ? 'LAYOUT: MAIN' : 'LAYOUT: TRIPLE';
    localStorage.setItem('monitor-layout', layout);
    localStorage.setItem('monitor-main-slot', String(mainSlot));
  }

  function toggleLayout() {
    layout = layout === 'main' ? 'triple' : 'main';
    applyLayout();
  }

  layoutBtn.addEventListener('click', toggleLayout);
  document.addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.code === 'KeyL' || e.key === 'l' || e.key === 'L') toggleLayout();
  });

  // ---------- 미션 클록 + 시계 ----------
  let t0 = null; // 카운트 시작 시각 (epoch ms), null = 정지

  clockBtn.addEventListener('click', () => {
    if (t0 === null) {
      t0 = Date.now();
      clockBtn.textContent = 'RESET';
      clockBtn.classList.add('armed');
    } else if (confirm('미션 클록을 리셋할까요?')) {
      t0 = null;
      clockBtn.textContent = 'T-0 START';
      clockBtn.classList.remove('armed');
      missionClockEl.textContent = 'T+ 00:00:00';
    }
  });

  const two = (n) => String(n).padStart(2, '0');

  function renderClocks() {
    if (t0 !== null) {
      let s = Math.max(0, Math.floor((Date.now() - t0) / 1000));
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

  // ---------- 하단 상태 바 ----------
  function updateConn() {
    if (!wsOpen) {
      connText.textContent = '서버 재연결 중…';
      return;
    }
    let live = 0;
    for (const feed of feeds.values()) if (feed.id && feed.gotMedia) live++;
    connText.textContent = live > 0 ? `${live} FEED${live === 1 ? '' : 'S'} LIVE` : 'STANDBY';
  }

  function updateUnassigned() {
    unassignedEl.textContent = unassigned.size > 0 ? `미배정 피드 ${unassigned.size}` : '';
  }

  // ---------- WebSocket ----------
  function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function routeBroadcaster(b) {
    const slot = Number(b.slot);
    if (slot === 1 || slot === 2 || slot === 3) {
      attachFeed(feeds.get(slot), b);
    } else {
      // slot 없는 구버전 방송자 — 패널에 띄우지 않고 하단 바에 개수만 표기
      unassigned.add(b.id);
      updateUnassigned();
    }
  }

  function connectWS() {
    ws = new WebSocket(`wss://${location.host}/ws`);

    ws.onopen = () => {
      wsSend({ type: 'register', role: 'viewer' });
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      handleMessage(msg);
    };

    ws.onclose = () => {
      wsOpen = false;
      for (const feed of feeds.values()) if (feed.id) detachFeed(feed);
      unassigned.clear();
      updateUnassigned();
      reconnectBanner.classList.remove('hidden');
      updateConn();
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWS, 3000);
    };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'registered':
        wsOpen = true;
        reconnectBanner.classList.add('hidden');
        for (const b of msg.broadcasters || []) routeBroadcaster(b);
        updateConn();
        break;
      case 'broadcaster-joined':
        routeBroadcaster({ id: msg.id, name: msg.name, slot: msg.slot, kind: msg.kind, fallback: false });
        break;
      case 'broadcaster-left': {
        if (unassigned.delete(msg.id)) {
          updateUnassigned();
          break;
        }
        const feed = feedOf(msg.id);
        if (feed) detachFeed(feed);
        break;
      }
      case 'offer':
        onOffer(msg.from, msg.sdp);
        break;
      case 'ice':
        onIce(msg.from, msg.candidate);
        break;
      case 'fallback-start': {
        const feed = feedOf(msg.from);
        if (feed) {
          feed.fallback = true;
          closePC(feed);
        }
        break;
      }
      case 'fallback-stop': {
        const feed = feedOf(msg.from);
        if (!feed) break;
        feed.fallback = false;
        feed.relayFrames = 0;
        feed.relayLastFrames = 0;
        if (feed.pc && feed.video.srcObject) {
          // 복귀 협상이 이미 끝난 상태 — 화면만 WebRTC로 전환
          setFeedMode(feed, 'webrtc');
        } else {
          wsSend({ type: 'watch', target: msg.from });
          feed.gotMedia = false;
          feed.acquiringEl.classList.remove('hidden');
          setFeedStatus(feed, 'acq');
          updateConn();
        }
        break;
      }
      case 'frame': {
        const feed = feedOf(msg.from);
        // 명시적 fallback 신호(fallback-start/등록 목록)가 있을 때만 렌더링 —
        // WebRTC 복귀 직후 도착하는 잔여 프레임이 화면을 되돌리지 않게 한다
        if (!feed || !feed.fallback) break;
        if (!feed.gotMedia || feed.img.classList.contains('hidden')) setFeedMode(feed, 'relay');
        feed.img.src = msg.jpeg;
        feed.relayFrames++;
        if (!feed.gotMedia) markLive(feed);
        break;
      }
      case 'viewer-count':
        viewerCountEl.textContent = String(msg.count);
        break;
      default:
        break;
    }
  }

  // ---------- 시작 ----------
  // 최초 접속 전에는 HTML 기본값 "CONNECTING…"을 유지한다 (registered 수신 시 갱신)
  hubAddrEl.textContent = location.host;
  applyLayout();
  connectWS();
})();
