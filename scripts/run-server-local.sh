#!/usr/bin/env bash
# 로컬에서 central 서버만 순수 node로 띄워 검증한다 (Electron 불필요).
# 라즈베리파이 headless 상시 구동과 동일한 진입점(server/standalone.js)을 사용한다.
#
# 사용법:
#   ./scripts/run-server-local.sh          # 8443 포트
#   ./scripts/run-server-local.sh 8600     # 포트 지정
#
# standalone.js가 리슨 포트 / 접속 IP / 페이지 URL을 콘솔에 출력한다.
# 종료는 Ctrl-C (SIGINT).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-8443}"

echo "BEWE central 서버 로컬 기동 (포트 ${PORT})"
echo "종료: Ctrl-C"

# exec로 shell을 node로 대체 → SIGINT/SIGTERM이 standalone.js 핸들러로 바로 전달
exec env BEWE_PORT="$PORT" node "$ROOT/server/standalone.js"
