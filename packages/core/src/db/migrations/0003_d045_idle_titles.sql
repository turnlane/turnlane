-- 0003（D-045・D-046）: ai_wait_segment.excluded_by に 'no_task'、task.title_key / title_params。drizzle-kit の生成を手で直したもの:
-- - ai_wait_segment は dl rederive で作り直せるキャッシュなので、行は写さずに作り直す（次の derive で作る）
-- - PRAGMA foreign_keys=OFF/ON は適用関数のトランザクション内では効かないので外す（migrate.ts）。
--   ai_wait_segment を参照するテーブルは無い
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
	CONSTRAINT "ai_wait_seg_excluded_by_ck" CHECK(excluded_by IN ('off_hours', 'event', 'snoozed', 'no_task')),
	CONSTRAINT "ai_wait_seg_is_open_ck" CHECK(is_open IN (0, 1)),
	CONSTRAINT "ai_wait_seg_end_reason_ck" CHECK(end_reason IN ('human_input', 'engaged', 'status_left', 'resolved', 'dismissed', 'expired', 'superseded')),
	CONSTRAINT "ai_wait_seg_estimated_ck" CHECK(estimated IN (0, 1)),
	CONSTRAINT "ai_wait_seg_range_ck" CHECK(end_at >= start_at),
	CONSTRAINT "ai_wait_seg_excluded_pair_ck" CHECK((kind = 'excluded') = (excluded_by IS NOT NULL))
);
--> statement-breakpoint
DROP TABLE `ai_wait_segment`;--> statement-breakpoint
ALTER TABLE `__new_ai_wait_segment` RENAME TO `ai_wait_segment`;--> statement-breakpoint
CREATE INDEX `ai_wait_seg_date_idx` ON `ai_wait_segment` (`local_date`,`kind`);--> statement-breakpoint
CREATE INDEX `ai_wait_seg_wi_idx` ON `ai_wait_segment` (`work_item_id`,`start_at`);--> statement-breakpoint
ALTER TABLE `task` ADD `title_key` text;--> statement-breakpoint
ALTER TABLE `task` ADD `title_params` text;
