-- 0005（M3-3、D-070）: dayline が書き戻した予定の時間ブロック（url = dayline://timeblock/<id>）。次の同期で埋まる
ALTER TABLE `calendar_event` ADD `own_timeblock_id` text;