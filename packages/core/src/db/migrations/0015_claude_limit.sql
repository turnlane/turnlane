-- 0015: Claude の利用枠の最新の値（アカウントごと）。statusLine の受け口が送る rate_limits の使用率とリセットの時刻だけ
CREATE TABLE `claude_limit` (
	`account` text PRIMARY KEY NOT NULL,
	`five_hour_pct` real,
	`five_hour_resets_at` integer,
	`seven_day_pct` real,
	`seven_day_resets_at` integer,
	`at` integer NOT NULL
);
