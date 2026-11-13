-- 0026（D-360）: 委任で立った子のセッションの hook（T3 Code の delegate_task）。真偽値だけ（スレッドの ID は持たない）
ALTER TABLE `hook_event` ADD `delegated` integer;