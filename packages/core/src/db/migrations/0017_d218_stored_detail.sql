-- 0017: 待ちの中身の限定した保存（ADR 0018、D-218）。自分の指示の 1 行目（ターンごと）と、自分の番の待ちの中身（フォローアップごと）。伏せ字の後の文だけ
CREATE TABLE `ai_instruction` (
	`turn_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`at` integer NOT NULL,
	`text` text NOT NULL,
	`masked` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`turn_id`) REFERENCES `ai_turn`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `ai_session`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ai_instruction_masked_ck" CHECK(masked IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `ai_instruction_session_idx` ON `ai_instruction` (`session_id`,`at`);--> statement-breakpoint
CREATE TABLE `wait_detail` (
	`follow_up_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`text` text,
	`options_json` text,
	`tool` text,
	`label` text,
	`command` text,
	`error_kind` text,
	`masked` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`follow_up_id`) REFERENCES `follow_up`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "wait_detail_kind_ck" CHECK(kind IN ('permission', 'question', 'ask', 'error')),
	CONSTRAINT "wait_detail_masked_ck" CHECK(masked IN (0, 1))
);
