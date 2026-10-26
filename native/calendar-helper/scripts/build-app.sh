#!/bin/sh
# TurnlaneCalendarHelper.app を組み立てて署名する（phase0-plan 1.3・1.5、S1）。
#
#   native/calendar-helper/scripts/build-app.sh [出力ディレクトリ]   # 既定: <repo>/out
#
# 署名: TURNLANE_CODESIGN_IDENTITY に証明書の名前（例: "Apple Development: ..."）か SHA-1 を入れるとそれで署名する。
# 無ければ ad-hoc 署名（-）。ad-hoc はビルドのたびに cdhash が変わるので、再ビルドで TCC の許可が外れうる
# （docs/spikes/s1-eventkit-tcc.md）。
# hardened runtime で署名し、カレンダーの entitlement（Resources/CalendarHelper.entitlements）を付ける（M6-8。
# hardened runtime のアプリは entitlement が無いとカレンダーの許可を求められない。docs/dev/codesign.md 3 章）。
# タイムスタンプの引数は scripts/signing.ts が決める（Developer ID ならセキュアタイムスタンプ、それ以外は付けない）。
# 外側の Turnlane.app に入れるときは scripts/build-app.ts の helperSignCommand と同じ引数になる（test/build-notarize.test.ts）
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$ROOT/out}"
APP="$OUT/TurnlaneCalendarHelper.app"
IDENTITY="${TURNLANE_CODESIGN_IDENTITY:--}"

cd "$HERE"
swift build -c release --arch arm64 >&2
BIN_DIR="$(swift build -c release --arch arm64 --show-bin-path)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN_DIR/CalendarHelper" "$APP/Contents/MacOS/TurnlaneCalendarHelper"
cp "$HERE/Resources/Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
# 版はルートの package.json から（M6-17。scripts/version.ts）。Turnlane.app・turnlaned と同じ値にそろえる
VERSION="$(cd "$ROOT" && bun scripts/version.ts)"
plutil -replace CFBundleShortVersionString -string "${VERSION}" "$APP/Contents/Info.plist"
plutil -replace CFBundleVersion -string "${VERSION}" "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >&2

ENTITLEMENTS="${HERE}/Resources/CalendarHelper.entitlements"
TIMESTAMP="$(cd "${ROOT}" && TURNLANE_CODESIGN_IDENTITY="${IDENTITY}" bun scripts/signing.ts timestamp-flag)"
if ! codesign --force --options runtime ${TIMESTAMP} --entitlements "${ENTITLEMENTS}" \
  --identifier dev.turnlane.calendar-helper --sign "${IDENTITY}" "${APP}" >&2; then
  if [ "${TIMESTAMP}" = "--timestamp" ]; then
    echo "error: codesign failed. Developer ID signing needs a secure timestamp from Apple (network to timestamp.apple.com). Check the network and run the build again." >&2
  fi
  exit 1
fi
codesign --verify --strict "${APP}" >&2

echo "$APP"
