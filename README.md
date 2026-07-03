# 🛰️ BEWE Streaming — 중앙 서버(라즈베리파이) 아키텍처

휴대폰 카메라 2대와 PC 창(앱) 화면을 **라즈베리파이 중앙 서버(central)** 로 모아
송출하고, **SpaceX 중계 스타일 3분할 관제 화면**으로 시청하는 시스템입니다.

v3에서는 서버를 각 PC(Ingest Hub 앱)가 아니라 **라즈베리파이에서 headless로
상시 구동**합니다. 폰 2대와 PC 화면은 전부 central로 송신하고, Mission Monitor는
central 주소를 고정으로 물어 수신합니다.

## 아키텍처

```
[폰1] ──https://100.123.59.3:8443/mobile?slot=1──┐
[폰2] ──https://100.123.59.3:8443/mobile?slot=2──┼──▶ [ raspb2-central ]         ◀── [Mission Monitor 앱]
[PC 화면] ─Ingest Hub 앱(central/ingest 로드,창캡처)┘      headless node 서버        (자동으로 100.123.59.3/monitor)
                                                    Tailscale 100.123.59.3:8443    또는 브라우저 /monitor
```

- **central**: `raspb2-central`, Tailscale IP `100.123.59.3`, 포트 `8443`.
  systemd 서비스(`bewe-server`)로 부팅 시 자동 구동.
- 브라우저 페이지(`/mobile`, `/monitor`, `/ingest`)는 모두 central이 직접 서빙하므로
  접속 주소가 곧 central 주소입니다. QR 코드·WebSocket 주소도 자동으로 central을 가리킵니다.

| 구성 | 실행 | 역할 |
|------|------|------|
| **중앙 서버** | `node server/standalone.js` (라파, systemd) | HTTPS+WebSocket 서버 상시 구동. 슬롯 배정/시그널링/프레임 릴레이, 폰·모니터·허브 페이지 서빙 |
| **BEWE Ingest Hub** | `ingest-main.js` | PC에서 실행. central의 `/ingest`에 접속해 실행 중인 창을 골라 슬롯3(APP)으로 캡처 송출 |
| **BEWE Mission Monitor** | `monitor-main.js` | 시작 시 central(`100.123.59.3`)에 자동 접속하는 관제 모니터. CAM 1 / CAM 2 / APP 고정 3슬롯, 미션 클록, 텔레메트리(해상도·fps·비트레이트·RTT) |

모니터 UI(`/monitor`)는 central이 서빙하는 순수 웹 페이지라서, Monitor 앱 없이
**일반 브라우저에서 `https://100.123.59.3:8443/monitor`를 열어도 동일하게 동작**합니다.

## 라즈베리파이 서버 배포

### 사전 조건

1. **Tailscale 연결**: 배포 PC와 라파가 같은 tailnet 안에 있어야 합니다.
   라파의 Tailscale IP는 `100.123.59.3`로 가정합니다(다르면 `deploy:central` 인자로 지정).
2. **SSH 공개키 등록**: 배포 스크립트는 비대화식 SSH를 씁니다.
   `ssh-copy-id dsa@100.123.59.3`로 미리 공개키를 등록하세요.
3. **원격 node 설치**: 라파에 node가 있어야 합니다(없으면 스크립트가 안내 후 중단).
   `sudo apt install -y nodejs npm` 또는 nodesource 배포판을 사용하세요.

### 배포 실행

```bash
npm run deploy:central                     # 기본 dsa@100.123.59.3 로 배포
npm run deploy:central -- pi@100.123.59.3  # HOST 지정
npm run deploy:central -- --no-service     # systemd 등록 없이 파일만 전송(수동 실행)
```

배포 스크립트(`scripts/deploy-central.sh`)가 하는 일:

1. SSH 연결 확인(실패 시 공개키 등록 안내).
2. 원격 node 존재 확인(없으면 설치 안내).
3. `server/`(`server.js`·`cert.js`·`standalone.js`), `public/`, `package.json`을
   rsync로 `~/bewe-server/`에 전송(`node_modules`·`release` 제외).
4. 원격에서 `npm install --omit=dev`(express/qrcode/selfsigned/ws — 전부 pure JS라 ARM OK).
5. `--no-service`가 아니면 `deploy/bewe-server.service` 템플릿을 원격 사용자/경로로 치환해
   `/etc/systemd/system/bewe-server.service`에 설치하고 `daemon-reload && enable --now`
   (sudo 비밀번호가 필요할 수 있습니다).
6. 방화벽 안내: Tailscale로만 접근한다면 UFW 등에서 `8443`을 `tailscale0` 인터페이스에
   한해 허용하는 것을 권장(강제 아님).
7. 완료 후 `curl -sk https://100.123.59.3:8443/api/info`로 검증 응답 출력.

### 로컬에서 서버만 띄워 검증

라파 없이 개발 PC에서 서버 동작만 확인할 때:

```bash
npm run server:local          # 기본 포트 8443
npm run server:local 8600     # 포트 지정
# 또는 직접:
BEWE_PORT=8600 node server/standalone.js
curl -sk https://127.0.0.1:8600/api/info    # {port, ips} 반환 확인
```

## 사용법

### 1) 휴대폰 2대 (CAM 1 / CAM 2)

Tailscale로 tailnet에 연결한 뒤 브라우저에서:

- 슬롯1(CAM 1): `https://100.123.59.3:8443/mobile?slot=1`
- 슬롯2(CAM 2): `https://100.123.59.3:8443/mobile?slot=2`

또는 Ingest Hub 화면의 QR 코드 2개를 스캔합니다.

- "연결이 비공개로 설정되어 있지 않습니다" 경고가 나오면 **고급 → 이동(계속)**.
  (서버가 직접 만든 사설 인증서라서 나오는 정상적인 경고입니다)
- **[방송 시작]** 버튼을 누르고 카메라 권한을 허용합니다.

### 2) PC 화면 (APP)

송출 PC에서 **Ingest Hub 앱**을 실행합니다.

```bash
npm run start:ingest
```

- 앱이 자동으로 central(`https://100.123.59.3:8443/ingest`)에 접속합니다.
  (서버가 아직 안 켜져 있으면 화면에 대기 안내가 뜨고, 켜지면 자동으로 로드됩니다)
- **APP 캡처** 카드에서 [창 선택] → 송출할 창을 클릭하면 그 창만 캡처되어
  슬롯3(APP)으로 송출됩니다.

### 3) 관제 (Mission Monitor)

관제 PC에서 **Mission Monitor 앱**을 실행합니다.

```bash
npm run start:monitor       # npm start 와 동일
```

- 앱이 시작 시 central(`100.123.59.3`)에 **자동 접속**합니다.
  서버가 꺼져 있으면 대기하다가 켜지면 자동으로 연결됩니다(재시도 루프).
- 수동 재접속이 필요하면 시작 화면에서 주소를 바꿔 다시 접속할 수 있습니다
  (기본값은 `100.123.59.3:8443`으로 프리필).
- 또는 브라우저에서 `https://100.123.59.3:8443/monitor` 접속.
- 레이아웃: 메인 1 + 사이드 2 (기본, 사이드 클릭 시 메인 승격) ↔ 3등분 — `l` 키 또는 버튼으로 전환.
- 패널 더블클릭 → 전체화면, 패널별 음소거 토글, 하단 미션 클록 `T+`.

## CENTRAL 주소·포트 변경

기본값은 `100.123.59.3:8443`입니다. 다른 주소를 쓰려면 환경변수로 지정합니다.

| 대상 | 변수 | 기본값 |
|------|------|--------|
| Ingest Hub / Mission Monitor 앱 | `BEWE_CENTRAL` (호스트), `BEWE_PORT` (포트) | `100.123.59.3` / `8443` |
| 서버(standalone) | `BEWE_PORT` (리슨 포트), `BEWE_CERT_DIR` (인증서 경로) | `8443` / `~/.config/bewe-server/cert` |

예:

```bash
BEWE_CENTRAL=100.99.0.5 BEWE_PORT=9000 npm run start:monitor
BEWE_PORT=9000 npm run start:server
```

## 전송 방식

| 모드 | 설명 |
|------|------|
| **WebRTC** (기본) | P2P 초저지연 스트리밍 |
| **보조 모드 (RELAY)** (자동 전환) | P2P가 막힌 네트워크에서 10초 안에 연결이 안 되면 자동으로 JPEG 프레임(10fps)을 서버 릴레이로 전송 |

## ⚠️ 보안 — Tailscale 신뢰망 전제

이 버전은 **인증(PIN/토큰)이 전혀 없습니다.** central 주소만 알면 누구나
모니터로 시청하고 방송자로 등록할 수 있습니다.

- 반드시 **Tailscale 등 본인 계정 기기로만 구성된 신뢰망** 안에서만 사용하세요.
- 공유기 포트포워딩, 공용 Wi-Fi, 공인 IP 등 **신뢰망 밖으로 포트(기본 8443)를
  절대 노출하지 마세요.** 라파에서도 UFW 등으로 `8443`을 `tailscale0`에만 여는 것을 권장합니다.
- HTTPS는 자체 서명 인증서로 전송 구간 암호화만 제공하며, 접속자 인증은 하지 않습니다.

## 개발

```bash
npm install
npm run server:local    # 로컬에서 중앙 서버만 띄워 검증 (BEWE_PORT로 포트 지정)
npm run start:ingest    # Ingest Hub 실행 (central 접속)
npm run start:monitor   # Mission Monitor 실행 (central 자동 접속, npm start와 동일)
```

## 테스트

```bash
npm test                # 시그널링 서버 통합 테스트 (슬롯 배정/중계/relay 검증)
npm run test:e2e        # 브라우저 E2E (모바일→모니터, 보조모드, APP 릴레이)
```

E2E 테스트는 Chrome이 필요합니다. 경로가 다르면 `CHROME_PATH` 환경변수로 지정하세요
(기본 `/usr/bin/google-chrome`).

## 빌드 (실행파일 만들기)

배포되는 실행파일은 **Ingest Hub / Mission Monitor 두 클라이언트 앱**입니다.
(서버는 라파에서 node로 직접 구동하므로 빌드 대상이 아닙니다.)

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
server/standalone.js          중앙 서버 부트스트랩 (Electron 없이 순수 node — 라파 headless 상시 구동)
server/server.js              HTTPS 정적 서버 + WebSocket 시그널링/슬롯 배정/프레임 릴레이
server/cert.js                자체 서명 인증서 생성/재사용 (IP 변경 시 재생성)
ingest-main.js                Ingest Hub Electron 메인 (central/ingest 로드 + 창 캡처 IPC)
ingest-preload.js             Ingest Hub preload (창 목록/선택 API 브리지)
monitor-main.js               Mission Monitor Electron 메인 (central 자동 접속 + 인증서 예외)
monitor-preload.js            Mission Monitor preload (connect API 브리지)
monitor-connect.html          모니터 시작/폴백 화면 (central 주소 프리필, 재시도)
public/mobile.*               휴대폰 송출 페이지 (getUserMedia + WebRTC + 보조 모드)
public/ingest.*               허브 UI (QR 2개, APP 캡처, 슬롯 상태판)
public/monitor.*              관제 모니터 페이지 (순수 웹 — 브라우저에서도 동작)
public/style.css              공용 스타일
deploy/bewe-server.service    systemd 서비스 템플릿 (배포 스크립트가 사용자/경로 치환)
scripts/deploy-central.sh     라파 중앙 서버 배포 (rsync + npm install + systemd 등록)
scripts/run-server-local.sh   로컬에서 서버만 띄워 검증
scripts/install-desktop.sh    Linux 바탕화면 아이콘 설치 스크립트
scripts/dist.sh               electron-builder 빌드 래퍼
test/signaling-test.js        시그널링 통합 테스트
test/e2e-test.js              모바일→모니터 E2E
test/fallback-e2e-test.js     보조 모드(RELAY) E2E
test/app-relay-e2e-test.js    APP 슬롯 릴레이 E2E
electron-builder.ingest.json  Ingest Hub 빌드 설정
electron-builder.monitor.json Mission Monitor 빌드 설정
```
