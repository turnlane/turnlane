/**
 * シンク（phase0-plan 3.2、ADR 0004）。NormalizedEvent を自然キーで upsert し、カーソルを
 * 同じトランザクション（BEGIN IMMEDIATE）で保存する。代入だけを行い、加算しない
 * （例外: session の started_at は min、last_activity_at は max。どちらも冪等）。
 * 取り込み系テーブル（ai_*、ingest_cursor、hook_event）は同期対象ではないので mutate() を通さない。
 * 行は削除しない（元ファイルが消えても残す）。
 */
import type { Changes, Database, SQLQueryBindings } from "bun:sqlite";
import type {
  ClaudeLimitsEvent,
  Cursor,
  NormalizedEvent,
  ReadResult,
  StreamSpec,
} from "@turnlane/collectors";
import { type Clock, newId, toLocalDate } from "@turnlane/core";
import { redact } from "@turnlane/core/web";
import { cleanSubject } from "../derive/stored-subject.ts";

/**
 * 文を実行する。db.run は呼ぶたびに文を組み立て直すので、取り込みのようにイベントごとに同じ文を何度も実行するところでは
 * db.query の文のキャッシュを使う（チャンクの同期処理を短くする）
 */
function exec(db: Database, sql: string, params: SQLQueryBindings[] = []): Changes {
  return db.query<unknown, SQLQueryBindings[]>(sql).run(...params);
}

export interface SinkSource {
  id: string;
  tool: string;
  rootPath: string;
}

/** 利用枠の記録先（limits/claude.ts の ClaudeLimitsStore） */
export interface ClaudeLimitsSink {
  recordFetched(
    account: string,
    v: {
      fiveHour?: { usedPercentage: number; resetsAt: number };
      sevenDay?: { usedPercentage: number; resetsAt: number };
    },
    fetchedAt: number,
  ): boolean;
}

export interface SinkContext {
  db: Database;
  /** 利用枠の記録先（`.claude.json` のキャッシュ。claude_limits のイベント）。省略は捨てる */
  limits?: ClaudeLimitsSink;
  clock: Clock;
  tz: string;
  dayBoundary: number;
  /** 自分の指示の 1 行目を保存する（設定 turn.store_detail。ADR 0018）。省略は保存しない */
  storeDetail?: boolean;
}

export interface SinkResult {
  /** 変化した ai_session.id */
  sessions: Set<string>;
  hooks: number;
}

interface CursorRow {
  dev: number | null;
  inode: number | null;
  size: number | null;
  mtime_ms: number | null;
  byte_offset: number;
  carry_state_json: string | null;
  parser_version: number;
  stream_key: string;
}

export function loadCursor(db: Database, sourceId: string, key: string): CursorRow | null {
  return db
    .query<CursorRow, [string, string]>(
      "SELECT dev, inode, size, mtime_ms, byte_offset, carry_state_json, parser_version, stream_key FROM ingest_cursor WHERE source_id = ? AND stream_key = ?",
    )
    .get(sourceId, key);
}

export function toCursor(row: CursorRow | null, parserVersion: number): Cursor | null {
  if (!row || row.parser_version !== parserVersion) return null;
  let carry: unknown;
  try {
    carry = row.carry_state_json ? JSON.parse(row.carry_state_json) : undefined;
  } catch {
    return null;
  }
  return {
    ...(row.dev !== null ? { dev: row.dev } : {}),
    ...(row.inode !== null ? { inode: row.inode } : {}),
    ...(row.size !== null ? { size: row.size } : {}),
    ...(row.mtime_ms !== null ? { mtimeMs: row.mtime_ms } : {}),
    byteOffset: row.byte_offset,
    ...(carry !== undefined ? { carry } : {}),
    parserVersion,
  };
}

type Row = Record<string, string | number | null>;

function sessionId(db: Database, tool: string, externalId: string): string | null {
  return (
    db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM ai_session WHERE tool = ? AND external_id = ?",
      )
      .get(tool, externalId)?.id ?? null
  );
}

/** セッションの行を確保する（無ければ最小の行を作る）。返り値は ai_session.id */
function ensureSession(
  ctx: SinkContext,
  source: SinkSource,
  tool: string,
  externalId: string,
  at: number,
): string {
  const found = sessionId(ctx.db, tool, externalId);
  if (found) return found;
  const id = newId(ctx.clock);
  const now = ctx.clock.now();
  exec(
    ctx.db,
    "INSERT INTO ai_session (id, source_id, tool, external_id, started_at, last_activity_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, source.id, tool, externalId, at, at, now, now],
  );
  return id;
}

function update(
  db: Database,
  table: string,
  where: string,
  args: (string | number)[],
  set: Row,
): void {
  const keys = Object.keys(set);
  if (keys.length === 0) return;
  exec(db, `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE ${where}`, [
    ...keys.map((k) => set[k] ?? null),
    ...args,
  ]);
}

const b = (v: boolean | undefined) => (v === undefined ? undefined : v ? 1 : 0);

function compact(o: Record<string, string | number | null | undefined>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

function applyEvent(
  ctx: SinkContext,
  source: SinkSource,
  e: NormalizedEvent,
  spoolStream: string | null,
  repoRoots: Map<string, string | null>,
  res: SinkResult,
): void {
  const now = ctx.clock.now();
  switch (e.kind) {
    case "session_seen": {
      const id = ensureSession(ctx, source, e.ref.tool, e.ref.externalId, e.startedAt ?? e.at);
      const parentId = e.parent
        ? ensureSession(ctx, source, e.parent.tool, e.parent.externalId, e.startedAt ?? e.at)
        : undefined;
      const repo = repoRoots.get(`${e.ref.tool}:${e.ref.externalId}`);
      update(ctx.db, "ai_session", "id = ?", [id], {
        // 終わった時刻（サブエージェント）。null は「終わった後にまた活動があった」なので消す（代入だけ）
        ...(e.endedAt !== undefined ? { ended_at: e.endedAt } : {}),
        ...compact({
          parent_session_id: parentId,
          is_subagent: b(e.isSubagent),
          entrypoint: e.entrypoint,
          client_version: e.clientVersion,
          model: e.model,
          cwd: e.cwd,
          repo_root: repo ?? undefined,
          title: e.title,
          title_source: e.titleSource,
          archived: b(e.archived),
          has_human_input: b(e.hasHumanInput),
          is_noise: b(e.noise),
          file_path: e.filePath,
          // 報告（ADR 0021）: プロジェクトの名前と開く先。来たときだけ代入する（省略は前の値のまま）
          project_name: e.project,
          open_url: e.openUrl,
        }),
        updated_at: now,
      });
      exec(
        ctx.db,
        "UPDATE ai_session SET started_at = MIN(started_at, ?), last_activity_at = MAX(last_activity_at, ?), transcript_missing_at = CASE WHEN ? IS NOT NULL AND file_path = ? THEN NULL ELSE transcript_missing_at END WHERE id = ?",
        [e.startedAt ?? e.at, e.at, e.filePath ?? null, e.filePath ?? null, id],
      );
      res.sessions.add(id);
      return;
    }
    case "turn": {
      const sid = ensureSession(ctx, source, e.ref.tool, e.ref.externalId, e.startedAt);
      const values = {
        started_at: e.startedAt,
        ended_at: e.endedAt ?? null,
        duration_ms: e.durationMs ?? null,
        local_date: toLocalDate(e.startedAt, ctx.tz, ctx.dayBoundary),
        status: e.status,
        ended_with: e.endedWith ?? null,
        initiator: e.initiator ?? null,
        git_branch: e.gitBranch ?? null,
        cwd: e.cwd ?? null,
        input_tokens: e.tokens?.input ?? null,
        output_tokens: e.tokens?.output ?? null,
        cache_read_tokens: e.tokens?.cacheRead ?? null,
        tool_counts_json: e.toolCounts ? JSON.stringify(e.toolCounts) : null,
        edited_files_count: e.editedFiles ?? 0,
        pending_question: e.pendingQuestion ? 1 : 0,
        closing_question: e.closingQuestion ? 1 : 0,
      };
      const cols = Object.keys(values);
      exec(
        ctx.db,
        `INSERT INTO ai_turn (id, session_id, turn_key, ${cols.join(", ")}, created_at, updated_at)
         VALUES (?, ?, ?, ${cols.map(() => "?").join(", ")}, ?, ?)
         ON CONFLICT (session_id, turn_key) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_at = excluded.updated_at`,
        [newId(ctx.clock), sid, e.turnKey, ...Object.values(values), now, now],
      );
      // 自分の指示の 1 行目（ADR 0018）: 伏せ字を通してから持つ。同じターンは上書き（代入だけ）
      // 相づちだけ・貼り付けの印だけの指示は持たない（題名の掃除と同じ cleanTitle。ai-session-ingestion 4.4）
      const instruction = cleanSubject(e.instruction);
      if (instruction && ctx.storeDetail) {
        const turnId = ctx.db
          .query<{ id: string }, [string, string]>(
            "SELECT id FROM ai_turn WHERE session_id = ? AND turn_key = ?",
          )
          .get(sid, e.turnKey)?.id;
        if (turnId) {
          const r = redact(instruction);
          exec(
            ctx.db,
            `INSERT INTO ai_instruction (turn_id, session_id, at, text, masked) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (turn_id) DO UPDATE SET text = excluded.text, masked = excluded.masked, at = excluded.at`,
            [turnId, sid, e.startedAt, r.text, r.masked ? 1 : 0],
          );
        }
      }
      // 報告で新しいターンを始めた（ADR 0021）: 同じセッションの、このターンより前に始まった開いたターンを閉じる
      // （別の日の spool に続きが来たとき。代入だけなので読み直しても同じ）
      if (e.closeOpen) {
        exec(
          ctx.db,
          `UPDATE ai_turn SET status = 'completed', ended_at = ?, ended_with = COALESCE(ended_with, 'end_turn'),
             pending_question = 0, updated_at = ?
           WHERE session_id = ? AND turn_key <> ? AND ended_at IS NULL AND started_at <= ?`,
          [e.startedAt, now, sid, e.turnKey, e.startedAt],
        );
      }
      // 報告のターンが、同じセッションの後のターンより前に開いたまま書かれた（古い spool を後から読み直した）: 後のターンの
      // 始まりで閉じる（読む順によらず同じ結果）
      if (e.initiator === "system" && e.endedAt === undefined) {
        exec(
          ctx.db,
          `UPDATE ai_turn SET status = 'completed', ended_with = COALESCE(ended_with, 'end_turn'), pending_question = 0,
             ended_at = (SELECT MIN(n.started_at) FROM ai_turn n WHERE n.session_id = ai_turn.session_id AND n.started_at > ai_turn.started_at)
           WHERE session_id = ? AND turn_key = ? AND ended_at IS NULL
             AND EXISTS (SELECT 1 FROM ai_turn n WHERE n.session_id = ai_turn.session_id AND n.started_at > ai_turn.started_at)
             AND EXISTS (SELECT 1 FROM ai_session x WHERE x.id = ai_turn.session_id AND x.entrypoint = 'report')`,
          [sid, e.turnKey],
        );
      }
      // 報告の待ちの中身（ADR 0021。ADR 0018 の上限は collectors の report.ts で切ってある）: 伏せ字を通して持つ
      if (e.reportWait && ctx.storeDetail) {
        let masked = false;
        const m = (x: string) => {
          const r = redact(x);
          if (r.masked) masked = true;
          return r.text;
        };
        const w = e.reportWait;
        const json = {
          kind: w.kind,
          text: m(w.text),
          ...(w.options ? { options: w.options.map(m) } : {}),
          ...(w.label ? { label: m(w.label) } : {}),
        };
        exec(ctx.db, "UPDATE ai_turn SET wait_json = ? WHERE session_id = ? AND turn_key = ?", [
          JSON.stringify({ ...json, masked }),
          sid,
          e.turnKey,
        ]);
      }
      // ターン内の最後の活動を session の last_activity_at に反映する（running の鮮度に使う）
      const last = e.lastActivityAt ?? e.endedAt ?? e.startedAt;
      exec(
        ctx.db,
        "UPDATE ai_session SET last_activity_at = MAX(last_activity_at, ?), started_at = MIN(started_at, ?) WHERE id = ?",
        [last, e.startedAt, sid],
      );
      res.sessions.add(sid);
      return;
    }
    case "artifact": {
      const sid = ensureSession(ctx, source, e.ref.tool, e.ref.externalId, e.at);
      const turnId = e.turnKey
        ? (ctx.db
            .query<{ id: string }, [string, string]>(
              "SELECT id FROM ai_turn WHERE session_id = ? AND turn_key = ?",
            )
            .get(sid, e.turnKey)?.id ?? null)
        : null;
      const a = e.artifact;
      const ref = a.kind === "pr" ? `${a.repo}#${a.number}` : a.sha;
      const url = a.kind === "pr" ? (a.url ?? null) : null;
      exec(
        ctx.db,
        `INSERT INTO ai_artifact (id, kind, ref, session_id, turn_id, url, state, first_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?)
         ON CONFLICT (kind, ref) DO UPDATE SET
           first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
           session_id = COALESCE(session_id, excluded.session_id),
           turn_id = COALESCE(turn_id, excluded.turn_id),
           url = COALESCE(url, excluded.url)`,
        [newId(ctx.clock), a.kind, ref, sid, turnId, url, e.at, now, now],
      );
      res.sessions.add(sid);
      return;
    }
    case "live_status": {
      const sid = sessionId(ctx.db, e.ref.tool, e.ref.externalId);
      if (!sid) return;
      exec(
        ctx.db,
        "UPDATE ai_session SET live_status = ?, live_pid = ?, live_checked_at = ? WHERE id = ?",
        [e.status, e.pid ?? null, now, sid],
      );
      res.sessions.add(sid);
      return;
    }
    case "claude_limits": {
      applyClaudeLimits(ctx, e);
      return;
    }
    case "hook": {
      const r = exec(
        ctx.db,
        `INSERT INTO hook_event (id, tool, config_root, hook_event_name, session_external_id, turn_id, prompt_id,
           notification_type, tool_name, error_type, source, reason, cwd, term_handle, agent_id, agent_type, permission_mode,
           quota_horizon, occurred_at, spool_file, spool_offset, created_at, pid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (spool_file, spool_offset) DO NOTHING`,
        [
          newId(ctx.clock),
          e.ref.tool,
          e.configRoot ?? null,
          e.name,
          e.ref.externalId,
          e.turnId ?? null,
          e.promptId ?? null,
          e.notificationType ?? null,
          e.toolName ?? null,
          e.errorType ?? null,
          e.source ?? null,
          e.reason ?? null,
          e.cwd ?? null,
          e.term ?? null,
          e.agentId ?? null,
          e.agentType ?? null,
          e.permissionMode ?? null,
          e.horizon === true ? 1 : null,
          e.at,
          spoolStream ?? e.spool.file,
          e.spool.offset,
          now,
          e.pid ?? null,
        ],
      );
      if (r.changes > 0) res.hooks++;
      if (e.configRoot) {
        exec(
          ctx.db,
          "UPDATE ai_source SET last_hook_at = MAX(COALESCE(last_hook_at, 0), ?), updated_at = ? WHERE tool = ? AND root_path = ?",
          [e.at, now, e.ref.tool, e.configRoot],
        );
      }
      const sid = sessionId(ctx.db, e.ref.tool, e.ref.externalId);
      if (sid) res.sessions.add(sid);
      return;
    }
  }
}

/**
 * `.claude.json` の利用枠のキャッシュ（live probe の claude_limits）を利用枠の記録先へ。持っている値より新しく取得した
 * ものだけを記録する（statusLine の受け口から届いた新しい値を古いキャッシュで上書きしない）。記録したら true
 */
export function applyClaudeLimits(ctx: SinkContext, e: ClaudeLimitsEvent): boolean {
  if (!ctx.limits) return false;
  const w = (x: ClaudeLimitsEvent["fiveHour"]) =>
    x ? { usedPercentage: x.pct, resetsAt: x.resetsAt } : undefined;
  const fiveHour = w(e.fiveHour);
  const sevenDay = w(e.sevenDay);
  return ctx.limits.recordFetched(
    e.account,
    { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) },
    e.fetchedAt,
  );
}

/**
 * 1回の read の結果を反映する。イベントの upsert とカーソルの保存を1トランザクションで行う。
 * result.missing なら元ファイルの消失として transcript_missing_at を記録する（行は消さない）。
 */
export function applyRead(
  ctx: SinkContext,
  source: SinkSource,
  stream: StreamSpec,
  parser: { id: string; version: number },
  result: ReadResult,
  repoRoots: Map<string, string | null> = new Map(),
): SinkResult {
  const res: SinkResult = { sessions: new Set(), hooks: 0 };
  const now = ctx.clock.now();
  // ai_session.file_path は「ルート + キー」で持つ（実際のパスではない）。アダプタはキーから利用者の会話の派生物
  // （Claude Code の Codex の作業フォルダの名前など）を落としているので、DB にはそれだけが残る（D-136）
  const filePath = `${source.rootPath}/${stream.key}`;
  ctx.db
    .transaction(() => {
      if (result.missing) {
        exec(
          ctx.db,
          "UPDATE ai_session SET transcript_missing_at = ? WHERE file_path = ? AND transcript_missing_at IS NULL",
          [now, filePath],
        );
        return;
      }
      const spoolStream = source.tool === "hook_spool" ? stream.key : null;
      // artifact はターンの行ができてから反映する（turn_id を引けるように）
      const order = (e: NormalizedEvent) => (e.kind === "artifact" ? 1 : 0);
      const events = [...result.events]
        .sort((a, b) => order(a) - order(b))
        .map((e) =>
          e.kind === "session_seen" && e.filePath !== undefined ? { ...e, filePath } : e,
        );
      for (const e of events) applyEvent(ctx, source, e, spoolStream, repoRoots, res);
      const n = result.next;
      const reset = n.byteOffset < (loadCursor(ctx.db, source.id, stream.key)?.byte_offset ?? 0);
      exec(
        ctx.db,
        `INSERT INTO ingest_cursor (source_id, stream_key, kind, dev, inode, size, mtime_ms, byte_offset, watermark,
           carry_state_json, parser_id, parser_version, records_ok, records_skipped, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT (source_id, stream_key) DO UPDATE SET
           kind = excluded.kind, dev = excluded.dev, inode = excluded.inode, size = excluded.size,
           mtime_ms = excluded.mtime_ms, byte_offset = excluded.byte_offset, watermark = excluded.watermark,
           carry_state_json = excluded.carry_state_json, parser_id = excluded.parser_id,
           parser_version = excluded.parser_version,
           records_ok = CASE WHEN ? THEN excluded.records_ok ELSE records_ok + excluded.records_ok END,
           records_skipped = CASE WHEN ? THEN excluded.records_skipped ELSE records_skipped + excluded.records_skipped END,
           last_error = NULL, updated_at = excluded.updated_at`,
        [
          source.id,
          stream.key,
          stream.kind,
          n.dev ?? null,
          n.inode ?? null,
          n.size ?? null,
          n.mtimeMs ?? null,
          n.byteOffset,
          n.watermark ?? null,
          n.carry === undefined ? null : JSON.stringify(n.carry),
          parser.id,
          parser.version,
          result.stats.records,
          result.stats.skipped,
          now,
          reset ? 1 : 0,
          reset ? 1 : 0,
        ],
      );
      exec(ctx.db, "UPDATE ai_source SET last_ingest_at = ? WHERE id = ?", [now, source.id]);
    })
    .immediate();
  return res;
}

/** 取り込みに失敗したストリームのエラーを記録する（本文を含めない: エラー名だけ） */
export function recordCursorError(
  db: Database,
  sourceId: string,
  key: string,
  error: string,
): void {
  exec(db, "UPDATE ingest_cursor SET last_error = ? WHERE source_id = ? AND stream_key = ?", [
    error.slice(0, 200),
    sourceId,
    key,
  ]);
}

/** ライブ状態の一括反映: 今回の probe に無い busy / idle のセッションは gone にする */
export function applyLiveSweep(
  ctx: SinkContext,
  source: SinkSource,
  seen: Set<string>,
): Set<string> {
  const changed = new Set<string>();
  const rows = ctx.db
    .query<{ id: string; external_id: string }, [string]>(
      "SELECT id, external_id FROM ai_session WHERE source_id = ? AND live_status IN ('busy', 'idle')",
    )
    .all(source.id);
  for (const r of rows) {
    if (seen.has(r.external_id)) continue;
    exec(ctx.db, "UPDATE ai_session SET live_status = 'gone', live_checked_at = ? WHERE id = ?", [
      ctx.clock.now(),
      r.id,
    ]);
    changed.add(r.id);
  }
  return changed;
}
