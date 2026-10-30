-- 0023: Codex の hook のハンドラの親（codex のプロセス）の pid（Issue #10）。セッションの live_pid に写す
ALTER TABLE `hook_event` ADD `pid` integer;