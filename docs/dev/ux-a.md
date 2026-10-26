# UX 監査 (a): 実装ですぐ直す14項目（確認と入れ替えの手順）

PO 決定 D-099（マウスで全ての操作ができる。キーボードは補助）・D-101（(2) 空き枠から作る既定はタスク、タスク / 予定の
切り替えを大きく見せる (3) 週表示の見出しを `10/1 – 10/7` に (4) 未実装のキーを一覧から外す）。仕様は ux-mvp 6.3
（見える操作の3層・クリックの規則・右クリックメニュー）と 2章・4.4・4.6・4.10・4.12・7章・8章、desktop-shell 4.2。
見た目の大きな変更（色・AI の帯化・紫・mono の範囲）は Claude Design で決めてから入れるので、今回は入れていない。

| # | 内容 | 主な場所 |
|---|---|---|
| A1 | 全種類（タスク・自分の番・AI・予定・空き枠）の右クリックメニュー。右に今のキー | `actions/item-actions.tsx`、`components/ContextMenu.tsx` |
| A2 | 自分の番の行にチェックボックスとホバーのボタン（開いて対応・明日へ・スヌーズ・対応不要・…）。メニューバーも | `components/TurnRow.tsx`、`components/HoverToolbar.tsx`、`routes/TrayPage.tsx` |
| A3 | 1クリックで選択して詳細パネル（どの種類も）。パネルは選択に追従。ダブルクリックで名前の変更 / 開く | `actions/item-actions.tsx` |
| A4 | パネルを開いたままの ⏎ で朝の計画へ移る不具合 | `keys/use-keys.ts`（控えの処理）、`layout/AppShell.tsx` |
| A5 | 上部バーの `＋ 新規 ▾`（タスク / 予定）、列の末尾に常に `+ 追加` | `layout/AppShell.tsx`、`board/WeekBoard.tsx`、`day/DayView.tsx` |
| A6 | 空き枠のクリックで作成の入力（15分の枠から30分） | `board/dnd.tsx`（`useRangeSelect`） |
| A7 | 作成の入力の `タスク / 予定` を幅いっぱいのタブに。`作成` のボタン | `board/editors.tsx` |
| A8 | 上部右の件数に状態の名前。取り込み元の状態をホバーで | `layout/AppShell.tsx` |
| A9 | ボード・デイビューの右下に凡例 | `components/Legend.tsx` |
| A10 | キュー・Inbox・設定・日報では日付送りと `3日 / 週 / 日` を出さない | `layout/AppShell.tsx` |
| A11 | サイドバーに `一日を閉じる`（17時以降は強め）。シャットダウン Step 2 の主ボタンを下に固定 | `layout/AppShell.tsx`、`ritual/ShutdownPage.tsx` |
| A12 | `b`・`*` をキーの定義から外す（`f`・`⌘.` と合わせて仕様は v1） | `keys/keymap.ts` |
| A13 | 今日の列の上部をボードの高さの 35% までにし、中でスクロール | `board/WeekBoard.tsx` |
| A14 | ⇧ / ⌘ クリックの複数選択と、下の一括操作のバー | `components/BulkBar.tsx` |

自動で確かめられる部分は `bun run check`（メニューの中身・複数選択・⏎ の順番・週の見出し・未実装のキー。
`apps/web/test/mouse-ops.test.ts`）と `bun run e2e`（`mouse` スイート: 主要な6つの流れをショートカットのキーを押さずに
Chromium と WebKit で完了する）。

## ダミーデータで見る

```sh
bun run build:web
bun scripts/dev-board.ts --lang ja --dense     # 朝の状態は --morning
```

スクリーンショット（ダミー、日本語ライト）: `docs/dev/screens/ux-a/`

| ファイル | 内容 |
|---|---|
| `01-board-3day` | 3日ボード（上部バーの `＋ 新規`・件数の文字・`一日を閉じる`・列の `+ 追加`・右下の凡例） |
| `02-turn-hover-toolbar` / `03-turn-context-menu` | 自分の番の行のホバーのボタン / 右クリックメニュー |
| `04-task-hover-and-menu` | タスクのカードのホバーのボタンと右クリックメニュー |
| `05-ai-context-menu` / `06-event-context-menu` | AI の作業 / 予定の右クリックメニュー |
| `07-turn-click-panel` | 自分の番の行の1クリックで AI 詳細パネル |
| `08-slot-click-create` / `09-slot-click-create-event` | 空き枠のクリックの作成の入力（既定はタスク / 予定のタブ） |
| `10-slot-context-menu` / `11-new-button` | 空き枠の右クリック / 上部の `＋ 新規` |
| `12-multi-select-bulk-bar` | ⌘ クリックの複数選択と一括操作のバー |
| `13-legend` | 凡例 |
| `14-week-range-label` | 週表示の見出し `10/1 – 10/6`（ウインドウの幅に入る日数。パネルを開いているので6日） |
| `15-queue-hover-no-date-nav` / `17-settings-no-date-nav` | キュー（行のホバー）と設定。上部に日付送りを出さない |
| `16-day-view` | デイビュー（左の `+ 追加`・凡例） |
| `18-key-help` | `?` の一覧（`b`・`*` が無い） |
| `19-shutdown-step2-sticky` | シャットダウン Step 2（主ボタンを下に固定） |
| `20-tray-hover` | メニューバーのポップオーバー（/tray。行のチェックとホバーのボタン） |
| `21-morning-board-top-capped` | 朝のボード（上部が 35% で止まり、中でスクロール） |

## オーナーの手順

### 1. デーモン（UI）の入れ替え（必要。DB のマイグレーションは無い）

```sh
cd ~/source/dayline
git pull               # main
bun install
bun run check
bun run build
bun run smoke
out/turnlane self-install    # デーモンを入れ替える（UI はデーモンに埋め込まれている）
```

- デスクトップアプリ・カレンダーヘルパ・hooks の入れ替えは要らない（変更は Web の UI だけ。メニューバーのポップオーバーも
  デーモンが配る画面なので、デーモンを入れ替えれば変わる）
- 開いている画面は再読み込み（⌘R）すると新しい UI になる

### 2. 確認項目（結果を PO に返す）

1. ボードで自分の番の行にカーソルを載せる → 右端に5つのボタン。`明日へ` で行が消え、次の稼働日の帯に出る
2. 自分の番の行・タスク・AI の作業・予定をそれぞれ右クリック → メニュー（右にキー）。予定は `カレンダーで開く` が動く
3. どの項目も1クリックで右にパネルが開き、別の項目をクリック（または `j` / `k`）するとパネルの中身が替わる。
   タスクのパネルを開いたまま ⏎ を押しても朝の計画へ移らない
4. 空き枠をクリック → 作成の入力（タスク / 予定のタブ）。`予定` を選んで `作成` → Calendar.app に30分の予定ができる
5. ⌘ クリックで2件選ぶ → 下のバーの `1日後へ` で両方が動く
6. 上部の `＋ 新規` → タスク / 予定。キュー・設定では上部に日付送りが出ない。週表示の見出しが `10/1 – 10/7` の形
7. 夕方、サイドバーの `一日を閉じる` → Step 2 で日報が長くても `一日を閉じる` のボタンが画面の下に見えている
