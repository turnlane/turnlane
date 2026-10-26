-- 0008（D-097）: 会議リンクがある予定（集中モードの対象）。値は次の同期で入る（NULL = まだ分からない）
ALTER TABLE `calendar_event` ADD `has_meeting_link` integer;