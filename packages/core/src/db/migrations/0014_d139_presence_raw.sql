-- 0014（D-139）: 在席の区間を「入力のあった区間」で持つ。これまでは区間の終わりに「使っていた」とみなす長さ T
-- （presence.tail_min）を足して保存していた。T は読むときに足す（derive.expandPresence）。
-- - seen_until: 最後の入力から途切れずに見ていた最後のサンプルの時刻。在席の終わりはこれを超えない
-- - 既存の行は、終わりから T を引く（始まりより前にはしない）。T は書いた時点の値が分からないので、今の設定
--   （無い・範囲外なら既定の 5 分）を使う（設定の履歴は持っていない）
-- - 上限の分かる行は seen_until に元の終わりを入れる。T より短い区間（スリープ・ロック・停止で T の前に切れた）と、
--   最後の区間（今続いている。デーモンの起動時に続きを引き継ぐ）。ほかは NULL（上限なし）。どちらでも、同じ T で
--   読めば元の区間と同じになる
ALTER TABLE `presence_span` ADD `seen_until` integer;
--> statement-breakpoint
WITH t(ms) AS (
  SELECT COALESCE(
    (SELECT CAST(value_json AS INTEGER) * 60000 FROM `setting`
      WHERE key = 'presence.tail_min' AND json_valid(value_json) AND json_type(value_json) = 'integer'
        AND CAST(value_json AS INTEGER) BETWEEN 2 AND 15),
    300000)
),
last(id) AS (SELECT id FROM `presence_span` ORDER BY end_at DESC, id DESC LIMIT 1)
UPDATE `presence_span` SET
  seen_until = CASE
    WHEN end_at - start_at < (SELECT ms FROM t) OR id IN (SELECT id FROM last) THEN end_at
    ELSE NULL END,
  end_at = MAX(start_at, end_at - (SELECT ms FROM t));
