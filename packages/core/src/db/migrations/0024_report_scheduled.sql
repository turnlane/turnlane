-- 0024: 報告の予定（state scheduled。0.8.1）の始める時刻。started などが来たら null。AI の項目にはしない
ALTER TABLE `ai_session` ADD `scheduled_at` integer;