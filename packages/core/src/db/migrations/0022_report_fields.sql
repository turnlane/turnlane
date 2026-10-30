-- 0022: 外の作業の報告（ADR 0021）。報告のセッションのプロジェクトの名前・開く先、報告の待ちの中身（伏せ字の後。turn.store_detail のときだけ）
ALTER TABLE `ai_session` ADD `project_name` text;--> statement-breakpoint
ALTER TABLE `ai_session` ADD `open_url` text;--> statement-breakpoint
ALTER TABLE `ai_turn` ADD `wait_json` text;