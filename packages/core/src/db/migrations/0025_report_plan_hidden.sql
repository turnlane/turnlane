-- 0025: 報告の予定を非表示にしたときの始める時刻（scheduled_at と同じ値の間だけ隠す）
ALTER TABLE `ai_session` ADD `plan_hidden_at` integer;