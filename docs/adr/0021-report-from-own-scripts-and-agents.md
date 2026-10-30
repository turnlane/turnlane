# ADR 0021: 自分のスクリプト・エージェントの報告を、もう 1 つの取り込み元として扱う

- ステータス: Accepted（2026-10-30）
- 日付: 2026-10-30

## Context

- Turnlane が拾える AI の作業は、手元に記録（トランスクリプト・rollout）と hooks を残すツール（Claude Code・Codex）だけだった。利用者の自前のスクリプト・cron・LaunchAgent、記録を残さない形で動くエージェント（SDK 経由のプログラム、サンドボックスの中のタスク）は、始まりも「人を待っている」も Turnlane に出なかった。
- それらの作業の中身を Turnlane が読みに行く口は無い。分かるのは、作業をしている側が自分で言う「始めた・待っている・終わった」だけ。
- 書く側の環境は制約が強いことがある。サンドボックスでは localhost への接続が止まることがあり、デーモンが止まっていることもある。ファイルを 1 行足すことは、承認さえあればできる。
- 判定（5 状態・自分の番・待ちの区間・答える・通知・放置）は、セッション・ターン・hooks の事実から作っている。別の表と別の判定を作ると、概念が増え、自分の番の見え方が揃わない。

## Decision

1. **報告は取り込み元の 1 つ**: 報告は spool の `report-YYYYMMDD.jsonl` に 1 行ずつ追記し、collectors の新しいアダプタ `report`（`packages/collectors/src/adapters/report/`）が Claude Code・Codex の記録と同じ形（セッション・ターン・許可待ちの hook）に直す。その先の判定と画面は今あるものがそのまま動く。新しい表・画面・概念は作らない。取り込み元の行（`ai_source`）は `report` の 1 行（spool のディレクトリ）で、設定 › AI の取り込みのオン/オフはすべての出どころにまとめて効く。
2. **口は 3 つ、型は 1 つ**: CLI `turnlane ai report`、MCP `report_ai_work`、HTTP `POST /api/ai/reports` が同じ型（`source`・`id`・`state` と、任意の `title`・`project`・`wait`・`error`・`url`・`at`・`client_id`。検証は collectors の `parseReport`）を受け、同じ 1 行を spool に書く。デーモンは受けた報告も spool に追記してからすぐ取り込む（道は 1 本）。CLI が第一の口で、デーモンに届かなければ spool に直接書いて exit 0（`turnlane add` と同じ）、spool にも書けなければ exit 1。MCP は HTTP を通るだけ（デーモンが止まっていればエラー）。
3. **出どころは利用者が決める識別子**: `source` は `^[a-z0-9_]{2,32}$`（`ai_session.tool` と同じ書式）。Turnlane が自分で読む取り込み元の名前（`claude_code`・`codex`・`claude_desktop`・`hook_spool`・`report`）は使えない。セッションは `tool = source`、`external_id = id`、`entrypoint = "report"`。UI は知らない出どころを汎用のバッジ（識別子の先頭 2 文字）で出し、リポジトリ・ブランチの欄の代わりに `出どころ · プロジェクト` を出す。`project` は名前で、無ければ作る（`turnlane add` の `#project` と同じ）。AI 項目の `project_id` になる。
4. **状態の写し方**: `started` は新しいターン（`initiator: system`）、`running` は開いたターンの最後の活動を進める、`waiting` の `question` はターンを開いたまま `pending_question`（Claude Code の AskUserQuestion と同じ needs_input。返答タスクは猶予を置かずにすぐ）、`permission` は許可待ちの hook（`PermissionRequest` と同じ needs_input と許可のタスク）、`done` は `end_turn`、`error` は `error` で閉じる（エラーと再開のタスク）。待ちの後に `running`・`done` などが来たら、待ちは「先に進んだ」として外れる（返答タスクは `auto:answered`、許可のタスクは `auto:next_turn_ok`）。報告の作業は長いので、最後の報告から 1 日は実行中のままにする（アダプタの `runningStaleMs`）。
5. **待ちの中身は ADR 0018 の範囲で**: 待ちの文（300 文字）・選択肢（10 個 × 60 文字、JSON で 2000 文字）・許可の説明（60 文字）・件名（120 文字）に切り、伏せ字を通してから持つ。設定 `turn.store_detail` がオフなら持たない（行の札だけ出る）。取り込みのときにターンの `wait_json` に持ち、自分の番ができたら `wait_detail` に写す。「保存した中身を消す」で両方消える。ログ・SSE・通知には文を出さない（ログは出どころの名前と状態だけ）。
6. **答えは v1 では読めるだけ**: 「答える」の節は問いと選択肢を読めるだけにし、「答えは <出どころ> で（開く）」と出す（届け先の理由 `report`）。端末に文字を送る口は無い。「開く」は報告の `url`（http(s) かアプリの URL スキーム。`file:`・`javascript:`・`data:` などは受けない）を `open` に渡す（開く先 `report_url`）。答えを報告した側へ戻す中継は作らない。
7. **冪等と上限**: `client_id`（UUIDv7。省けば CLI・MCP・デーモンが付ける）の同じ行は 1 回だけ反映する（アダプタが同じ spool の最近 500 件を覚える）。1 行は 4 KB 未満（`O_APPEND` の 1 回の書き込みで行が混ざらない）。出どころ 1 つにつき受けた時刻の 1 分で 60 件を超えた行は捨て、ログに `report.rate_limited`（出どころの名前だけ）。未来の `at` は受けた時刻に丸める。72 時間より古い待ちは自分の番にしない（既存の規則のまま）。
8. **外には何も送らない**: 報告を受けるだけで、Turnlane から報告した側や外のサービスへは何も呼ばない（ADR 0008）。

## Consequences

- 自前のスクリプトやエージェントの「人を待っている」が、Claude Code の許可待ちと同じ行・通知・放置の数え方で出る。新しい画面は無い。
- 中身は自己申告なので、正しさは報告する側に依る。Turnlane は形と長さだけを確かめる。
- 同じ作業の続きが別の日の spool に書かれたら、その報告で新しいターンを始め、前の開いたターンを閉じる（取り込みのシンク。読み直しても同じ結果）。1 つの作業が日をまたぐと、ターンは日ごとに分かれることがある。
- 出どころごとのオン/オフ・アイコン・色は無い（取り込み元の 1 行でまとめて止める）。出どころが増えたら足す。
- アプリの URL スキームが登録されていなければ `open` が失敗し、「開けませんでした」になる（登録を前もって確かめない）。
