// 라즈베리파이(raspb2-central) 등에서 Electron 없이 순수 node로 상시 구동하는
// 중앙 서버 부트스트랩. server.js의 startServer(HTTPS + WebSocket 시그널링)를
// headless로 기동하고, SIGINT/SIGTERM 시 graceful하게 닫는다.
//
// 실행: BEWE_PORT=8443 node server/standalone.js
// 환경변수:
//   BEWE_PORT     : 리슨 포트(기본 8443). 사용 중이면 server.js가 +19까지 탐색.
//   BEWE_CERT_DIR : self-signed 인증서 저장 디렉토리
//                   (기본 ~/.config/bewe-server/cert)
const path = require('path');
const os = require('os');
const { startServer } = require('./server');

const certDir =
  process.env.BEWE_CERT_DIR ||
  path.join(os.homedir(), '.config', 'bewe-server', 'cert');
const preferredPort = Number(process.env.BEWE_PORT) || 8443;

async function main() {
  const info = await startServer({ certDir, preferredPort });

  console.log('[bewe-server] 중앙 서버 기동 완료');
  console.log(`[bewe-server] listening on port ${info.port}`);
  console.log(`[bewe-server] ips: ${info.ips.join(', ') || '(none)'}`);
  console.log('[bewe-server] 접속 주소 예시:');
  for (const ip of info.ips) {
    console.log(`  - 휴대폰 송출 : https://${ip}:${info.port}/mobile`);
    console.log(`  - 관제 모니터 : https://${ip}:${info.port}/monitor`);
  }
  console.log(`[bewe-server] cert dir: ${certDir}`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`\n[bewe-server] ${signal} 수신 — 서버 종료 중...`);
    try {
      await info.close();
    } catch (err) {
      console.error('[bewe-server] 종료 중 오류:', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[bewe-server] 서버 기동 실패:', err);
  process.exit(1);
});
