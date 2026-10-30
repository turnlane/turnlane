/**
 * Drizzle スキーマ（正）。phase0-plan 2.3 の DDL をそのまま写したもの。
 * 変更したら `bun run --cwd packages/core db:generate` でマイグレーション SQL を生成し、
 * test/schema.test.ts のスナップショットと DDL 照合を更新する。
 *
 * - 主キーは UUIDv7 の TEXT（例外: setting.key、ingest_cursor の複合キー、change_log.seq）
 * - 時刻は UTC の epoch ms（INTEGER）、論理日付は 'YYYY-MM-DD'
 * - 真偽値は 0/1 の INTEGER（CHECK 付き）
 * - ビュー work_item_daily は手書きの SQL マイグレーション（0001）で作る
 */
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const bool01 = (col: string) => sql.raw(`${col} IN (0, 1)`);
const syncScope = (dflt: "synced" | "local_only") =>
  text("sync_scope", { enum: ["synced", "local_only"] })
    .notNull()
    .default(dflt);
const SYNC_SCOPE_CK = sql.raw("sync_scope IN ('synced', 'local_only')");
const TOOL_ID_CK = sql.raw("length(tool) BETWEEN 2 AND 32 AND tool NOT GLOB '*[^a-z0-9_]*'");

// ---------- 端末・設定 ----------
export const device = sqliteTable(
  "device",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    isSelf: integer("is_self").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check("device_is_self_ck", bool01("is_self")),
    uniqueIndex("device_self_uq").on(t.isSelf).where(sql`is_self = 1`),
  ],
);

export const setting = sqliteTable(
  "setting",
  {
    key: text("key").primaryKey(),
    valueJson: text("value_json").notNull(),
    updatedAt: integer("updated_at").notNull(),
    hlc: text("hlc").notNull(),
    deviceId: text("device_id").notNull(),
    syncScope: syncScope("local_only"),
  },
  () => [check("setting_sync_scope_ck", SYNC_SCOPE_CK)],
);

// ---------- プロジェクト ----------
export const project = sqliteTable(
  "project",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    color: text("color"),
    repoPathsJson: text("repo_paths_json").notNull().default("[]"),
    archivedAt: integer("archived_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    hlc: text("hlc").notNull(),
    deviceId: text("device_id").notNull(),
    deletedAt: integer("deleted_at"),
    syncScope: syncScope("synced"),
    // 0010（D-107・M5-B）: AI に頼むときの worktree の既定（NULL = git のリポジトリなら使う。D-110 (5)）、
    // worktree にコピーする追跡外のファイル（glob の JSON 配列）、確認支援のテストのコマンド（空なら出さない）
    worktreeDefault: integer("worktree_default"),
    worktreeCopyGlobsJson: text("worktree_copy_globs_json").notNull().default("[]"),
    testCommand: text("test_command"),
  },
  (t) => [
    check("project_sync_scope_ck", SYNC_SCOPE_CK),
    uniqueIndex("project_name_uq").on(t.name).where(sql`deleted_at IS NULL`),
  ],
);

// ---------- タスク ----------
export const TASK_STATUSES = ["todo", "doing", "done", "canceled", "someday"] as const;
export const TASK_SOURCES = ["manual", "cli", "mcp", "ai", "calendar"] as const;

export const task = sqliteTable(
  "task",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    notesMd: text("notes_md"),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("todo"),
    scheduledDate: text("scheduled_date"),
    laneOrder: text("lane_order").notNull(),
    dueDate: text("due_date"),
    estimateMin: integer("estimate_min"),
    priority: integer("priority").notNull().default(0),
    projectId: text("project_id").references(() => project.id),
    source: text("source", { enum: TASK_SOURCES }).notNull(),
    sourceRef: text("source_ref"),
    externalSource: text("external_source"),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    rolloverCount: integer("rollover_count").notNull().default(0),
    isHighlight: integer("is_highlight").notNull().default(0),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    autoCompleted: integer("auto_completed").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    hlc: text("hlc").notNull(),
    deviceId: text("device_id").notNull(),
    deletedAt: integer("deleted_at"),
    syncScope: syncScope("synced"),
    // 自動生成の題名（D-046）。種類とパラメータ（JSON）を保存し、表示時に i18n で組み立てる（core/i18n/task-title.ts）
    titleKey: text("title_key"),
    titleParams: text("title_params"),
  },
  (t) => [
    check("task_status_ck", sql.raw("status IN ('todo', 'doing', 'done', 'canceled', 'someday')")),
    check("task_estimate_ck", sql.raw("estimate_min IS NULL OR estimate_min >= 0")),
    check("task_priority_ck", sql.raw("priority BETWEEN 0 AND 3")),
    check("task_source_ck", sql.raw("source IN ('manual', 'cli', 'mcp', 'ai', 'calendar')")),
    check(
      "task_external_source_ck",
      sql.raw(
        "external_source IS NULL OR (length(external_source) BETWEEN 1 AND 64 AND external_source NOT GLOB '*[^a-z0-9._-]*')",
      ),
    ),
    check(
      "task_external_id_ck",
      sql.raw("external_id IS NULL OR length(external_id) BETWEEN 1 AND 256"),
    ),
    check("task_is_highlight_ck", bool01("is_highlight")),
    check("task_auto_completed_ck", bool01("auto_completed")),
    check("task_sync_scope_ck", SYNC_SCOPE_CK),
    check("task_external_pair_ck", sql.raw("(external_source IS NULL) = (external_id IS NULL)")),
    // 論理削除した行も含めて一意にする（ユーザーが消したタスクを同じ external_id で作り直さないため）
    uniqueIndex("task_external_uq")
      .on(t.externalSource, t.externalId)
      .where(sql`external_source IS NOT NULL`),
    index("task_lane_idx").on(t.scheduledDate, t.laneOrder).where(sql`deleted_at IS NULL`),
    index("task_inbox_idx")
      .on(t.createdAt)
      .where(sql`scheduled_date IS NULL AND deleted_at IS NULL AND status IN ('todo', 'doing')`),
    index("task_project_idx").on(t.projectId).where(sql`deleted_at IS NULL`),
    index("task_done_idx").on(t.completedAt).where(sql`completed_at IS NOT NULL`),
  ],
);

export const taskTimeEntry = sqliteTable(
  "task_time_entry",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => task.id),
    startAt: integer("start_at").notNull(),
    endAt: integer("end_at"),
    source: text("source", { enum: ["tap", "followup_estimate", "timeblock_assumed"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    hlc: text("hlc").notNull(),
    deviceId: text("device_id").notNull(),
    deletedAt: integer("deleted_at"),
    syncScope: syncScope("synced"),
  },
  (t) => [
    check("tte_source_ck", sql.raw("source IN ('tap', 'followup_estimate', 'timeblock_assumed')")),
    check("tte_sync_scope_ck", SYNC_SCOPE_CK),
    check("tte_range_ck", sql.raw("end_at IS NULL OR end_at >= start_at")),
    index("tte_task_idx").on(t.taskId).where(sql`deleted_at IS NULL`),
    index("tte_start_idx").on(t.startAt).where(sql`deleted_at IS NULL`),
  ],
);

// ---------- カレンダー ----------
export const calendar = sqliteTable(
  "calendar",
  {
    id: text("id").primaryKey(),
    provider: text("provider", { enum: ["eventkit"] })
      .notNull()
      .default("eventkit"),
    externalId: text("external_id").notNull(),
    accountName: text("account_name"),
    name: text("name").notNull(),
    color: text("color"),
    /**
     * Turnlane の中だけで選んだ色（D-125。パレットのキー。null ならカレンダーアプリの色 color に従う）。
     * カレンダーアプリ・Google 側の色は書き換えない。キーの一覧は calendar-colors.ts、値はテーマごとに web のトークン
     */
    colorKey: text("color_key"),
    isWritable: integer("is_writable").notNull().default(0),
    role: text("role", { enum: ["source", "writeback", "ignored"] })
      .notNull()
      .default("source"),
    lastSyncedAt: integer("last_synced_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check("calendar_provider_ck", sql.raw("provider IN ('eventkit')")),
    check("calendar_is_writable_ck", bool01("is_writable")),
    check("calendar_role_ck", sql.raw("role IN ('source', 'writeback', 'ignored')")),
    uniqueIndex("calendar_ext_uq").on(t.provider, t.externalId),
    uniqueIndex("calendar_writeback_uq").on(t.role).where(sql`role = 'writeback'`),
  ],
);

export const calendarEvent = sqliteTable(
  "calendar_event",
  {
    id: text("id").primaryKey(),
    calendarId: text("calendar_id")
      .notNull()
      .references(() => calendar.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    occurrenceStart: integer("occurrence_start").notNull(),
    title: text("title"),
    location: text("location"),
    startAt: integer("start_at").notNull(),
    endAt: integer("end_at").notNull(),
    tz: text("tz"),
    allDay: integer("all_day").notNull().default(0),
    startDate: text("start_date"),
    endDate: text("end_date"),
    status: text("status", { enum: ["confirmed", "tentative", "cancelled"] }),
    availability: text("availability", { enum: ["busy", "free", "tentative", "unavailable"] }),
    selfResponse: text("self_response", {
      enum: ["accepted", "declined", "tentative", "pending", "unknown"],
    }),
    conferenceUrl: text("conference_url"),
    extUpdatedAt: integer("ext_updated_at"),
    isOwnTimeblock: integer("is_own_timeblock").notNull().default(0),
    /** Turnlane が書き戻した予定の時間ブロック（url = dayline://timeblock/<id> から。M3-3）。外部キーは張らない */
    ownTimeblockId: text("own_timeblock_id"),
    fetchedAt: integer("fetched_at").notNull(),
    /** EKEvent.eventIdentifier（予定の更新・削除に使う。0007、D-093） */
    eventId: text("event_id"),
    /** 参加者がいる。NULL = 分からない（0.4.0 より前のヘルパ。編集しない）。0007、D-093 */
    hasAttendees: integer("has_attendees"),
    /** 繰り返しの予定の各回。0007 */
    recurring: integer("recurring"),
    /** Turnlane が作った予定（url = turnlane://event/<uuid>）。0007 */
    isOwnEvent: integer("is_own_event").notNull().default(0),
    /** 会議リンクがある（集中モードの対象。D-097）。NULL = まだ分からない。0008 */
    hasMeetingLink: integer("has_meeting_link"),
  },
  (t) => [
    check("cal_event_all_day_ck", bool01("all_day")),
    check("cal_event_status_ck", sql.raw("status IN ('confirmed', 'tentative', 'cancelled')")),
    check(
      "cal_event_availability_ck",
      sql.raw("availability IN ('busy', 'free', 'tentative', 'unavailable')"),
    ),
    check(
      "cal_event_self_response_ck",
      sql.raw("self_response IN ('accepted', 'declined', 'tentative', 'pending', 'unknown')"),
    ),
    check("cal_event_is_own_timeblock_ck", bool01("is_own_timeblock")),
    uniqueIndex("cal_event_uq").on(t.calendarId, t.externalId, t.occurrenceStart),
    index("cal_event_range_idx").on(t.startAt, t.endAt),
  ],
);

// ---------- 時間ブロック ----------
export const timeBlock = sqliteTable(
  "time_block",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").references(() => task.id),
    title: text("title"),
    startAt: integer("start_at").notNull(),
    endAt: integer("end_at").notNull(),
    tz: text("tz").notNull(),
    writebackProvider: text("writeback_provider", { enum: ["eventkit"] }),
    writebackCalendarId: text("writeback_calendar_id").references(() => calendar.id),
    externalEventId: text("external_event_id"),
    externalUpdatedAt: integer("external_updated_at"),
    writebackState: text("writeback_state", {
      enum: ["pending", "synced", "conflict", "error", "disabled"],
    })
      .notNull()
      .default("pending"),
    writebackError: text("writeback_error"),
    writebackAttempts: integer("writeback_attempts").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    hlc: text("hlc").notNull(),
    deviceId: text("device_id").notNull(),
    deletedAt: integer("deleted_at"),
    syncScope: syncScope("synced"),
  },
  (t) => [
    check("time_block_wb_provider_ck", sql.raw("writeback_provider IN ('eventkit')")),
    check(
      "time_block_wb_state_ck",
      sql.raw("writeback_state IN ('pending', 'synced', 'conflict', 'error', 'disabled')"),
    ),
    check("time_block_sync_scope_ck", SYNC_SCOPE_CK),
    check("time_block_range_ck", sql.raw("end_at > start_at")),
    index("time_block_range_idx").on(t.startAt, t.endAt).where(sql`deleted_at IS NULL`),
    index("time_block_task_idx").on(t.taskId),
    index("time_block_wb_idx")
      .on(t.writebackState)
      .where(sql`writeback_state IN ('pending', 'error')`),
  ],
);

// ---------- AI 取り込み元 ----------
export const aiSource = sqliteTable(
  "ai_source",
  {
    id: text("id").primaryKey(),
    tool: text("tool").notNull(),
    rootPath: text("root_path").notNull(),
    profileLabel: text("profile_label"),
    enabled: integer("enabled").notNull().default(1),
    hooksState: text("hooks_state", {
      enum: ["none", "installed", "pending_trust", "receiving", "silent"],
    })
      .notNull()
      .default("none"),
    includeGlobsJson: text("include_globs_json").notNull().default("[]"),
    excludeGlobsJson: text("exclude_globs_json").notNull().default("[]"),
    healthLevel: text("health_level", { enum: ["L0", "L1", "L2", "L3"] })
      .notNull()
      .default("L0"),
    healthReason: text("health_reason"),
    detectedVersion: text("detected_version"),
    lastIngestAt: integer("last_ingest_at"),
    lastHookAt: integer("last_hook_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check(
      "ai_source_tool_ck",
      sql.raw(
        "length(tool) BETWEEN 2 AND 32 AND tool GLOB '[a-z]*' AND tool NOT GLOB '*[^a-z0-9_]*'",
      ),
    ),
    check("ai_source_enabled_ck", bool01("enabled")),
    check(
      "ai_source_hooks_state_ck",
      sql.raw("hooks_state IN ('none', 'installed', 'pending_trust', 'receiving', 'silent')"),
    ),
    check("ai_source_health_level_ck", sql.raw("health_level IN ('L0', 'L1', 'L2', 'L3')")),
    uniqueIndex("ai_source_uq").on(t.tool, t.rootPath),
  ],
);

export const ingestCursor = sqliteTable(
  "ingest_cursor",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => aiSource.id, { onDelete: "cascade" }),
    streamKey: text("stream_key").notNull(),
    kind: text("kind", { enum: ["jsonl", "json_snapshot", "sqlite"] }).notNull(),
    dev: integer("dev"),
    inode: integer("inode"),
    size: integer("size"),
    mtimeMs: integer("mtime_ms"),
    byteOffset: integer("byte_offset").notNull().default(0),
    watermark: text("watermark"),
    carryStateJson: text("carry_state_json"),
    parserId: text("parser_id").notNull(),
    parserVersion: integer("parser_version").notNull(),
    recordsOk: integer("records_ok").notNull().default(0),
    recordsSkipped: integer("records_skipped").notNull().default(0),
    lastError: text("last_error"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.streamKey] }),
    check("ingest_cursor_kind_ck", sql.raw("kind IN ('jsonl', 'json_snapshot', 'sqlite')")),
  ],
);

// ---------- WorkItem（AIカード） ----------
export const WORK_ITEM_STATUSES = ["running", "needs_input", "your_turn", "done", "error"] as const;
const WORK_ITEM_STATUS_CK = sql.raw(
  "status IN ('running', 'needs_input', 'your_turn', 'done', 'error')",
);

export const workItem = sqliteTable(
  "work_item",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => project.id),
    groupKey: text("group_key").notNull(),
    repoRoot: text("repo_root"),
    branch: text("branch"),
    prRef: text("pr_ref"),
    titleAuto: text("title_auto"),
    titleSource: text("title_source", {
      enum: ["pr", "ai_title", "thread_name", "desktop_title", "branch", "session_name", "repo"],
    }),
    titleUser: text("title_user"),
    status: text("status", { enum: WORK_ITEM_STATUSES }).notNull(),
    statusReason: text("status_reason"),
    statusEstimated: integer("status_estimated").notNull().default(0),
    statusChangedAt: integer("status_changed_at").notNull(),
    manualDoneAt: integer("manual_done_at"),
    mergedIntoId: text("merged_into_id").references((): AnySQLiteColumn => workItem.id),
    hiddenAt: integer("hidden_at"),
    // 0012（D-135）: 壁打ち（プロジェクトに属さない会話）のカード。runner が作業フォルダから決める（core/scratch.ts）
    scratch: integer("scratch").notNull().default(0),
    toolsJson: text("tools_json").notNull().default("[]"),
    firstActivityAt: integer("first_activity_at").notNull(),
    lastActivityAt: integer("last_activity_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    hlc: text("hlc").notNull(),
    deviceId: text("device_id").notNull(),
    deletedAt: integer("deleted_at"),
    syncScope: syncScope("local_only"),
  },
  (t) => [
    check(
      "work_item_title_source_ck",
      sql.raw(
        "title_source IN ('pr', 'ai_title', 'thread_name', 'desktop_title', 'branch', 'session_name', 'repo')",
      ),
    ),
    check("work_item_status_ck", WORK_ITEM_STATUS_CK),
    check("work_item_status_estimated_ck", bool01("status_estimated")),
    check("work_item_sync_scope_ck", SYNC_SCOPE_CK),
    uniqueIndex("work_item_key_uq").on(t.groupKey).where(sql`deleted_at IS NULL`),
    index("work_item_open_idx")
      .on(t.status, t.lastActivityAt)
      .where(sql`deleted_at IS NULL AND status <> 'done'`),
    index("work_item_recent_idx").on(t.lastActivityAt),
  ],
);

export const workItemStatusLog = sqliteTable(
  "work_item_status_log",
  {
    id: text("id").primaryKey(),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => workItem.id, { onDelete: "cascade" }),
    status: text("status", { enum: WORK_ITEM_STATUSES }).notNull(),
    fromAt: integer("from_at").notNull(),
    toAt: integer("to_at"),
    reason: text("reason"),
  },
  (t) => [
    check("wisl_status_ck", WORK_ITEM_STATUS_CK),
    index("wisl_item_idx").on(t.workItemId, t.fromAt),
    index("wisl_open_idx").on(t.workItemId).where(sql`to_at IS NULL`),
  ],
);

// ---------- AI セッション / ターン / 成果物（local_only） ----------
export const aiSession = sqliteTable(
  "ai_session",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => aiSource.id),
    tool: text("tool").notNull(),
    externalId: text("external_id").notNull(),
    parentSessionId: text("parent_session_id").references((): AnySQLiteColumn => aiSession.id),
    isSubagent: integer("is_subagent").notNull().default(0),
    entrypoint: text("entrypoint"),
    clientVersion: text("client_version"),
    model: text("model"),
    cwd: text("cwd"),
    repoRoot: text("repo_root"),
    title: text("title"),
    titleSource: text("title_source"),
    startedAt: integer("started_at").notNull(),
    lastActivityAt: integer("last_activity_at").notNull(),
    endedAt: integer("ended_at"),
    liveStatus: text("live_status", { enum: ["busy", "idle", "gone"] }),
    livePid: integer("live_pid"),
    liveCheckedAt: integer("live_checked_at"),
    archived: integer("archived").notNull().default(0),
    hasHumanInput: integer("has_human_input").notNull().default(0),
    isNoise: integer("is_noise").notNull().default(0),
    filePath: text("file_path"),
    transcriptMissingAt: integer("transcript_missing_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check("ai_session_tool_ck", TOOL_ID_CK),
    check("ai_session_is_subagent_ck", bool01("is_subagent")),
    check("ai_session_live_status_ck", sql.raw("live_status IN ('busy', 'idle', 'gone')")),
    check("ai_session_archived_ck", bool01("archived")),
    check("ai_session_has_human_input_ck", bool01("has_human_input")),
    check("ai_session_is_noise_ck", bool01("is_noise")),
    uniqueIndex("ai_session_uq").on(t.tool, t.externalId),
    index("ai_session_repo_idx").on(t.repoRoot),
    index("ai_session_recent_idx").on(t.lastActivityAt),
    index("ai_session_parent_idx").on(t.parentSessionId).where(sql`parent_session_id IS NOT NULL`),
  ],
);

export const aiTurn = sqliteTable(
  "ai_turn",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => aiSession.id, { onDelete: "cascade" }),
    turnKey: text("turn_key").notNull(),
    workItemId: text("work_item_id").references(() => workItem.id),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    durationMs: integer("duration_ms"),
    localDate: text("local_date").notNull(),
    status: text("status", { enum: ["running", "completed", "interrupted", "error"] }).notNull(),
    endedWith: text("ended_with", {
      enum: ["end_turn", "question", "permission", "error", "aborted"],
    }),
    initiator: text("initiator", { enum: ["human", "queued", "scheduled", "system"] }),
    gitBranch: text("git_branch"),
    cwd: text("cwd"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    toolCountsJson: text("tool_counts_json"),
    editedFilesCount: integer("edited_files_count").notNull().default(0),
    pendingQuestion: integer("pending_question").notNull().default(0),
    // 0002（M1-9）: 締めの決まり文句の質問で終わった（3.3.1）
    closingQuestion: integer("closing_question").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check("ai_turn_closing_question_ck", bool01("closing_question")),
    check(
      "ai_turn_status_ck",
      sql.raw("status IN ('running', 'completed', 'interrupted', 'error')"),
    ),
    check(
      "ai_turn_ended_with_ck",
      sql.raw("ended_with IN ('end_turn', 'question', 'permission', 'error', 'aborted')"),
    ),
    check(
      "ai_turn_initiator_ck",
      sql.raw("initiator IN ('human', 'queued', 'scheduled', 'system')"),
    ),
    check("ai_turn_pending_question_ck", bool01("pending_question")),
    uniqueIndex("ai_turn_uq").on(t.sessionId, t.turnKey),
    index("ai_turn_wi_idx").on(t.workItemId, t.startedAt),
    index("ai_turn_date_idx").on(t.localDate),
  ],
);

export const aiArtifact = sqliteTable(
  "ai_artifact",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["pr", "commit", "file_output"] }).notNull(),
    ref: text("ref").notNull(),
    sessionId: text("session_id").references(() => aiSession.id),
    turnId: text("turn_id").references(() => aiTurn.id),
    workItemId: text("work_item_id").references(() => workItem.id),
    url: text("url"),
    title: text("title"),
    state: text("state", { enum: ["open", "draft", "merged", "closed", "unknown"] })
      .notNull()
      .default("unknown"),
    reviewDecision: text("review_decision"),
    myReviewAt: integer("my_review_at"),
    headRef: text("head_ref"),
    // 0002（M1-9）: merged / closed になった時刻（3.3.1）
    stateChangedAt: integer("state_changed_at"),
    firstSeenAt: integer("first_seen_at").notNull(),
    stateCheckedAt: integer("state_checked_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check("ai_artifact_kind_ck", sql.raw("kind IN ('pr', 'commit', 'file_output')")),
    check(
      "ai_artifact_state_ck",
      sql.raw("state IN ('open', 'draft', 'merged', 'closed', 'unknown')"),
    ),
    uniqueIndex("ai_artifact_uq").on(t.kind, t.ref),
    index("ai_artifact_wi_idx").on(t.workItemId),
    index("ai_artifact_open_idx")
      .on(t.stateCheckedAt)
      .where(sql`kind = 'pr' AND state IN ('open', 'draft', 'unknown')`),
  ],
);

// ---------- hooks の生イベント ----------
export const hookEvent = sqliteTable(
  "hook_event",
  {
    id: text("id").primaryKey(),
    tool: text("tool").notNull(),
    configRoot: text("config_root"),
    hookEventName: text("hook_event_name").notNull(),
    sessionExternalId: text("session_external_id"),
    turnId: text("turn_id"),
    promptId: text("prompt_id"),
    notificationType: text("notification_type"),
    toolName: text("tool_name"),
    errorType: text("error_type"),
    source: text("source"),
    reason: text("reason"),
    cwd: text("cwd"),
    /** Orca の端末のハンドル（ORCA_TERMINAL_HANDLE。Turnlane から答える届け先。D-238） */
    termHandle: text("term_handle"),
    /** サブエージェントの中で出た hook のサブエージェントの ID（Claude Code の agent_id。session_external_id は親） */
    agentId: text("agent_id"),
    /** サブエージェントの種類（agent_type。種類の名前だけ） */
    agentType: text("agent_type"),
    /** 権限のモード（permission_mode。bypassPermissions の許可の hook は待ちにしない） */
    permissionMode: text("permission_mode"),
    /**
     * 利用枠の自動再開を止めた通知（quota_auto_resume_disabled）が「明けるのが 24 時間より先」の定型文だった（1）。文は
     * 持たない（hook が真偽値だけを残す）。上限待ちの明ける時刻が分からないときの見込みを 24 時間にする
     */
    quotaHorizon: integer("quota_horizon"),
    occurredAt: integer("occurred_at").notNull(),
    spoolFile: text("spool_file").notNull(),
    spoolOffset: integer("spool_offset").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check("hook_event_tool_ck", TOOL_ID_CK),
    uniqueIndex("hook_event_spool_uq").on(t.spoolFile, t.spoolOffset),
    index("hook_event_sess_idx").on(t.sessionExternalId, t.occurredAt),
    index("hook_event_time_idx").on(t.occurredAt),
  ],
);

// ---------- フォローアップ（自分の番） ----------
export const FOLLOW_UP_KINDS = [
  "approve",
  "reply",
  "review_pr",
  "resume_error",
  "check_changes",
  "merge_pr",
] as const;
export const FOLLOW_UP_STATUSES = [
  "open",
  "snoozed",
  "done",
  "dismissed",
  "superseded",
  "expired",
] as const;
export const followUp = sqliteTable(
  "follow_up",
  {
    id: text("id").primaryKey(),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => workItem.id),
    kind: text("kind", { enum: FOLLOW_UP_KINDS }).notNull(),
    artifactRef: text("artifact_ref").notNull().default(""),
    dedupeKey: text("dedupe_key").notNull(),
    triggerAt: integer("trigger_at").notNull(),
    triggerTurnId: text("trigger_turn_id").references(() => aiTurn.id),
    status: text("status", { enum: FOLLOW_UP_STATUSES }).notNull().default("open"),
    snoozeUntil: integer("snooze_until"),
    // スヌーズした区間の履歴 [[開始, 終了], ...]（D-032。3.3.1）
    snoozesJson: text("snoozes_json").notNull().default("[]"),
    taskId: text("task_id").references(() => task.id),
    engagedAt: integer("engaged_at"),
    closedAt: integer("closed_at"),
    closeReason: text("close_reason"),
    // 閉じた行を利用者が手で自分の番に戻した時刻（Issue #3）。手で閉じるか、この後に新しいターンが始まるまで自動では閉じない
    returnedAt: integer("returned_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    hlc: text("hlc").notNull(),
    deviceId: text("device_id").notNull(),
    deletedAt: integer("deleted_at"),
    syncScope: syncScope("local_only"),
  },
  (t) => [
    check(
      "follow_up_kind_ck",
      sql.raw(
        "kind IN ('approve', 'reply', 'review_pr', 'resume_error', 'check_changes', 'merge_pr')",
      ),
    ),
    check(
      "follow_up_status_ck",
      sql.raw("status IN ('open', 'snoozed', 'done', 'dismissed', 'superseded', 'expired')"),
    ),
    check("follow_up_sync_scope_ck", SYNC_SCOPE_CK),
    uniqueIndex("follow_up_dedupe_uq").on(t.dedupeKey),
    // AI に頼んだタスク（D-107）は、そのタスクに自分の番が何度も付くので一意にしない（0010）
    index("follow_up_task_idx").on(t.taskId).where(sql`task_id IS NOT NULL`),
    index("follow_up_open_idx").on(t.status, t.triggerAt).where(sql`status IN ('open', 'snoozed')`),
    index("follow_up_wi_idx").on(t.workItemId),
  ],
);

// ---------- 待ちの中身（限定した保存。ADR 0018、D-218） ----------

/**
 * 自分の指示の 1 行目（ターンごと。伏せ字の後・120 文字まで。短い返事・スラッシュコマンドだけの指示は持たない）。
 * 件名（その日の最初の指示）と流れの各段の「何を頼んだか」に使う。設定 turn.store_detail がオフなら書かない。
 * 同期の対象にしない
 */
export const aiInstruction = sqliteTable(
  "ai_instruction",
  {
    turnId: text("turn_id")
      .primaryKey()
      .references(() => aiTurn.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => aiSession.id, { onDelete: "cascade" }),
    at: integer("at").notNull(),
    text: text("text").notNull(),
    masked: integer("masked").notNull().default(0),
  },
  (t) => [
    check("ai_instruction_masked_ck", bool01("masked")),
    index("ai_instruction_session_idx").on(t.sessionId, t.at),
  ],
);

/**
 * 自分の番の待ちの中身（フォローアップごと。作ったときに 1 度だけ記録から読んで、伏せ字の後に持つ）。
 * kind: permission = 許可待ち（ツール名・Claude の短い説明・コマンドの 1 行目またはパス等）、question = AI の問い（2 文まで）、
 * ask = AskUserQuestion（問いと選択肢）、error = エラーの種類。AI の発言の本文・差分・ファイルの中身は持たない
 */
export const waitDetail = sqliteTable(
  "wait_detail",
  {
    followUpId: text("follow_up_id")
      .primaryKey()
      .references(() => followUp.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["permission", "question", "ask", "error"] }).notNull(),
    text: text("text"),
    optionsJson: text("options_json"),
    tool: text("tool"),
    label: text("label"),
    command: text("command"),
    errorKind: text("error_kind"),
    masked: integer("masked").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  () => [
    check("wait_detail_kind_ck", sql.raw("kind IN ('permission', 'question', 'ask', 'error')")),
    check("wait_detail_masked_ck", bool01("masked")),
  ],
);

// ---------- 日報 / 儀式 ----------
export const dailyNote = sqliteTable(
  "daily_note",
  {
    id: text("id").primaryKey(),
    date: text("date").notNull(),
    planMd: text("plan_md"),
    memoMd: text("memo_md"),
    reportMd: text("report_md"),
    highlightTaskId: text("highlight_task_id").references(() => task.id),
    plannedMin: integer("planned_min"),
    actualMin: integer("actual_min"),
    morningDoneAt: integer("morning_done_at"),
    shutdownDoneAt: integer("shutdown_done_at"),
    // 0006（M4-6）: 日報の AI 要約（ユーザーが編集できる）、作ったツール、保存した時刻
    aiSummaryMd: text("ai_summary_md"),
    aiSummaryTool: text("ai_summary_tool", { enum: ["claude_code", "codex"] }),
    aiSummaryAt: integer("ai_summary_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    hlc: text("hlc").notNull(),
    deviceId: text("device_id").notNull(),
    deletedAt: integer("deleted_at"),
    syncScope: syncScope("synced"),
  },
  (t) => [
    check("daily_note_sync_scope_ck", SYNC_SCOPE_CK),
    uniqueIndex("daily_note_date_uq").on(t.date).where(sql`deleted_at IS NULL`),
  ],
);

// ---------- 在席（端末内だけ。同期しない・mutate() を通さない。D-105、ADR 0013） ----------
/**
 * Mac を使っていた区間（入力のあった区間。D-139）。始まり・最後の入力の時刻・続けて見ていた最後のサンプルの時刻だけを持ち、
 * どのアプリを使ったか・何を打ったかは持たない。デーモンが 30 秒ごとのサンプルで最後の区間を延ばすか、新しい区間を足す。
 * 「使っていた」とみなす長さ（presence.tail_min）は保存のときではなく、読むときに足す（derive.expandPresence）
 */
export const presenceSpan = sqliteTable(
  "presence_span",
  {
    id: text("id").primaryKey(),
    startAt: integer("start_at").notNull(),
    /** 最後の入力の時刻（D-139。それより前は、presence.tail_min を足した時刻だった） */
    endAt: integer("end_at").notNull(),
    /**
     * 最後の入力から途切れずに見ていた最後のサンプルの時刻（D-139。在席の終わりはこれを超えない）。
     * NULL は上限なし（D-139 より前の行で、上限の分からないもの）
     */
    seenUntil: integer("seen_until"),
    /** 取り方（hid = HID の無操作時間） */
    source: text("source", { enum: ["hid"] }).notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check("presence_span_range_ck", sql.raw("end_at >= start_at")),
    check("presence_span_source_ck", sql.raw("source IN ('hid')")),
    index("presence_span_end_idx").on(t.endAt),
  ],
);

// ---------- AI に頼む（端末内だけ。同期しない・mutate() を通さない。D-107、M5-B） ----------
export const AI_LAUNCH_TOOLS = ["claude_code", "codex"] as const;
export const AI_LAUNCH_STATUSES = ["pending", "started", "linked", "unlinked", "failed"] as const;
export const AI_LAUNCH_TRIGGERS = ["manual", "schedule", "queue", "issue"] as const;

/**
 * タスクから AI に頼んだ1回（plan §B.6）。id は端末に渡す起動 ID（ランダム 128bit の16進）。組み立てたプロンプトは保存しない
 * （タスクの題名・メモは task にある。ADR 0005 の追記）。パスを持つので同期の対象にしない
 */
export const aiLaunch = sqliteTable(
  "ai_launch",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => task.id),
    tool: text("tool", { enum: AI_LAUNCH_TOOLS }).notNull(),
    repoRoot: text("repo_root").notNull(),
    /** AI を起動するディレクトリ（worktree か repo_root） */
    cwd: text("cwd").notNull(),
    worktreePath: text("worktree_path"),
    branch: text("branch"),
    baseRef: text("base_ref"),
    /** 依頼の型（組み込みは `builtin:<key>`、利用者のものは ai_template.id） */
    templateId: text("template_id"),
    readOnly: integer("read_only").notNull().default(0),
    trigger: text("trigger", { enum: AI_LAUNCH_TRIGGERS }).notNull().default("manual"),
    /** Claude Code に先に渡したセッション ID（--session-id） */
    sessionUuid: text("session_uuid"),
    sessionId: text("session_id").references(() => aiSession.id),
    status: text("status", { enum: AI_LAUNCH_STATUSES }).notNull(),
    failReason: text("fail_reason"),
    /** 確認支援のテストの成否と時刻（出力は持たない。D-109） */
    testOk: integer("test_ok"),
    testAt: integer("test_at"),
    createdAt: integer("created_at").notNull(),
    fetchedAt: integer("fetched_at"),
    linkedAt: integer("linked_at"),
    cleanedAt: integer("cleaned_at"),
    updatedAt: integer("updated_at").notNull(),
    /** 起動した Claude のアカウント（設定ディレクトリ。既定・Codex は null）。unlinked の理由で信頼を見るのに使う */
    claudeAccount: text("claude_account"),
    /** turnlane ai run が知らせた、AI の CLI の終了コードと、始めてから終わるまでの時間（ms）と、知らせた時刻 */
    exitCode: integer("exit_code"),
    exitAfterMs: integer("exit_after_ms"),
    exitedAt: integer("exited_at"),
    /** unlinked の理由（core の UnlinkedReason: exited / untrusted / no_session） */
    unlinkedReason: text("unlinked_reason"),
  },
  (t) => [
    check("ai_launch_tool_ck", sql.raw("tool IN ('claude_code', 'codex')")),
    check(
      "ai_launch_status_ck",
      sql.raw("status IN ('pending', 'started', 'linked', 'unlinked', 'failed')"),
    ),
    check("ai_launch_trigger_ck", sql.raw("trigger IN ('manual', 'schedule', 'queue', 'issue')")),
    check("ai_launch_read_only_ck", bool01("read_only")),
    check("ai_launch_test_ok_ck", sql.raw("test_ok IS NULL OR test_ok IN (0, 1)")),
    index("ai_launch_task_idx").on(t.taskId, t.createdAt),
    index("ai_launch_session_idx").on(t.sessionId).where(sql`session_id IS NOT NULL`),
    index("ai_launch_open_idx").on(t.status).where(sql`status IN ('pending', 'started')`),
  ],
);

/**
 * Claude の利用枠の最新の値（アカウント＝設定ディレクトリごとに1行）。本体が起動した Claude のセッションの statusLine の受け口
 * （turnlane statusline）が送る `rate_limits` の使用率とリセットの時刻だけ。会話・費用・モデルなどは持たない（ADR 0005）。
 * パスを持つので同期の対象にしない
 */
export const claudeLimit = sqliteTable("claude_limit", {
  /** 設定ディレクトリの絶対パス（CLAUDE_CONFIG_DIR、無ければ ~/.claude） */
  account: text("account").primaryKey(),
  fiveHourPct: real("five_hour_pct"),
  fiveHourResetsAt: integer("five_hour_resets_at"),
  sevenDayPct: real("seven_day_pct"),
  sevenDayResetsAt: integer("seven_day_resets_at"),
  /** 受け取った時刻 */
  at: integer("at").notNull(),
});

/** 依頼の型（利用者が足したもの。組み込みの4つはコードに持つ。plan §B.4） */
export const aiTemplate = sqliteTable(
  "ai_template",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** 本文（{title} {notes} {repo} {branch} を差し込む） */
    body: text("body").notNull(),
    /** 既定のツール（NULL = 前回選んだもの） */
    tool: text("tool", { enum: AI_LAUNCH_TOOLS }),
    readOnly: integer("read_only").notNull().default(0),
    /** worktree の既定（NULL = プロジェクトの既定） */
    worktree: integer("worktree"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  () => [
    check("ai_template_tool_ck", sql.raw("tool IS NULL OR tool IN ('claude_code', 'codex')")),
    check("ai_template_read_only_ck", bool01("read_only")),
    check("ai_template_worktree_ck", sql.raw("worktree IS NULL OR worktree IN (0, 1)")),
  ],
);

// ---------- 待ち（local_only。事実から再計算できるキャッシュ。3.3.1） ----------

export const WAIT_KINDS = ["grace", "idle", "excluded", "expired"] as const;
export const WAIT_EXCLUDED_BY = [
  "closed",
  "away",
  "event",
  "snoozed",
  "no_task",
  "scheduled",
] as const;
export const WAIT_END_REASONS = [
  "human_input",
  "engaged",
  "status_left",
  "resolved",
  "dismissed",
  "expired",
  "superseded",
] as const;

export const aiWaitSegment = sqliteTable(
  "ai_wait_segment",
  {
    id: text("id").primaryKey(),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => workItem.id, { onDelete: "cascade" }),
    waitKey: text("wait_key").notNull(),
    followUpId: text("follow_up_id").references(() => followUp.id),
    localDate: text("local_date").notNull(),
    kind: text("kind", { enum: WAIT_KINDS }).notNull(),
    excludedBy: text("excluded_by", { enum: WAIT_EXCLUDED_BY }),
    startAt: integer("start_at").notNull(),
    endAt: integer("end_at").notNull(),
    isOpen: integer("is_open").notNull().default(0),
    endReason: text("end_reason", { enum: WAIT_END_REASONS }),
    estimated: integer("estimated").notNull().default(0),
    computedAt: integer("computed_at").notNull(),
  },
  (t) => [
    check("ai_wait_seg_kind_ck", sql.raw("kind IN ('grace', 'idle', 'excluded', 'expired')")),
    check(
      "ai_wait_seg_excluded_by_ck",
      sql.raw("excluded_by IN ('closed', 'away', 'event', 'snoozed', 'no_task', 'scheduled')"),
    ),
    check("ai_wait_seg_is_open_ck", bool01("is_open")),
    check(
      "ai_wait_seg_end_reason_ck",
      sql.raw(
        "end_reason IN ('human_input', 'engaged', 'status_left', 'resolved', 'dismissed', 'expired', 'superseded')",
      ),
    ),
    check("ai_wait_seg_estimated_ck", bool01("estimated")),
    check("ai_wait_seg_range_ck", sql.raw("end_at >= start_at")),
    check(
      "ai_wait_seg_excluded_pair_ck",
      sql.raw("(kind = 'excluded') = (excluded_by IS NOT NULL)"),
    ),
    index("ai_wait_seg_date_idx").on(t.localDate, t.kind),
    index("ai_wait_seg_wi_idx").on(t.workItemId, t.startAt),
  ],
);

// ---------- 自分用の利用計測 ----------
export const usageEvent = sqliteTable(
  "usage_event",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    kind: text("kind").notNull(),
    ref: text("ref"),
  },
  (t) => [index("usage_event_idx").on(t.kind, t.at)],
);

// ---------- 同期用の変更ログ（outbox） ----------
export const changeLog = sqliteTable(
  "change_log",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    tbl: text("tbl").notNull(),
    rowId: text("row_id").notNull(),
    op: text("op", { enum: ["insert", "update", "delete"] }).notNull(),
    hlc: text("hlc").notNull(),
    deviceId: text("device_id").notNull(),
    patchJson: text("patch_json").notNull(),
    createdAt: integer("created_at").notNull(),
    pushedAt: integer("pushed_at"),
  },
  (t) => [
    check("change_log_op_ck", sql.raw("op IN ('insert', 'update', 'delete')")),
    index("change_log_unpushed_idx").on(t.seq).where(sql`pushed_at IS NULL`),
    index("change_log_row_idx").on(t.tbl, t.rowId),
  ],
);
