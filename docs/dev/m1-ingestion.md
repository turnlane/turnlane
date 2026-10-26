# M1 の確認手順（自分の Mac で取り込みを有効にする・hooks を入れる）

M1（取り込み）の完了条件（phase0-plan 4.3）のうち、自分のデータと記憶で確かめるものの手順。
自動で確かめられる部分は `bun run check` と `bun run smoke`（一時 HOME・匿名化フィクスチャ）が行う。

- 対象: M0 の手順（[m0-install.md](./m0-install.md)）で常駐させた Turnlane を、M1 のビルドに入れ替える
- M1 から turnlaned は AI セッションのローカルファイルを**読み取り専用で**読む:
  `~/.claude` と `~/.claude-*`（`projects/` があるもの。別アカウント用も含めてすべて）、`~/.codex`
  （rollout JSONL・`session_index.jsonl`・`archived_sessions/`。SQLite は開かない）
- 書き込むのは Turnlane のデータディレクトリ（`~/Library/Application Support/turnlane/`）だけ。
  hooks を入れる手順（3）だけが Claude Code / Codex の設定ファイルを書き換える（Turnlane のエントリだけ。バックアップあり）
- 会話本文は保存しない（ADR 0005）。PR の状態は `gh` がログイン済みなら `gh pr view` で確かめる（読み取りのみ）
- Idle（放置）は D-045 の3原則で数える: (1) YOUR TURN にタスク（返答・PR レビュー・許可待ち・再開）が出ている間だけ、
  (2) 日別は同時に待っている時間を1回だけ（和集合）、(3) 初回の取り込みでは72時間より古い待ちからタスクを作らない

## 1. ビルドと入れ替え

```sh
cd ~/source/dayline
bun install
bun run check          # biome / tsc -b / bun test（M1 のシナリオ W1〜W32、番兵テストを含む）
bun run build          # out/turnlaned と out/turnlane
bun run bench:hook     # turnlane hook の起動時間（p95 50ms 以内）
bun run smoke          # 一時 HOME で取り込み → turnlane ai / turnlane queue、hooks の即時反映まで
out/turnlane self-install    # ~/.local/bin を入れ替え、デーモンを再起動する
turnlane daemon status
```

- 起動時に DB のマイグレーション（M1 は 0002・0003）を当てる。当てる前の DB は `backups/` に残る
- M1 のビルドを一度入れた後に入れ替える場合も同じ手順でよい（0003 だけ当たる。待ち区間は作り直す）

起動すると、検出した設定ディレクトリを最初から読む（30日分で数秒〜数十秒）。進み具合と健全性:

```sh
turnlane sources
```

- 各行に `claude_code` / `codex` / `hook_spool` と、プロファイル名（`default` / `acme` / `sandbox` など）、
  `health L0`（L1・L2 なら形式が変わった疑い）、`hooks none`（手順 3 の前）が出る
- 最後の行が `初回の取り込み: 完了` になれば、過去分は読み終わっている
- 取り込みたくない設定ディレクトリやリポジトリがあれば、`PATCH /api/sources/:id`（`enabled: false` か
  `excludeGlobs`）で外せる（設定画面は M2-9）

## 2. 過去7日を自分の記憶と照合する（M1 完了条件）

```sh
turnlane ai --days 7          # 日ごとのカード、勤務時間、AI 時間、Idle、Expired
turnlane queue                # 今の自分の番（カードの下の「- Reply: …」などが YOUR TURN のタスク）
turnlane doctor               # DB の監査（300 文字を超える値が 0 件 = 本文が入っていない）
```

入れた直後の数字の読み方:

- **過去の日の Idle はほぼ 0 になる**。放置はタスクが出ている間だけ数え、タスクは入れた時点で作るので、入れる前の
  待ちは放置に遡らない（D-045。待ち区間そのものは記録されていて、`no_task` の集計外として残る）。Idle は入れた後の
  日から意味を持つ
- **タスクになるのは直近72時間の待ちだけ**。それより古い質問・エラー・PR からはタスクを作らないので、`turnlane queue` の
  「- Reply: …」などは数件のはず。数十件出たら PO に伝える
- **Expired** は返答・再開のタスクが72時間で期限切れになった件数。入れた直後は 0 で、3日後から出始める
- **日別 Idle はその日の勤務時間（`work 09:12–18:40`）を超えない**。超えていたら不具合なので PO に伝える
- `turnlane queue` には、タスクが無くても状態が YOUR TURN のカード（編集ありで止まっているもの）が並ぶ。これらは放置に
  数えない。数が多くて邪魔なら、その旨を PO に伝える（状態の期限の扱いは PO の判断）

見るところ:

1. **直近3日分に大きな取りこぼし・分裂が無いか**: 1枚のカード = リポジトリ × ブランチ（既定ブランチと git 管理外は
   セッション単位）。同じ作業が2枚に割れていたり、別の作業が1枚に混ざっていたりしないか。別アカウント
   （`~/.claude-acme` など）の作業も出ているか
2. **状態**: `YOUR TURN` は「PR を確認する」「編集を確認する」「質問に答える」のどれかで、本当に自分の番か。
   `~` が付いた状態は推定（hooks なし）
3. **Idle**: 入れた翌日以降の Idle が、実際に返答・レビューを放置した時間の実感と合うか。夜間（勤務時間 = その日の
   最初〜最後の操作の外）が入っていないか。会議中の除外はカレンダー（M3）までは効かない
4. **勤務時間**: `work 09:12–now` がその日の実感と合うか。違えば修正できる（UI は M2。今は API:
   `curl -X PUT -H "Authorization: Bearer $(cat ~/Library/Application\ Support/turnlane/token)" -H "x-turnlane-client: cli" -H "content-type: application/json" -d '{"start": <epoch ms>}' http://127.0.0.1:7317/api/work-hours/2026-10-03`）

気づいた点（分けすぎ・まとめすぎ・状態の誤り・Idle の過大）は、カードのタイトルを伏せて PO に伝える。

## 3. hooks を入れる（任意。状態の即時反映）

hooks が無くても全機能が動く（数十秒遅れ・推定表示）。入れると「許可待ち」が数秒で出て、`~` の付かない状態になる。

先に差分を見る（何も書かない）:

```sh
turnlane hooks install --dry-run
```

- 検出した Claude の各設定ディレクトリの `settings.json` と、`~/.codex/hooks.json` が対象。
  一部だけにするなら `--claude-dir ~/.claude` や `--codex` で指定する
- Turnlane のエントリは、イベントごとに自分専用のグループを配列の**末尾**に足すだけ。他ツールのエントリには触らない。
  設定ファイルに未知のキーは足さない（識別はコマンドの `--managed-by turnlane`）
- 書式（空白など）が正規形でないファイルは「書式が正規化されます」と出る

入れる:

```sh
turnlane hooks install
turnlane hooks status
```

- 変更したファイルの横に `*.bak-turnlane-<時刻>` のバックアップができる（変更が無ければ作らない）
- Claude Code は設定ファイルの変更をすぐ読むので、承認は要らない
- **Codex は承認が要る**: 次に Codex を起動したら `/hooks` を開き、Turnlane の hook（`... hook --tool codex --managed-by turnlane`）を
  承認する。承認するまで黙って動かない。`turnlane hooks status` の「承認待ち」が消え、`turnlane sources` の Codex が
  `hooks receiving` になれば届いている
- `turnlane` の場所を変えた（入れ直した）ときも Codex の再承認が要る

確かめる（Claude Code）: 何か許可の要る操作（例: 新しいコマンドの実行）を頼み、許可のプロンプトが出ている間に

```sh
turnlane queue                # 数秒以内に NEEDS INPUT [approve] が出る
turnlane sources              # Claude のプロファイルが hooks receiving
```

質問で終わるやり取りをすると、15分後に `turnlane queue` に `[reply]` が出て、返答すると自動で閉じる。
「他に何かありますか？」のような締めの決まり文句では出ない。返答タスクのあるブランチでコミットすると
「解決済み（推定）」で閉じる。

### hooks を外す

```sh
turnlane hooks uninstall --dry-run
turnlane hooks uninstall
```

- Turnlane のエントリだけを外す（ファイルは消さない）
- Codex で Turnlane より後ろに他ツールの hook がある場合、外すと位置がずれてそのツールの承認が外れる。
  Turnlane は承認状態を書き換えないので、表示された hook を `/hooks` で承認し直す（PO 決定 D-030）

## 4. うまくいかないとき

| 症状 | 確かめること |
|---|---|
| `turnlane ai` が空 | `turnlane sources` に設定ディレクトリが出ているか。`turnlane daemon logs` に `ingest.*_failed` が無いか |
| 状態が `running` のまま | 5分（Codex は10分）更新が無ければ自動で外れる。`turnlane rederive` で今すぐ再計算できる |
| hooks を入れたのに `hooks installed` のまま | Claude: プロジェクトの `.claude/settings.json` の `disableAllHooks`、管理設定。Codex: `/hooks` での承認、`config.toml` の `[features] hooks = false`。24時間届かないと `silent` になる |
| 取り込み結果をやり直したい | `turnlane reingest`（カーソルを戻して読み直す。行は消さない）→ `turnlane rederive` |
| 古い日の Idle を作り直したい | `turnlane rederive --wait --since 2026-09-20`（カレンダーの窓より古い日は自動では作り直さない） |
| Idle が勤務時間を超えている・数十時間ある | 不具合。`turnlane ai --days 7 --json` の `idleMs` と `workHours` を、タイトルを伏せて PO に伝える |
| 古い質問・PR のタスクが大量に出た | 72時間より古い待ちからは作らない（D-045）はず。件数を PO に伝える |

## 5. 推奨（自動ではやらない）

- Claude Code はトランスクリプトを既定30日で消す（`cleanupPeriodDays`）。Turnlane は取り込んだ時点で
  メタデータを残すが、元ファイルが長く残る方が読み直しに強い。各設定ディレクトリの `settings.json` で延長するかは自分で決める
