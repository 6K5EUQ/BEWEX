# 📹 PhoneCam Viewer

스마트폰 카메라 영상을 **실시간으로 데스크톱에서 보는** 프로그램입니다.

- 데스크톱 앱(실행파일)을 켜면 내장 HTTPS 서버가 시작되고 QR 코드가 표시됩니다.
- 휴대폰으로 QR 코드를 스캔해 웹 페이지에 접속하고 **카메라 권한을 허용**하면,
  영상이 실시간으로 데스크톱 앱 화면에 나타납니다.
- 여러 대의 휴대폰을 동시에 연결하면 그리드로 표시됩니다.

## 사용 방법

1. 데스크톱 앱을 실행합니다. (창에 QR 코드와 접속 주소가 표시됨)
2. 휴대폰을 **데스크톱과 같은 Wi-Fi**에 연결합니다.
3. 휴대폰 카메라로 QR 코드를 스캔하거나, 표시된 주소(`https://192.168.x.x:8443/mobile`)를 브라우저에 입력합니다.
4. "연결이 비공개로 설정되어 있지 않습니다" 경고가 나오면 **고급 → 이동(계속)** 을 누릅니다.
   (앱이 직접 만든 사설 인증서라서 나오는 정상적인 경고입니다)
5. **[방송 시작]** 버튼을 누르고 카메라 권한을 허용합니다.

## 전송 방식

| 모드 | 설명 |
|------|------|
| **WebRTC** (기본) | P2P 초저지연 스트리밍. 마이크 소리 전송도 지원 |
| **보조 모드** (자동 전환) | P2P가 막힌 네트워크에서 10초 안에 연결이 안 되면 자동으로 JPEG 프레임(10fps)을 서버 릴레이로 전송 |

## 보안

- 스트림 **시청**은 데스크톱 앱(localhost)에서만 가능합니다.
  서버가 실행 시마다 무작위 토큰을 만들고, localhost 요청에만 토큰을 발급합니다.
- 같은 네트워크의 다른 기기는 송출 페이지(`/mobile`)에만 접근할 수 있습니다.

## 개발

```bash
npm install
npm start        # 개발 모드 실행
npm test         # 시그널링 서버 통합 테스트
```

## 빌드 (실행파일 만들기)

```bash
npm run dist:linux   # Linux AppImage → release/
npm run dist:win     # Windows portable .exe → release/
```

- Linux에서 Windows용 빌드는 그대로 동작하지만, 실행파일에 아이콘/버전 정보를
  넣으려면 Windows에서 빌드하세요 (`signAndEditExecutable` 옵션 참고).

## 구조

```
main.js               Electron 메인 (내장 서버 시작 + 뷰어 창)
server/server.js      HTTPS 정적 서버 + WebSocket 시그널링/프레임 릴레이
server/cert.js        자체 서명 인증서 생성/재사용
public/mobile.*       휴대폰 송출 페이지 (getUserMedia + WebRTC + 보조 모드)
public/viewer.*       데스크톱 뷰어 페이지 (그리드, QR, 전체화면)
test/signaling-test.js 시그널링 통합 테스트
```
