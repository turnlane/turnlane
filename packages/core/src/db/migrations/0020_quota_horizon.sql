-- 0020: 利用枠の自動再開を止めた通知が「明けるのが 24 時間より先」の定型文だったか（真偽値だけ。文は持たない）
ALTER TABLE `hook_event` ADD `quota_horizon` integer;