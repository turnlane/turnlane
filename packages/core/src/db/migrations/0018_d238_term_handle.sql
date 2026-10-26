-- 0018: hooks が記録する Orca の端末のハンドル（ORCA_TERMINAL_HANDLE）。Turnlane から答える届け先を決める（D-238）
ALTER TABLE `hook_event` ADD `term_handle` text;