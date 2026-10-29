#!/bin/sh
# Turnlane.app（デスクトップシェル。Tauri 2）をビルドして署名する（desktop-shell.md 2.4）。
#
#   apps/desktop/scripts/build.sh [出力ディレクトリ]   # 既定: <repo>/out → <repo>/out/Turnlane.app
#   bun run build:desktop                              # 同じ
#
# 署名: TURNLANE_CODESIGN_IDENTITY に証明書の名前（例: "Apple Development: ..."）か SHA-1 を入れるとそれで署名する
# （Tauri に APPLE_SIGNING_IDENTITY として渡す。hardened runtime。entitlements は不要）。
# 無ければ ad-hoc 署名（-）。ad-hoc はビルドのたびに cdhash が変わるので、再ビルドで通知の許可が外れることがある。
# 配布用（Developer ID）の外側の署名・公証は bun run build:app が行う（docs/dev/codesign.md 5 章）。
# TURNLANE_DESKTOP_FEATURES に cargo の feature を入れると付ける（お試し版の Web Inspector は inspector。
# bun run build:app --debug-webview が入れる）。既定は空
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
OUT="${1:-${ROOT}/out}"
TARGET="aarch64-apple-darwin"
IDENTITY="${TURNLANE_CODESIGN_IDENTITY:-}"
FEATURES="${TURNLANE_DESKTOP_FEATURES:-}"

if [ -z "${IDENTITY}" ]; then
  echo "warning: TURNLANE_CODESIGN_IDENTITY is not set; signing ad-hoc. Notification permission may be reset on every rebuild." >&2
  IDENTITY="-"
fi

# 版はルートの package.json から（M6-17。scripts/version.ts）。tauri.conf.json の version は使わない
VERSION="$(cd "${ROOT}" && bun scripts/version.ts)"

cd "${HERE}"
if [ -n "${FEATURES}" ]; then
  echo "note: building the desktop shell with features: ${FEATURES}" >&2
  APPLE_SIGNING_IDENTITY="${IDENTITY}" bun --bun tauri build --bundles app --target "${TARGET}" \
    --features "${FEATURES}" --config "{\"version\":\"${VERSION}\"}" >&2
else
  APPLE_SIGNING_IDENTITY="${IDENTITY}" bun --bun tauri build --bundles app --target "${TARGET}" \
    --config "{\"version\":\"${VERSION}\"}" >&2
fi

SRC="${HERE}/src-tauri/target/${TARGET}/release/bundle/macos/Turnlane.app"
mkdir -p "${OUT}"
rm -rf "${OUT}/Turnlane.app.tmp"
cp -R "${SRC}" "${OUT}/Turnlane.app.tmp"
rm -rf "${OUT}/Turnlane.app"
mv "${OUT}/Turnlane.app.tmp" "${OUT}/Turnlane.app"
codesign --verify --strict "${OUT}/Turnlane.app" >&2
# 記号（release の split-debuginfo = packed が作る turnlane.dSYM。出すアプリには入れない）をアプリの隣に写す。
# クラッシュレポートを atos で読むため（docs/release.md）。cargo の dSYM は deps の中への symlink なので中身を写す
DSYM="${HERE}/src-tauri/target/${TARGET}/release/turnlane.dSYM"
rm -rf "${OUT}/turnlane.dSYM"
if [ -e "${DSYM}" ]; then
  cp -RL "${DSYM}" "${OUT}/turnlane.dSYM"
fi

echo "${OUT}/Turnlane.app"
