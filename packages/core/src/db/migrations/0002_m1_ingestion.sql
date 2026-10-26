-- 0002（M1-9）: phase0-plan 2.3 の U22（3.3.1）と D-032 の列・テーブル。drizzle-kit の生成を手で直したもの:
-- - 作り直し（新テーブル → コピー → 入れ替え）の INSERT から新しい列を外す（生成物は元テーブルに無い列を SELECT していた）
-- - ai_artifact も作り直して列の順序を DDL（2.3）に合わせる（ALTER TABLE ADD は末尾に足すため）
-- - PRAGMA foreign_keys=OFF/ON は適用関数のトランザクション内では効かないので外す（migrate.ts）。
--   作り直す ai_artifact / follow_up / ai_turn / daily_note は M0 の時点で行が無い（取り込み・UI は M1 以降）
-- - ai_wait_segment は follow_up を参照するので、follow_up の作り直しの後に作る
CREATE TABLE `__new_ai_artifact` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`session_id` text,
	`turn_id` text,
	`work_item_id` text,
	`url` text,
	`title` text,
	`state` text DEFAULT 'unknown' NOT NULL,
	`review_decision` text,
	`my_review_at` integer,
	`head_ref` text,
	`state_changed_at` integer,
	`first_seen_at` integer NOT NULL,
	`state_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `ai_session`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`turn_id`) REFERENCES `ai_turn`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_artifact_kind_ck" CHECK(kind IN ('pr', 'commit', 'file_output')),
	CONSTRAINT "ai_artifact_state_ck" CHECK(state IN ('open', 'draft', 'merged', 'closed', 'unknown'))
);
--> statement-breakpoint
INSERT INTO `__new_ai_artifact`("id", "kind", "ref", "session_id", "turn_id", "work_item_id", "url", "title", "state", "review_decision", "my_review_at", "head_ref", "first_seen_at", "state_checked_at", "created_at", "updated_at") SELECT "id", "kind", "ref", "session_id", "turn_id", "work_item_id", "url", "title", "state", "review_decision", "my_review_at", "head_ref", "first_seen_at", "state_checked_at", "created_at", "updated_at" FROM `ai_artifact`;
--> statement-breakpoint
DROP TABLE `ai_artifact`;
--> statement-breakpoint
ALTER TABLE `__new_ai_artifact` RENAME TO `ai_artifact`;
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_artifact_uq` ON `ai_artifact` (`kind`,`ref`);
--> statement-breakpoint
CREATE INDEX `ai_artifact_wi_idx` ON `ai_artifact` (`work_item_id`);
--> statement-breakpoint
CREATE INDEX `ai_artifact_open_idx` ON `ai_artifact` (`state_checked_at`) WHERE kind = 'pr' AND state IN ('open', 'draft', 'unknown');
--> statement-breakpoint
CREATE TABLE `work_day_auto` (
	`date` text PRIMARY KEY NOT NULL,
	`first_op_at` integer NOT NULL,
	`last_op_at` integer NOT NULL,
	`op_count` integer NOT NULL,
	`computed_at` integer NOT NULL,
	CONSTRAINT "work_day_auto_range_ck" CHECK(last_op_at >= first_op_at)
);
--> statement-breakpoint
CREATE TABLE `__new_follow_up` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`kind` text NOT NULL,
	`artifact_ref` text DEFAULT '' NOT NULL,
	`dedupe_key` text NOT NULL,
	`trigger_at` integer NOT NULL,
	`trigger_turn_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`snooze_until` integer,
	`snoozes_json` text DEFAULT '[]' NOT NULL,
	`task_id` text,
	`engaged_at` integer,
	`closed_at` integer,
	`close_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`hlc` text NOT NULL,
	`device_id` text NOT NULL,
	`deleted_at` integer,
	`sync_scope` text DEFAULT 'local_only' NOT NULL,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trigger_turn_id`) REFERENCES `ai_turn`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "follow_up_kind_ck" CHECK(kind IN ('approve', 'reply', 'review_pr', 'resume_error', 'check_changes', 'merge_pr')),
	CONSTRAINT "follow_up_status_ck" CHECK(status IN ('open', 'snoozed', 'done', 'dismissed', 'superseded', 'expired')),
	CONSTRAINT "follow_up_sync_scope_ck" CHECK(sync_scope IN ('synced', 'local_only'))
);
--> statement-breakpoint
INSERT INTO `__new_follow_up`("id", "work_item_id", "kind", "artifact_ref", "dedupe_key", "trigger_at", "trigger_turn_id", "status", "snooze_until", "task_id", "engaged_at", "closed_at", "close_reason", "created_at", "updated_at", "hlc", "device_id", "deleted_at", "sync_scope") SELECT "id", "work_item_id", "kind", "artifact_ref", "dedupe_key", "trigger_at", "trigger_turn_id", "status", "snooze_until", "task_id", "engaged_at", "closed_at", "close_reason", "created_at", "updated_at", "hlc", "device_id", "deleted_at", "sync_scope" FROM `follow_up`;
--> statement-breakpoint
DROP TABLE `follow_up`;
--> statement-breakpoint
ALTER TABLE `__new_follow_up` RENAME TO `follow_up`;
--> statement-breakpoint
CREATE UNIQUE INDEX `follow_up_dedupe_uq` ON `follow_up` (`dedupe_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `follow_up_task_uq` ON `follow_up` (`task_id`) WHERE task_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `follow_up_open_idx` ON `follow_up` (`status`,`trigger_at`) WHERE status IN ('open', 'snoozed');
--> statement-breakpoint
CREATE INDEX `follow_up_wi_idx` ON `follow_up` (`work_item_id`);
--> statement-breakpoint
CREATE TABLE `__new_ai_turn` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_key` text NOT NULL,
	`work_item_id` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`duration_ms` integer,
	`local_date` text NOT NULL,
	`status` text NOT NULL,
	`ended_with` text,
	`initiator` text,
	`git_branch` text,
	`cwd` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`tool_counts_json` text,
	`edited_files_count` integer DEFAULT 0 NOT NULL,
	`pending_question` integer DEFAULT 0 NOT NULL,
	`closing_question` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `ai_session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_turn_closing_question_ck" CHECK(closing_question IN (0, 1)),
	CONSTRAINT "ai_turn_status_ck" CHECK(status IN ('running', 'completed', 'interrupted', 'error')),
	CONSTRAINT "ai_turn_ended_with_ck" CHECK(ended_with IN ('end_turn', 'question', 'permission', 'error', 'aborted')),
	CONSTRAINT "ai_turn_initiator_ck" CHECK(initiator IN ('human', 'queued', 'scheduled', 'system')),
	CONSTRAINT "ai_turn_pending_question_ck" CHECK(pending_question IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_ai_turn`("id", "session_id", "turn_key", "work_item_id", "started_at", "ended_at", "duration_ms", "local_date", "status", "ended_with", "initiator", "git_branch", "cwd", "input_tokens", "output_tokens", "cache_read_tokens", "tool_counts_json", "edited_files_count", "pending_question", "created_at", "updated_at") SELECT "id", "session_id", "turn_key", "work_item_id", "started_at", "ended_at", "duration_ms", "local_date", "status", "ended_with", "initiator", "git_branch", "cwd", "input_tokens", "output_tokens", "cache_read_tokens", "tool_counts_json", "edited_files_count", "pending_question", "created_at", "updated_at" FROM `ai_turn`;
--> statement-breakpoint
DROP TABLE `ai_turn`;
--> statement-breakpoint
ALTER TABLE `__new_ai_turn` RENAME TO `ai_turn`;
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_turn_uq` ON `ai_turn` (`session_id`,`turn_key`);
--> statement-breakpoint
CREATE INDEX `ai_turn_wi_idx` ON `ai_turn` (`work_item_id`,`started_at`);
--> statement-breakpoint
CREATE INDEX `ai_turn_date_idx` ON `ai_turn` (`local_date`);
--> statement-breakpoint
CREATE TABLE `__new_daily_note` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`plan_md` text,
	`memo_md` text,
	`report_md` text,
	`highlight_task_id` text,
	`planned_min` integer,
	`actual_min` integer,
	`morning_done_at` integer,
	`shutdown_done_at` integer,
	`work_start_at` integer,
	`work_end_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`hlc` text NOT NULL,
	`device_id` text NOT NULL,
	`deleted_at` integer,
	`sync_scope` text DEFAULT 'synced' NOT NULL,
	FOREIGN KEY (`highlight_task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "daily_note_sync_scope_ck" CHECK(sync_scope IN ('synced', 'local_only')),
	CONSTRAINT "daily_note_work_hours_ck" CHECK(work_start_at IS NULL OR work_end_at IS NULL OR work_end_at > work_start_at)
);
--> statement-breakpoint
INSERT INTO `__new_daily_note`("id", "date", "plan_md", "memo_md", "report_md", "highlight_task_id", "planned_min", "actual_min", "morning_done_at", "shutdown_done_at", "created_at", "updated_at", "hlc", "device_id", "deleted_at", "sync_scope") SELECT "id", "date", "plan_md", "memo_md", "report_md", "highlight_task_id", "planned_min", "actual_min", "morning_done_at", "shutdown_done_at", "created_at", "updated_at", "hlc", "device_id", "deleted_at", "sync_scope" FROM `daily_note`;
--> statement-breakpoint
DROP TABLE `daily_note`;
--> statement-breakpoint
ALTER TABLE `__new_daily_note` RENAME TO `daily_note`;
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_note_date_uq` ON `daily_note` (`date`) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TABLE `ai_wait_segment` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`wait_key` text NOT NULL,
	`follow_up_id` text,
	`local_date` text NOT NULL,
	`kind` text NOT NULL,
	`excluded_by` text,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`is_open` integer DEFAULT 0 NOT NULL,
	`end_reason` text,
	`estimated` integer DEFAULT 0 NOT NULL,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`follow_up_id`) REFERENCES `follow_up`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_wait_seg_kind_ck" CHECK(kind IN ('grace', 'idle', 'excluded', 'expired')),
	CONSTRAINT "ai_wait_seg_excluded_by_ck" CHECK(excluded_by IN ('off_hours', 'event', 'snoozed')),
	CONSTRAINT "ai_wait_seg_is_open_ck" CHECK(is_open IN (0, 1)),
	CONSTRAINT "ai_wait_seg_end_reason_ck" CHECK(end_reason IN ('human_input', 'engaged', 'status_left', 'resolved', 'dismissed', 'expired', 'superseded')),
	CONSTRAINT "ai_wait_seg_estimated_ck" CHECK(estimated IN (0, 1)),
	CONSTRAINT "ai_wait_seg_range_ck" CHECK(end_at >= start_at),
	CONSTRAINT "ai_wait_seg_excluded_pair_ck" CHECK((kind = 'excluded') = (excluded_by IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `ai_wait_seg_date_idx` ON `ai_wait_segment` (`local_date`,`kind`);
--> statement-breakpoint
CREATE INDEX `ai_wait_seg_wi_idx` ON `ai_wait_segment` (`work_item_id`,`start_at`);
