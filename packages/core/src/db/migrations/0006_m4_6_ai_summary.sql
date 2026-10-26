-- 0006（M4-6、D-041）: 日報の AI 要約（ユーザーが編集できる）、作ったツール、保存した時刻
ALTER TABLE `daily_note` ADD `ai_summary_md` text;--> statement-breakpoint
ALTER TABLE `daily_note` ADD `ai_summary_tool` text;--> statement-breakpoint
ALTER TABLE `daily_note` ADD `ai_summary_at` integer;