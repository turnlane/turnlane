#!/bin/bash
# 撮影キット: dev-board（ダミーデータ・一時 HOME）を起動する。止めるときは Ctrl-C（一時 HOME を消す）。
#
#   bash board.sh <ja|en> <rehearse|scene3|banner>
#
# - rehearse / scene3: 場面 (3)。C（api-gateway）は起動の時点で許可待ち。「開く」は本物の OS で Ghostty のタブ 3 を前に出す。
#   先に Ghostty のタブ 3 で tab.sh api-gateway を動かしておく（その pid を使う）
# - banner: 通知のバナー（案 A）。起動の 45 秒後に C が許可待ちになり、デスクトップアプリが通知を出す
set -eu

KIT="$(cd "$(dirname "${0}")" && pwd)"
LANG_UI="${1:-}"
MODE="${2:-}"
PORT=27317
BUN_BIN="${BUN_BIN:-$(command -v bun || true)}"
[ -n "${BUN_BIN}" ] || BUN_BIN=/opt/homebrew/bin/bun

usage() {
  echo "usage: bash board.sh <ja|en> <rehearse|scene3|banner>" >&2
  exit 2
}
case "${LANG_UI}" in ja | en) ;; *) usage ;; esac

EXTRA=()
case "${MODE}" in
  rehearse | scene3)
    PID_FILE="${KIT}/run/api-gateway.pid"
    if [ ! -f "${PID_FILE}" ]; then
      echo "先に Ghostty のタブ 3 で bash ${KIT}/tab.sh api-gateway ${LANG_UI} を動かしてください（${PID_FILE} がありません）" >&2
      exit 1
    fi
    TAB_PID="$(cat "${PID_FILE}")"
    if ! kill -0 "${TAB_PID}" 2>/dev/null; then
      echo "タブ 3 の台本（pid ${TAB_PID}）が動いていません。タブ 3 で tab.sh を動かし直してください" >&2
      exit 1
    fi
    EXTRA=(--real-open --demo-waiting --demo-pid "${TAB_PID}" --demo-root "${HOME}/w")
    ;;
  banner)
    EXTRA=(--demo-notify 45)
    ;;
  *) usage ;;
esac

if [ ! -x "${BUN_BIN}" ]; then
  echo "bun が見つかりません（README の「bun が無いとき」）" >&2
  exit 1
fi

mkdir -p "${KIT}/run"
LOG="${KIT}/run/board-$(id -un).log"
echo "dev-board: ${MODE} (${LANG_UI}) port ${PORT}"
"${BUN_BIN}" "${KIT}/dev-board.js" --port "${PORT}" --design demo --lang "${LANG_UI}" --theme dark \
  --web-dist "${KIT}/web" "${EXTRA[@]}" 2>&1 | tee "${LOG}"
