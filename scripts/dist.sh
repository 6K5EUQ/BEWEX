#!/usr/bin/env bash
# electron-builder로 빌드한다. extraMetadata.main 옵션이 빌드 중 루트
# package.json을 덮어쓰고 복구하지 않는 문제가 있어(scripts 유실), 빌드 전후로
# package.json을 백업·복구한다.
#
# 사용법:
#   ./scripts/dist.sh ingest linux
#   ./scripts/dist.sh monitor win
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:?사용법: dist.sh <ingest|monitor> <linux|win>}"
PLATFORM="${2:?사용법: dist.sh <ingest|monitor> <linux|win>}"

case "$APP" in ingest|monitor) ;; *) echo "APP은 ingest 또는 monitor" >&2; exit 1 ;; esac
case "$PLATFORM" in linux|win) ;; *) echo "PLATFORM은 linux 또는 win" >&2; exit 1 ;; esac

CONFIG="$ROOT/electron-builder.$APP.json"
PKG="$ROOT/package.json"
BACKUP="$(mktemp)"

cp -f "$PKG" "$BACKUP"
# 빌드가 실패하거나 중단돼도 package.json은 반드시 원상 복구
restore() { cp -f "$BACKUP" "$PKG"; rm -f "$BACKUP"; }
trap restore EXIT

echo "▶ $APP ($PLATFORM) 빌드 중…"
( cd "$ROOT" && npx electron-builder --"$PLATFORM" --config "$CONFIG" )
echo "✅ 빌드 완료 → release/$APP/"
