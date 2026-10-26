-- 0013（D-136 の残り）: Claude Code を Codex の作業フォルダ（`~/Documents/Codex/<日付>/<最初の依頼から作った名前>`）で
-- 動かしたセッションの、トランスクリプトの置き場所 `projects/<cwd を符号化した名前>/…` に残るフォルダ名を落とす。
-- 取り込みでは collectors の trimClaudeProjectPath が同じ規則で落とす（最初の `-Documents-Codex-` から後を、直後の
-- 日付 `-YYYY-MM-DD` だけ残して落とす）。drizzle-kit の custom（データだけ）:
-- - ai_session.file_path: 符号化した名前の1段を切り落とす。q = '/projects/-' の位置、dir = その次の1段、
--   p = dir の中の '-Documents-Codex-' の位置、after = '-Documents-Codex' の後ろ（'-' で始まる）
-- - ingest_cursor: キー（stream_key）と継続状態（carry_state_json の cwd）にフォルダ名が残るので行を消す（途中で
--   Codex の作業フォルダへ移ったセッションの継続状態も）。次の走査で切り落としたキーで先頭から読み直す（取り込みは
--   upsert なので重複しない。まとめての取り込みとして通知しない）
UPDATE `ai_session` SET file_path = x.trimmed
FROM (
  SELECT id,
    substr(file_path, 1, q + 9)
      || substr(dir, 1, p + 15)
      || CASE WHEN substr(after, 2, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
              AND (length(after) = 11 OR substr(after, 12, 1) = '-')
         THEN substr(after, 1, 11) ELSE '' END
      || tail AS trimmed
  FROM (
    SELECT id, file_path, q, dir, tail, instr(dir, '-Documents-Codex-') AS p,
      substr(dir, instr(dir, '-Documents-Codex-') + 16) AS after
    FROM (
      SELECT id, file_path, q,
        CASE WHEN instr(rest, '/') > 0 THEN substr(rest, 1, instr(rest, '/') - 1) ELSE rest END AS dir,
        CASE WHEN instr(rest, '/') > 0 THEN substr(rest, instr(rest, '/')) ELSE '' END AS tail
      FROM (
        SELECT id, file_path, instr(file_path, '/projects/-') AS q,
          substr(file_path, instr(file_path, '/projects/-') + 10) AS rest
        FROM `ai_session`
        WHERE tool = 'claude_code' AND file_path LIKE '%/projects/-%-Documents-Codex-%'
      )
    )
  )
  WHERE p > 0
) AS x
WHERE `ai_session`.id = x.id AND `ai_session`.file_path <> x.trimmed;
--> statement-breakpoint
DELETE FROM `ingest_cursor`
WHERE parser_id = 'claude_code.transcript'
  AND (stream_key LIKE 'projects/%-Documents-Codex-%' OR carry_state_json LIKE '%/Documents/Codex/%');
