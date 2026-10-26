#!/bin/sh
# S1 の確認（オーナーが手で実行する。docs/spikes/s1-eventkit-tcc.md の手順 3・4）。
#
#   native/calendar-helper/scripts/s1-launchd-probe.sh [秒数（既定 60）] [.app のパス（既定 ~/Applications/TurnlaneCalendarHelper.app）]
#
# ヘルパを一時的な LaunchAgent（dev.turnlane.calendar-helper.s1）として launchd から起動し、
# --probe で「権限」「カレンダーと窓の予定の件数（題名は出さない）」を記録、指定の秒数だけ
# EKEventStoreChanged を待ってから終わる。終わったら LaunchAgent を外し、一時 plist を消す。
# 常駐用の dev.turnlane.calendar-helper とデーモン（dev.turnlane.daemon）には触れない。
set -eu

SECONDS_TO_WATCH="${1:-60}"
APP="${2:-$HOME/Applications/TurnlaneCalendarHelper.app}"
BIN="$APP/Contents/MacOS/TurnlaneCalendarHelper"
LABEL="dev.turnlane.calendar-helper.s1"
LOG_DIR="${TURNLANE_LOG_DIR:-$HOME/Library/Logs/turnlane}"
LOG="$LOG_DIR/calendar-helper-s1.log"
TMP="$(mktemp -d)"
PLIST="$TMP/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [ ! -x "$BIN" ]; then
  echo "$BIN がありません（先に .app を置いてください）" >&2
  exit 1
fi
mkdir -p "$LOG_DIR"
: > "$LOG"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN</string>
    <string>--probe</string>
    <string>--watch</string>
    <string>$SECONDS_TO_WATCH</string>
    <string>--log</string>
    <string>$LOG</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/calendar-helper-s1.stderr.log</string>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null

cleanup() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "launchd から起動しました（${LABEL}）。${SECONDS_TO_WATCH} 秒のあいだに Calendar.app で予定を1件足すか動かしてください。"
sleep $((SECONDS_TO_WATCH + 5))

echo "--- $LOG ---"
cat "$LOG"
echo "---"
if grep -q '"event":"probe.result"' "$LOG" && grep '"event":"probe.result"' "$LOG" | grep -q '"authorization":"fullAccess"'; then
  echo "S1: launchd 配下でフルアクセスの権限が効いています（parent_pid 1 = launchd から起動）"
else
  echo "S1: launchd 配下で権限が効いていません（authorization を確認）"
fi
if grep -q '"event":"probe.store_changed"' "$LOG"; then
  echo "S1: EKEventStoreChanged を受け取りました"
else
  echo "S1: EKEventStoreChanged は来ませんでした（待つあいだに予定を変えたか確認）"
fi
