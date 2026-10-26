-- 0012（D-135）: 壁打ち（プロジェクトに属さない AI との会話）。
-- - work_item.scratch: 壁打ちのカード（drizzle-kit の生成のまま。runner が作業フォルダから決める）
-- - Codex のプロジェクト外の会話の作業フォルダ `~/Documents/Codex/<日付>/<最初の依頼から作った名前>` を、保存済みの行でも
--   `~/Documents/Codex/<日付>` までに切り落とす（日付の形でなければ `~/Documents/Codex`）。取り込みでは
--   collectors の trimCodexScratchCwd が同じ規則で落とす。ホームは `/Users/<名前>`（macOS）。
--   p = '/Documents/Codex/' の位置、base = `~/Documents/Codex`、seg = その次の1段
-- - Codex の継続状態（ingest_cursor.carry_state_json）に残っている切り落とす前の cwd は捨てる（Codex のパーサの版を
--   3 に上げたので、起動時に先頭から読み直して作り直す）
ALTER TABLE `work_item` ADD `scratch` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `ai_session` SET cwd = x.trimmed
FROM (
  SELECT id, CASE WHEN seg GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN base || '/' || seg ELSE base END AS trimmed
  FROM (
    SELECT id, substr(cwd, 1, p + 15) AS base,
      CASE WHEN instr(rest, '/') > 0 THEN substr(rest, 1, instr(rest, '/') - 1) ELSE rest END AS seg
    FROM (
      SELECT id, cwd, p, substr(cwd, p + 17) AS rest
      FROM (SELECT id, cwd, instr(cwd, '/Documents/Codex/') AS p FROM `ai_session` WHERE cwd LIKE '/Users/%/Documents/Codex/%')
      WHERE p > 8 AND substr(cwd, 8, p - 8) NOT LIKE '%/%'
    )
  )
) AS x
WHERE `ai_session`.id = x.id AND `ai_session`.cwd <> x.trimmed;
--> statement-breakpoint
UPDATE `ai_turn` SET cwd = x.trimmed
FROM (
  SELECT id, CASE WHEN seg GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN base || '/' || seg ELSE base END AS trimmed
  FROM (
    SELECT id, substr(cwd, 1, p + 15) AS base,
      CASE WHEN instr(rest, '/') > 0 THEN substr(rest, 1, instr(rest, '/') - 1) ELSE rest END AS seg
    FROM (
      SELECT id, cwd, p, substr(cwd, p + 17) AS rest
      FROM (SELECT id, cwd, instr(cwd, '/Documents/Codex/') AS p FROM `ai_turn` WHERE cwd LIKE '/Users/%/Documents/Codex/%')
      WHERE p > 8 AND substr(cwd, 8, p - 8) NOT LIKE '%/%'
    )
  )
) AS x
WHERE `ai_turn`.id = x.id AND `ai_turn`.cwd <> x.trimmed;
--> statement-breakpoint
UPDATE `hook_event` SET cwd = x.trimmed
FROM (
  SELECT id, CASE WHEN seg GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN base || '/' || seg ELSE base END AS trimmed
  FROM (
    SELECT id, substr(cwd, 1, p + 15) AS base,
      CASE WHEN instr(rest, '/') > 0 THEN substr(rest, 1, instr(rest, '/') - 1) ELSE rest END AS seg
    FROM (
      SELECT id, cwd, p, substr(cwd, p + 17) AS rest
      FROM (SELECT id, cwd, instr(cwd, '/Documents/Codex/') AS p FROM `hook_event` WHERE cwd LIKE '/Users/%/Documents/Codex/%')
      WHERE p > 8 AND substr(cwd, 8, p - 8) NOT LIKE '%/%'
    )
  )
) AS x
WHERE `hook_event`.id = x.id AND `hook_event`.cwd <> x.trimmed;
--> statement-breakpoint
UPDATE `ingest_cursor` SET carry_state_json = NULL WHERE parser_id = 'codex.rollout' AND carry_state_json LIKE '%/Documents/Codex/%';
