-- 手書き: 集計ビュー（phase0-plan 2.3）。drizzle-kit はビューを扱わないため custom マイグレーションにする
CREATE VIEW work_item_daily AS
SELECT
  t.work_item_id,
  t.local_date,
  COUNT(*)                          AS turn_count,
  COALESCE(SUM(t.duration_ms), 0)   AS ai_ms,
  MIN(t.started_at)                 AS first_at,
  MAX(COALESCE(t.ended_at, t.started_at)) AS last_at
FROM ai_turn t
WHERE t.work_item_id IS NOT NULL
GROUP BY t.work_item_id, t.local_date;
