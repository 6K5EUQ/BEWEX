#!/usr/bin/env bash
# BEWE 앱을 리눅스 바탕화면 아이콘으로 설치한다.
#
# 사용법:
#   ./scripts/install-desktop.sh monitor   # 관제 모니터 설치 (기본)
#   ./scripts/install-desktop.sh ingest    # 연결 허브 설치
#   ./scripts/install-desktop.sh both      # 둘 다 설치
#
# 하는 일:
#   1. release/ 에서 빌드된 AppImage를 ~/.local/opt/bewe/ 로 복사
#   2. 앱 메뉴 등록 (~/.local/share/applications/*.desktop)
#   3. 바탕화면 아이콘 생성 (+ GNOME "실행 허용" 신뢰 플래그 설정)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-monitor}"
INSTALL_DIR="$HOME/.local/opt/bewe"
APPS_DIR="$HOME/.local/share/applications"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"

install_one() {
  local key="$1" name="$2" comment="$3" glob="$4"

  # 빌드 산출물 찾기
  local appimage
  appimage=$(ls "$ROOT"/release/"$key"/*.AppImage 2>/dev/null | head -1 || true)
  if [ -z "$appimage" ]; then
    echo "❌ release/$key/ 에 AppImage가 없습니다. 먼저 빌드하세요:"
    echo "   npm run dist:$key:linux"
    return 1
  fi

  mkdir -p "$INSTALL_DIR" "$APPS_DIR"
  local dest="$INSTALL_DIR/$glob"
  cp -f "$appimage" "$dest"
  chmod +x "$dest"
  cp -f "$ROOT/assets/icon.png" "$INSTALL_DIR/$key-icon.png"

  # 실행 명령 결정 — libfuse.so.2(FUSE2)가 있으면 AppImage 직접 실행(빠름),
  # 없으면 설치 시점에 압축해제해 두고 그 안의 AppRun을 실행(FUSE 불필요).
  local exec_cmd="$dest"
  if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    echo "ℹ️  libfuse2 미설치 → AppImage를 압축해제해 FUSE 없이 실행하도록 설정합니다."
    local appdir="$INSTALL_DIR/$key.AppDir"
    rm -rf "$appdir"
    # extract는 실행 위치에 squashfs-root/ 를 생성하므로 대상 폴더 안에서 수행
    ( cd "$INSTALL_DIR" && "$dest" --appimage-extract >/dev/null 2>&1 )
    if [ -d "$INSTALL_DIR/squashfs-root" ]; then
      mv "$INSTALL_DIR/squashfs-root" "$appdir"
      exec_cmd="$appdir/AppRun"
    else
      echo "⚠️  압축해제 실패 — extract-and-run 방식으로 대체합니다(실행이 느릴 수 있음)."
      exec_cmd="$dest --appimage-extract-and-run"
    fi
  fi

  # .desktop 런처 (앱 메뉴 + 바탕화면 공용)
  local desktop_file="$APPS_DIR/bewe-$key.desktop"
  cat > "$desktop_file" <<EOF
[Desktop Entry]
Type=Application
Name=$name
Comment=$comment
Exec=$exec_cmd
Icon=$INSTALL_DIR/$key-icon.png
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

  echo "✅ $name 설치 완료"
  echo "   실행명령 : $exec_cmd"
  echo "   앱 메뉴  : $desktop_file"
  [ -d "$DESKTOP_DIR" ] && echo "   바탕화면 : $DESKTOP_DIR/bewe-$key.desktop"
}

case "$TARGET" in
  monitor)
    install_one monitor "BEWE Mission Monitor" "관제 모니터 — 카메라/화면 피드 3분할 뷰어" "BEWE-Mission-Monitor.AppImage"
    ;;
  ingest)
    install_one ingest "BEWE Ingest Hub" "연결 허브 — 휴대폰 카메라 QR 접속 + 창 캡처 송출" "BEWE-Ingest-Hub.AppImage"
    ;;
  both)
    install_one monitor "BEWE Mission Monitor" "관제 모니터 — 카메라/화면 피드 3분할 뷰어" "BEWE-Mission-Monitor.AppImage"
    install_one ingest "BEWE Ingest Hub" "연결 허브 — 휴대폰 카메라 QR 접속 + 창 캡처 송출" "BEWE-Ingest-Hub.AppImage"
    ;;
  *)
    echo "사용법: $0 [monitor|ingest|both]" >&2
    exit 1
    ;;
esac

echo ""
echo "ℹ️  아이콘이 바탕화면에서 '실행 안 됨'으로 나오면: 아이콘 우클릭 → '실행 허용(Allow Launching)'"
echo "ℹ️  AppImage 실행에 FUSE 필요: sudo apt install libfuse2"
