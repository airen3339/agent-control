#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PORT="${PORT:-43310}"
DIST_DIR="$ROOT_DIR/dist"
APP_NAME="Agent Control.app"
BUILD_APP="$DIST_DIR/$APP_NAME"
INSTALL_DIR="${AGENT_CONTROL_APP_INSTALL_DIR:-/Applications}"
INSTALL_APP="$INSTALL_DIR/$APP_NAME"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "仅支持在 macOS 上构建原生桌面包装。" >&2
  exit 1
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "未找到 swiftc，请先安装 Xcode Command Line Tools (xcode-select --install)。" >&2
  exit 1
fi

INSTALL_MODE=0
for arg in "$@"; do
  case "$arg" in
    --install)
      INSTALL_MODE=1
      ;;
    --help|-h)
      echo "用法: $0 [--install]"
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      exit 2
      ;;
  esac
done

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

CONTENTS_DIR="$BUILD_APP/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RES_DIR="$CONTENTS_DIR/Resources"

rm -rf "$BUILD_APP"
mkdir -p "$MACOS_DIR" "$RES_DIR"

echo "正在编译 Agent Control 原生桌面端..."
TARGET_FLAGS=()
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  TARGET_FLAGS=(-target arm64-apple-macos13.0)
fi
swiftc \
  -O \
  "${TARGET_FLAGS[@]}" \
  -framework Cocoa \
  -framework WebKit \
  "$SCRIPT_DIR/AgentControl.swift" \
  -o "$MACOS_DIR/AgentControl"

echo "正在生成应用图标..."
ICONSET_DIR="$TMP_DIR/AppIcon.iconset"
BASE_PNG="$TMP_DIR/icon_1024.png"
mkdir -p "$ICONSET_DIR"
swift "$SCRIPT_DIR/render-icon.swift" "$BASE_PNG"

for sz in 16 32 128 256 512; do
  sips -z "$sz" "$sz" "$BASE_PNG" --out "$ICONSET_DIR/icon_${sz}x${sz}.png" >/dev/null
  double_sz=$((sz * 2))
  sips -z "$double_sz" "$double_sz" "$BASE_PNG" --out "$ICONSET_DIR/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET_DIR" -o "$RES_DIR/AppIcon.icns"

# Escape '&' for sed replacement
ESCAPED_ROOT="$(printf '%s' "$ROOT_DIR" | sed 's/[&|\\]/\\&/g')"
ESCAPED_PORT="$(printf '%s' "$PORT" | sed 's/[&|\\]/\\&/g')"
sed \
  -e "s|__AGENT_CONTROL_REPO_ROOT__|$ESCAPED_ROOT|g" \
  -e "s|__AGENT_CONTROL_PORT__|$ESCAPED_PORT|g" \
  "$SCRIPT_DIR/Info.plist" > "$CONTENTS_DIR/Info.plist"

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$BUILD_APP" >/dev/null 2>&1 || true
fi

echo "已构建桌面应用: $BUILD_APP"

if [ "$INSTALL_MODE" -eq 1 ]; then
  mkdir -p "$INSTALL_DIR"
  rm -rf "$INSTALL_APP"
  ditto "$BUILD_APP" "$INSTALL_APP"
  if command -v codesign >/dev/null 2>&1; then
    codesign --force --deep --sign - "$INSTALL_APP" >/dev/null 2>&1 || true
  fi
  echo "已安装到: $INSTALL_APP"
fi
