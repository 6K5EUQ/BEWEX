#!/usr/bin/env bash
# BEWE 앱을 소스코드(이 저장소)에서 직접 실행하는 런처.
#
# 왜 이렇게 하나:
#   기존 방식은 AppImage를 미리 빌드해 복사했기 때문에, `git pull`로 소스를 갱신해도
#   빌드를 다시 하기 전까지는 낡은 AppImage가 실행됐다.
#   이 런처는 저장소의 현재 소스를 electron으로 바로 띄운다.
#   → `git pull` 후 아이콘을 다시 누르면 곧바로 최신 코드로 실행된다. 재빌드 불필요.
#
# 사용법:
#   ./scripts/bewe-run.sh ingest    # 연결 허브
#   ./scripts/bewe-run.sh monitor   # 관제 모니터
#
# 주의: GNOME 등에서 바탕화면 아이콘을 더블클릭하면 로그인 셸(.bashrc/nvm)이 로드되지
#       않으므로, node/electron 경로를 이 스크립트에서 직접 찾아 PATH에 넣는다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-monitor}"

case "$TARGET" in
  ingest)  ENTRY="ingest-main.js" ;;
  monitor) ENTRY="monitor-main.js" ;;
  *)
    echo "사용법: $0 [ingest|monitor]" >&2
    exit 1
    ;;
esac

# --- node 경로 확보 (nvm이 로드 안 된 GUI 세션 대비) ---
# 우선순위: 이미 PATH에 있는 node > nvm default > nvm 최신 > 시스템 node
if ! command -v node >/dev/null 2>&1; then
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  node_bin=""
  if [ -s "$NVM_DIR/alias/default" ]; then
    ver="$(cat "$NVM_DIR/alias/default")"
    # alias가 "20" 같은 축약이면 실제 설치본으로 확장
    cand="$(ls -d "$NVM_DIR/versions/node/v${ver}"* 2>/dev/null | sort -V | tail -1 || true)"
    [ -n "$cand" ] && node_bin="$cand/bin"
  fi
  if [ -z "$node_bin" ]; then
    cand="$(ls -d "$NVM_DIR"/versions/node/v* 2>/dev/null | sort -V | tail -1 || true)"
    [ -n "$cand" ] && node_bin="$cand/bin"
  fi
  [ -n "$node_bin" ] && export PATH="$node_bin:$PATH"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "실패: node를 찾을 수 없습니다. Node.js(또는 nvm)를 설치하세요." >&2
  exit 1
fi

cd "$ROOT"

# --- 의존성 설치 (최초 클론 또는 lock 변경 시) ---
# node_modules가 없거나 package-lock.json이 더 최신이면 설치한다.
need_install=false
if [ ! -d node_modules ] || [ ! -x node_modules/.bin/electron ]; then
  need_install=true
elif [ package-lock.json -nt node_modules/.package-lock.json ] 2>/dev/null; then
  need_install=true
fi
if [ "$need_install" = true ]; then
  echo "의존성 설치 중... (npm ci)"
  npm ci || npm install
fi

# --- 실행 ---
# electron이 이 저장소의 소스를 그대로 로드한다. exec로 셸을 대체해 시그널이 앱까지 전달되게 한다.
exec node_modules/.bin/electron "$ENTRY" "${@:2}"
