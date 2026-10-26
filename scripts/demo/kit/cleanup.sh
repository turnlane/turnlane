#!/bin/bash
# 撮影キット: 撮り終えたら、テスト用ユーザーの中に作ったものを消す（このキットの captures/ は残す）。
# 先に board.sh・app.sh・Ghostty のタブの tab.sh を Ctrl-C / ⌘Q で止めておく。
#
#   bash cleanup.sh
set -eu

KIT="$(cd "$(dirname "${0}")" && pwd)"
ME="$(id -un)"

# ダミーのフォルダ（tab.sh が作った ~/w/<repo>）
for r in web-app docs-site api-gateway; do
  rm -rf "${HOME}/w/${r}"
done
rmdir "${HOME}/w" 2>/dev/null || true
# dev-board の一時 HOME（Ctrl-C で消えるが、強制終了したときの残り）
for d in "${TMPDIR:-/tmp}"/turnlane-devboard-*; do
  [ -d "${d}" ] && rm -rf "${d}"
done
# デスクトップアプリの設定・キャッシュ（このユーザーの分だけ）
rm -rf "${HOME}/Library/Application Support/dev.turnlane.desktop" \
  "${HOME}/Library/Caches/dev.turnlane.desktop" \
  "${HOME}/Library/WebKit/dev.turnlane.desktop"
# キットの run/ の自分のファイル（pid とログ）
rm -f "${KIT}/run/board-${ME}.log"
for r in web-app docs-site api-gateway; do
  f="${KIT}/run/${r}.pid"
  [ -O "${f}" ] && rm -f "${f}"
done
echo "消しました。通知・オートメーション・画面収録の許可は システム設定 > プライバシーとセキュリティ / 通知 で外せます"
