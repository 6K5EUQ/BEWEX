#!/usr/bin/env bash
# BEWE 앱을 리눅스 바탕화면 아이콘으로 설치한다.
#
# 사용법:
#   ./scripts/install-desktop.sh monitor   # 관제 모니터 설치 (기본)
#   ./scripts/install-desktop.sh ingest    # 연결 허브 설치
#   ./scripts/install-desktop.sh both      # 둘 다 설치
#
# 하는 일:
#   1. 앱 메뉴 등록 (~/.local/share/applications/*.desktop)
#   2. 바탕화면 아이콘 생성 (+ GNOME "실행 허용" 신뢰 플래그 설정)
#
# 핵심: 아이콘은 AppImage가 아니라 이 저장소의 소스를 직접 실행한다(scripts/bewe-run.sh).
#       따라서 `git pull`로 코드를 갱신하면 재빌드 없이 아이콘 실행만으로 최신 코드가 뜬다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-monitor}"
RUNNER="$ROOT/scripts/bewe-run.sh"
APPS_DIR="$HOME/.local/share/applications"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"

chmod +x "$RUNNER"

install_one() {
  local key="$1" name="$2" comment="$3"

  mkdir -p "$APPS_DIR"

  # 아이콘 파일 (있으면 사용, 없으면 이름만)
  local icon="$ROOT/assets/icon.png"

  # .desktop 런처 (앱 메뉴 + 바탕화면 공용)
  # Exec은 소스 실행 런처를 가리킨다. Path로 작업 디렉터리를 저장소 루트로 고정한다.
  local desktop_file="$APPS_DIR/bewe-$key.desktop"
  cat > "$desktop_file" <<EOF
[Desktop Entry]
Type=Application
Name=$name
Comment=$comment
Exec=$RUNNER $key
Path=$ROOT
Icon=$icon
Terminal=false
Categories=AudioVideo;Network;
StartupNotify=true
EOF
  chmod +x "$desktop_file"

  # 바탕화면 아이콘
  if [ -d "$DESKTOP_DIR" ]; then
    cp -f "$desktop_file" "$DESKTOP_DIR/bewe-$key.desktop"
    chmod +x "$DESKTOP_DIR/bewe-$key.desktop"
    # GNOME(우분투 기본)은 신뢰 플래그가 있어야 더블클릭 실행이 바로 된다
    gio set "$DESKTOP_DIR/bewe-$key.desktop" metadata::trusted true 2>/dev/null || true
  fi

  echo "$name 설치 완료"
  echo "  실행명령 : $RUNNER $key"
  echo "  앱 메뉴  : $desktop_file"
  [ -d "$DESKTOP_DIR" ] && echo "  바탕화면 : $DESKTOP_DIR/bewe-$key.desktop"
}

case "$TARGET" in
  monitor)
    install_one monitor "BEWEX Monitor" "관제 모니터 — 카메라/화면 피드 3분할 뷰어"
    ;;
  ingest)
    install_one ingest "BEWEX Hub" "연결 허브 — 휴대폰 카메라 QR 접속 + 창 캡처 송출"
    ;;
  both)
    install_one monitor "BEWEX Monitor" "관제 모니터 — 카메라/화면 피드 3분할 뷰어"
    install_one ingest "BEWEX Hub" "연결 허브 — 휴대폰 카메라 QR 접속 + 창 캡처 송출"
    ;;
  *)
    echo "사용법: $0 [monitor|ingest|both]" >&2
    exit 1
    ;;
esac

echo ""
echo "코드 업데이트: 이 저장소에서 'git pull' 하면 다음 아이콘 실행부터 최신 코드로 뜹니다(재빌드 불필요)."
echo "아이콘이 바탕화면에서 '실행 안 됨'으로 나오면: 아이콘 우클릭 → '실행 허용(Allow Launching)'"