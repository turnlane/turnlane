#!/bin/bash
# 撮影キット: 開発ビルドのデスクトップアプリ（Turnlane.app）を、board.sh が起動した dev-board に向けて起動する。
# 止めるときは Turnlane のメニューの Quit（⌘Q）か、このターミナルで Ctrl-C。
#
#   bash app.sh
#
# - TURNLANE_PORT / TURNLANE_DATA_DIR を dev-board に向けるので、常駐の登録（SMAppService）には触れない
#   （apps/desktop/src-tauri/src/setup.rs の managed）。LaunchAgents・ログイン項目は増えない
# - ウインドウの中身を 1440×900 pt にする（起動のたびに、アプリの設定フォルダの window.json に位置と大きさを書く）
set -eu

KIT="$(cd "$(dirname "${0}")" && pwd)"
LOG="${KIT}/run/board-$(id -un).log"
if [ ! -f "${LOG}" ]; then
  echo "先に bash ${KIT}/board.sh を動かしてください（${LOG} がありません）" >&2
  exit 1
fi
LINE="$(grep '^TURNLANE_DATA_DIR=' "${LOG}" | tail -n 1 || true)"
if [ -z "${LINE}" ]; then
  echo "dev-board がまだ起動していません。少し待ってからもう一度" >&2
  exit 1
fi
DATA_DIR="${LINE#TURNLANE_DATA_DIR=}"
DATA_DIR="${DATA_DIR%% TURNLANE_PORT=*}"
PORT="${LINE##*TURNLANE_PORT=}"

# ウインドウの位置と大きさ（中身。pt）。X・Y はウインドウの左上（タイトルバーを含む）
WIN_X="${WIN_X:-0}"
WIN_Y="${WIN_Y:-40}"
CONF_DIR="${HOME}/Library/Application Support/dev.turnlane.desktop"
mkdir -p "${CONF_DIR}"
printf '{"x":%s,"y":%s,"w":1440,"h":900}\n' "${WIN_X}" "${WIN_Y}" >"${CONF_DIR}/window.json"

echo "Turnlane.app -> 127.0.0.1:${PORT}"
TURNLANE_PORT="${PORT}" TURNLANE_DATA_DIR="${DATA_DIR}" "${KIT}/Turnlane.app/Contents/MacOS/turnlane"
