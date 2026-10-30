-- 0021: 閉じた自分の番を利用者が手で戻した時刻（Issue #3）。手で閉じるか、この後に新しいターンが始まるまで自動では閉じない
ALTER TABLE `follow_up` ADD `returned_at` integer;
