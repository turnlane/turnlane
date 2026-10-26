# M4 段階 A の確認手順（夕方のシャットダウンと日報、利用計測）

M4 の段階 A（phase0-plan 4.6。常用開始の前に要る範囲）と M5-1（利用計測）を入れ替えて確かめる手順。
自動で確かめられる部分は `bun run check`（日報の golden テスト英日、持ち越し先、利用計測、API の結合テスト）が行う。

- 段階 A に入っているもの: 儀式の共通レイアウト（M4-5）、日報（M4-3。画面・`turnlane report`・MCP `get_daily_report`）、
  シャットダウン2ステップ（M4-2）、日付区切りでの日の確定（M4-4）、利用計測と `turnlane stats`（M5-1）
- まだ無いもの（段階 B）: 朝の計画（M4-1・M4-7）、日報の AI 要約（M4-6。チェックボックスは出していない）、
  ⌘K からの入口（M2-15）
- 持ち越し先と `m`（明日）の「次の稼働日」は M3-6 の判定（稼働曜日と祝日カレンダー）
- D-052 の手直し（2026-10-04）: `m` は勤務開始までスヌーズ、閉店モードは次の勤務開始まで全通知を止める、
  日報の回答待ち / 許可待ちの書き分け、実行中・待ち中のカードの AI 時間、ダミーデータの所要時間
- 会議の時間（`meetings 1h30m` と積み上げ棒の Meetings）はカレンダー（M3 の A）が入るまで 0

## 0. 入れ替える前に（任意）: ダミーデータで画面を見る

実データに触れずに、一時 HOME・別ポート（27317）・偽の時計で動かせる。Ctrl-C で止めると一時 HOME を消す。

```sh
cd ~/source/dayline
bun install
bun run build:web
bun scripts/dev-board.ts --now 2026-10-02T19:40:00+09:00 --open /shutdown --lang en --theme dark
# 表示された http://127.0.0.1:27317/auth?t=... をブラウザで開く。--open "/shutdown?step=2" で Step 2 から、--lang ja で日本語
```

スクリーンショット（このダミーデータで撮ったもの）は `docs/dev/screens/m4-a/` にある。

| ファイル | 内容 |
|---|---|
| `shutdown-step1-en-dark.png` | Step 1「Your turn」 |
| `shutdown-step2-en-dark.png` | Step 2「Daily note」 |
| `shutdown-step2-ja-dark.png` | Step 2 の日本語 |
| `shutdown-closed-en-dark.png` | Close the day の後（確定した日報と閉店モード） |

## 1. ビルドと入れ替え

```sh
cd ~/source/dayline
git pull               # main
bun install
bun run check          # biome / tsc -b / bun test
bun run build          # out/turnlaned と out/turnlane（Web UI を埋め込む）
bun run smoke          # 一時 HOME で M0〜M2 の確認
out/turnlane self-install    # ~/.local/bin を入れ替え、デーモンを再起動する
turnlane daemon status
```

- DB のマイグレーションは増えない（既存の `daily_note`・`usage_event` を使う）
- 入れ替えた直後から、UI を開くたびに `usage_event(kind='ui_open')` が記録される（14日カウントの初日から記録するため。
  勤務時間の「操作」には数えない）
- デーモンの起動時と日付区切り（04:00）のたびに、閉じていない前の日の日報をその時点の内容で確定する（`report_md`。
  持ち越しはしない）

## 2. シャットダウンを1回通す（M4 の A の完了条件）

1. `turnlane open board` で開き、サイドバーの **Daily note**（または `g r`）→ 右上の **Close the day**。
   直接 `http://127.0.0.1:7317/shutdown` を開いてもよい
2. Step 1「Your turn」: 未処理の自分の番が1件ずつ並ぶ
   - `j` / `k` で選び、`⏎` で開く・対応（PR は開く、セッションは再開コマンドをコピー）、`m` で明日（次の稼働日）へ、
     `e` で対応不要、`s` でスヌーズ。許可待ちの行にだけ琥珀で「This session stays blocked until you approve.」
   - `m` を押した行は「→ Mon 10/5」になって一覧に残る。週ボードの今日の YOUR TURN 帯からは消え、
     次の稼働日の勤務開始（いつもの開始時刻）まで出てこない（スヌーズ。放置にも数えない。D-052 (1)）。
     帯とキュー（`g q`）の `m` も同じ
   - 下に「Closed automatically today: …」（今日自動で閉じた件数）
   - `⌘⏎` で次へ
3. Step 2「Daily note」
   - 上の `Worked 8:42 – 19:40 (auto) · Edit` で勤務時間を確かめる。違えば **Edit** で直す（日報が計算し直される）
   - 日報を読む: `Time: You … · AI … (n runs, up to n in parallel)`、紫の縦線の `Idle … · Expired …`、
     リポジトリ別の放置、`Expired: <項目名>`、What I did / What the AI did / Carried over
   - What the AI did で、質問で止まっているものは `waiting for your answer`、許可待ちは `waiting for approval`。
     実行中・待ち中のものも AI の時間が 0m にならない（始まりから今、または待ちの始まりまで）
   - 直したいときは **Edit text** で Markdown を直接編集できる（**Reset to generated** で戻す）
   - Note に1行書く。**Copy Markdown** で全文をコピーして Slack やメモに貼れるか確かめる
   - `⌘⏎`（または **Close the day**）で確定する
4. 確定後: 「Closed at 19:42. Notifications are paused until your next workday starts.」が出る。
   - 今日の未完了タスクが次の稼働日に移っている（週ボードで確認。持ち越し回数が1増える）
   - 金曜に閉じると月曜に行く
   - 次の勤務開始（次の稼働日のいつもの開始時刻。それより前に AI を使うなど操作すればその時刻）まで、
     通知が一切出ない（D-052 (2)）。許可待ちだけは通知してほしければ、設定（Settings）の
     「Approval requests outside working hours（日本語「勤務時間外の許可待ち」。D-080 で改名）」を On にする（既定 Off）

```sh
turnlane report              # 今日の日報（確定済みならその内容）
turnlane report 2026-10-02 --copy --lang ja
```

## 3. 利用計測（M5-1）

```sh
turnlane stats               # 直近14日: UI を開いた日・朝 / 夕の儀式・数える日、連続日数、自分の番の処理数、平均応答時間
turnlane stats --days 14 --json
```

- 数える日 = UI を開き、かつ朝か夕方の儀式を1回以上行った日（D-006）。段階 A では夕方のシャットダウンだけが儀式
- 連続日数は今日で終わる（今日がまだ数えられていなければ昨日で終わる）
- 自分の番の処理数 = 返答・解決（推定）・対応不要で閉じたもの。期限切れは別に数える。平均応答時間はキュー画面と同じ定義

## 4. うまくいかないとき

```sh
turnlane daemon logs -n 100
turnlane doctor
```

- 日報の画面が「Loading…」のまま: `turnlane daemon restart` してから `turnlane open board` で開き直す
- 戻したいとき: 1つ前のビルドで `bun run build && out/turnlane self-install`。マイグレーションは増えていないので DB はそのまま使える
