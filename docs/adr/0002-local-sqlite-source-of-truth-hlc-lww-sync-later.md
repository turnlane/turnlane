# ADR 0002: ローカル SQLite を正とし、同期は HLC + LWW で後付けする

- ステータス: Accepted / Amended by [ADR 0008](./0008-mit-no-server-open-source.md)（同期サーバーは作らない。同期用カラムと `mutate()` / `change_log` は残す。それ以外の決定は有効）
- 日付: 2026-10-02

## Context

- データは単一ユーザーのもので、共同編集は無い。同時編集が起きるのは「複数の端末でほぼ同時に同じタスクを触る」程度。
- AI セッション由来のデータはローカルから出したくない（ADR 0005）。同期対象をテーブル・行単位で明示的に制御したい。
- Phase0 は同期なしで使い始めるが、Phase1 以降でマルチデバイス同期を追加する可能性が高い。後から同期を足すときにスキーマを作り直したくない。
- レーン内の並び順、取り込みの高頻度書き込み、時刻集計があり、Markdown ファイルを正にすると監視と競合解決が重くなる。

検討経緯は非公開の戦略ドキュメントにある。

## Decision

- **ローカル SQLite（WAL）を正（source of truth）**とする。ORM は Drizzle（bun-sqlite ドライバ）。
- ユーザーが作るデータ（task, time_block, project, daily_note, setting など）には最初から同期用カラムを持たせる: `id`（UUIDv7）、`created_at`、`updated_at`、`hlc`、`device_id`、`deleted_at`、`sync_scope`（`synced` / `local_only`）。
- 同期対象テーブルへの書き込みは必ず `mutate()` 層を通し、同じトランザクションで `change_log`（outbox）に変更フィールドを記録する。削除は論理削除。
- AI 取り込み系テーブル（`ai_*`、`ingest_cursor`、`hook_event`、`calendar_event`）は `local_only` 固定とし、変更ログを書かない。
- 同期は Phase1 以降に、**Hybrid Logical Clock による Last-Writer-Wins**（Phase0 時点のログは行単位、フィールド単位に上げられる形で patch を残す）で自前実装する。同期サーバの具体的な実装は Phase1 で決める。
- マイグレーションは前進のみ。適用前に `VACUUM INTO` でバックアップを取る。
- ポータビリティとして JSON Lines の完全エクスポート（`dl export --json`）を Phase0 から提供する。Markdown は正にせず、エクスポート / ミラーとしてのみ扱う。

## Consequences

- Phase0 は同期を実装せずに済み、開発が速い。後から同期を足すときもスキーマ変更が小さい。
- 汎用同期エンジンを採用しないのでロックインが無く、同期対象の制御を素直に書ける。
- ネイティブモバイルを本格化して同期要求が上がった場合は、汎用同期エンジンへの移行を再検討する。UUIDv7 / hlc / deleted_at / change_log を持っていれば移行コストは小さい。
- すべての書き込み経路を `mutate()` に限定する規律が要る（lint で直接書き込みを禁止する）。
- 取り込みデータは元ファイルが消えると作り直せない（Claude Code の30日削除）。取り込み系の行は削除せず、再取り込みは upsert のみとする。
