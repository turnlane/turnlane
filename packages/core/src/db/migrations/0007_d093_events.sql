-- 0007（D-093）: 予定の作成・編集。eventIdentifier、参加者・繰り返しの有無（編集できるかの判定）、dayline が作った予定の印。
-- 時間ブロックの書き戻しをやめたので、役割が writeback のカレンダーは ignored にする（中身は時間ブロックの予定だけの想定）
ALTER TABLE `calendar_event` ADD `event_id` text;--> statement-breakpoint
ALTER TABLE `calendar_event` ADD `has_attendees` integer;--> statement-breakpoint
ALTER TABLE `calendar_event` ADD `recurring` integer;--> statement-breakpoint
ALTER TABLE `calendar_event` ADD `is_own_event` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `calendar` SET `role` = 'ignored' WHERE `role` = 'writeback';
