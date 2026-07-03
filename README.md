# BEWEX — 중앙 서버(라즈베리파이) 스트리밍 관제

휴대폰 카메라 2대와 PC 창 화면을 라즈베리파이 중앙 서버(central)로 모아
송출하고, 3분할 관제 화면으로 시청하는 시스템입니다.

## 동작 구조

- 세 개의 소스가 central로 영상을 보냅니다: **폰 2대**(브라우저로 접속) + **PC 창 1개**(BEWEX Hub 앱).
- central은 라즈베리파이에서 headless로 상시 구동하며, 소스를 3개 슬롯에 배정하고
  BEWEX Monitor로 중계합니다.
- **BEWEX Monitor**는 central에 자동 접속해 3슬롯을 한 화면에 관제합니다.
- 슬롯 3개 고정: 슬롯1 = **CAM 1**, 슬롯2 = **CAM 2**, 슬롯3 = **BEWE**(PC 창 캡처).
- 기본 전송은 WebRTC(P2P). 막힌 네트워크에서는 서버 릴레이(RELAY)로 자동 전환.

```
[폰1] ─┐
[폰2] ─┼──▶ [ central 서버 ] ──▶ [BEWEX Monitor]
[PC창] ─┘     (라파, headless)      CAM 1 / CAM 2 / BEWE
```

BEWEX Hub / BEWEX Monitor 앱은 UI를 로컬 소스(`public/*.html`)에서 직접 로드하고
central에는 WebSocket 시그널링·프레임만 붙습니다. 서버가 꺼져 있어도 창은 뜨고
연결만 재시도합니다. 브라우저로 `/ingest`·`/monitor`를 열면 central이 같은 페이지를
서빙하므로 동일하게 동작합니다.

| 구성 | 실행 | 역할 |
|------|------|------|
| 중앙 서버 | `node server/standalone.js` (라파, systemd) | HTTPS+WebSocket 서버 상시 구동. 슬롯 배정/시그널링/프레임 릴레이, 폰(`/mobile`)·모니터(`/monitor`)·허브(`/ingest`) 페이지 서빙 |
| BEWEX Hub | `ingest-main.js` | PC에서 실행. 로컬 UI를 띄우고 실행 중인 창을 골라 슬롯3(BEWE, 프로토콜상 `kind:'app'`)으로 캡처 송출 |
| BEWEX Monitor | `monitor-main.js` | central에 자동 접속하는 관제 모니터. CAM 1 / CAM 2 / BEWE 고정 3슬롯, 미션 클록, 텔레메트리(해상도·fps·비트레이트·RTT) |

모니터 UI(`/monitor`)는 순수 웹 페이지라서 BEWEX Monitor 앱 없이 일반 브라우저에서
열어도 동일하게 동작합니다.

## 설치 (클라이언트 PC)

폰은 브라우저만 있으면 되고, PC 두 대(송출용·관제용)에만 앱을 깔면 됩니다.

```bash
git clone <repo> && cd BEWEX
npm install                  # 의존성 설치 (최초 1회)
```

### 데스크톱 아이콘 생성 (Linux)

바탕화면 아이콘이 이 저장소의 소스를 직접 실행합니다(빌드 불필요, `git pull`이면 최신).

```bash
npm run install:desktop      # BEWEX Hub + BEWEX Monitor 아이콘 둘 다 생성
npm run install:ingest       # BEWEX Hub 아이콘만
npm run install:monitor      # BEWEX Monitor 아이콘만
```

아이콘 없이 바로 실행:

```bash
npm run start:ingest         # BEWEX Hub (창 캡처 송출)
npm run start:monitor        # BEWEX Monitor (3분할 관제)
```

> 아이콘이 "실행 안 됨"으로 나오면 우클릭 → 실행 허용(Allow Launching).

## 라즈베리파이 서버 배포

### 사전 조건

1. Tailscale 연결: 배포 PC와 라파가 같은 tailnet 안에 있어야 합니다.
   라파의 Tailscale IP는 `100.123.59.3`로 가정합니다(다르면 `deploy:central` 인자로 지정).
2. SSH 공개키 등록: `ssh-copy-id raspb2@100.123.59.3`로 미리 등록하세요(스크립트는 비대화식 SSH 사용).
3. 원격 node 설치: 라파에 node 필요(없으면 스크립트가 안내 후 중단).
   `sudo apt install -y nodejs npm` 또는 nodesource 배포판.

### 배포 실행

```bash
npm run deploy:central                     # 기본 raspb2@100.123.59.3 로 배포
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
   `/etc/systemd/system/bewe-server.service`에 설치하고 `daemon-reload && enable --now`(sudo 필요).
6. 방화벽 안내: `8443`을 `tailscale0` 인터페이스에만 허용하도록 권장(강제 아님).
7. `curl -sk https://100.123.59.3:8443/api/info`로 검증.

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

- 슬롯1(CAM 1): `https://<central>/mobile?slot=1`
- 슬롯2(CAM 2): `https://<central>/mobile?slot=2`

가장 쉬운 방법은 BEWEX Hub 화면의 QR 코드 2개를 스캔하는 것입니다(주소를 몰라도 됨).

- "연결이 비공개로 설정되어 있지 않습니다" 경고가 나오면 고급 → 이동(계속).
  (자체 서명 인증서라서 나오는 정상 경고)
- [방송 시작] 버튼을 누르고 카메라 권한을 허용합니다.

### 2) PC 화면 (BEWE)

송출 PC에서 BEWEX Hub 앱을 실행합니다.

```bash
npm run start:ingest
```

- 앱이 로컬 UI를 띄우고 WS만 central에 붙습니다.
  (서버가 꺼져 있으면 창은 뜬 채로 연결만 재시도, 켜지면 자동 접속)
- BEWE 캡처 카드에서 [창 선택] → 송출할 창을 클릭하면 그 창만 슬롯3(BEWE)으로 송출됩니다.
- Wayland/PipeWire 세션에서는 창 클릭 시 OS 화면 선택 창(xdg-desktop-portal)이 떠서
  실제 창을 고릅니다. X11은 앱 목록에서 고른 창을 바로 캡처합니다.

### 3) 관제 (BEWEX Monitor)

관제 PC에서 BEWEX Monitor 앱을 실행합니다.

```bash
npm run start:monitor       # npm start 와 동일
```

- 앱이 시작 시 central에 자동 접속합니다(꺼져 있으면 재시도 루프).
- 수동 재접속은 시작 화면에서 주소를 바꿔 접속(기본 central 주소가 프리필됨).
- 또는 브라우저에서 `https://<central>/monitor` 접속.
- 레이아웃: 메인 1 + 사이드 2(사이드 클릭 시 메인 승격) ↔ 3등분 — `l` 키 또는 버튼으로 전환.
- 패널 더블클릭 → 전체화면, 패널별 음소거 토글, 하단 미션 클록 `T+`.

## CENTRAL 주소·포트 변경

기본값은 `100.123.59.3:8443`입니다. 다른 주소를 쓰려면 환경변수로 지정합니다.

| 대상 | 변수 | 기본값 |
|------|------|--------|
| BEWEX Hub / BEWEX Monitor 앱 | `BEWE_CENTRAL` (호스트), `BEWE_PORT` (포트) | `100.123.59.3` / `8443` |
| 서버(standalone) | `BEWE_PORT` (리슨 포트), `BEWE_CERT_DIR` (인증서 경로), `BEWE_PUBLIC_HOST` (공개 주소 고정) | `8443` / `~/.config/bewe-server/cert` / (미설정=자동 감지) |

`BEWE_PUBLIC_HOST`를 지정하면 `/api/info`·QR·접속 주소가 그 주소 하나로 고정됩니다
(예: Tailscale IP `100.123.59.3`). 인증서(SAN)는 모든 로컬 IP를 커버하므로
localhost·LAN 접속에서도 경고 없이 붙습니다. `deploy:central`은 배포 대상 IP를
자동으로 이 값에 넣습니다.

예:

```bash
BEWE_CENTRAL=100.99.0.5 BEWE_PORT=9000 npm run start:monitor
BEWE_PORT=9000 npm run start:server
```

## 전송 방식

| 모드 | 설명 |
|------|------|
| WebRTC (기본) | P2P 저지연 스트리밍 |
| 보조 모드 (RELAY) | P2P가 막힌 네트워크에서 10초 안에 연결이 안 되면 자동으로 JPEG 프레임(10fps)을 서버 릴레이로 전송 |

## 보안 — Tailscale 신뢰망 전제

이 버전은 인증(PIN/토큰)이 없습니다. central 주소만 알면 누구나 모니터로
시청하고 방송자로 등록할 수 있습니다.

- Tailscale 등 본인 계정 기기로만 구성된 신뢰망 안에서만 사용하세요.
- 포트포워딩, 공용 Wi-Fi, 공인 IP 등 신뢰망 밖으로 포트(기본 8443)를 노출하지 마세요.
  라파에서도 `8443`을 `tailscale0`에만 여는 것을 권장합니다.
- HTTPS는 자체 서명 인증서로 전송 구간 암호화만 제공하며, 접속자 인증은 하지 않습니다.

## 개발

```bash
npm install
npm run server:local    # 로컬에서 중앙 서버만 띄워 검증 (BEWE_PORT로 포트 지정)
npm run start:ingest    # BEWEX Hub 실행 (central 접속)
npm run start:monitor   # BEWEX Monitor 실행 (central 자동 접속, npm start와 동일)
```

## 테스트

```bash
npm test                # 시그널링 서버 통합 테스트 (슬롯 배정/중계/relay 검증)
npm run test:e2e        # 브라우저 E2E (모바일→모니터, 보조모드, BEWE 슬롯 릴레이)
```

E2E 테스트는 Chrome이 필요합니다. 경로가 다르면 `CHROME_PATH` 환경변수로 지정하세요
(기본 `/usr/bin/google-chrome`).

## 코드 업데이트 · 아이콘 동작 (Linux)

데스크톱 아이콘은 이 저장소의 소스를 직접 실행하므로 코드 갱신에 재빌드가 필요 없습니다.

```bash
cd BEWEX
git pull                     # 소스 갱신
# 끝. 아이콘을 다시 누르면 최신 코드로 실행됨.
```

- 아이콘의 `Exec`은 `scripts/bewe-run.sh <ingest|monitor>`를 가리키며, 이 런처가
  저장소 루트에서 `electron`으로 소스를 바로 띄웁니다(`Path`로 작업 디렉터리 고정).
- 런처는 nvm이 로드되지 않은 GUI 세션(GNOME 더블클릭)에서도 node를 찾도록 PATH를
  직접 보정하고, `node_modules`가 없거나 `package-lock.json`이 바뀌면 `npm ci`를 자동 실행합니다.
- 저장소를 옮기면 아이콘의 경로가 깨지므로 `npm run install:desktop`을 다시 실행하세요.
- 아이콘이 "실행 안 됨"으로 나오면 우클릭 → 실행 허용(Allow Launching).
  (스크립트가 GNOME 신뢰 플래그를 자동 설정하지만 일부 환경은 수동 허용 필요)

## 구조

```
server/standalone.js          중앙 서버 부트스트랩 (Electron 없이 순수 node — 라파 headless 상시 구동)
server/server.js              HTTPS 정적 서버 + WebSocket 시그널링/슬롯 배정/프레임 릴레이
server/cert.js                자체 서명 인증서 생성/재사용 (IP 변경 시 재생성)
ingest-main.js                BEWEX Hub Electron 메인 (로컬 UI 로드 + 창 캡처 IPC + central 인증서 예외)
ingest-preload.js             BEWEX Hub preload (창 목록/선택 API 브리지)
monitor-main.js               BEWEX Monitor Electron 메인 (central 자동 접속 + 인증서 예외)
monitor-preload.js            BEWEX Monitor preload (connect API 브리지)
monitor-connect.html          모니터 시작/폴백 화면 (central 주소 프리필, 재시도)
public/mobile.*               휴대폰 송출 페이지 (getUserMedia + WebRTC + 보조 모드)
public/ingest.*               허브 UI (QR 2개, BEWE 슬롯 창 캡처, 슬롯 상태판)
public/monitor.*              관제 모니터 페이지 (순수 웹 — 브라우저에서도 동작)
public/style.css              공용 스타일
deploy/bewe-server.service    systemd 서비스 템플릿 (배포 스크립트가 사용자/경로 치환)
scripts/deploy-central.sh     라파 중앙 서버 배포 (rsync + npm install + systemd 등록)
scripts/run-server-local.sh   로컬에서 서버만 띄워 검증
scripts/install-desktop.sh    Linux 바탕화면 아이콘 설치 (아이콘 → bewe-run.sh 연결)
scripts/bewe-run.sh           소스 직접 실행 런처 (git pull 후 재빌드 없이 최신 코드 실행)
test/signaling-test.js        시그널링 통합 테스트
test/e2e-test.js              모바일→모니터 E2E
test/fallback-e2e-test.js     보조 모드(RELAY) E2E
test/app-relay-e2e-test.js    BEWE 슬롯(창 캡처) 릴레이 E2E
```
