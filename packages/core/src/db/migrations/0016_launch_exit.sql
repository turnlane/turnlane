-- 0016: 依頼の起動の診断（Claude のアカウント、AI の CLI の終了コードと時間、セッションが見つからなかった理由）
ALTER TABLE `ai_launch` ADD `claude_account` text;--> statement-breakpoint
ALTER TABLE `ai_launch` ADD `exit_code` integer;--> statement-breakpoint
ALTER TABLE `ai_launch` ADD `exit_after_ms` integer;--> statement-breakpoint
ALTER TABLE `ai_launch` ADD `exited_at` integer;--> statement-breakpoint
ALTER TABLE `ai_launch` ADD `unlinked_reason` text;
