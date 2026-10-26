CREATE TABLE `ai_artifact` (
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
CREATE UNIQUE INDEX `ai_artifact_uq` ON `ai_artifact` (`kind`,`ref`);--> statement-breakpoint
CREATE INDEX `ai_artifact_wi_idx` ON `ai_artifact` (`work_item_id`);--> statement-breakpoint
CREATE INDEX `ai_artifact_open_idx` ON `ai_artifact` (`state_checked_at`) WHERE kind = 'pr' AND state IN ('open', 'draft', 'unknown');--> statement-breakpoint
CREATE TABLE `ai_session` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`tool` text NOT NULL,
	`external_id` text NOT NULL,
	`parent_session_id` text,
	`is_subagent` integer DEFAULT 0 NOT NULL,
	`entrypoint` text,
	`client_version` text,
	`model` text,
	`cwd` text,
	`repo_root` text,
	`title` text,
	`title_source` text,
	`started_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`ended_at` integer,
	`live_status` text,
	`live_pid` integer,
	`live_checked_at` integer,
	`archived` integer DEFAULT 0 NOT NULL,
	`has_human_input` integer DEFAULT 0 NOT NULL,
	`is_noise` integer DEFAULT 0 NOT NULL,
	`file_path` text,
	`transcript_missing_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `ai_source`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_session_id`) REFERENCES `ai_session`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_session_tool_ck" CHECK(length(tool) BETWEEN 2 AND 32 AND tool NOT GLOB '*[^a-z0-9_]*'),
	CONSTRAINT "ai_session_is_subagent_ck" CHECK(is_subagent IN (0, 1)),
	CONSTRAINT "ai_session_live_status_ck" CHECK(live_status IN ('busy', 'idle', 'gone')),
	CONSTRAINT "ai_session_archived_ck" CHECK(archived IN (0, 1)),
	CONSTRAINT "ai_session_has_human_input_ck" CHECK(has_human_input IN (0, 1)),
	CONSTRAINT "ai_session_is_noise_ck" CHECK(is_noise IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_session_uq` ON `ai_session` (`tool`,`external_id`);--> statement-breakpoint
CREATE INDEX `ai_session_repo_idx` ON `ai_session` (`repo_root`);--> statement-breakpoint
CREATE INDEX `ai_session_recent_idx` ON `ai_session` (`last_activity_at`);--> statement-breakpoint
CREATE INDEX `ai_session_parent_idx` ON `ai_session` (`parent_session_id`) WHERE parent_session_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `ai_source` (
	`id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`root_path` text NOT NULL,
	`profile_label` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`hooks_state` text DEFAULT 'none' NOT NULL,
	`include_globs_json` text DEFAULT '[]' NOT NULL,
	`exclude_globs_json` text DEFAULT '[]' NOT NULL,
	`health_level` text DEFAULT 'L0' NOT NULL,
	`health_reason` text,
	`detected_version` text,
	`last_ingest_at` integer,
	`last_hook_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "ai_source_tool_ck" CHECK(length(tool) BETWEEN 2 AND 32 AND tool GLOB '[a-z]*' AND tool NOT GLOB '*[^a-z0-9_]*'),
	CONSTRAINT "ai_source_enabled_ck" CHECK(enabled IN (0, 1)),
	CONSTRAINT "ai_source_hooks_state_ck" CHECK(hooks_state IN ('none', 'installed', 'pending_trust', 'receiving', 'silent')),
	CONSTRAINT "ai_source_health_level_ck" CHECK(health_level IN ('L0', 'L1', 'L2', 'L3'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_source_uq` ON `ai_source` (`tool`,`root_path`);--> statement-breakpoint
CREATE TABLE `ai_turn` (
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
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `ai_session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_turn_status_ck" CHECK(status IN ('running', 'completed', 'interrupted', 'error')),
	CONSTRAINT "ai_turn_ended_with_ck" CHECK(ended_with IN ('end_turn', 'question', 'permission', 'error', 'aborted')),
	CONSTRAINT "ai_turn_initiator_ck" CHECK(initiator IN ('human', 'queued', 'scheduled', 'system')),
	CONSTRAINT "ai_turn_pending_question_ck" CHECK(pending_question IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_turn_uq` ON `ai_turn` (`session_id`,`turn_key`);--> statement-breakpoint
CREATE INDEX `ai_turn_wi_idx` ON `ai_turn` (`work_item_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `ai_turn_date_idx` ON `ai_turn` (`local_date`);--> statement-breakpoint
CREATE TABLE `calendar` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'eventkit' NOT NULL,
	`external_id` text NOT NULL,
	`account_name` text,
	`name` text NOT NULL,
	`color` text,
	`is_writable` integer DEFAULT 0 NOT NULL,
	`role` text DEFAULT 'source' NOT NULL,
	`last_synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "calendar_provider_ck" CHECK(provider IN ('eventkit')),
	CONSTRAINT "calendar_is_writable_ck" CHECK(is_writable IN (0, 1)),
	CONSTRAINT "calendar_role_ck" CHECK(role IN ('source', 'writeback', 'ignored'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_ext_uq` ON `calendar` (`provider`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_writeback_uq` ON `calendar` (`role`) WHERE role = 'writeback';--> statement-breakpoint
CREATE TABLE `calendar_event` (
	`id` text PRIMARY KEY NOT NULL,
	`calendar_id` text NOT NULL,
	`external_id` text NOT NULL,
	`occurrence_start` integer NOT NULL,
	`title` text,
	`location` text,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`tz` text,
	`all_day` integer DEFAULT 0 NOT NULL,
	`start_date` text,
	`end_date` text,
	`status` text,
	`availability` text,
	`self_response` text,
	`conference_url` text,
	`ext_updated_at` integer,
	`is_own_timeblock` integer DEFAULT 0 NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`calendar_id`) REFERENCES `calendar`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "cal_event_all_day_ck" CHECK(all_day IN (0, 1)),
	CONSTRAINT "cal_event_status_ck" CHECK(status IN ('confirmed', 'tentative', 'cancelled')),
	CONSTRAINT "cal_event_availability_ck" CHECK(availability IN ('busy', 'free', 'tentative', 'unavailable')),
	CONSTRAINT "cal_event_self_response_ck" CHECK(self_response IN ('accepted', 'declined', 'tentative', 'pending', 'unknown')),
	CONSTRAINT "cal_event_is_own_timeblock_ck" CHECK(is_own_timeblock IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cal_event_uq` ON `calendar_event` (`calendar_id`,`external_id`,`occurrence_start`);--> statement-breakpoint
CREATE INDEX `cal_event_range_idx` ON `calendar_event` (`start_at`,`end_at`);--> statement-breakpoint
CREATE TABLE `change_log` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tbl` text NOT NULL,
	`row_id` text NOT NULL,
	`op` text NOT NULL,
	`hlc` text NOT NULL,
	`device_id` text NOT NULL,
	`patch_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`pushed_at` integer,
	CONSTRAINT "change_log_op_ck" CHECK(op IN ('insert', 'update', 'delete'))
);
--> statement-breakpoint
CREATE INDEX `change_log_unpushed_idx` ON `change_log` (`seq`) WHERE pushed_at IS NULL;--> statement-breakpoint
CREATE INDEX `change_log_row_idx` ON `change_log` (`tbl`,`row_id`);--> statement-breakpoint
CREATE TABLE `daily_note` (
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
CREATE UNIQUE INDEX `daily_note_date_uq` ON `daily_note` (`date`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE TABLE `device` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_self` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "device_is_self_ck" CHECK(is_self IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_self_uq` ON `device` (`is_self`) WHERE is_self = 1;--> statement-breakpoint
CREATE TABLE `follow_up` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`kind` text NOT NULL,
	`artifact_ref` text DEFAULT '' NOT NULL,
	`dedupe_key` text NOT NULL,
	`trigger_at` integer NOT NULL,
	`trigger_turn_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`snooze_until` integer,
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
	CONSTRAINT "follow_up_status_ck" CHECK(status IN ('open', 'snoozed', 'done', 'dismissed', 'superseded')),
	CONSTRAINT "follow_up_sync_scope_ck" CHECK(sync_scope IN ('synced', 'local_only'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `follow_up_dedupe_uq` ON `follow_up` (`dedupe_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `follow_up_task_uq` ON `follow_up` (`task_id`) WHERE task_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `follow_up_open_idx` ON `follow_up` (`status`,`trigger_at`) WHERE status IN ('open', 'snoozed');--> statement-breakpoint
CREATE INDEX `follow_up_wi_idx` ON `follow_up` (`work_item_id`);--> statement-breakpoint
CREATE TABLE `hook_event` (
	`id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`config_root` text,
	`hook_event_name` text NOT NULL,
	`session_external_id` text,
	`turn_id` text,
	`prompt_id` text,
	`notification_type` text,
	`tool_name` text,
	`error_type` text,
	`source` text,
	`reason` text,
	`cwd` text,
	`occurred_at` integer NOT NULL,
	`spool_file` text NOT NULL,
	`spool_offset` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "hook_event_tool_ck" CHECK(length(tool) BETWEEN 2 AND 32 AND tool NOT GLOB '*[^a-z0-9_]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hook_event_spool_uq` ON `hook_event` (`spool_file`,`spool_offset`);--> statement-breakpoint
CREATE INDEX `hook_event_sess_idx` ON `hook_event` (`session_external_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `hook_event_time_idx` ON `hook_event` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `ingest_cursor` (
	`source_id` text NOT NULL,
	`stream_key` text NOT NULL,
	`kind` text NOT NULL,
	`dev` integer,
	`inode` integer,
	`size` integer,
	`mtime_ms` integer,
	`byte_offset` integer DEFAULT 0 NOT NULL,
	`watermark` text,
	`carry_state_json` text,
	`parser_id` text NOT NULL,
	`parser_version` integer NOT NULL,
	`records_ok` integer DEFAULT 0 NOT NULL,
	`records_skipped` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`source_id`, `stream_key`),
	FOREIGN KEY (`source_id`) REFERENCES `ai_source`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ingest_cursor_kind_ck" CHECK(kind IN ('jsonl', 'json_snapshot', 'sqlite'))
);
--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`repo_paths_json` text DEFAULT '[]' NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`hlc` text NOT NULL,
	`device_id` text NOT NULL,
	`deleted_at` integer,
	`sync_scope` text DEFAULT 'synced' NOT NULL,
	CONSTRAINT "project_sync_scope_ck" CHECK(sync_scope IN ('synced', 'local_only'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_name_uq` ON `project` (`name`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE TABLE `setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	`hlc` text NOT NULL,
	`device_id` text NOT NULL,
	`sync_scope` text DEFAULT 'local_only' NOT NULL,
	CONSTRAINT "setting_sync_scope_ck" CHECK(sync_scope IN ('synced', 'local_only'))
);
--> statement-breakpoint
CREATE TABLE `task` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`notes_md` text,
	`status` text DEFAULT 'todo' NOT NULL,
	`scheduled_date` text,
	`lane_order` text NOT NULL,
	`due_date` text,
	`estimate_min` integer,
	`priority` integer DEFAULT 0 NOT NULL,
	`project_id` text,
	`source` text NOT NULL,
	`source_ref` text,
	`external_source` text,
	`external_id` text,
	`external_url` text,
	`rollover_count` integer DEFAULT 0 NOT NULL,
	`is_highlight` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`auto_completed` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`hlc` text NOT NULL,
	`device_id` text NOT NULL,
	`deleted_at` integer,
	`sync_scope` text DEFAULT 'synced' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_status_ck" CHECK(status IN ('todo', 'doing', 'done', 'canceled', 'someday')),
	CONSTRAINT "task_estimate_ck" CHECK(estimate_min IS NULL OR estimate_min >= 0),
	CONSTRAINT "task_priority_ck" CHECK(priority BETWEEN 0 AND 3),
	CONSTRAINT "task_source_ck" CHECK(source IN ('manual', 'cli', 'mcp', 'ai', 'calendar')),
	CONSTRAINT "task_external_source_ck" CHECK(external_source IS NULL OR (length(external_source) BETWEEN 1 AND 64 AND external_source NOT GLOB '*[^a-z0-9._-]*')),
	CONSTRAINT "task_external_id_ck" CHECK(external_id IS NULL OR length(external_id) BETWEEN 1 AND 256),
	CONSTRAINT "task_is_highlight_ck" CHECK(is_highlight IN (0, 1)),
	CONSTRAINT "task_auto_completed_ck" CHECK(auto_completed IN (0, 1)),
	CONSTRAINT "task_sync_scope_ck" CHECK(sync_scope IN ('synced', 'local_only')),
	CONSTRAINT "task_external_pair_ck" CHECK((external_source IS NULL) = (external_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_external_uq` ON `task` (`external_source`,`external_id`) WHERE external_source IS NOT NULL;--> statement-breakpoint
CREATE INDEX `task_lane_idx` ON `task` (`scheduled_date`,`lane_order`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `task_inbox_idx` ON `task` (`created_at`) WHERE scheduled_date IS NULL AND deleted_at IS NULL AND status IN ('todo', 'doing');--> statement-breakpoint
CREATE INDEX `task_project_idx` ON `task` (`project_id`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `task_done_idx` ON `task` (`completed_at`) WHERE completed_at IS NOT NULL;--> statement-breakpoint
CREATE TABLE `task_time_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`hlc` text NOT NULL,
	`device_id` text NOT NULL,
	`deleted_at` integer,
	`sync_scope` text DEFAULT 'synced' NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tte_source_ck" CHECK(source IN ('tap', 'followup_estimate', 'timeblock_assumed')),
	CONSTRAINT "tte_sync_scope_ck" CHECK(sync_scope IN ('synced', 'local_only')),
	CONSTRAINT "tte_range_ck" CHECK(end_at IS NULL OR end_at >= start_at)
);
--> statement-breakpoint
CREATE INDEX `tte_task_idx` ON `task_time_entry` (`task_id`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `tte_start_idx` ON `task_time_entry` (`start_at`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE TABLE `time_block` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`title` text,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`tz` text NOT NULL,
	`writeback_provider` text,
	`writeback_calendar_id` text,
	`external_event_id` text,
	`external_updated_at` integer,
	`writeback_state` text DEFAULT 'pending' NOT NULL,
	`writeback_error` text,
	`writeback_attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`hlc` text NOT NULL,
	`device_id` text NOT NULL,
	`deleted_at` integer,
	`sync_scope` text DEFAULT 'synced' NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`writeback_calendar_id`) REFERENCES `calendar`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "time_block_wb_provider_ck" CHECK(writeback_provider IN ('eventkit')),
	CONSTRAINT "time_block_wb_state_ck" CHECK(writeback_state IN ('pending', 'synced', 'conflict', 'error', 'disabled')),
	CONSTRAINT "time_block_sync_scope_ck" CHECK(sync_scope IN ('synced', 'local_only')),
	CONSTRAINT "time_block_range_ck" CHECK(end_at > start_at)
);
--> statement-breakpoint
CREATE INDEX `time_block_range_idx` ON `time_block` (`start_at`,`end_at`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `time_block_task_idx` ON `time_block` (`task_id`);--> statement-breakpoint
CREATE INDEX `time_block_wb_idx` ON `time_block` (`writeback_state`) WHERE writeback_state IN ('pending', 'error');--> statement-breakpoint
CREATE TABLE `usage_event` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`ref` text
);
--> statement-breakpoint
CREATE INDEX `usage_event_idx` ON `usage_event` (`kind`,`at`);--> statement-breakpoint
CREATE TABLE `work_item` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`group_key` text NOT NULL,
	`repo_root` text,
	`branch` text,
	`pr_ref` text,
	`title_auto` text,
	`title_source` text,
	`title_user` text,
	`status` text NOT NULL,
	`status_reason` text,
	`status_estimated` integer DEFAULT 0 NOT NULL,
	`status_changed_at` integer NOT NULL,
	`manual_done_at` integer,
	`merged_into_id` text,
	`hidden_at` integer,
	`tools_json` text DEFAULT '[]' NOT NULL,
	`first_activity_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`hlc` text NOT NULL,
	`device_id` text NOT NULL,
	`deleted_at` integer,
	`sync_scope` text DEFAULT 'local_only' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merged_into_id`) REFERENCES `work_item`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "work_item_title_source_ck" CHECK(title_source IN ('pr', 'ai_title', 'thread_name', 'desktop_title', 'branch', 'session_name', 'repo')),
	CONSTRAINT "work_item_status_ck" CHECK(status IN ('running', 'needs_input', 'your_turn', 'done', 'error')),
	CONSTRAINT "work_item_status_estimated_ck" CHECK(status_estimated IN (0, 1)),
	CONSTRAINT "work_item_sync_scope_ck" CHECK(sync_scope IN ('synced', 'local_only'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_item_key_uq` ON `work_item` (`group_key`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `work_item_open_idx` ON `work_item` (`status`,`last_activity_at`) WHERE deleted_at IS NULL AND status <> 'done';--> statement-breakpoint
CREATE INDEX `work_item_recent_idx` ON `work_item` (`last_activity_at`);--> statement-breakpoint
CREATE TABLE `work_item_status_log` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`status` text NOT NULL,
	`from_at` integer NOT NULL,
	`to_at` integer,
	`reason` text,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "wisl_status_ck" CHECK(status IN ('running', 'needs_input', 'your_turn', 'done', 'error'))
);
--> statement-breakpoint
CREATE INDEX `wisl_item_idx` ON `work_item_status_log` (`work_item_id`,`from_at`);--> statement-breakpoint
CREATE INDEX `wisl_open_idx` ON `work_item_status_log` (`work_item_id`) WHERE to_at IS NULL;