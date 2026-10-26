#!/bin/bash
# デモ動画（M6-30）の場面 (3) 用: Ghostty のタブ 1 つに出すダミーの画面（docs/dev/demo-video.md）。
# Claude Code は動かさず、見た目もまねない。許可を求めていると分かる素の文を出して止まるだけ（D-259）。
#
#   bash tab.sh <api-gateway|web-app|docs-site> <ja|en>
#
# - ${TURNLANE_DEMO_W:-~/w}/<repo>（ダミーのフォルダ。無ければ作る）に移り、そこを作業フォルダとして OSC 7 で知らせ（Ghostty のタブの working directory）、OSC 2 でタブの題名をリポジトリ名にする
# - 自分の pid を ${TURNLANE_DEMO_RUN:-/Users/Shared/turnlane-demo/run}/<repo>.pid に書く（dev-board の --demo-pid に渡す）
# - Ctrl-C で終わる（カーソルを戻して pid のファイルを消す）
set -eu

REPO="${1:-}"
LANG_UI="${2:-ja}"
RUN_DIR="${TURNLANE_DEMO_RUN:-/Users/Shared/turnlane-demo/run}"
DEMO_W="${TURNLANE_DEMO_W:-${HOME}/w}"

case "${REPO}" in
  api-gateway) BRANCH="fix/auth-refresh" ;;
  web-app) BRANCH="feat/board-width" ;;
  docs-site) BRANCH="docs/deploy" ;;
  *)
    echo "usage: bash tab.sh <api-gateway|web-app|docs-site> <ja|en>" >&2
    exit 2
    ;;
esac
case "${LANG_UI}" in
  ja | en) ;;
  *)
    echo "usage: bash tab.sh <api-gateway|web-app|docs-site> <ja|en>" >&2
    exit 2
    ;;
esac

pick() {
  # pick <日本語> <英語>
  if [ "${LANG_UI}" = "en" ]; then printf '%s' "${2}"; else printf '%s' "${1}"; fi
}

case "${REPO}" in
  api-gateway)
    ASK="$(pick 'リフレッシュトークンの 401 を直して' 'Fix the 401 on token refresh')"
    DESC="$(pick '認証のテストを走らせる' 'Run the auth tests')"
    ;;
  web-app)
    ASK="$(pick '3日ボードの列幅を直して' 'Fix the three-day board column widths')"
    ;;
  docs-site)
    ASK="$(pick 'デプロイの手順を整理して' 'Tidy up the deploy guide')"
    ;;
esac

mkdir -p "${RUN_DIR}" "${DEMO_W}/${REPO}"
cd "${DEMO_W}/${REPO}"
PID_FILE="${RUN_DIR}/${REPO}.pid"
printf '%s\n' "$$" >"${PID_FILE}"

SLEEP_PID=""
cleanup() {
  [ -n "${SLEEP_PID}" ] && kill "${SLEEP_PID}" 2>/dev/null
  rm -f "${PID_FILE}"
  printf '\033[?25h'
  exit 0
}
trap cleanup INT TERM

# 作業フォルダ（OSC 7）とタブの題名（OSC 2）。画面を消してカーソルを隠す
printf '\033]7;file://localhost%s\007' "${PWD}"
printf '\033]2;%s\007' "${REPO}"
printf '\033[2J\033[H\033[?25l'

# 表示するパスは ~ からの形（ユーザー名を出さない）
SHOWN="${PWD/#${HOME}/~}"
printf '\n  %s  %s\n\n' "${SHOWN}" "${BRANCH}"
printf '  > %s\n\n' "${ASK}"
if [ "${REPO}" = "api-gateway" ]; then
  printf '  Bash  bun test src/auth\n'
  printf '        %s\n\n' "${DESC}"
  printf '  Allow this command?  1. Yes  2. No\n'
else
  printf '  %s\n' "$(pick '作業中…' 'Working…')"
fi

while :; do
  sleep 3600 &
  SLEEP_PID=$!
  wait "${SLEEP_PID}" || true
done
