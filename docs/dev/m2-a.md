# M2 段階 A の確認手順（週ボードを自分の Mac で開く）

M2 の段階 A（phase0-plan 4.4。常用開始の前に要る範囲）を入れ替えて、週ボード・YOUR TURN・Inbox・MCP の
`add_task` を確かめる手順。自動で確かめられる部分は `bun run check` と `bun run smoke`（一時 HOME）が行う。

- 段階 A に入っているもの: 週ボード（M2-3）、今日の AI レーン（M2-14）、YOUR TURN 帯と要対応キュー（M2-6）、
  タスク操作と Inbox（M2-4）、キーボード（M2-7）、AI 詳細パネル（M2-5）、ブラウザ通知（M2-8）、
  `turnlane add / today / ls / done` と `turnlane mcp`（M2-10）、テーマ（ダーク・ライト・System）と言語（英語・日本語）
- まだ無いもの（段階 B）: デイビュー（上部の Day は押せない）、DnD、時間ブロックの作成・伸縮、⌘K の検索
  （⌘K は当面ショートカット一覧を開く）、週ボードの仕上げ（過去日のリボン、範囲外のヒント、開始境界のドラッグ）、
  設定画面の本体（取り込み元・カレンダーなど。設定画面はテーマ・言語・通知だけ）、日報
- 予定（カレンダー）は M3 の A で入る。それまで週ボードの予定は空で、Free は勤務時間そのものになる

## 0. 入れ替える前に（任意）: ダミーデータで画面を見る

実データに触れずに画面だけ見たいときは、ダミーデータと偽の時計（2026-10-02 13:20）で動かせる。
一時 HOME を作って別ポート（27317）で動き、Ctrl-C で止めると一時 HOME を消す。常駐のデーモン（7317）には触れない。

```sh
cd ~/source/dayline
bun install
bun run dev:board      # 表示された http://127.0.0.1:27317/auth?t=... をブラウザで開く
```

`bun run build:web && bun scripts/dev-board.ts --place-reply 15:00` で、YOUR TURN の「Reply: draft pricing」を
朝 9:00 に 15:00〜15:30 へ置いた状態になる（D-051 の確認用。今日の Idle が 3h53m → 40m になり、AI 詳細の内訳に
Scheduled が出る。`--now 2026-10-02T16:00:00+09:00` を足すと 15:00 以降が放置に戻るのを確かめられる）。

確認用のスクリーンショット（このダミーデータで撮ったもの）は `docs/dev/screens/m2-a/` にある。

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

- DB のマイグレーションが1本増える（`0004_d051_scheduled_wait`。待ち区間のキャッシュ `ai_wait_segment` に集計外 `scheduled` を足す。D-051）。適用前にデーモンが `backups/pre-migrate-0004-<時刻>.db` を取る。待ち区間はキャッシュなので作り直され、他のデータは変わらない
- 入れ替え後の最初の判定で、次の3つが効く（PO 決定。データは消えない）
  - **D-048 (4)**: タスクのない your_turn は72時間で done になる。M1 で溜まっていたタスクのない your_turn のカードは
    ここで done になり、YOUR TURN に出なくなる（AI レーン・`turnlane ai` では状態どおりに見える）
  - **D-049 (1)**: hooks なしで AskUserQuestion に止まっている AI は返答タスク、hooks なしでプロセスが idle の許可待ちは
    approve のタスクになり、YOUR TURN と通知に出る（72時間より古い待ちからは作らない）
  - **D-051**: 時間に置いた（時間ブロックのある）自分の番のタスクは、置いた時刻からブロックの開始まで放置に数えない
    （集計外 `scheduled`）。開始を過ぎても手を付けなければ、そこから放置に数える。「今日」にしただけのものは従来どおり

## 2. 週ボードを開く

```sh
turnlane open board          # ブラウザで週ボードが開く（認証付きの URL）
```

見るところ（確定デザイン `docs/design/screens/week-board-v4.png` と同じ構造）:

- カラムは昨日・今日・以降（ウィンドウの幅で日数が変わる）。今日は幅が約2倍で、左が自分・右が AI
- 今日のヘッダに `Free · Events · Planned · Idle · Expired`、昨日に `n/m done · AI · Idle`（0 の項目は出ない）
- 今日の上部に YOUR TURN（needs_input → error → your_turn、待ちの長い順に5行まで）
- 今日の時間軸に `Started 8:42 (auto)` の線、紫の現在線、AI の実行ブロックと待ち線（放置は状態色の点線、
  10分以上なら `idle 11m`）
- サイドバーの Sources に取り込み元の健全性（hooks の spool は出さない）

外観と言語は Settings（サイドバーの下）で変える。既定は System（macOS の外観設定・ブラウザの言語に従う）。

## 3. 段階 A の完了条件を確かめる（phase0-plan 4.4）

| 条件 | 確かめ方 |
|---|---|
| 丸1日、タスク管理を週ボードとキーボードだけで行える | `c` で追加（`Write outline tomorrow 30m #blog` のような自然言語。チップで確認し ⏎）、`j` / `k` / `h` / `l` で移動、`Space` で完了、`r` で名前、`m` で日付（`tomorrow`、`mon`、`10/5`、`inbox`）、`>` / `<` で1日ずらす、`t` で今日へ、`⌘⌫` で削除と `⌘Z`、`?` で一覧。`g i` で Inbox、`g q` で自分の番 |
| Claude / Codex の自分の番が YOUR TURN 帯とキューに出て、対応すると自動で閉じる | 質問で終わったセッションを15分置く → 帯に `Reply: …`。そのセッションに返答すると数秒で消え、帯の下に取り消し線で残る。`⏎` は再開コマンドをコピー（PR は開く）、`s` スヌーズ、`e` 対応不要、`x` で複数選んで一括 |
| Claude Code の会話から `add_task` したタスクが、印付きで Inbox に入る | 下の 4 で MCP を登録し、会話で「Turnlane にタスクを追加して」と頼む → Inbox に `MCP via claude-code` の印付きで入り、画面にトースト（`Undo` で取り消せる） |
| `source` / `external_id` 付きで同じ項目を2回送っても1件 | `turnlane add "Fix login bug" --source github --external-id issue-42` を2回 → `turnlane ls --inbox` で1件。削除してからもう一度送っても作られない |
| 英語 UI で、macOS の外観設定に合わせてダーク・ライトが切り替わる | Settings で Appearance を System にし、macOS の外観を切り替える |

ブラウザ通知は Settings の Notifications で許可する（needs_input / error は即時、your_turn は15分ごとにまとめ、
同じカードは5分以内に再送しない）。タブのタイトルに件数 `(3) turnlane` が出る。

## 4. MCP（`turnlane mcp`）を登録する

`turnlane mcp` はデーモンの API を叩くだけの stdio の MCP サーバ。MCP からの追加は勤務時間の「操作」に数えない。

`turnlane mcp install` で、見つかった Claude Code の設定ディレクトリすべてと Codex に登録できる（D-145。`--dry-run` で書く内容を確かめられる。`turnlane mcp status` で状態）。手で登録するなら次のとおり。

Claude Code（設定ディレクトリごと。既定の `~/.claude` 以外は `CLAUDE_CONFIG_DIR` を付ける）:

```sh
claude mcp add --scope user turnlane -- ~/.local/bin/turnlane mcp
CLAUDE_CONFIG_DIR=~/.claude-<name> claude mcp add --scope user turnlane -- ~/.local/bin/turnlane mcp
```

Codex（`~/.codex/config.toml`。`~` は展開されないので、自分のホームの絶対パスを書く）:

```toml
[mcp_servers.turnlane]
command = "/Users/<you>/.local/bin/turnlane"
args = ["mcp"]
```

使えるツール: `add_task`（既定は Inbox。`source` と `external_id` は両方か両方省略）、`list_tasks`、`get_today`、`get_day`、
`get_free_slots`、`schedule_task`、`complete_task`、`list_your_turn`、`get_ai_work`。`get_daily_report` は M4 まで
エラーを返す。削除・一括更新のツールは無い。

## 5. CLI

```sh
turnlane add Write outline tomorrow 30m #blog   # 自然言語。日付が無ければ Inbox
turnlane today                                  # 今日の予定・タスク・自分の番の件数
turnlane ls [--date YYYY-MM-DD | --inbox]
turnlane done <id>                              # turnlane ls に出る接頭辞（最低8文字）でよい
```

デーモンが止まっているときの `turnlane add` は `~/Library/Application Support/turnlane/spool/cli-YYYYMMDD.jsonl` に書き、
デーモンが起動時（と1分ごと）に取り込む（再送しても重複しない）。

## 6. うまくいかないとき

```sh
turnlane daemon logs -n 100
turnlane doctor
```

- 画面が真っ白: `turnlane daemon restart` してから `turnlane open board` で開き直す（Web UI はデーモンに埋め込まれている）
- 上部に「Not signed in」: `turnlane open` で開き直す（クッキーはブラウザを閉じると消える）
- 上部に「Background recording has stopped.」: デーモンへの接続（SSE）が切れている。`turnlane daemon status`
- 戻したいとき: 1つ前のビルド（git の前のコミット）で `bun run build && out/turnlane self-install`。
  古いビルドは新しいマイグレーション（0004）を知らないので起動を拒む。デーモンを止めてから
  `backups/pre-migrate-0004-<時刻>.db` を `turnlane.db` に戻す（0004 以降の変更は失われる）
