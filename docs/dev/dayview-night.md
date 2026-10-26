# 深夜のデイビュー（0:00〜日付区切り）の確認手順

仕様は ux-mvp.md 4.5（縦軸と配置は暦どおり、集計は論理日）、m2-api.md 4.3（無効化）・23章。

- **不具合**: 0:00 を過ぎて日付区切り（既定 04:00）の前に AI が動いても、暦日の今日のデイビューに出なかった。`/api/day/:date` は暦日の時間軸にかかる実行を返していたが、SSE の無効化が `["day", date]` を論理日の一致だけで判定していたため、論理日が前日のイベントで取り直さなかった（3日ボードは前日まで含めていたので出ていた）
- **直したこと**: `day` も前日の論理日のイベントで無効化する。暦日の今日を深夜に開いたときは、上部の集計・`勤務`・閉じたもの・放置の内訳を今の論理日（前日）の値にし、`金 10/2 の集計` と添える（`DayDetail.summary`）
- `turnlane ai --date` は従来どおり論理日で数える

自動で確かめているもの（`bun run check`）: `apps/daemon/test/day-api.test.ts` の「深夜のデイビュー」（暦日の今日に 0:00〜日付区切りの実行と now まで続くターンが入る、前の暦日には 0:00 以降に始めた実行が入らない、集計は今の論理日、4:00 を過ぎたら戻る）、`apps/web/test/day-layout.test.ts` の「深夜（0:00〜日付区切り）の AI のブロック」（0:00 から now まで、前の暦日は 24:00 で切る）、`apps/web/test/data.test.ts` の「day は前日の論理日のイベントでも無効化する」。

## ダミーデータで見る

```sh
bun run build:web
bun scripts/dev-board.ts --now 2026-10-03T03:50:00+09:00 --night --lang ja --theme dark   # --open /day でも可
```

| ファイル（`docs/dev/screens/dayview-night/`） | 見るところ |
|---|---|
| `day-view-night-today-ja-dark.png` | 暦日の今日 土 10/3 のデイビュー。上端（0:00）から現在線 03:50 まで稼働中の `Day view lanes` と待ちの線、自分レーンの `Deploy hotfix`（0:00〜0:30 側）。上部は `金 10/2 の集計` と金曜の値、`勤務 8:42 – 現在（自動）`。左パネルの閉じたもの・放置も金曜の値 |
| `day-view-night-prev-bottom-ja-dark.png` | 前の暦日 金 10/2 のデイビューの下端。ブロックは 24:00 で切れ、0:00 以降は描かない（`Deploy hotfix` の 23:30〜24:00 側）。集計は金曜の値で、日付は添えない |

0:00〜4:00 のブロックにホバーすると `金 10/2 に計上` が出る（従来どおり）。ダミーデータの 0:10〜0:50 の `log rotation` は AI レーンの3列を超えるので `+2` に入る。

ヘッドレスの Chrome（CDP、1440×900、2倍）で撮影。

## オーナーの入れ替え手順

```sh
cd ~/source/dayline
git pull               # main
bun install
bun run check
bun run build
bun run smoke
out/turnlane self-install    # デーモンと turnlane を入れ替える（マイグレーションは無し）
```

デーモンの入れ替えと開いているウインドウの再読み込み（⌘R）で反映される。デスクトップアプリとカレンダーヘルパは入れ替え不要。
