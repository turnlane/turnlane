# AIセッション取り込み仕様（Claude Code / Claude Desktop / Codex）

- 作成: 2026-10-02 / 状態: Phase 0 の実装仕様（正）
- 調査時点のバージョン: Claude Code 2.1 系、Codex 0.147〜0.158 系（macOS）
- 方針: 各ツールのローカルファイルは読み取り専用で扱う。会話本文・認証情報は開かず、スキーマ（キー名・型）だけを根拠にする
- 関連: [phase0-plan.md](./phase0-plan.md)（DDL・アダプタ IF の正）、[ADR 0004](../adr/0004-ingestion-file-watch-primary-hooks-opt-in.md)、[ADR 0005](../adr/0005-no-ai-session-body-storage-or-transmission.md)

> 本書の 4.1 のデータモデルは概念図である。テーブル定義の正は [phase0-plan.md](./phase0-plan.md) の 2.3 DDL とする。

---

## 0. 結論（先に読む）

1. 取り込みは「ファイル監視が正、hooks は速報」の併用にする。
   - 正（source of truth）: 各ツールのローカル保存ファイルを FSEvents で監視し、差分パースする。過去分のバックフィルもこれで行う。
   - 速報: Claude Code / Codex の公式 hooks（SessionStart / UserPromptSubmit / Stop / Notification / PermissionRequest / StopFailure / SessionEnd）から、メタデータだけを Turnlane の spool に書く。「今まさにユーザー入力待ち」の検知はこれでしか正確に取れない。
   - hooks が無くても全機能が「数十秒遅れ・精度やや低」で動くことを必須要件にする。hooks はオプトインで後付けする。
2. 1セッション = 1カード にはしない。1つの Claude Code セッションが数週間・数十ブランチ・数十 PR にまたがることがある。カードの単位は「作業単位 (WorkItem) = リポジトリ × ブランチ（PR があれば PR）」とし、セッションとターンはその証拠（evidence）としてぶら下げる。日付レーンには「その日に活動があった WorkItem」を出す。
3. 状態は5種類にする: `running` / `needs_input`（許可・質問でブロック中） / `your_turn`（AI のターンが終わり、レビュー・返答待ち） / `done` / `error`。判定にはファイルとプロセス状態と hooks を組み合わせる。Claude Code の `sessions/<pid>.json`（`status: busy|idle`）は非公式だが強いシグナルになる。
4. タイトルは既存の要約を優先して使う。Claude Code は `ai-title` レコード、Desktop/Cowork は `local_*.json` の `title`、Codex は `session_index.jsonl` の `thread_name`。LLM による再要約はオプトインとし、既定はローカル LLM にする。
5. 最大のリスク:
   - Claude Code はトランスクリプトを既定30日で自動削除する（`cleanupPeriodDays`）。履歴（`history.jsonl`）に残っているセッションの多くは、トランスクリプトがすでに消えている可能性がある。取り込んだメタデータは自前 DB にスナップショットする必要がある。
   - 内部ファイル形式は無告知で変わる。Codex は SQLite のスキーマ番号（`state_5`, `logs_2`）がすでに上がっている（Phase0 は Codex の SQLite を読まず、rollout JSONL だけを追う。1.4）。パーサはバージョンで分岐させ、失敗したら縮退動作にする。
   - 設定ディレクトリが複数ありうる（`CLAUDE_CONFIG_DIR`）。hooks は設定ディレクトリごとに入るため、ある設定ディレクトリにだけ hooks が入っていて、CLI が実際に使う別の設定ディレクトリでは発火しない、という状態が起こりうる。

---

## 1. ソース別の仕様

### 1.1 Claude Code CLI

設定ディレクトリは `$CLAUDE_CONFIG_DIR`、未設定なら `~/.claude` になる。CLI と Claude Desktop の Code タブが別の設定ディレクトリを使っていることがある（Desktop 起動のセッションはトランスクリプトの `entrypoint` が `claude-desktop` になる）。

| パス | 形式 | 用途 | 公式性 |
|---|---|---|---|
| `projects/<enc-cwd>/<sessionId>.jsonl` | JSONL（1行1レコード） | 本体トランスクリプト | 場所はドキュメントに記載あり、形式は非公式 |
| `projects/<enc-cwd>/<sessionId>/subagents/agent-<id>.jsonl` + `.meta.json` | JSONL / JSON | サブエージェントのトランスクリプト。meta は `agentType, description, toolUseId, spawnDepth` | 非公式 |
| `projects/<enc-cwd>/<sessionId>/tool-results/*.txt` | text | 大きなツール出力の退避先 | 非公式。読まない |
| `projects/<enc-cwd>/memory/*.md` | md | 自動メモリ | 対象外 |
| `sessions/<pid>.json` | JSON | 稼働中プロセスのライブ状態 | 非公式。ただし非常に有用 |
| `sessions/<pid>.<hash>.key` | — | ピア通信トークン | **秘密情報なので開かない** |
| `history.jsonl` | JSONL | 入力プロンプト履歴 `{display, pastedContents, project, sessionId, timestamp}` | 非公式。本文を含むので `project, sessionId, timestamp` 以外は読まない |
| `stats-cache.json` | JSON | `dailyActivity[{date,messageCount,sessionCount,toolCallCount}]`, `dailyModelTokens`, `modelUsage` など | 非公式。更新が止まることがあるので当てにしない |
| `.claude.json` の `projects[<path>]` | JSON | `lastSessionId, lastCost, lastDuration, lastLinesAdded/Removed, lastTotal*Tokens` | 非公式。最後の1セッション分しか持たない。読まない |
| `.claude.json` の `cachedUsageUtilization` | JSON | `fetchedAtMs`、`utilization.five_hour` / `seven_day` の `utilization`（0〜100）と `resets_at`（ISO 8601。null もある）、`limits[]` など | 非公式。Claude Code が取得した利用枠のキャッシュ。Turnlane は `fetchedAtMs` と 2 つの枠の使用率と明ける時刻だけを読む（下の「利用枠のキャッシュ」） |
| `file-history/`, `paste-cache/`, `shell-snapshots/`, `session-env/` | — | 内部用 | 読まない |

`<enc-cwd>` は絶対パスの `/` と `.` を `-` に置き換えた文字列（例 `-Users-foo-src-app`）。先頭が `-` になるので、外部 CLI に引数として渡すとオプションと誤認されることがある。逆変換は一意でないため、cwd は必ずレコード内の `cwd` フィールドから取る。

**`sessions/<pid>.json` のキー**
`pid, sessionId, cwd, startedAt(ms), procStart, version, kind("interactive"), entrypoint("cli"), name, nameSource("derived"), status("busy"|"idle"), updatedAt, statusUpdatedAt, messagingSocketPath, peerFeatures[], bridgeSessionId?`
- プロセス終了時に削除される模様。異常終了時は残る可能性があるので、pid の生存確認を必ず行う。
- `status` は「実行中」判定の一次シグナルとして使える。

**利用枠のキャッシュ（`<設定ディレクトリ>/.claude.json`）**
- live probe（5 秒ごと）が `.claude.json` を stat し、mtime が前回と変わったときだけ JSON として読む。許可リスト（アダプタの `allowlist[".claude.json"]`）は `cachedUsageUtilization.fetchedAtMs` と `cachedUsageUtilization.utilization.{five_hour,seven_day}.{utilization,resets_at}` だけで、ほかのキー（`oauthAccount`・`userID`・`projects`・`accountUuid`・`limits` など）は読まない・ログに出さない・保存しない（ADR 0005）。32MB を超えるファイルは読まない。
- 出すイベントは `claude_limits`（`{ account: ルートのパス, fetchedAt, fiveHour?: { pct, resetsAt }, sevenDay?: { pct, resetsAt } }`）。デーモンは利用枠の記録先（`claude_limit`。m2-api 28.1）に、持っている値（statusLine の受け口から受けた時刻・前のキャッシュの取得時刻）より `fetchedAt` が新しいときだけ記録し、判定をやり直す。`account` は hook の `config_root` と同じ書き方（`CLAUDE_CONFIG_DIR`、無ければ `~/.claude`。末尾の `/` を落とす）。
- 読むのは `<ルート>/.claude.json`。それが無く、ルートが既定の `~/.claude`（名前が `.claude`）のときだけ、Claude Code の既定の置き場所 `~/.claude.json`（ルートの親 = ホームの直下。`CLAUDE_CONFIG_DIR` を指定しない Claude Code が書く）を読む。読むキー・mtime の扱いは同じ。`CLAUDE_CONFIG_DIR` 付きのルートでは親を見ない。

**トランスクリプト JSONL のレコード型**

| `type` | 主なフィールド | 使い道 |
|---|---|---|
| `user` | `uuid, parentUuid, sessionId, timestamp, cwd, gitBranch, version, entrypoint, isSidechain, isMeta, promptId, origin.kind("human"|"task-notification"), promptSource("typed"|"queued"|"suggestion_accepted"|"system"), permissionMode, message.content` | 人間の入力（`origin.kind=="human"`）とツール結果（content が `tool_result`）を区別する |
| `assistant` | 上記共通 + `requestId, effort, message{model, stop_reason, usage{input_tokens, output_tokens, cache_*}, content[text|thinking|tool_use]}` | モデル、トークン数、ツール呼び出し名、ターン終了（`stop_reason=="end_turn"`） |
| `system` | `subtype`: `turn_duration{durationMs, messageCount}` / `away_summary` / `compact_boundary` / `local_command` / `informational` | **`turn_duration` が AI 作業時間の一次ソース**になる。`away_summary` は短い要約文（本文扱いなので保存しない） |
| `attachment` | `attachment.type`: `hook_success`, `edited_text_file`, `date_change`, `task_status`, `queued_command` など | 編集ファイル数の計測に `edited_text_file` を使う |
| `ai-title` | `aiTitle, sessionId` | session のカードのタイトル候補。セッション中に何度も再出力されるが、値はセッション中に変わらない（S3: 12セッション中11が1種類、1が無し）。ブランチをまたぐセッションでは全カードが同じ値になるので、branch のカードでは PR タイトルとブランチ名を優先する（4.4） |
| `summary` | `summary, leafUuid` | Claude Code が書く会話の要約。`storeTitles` が有効なときだけ、`summary` の文字列（最新の行）を題名の候補にし、`ai-title` より優先する（4.4）。`summary` は本文系のキーなので許可リストには入れず、パーサがその場で題名の掃除（`cleanTitle`）を通した結果だけを持つ。`leafUuid` は読まない |
| `last-prompt` | `lastPrompt, leafUuid` | 本文なので使わない |
| `pr-link` | `prNumber, prRepository, prUrl, timestamp` | **AI が作った PR の紐付け**。フォローアップ生成に直結する。同じ PR がセッション中に何度も再出力される（S3: 45 PR に978レコード、1 PR あたり最大138回）ので、セッション内の初出だけを PR 作成として扱う |
| `permission-mode`, `mode` | `permissionMode` / `mode` | 自律度の表示 |
| `bridge-session` | `bridgeSessionId, owner*Uuid` | リモート連携。アカウント ID なので保存しない |
| `file-history-snapshot/delta` | 内部 | 読まない |
| `queue-operation` | — | キュー投入 |

パース上の注意:
- `ai-title` を持たないセッション、`pr-link` を持たないセッションがある。どちらも任意として扱う。
- 終了済みセッションの最後の非サイドチェーン会話レコードは、ほぼ `assistant / end_turn / text` になる。つまり「最後の発話者」だけでは「完了」と「ユーザー返答待ち」を区別できない。AI のターンが終わったことしか分からない（4章で対処する）。
- 1レコードごとに `gitBranch` と `cwd` が入るので、セッション途中のブランチ切り替えを追跡できる。1つのターンの中でブランチが変わることもある（S3: Claude のターンの13%）。ターンのブランチと cwd はターン終了時点の値にする。
- `origin.kind=="task-notification"` の user レコードは、バックグラウンドのサブエージェント完了などで AI が再開したターンの起点になる（S3: 107ターン中12）。`turn_duration` を持つので AI 時間には数えるが、人間の入力としては扱わない。`origin` を持たない user レコードはほぼすべて `tool_result` で、ターンの起点は `origin.kind=="human"` だけで判定してよい。
- ツール呼び出しはツール名で数える（`Bash`, `Edit`, `Read`, `Write`, `mcp__*`, `AskUserQuestion`, `Agent` など）。`AskUserQuestion` は「質問中」判定に使える。
- 末尾行は書き込み途中のことがある。行単位で寛容にパースし、最後の不完全な行は次回に回す。

### 1.2 Claude Desktop — Code タブ

- メタデータ: `~/Library/Application Support/Claude/claude-code-sessions/<accountId>/<orgId>/local_<uuid>.json`
  - キー: `sessionId, cliSessionId, cwd, originCwd, createdAt, lastActivityAt, lastFocusedAt, model, effort, isArchived, title, titleSource, permissionMode, enabledMcpTools[], prNumber, prUrl, prRepository, prState, prs[], completedTurns, ...`
  - `cliSessionId` で Claude Code のトランスクリプト（Desktop が使う設定ディレクトリの `projects/...`）に結合できる。
  - **`title` / `prState` / `isArchived` / `completedTurns` / `lastActivityAt` が揃っていて、カード化にそのまま使える**。
- 同じディレクトリに `scheduled-tasks.json` がある。
- `claude-code/<ver>/claude.app` と `claude-code-vm/` は同梱バイナリなので対象外。
- `Cookies`, `*token*`, `ant-device-registry.json`, `bridge-state.json`, `config.json` 等は開かない。

### 1.3 Claude Desktop — Cowork（local-agent-mode）

Phase0 では対象外（v1 で扱う）。仕様だけ記録しておく。

- `~/Library/Application Support/Claude/local-agent-mode-sessions/<accountId>/<orgId>/`
  - `local_<uuid>.json`: `sessionId, cliSessionId, cwd, userSelectedFolders, createdAt, lastActivityAt, model, isArchived, title, sessionType, scheduledTaskId, initialMessage, systemPrompt, emailAddress, accountName, ...`
    - `initialMessage`（本文）、`systemPrompt`、`emailAddress` は読まない・保存しない。読むキーは allowlist で限定する。
    - `sessionType`: `scheduled` または null。定期実行が大半を占めることがあるので、日付レーンでは「定期タスク」として1行に集約しないと埋もれる。
  - `local_<uuid>/` ディレクトリ
    - `.claude/projects/<enc>/<cliSessionId>.jsonl`: Claude Code と同じトランスクリプト形式（セッションごとに独立した設定ディレクトリを持つ）。
    - `audit.jsonl`: Agent SDK の stream-json 形式。`type` は `system / assistant / user / result / rate_limit_event / command_lifecycle`。各行に `_audit_hmac` が付く（改ざん検知用なので触らない）。
      - `result` レコード: `subtype, is_error, num_turns, duration_ms, duration_api_ms, total_cost_usd, usage, modelUsage, stop_reason, terminal_reason, permission_denials`。**完了・エラー判定に最適**（`is_error=true`、`terminal_reason=api_error` など）。
    - `outputs/`, `uploads/`: 成果物。ファイル名と件数だけを「成果物あり」の判定に使ってよい。
  - `scheduled-tasks.json`: `scheduledTasks[{id, cronExpression, enabled, lastRunAt, lastScheduledFor, model, filePath, ...}]`
  - 総容量が数百MBになりうる。全走査は初回だけにし、以降は mtime の差分で処理する。

### 1.4 Codex（CLI / Desktop アプリ共通: `$CODEX_HOME`、既定 `~/.codex`）

| パス | 形式 | 内容 |
|---|---|---|
| `sessions/YYYY/MM/DD/rollout-<ISO>-<threadId>.jsonl` | JSONL | 本体（日付は開始日） |
| `archived_sessions/rollout-*.jsonl` | JSONL | アーカイブ済み |
| `session_index.jsonl` | JSONL | `{id, thread_name, updated_at}`。**タイトルの第一候補** |
| `history.jsonl` | JSONL | `{session_id, ts, text}`。本文なので `text` は読まない |
| `state_5.sqlite` | SQLite (WAL) | `threads`, `projects`, `project_roots`, `thread_spawn_edges`, `thread_sections` など。**Phase0 は開かない** |
| `thread_history_1.sqlite` | SQLite (WAL) | `thread_turns`（ターンの状態・時間）、`thread_items`（アイテム種別）。rollout JSONL の写し。**Phase0 は開かない** |
| `goals_1.sqlite` | SQLite (WAL) | `thread_goals{objective, status: active|paused|blocked|usage_limited|budget_limited|complete, tokens_used, time_used_seconds}`。**Phase0 は開かない**（ゴールは表示しない） |
| `queue_1.sqlite` | SQLite (WAL) | `queued_items`（フォローアップの予約入力）。`codex app-server` が常時開いている。**開かない** |
| `logs_2.sqlite` | SQLite | 内部ログ。対象外 |
| `.codex-global-state.json` | JSON | Desktop の UI 状態。`electron-thread-read-state-v1.unreadByIdentity`（未読スレッド）、`queued-follow-ups`、`local-projects` など |
| `hooks.json` / `config.toml` | JSON / TOML | hooks 定義、`notify`、`[features] hooks=true`、`[hooks.state]`（信頼済みハッシュ） |
| `auth.json` | — | **開かない** |

**rollout JSONL**（各行 `{timestamp, ordinal, type, payload}`）
- `session_meta`: `id/session_id, timestamp, cwd, originator("Codex Desktop"|"codex-tui"), source("vscode"|"cli"|{subagent:...}), thread_source, cli_version, model_provider, git{branch, commit_hash, repository_url}?`
  - `git` は CLI 起動のセッションにしか付かないことがある（Desktop 起動では欠ける）。ブランチは自分で `git -C <cwd> rev-parse` して補完する必要がある。
- `turn_context`: `turn_id, cwd, model, effort, approval_policy, sandbox_policy, permission_profile, timezone, current_date, workspace_roots, ...`
- `event_msg`:
  - `task_started{turn_id, started_at}`
  - `task_complete{turn_id, started_at, completed_at, duration_ms, last_agent_message}` が**ターン時間の一次ソース**。`last_agent_message` は本文なので保存しない。
  - `turn_aborted` でエラー・中断を判定する。
  - `token_count{info.total_token_usage, last_token_usage, rate_limits}`
  - `item_completed{item.type: AgentMessage|CommandExecution|FileChange|McpToolCall|Reasoning|UserMessage|ImageView|...}`
  - `thread_settings_applied`
- `response_item`: `message{role}`, `reasoning`, `custom_tool_call{name}`, `function_call{name}` とそれぞれの `_output`
- `token_usage_record`: `thread_id, turn_id, usage, turn_token_usage`
- `world_state`: 環境状態（skills, permissions など）

**Phase0 の Codex 取り込みは JSONL だけにする（PO 決定、S2）。** 読むのは rollout JSONL（ターン・状態・時間）、`session_index.jsonl`（タイトル `thread_name`）、`archived_sessions/`（アーカイブ = このディレクトリへの移動）の3つ。サブエージェントは rollout の `session_meta.source`、ブランチは `session_meta.git` か `git rev-parse` で補う。SQLite を開かない理由（[S2 レポート](../spikes/s2-codex-sqlite.md)）:
- `thread_history_1.thread_turns` は rollout JSONL の写しで、`rollout_byte_offset` 等の列で取り込み位置を管理している。計測時点で JSONL より遅れていた。
- `-wal` が無い普段の状態（Codex は書くときだけ開いて閉じ、閉じると `-wal` / `-shm` が消える）では、読み取り専用の接続は `-wal` を作れずに SQLITE_CANTOPEN になる。`mode=ro` で開けた場合も、Codex の `-shm` を作成・更新する。
- `state_5.threads` にしか無い列（`is_pinned` など）と `goals_1.thread_goals` は Phase0 の画面で使わない。`git_branch` は SQLite でもほぼ NULL で、どのみち `git rev-parse` で補う必要がある。
- スキーマは sqlx のマイグレーションで頻繁に変わる。`PRAGMA user_version` は常に 0 で、スキーマ判定には `_sqlx_migrations` を見る必要がある。

Codex のピン留めスレッド（`threads.is_pinned`）とゴール（`goals_1.sqlite`）は表示しない（PO 決定）。必要になったら、下の「将来 SQLite を読む場合の規則」に従って後から追加する。

**参考: `state_5.sqlite` の `threads`（主要列）**
`id, rollout_path, created_at(_ms), updated_at(_ms), recency_at_ms, source, thread_source, originator, cwd, title, name, preview, first_user_message, model, reasoning_effort, tokens_used, archived, archived_at, git_sha, git_branch, git_origin_url, project_id, agent_nickname, agent_role, is_pinned, thread_section_id`
- `name` は生成タイトル（短い）。`title` / `first_user_message` / `preview` は本文由来なので読まない。
- `thread_spawn_edges(parent_thread_id, child_thread_id, status)` はサブエージェントの親子関係。`source` が `{"subagent":{"other":"guardian"}}` のスレッドは自動レビュー用なので、カードから除外する。
- **`thread_turns(thread_id, turn_id, status, error_json, started_at, completed_at, duration_ms, rollout_byte_offset, rollout_end_byte_offset, first_user_item_id, final_agent_item_id)`**: status は `completed` / `interrupted` など。rollout JSONL のターンの写し。

**将来 SQLite を読む場合の規則**（Phase0 では実装しない。S2 の検証結果）:
- 元ファイルを `readonly` / `file:...?mode=ro` で開かない。`-wal` が無いと開けず、開けた場合は Codex の `-shm` に書き込む。
- 本体と `-wal` を Turnlane の一時ディレクトリへコピーし（`-shm` はコピーしない）、コピーの前後で本体と `-wal` の有無・サイズ・mtime・inode が変わっていなければ採用、変わっていれば再試行する。読むのはコピーだけ（1.5MB で 10ms 程度）。
- 変更の検出は本体と `-wal` の mtime とサイズで行い、変わったときだけコピーする。
- 元ファイルに `immutable=1` を確認なしで使わない。書き込み中に壊れた内容を読むことがある（S2 の模擬で 1.3%）。WAL に未反映の内容も見えない。
- スキーマ判定は `PRAGMA user_version`（常に 0）ではなく `_sqlx_migrations` を見る。

---

## 2. 公式手段で取れる情報

### 2.1 Claude Code hooks（公式・安定）
- 設定場所: `<CONFIG_DIR>/settings.json`（ユーザー）、`.claude/settings(.local).json`（プロジェクト）、プラグインの `hooks/hooks.json`、managed settings。
- 共通入力（stdin JSON）: `session_id, transcript_path, cwd, hook_event_name, permission_mode`、サブエージェントでは `agent_id/agent_type`、v2.1.196 以降は `prompt_id`。
- 本用途で使うイベント:

| イベント | 取れる情報 | 状態遷移 |
|---|---|---|
| `SessionStart` | `source: startup|resume|clear|compact|fork`, `model`, `session_title` | セッション登録 |
| `UserPromptSubmit` | `prompt`（**本文は捨てる**） | → running |
| `PermissionRequest` | `tool_name, tool_input` | → needs_input（許可待ち） |
| `Notification` | `notification_type: permission_prompt|idle_prompt|agent_needs_input|quota_auto_resume_fired|quota_auto_resume_stale|quota_auto_resume_disabled|...`, `message` | → needs_input / your_turn。`quota_auto_resume_*` は利用枠の信号（下の「利用枠の停止」） |
| `Stop` | `last_assistant_message`（本文は捨てる） | → your_turn |
| `StopFailure` | `error: rate_limit|overloaded|authentication_failed|oauth_org_not_allowed|account_on_hold|billing_error|invalid_request|model_not_found|server_error|max_output_tokens|cloud_credential_error|unknown`（`error_details`・`last_assistant_message` は本文になりうるので捨てる） | → error（`rate_limit` は上限待ち。phase0-plan 3.3） |
| `SubagentStart/Stop` | サブエージェント | 補助 |
| `SessionEnd` | `reason: clear|resume|logout|prompt_input_exit|other` | プロセス終了 |
| `CwdChanged`, `WorktreeCreate/Remove` | cwd・worktree の変化 | WorkItem の再判定 |

- サブエージェントの中で出た hook は、`session_id` が親のセッションのまま `agent_id`（`subagents/agent-<id>.jsonl` の <id>）と `agent_type` を持つ（公式ドキュメント）。Turnlane は hook を親のセッションに結び付け、`agent_id` でサブエージェントの許可待ちと区別する。`permission_mode`（`default`・`plan`・`acceptEdits`・`auto`・`dontAsk`・`bypassPermissions`）はイベントによっては無い。Claude Code は `bypassPermissions` でも（少なくともサブエージェントの呼び出しで）`PermissionRequest` と `Notification(permission_prompt)` を出してすぐ自動で許可するので、`bypassPermissions` の許可の hook は待ちにしない（needs_input・承認のタスク・通知・帯・レーンのどれにも出さない。モードを持たない Notification は同じセッションの前の hook のモードを引き継ぐ）。ほかのモードの許可待ちは、hook より後に親かサブエージェントのトランスクリプトに活動があれば閉じる。許可待ちの即時の通知は hook から 10 秒待ち、その間に閉じれば出さない。
- ハンドラ型には `command` のほか `http`（ローカルの HTTP エンドポイントへ POST）がある。`async: true` を付ければ Claude の処理をブロックしない。
- ハンドラに `id` や `name` のような識別用のフィールドは無い。同じハンドラが複数の設定ファイルにあると、内容の比較で1回だけ実行される。Turnlane は command 文字列（`--managed-by turnlane`）で自分のハンドラを識別する（S5。phase0-plan 3.6.1）。
- 設定ファイルの変更はファイル監視で即時に反映され、承認の手順は無い（`/hooks` は閲覧用）。設定ファイルは厳密な JSON（コメント・末尾カンマは Settings Error）。
- 注意:
  - 設定ディレクトリごとにインストールが必要（`~/.claude` と `CLAUDE_CONFIG_DIR` の両方。Cowork はセッションごとに独立した `.claude` を持ち VM 内で動くので、hooks の導入は現実的でない）。
  - ユーザーが `disableAllHooks` を設定していることがある。
  - hooks 入力のフィールド名は S5 で公式ドキュメントと照合した（`prompt_id` は v2.1.196 以降、`notification_type`。Stop の `last_assistant_message` は hook 側で捨てる。phase0-plan U5）。StopFailure のエラーの種類の項目名は、S5 では `error_type` と書いていたが、公式の名前は `error`（2026-10-23 に公式の StopFailure の節で確かめ直した。`error` は matcher にも使われる）。Turnlane は `error` を残し、古い spool の行のために `error_type` も読む（`error` を優先）。`error` は識別子の形（英小文字・数字・`_`）の値だけを残す。
- **利用枠の停止**（Claude Code。phase0-plan 3.3 の「上限待ち」）: 公式の Notification の `quota_auto_resume_*`（Claude Code v2.1.234 以降）を使う。
  - `quota_auto_resume_fired`: 利用枠で止まった作業を Claude Code が続けた（リセットの時刻か、それより前に枠が空いたとき）。最後の停止より後に来たら、そのターンは止まっていない（上限待ちを閉じ、再開のタスクも作らない。続きは UserPromptSubmit で実行中になる）。
  - `quota_auto_resume_disabled`: Claude Code が待つのをやめた（自動で続けない設定・リセットが 24 時間より先・続けてもまた枠に当たった など）。上限待ち（明ける時刻はリセットの時刻か、分からなければ停止から 5 時間。明けたら「再開できる」）。`message` が「リセットが 24 時間より先」の定型文（`Automatic continue stopped — the usage limit now resets more than 24 hours out; …`。週の上限など）なら、`turnlane hook` がその場で照らして spool に真偽値 `quota_horizon` だけを残し（`message` は残さない）、明ける時刻が分からないときの見込みを停止から 24 時間にする（`hook_event.quota_horizon`）。設定で切ったときの文（`Automatic continue was turned off — …`）は当たらない。
  - `quota_auto_resume_stale`: スリープ中（約 30 分より長く）にリセットした。Claude Code は続けずに ⏎ を待つので、すぐに「再開できる」にする。
  - 種類の無い StopFailure（項目名を取り違えていた間の記録、古い Claude Code）: 同じターンの窓に `quota_auto_resume_*` の通知があれば利用枠とみなす。同じセッションで先に上限待ちがあり、その明ける時刻より前の停止（種類が無いか `rate_limit`）は同じ上限待ちの続きとみなす（Claude Code の再試行で StopFailure が何百件続いても別のエラーにせず、明ける時刻と再開のタスクは最初の停止のもの）。種類が `rate_limit` 以外と分かるものは今までどおりエラー。
  - 再開のタスク（＝通知）は 1 回の停止につき 1 件（`<ターン>:limit`）。

### 2.2 Claude Code OpenTelemetry（公式）
- 有効化: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`, プロトコルは `grpc|http/json|http/protobuf`。
- メトリクス: `claude_code.session.count`, `token.usage`, `cost.usage`, `lines_of_code.count`, `commit.count`, `pull_request.count`, `active_time.total`, `code_edit_tool.decision`。
- イベント: `user_prompt`（本文は既定で伏せられる）, `api_request`, `api_error`, `tool_result`, `tool_decision`, `permission_mode_changed` など。`session.id` と `prompt.id` で相関できる。
- 評価: トークン・コスト・コミット・PR 数の集計には最も堅牢な手段。ただし環境変数の設定が必要で（Desktop アプリへは渡しにくい）、OTLP 受信サーバを内蔵する手間もかかる。タイトル・ブランチ・状態は取れない。**Phase2 のオプション**扱いとする。

### 2.3 Codex hooks / notify / OTel（公式）
- hooks: 0.147 では既定で有効（機能フラグ `hooks` は `stable`）。ユーザーが `[features] hooks = false`（旧名 `codex_hooks`）にしている場合がある。`~/.codex/hooks.json` またはプロジェクトの `.codex/hooks.json`。イベントは `SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, PreCompact, PostCompact, SubagentStart, SubagentStop, Stop, Interrupt`。共通入力は `session_id, transcript_path, cwd, hook_event_name, model, permission_mode`、ターン系イベントは `turn_id` も持つ。
  - **ハッシュによる信頼レビューがある**（`config.toml` の `[hooks.state."<hooks.json の実パス>:<event>:<グループ番号>:<ハンドラ番号>"] trusted_hash = "sha256:…"`）。鍵は位置、hash は内容（イベント名・matcher・ハンドラの設定）。インストールしたあと、ユーザーが `/hooks` で承認するまで動かない。**未承認の hook は黙って実行されない**（警告も出ない）。非対話で承認する公式手段は無い。導入手順の UI で案内が必要。位置が鍵なので、他ツールのグループより前に足すと他ツールの承認が外れる。Turnlane は末尾に足す（phase0-plan 3.6.1）。
  - **`async: true` のハンドラは未対応として読み飛ばされる**（0.147。警告のみ）。Turnlane は Codex に `async` を付けない。
  - hooks.json はトップレベルの未知キーがあるとファイル全体が読み込まれない（`deny_unknown_fields`）。グループ・ハンドラの未知キーは黙って無視される。
  - ドキュメント上は Desktop アプリでも発火する。
- `notify`: `agent-turn-complete` で外部プログラムに JSON（`thread-id, turn-id, cwd, input-messages, last-assistant-message`）を渡す。**`notify` は1コマンドしか設定できない**ため、他のツールがすでに使っている場合に上書きすると他機能を壊す。**notify は使わず hooks を使う**。
- OTel: `[otel] exporter = otlp-http|otlp-grpc`、`log_user_prompt=false`（既定）。イベントは `codex.conversation_starts, codex.api_request, codex.tool_result, codex.user_prompt` など。
- `[history] persistence = "none"` を設定しているユーザーではローカルファイルが残らないので、hooks だけが頼りになる。

### 2.4 hooks 設定の共有と先行パターン
- hooks 設定ファイル（Claude の `settings.json`、Codex の `hooks.json`）は、他のツールも同じファイルに自分のエントリを書き込むことがある。**Turnlane は自分のエントリだけを識別子付きで追加・削除する**実装が必須になる。
- 一般的な先行パターンとして「hook からローカル HTTP へ POST し、失敗したら spool JSONL に追記する」方式がある。高頻度の Pre/PostToolUse を spool から除外し、サイズと日数でローテーションするのが定石。Turnlane は HTTP を使わず spool 追記だけにする（3.3）。

---

## 3. 推奨取り込み方式

### 3.1 構成

```
[Source Adapters] --(NormalizedEvent)--> [Ingest Queue] --> [Session Store (SQLite)] --> [Task Deriver] --> [Day Lanes UI]
   ├ ClaudeCodeFileAdapter   (FSEvents: <cfg>/projects/**.jsonl, <cfg>/sessions/*.json)
   ├ ClaudeDesktopAdapter    (claude-code-sessions/**/local_*.json, local-agent-mode-sessions/**)
   ├ CodexAdapter            (sessions/**.jsonl・archived_sessions/ の tail + session_index.jsonl。SQLite は開かない)
   ├ HookSpoolAdapter        (~/Library/Application Support/turnlane/spool/*.jsonl  ← hooks が追記)
   └ GitHubAdapter (任意)     (gh / GitHub API で PR 状態を取得)
```

### 3.2 方式ごとの比較と結論

| 方式 | 長所 | 短所 | 位置づけ |
|---|---|---|---|
| ファイル監視 | 設定不要で過去分も読める。Desktop・Cowork も対象にできる | 非公式形式で壊れうる。入力待ちの瞬間が分からない。30日で消える | **正（必須）** |
| hooks | 公式で、状態遷移が即時に分かる（許可待ち・Stop・失敗） | 導入が必要。Codex は信頼承認が必要。設定ディレクトリごとに入れる必要があり、Cowork には入れられない。過去分は取れない | **速報（推奨・オプトイン）** |
| OTel | 公式で、トークン・コスト・PR 数が正確 | 環境変数の設定が必要。受信サーバが必要。状態とタイトルが取れない | 任意（Phase2） |
| SQLite 直読（Codex） | ターン状態・時間・タイトルが構造化済み | JSONL の写しで遅れがある。普段の状態では読み取り専用で開けず、開けると Codex の `-shm` に書く。スキーマ番号が上がると壊れる | **Phase0 は使わない**（S2）。Codex の主経路は rollout JSONL + `session_index.jsonl` |

### 3.3 hooks の実装指針
- hook コマンド（`turnlane hook`）は「stdin を読み、許可リストのキーだけを抜き出して spool に1行追記して終了する」だけにする。`async: true` を付け、タイムアウトは1〜2秒。どんな失敗でも exit 0 にする。
- 保存するキー: `hook_event_name, session_id, agent_id, agent_type, permission_mode, transcript_path, cwd, turn_id, prompt_id, notification_type, tool_name, error, error_type, source, reason, received_at`（`error` は StopFailure のエラーの種類で、識別子の形の値だけ。`error_type` は古い spool の行のため）。`error_details` も捨てる。`prompt`, `last_assistant_message`, `tool_input`, `message` は**hook 側で破棄**する。例外として、`quota_auto_resume_disabled` の `message` が「リセットが 24 時間より先」の定型文かどうかだけを hook の中で照らし、真偽値 `quota_horizon` を spool に残す（文は残さない。`hook-allowlist.ts` の `quotaHorizonOf`）。
- デーモンが起動していなくても spool に溜まり、起動時にまとめて取り込める（HTTP 型 hook だとデーモン停止中のイベントを失う）。
- インストーラは各 hooks ファイルに Turnlane のエントリであることが分かる識別を付け、冪等な追加・削除を行う。既存エントリには触らない。書き換え前にバックアップを取る。

### 3.4 壊れたときのフォールバック（段階的縮退）
1. 各パーサは「既知のバージョン範囲」と「必須キー」を宣言する。必須キーが欠けたレコードが一定割合を超えたらパーサを無効化し、UI に「Claude Code の形式が変わりました（取り込み縮退中）」と表示する。
2. 縮退レベル:
   - L0 フル: 全機能
   - L1: hooks spool のみで状態とセッションを把握
   - L2: ファイルの mtime だけで「このリポジトリで◯時台に AI が活動した」ことを把握（cwd はディレクトリ名から推定）
   - L3: 非表示
3. 未知の `type` やキーは無視して前進する（前方互換）。不完全な最終行は保留する。
4. Codex は rollout JSONL の形式変更を、必須キーの欠落率とフィクスチャ回帰で検知する（Phase0 は SQLite を読まないので、SQLite への切り替えは無い）。
5. テストに「各ツールの最新版で生成した匿名化フィクスチャ」を持ち、CI でパーサ回帰を検知する。ツールのバージョンは `version` フィールド・`cli_version` で記録しておく。

### 3.5 ファイル追従の規則（JSONL）

S4（[docs/spikes/s4-bun-foundation.md](../spikes/s4-bun-foundation.md)）の結果に基づく。カーソルの列は phase0-plan 2.3 の `ingest_cursor`（`stream_key`、`dev`、`inode`、`byte_offset`、`carry_state_json`）をそのまま使い、DDL は変えない。

- 監視は `fs.watch`（recursive、FSEvents）で行い、@parcel/watcher は使わない。60 秒ごとの再走査（mtime とサイズの比較）を常に併用する。
- **開いたままのファイルへの追記は監視に来ない**: macOS の `fs.watch`（Bun 1.4 で確かめた。recursive のディレクトリ・日付のディレクトリ・ファイルそのもののどれを見張っても同じ）は、ファイルを開いたまま書き足しても閉じるまで知らせない（作成と閉じたときだけ来る）。mtime は書き込みのたびに進む。Claude Code は追記のたびに開いて閉じるので監視で拾えるが、Codex（CLI・Desktop）は rollout を開いたまま追記するので、ターンの終わりが 60 秒ごとの再走査まで取り込まれなかった（Stop の hook より最大 1 分遅れる）。新しい日付のディレクトリの作成・新しい rollout の作成は監視に来る。
  - 対策として、Codex の `sessions/` の監視先に軽い走査を足す（`WatchSpec.pollEveryMs`。10 秒）。対象は再走査の列挙で `live` / `recent` のストリームと、監視で作成を見つけた rollout。mtime だけを比べ、変わったものをカーソルから読む（中身は走査では読まない）。古い rollout（`backfill`）は 60 秒の再走査に任せる。
- FSEvents はイベントを合体させる（数千回の書き込みで数イベント）。イベント1回が書き込み1回に対応すると仮定せず、**イベントを受けたらカーソルから末尾まで、完全な行だけを読む**。改行の無い末尾は改行が来るまでカーソルを進めない。
- ファイルの同一性は `(dev, inode)` で判定する。
  - **同一パスでの差し替え**: 同じ `stream_key` で `(dev, inode)` が変わったら新しいファイルとみなし、カーソルと carry を捨てて先頭から読む。サイズが `byte_offset` より小さくなった場合（切り詰め）も同じ。
  - **リネーム**: 別の `stream_key` に同じ `(dev, inode)` の既存カーソルがあればリネームとみなし、オフセットと carry を新しい `stream_key` に引き継ぐ。Claude Code / Codex のファイルはローテーションしないので優先度は低い。引き継げずに先頭から読み直しても、冪等な upsert（ADR 0004）なので結果は変わらない。
  - **元ファイルの消失**: DB の行は残し、`ai_session.transcript_missing_at` を記録する（phase0-plan 3.2）。
- **監視先が存在しない**（例: `<CLAUDE_CONFIG_DIR>/projects` がまだ無い）: `fs.watch` は `ENOENT` を同期的に投げるので、捕捉してデーモンを落とさない。存在する最も近い親ディレクトリを見張り、再走査のたびに張り直しを試みる。ソースの health には「監視先が未作成」と出す。
- 監視ルートがシンボリックリンクでもよい（リンク経由・実体経由のどちらの書き込みも拾える）。
- スリープ復帰後は watch を張り直す（phase0-plan M5-2）。

---

## 4. セッション → タスク変換ルール

### 4.1 データモデル（概念）

```
AgentSession   (source, session_id, parent_session_id?, config_root, entrypoint, model, cwd, repo_root, started_at, last_activity_at, title, title_source, is_archived, is_scheduled, tool_version)
AgentTurn      (session_id, turn_id, started_at, ended_at, duration_ms, status[running|completed|interrupted|error], git_branch, tokens_in/out, tools{name:count}, edited_files_count, ended_with[end_turn|question|permission|error])
AgentArtifact  (session_id, kind[pr|commit|file_output], ref(repo#num | sha | path), state[open|merged|closed], first_seen_at)
WorkItem       (id, repo_root, branch?, pr_ref?, title, status, first_activity_at, last_activity_at)  -- カード
WorkItemEvidence (work_item_id, session_id, turn_id)
FollowUp       (id, work_item_id, kind[review_pr|merge_pr|reply|approve|check_failure], status[open|done|dismissed], due_hint, auto_close_rule)
```

実テーブルは phase0-plan.md 2.3 の `ai_session` / `ai_turn` / `ai_artifact` / `work_item` / `follow_up` を正とする。

### 4.2 粒度（カード = WorkItem）
- キーの決め方（実装の正は phase0-plan 3.3）:
  1. `repo_root + git_branch`。ブランチはターン終了時点の値。ただし既定ブランチ（main/master/develop）は除く
  2. 既定ブランチ上の作業、または git 管理外なら `session_id` 単位。既定ブランチで終わったつなぎのターン（pull、マージ後の片付け、次の作業の相談）も、前後のブランチのカードへ寄せずに session のカードに入れる（S3 のオーナー確認で粒度の誤りなし）
  3. PR はキーではなく属性。PR は `gh` の `headRefName` に一致するブランチのカードに付け、そのカードが無ければ PR を起点に作る（Claude の `pr-link` は初出だけを使う。Desktop の `prs[]` も同じ扱い）。PR のカードのリポジトリは PR の属するリポジトリ（`owner/repo` をリモートに持つ手元のクローン。無ければリモートの無い同じ名前のリポジトリ、それも無ければ `owner/repo` を表示用に持つ）で、PR を出したセッションの cwd のリポジトリではない。前の版で cwd のリポジトリに付いたカードは次の判定でキーとリポジトリを付け替え、同じ repo×branch のカードがあれば統合する（fix-pr-card-repo）
- `cwd` が今は存在せず（ディレクトリ名の変更など）`repo_root` を解決できないターンは、同じセッションで直前に解決できたターンの `repo_root` を引き継ぐ。既定ブランチの session カードの `repo_root` は、カードのターンのうち最後に解決できたターンのもの（ディレクトリ名を変えたリポジトリで、変える前のターンと後のターンが同じセッションにあれば、後のターンのリポジトリになる）。一度も解決できないカードは git 管理外と同じく「(no repo)」（変える前のパスはもう読めず、同じリポジトリだと確かめる手段が無い。D-061）。
- 1つのセッションのターンを、ブランチの変化点で分割して WorkItem に割り当てる（1セッションが多数のブランチにまたがることがある）。
- 逆に、同じブランチで複数のセッション（CLI と Desktop、Claude と Codex）が動いた場合は1枚のカードに束ね、ソースのアイコンを複数表示する。
- サブエージェント（Claude の `subagents/`、Codex の rollout `session_meta.source` が subagent のもの）は親カードに内包する。独立カードにはしない。
- 親がサブエージェント（Agent ツール）に作業を渡すと、親の番は Stop で閉じ、サブエージェントが終わると task-notification の user レコードで親が自動で再開する。この間も親は働いている: Claude のサブエージェントのトランスクリプトが終わっていない（最後のレコードが最後の応答 `stop_reason=="end_turn"` でない）・最後の活動が runningStale（5 分）の中・その後に親が再開していなければ、親のセッションは `running`（理由 `subagent:running`）で、自分の番の候補（問いで終わっていても返答待ち）にしない。サブエージェントの許可待ち（`agent_id` 付きの hook。`agent_id` の無い古い spool は、親のターンが閉じた後の許可待ち）は親の `needs_input` で、サブエージェントのトランスクリプトの後の活動・終わり・親の再開・入力で閉じる（親の Stop では閉じない）。your_turn の待ちは、サブエージェントと、その完了で再開したターンが終わった時刻から始める。離れていた間のまとめでは、閉じた後もサブエージェントが動いていたターンを完了に数えない。Codex のサブエージェントの rollout はターンを持ち、カードのセッションとして状態に入るので、この扱いは Claude のサブエージェント（ターンを持たないセッション）だけ。
- Cowork の定期実行（`sessionType=scheduled`）は `scheduledTaskId` ごとに1日1行へ集約する（例「定期: ◯◯ ×3回 / 1件エラー」）。
- 壁打ち（D-135。2026-10-09）: プロジェクトに属さない会話。作業フォルダが `~/Documents/Codex/` の下（Codex のアプリのプロジェクト外の会話。CLI でここで始めたものも）か、設定 `ai.scratch_dirs` で印を付けたフォルダの下（Claude の Code タブを専用のフォルダで使う運用など）のセッションは、git の中でもリポジトリとして扱わず（`repo_root` は null）、git 管理外と同じ session カードにして `work_item.scratch = 1` を付ける。UI はリポジトリの代わりに「壁打ち」（英語 Scratch）と出し、プロジェクトの一覧には出さない。自分の番・放置の判定は他のカードと同じ（質問で終わったときだけ自分の番）
- ノイズ除外: 人間の入力が0のセッション（Codex の rollout に `UserMessage` が無いもの、guardian review）、`/clear` 直後の空セッション、総時間30秒未満でツール呼び出しも0のセッションは除外する。

### 4.3 状態判定（優先順位の高い順に評価）

| 状態 | 条件（どれか1つ） |
|---|---|
| `error` | 最終ターンが StopFailure hook / `api_error` / Codex `turn_aborted`（中断理由がエラーのもの） / Cowork `result.is_error=true`。止まってから 1 時間で閉じる。StopFailure の `error`（古い記録は `error_type`）が `rate_limit` のもの、種類が無くても `quota_auto_resume_*` の通知から利用枠と分かるものは error にせず上限待ち（利用枠のリセットまで。明けたら「再開できる」のタスク。2.1 の「利用枠の停止」、phase0-plan 3.3） |
| `needs_input`（ブロック中・最優先で通知） | 未解決の PermissionRequest hook / `Notification(permission_prompt|agent_needs_input)` / `AskUserQuestion` の tool_use に対応する tool_result がまだ無い（Codex のゴールは表示しないので判定に使わない。1.4） |
| `running` | Claude `sessions/<pid>.json.status=="busy"` かつ pid が生存 / 最後のレコードが user（human prompt か tool_result）で、5分以内に更新がある / Codex `task_started` に対応する `task_complete` が無く、10分以内に更新がある / UserPromptSubmit 以降に Stop が無い |
| `your_turn`（レビュー・返答待ち） | 最後のターンが `end_turn` / `task_complete` / Stop で終わっていて、その後に人間の入力が無く、次のどれかに当てはまる: (a) open な PR がある、(b) このターンでファイル編集やコミットがある（既定ブランチのカードでは、今も未コミットの変更があることを条件に加える）、(c) 最終 assistant メッセージが質問で終わる（後述。締めの決まり文句の質問は除く）、(d) トランスクリプトの終わりがまだ取り込まれていないが Stop の hook で終わった（理由 `hook:stop`。下の「hooks が補う終わり」。追いついたら (a)〜(c) で判定し直す）。Codex の未読（`.codex-global-state.json` の `unreadByIdentity`）は Phase0 では読まない（Codex の取り込みは JSONL のみ） |
| `done` | PR が merged/closed / セッションが archived（Desktop `isArchived`、Codex は `archived_sessions/` への移動）/ `your_turn` の条件を満たさずにターンが終了した（待たずに done）/ `your_turn` の期限切れ（git 管理外のカードの (b) は24時間、(c) は72時間。ユーザー設定可）/ タスクのない `your_turn` の期限切れ（YOUR TURN のタスクが1件も無い状態が72時間続いた。下記。D-048）/ ユーザーが手動で完了にした |

- **タスクのない your_turn は72時間で done（D-048）**: your_turn の条件を満たしていても、カードに YOUR TURN のタスク（返答・PR レビュー・許可待ち・再開。スヌーズ中を含む）が1件も無い状態が72時間続いたら done にする（理由 `no_task_expired`）。起点は待ちの始点（最後のターン終了。PR だけが理由なら PR の初出との遅い方）と、カードのフォローアップが最後に閉じた時刻の遅い方。編集ありだけの your_turn、自分のレビュー後も open のままの PR、初回の取り込みでタスクを作らなかった古い待ちが対象。新しいターンが始まれば判定し直す。needs_input と error には適用しない。詳細は phase0-plan 3.3。
- 「最後の発話者」だけでは done と your_turn を区別できない（1.1 のとおり、終了済みセッションはほぼ `assistant/end_turn` で終わる）。だから成果物（PR・編集）の有無と経過時間で振り分ける。
- 質問で終わっているかの判定（PO 決定 D-066 で広げた）: 本文を保存せずに、パース時にその場で最終 assistant メッセージの**最後の段落**（コードブロックとインラインコードを除く。最後の段落が箇条書き・表だけのとき、相手の判断待ちの条件文（「決まったら〜お見せします」「once you decide, I'll」）を含むとき、短い締め（1〜2 文・120 文字以内）で直前の段落が箇条書き・表だけのときは直前の段落も含め、その直前の段落が箇条書き・表だけならさらに前の段落（見出し）も含める。最大 600 文字）を文に分け、次のどれかに当たる文があるかを判定し、真偽値として保存する。本文自体は保持しない。
  - 文のどこかに `?` / `？` がある（URL やコードの `?a=b` のように直後に英数字・`=` が続くものは除く）
  - 答え・判断を求める言い回し。日本語:「回答を待っています」「返答を待っています」「教えてください」「決めてください」「選んでください」「どうしますか」「どうしましょう」「よいですか」「いいですか」「よろしいですか」「確認させてください」「〜かご確認ください」（判断を求めるもの。「ご確認ください」だけの依頼は除く）等。英語: let me know / which do you prefer / should I / shall I / do you want me to / waiting for your answer / please confirm / please choose 等
  - 疑問の終止形（「〜しますか」「〜でしょうか」「どちらが〜」等。`？` が無いもの）
  - 問いの見出し（「決めていただきたいこと」「ご判断いただきたい点」「確認したいこと」「質問」「Questions for you」「Decisions I need from you」）、判断待ちの条件文、「〜にするか」「〜してよいか」「〜かどうか」で終わる・whether で始まる箇条書きの項目。表示の抜き出し（questionExcerpt）も同じ対象から問いの文を選ぶ
  - 「〜してください」という作業の依頼（「確認してください」「実行してください」「ご確認いただければ」）は質問にしない
  - 未来の出来事を待つ条件節（「グラフが出たら」「結果が分かったら」「ビルドが終わったら」「結果次第」「once the graph is up」「when the results are available」）を含む文は、データを求める依頼・質問でも今答えるものではないので質問にしない（2026-10-28）。相手の動作・判断を待つ形（「貼ってもらえれば判断します」「決まったら〜します」）は今までどおり判断待ちの条件文
- 締めの決まり文句の質問（「他に何かありますか？」「必要であれば〜してください」「他に何かあれば」「Anything else?」「Let me know if you need anything」「if you need anything else」など）も同じくパース時にだけ判定し、`ai_turn.closing_question` に真偽値を残す。上の判定に当たった文がすべて締めの決まり文句なら締めとし、返答タスクを作らず、(c) にも数えない（PO 決定 D-021。判定表は `packages/collectors/src/closing-question.ts`、phase0-plan 3.3.1）。
- 判定を変えたら、アダプタの `parserVersion` を上げる。デーモンは起動時に版の違うカーソルを捨てて先頭から読み直し（`turnlane reingest` と同じ upsert。行は消さない）、残っているトランスクリプトのターンの真偽値を新しい判定で書き直す。元ファイルが消えたターンは書き直せないので古い判定のまま残る（D-066 で claude-code・codex を版 2 にした）。
- 判定漏れの手段として、AI カードで `y` を押すと、そのカードの返答タスクを手で作れる（D-066 (2)。phase0-plan 3.3、ux-mvp 6章）。
- 状態はカード（WorkItem）単位で集約する: 構成セッションのうち最も優先度の高い状態を採用する（error > needs_input > running > your_turn > done）。
- **hooks が補う終わり**: トランスクリプトに終わりの無いまま開いて残ったターン（`ai_turn.status='running'`・`ended_at` が無い。例: タスクの通知で始まったターンが同じ秒に StopFailure で止まり、AI の記録が無い。トランスクリプトの取り込みが Stop の hook より遅れている）は、ターンの hook の窓（始まりの 1 秒前から次のターンの始まりまで。最後の UserPromptSubmit・`quota_auto_resume_fired` の後）に Stop・StopFailure・`quota_auto_resume_disabled` / `stale`・`Notification(idle_prompt)`（公式: 応答を終えて約 60 秒、入力が無い）があり、その後にトランスクリプトの活動が無ければ、その hook の時刻（`idle_prompt` はその前の最後の活動）で終わったものとして扱う。流れ（詳細パネルの「この項目の流れ」）・AI の時間・レーンのブロック・日報・サブエージェントの区間で「今」まで伸ばさない（core の `derive.openTurnHookEnd`、デーモンの `derive/hook-end.ts`）。
  - `ai_turn` は書き換えない。トランスクリプトが正で、取り込みは元ファイルからの代入だけ（ADR 0004。再取り込みで同じ行になる）。hook は補助なので、読むときに求める（後でトランスクリプトに続きが書かれれば、何もしなくても正しい終わりに戻る）。
  - 状態: StopFailure・利用枠の通知は今までどおり止まった事実（error・上限待ち）として判定し、`idle_prompt` は状態に使わない。**Stop は状態にも効かせる**（core の `derive.openTurnStopEnd`・`turnHookStopOf`）: 最後の UserPromptSubmit の後に親の Stop があり、その後にトランスクリプトの活動が無い開いたターンは `running` にせず（`turn:open` の 5 分を待たない）、終わりの中身（問い・PR・ただの終わり）が分かるまでは `your_turn`（理由 `hook:stop`、推定）にする。Stop より後に見たプロセスの busy（`sessions/<pid>.json`）があれば `running` のまま。サブエージェントの Stop（`agent_id` 付き。Codex のサブエージェントは別のセッション）は親の終わりにしない。
  - 待ち: `hook:stop` は返答待ち（question）と同じ扱いで、答える口（セッションの待ち）と猶予中の行は Stop の時刻から開く。猶予（15 分）の後の返答タスク（`reply`）はそのターンに作る（artifact_ref はターン）。トランスクリプトが追いついて問いだったら同じ待ち・同じ返答タスクのまま理由が `question` に替わる（作り直さないので通知は 1 回）。PR があれば `pr_open`、ただの終わりなら `your_turn` の条件どおり（done になれば返答タスクは閉じる）。放置の区間はトランスクリプトの終わりから数える（今までどおり）。

### 4.4 タイトル生成
優先順位はカードの種類で変える。Claude の `ai-title` はセッション中に変わらないので、ブランチをまたぐセッションでは使い回しになる（S3: 21枚中10枚が他のカードとタイトル重複）。

**カードのセッションが他のカードにまたがっていなければ、ツール生成の要約（Claude `ai-title` / Codex `thread_name` 等。新しいセッションのもの）を最優先にする（PO 決定 D-066 (3)）。** 「またがる」は、カードを構成するセッションのどれかが、別のカードにもターンを持つこと（ブランチを切り替えたセッション）。この場合は要約が他のカードと重複するので、下の種類ごとの順に従う。要約が無ければ、またがらない場合も下の順。ユーザーが付けた名前はどちらの場合も最優先。自動生成タスクの題名は読み取り時にカードの現在のタイトルで組み立てるので（D-047 (3)）、そのまま反映される。

branch のカード:
1. ユーザーが手動で付けた名前（Turnlane 内、Claude `custom-title`）
2. PR タイトル（GitHub から取得。最も「人間向け」の表現になっている）
3. ブランチ名を整形したもの（`feat/add-login` → 「add login」）
4. ツール生成の要約: Claude `ai-title` / Desktop・Cowork `local_*.json.title` / Codex `session_index.thread_name`

session のカード（既定ブランチ・git 管理外）は次の順:
1. ユーザーが手動で付けた名前
2. PR タイトル
3. ツール生成の要約: Claude `ai-title`（最新値）/ Desktop・Cowork `local_*.json.title` / Codex `session_index.thread_name`
4. ブランチ名を整形したもの
5. `sessions/<pid>.json.name`（`derived`、例 `repo-xx`）
6. 「<repo名> での作業」

**ツール生成の題名の掃除**（`packages/collectors` の `cleanTitle`。取り込み時に保存する題名と、デーモンの `cardTitle` の両方で通す。保存済みの古い題名も次の導出で直る）:
- Claude Code は `summary` の行（最新のもの）を `ai-title` より優先する。どちらも下の掃除を通し、空同然なら使わない（空同然の `summary` は `ai-title` に落ちる）。claude-code の parserVersion 5 で既存の記録から読み直す。parserVersion 6 で、先頭からの読み直しのときに題名の行が空同然のものだけのセッションは保存済みの題名を消す（`session_seen` の `title: null`。通常の追記では消さない）。カードの題名（`title_auto`）は導出の各回に全カードを `cardTitle` で計算し直すので、読み直しの後の導出で直る。
- タグをはがす: `<pasted_content …>…</pasted_content>` は中身ごと、ほかの `<…>` の形（閉じの無い `<pasted_content id="…">` を含む）はタグだけを取り除く。
- 先頭の相づちと区切り（句読点・空白）をはがす（「OK。コミットしておいて」→「コミットしておいて」）。相づちの直後が区切りでなければはがさない（`OKR`・「続けて実装する」）。英語の相づちの後が空白だけなら、続きが日本語のときだけはがす（`OK button` は題名のまま）。
- 空同然は無い扱いにして、カードは次の候補（PR タイトル → ブランチ名 → リポジトリ名。session のカードは既定ブランチを飛ばす）に落とす: 空白を除いて 3 文字以下、相づちだけ（表 `TITLE_ACKS`: OK・yes・y・sure・thanks・lgtm・continue・はい・うん・了解・進めて・続けて・つづきやって・お願いします・同上・ありがとう など）、句読点と記号だけ。
- 改行・連続空白は 1 つの空白にし、80 文字で切る（末尾は `…`）。
- 保存した件名（ADR 0018 の自分の指示の 1 行目 `ai_instruction.text`、自動のタスクの作成時の件名 `task.title_params.title`）にも同じ判定を通す。指示は相づちだけ・貼り付けの塊だけの行を飛ばし（貼り付けた本文は件名にしない。相づちで始まる文ははがさない。`cleanSubjectLine`）、保存の時点（sink）と表示の時点（glance・離れていた間のまとめ・記録・AI 詳細の流れ）の両方で通す。空同然なら項目の今の題名（`titleResolver` の subject）に落とす。PR の題名のカードのツール生成の題名も同じ。保存済みの古い行は起動時に 1 度だけ直す（`cleanStoredSubjects`。空同然の指示の行は消し、タスクの件名は null に。会話本文は読まない。直すものが無ければ何も書かない）。

- LLM による再要約は既定オフにする。オンにする場合も、入力はタイトル候補・ブランチ・編集ファイル名・ツール統計といった**メタデータのみ**にし、会話本文は送らない。既定のエンジンはローカル LLM とし、外部 API は明示的にオプトインした場合だけ使う。生成した要約はキャッシュし、WorkItem の構成が変わったときだけ再生成する。
- 日報用の「今日 AI がやったこと」も、まずは各カードのタイトル一覧で十分。

### 4.5 作業時間
- **AI 稼働時間** = その日のターン時間の合計
  - Claude: `system/turn_duration.durationMs`。無いターンは「人間入力レコード → 同ターン最後の assistant レコード」の時刻差で代用する
  - Codex: `task_complete.duration_ms`（中断は `turn_aborted.duration_ms`）
  - Cowork: `result.duration_ms`
- **人の関与時間**（任意）: 人間の入力時刻を起点に、レコード間隔が15分以内の連続区間を合計する。
- **在席**: Mac を使っていた時間（最後のキーボード・マウスの入力から5分まで。デーモンが30秒ごとに入力からの経過だけを読む。中身は読まない）。勤務時間（D-018）は D-105 でなくした（詳細は phase0-plan 3.3.1、ADR 0013）。
- **待ち時間**: AI が your_turn / needs_input で待っていた区間を、事実の時刻（`ai_turn` の開始・終了、hooks の発生時刻、フォローアップの操作、PR の merged 時刻）から求め、次の4つに分ける。status_log の検知時刻は使わない。
  - 猶予: 放置に数えうる時間（在席・一日を閉じた後でない・予定と重ならない・タスクが出ていてスヌーズ中でない）に入ってから15分（設定可。D-019、D-058）。待ちの始まりからではない。放置に入れない
  - 放置（Idle）: 猶予を除いて、在席していて、一日を閉じた後でなく、かつカレンダーの busy な予定と重ならない時間。日別・リポジトリ別に合計する
  - 集計外: 一日を閉じた後（翌朝 Mac を使い始めるまで）、不在、busy な予定と重なる時間など
  - 期限切れ: 72時間で期限切れになった返答待ちは放置に入れず、件数（Expired）だけを数える（D-022）
  - 以前の定義（ターン終了 → 次の人間入力の全体）は夜間・離席を含み、S3 で7日合計168時間と意味のある値にならなかった（122区間の中央値4分・p90 91分）。この問題を上の区分で解消する。
- S3 では `turn_duration` が Claude のターンの98%（欠けた2件はどちらもユーザー中断）、Codex の `duration_ms` が100%にあった。代替計算はほとんど使われない。
- 並列サブエージェントの時間は親ターンに含まれるので二重計上しない。親のターンが閉じた後もサブエージェントが動いていた時間（サブエージェントの区間の和集合から親のターンの区間を除いたもの）は、親のカードの AI の時間に 1 回だけ足し、レーンでは親のブロックの続きとして描く（ターン数には数えない）。
- 表示は「AI 1h20m（3セッション）」のように、AI 時間と件数を出す。

### 4.6 日付への割り当て
- タイムスタンプは UTC で保存する（Claude は ISO8601 Z、Codex は秒または ms）。表示時にユーザーのタイムゾーンで日付に変換する。Codex は `turn_context.timezone` も持っている。
- 「その日に1ターン以上活動した WorkItem」をその日のレーンに表示する。日をまたぐセッションは両方の日に出し、各日の時間はその日のターンだけで計算する。
- 1つのターンが0時をまたぐ場合はターン開始日に帰属させる（ターン単位で分割はしない）。
- 日付の区切りはユーザー設定にする（既定 04:00）。深夜作業を前日扱いにしたいユーザーが多いため。
- 未完了のカード（running / needs_input / your_turn）は「今日」のレーンに持ち越して表示し、元の日付をバッジで出す。

---

## 5. AI タスクと人間タスクの接続（フォローアップ自動生成）

| トリガ | 生成する人間タスク | 自動クローズ条件 |
|---|---|---|
| AI が PR を作成（`pr-link` の初出 / Desktop `prs[]` / `gh pr list --author @me` かつ AI セッションの時間帯とブランチが一致） | 「PR #N をレビュー」 | PR に自分のレビュー・承認が付く、または merged/closed（個人開発では自分の PR を自分で承認できないので、実際には merged/closed で閉じる） |
| PR が approved かつ CI green | 「PR #N をマージ」 | merged/closed |
| `your_turn` で質問で終わっていて（締めの決まり文句を除く）、ターン終了から15分間人間の入力が無い | 「◯◯に返答」（WorkItem へのディープリンク付き） | 同じセッションに人間の入力が来る（返答済み）/ 同じ repo・ブランチでのコミット・別セッションの開始（トリガより後に始まったセッション）・PR の merged（解決済み（推定）。放置はその時点で止める。コミットと別セッションは問いのセッションのプロセスが生きている間は使わない）/ 72時間（期限切れ。放置に入れず件数のみ）。手動では `e`（対応不要。D-031）。phase0-plan 3.3.1 |
| `needs_input`（許可待ち。hooks の PermissionRequest / Notification、hooks なしでプロセスが idle のまま最終ターンが未完了） | 「◯◯の許可待ち」（approve。最優先、通知。待ちの開始ですぐ作る） | 次のツール実行か Stop が来る |
| `needs_input`（AskUserQuestion の未回答。hooks の有無によらない） | 「◯◯に返答」（reply。最優先、通知。待ちの開始ですぐ作る。D-049） | 質問に答えた（ターンが進んだ）/ 同じセッションに人間の入力 / 72時間（期限切れ） |
| `your_turn` でファイル編集があり PR が無い | 「◯◯の変更を確認・コミット」 | コミットされる / ブランチに PR ができる / 手動完了 |
| `error`（API エラー・中断） | 「◯◯を再開」 | 次のターンが成功する / 72時間（期限切れ。件数のみ。D-045） |
| Cowork 定期実行のエラー | 「定期タスク◯◯の失敗を確認」 | 次回の実行が成功する |
| ~~Codex goal `blocked`~~ | Phase0 では生成しない（ゴールは表示しない。1.4） | — |

- 原則: フォローアップは「自動生成・自動クローズ」とし、ユーザーが手で消したもの（dismissed）は同じトリガで再生成しない。重複を防ぐため、キーは `(work_item_id, kind, artifact_ref)` にする。
- 既定でオンにする種別と Phase0 の範囲は phase0-plan.md 3.3 を正とする。
- 待ちの開始（トリガ）が72時間より古いものからはタスクを作らない（初回の取り込みで過去の履歴をタスクにしない。D-045）。カードと待ち区間は履歴として残る。
- YOUR TURN（帯・キュー・件数・通知・儀式）に出すのは、ここで作ったタスク（返答・PR レビュー・許可待ち・再開）が open なカードだけ。タスクのない your_turn は出さず、72時間で done にする（4.3。D-048）。
- **needs_input は必ずタスクにする（D-049 (1)）**: AI が止まって自分を待っている瞬間はプロダクトの芯なので、許可待ちは approve、AskUserQuestion は reply を、hooks の有無によらず待ちの開始ですぐ作り、YOUR TURN と通知に出す（設定でその種類をオフにした場合と、72時間より古い待ちを除く）。
- 「放置」に数えるのは、ここで作ったタスク（返答・PR レビュー・許可待ち・再開）が YOUR TURN に出ている間だけ。タスクを作らない your_turn（編集ありだけなど）は放置に数えない。日別の放置は同時に待っている時間を1回だけ数える（和集合。D-045。phase0-plan 3.3.1）。
- タスクの題名は文字列で保存せず、種類とパラメータ（PR 番号、AI のタイトル、リポジトリ名など）を保存して表示時に翻訳する（D-046。phase0-plan 3.3）。上の表の「」内は意味の説明。
- 再開導線: Claude は `claude --resume <session_id>`（cwd で実行）、Desktop・Codex アプリはアプリのディープリンク（要調査）、PR は URL を使う。
- 人間タスクから AI を起動する逆方向の連携（タスクから `claude -p` を起動する等）は将来の拡張とする。

---

## 6. 環境の一般化とプライバシー

### 6.1 パス検出
- Claude Code: 候補は `$CLAUDE_CONFIG_DIR`、`~/.claude`、そして **`~/.claude*` のうち `projects/` を持つディレクトリをすべて**（別名の設定ディレクトリを使う人がいる）。シェルの rc ファイルを解析するより、ディレクトリ走査の方が確実。**検出したものは、名前に `work` を含むもの（別アカウント用など）も含めて既定ですべて取り込む**（PO 決定。S3 で `work` を含む設定ディレクトリを除外したところ、その作業がすべて抜け落ちた。データは端末の外に出ないので、既定で除外する理由が弱い）。検出した一覧をユーザーに見せ、プロファイル（設定ディレクトリ）単位で除外できるようにする（`ai_source.enabled`）。リポジトリ単位の除外は `exclude_globs_json` で行う。
- Claude Desktop: macOS は `~/Library/Application Support/Claude/`、Windows は `%APPDATA%\Claude\`、Linux は公式版が無い。
- Codex: `$CODEX_HOME`、なければ `~/.codex`。
- Windows: `~` は `%USERPROFILE%`。パスのエンコード規則（`C:\` の扱い）が異なるので、cwd は必ずレコードから取る。FSEvents の代わりに ReadDirectoryChangesW を使う。Linux は inotify（ウォッチ数の上限に注意）。macOS 以外は「軽く対応」とし、まずはポーリングでよい。
- macOS のサンドボックス: Mac App Store 版にすると `~/.claude` 等を読めないので、直接配布にするか、ユーザーにフォルダを選ばせて security-scoped bookmark で保持する。`~/Library/Application Support/Claude` は通常 TCC 保護の対象外だが、将来変わる可能性がある。

### 6.2 プライバシー設計
- **完全ローカル**にする。Turnlane のプロセス自身は外部へ接続しない（ADR 0008）。ネットワークに出るのは、利用者自身の `gh` CLI による GitHub の参照（PR 状態の取得のみ。`gh` が無ければ使わない）、LLM 要約を入れる場合の利用者自身の `claude` / `codex` CLI の呼び出し（オプトイン）、公開版の更新確認（GitHub Releases の静的ファイルの取得。設定でオフにできる。ADR 0008 の追記）だけ。
- 読むキーは**許可リスト方式**にする。各アダプタに「読んでよいキー」を宣言させ、それ以外（`message.content`、`prompt`、`initialMessage`、`systemPrompt`、`text`、`last_agent_message`、`emailAddress` など）はパース直後に破棄する。Turnlane の DB に会話本文は1文字も入れない。
- 例外として、タイトル（ツールが生成した要約）は表示に必要なので保存する。ただし「タイトルも保存しない（ブランチ名のみ）」モードを用意する。
- Codex のプロジェクト外の会話の作業フォルダ `~/Documents/Codex/<日付>/<名前>` の `<名前>` は、Codex が最初の依頼の文から作る（会話の中身の派生物）。取り込みの時点で `~/Documents/Codex/<日付>` まで切り落とす（日付の形でなければ `~/Documents/Codex`）。rollout の読み取り（継続状態にも残さない）・`turnlane hook` の spool・デーモンの enrich（どのツールのイベントでも）の3か所で落とし、タイトルを保存しないモードでも同じ。保存済みの行はマイグレーション 0012 で落とす（D-135）。Claude Code をこのフォルダで動かした場合、トランスクリプトの置き場所（`projects/<cwd を符号化した名前>`）にもフォルダ名が入る。ストリームのキー（`ingest_cursor.stream_key`）と `ai_session.file_path` は、符号化した名前の最初の `-Documents-Codex-` から後を日付 `-YYYY-MM-DD` だけ残して落としたもので持ち（`file_path` は常に「ルート + キー」）、実際のパスは DB に置かず、走査・監視のたびに列挙から得る（消えたファイルの判定も列挙を先に見る）。キーからはセッション ID（ファイル名）が残るので重ならない。Claude のパーサの継続状態の cwd と、`turnlane hook` の spool の `transcript_path` も同じく落とす。保存済みの行はマイグレーション 0013 で `file_path` を落とし、該当するカーソルを消して先頭から読み直す（D-136 の残り）
- 開かないファイルをハードコードする: `auth.json`、`*.key`、`Cookies*`、`*token*`、`oauth_creds.json`、`.audit-key`、`ant-device-registry.json`、`bridge-state.json`、`config.json`（Desktop）。
- DB は `~/Library/Application Support/turnlane/` に置き、パーミッション 600 にする。エクスポートやバックアップの対象をユーザーが選べるようにする。
- 作者が運用するサーバーは持たず、クラウド同期は作らない（ADR 0008）。将来、利用者自身のストレージ経由で複数端末に対応する場合も、AI 取り込み系のデータは端末の外に出さない。
- hooks で受け取る本文はプロセス内でも保持しない（hook コマンド内で破棄する）。
- 表示の瞬間にだけ読む（glance。D-207、ADR 0005 の追記 2026-10-16）: 自分の番の行と詳細に「なぜ待っているか」を出すため、`GET /api/work-items/:id/glance` が手元の記録から 1〜3 行だけ読む。パーサが継続状態に持つのは行の位置（バイト数）と「件名に使える指示か」の判定だけ（Claude Code の `textAt`・`pend`・`promptAt`。parserVersion 3）。読んだ中身は応答（no-store）にだけ入れ、DB・ログ・spool・SSE・MCP・記録・エクスポートには入れない。表示の前に伏せ字を通す。Codex は後から。件名に使う直近の指示は、待っていない項目（AI の詳細の見出し・AI の線）でも読む（D-210）。即時の通知の題名にも使い、デスクトップアプリが通知を出す直前に読んで macOS の通知にだけ渡す（SSE の `notify` には印 `promptTitle` だけ。D-211。ADR 0005 の追記 2026-10-16 の 2）。

- 限定した保存（ADR 0018、D-218。2026-10-17）: 設定「待ちの中身を保存する」（`turn.store_detail`、既定オン）がオンなら、伏せ字の後の (a) 自分の指示の 1 行目（ターンごと、120 文字。`ai_instruction`）(b) AI の問いと選択肢 (c) 許可待ちのツール名と説明・コマンドの 1 行目 (d) エラーの種類（(b)〜(d) は `wait_detail`。自分の番を作ったときに 1 度読む）だけを持つ。(a) は Claude Code のパーサが `TurnEvent.instruction` で返し（継続状態には入れない。`ReadContext.privacy.storeDetails` のときだけ）、シンクが伏せ字を通して書く。parserVersion 4 で既存の記録から埋めるため起動時に読み直す（更新の直後の 1 回は初回の取り込みと同じく時間がかかる）。AI の発言の本文・差分・ファイルの中身・記録の写しは持たない。外には送らない（AI 要約に渡す日報からも外す）。glance は DB を先に読み、件名はその日の最初の指示で固定する。Codex は後から

### 6.3 データ保持
- Claude Code は `cleanupPeriodDays`（既定30日）でトランスクリプトを削除するので、Turnlane は**取り込み時点で必要なメタデータを確定保存**する。ユーザーに `cleanupPeriodDays` の延長を案内する選択肢を出してもよいが、勝手に設定を変更してはいけない。
- Codex には `[history].max_bytes`・`persistence="none"` がある。persistence=none のユーザーは hooks のみで対応する。

---

## 7. ソースアダプタの抽象化（拡張候補）

実装上の IF は phase0-plan.md 3.1 を正とする。以下は拡張を見据えた概念形。

```ts
interface SourceAdapter {
  id: 'claude-code' | 'claude-desktop' | 'claude-cowork' | 'codex' | 'cursor' | 'gemini-cli' | 'github-copilot-agent' | 'devin' | string;
  detect(): Promise<DetectedRoot[]>;              // 設定ディレクトリ・DBの検出（存在チェックのみ）
  capabilities: { liveStatus: boolean; turns: boolean; tokens: boolean; gitBranch: boolean; prLinks: boolean; hooks: boolean };
  watchPaths(root): WatchSpec[];                  // FSEvents / poll 間隔
  readIncremental(root, cursor): AsyncIterable<NormalizedEvent>; // byte offset / ordinal / updated_at をカーソルに
  allowlistedKeys: Record<string, string[]>;      // 読んでよいキーの宣言（監査用）
  installHooks?(root): Promise<HookInstallResult>;  // 任意。冪等・可逆
  supportedVersions: SemverRange;
}

type NormalizedEvent =
  | { kind: 'session_seen'; source; sessionId; cwd; startedAt; model?; title?; titleSource?; entrypoint?; archived?; scheduled? }
  | { kind: 'turn_started' | 'turn_ended'; sessionId; turnId; at; durationMs?; status?; endedWith?; gitBranch?; tokens?; tools? }
  | { kind: 'needs_input'; sessionId; at; reason: 'permission' | 'question' | 'elicitation' }
  | { kind: 'artifact'; sessionId; at; artifact: { kind: 'pr' | 'commit' | 'file_output'; ref: string } }
  | { kind: 'live_status'; sessionId; status: 'busy' | 'idle'; pid?: number; at }
  | { kind: 'error'; sessionId; at; errorType };
```

候補ごとのメモ（実装前に要検証）:
- **Cursor**: `~/.cursor/`（`projects/`, `ai-tracking/ai-code-tracking.db`）と `~/Library/Application Support/Cursor/User/{globalStorage,workspaceStorage}`。エージェントの会話は VS Code 系の `state.vscdb`（SQLite の KV）に入っている模様で、形式は不安定。Cursor にも hooks（`hooks.json`）があり、そちらを優先する方がよい。
- **Gemini CLI**: `~/.gemini/tmp/<project_hash>/`（`chats/`, `logs.json`, `checkpoints/`）。hooks・テレメトリ（OTel）もある。`project_hash` から cwd への逆引きには `~/.gemini/projects.json` を使う。
- **GitHub Copilot coding agent / Devin / Codex Cloud / Claude Code on the web**: ローカルにファイルが無いリモート型。API（GitHub の PR・Issue アサイン、Devin Sessions API）をポーリングするアダプタになる。この種のソースは `liveStatus` を PR やセッションの状態から推定する。認証トークンは OS キーチェーンに保存する。
- **Antigravity**: `~/.gemini/antigravity/` 配下にデータを持つ。hooks ベースのアダプタにできる可能性がある。

---

## 8. リスクと対策のまとめ

| リスク | 影響 | 対策 |
|---|---|---|
| 内部形式の無告知変更（JSONL のキー、SQLite のスキーマ番号） | 取り込み停止・誤判定 | バージョンで分岐、必須キーの検査、段階的縮退、フィクスチャでの CI |
| Claude の30日自動削除 | 過去の実績が消える | 取り込み時にスナップショット、起動時のバックフィル |
| 設定ディレクトリが複数ある | 取りこぼし、hooks が発火しない | `~/.claude*` を全走査し、ユーザーに確認 |
| hooks の衝突（他ツールとの共存、Codex notify は単一） | 他ツールを壊す | notify は使わない。hooks は識別子付きで冪等に追加・削除し、バックアップを取る |
| Codex hooks の信頼承認 | 導入しても動かない | 導入 UI で `/hooks` での承認を案内し、spool の受信有無でヘルスチェック |
| 会話本文の混入 | プライバシー事故 | キーの許可リスト、hook 側での破棄、DB の定期監査（長文フィールドの検出） |
| 大容量（数百MB 規模のトランスクリプト・セッションディレクトリ） | 初回取り込みが重い | mtime とオフセットのカーソルで差分処理、初回はバックグラウンドで低優先度実行 |
| 書き込み途中の行 | パースエラー | 末尾行を保留する（Codex の SQLite は Phase0 では開かない。1.4） |
| 「完了」と「返答待ち」の誤判定 | 不要なタスクや見落とし | 成果物ベースの判定、24時間の自動 done、ユーザーの修正操作を記録 |

---

## 付録: 構造確認用コマンド（本文を出力しないもの）

```bash
# Claude: レコード型の分布
jq -r '.type' ./<enc>/<sid>.jsonl | sort | uniq -c
# Claude: system subtype
jq -r 'select(type=="object" and .type=="system")|.subtype' ./<enc>/<sid>.jsonl | sort | uniq -c
# Claude: ライブ状態
jq -r '[.pid,.status,.kind,.entrypoint]|@tsv' <cfg>/sessions/*.json
# Codex: スキーマ（-readonly / mode=ro は普段の状態で失敗し、-wal だけある状態では -shm を作るので使わない。
#        immutable=1 はスキーマ確認だけなら書き込み中でも害がない）
sqlite3 "file:$HOME/.codex/state_5.sqlite?mode=ro&immutable=1" ".schema threads"
# Codex: rollout の型分布
jq -r '.type+":"+(.payload.type//"-")' rollout-*.jsonl | sort | uniq -c
```

`<enc>` は先頭が `-` なので、jq 等に渡すときは `./` を付ける。

参考:
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code monitoring (OTel): https://code.claude.com/docs/en/monitoring-usage
- Claude Code settings / CLAUDE_CONFIG_DIR: https://code.claude.com/docs/en/settings
- cleanupPeriodDays による30日削除: https://github.com/anthropics/claude-code/issues/62476
- Codex hooks: https://learn.chatgpt.com/docs/hooks
- Codex 詳細設定（notify / otel / history）: https://learn.chatgpt.com/docs/config-file/config-advanced
- Gemini CLI セッション管理: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md
