# 🛰️ BEWE Streaming — Ingest Hub + Mission Monitor

휴대폰 카메라 2대와 PC 창(앱) 화면을 한곳에 모아 송출하고,
**SpaceX 중계 스타일 3분할 관제 화면**으로 시청하는 두 개의 Electron 앱입니다.

| 앱 | 실행 파일 | 역할 |
|----|-----------|------|
| **BEWE Ingest Hub** | `ingest-main.js` | 내장 HTTPS+WebSocket 서버 기동. 휴대폰 2대용 QR 코드 표시(슬롯1 = CAM 1, 슬롯2 = CAM 2), 실행 중인 창을 골라 슬롯3(APP)으로 캡처 송출, 슬롯별 연결 상태판 |
| **BEWE Mission Monitor** | `monitor-main.js` | 허브 IP를 입력해 접속하는 관제 모니터. CAM 1 / CAM 2 / APP 고정 3슬롯, 미션 클록, 텔레메트리(해상도·fps·비트레이트·RTT) 표시 |

모니터 UI(`/monitor`)는 허브가 서빙하는 순수 웹 페이지라서, Monitor 앱 없이
**일반 브라우저에서 `https://허브IP:8443/monitor`를 열어도 동일하게 동작**합니다.

## 사용 시나리오

1. 송출 PC에서 **Ingest Hub**를 실행합니다. (내장 서버가 시작되고 QR 코드 2개가 표시됨)
2. 상단의 **접속 주소 선택**에서 인터페이스를 고릅니다.
   - 같은 공유기 안이면 `192.168.x.x`, 외부/원격이면 Tailscale 주소(`100.x.x.x`)를 선택.
3. 휴대폰 2대로 각각 QR 코드를 스캔합니다. (슬롯1 QR → CAM 1, 슬롯2 QR → CAM 2)
   - "연결이 비공개로 설정되어 있지 않습니다" 경고가 나오면 **고급 → 이동(계속)**.
     (앱이 직접 만든 사설 인증서라서 나오는 정상적인 경고입니다)
   - **[방송 시작]** 버튼을 누르고 카메라 권한을 허용합니다.
4. Ingest Hub의 **APP 캡처** 카드에서 [창 선택] → 송출할 창을 클릭하면
   그 창만 캡처되어 슬롯3(APP)으로 송출됩니다.
5. 관제 PC에서 **Mission Monitor**를 실행하고 허브 IP를 입력해 접속합니다.
   (또는 브라우저에서 `https://허브IP:8443/monitor` 접속)
   - 레이아웃: 메인 1 + 사이드 2 (기본, 사이드 클릭 시 메인 승격) ↔ 3등분 — `l` 키 또는 버튼으로 전환
   - 패널 더블클릭 → 전체화면, 패널별 음소거 토글, 하단 미션 클록 `T+`

## 전송 방식

| 모드 | 설명 |
|------|------|
| **WebRTC** (기본) | P2P 초저지연 스트리밍 |
| **보조 모드 (RELAY)** (자동 전환) | P2P가 막힌 네트워크에서 10초 안에 연결이 안 되면 자동으로 JPEG 프레임(10fps)을 서버 릴레이로 전송 |

## ⚠️ 보안 — Tailscale 신뢰망 전제

이 버전은 **인증(PIN/토큰)이 전혀 없습니다.** 서버 주소만 알면 누구나
모니터로 시청하고 방송자로 등록할 수 있습니다.

- 반드시 **Tailscale 등 본인 계정 기기로만 구성된 신뢰망** 안에서만 사용하세요.
- 공유기 포트포워딩, 공용 Wi-Fi, 공인 IP 등 **신뢰망 밖으로 포트(기본 8443)를
  절대 노출하지 마세요.**
- HTTPS는 자체 서명 인증서로 전송 구간 암호화만 제공하며, 접속자 인증은 하지 않습니다.

## 개발

```bash
npm install
npm run start:ingest    # Ingest Hub 실행 (npm start와 동일)
npm run start:monitor   # Mission Monitor 실행
```

## 테스트

```bash
npm test                # 시그널링 서버 통합 테스트 (슬롯 배정/중계/relay 검증)
npm run test:e2e        # 브라우저 E2E (모바일→모니터, 보조모드, APP 릴레이)
```

E2E 테스트는 Chrome이 필요합니다. 경로가 다르면 `CHROME_PATH` 환경변수로 지정하세요
(기본 `/usr/bin/google-chrome`).

## 빌드 (실행파일 만들기)

```bash
npm run dist:ingest:linux    # Ingest Hub Linux AppImage → release/ingest/
npm run dist:ingest:win      # Ingest Hub Windows portable → release/ingest/
npm run dist:monitor:linux   # Mission Monitor Linux AppImage → release/monitor/
npm run dist:monitor:win     # Mission Monitor Windows portable → release/monitor/
```

- Linux에서 Windows용 빌드는 그대로 동작하지만, 실행파일에 아이콘/버전 정보를
  넣으려면 Windows에서 빌드하세요 (`signAndEditExecutable` 옵션 참고).
- AppImage 실행에는 FUSE가 필요합니다. Ubuntu 22.04+에서는 `sudo apt install libfuse2`,
  또는 FUSE 없이 `./앱이름-*.AppImage --appimage-extract-and-run`으로 실행하세요.

## 바탕화면 설치 (Linux)

빌드된 AppImage를 바탕화면 아이콘 + 앱 메뉴로 설치합니다.

```bash
npm run dist:monitor:linux   # 먼저 빌드
npm run install:monitor      # Mission Monitor 바탕화면 설치
npm run install:ingest       # Ingest Hub 바탕화면 설치
npm run install:desktop      # 둘 다 설치
```

- AppImage는 `~/.local/opt/bewe/`로 복사되고, 런처가 앱 메뉴와 바탕화면에 등록됩니다.
- 바탕화면 아이콘이 "실행 안 됨"으로 나오면: 아이콘 우클릭 → **실행 허용(Allow Launching)**.
  (스크립트가 GNOME 신뢰 플래그를 자동 설정하지만, 일부 환경은 수동 허용 필요)

## 구조

```
ingest-main.js                Ingest Hub Electron 메인 (내장 서버 시작 + 창 캡처 IPC)
ingest-preload.js             Ingest Hub preload (창 목록/선택 API 브리지)
monitor-main.js               Mission Monitor Electron 메인 (허브 접속 + 인증서 예외)
monitor-preload.js            Mission Monitor preload (connect API 브리지)
monitor-connect.html          모니터 시작 화면 (허브 IP 입력, 최근 접속 목록)
server/server.js              HTTPS 정적 서버 + WebSocket 시그널링/슬롯 배정/프레임 릴레이
server/cert.js                자체 서명 인증서 생성/재사용 (IP 변경 시 재생성)
public/mobile.*               휴대폰 송출 페이지 (getUserMedia + WebRTC + 보조 모드)
public/ingest.*               허브 UI (QR 2개, APP 캡처, 슬롯 상태판)
public/monitor.*              관제 모니터 페이지 (순수 웹 — 브라우저에서도 동작)
public/style.css              공용 스타일
test/signaling-test.js        시그널링 통합 테스트
test/e2e-test.js              모바일→모니터 E2E
test/fallback-e2e-test.js     보조 모드(RELAY) E2E
test/app-relay-e2e-test.js    APP 슬롯 릴레이 E2E
electron-builder.ingest.json  Ingest Hub 빌드 설정
electron-builder.monitor.json Mission Monitor 빌드 설정
scripts/install-desktop.sh    Linux 바탕화면 아이콘 설치 스크립트
```
