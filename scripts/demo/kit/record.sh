#!/bin/bash
# 撮影キット: 画面を録る（screencapture -v。Retina のまま。音声なし）。決まった秒数で止まる（途中で止めるなら Ctrl-C）。
#
#   bash record.sh <ja|en> <scene3|banner>
#
# - scene3: カーソルも写す。35 秒。captures/<lang>/scene3.mov
# - banner: カーソルは写さない。70 秒（board.sh banner の 45 秒後の通知を待つ）。captures/<lang>/banner.mov
# 録るのはメインの画面全体。切り出しは組み立てのときに行う（scripts/demo-assemble.ts の edit.json）
set -eu

KIT="$(cd "$(dirname "${0}")" && pwd)"
LANG_UI="${1:-}"
MODE="${2:-}"
usage() {
  echo "usage: bash record.sh <ja|en> <scene3|banner>" >&2
  exit 2
}
case "${LANG_UI}" in ja | en) ;; *) usage ;; esac
case "${MODE}" in
  scene3)
    SECS=35
    CURSOR=-C
    ;;
  banner)
    SECS=70
    CURSOR=""
    ;;
  *) usage ;;
esac
OUT_DIR="${KIT}/captures/${LANG_UI}"
mkdir -p "${OUT_DIR}"
OUT="${OUT_DIR}/${MODE}.mov"
if [ -f "${OUT}" ]; then
  mv "${OUT}" "${OUT_DIR}/${MODE}-$(date +%H%M%S).mov"
fi
echo "3 秒後に録り始めます（${SECS} 秒）: ${OUT}"
sleep 3
echo "録画中"
if [ -n "${CURSOR}" ]; then
  screencapture -v -V "${SECS}" "${CURSOR}" "${OUT}"
else
  screencapture -v -V "${SECS}" "${OUT}"
fi
echo "保存しました: ${OUT}"
