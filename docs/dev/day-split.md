# 表示は暦の 0:00、集計と儀式は日付区切り（D-054）の確認手順

週ボードの列・縦軸（0:00〜24:00）・今日の列・現在線・ブロックの配置は暦どおり 0:00 で区切り、
集計と儀式（勤務時間、放置、日報、シャットダウン、ヘッダの集計値）は日付区切り（既定 04:00）で区切る。
規則は ux-mvp 4.4.1、API は m2-api の `DayColumn`（`logicalPhase` / `logical` / `nightWork` / `crossTasks`）と
`BoardResponse.openDay`、`ReadMeta.displayToday`。

日付区切りは `turnlane config set day_boundary 04:00` で変えられる（`turnlane config get` で今の値）。

## ダミーデータで深夜の状態を見る

```sh
bun run build:web
bun scripts/dev-board.ts --now 2026-10-03T01:40:00+09:00 --night --lang en --theme dark
```

`--night` は 0:10〜0:50 の AI の作業と、23:30〜0:30 に置いたタスク（Deploy hotfix）を足す。
論理日は 10/2 のまま、週ボードの今日の列は 10/3 になる。

| ファイル（`docs/dev/screens/day-split/`） | 見るところ |
|---|---|
| `week-board-night-en-dark.png` | 今日の列が Sat 10/3、縦軸が 0:00 から、現在線 01:40。上部に `Fri 10/2 is still open · Close the day`。Deploy hotfix の 0:00〜0:30 側。0:00〜1:40 は前日の勤務の続きなので沈めない |
| `week-board-night-bottom-en-dark.png` | 昨日の列の下端に Deploy hotfix の 23:30〜24:00 側 |
| `week-board-night-ja-dark.png` | 日本語（`金 10/2 がまだ閉じていません · 一日を閉じる`） |

0:00〜4:00 のブロックにホバーすると `Counted in Fri 10/2`（日本語 `金 10/2 に計上`）が出る（ブラウザの title）。
