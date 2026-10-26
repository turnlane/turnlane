-- 0011（D-125）: カレンダーの色を Turnlane の中だけで選ぶ。drizzle-kit の生成のまま:
-- - calendar.color_key: パレットのキー（null ならカレンダーアプリの色 color に従う）。calendar は端末内だけで同期しない
ALTER TABLE `calendar` ADD `color_key` text;