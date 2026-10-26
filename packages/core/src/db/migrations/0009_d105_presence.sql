-- 0009（D-105・D-106・D-110）: 勤務時間をなくし、放置を在席（Mac を使っていた時間）で数える。drizzle-kit の生成を手で直したもの:
-- - presence_span: 在席の区間（端末内だけ。同期しない）。始まりと終わりだけを持つ（ADR 0013）
-- - work_day_auto（自動の勤務時間のキャッシュ）と daily_note.work_start_at / work_end_at（手で直した勤務時間）を消す
-- - ai_wait_segment.excluded_by: 'off_hours' を外し 'closed'（一日を閉じていた）・'away'（不在）を足す。在席の記録を
--   始める前の日は作り直さない（D-110 (3)）ので行を写し、'off_hours' は 'away' に読み替える（どちらも「放置に数えない」）
-- - PRAGMA foreign_keys=OFF/ON は適用関数のトランザクション内では効かないので外す（migrate.ts）。
--   ai_wait_segment・daily_note を参照するテーブルは無い
CREATE TABLE `presence_span` (
	`id` text PRIMARY KEY NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`source` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "presence_span_range_ck" CHECK(end_at >= start_at),
	CONSTRAINT "presence_span_source_ck" CHECK(source IN ('hid'))
);
--> statement-breakpoint
CREATE INDEX `presence_span_end_idx` ON `presence_span` (`end_at`);--> statement-breakpoint
DROP TABLE `work_day_auto`;--> statement-breakpoint
CREATE TABLE `__new_ai_wait_segment` (
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
	CONSTRAINT "ai_wait_seg_excluded_by_ck" CHECK(excluded_by IN ('closed', 'away', 'event', 'snoozed', 'no_task', 'scheduled')),
	CONSTRAINT "ai_wait_seg_is_open_ck" CHECK(is_open IN (0, 1)),
	CONSTRAINT "ai_wait_seg_end_reason_ck" CHECK(end_reason IN ('human_input', 'engaged', 'status_left', 'resolved', 'dismissed', 'expired', 'superseded')),
	CONSTRAINT "ai_wait_seg_estimated_ck" CHECK(estimated IN (0, 1)),
	CONSTRAINT "ai_wait_seg_range_ck" CHECK(end_at >= start_at),
	CONSTRAINT "ai_wait_seg_excluded_pair_ck" CHECK((kind = 'excluded') = (excluded_by IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_ai_wait_segment`("id", "work_item_id", "wait_key", "follow_up_id", "local_date", "kind", "excluded_by", "start_at", "end_at", "is_open", "end_reason", "estimated", "computed_at") SELECT "id", "work_item_id", "wait_key", "follow_up_id", "local_date", "kind", CASE "excluded_by" WHEN 'off_hours' THEN 'away' ELSE "excluded_by" END, "start_at", "end_at", "is_open", "end_reason", "estimated", "computed_at" FROM `ai_wait_segment`;--> statement-breakpoint
DROP TABLE `ai_wait_segment`;--> statement-breakpoint
ALTER TABLE `__new_ai_wait_segment` RENAME TO `ai_wait_segment`;--> statement-breakpoint
CREATE INDEX `ai_wait_seg_date_idx` ON `ai_wait_segment` (`local_date`,`kind`);--> statement-breakpoint
CREATE INDEX `ai_wait_seg_wi_idx` ON `ai_wait_segment` (`work_item_id`,`start_at`);--> statement-breakpoint
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
	`ai_summary_md` text,
	`ai_summary_tool` text,
	`ai_summary_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`hlc` text NOT NULL,
	`device_id` text NOT NULL,
	`deleted_at` integer,
	`sync_scope` text DEFAULT 'synced' NOT NULL,
	FOREIGN KEY (`highlight_task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "daily_note_sync_scope_ck" CHECK(sync_scope IN ('synced', 'local_only'))
);
--> statement-breakpoint
INSERT INTO `__new_daily_note`("id", "date", "plan_md", "memo_md", "report_md", "highlight_task_id", "planned_min", "actual_min", "morning_done_at", "shutdown_done_at", "ai_summary_md", "ai_summary_tool", "ai_summary_at", "created_at", "updated_at", "hlc", "device_id", "deleted_at", "sync_scope") SELECT "id", "date", "plan_md", "memo_md", "report_md", "highlight_task_id", "planned_min", "actual_min", "morning_done_at", "shutdown_done_at", "ai_summary_md", "ai_summary_tool", "ai_summary_at", "created_at", "updated_at", "hlc", "device_id", "deleted_at", "sync_scope" FROM `daily_note`;--> statement-breakpoint
DROP TABLE `daily_note`;--> statement-breakpoint
ALTER TABLE `__new_daily_note` RENAME TO `daily_note`;--> statement-breakpoint
CREATE UNIQUE INDEX `daily_note_date_uq` ON `daily_note` (`date`) WHERE deleted_at IS NULL;