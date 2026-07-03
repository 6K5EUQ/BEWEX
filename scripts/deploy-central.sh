#!/usr/bin/env bash
# BEWE central 서버를 라즈베리파이(또는 원격 리눅스 호스트)에 배포한다.
#
# 하는 일: SSH 확인 → node/npm 확인 → rsync 전송 → npm install --omit=dev
#          → (--no-service 아니면) systemd 설치 + enable --now(sudo) → 방화벽 안내 → 검증.
# --delete 미사용, systemd 설치 구간만 sudo 필요.
#
# 사용법:
#   ./scripts/deploy-central.sh                        # raspb2@100.123.59.3 로 배포
#   ./scripts/deploy-central.sh pi@100.123.59.3        # 대상 지정
#   ./scripts/deploy-central.sh HOST --no-service      # 파일만 배포(수동 실행)
#   BEWE_PORT=8600 ./scripts/deploy-central.sh HOST    # 포트 지정
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 기본값
HOST="raspb2@100.123.59.3"   # 배포 대상 (user@host)
NO_SERVICE=0                 # 1이면 systemd 등록 건너뜀
PORT="${BEWE_PORT:-8443}"    # 서버 포트
REMOTE_DIR="bewe-server"     # 원격 홈 기준 → ~/bewe-server
SERVICE_NAME="bewe-server.service"

usage() {
  cat <<'EOF'
BEWE central 서버 배포 스크립트

사용법:
  scripts/deploy-central.sh [HOST] [--no-service]

인자:
  HOST           배포 대상 user@host (기본: raspb2@100.123.59.3)
  --no-service   systemd 등록을 건너뛰고 파일 전송/설치만 수행
  -h, --help     이 도움말 출력

환경변수:
  BEWE_PORT      서버 포트 (기본 8443)

사전 준비:
  - 대상에 SSH 공개키 등록:  ssh-copy-id HOST
  - 대상에 node 설치:        sudo apt install -y nodejs npm
EOF
}

# 인자 파싱 (위치 인자 HOST + --no-service, 순서 무관)
for arg in "$@"; do
  case "$arg" in
    --no-service) NO_SERVICE=1 ;;
    -h|--help)    usage; exit 0 ;;
    -*)           echo "알 수 없는 옵션: $arg" >&2; usage >&2; exit 1 ;;
    *)            HOST="$arg" ;;
  esac
done

HOST_IP="${HOST##*@}"   # user@ 접두 제거 → 검증 curl 대상 IP

echo "BEWE central 배포"
echo "  대상 HOST : $HOST"
echo "  포트      : $PORT"
echo "  원격 경로 : ~/$REMOTE_DIR"
echo "  systemd   : $([ "$NO_SERVICE" -eq 1 ] && echo '건너뜀(--no-service)' || echo '등록')"

# 1) SSH 연결 확인
echo "[1/7] SSH 연결 확인: $HOST"
if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true 2>/dev/null; then
  echo "실패: SSH 로 접속할 수 없습니다 ($HOST)." >&2
  echo "  공개키 등록: ssh-copy-id $HOST" >&2
  echo "  또는 ~/.ssh/config 의 호스트/키 경로를 확인하세요." >&2
  exit 1
fi
echo "  연결 확인됨"

# 2) 원격 node / npm 확인
echo "[2/7] 원격 node / npm 확인"
REMOTE_NODE="$(ssh "$HOST" 'command -v node' 2>/dev/null || true)"
if [ -z "$REMOTE_NODE" ]; then
  echo "실패: 원격에 node 가 없습니다." >&2
  echo "  Debian/Ubuntu: sudo apt update && sudo apt install -y nodejs npm" >&2
  echo "  최신 LTS: curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt install -y nodejs" >&2
  echo "  (nvm 사용 시 non-interactive SSH PATH 에 node 가 없을 수 있음 → 시스템 설치 권장)" >&2
  exit 1
fi
if ! ssh "$HOST" 'command -v npm' >/dev/null 2>&1; then
  echo "실패: 원격에 npm 이 없습니다 (의존성 설치 불가)." >&2
  echo "  sudo apt install -y npm" >&2
  exit 1
fi
echo "  node: $REMOTE_NODE ($(ssh "$HOST" 'node -v' 2>/dev/null || echo '?'))"

# 3) rsync 전송 (--delete 미사용 = 비파괴)
echo "[3/7] 파일 전송(rsync) → $HOST:~/$REMOTE_DIR/"
ssh "$HOST" "mkdir -p ~/$REMOTE_DIR"
rsync -az \
  --exclude 'node_modules' \
  --exclude 'release' \
  "$ROOT/server" \
  "$ROOT/public" \
  "$ROOT/package.json" \
  "$HOST:$REMOTE_DIR/"
echo "  전송 완료 (server/, public/, package.json)"

# 4) 원격 의존성 설치
echo "[4/7] 원격 의존성 설치: npm install --omit=dev"
ssh "$HOST" "cd ~/$REMOTE_DIR && npm install --omit=dev"
echo "  설치 완료"

# 5) systemd 서비스 설치
if [ "$NO_SERVICE" -eq 1 ]; then
  echo "[5/7] --no-service 지정 → systemd 등록 건너뜀"
  echo "  수동 실행: ssh $HOST 'cd ~/$REMOTE_DIR && BEWE_PORT=$PORT node server/standalone.js'"
else
  echo "[5/7] systemd 서비스 설치 (sudo 필요 — 원격 비밀번호를 물을 수 있음)"
  REMOTE_USER="$(ssh "$HOST" 'id -un')"
  REMOTE_HOME="$(ssh "$HOST" 'echo "$HOME"')"

  # 공개(표시/QR) 주소는 대상 IP로 고정. BEWE_PUBLIC_HOST 로 덮어쓸 수 있음.
  PUBLIC_HOST="${BEWE_PUBLIC_HOST:-$HOST_IP}"

  # 템플릿 치환: /home/%i(실제 홈) 먼저, 남은 %i → 사용자명.
  UNIT_CONTENT="$(sed \
    -e "s|/home/%i|$REMOTE_HOME|g" \
    -e "s|%i|$REMOTE_USER|g" \
    -e "s|/usr/bin/node|$REMOTE_NODE|g" \
    -e "s|BEWE_PORT=8443|BEWE_PORT=$PORT|g" \
    -e "s|__PUBLIC_HOST__|$PUBLIC_HOST|g" \
    "$ROOT/deploy/bewe-server.service")"

  # 생성한 유닛을 원격 홈에 먼저 두고(비파괴), sudo 로 시스템 위치에 설치
  printf '%s\n' "$UNIT_CONTENT" | ssh "$HOST" "cat > ~/$REMOTE_DIR/$SERVICE_NAME"
  ssh -t "$HOST" "sudo install -m 0644 ~/$REMOTE_DIR/$SERVICE_NAME /etc/systemd/system/$SERVICE_NAME && sudo systemctl daemon-reload && sudo systemctl enable --now $SERVICE_NAME"
  echo "  서비스 등록/기동 완료"
  ssh "$HOST" "systemctl --no-pager status $SERVICE_NAME 2>/dev/null | head -n 12" || true
fi

# 6) 방화벽 안내 (선택 — 강제 아님)
echo "[6/7] 방화벽 안내 (선택)"
echo "  $PORT 를 tailscale0 인터페이스에만 여는 것을 권장:"
echo "    ssh $HOST 'sudo ufw allow in on tailscale0 to any port $PORT proto tcp'"
echo "  (UFW 미사용 환경이면 무시)"

# 7) 배포 검증
echo "[7/7] 배포 검증: https://$HOST_IP:$PORT/api/info"
if [ "$NO_SERVICE" -eq 1 ]; then
  # --no-service 모드는 서버를 기동하지 않으므로 무응답이 정상 경로 → best-effort 확인.
  if curl -sk --max-time 10 "https://$HOST_IP:$PORT/api/info"; then
    echo ""
    echo "  응답 정상 — 서버가 이미 기동되어 있습니다."
  else
    echo ""
    echo "  --no-service 모드입니다(파일 전송/설치 완료, 서버 미기동)."
    echo "  수동 기동 후 검증:"
    echo "    ssh $HOST 'cd ~/$REMOTE_DIR && BEWE_PORT=$PORT node server/standalone.js'"
    echo "    curl -sk https://$HOST_IP:$PORT/api/info"
  fi
else
  sleep 2   # 서비스 기동 여유
  if curl -sk --max-time 10 "https://$HOST_IP:$PORT/api/info"; then
    echo ""
    echo "  응답 정상 — 배포 완료"
  else
    echo ""
    echo "실패: /api/info 응답이 없습니다. 서버 기동/방화벽/Tailscale 연결을 확인하세요." >&2
    echo "  상태: ssh $HOST 'systemctl status $SERVICE_NAME'" >&2
    echo "  로그: ssh $HOST 'journalctl -u $SERVICE_NAME -n 50 --no-pager'" >&2
  fi
fi

echo "접속 주소 (Tailscale 연결 전제)"
echo "  폰1  : https://$HOST_IP:$PORT/mobile?slot=1"
echo "  폰2  : https://$HOST_IP:$PORT/mobile?slot=2"
echo "  관제 : https://$HOST_IP:$PORT/monitor"
echo "  Ingest Hub 앱: BEWE_CENTRAL=$HOST_IP 로 자동 접속"
