-- 0010（D-107・D-109・D-110、M5-B）: タスクから AI に頼む（無料の部分）。drizzle-kit の生成のまま:
-- - ai_launch: 頼んだ1回（起動 ID・ツール・リポジトリ・worktree・紐づいたセッション）。端末内だけで同期しない
-- - ai_template: 利用者が足した依頼の型（組み込みの4つはコードに持つ）
-- - follow_up.task_id の一意をやめる（頼んだタスクに自分の番が何度も付く。plan §B.2）
-- - project: worktree の既定・コピーするファイル・テストのコマンド（列の追加）
CREATE TABLE `ai_launch` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`tool` text NOT NULL,
	`repo_root` text NOT NULL,
	`cwd` text NOT NULL,
	`worktree_path` text,
	`branch` text,
	`base_ref` text,
	`template_id` text,
	`read_only` integer DEFAULT 0 NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`session_uuid` text,
	`session_id` text,
	`status` text NOT NULL,
	`fail_reason` text,
	`test_ok` integer,
	`test_at` integer,
	`created_at` integer NOT NULL,
	`fetched_at` integer,
	`linked_at` integer,
	`cleaned_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `ai_session`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_launch_tool_ck" CHECK(tool IN ('claude_code', 'codex')),
	CONSTRAINT "ai_launch_status_ck" CHECK(status IN ('pending', 'started', 'linked', 'unlinked', 'failed')),
	CONSTRAINT "ai_launch_trigger_ck" CHECK(trigger IN ('manual', 'schedule', 'queue', 'issue')),
	CONSTRAINT "ai_launch_read_only_ck" CHECK(read_only IN (0, 1)),
	CONSTRAINT "ai_launch_test_ok_ck" CHECK(test_ok IS NULL OR test_ok IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `ai_launch_task_idx` ON `ai_launch` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_launch_session_idx` ON `ai_launch` (`session_id`) WHERE session_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `ai_launch_open_idx` ON `ai_launch` (`status`) WHERE status IN ('pending', 'started');--> statement-breakpoint
CREATE TABLE `ai_template` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`body` text NOT NULL,
	`tool` text,
	`read_only` integer DEFAULT 0 NOT NULL,
	`worktree` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "ai_template_tool_ck" CHECK(tool IS NULL OR tool IN ('claude_code', 'codex')),
	CONSTRAINT "ai_template_read_only_ck" CHECK(read_only IN (0, 1)),
	CONSTRAINT "ai_template_worktree_ck" CHECK(worktree IS NULL OR worktree IN (0, 1))
);
--> statement-breakpoint
DROP INDEX `follow_up_task_uq`;--> statement-breakpoint
CREATE INDEX `follow_up_task_idx` ON `follow_up` (`task_id`) WHERE task_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE `project` ADD `worktree_default` integer;--> statement-breakpoint
ALTER TABLE `project` ADD `worktree_copy_globs_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `project` ADD `test_command` text;