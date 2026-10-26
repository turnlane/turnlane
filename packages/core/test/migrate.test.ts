import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appliedMigrations,
  type Migration,
  MigrationError,
  migrate,
  pendingMigrations,
  readUserVersion,
  splitStatements,
} from "../src/db/migrate.ts";
import { migrations } from "../src/db/migrations/index.ts";
import { openDatabase } from "../src/db/open.ts";
import { expandPresence, type PresenceRow } from "../src/derive/index.ts";
import { aiEnd, at, compute, D, facts, followUp, human, MIN } from "./derive/helpers.ts";

const M0: Migration = {
  id: "0000_init",
  sql: "CREATE TABLE a (id TEXT PRIMARY KEY, n INTEGER NOT NULL);\n--> statement-breakpoint\nCREATE INDEX a_n ON a(n);",
};
const M1: Migration = {
  id: "0001_add_b",
  sql: "CREATE TABLE b (id TEXT PRIMARY KEY);",
};
const BROKEN: Migration = {
  id: "0001_broken",
  sql: "CREATE TABLE c (id TEXT);\n--> statement-breakpoint\nCREATE TABLE c (id TEXT);",
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turnlane-migrate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const tables = (db: Database) =>
  db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);

describe("splitStatements", () => {
  test("statement-breakpoint で分割し、空の文を捨てる", () => {
    expect(splitStatements(M0.sql)).toEqual([
      "CREATE TABLE a (id TEXT PRIMARY KEY, n INTEGER NOT NULL);",
      "CREATE INDEX a_n ON a(n);",
    ]);
    expect(splitStatements("\n--> statement-breakpoint\n")).toEqual([]);
  });
});

describe("migrate", () => {
  test("新規 DB に適用し、2回目は何もしない", () => {
    const db = openDatabase(join(dir, "d.db"));
    const r1 = migrate(db, [M0], { backupDir: join(dir, "backups") });
    expect(r1).toEqual({ applied: ["0000_init"], userVersion: 1, backupPath: null });
    expect(tables(db)).toEqual(["__migrations", "a"]);
    const r2 = migrate(db, [M0], { backupDir: join(dir, "backups") });
    expect(r2).toEqual({ applied: [], userVersion: 1, backupPath: null });
    expect(appliedMigrations(db)).toEqual(["0000_init"]);
    // 新規 DB ではバックアップを取らない
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });

  test("既存 DB に未適用分があれば、適用前に VACUUM INTO でバックアップを取る", () => {
    const db = openDatabase(join(dir, "d.db"));
    migrate(db, [M0]);
    db.run("INSERT INTO a VALUES ('x', 1)");
    const r = migrate(db, [M0, M1], {
      backupDir: join(dir, "backups"),
      now: () => Date.parse("2026-10-02T01:02:03Z"),
    });
    expect(r.applied).toEqual(["0001_add_b"]);
    expect(r.userVersion).toBe(2);
    expect(r.backupPath).toBe(join(dir, "backups", "pre-migrate-0001-20261002T010203Z.db"));
    // バックアップは適用前の状態
    const bk = new Database(r.backupPath as string, { readonly: true });
    expect(tables(bk)).toEqual(["__migrations", "a"]);
    expect(bk.query("SELECT count(*) AS n FROM a").get()).toEqual({ n: 1 });
    bk.close();
    expect(readUserVersion(db)).toBe(2);
  });

  test("途中で失敗したら全部巻き戻し、MigrationError を投げる", () => {
    const db = openDatabase(join(dir, "d.db"));
    migrate(db, [M0]);
    let err: unknown;
    try {
      migrate(db, [M0, BROKEN]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as MigrationError).migrationId).toBe("0001_broken");
    expect((err as MigrationError).statementIndex).toBe(1);
    expect(tables(db)).toEqual(["__migrations", "a"]);
    expect(appliedMigrations(db)).toEqual(["0000_init"]);
    expect(readUserVersion(db)).toBe(1);
  });

  test("連番が飛んでいる・書式が違う ID は拒否する", () => {
    const db = openDatabase(":memory:");
    expect(() => migrate(db, [M1])).toThrow(MigrationError);
    expect(() => migrate(db, [{ id: "init", sql: "" }])).toThrow(MigrationError);
  });

  test("DB に埋め込み側の知らない適用履歴があれば拒否する（新しい版の DB）", () => {
    const db = openDatabase(":memory:");
    migrate(db, [M0, M1]);
    expect(() => pendingMigrations(db, [M0, { id: "0001_other", sql: "" }])).toThrow(
      /does not know/,
    );
  });
});

describe("0002（M1-9）を M0 の DB に適用する", () => {
  test("M0 の時点の行（task・work_item・follow_up・daily_note）を保ったまま列とテーブルを足す", () => {
    const db = openDatabase(join(dir, "m0.db"));
    migrate(db, migrations.slice(0, 2));
    const ins = (sql: string) => db.run(sql);
    ins(
      "INSERT INTO task (id, title, lane_order, source, created_at, updated_at, hlc, device_id) VALUES ('t1', 'x', 'a0', 'manual', 1, 1, 'h', 'd')",
    );
    ins(
      "INSERT INTO work_item (id, group_key, status, status_changed_at, first_activity_at, last_activity_at, created_at, updated_at, hlc, device_id) VALUES ('w1', 'session:claude_code:s', 'done', 1, 1, 1, 1, 1, 'h', 'd')",
    );
    ins(
      "INSERT INTO follow_up (id, work_item_id, kind, dedupe_key, trigger_at, status, snooze_until, task_id, created_at, updated_at, hlc, device_id) VALUES ('f1', 'w1', 'reply', 'w1|reply|', 1, 'snoozed', 5, 't1', 1, 1, 'h', 'd')",
    );
    ins(
      "INSERT INTO daily_note (id, date, memo_md, created_at, updated_at, hlc, device_id) VALUES ('n1', '2026-10-01', 'm', 1, 1, 'h', 'd')",
    );
    const r = migrate(db, migrations.slice(0, 3), { backupDir: join(dir, "backups") });
    expect(r.applied).toEqual(["0002_m1_ingestion"]);
    expect(r.backupPath).not.toBeNull();
    expect(
      db.query("SELECT status, snooze_until, snoozes_json, task_id FROM follow_up").get(),
    ).toEqual({
      status: "snoozed",
      snooze_until: 5,
      snoozes_json: "[]",
      task_id: "t1",
    });
    expect(db.query("SELECT memo_md, work_start_at FROM daily_note").get()).toEqual({
      memo_md: "m",
      work_start_at: null,
    });
    expect(() => db.run("UPDATE follow_up SET status = 'expired'")).not.toThrow();
    expect(() => db.run("UPDATE daily_note SET work_start_at = 10, work_end_at = 5")).toThrow(
      /CHECK/,
    );
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(tables(db)).toContain("ai_wait_segment");
    expect(tables(db)).toContain("work_day_auto");
  });
});

describe("openDatabase", () => {
  test("接続ごとの PRAGMA と、ファイル・ディレクトリの権限", () => {
    const path = join(dir, "sub", "d.db");
    const db = openDatabase(path);
    const get = (p: string) => Object.values(db.query(`PRAGMA ${p}`).get() as object)[0];
    expect(get("journal_mode")).toBe("wal");
    expect(get("synchronous")).toBe(1); // NORMAL
    expect(get("foreign_keys")).toBe(1);
    expect(get("busy_timeout")).toBe(5000);
    expect(get("temp_store")).toBe(2); // MEMORY
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o700);
    db.close();
    expect(readdirSync(join(dir, "sub"))).toContain("d.db");
  });
});

describe("0003（D-045・D-046）を M1 の DB に適用する", () => {
  test("task の行を保ったまま題名の列を足し、ai_wait_segment は作り直して no_task を受け付ける", () => {
    const db = openDatabase(join(dir, "m1.db"));
    migrate(db, migrations.slice(0, 3));
    db.run(
      "INSERT INTO task (id, title, lane_order, source, created_at, updated_at, hlc, device_id) VALUES ('t1', 'x', 'a0', 'manual', 1, 1, 'h', 'd')",
    );
    db.run(
      "INSERT INTO work_item (id, group_key, status, status_changed_at, first_activity_at, last_activity_at, created_at, updated_at, hlc, device_id) VALUES ('w1', 'session:claude_code:s', 'done', 1, 1, 1, 1, 1, 'h', 'd')",
    );
    db.run(
      "INSERT INTO ai_wait_segment (id, work_item_id, wait_key, local_date, kind, start_at, end_at, computed_at) VALUES ('s1', 'w1', 'turn:x', '2026-10-01', 'idle', 1, 2, 1)",
    );
    const r = migrate(db, migrations.slice(0, 4), { backupDir: join(dir, "backups") });
    expect(r.applied).toEqual(["0003_d045_idle_titles"]);
    expect(db.query("SELECT title, title_key, title_params FROM task").get()).toEqual({
      title: "x",
      title_key: null,
      title_params: null,
    });
    // キャッシュなので行は捨てる（次の derive で作る）
    expect(db.query("SELECT count(*) AS n FROM ai_wait_segment").get()).toEqual({ n: 0 });
    expect(() =>
      db.run(
        "INSERT INTO ai_wait_segment (id, work_item_id, wait_key, local_date, kind, excluded_by, start_at, end_at, computed_at) VALUES ('s2', 'w1', 'turn:x', '2026-10-01', 'excluded', 'no_task', 1, 2, 1)",
      ),
    ).not.toThrow();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("0004（D-051）を M2 段階 A の DB に適用する", () => {
  test("ai_wait_segment を作り直し、scheduled を受け付ける", () => {
    const db = openDatabase(join(dir, "m2a.db"));
    migrate(db, migrations.slice(0, 4));
    db.run(
      "INSERT INTO work_item (id, group_key, status, status_changed_at, first_activity_at, last_activity_at, created_at, updated_at, hlc, device_id) VALUES ('w1', 'session:claude_code:s', 'done', 1, 1, 1, 1, 1, 'h', 'd')",
    );
    const insert = (id: string, by: string) =>
      db.run(
        `INSERT INTO ai_wait_segment (id, work_item_id, wait_key, local_date, kind, excluded_by, start_at, end_at, computed_at) VALUES ('${id}', 'w1', 'turn:x', '2026-10-01', 'excluded', '${by}', 1, 2, 1)`,
      );
    insert("s1", "no_task");
    expect(() => insert("s2", "scheduled")).toThrow(/CHECK/);
    const r = migrate(db, migrations.slice(0, 5), { backupDir: join(dir, "backups") });
    expect(r.applied).toEqual(["0004_d051_scheduled_wait"]);
    // キャッシュなので行は捨てる（次の derive で作る）
    expect(db.query("SELECT count(*) AS n FROM ai_wait_segment").get()).toEqual({ n: 0 });
    expect(() => insert("s3", "scheduled")).not.toThrow();
    expect(() => insert("s4", "other")).toThrow(/CHECK/);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("0005（M3-3・D-070）", () => {
  test("calendar_event に own_timeblock_id を足す（既存の行は NULL）", () => {
    const db = openDatabase(join(dir, "m3.db"));
    migrate(db, migrations.slice(0, 5));
    db.run(
      "INSERT INTO calendar (id, external_id, name, created_at, updated_at) VALUES ('c1', 'ek', 'Work', 1, 1)",
    );
    db.run(
      "INSERT INTO calendar_event (id, calendar_id, external_id, occurrence_start, start_at, end_at, fetched_at) VALUES ('e1', 'c1', 'x', 1, 1, 2, 1)",
    );
    const r = migrate(db, migrations, { backupDir: join(dir, "backups") });
    expect(r.applied).toEqual([
      "0005_m3_3_own_timeblock",
      "0006_m4_6_ai_summary",
      "0007_d093_events",
      "0008_d097_meeting_link",
      "0009_d105_presence",
      "0010_d107_ai_launch",
      "0011_d125_calendar_color",
      "0012_d135_scratch",
      "0013_d136_claude_scratch_paths",
      "0014_d139_presence_raw",
      "0015_claude_limit",
      "0016_launch_exit",
      "0017_d218_stored_detail",
      "0018_d238_term_handle",
      "0019_subagent_hook",
      "0020_quota_horizon",
    ]);
    expect(db.query("SELECT own_timeblock_id FROM calendar_event").all()).toEqual([
      { own_timeblock_id: null },
    ]);
  });
});

describe("0006（M4-6）", () => {
  test("daily_note に AI 要約の列を足す（既存の日報はそのまま、要約は NULL）", () => {
    const db = openDatabase(join(dir, "m4.db"));
    migrate(db, migrations.slice(0, 6));
    db.run(
      "INSERT INTO daily_note (id, date, report_md, created_at, updated_at, hlc, device_id) VALUES ('n1', '2026-10-02', '## Fri', 1, 1, 'h', 'd')",
    );
    const r = migrate(db, migrations, { backupDir: join(dir, "backups") });
    expect(r.applied).toEqual([
      "0006_m4_6_ai_summary",
      "0007_d093_events",
      "0008_d097_meeting_link",
      "0009_d105_presence",
      "0010_d107_ai_launch",
      "0011_d125_calendar_color",
      "0012_d135_scratch",
      "0013_d136_claude_scratch_paths",
      "0014_d139_presence_raw",
      "0015_claude_limit",
      "0016_launch_exit",
      "0017_d218_stored_detail",
      "0018_d238_term_handle",
      "0019_subagent_hook",
      "0020_quota_horizon",
    ]);
    expect(
      db
        .query("SELECT report_md, ai_summary_md, ai_summary_tool, ai_summary_at FROM daily_note")
        .all(),
    ).toEqual([
      { report_md: "## Fri", ai_summary_md: null, ai_summary_tool: null, ai_summary_at: null },
    ]);
  });
});

describe("0007（D-093）", () => {
  test("calendar_event に予定の編集の材料を足し、役割 writeback のカレンダーを ignored にする", () => {
    const db = openDatabase(join(dir, "d093.db"));
    migrate(db, migrations.slice(0, 7));
    db.run(
      "INSERT INTO calendar (id, external_id, name, role, created_at, updated_at) VALUES ('c1', 'ek1', 'Work', 'source', 1, 1), ('c2', 'ek2', 'Turnlane', 'writeback', 1, 1)",
    );
    db.run(
      "INSERT INTO calendar_event (id, calendar_id, external_id, occurrence_start, start_at, end_at, fetched_at) VALUES ('e1', 'c1', 'x', 1, 1, 2, 1)",
    );
    const r = migrate(db, migrations, { backupDir: join(dir, "backups") });
    expect(r.applied).toEqual([
      "0007_d093_events",
      "0008_d097_meeting_link",
      "0009_d105_presence",
      "0010_d107_ai_launch",
      "0011_d125_calendar_color",
      "0012_d135_scratch",
      "0013_d136_claude_scratch_paths",
      "0014_d139_presence_raw",
      "0015_claude_limit",
      "0016_launch_exit",
      "0017_d218_stored_detail",
      "0018_d238_term_handle",
      "0019_subagent_hook",
      "0020_quota_horizon",
    ]);
    expect(
      db.query("SELECT event_id, has_attendees, recurring, is_own_event FROM calendar_event").all(),
    ).toEqual([{ event_id: null, has_attendees: null, recurring: null, is_own_event: 0 }]);
    expect(db.query("SELECT id, role FROM calendar ORDER BY id").all()).toEqual([
      { id: "c1", role: "source" },
      { id: "c2", role: "ignored" },
    ]);
  });
});

describe("0008（D-097）", () => {
  test("calendar_event に会議リンクの列を足す（既存の行は NULL = まだ分からない。次の同期で入る）", () => {
    const db = openDatabase(join(dir, "d097.db"));
    migrate(db, migrations.slice(0, 8));
    db.run(
      "INSERT INTO calendar (id, external_id, name, created_at, updated_at) VALUES ('c1', 'ek1', 'Work', 1, 1)",
    );
    db.run(
      "INSERT INTO calendar_event (id, calendar_id, external_id, occurrence_start, start_at, end_at, fetched_at) VALUES ('e1', 'c1', 'x', 1, 1, 2, 1)",
    );
    const r = migrate(db, migrations, { backupDir: join(dir, "backups") });
    expect(r.applied).toEqual([
      "0008_d097_meeting_link",
      "0009_d105_presence",
      "0010_d107_ai_launch",
      "0011_d125_calendar_color",
      "0012_d135_scratch",
      "0013_d136_claude_scratch_paths",
      "0014_d139_presence_raw",
      "0015_claude_limit",
      "0016_launch_exit",
      "0017_d218_stored_detail",
      "0018_d238_term_handle",
      "0019_subagent_hook",
      "0020_quota_horizon",
    ]);
    expect(db.query("SELECT has_meeting_link FROM calendar_event").all()).toEqual([
      { has_meeting_link: null },
    ]);
  });
});

describe("0009（D-105）", () => {
  test("presence_span を作り、work_day_auto と daily_note の勤務時間の列を消す。過去の待ち区間は残し off_hours を away に読み替える", () => {
    const db = openDatabase(join(dir, "d105.db"));
    migrate(db, migrations.slice(0, 9));
    db.run(
      "INSERT INTO daily_note (id, date, report_md, work_start_at, work_end_at, shutdown_done_at, created_at, updated_at, hlc, device_id) VALUES ('n1', '2026-10-02', '## Fri', 1, 2, 3, 1, 1, 'h', 'd')",
    );
    db.run(
      "INSERT INTO work_day_auto (date, first_op_at, last_op_at, op_count, computed_at) VALUES ('2026-10-02', 1, 2, 1, 1)",
    );
    db.run(
      "INSERT INTO work_item (id, group_key, status, first_activity_at, last_activity_at, status_changed_at, created_at, updated_at, hlc, device_id) VALUES ('w1', 'g', 'done', 1, 1, 1, 1, 1, 'h', 'd')",
    );
    const seg = (id: string, kind: string, by: string | null) =>
      db.run(
        "INSERT INTO ai_wait_segment (id, work_item_id, wait_key, local_date, kind, excluded_by, start_at, end_at, computed_at) VALUES (?, 'w1', 'k', '2026-10-02', ?, ?, 1, 2, 1)",
        [id, kind, by],
      );
    seg("s1", "excluded", "off_hours");
    seg("s2", "idle", null);
    const r = migrate(db, migrations, { backupDir: join(dir, "backups") });
    expect(r.applied).toEqual([
      "0009_d105_presence",
      "0010_d107_ai_launch",
      "0011_d125_calendar_color",
      "0012_d135_scratch",
      "0013_d136_claude_scratch_paths",
      "0014_d139_presence_raw",
      "0015_claude_limit",
      "0016_launch_exit",
      "0017_d218_stored_detail",
      "0018_d238_term_handle",
      "0019_subagent_hook",
      "0020_quota_horizon",
    ]);
    expect(tables(db)).toContain("presence_span");
    expect(tables(db)).not.toContain("work_day_auto");
    expect(db.query("SELECT date, report_md, shutdown_done_at FROM daily_note").all()).toEqual([
      { date: "2026-10-02", report_md: "## Fri", shutdown_done_at: 3 },
    ]);
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(daily_note)")
      .all()
      .map((c) => c.name);
    expect(cols).not.toContain("work_start_at");
    expect(db.query("SELECT id, kind, excluded_by FROM ai_wait_segment ORDER BY id").all()).toEqual(
      [
        { id: "s1", kind: "excluded", excluded_by: "away" },
        { id: "s2", kind: "idle", excluded_by: null },
      ],
    );
    expect(() => seg("s3", "excluded", "off_hours")).toThrow(/CHECK/);
    expect(() => seg("s4", "excluded", "closed")).not.toThrow();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("0011（D-125）", () => {
  test("calendar に Turnlane の中だけの色 color_key を足す（既存のカレンダーは NULL = カレンダーアプリの色）", () => {
    const db = openDatabase(join(dir, "d125.db"));
    migrate(db, migrations.slice(0, 11));
    db.run(
      "INSERT INTO calendar (id, external_id, name, color, created_at, updated_at) VALUES ('c1', 'ek', 'Work', '#1badf8', 1, 1)",
    );
    const r = migrate(db, migrations.slice(0, 12), { backupDir: join(dir, "backups") });
    expect(r.applied).toEqual(["0011_d125_calendar_color"]);
    expect(db.query("SELECT color, color_key FROM calendar").all()).toEqual([
      { color: "#1badf8", color_key: null },
    ]);
  });
});

describe("0012（D-135）", () => {
  test("work_item に scratch を足し、Codex のプロジェクト外の作業フォルダを日付までに切り落とす（ほかの行はそのまま）", () => {
    const db = openDatabase(join(dir, "d135.db"));
    migrate(db, migrations.slice(0, 12));
    const H = "/Users/fixture";
    const slug = `${H}/Documents/Codex/2026-10-08/SENTINEL-plan-the-trip`;
    db.run(
      `INSERT INTO ai_source (id, tool, root_path, created_at, updated_at) VALUES ('src', 'codex', '${H}/.codex', 1, 1)`,
    );
    const sess = (id: string, cwd: string | null) =>
      db.run(
        "INSERT INTO ai_session (id, source_id, tool, external_id, cwd, started_at, last_activity_at, created_at, updated_at) VALUES (?, 'src', 'codex', ?, ?, 1, 1, 1, 1)",
        [id, id, cwd],
      );
    sess("s1", slug);
    sess("s2", `${slug}/deeper`);
    sess("s3", `${H}/Documents/Codex/2026-10-08`);
    sess("s4", `${H}/Documents/Codex/SENTINEL-no-date/x`);
    sess("s5", `${H}/src/app`);
    sess("s6", null);
    sess("s7", `${H}/work/Documents/Codex/2026-10-08/keep`);
    db.run(
      "INSERT INTO ai_turn (id, session_id, turn_key, started_at, local_date, status, cwd, created_at, updated_at) VALUES ('t1', 's1', 'k1', 1, '2026-10-08', 'completed', ?, 1, 1)",
      [slug],
    );
    db.run(
      "INSERT INTO hook_event (id, tool, hook_event_name, cwd, occurred_at, spool_file, spool_offset, created_at) VALUES ('h1', 'codex', 'Stop', ?, 1, 'hooks-20261008.jsonl', 0, 1)",
      [slug],
    );
    const cur = (key: string, parser: string, carry: string) =>
      db.run(
        "INSERT INTO ingest_cursor (source_id, stream_key, kind, carry_state_json, parser_id, parser_version, updated_at) VALUES ('src', ?, 'jsonl', ?, ?, 2, 1)",
        [key, carry, parser],
      );
    cur("a.jsonl", "codex.rollout", JSON.stringify({ v: 1, cwd: slug }));
    cur("b.jsonl", "codex.rollout", JSON.stringify({ v: 1, cwd: `${H}/src/app` }));
    cur("c.jsonl", "claude_code.transcript", JSON.stringify({ cwd: slug }));
    const r = migrate(db, migrations.slice(0, 13), { backupDir: join(dir, "backups") });
    expect(r.applied).toEqual(["0012_d135_scratch"]);
    expect(r.backupPath).not.toBeNull();
    expect(db.query("SELECT id, cwd FROM ai_session ORDER BY id").all()).toEqual([
      { id: "s1", cwd: `${H}/Documents/Codex/2026-10-08` },
      { id: "s2", cwd: `${H}/Documents/Codex/2026-10-08` },
      { id: "s3", cwd: `${H}/Documents/Codex/2026-10-08` },
      { id: "s4", cwd: `${H}/Documents/Codex` },
      { id: "s5", cwd: `${H}/src/app` },
      { id: "s6", cwd: null },
      { id: "s7", cwd: `${H}/work/Documents/Codex/2026-10-08/keep` },
    ]);
    expect(db.query("SELECT cwd FROM ai_turn").get()).toEqual({
      cwd: `${H}/Documents/Codex/2026-10-08`,
    });
    expect(db.query("SELECT cwd FROM hook_event").get()).toEqual({
      cwd: `${H}/Documents/Codex/2026-10-08`,
    });
    expect(
      db.query("SELECT stream_key, carry_state_json FROM ingest_cursor ORDER BY stream_key").all(),
    ).toEqual([
      { stream_key: "a.jsonl", carry_state_json: null },
      { stream_key: "b.jsonl", carry_state_json: JSON.stringify({ v: 1, cwd: `${H}/src/app` }) },
      { stream_key: "c.jsonl", carry_state_json: JSON.stringify({ cwd: slug }) },
    ]);
    // 切り落とした後の DB に、最初の依頼から作った名前は残らない（Codex の継続状態を含む）
    const dump = JSON.stringify([
      db.query("SELECT * FROM ai_session").all(),
      db.query("SELECT * FROM ai_turn").all(),
      db.query("SELECT * FROM hook_event").all(),
      db.query("SELECT * FROM ingest_cursor WHERE parser_id = 'codex.rollout'").all(),
    ]);
    expect(dump).not.toContain("SENTINEL");
    expect(
      db.query("SELECT name FROM pragma_table_info('work_item') WHERE name = 'scratch'").get(),
    ).toEqual({
      name: "scratch",
    });
  });
});

describe("0013（D-136）", () => {
  test("Claude Code のトランスクリプトの置き場所に残る Codex の作業フォルダの名前を落とす（ほかの行はそのまま）", () => {
    const db = openDatabase(join(dir, "d136.db"));
    migrate(db, migrations.slice(0, 13));
    const H = "/Users/fixture";
    const R = `${H}/.claude`;
    const enc = "-Users-fixture-Documents-Codex-2026-10-08";
    db.run(
      `INSERT INTO ai_source (id, tool, root_path, created_at, updated_at) VALUES ('src', 'claude_code', '${R}', 1, 1)`,
    );
    const sess = (id: string, path: string | null) =>
      db.run(
        "INSERT INTO ai_session (id, source_id, tool, external_id, file_path, started_at, last_activity_at, created_at, updated_at) VALUES (?, 'src', 'claude_code', ?, ?, 1, 1, 1, 1)",
        [id, id, path],
      );
    sess("s1", `${R}/projects/${enc}-SENTINEL-plan-the-trip/s1.jsonl`);
    sess("s2", `${R}/projects/${enc}-SENTINEL-plan-the-trip/s2/subagents/agent-a.jsonl`);
    sess("s3", `${R}/projects/${enc}/s3.jsonl`);
    sess("s4", `${R}/projects/-Users-fixture-Documents-Codex-SENTINEL-no-date/s4.jsonl`);
    sess("s5", `${R}/projects/-Users-fixture-src-app/s5.jsonl`);
    sess("s6", null);
    const cur = (key: string, parser: string, carry: string | null) =>
      db.run(
        "INSERT INTO ingest_cursor (source_id, stream_key, kind, carry_state_json, parser_id, parser_version, updated_at) VALUES ('src', ?, 'jsonl', ?, ?, 2, 1)",
        [key, carry, parser],
      );
    cur(
      `projects/${enc}-SENTINEL-plan-the-trip/s1.jsonl`,
      "claude_code.transcript",
      JSON.stringify({ v: 1, cwd: `${H}/Documents/Codex/2026-10-08/SENTINEL-plan-the-trip` }),
    );
    cur(
      "projects/-Users-fixture-src-app/s7.jsonl",
      "claude_code.transcript",
      JSON.stringify({ v: 1, cwd: `${H}/Documents/Codex/2026-10-08/SENTINEL-moved-here` }),
    );
    cur(
      "projects/-Users-fixture-src-app/s5.jsonl",
      "claude_code.transcript",
      JSON.stringify({ v: 1, cwd: `${H}/src/app` }),
    );
    const r = migrate(db, migrations, { backupDir: join(dir, "backups") });
    expect(r.applied).toEqual([
      "0013_d136_claude_scratch_paths",
      "0014_d139_presence_raw",
      "0015_claude_limit",
      "0016_launch_exit",
      "0017_d218_stored_detail",
      "0018_d238_term_handle",
      "0019_subagent_hook",
      "0020_quota_horizon",
    ]);
    expect(db.query("SELECT id, file_path FROM ai_session ORDER BY id").all()).toEqual([
      { id: "s1", file_path: `${R}/projects/${enc}/s1.jsonl` },
      { id: "s2", file_path: `${R}/projects/${enc}/s2/subagents/agent-a.jsonl` },
      { id: "s3", file_path: `${R}/projects/${enc}/s3.jsonl` },
      { id: "s4", file_path: `${R}/projects/-Users-fixture-Documents-Codex/s4.jsonl` },
      { id: "s5", file_path: `${R}/projects/-Users-fixture-src-app/s5.jsonl` },
      { id: "s6", file_path: null },
    ]);
    // フォルダ名の残るカーソルは消す（次の走査で切り落としたキーで読み直す）。ほかはそのまま
    expect(db.query("SELECT stream_key FROM ingest_cursor").all()).toEqual([
      { stream_key: "projects/-Users-fixture-src-app/s5.jsonl" },
    ]);
    const dump = JSON.stringify([
      db.query("SELECT * FROM ai_session").all(),
      db.query("SELECT * FROM ingest_cursor").all(),
    ]);
    expect(dump).not.toContain("SENTINEL");
  });
});

describe("0014（D-139）", () => {
  // 在席の区間（D-139 より前の形 = 終わりに T を足したもの）と、その日の待ち。放置を計算し直して比べる
  const OLD: [string, number, number][] = [
    ["p1", at("09:00"), at("10:12")], // 入力 9:00〜10:07
    ["p2", at("10:20"), at("10:25")], // 1回だけ触れた
    ["p3", at("10:40"), at("10:43")], // T の前にスリープで切れた
    ["p4", at("11:00"), at("12:05")],
    ["p5", at("13:00"), at("14:00")], // 最後の区間（今続いている）
  ];
  const fixture = () => {
    const a = asked(at("09:30"), at("10:22"));
    const b = asked(at("10:41"), at("11:30"));
    const c = asked(at("11:50"), at("13:20"));
    return facts({
      turns: [a.t, human(at("10:22")), b.t, human(at("11:30")), c.t, human(at("13:20"))],
      followUps: [a.reply, b.reply, c.reply],
    });
  };
  function asked(end: number, closedAt: number) {
    const t = aiEnd(end, { endedWith: "question" });
    const reply = followUp({
      kind: "reply",
      triggerAt: end,
      triggerTurnId: t.id,
      status: "done",
      closedAt,
      closeReason: "auto:human_input",
    });
    return { t, reply };
  }
  const spans = (db: Database) =>
    db
      .query<PresenceRow & { id: string }, []>(
        "SELECT id, start_at AS start, end_at AS end, seen_until AS seenUntil FROM presence_span ORDER BY start_at",
      )
      .all();
  const before = (tailMin: number | null) => {
    const db = openDatabase(join(dir, `d139-${tailMin}.db`));
    migrate(db, migrations.slice(0, 14));
    if (tailMin !== null)
      db.run(
        "INSERT INTO setting (key, value_json, updated_at, hlc, device_id) VALUES ('presence.tail_min', ?, 1, 'h', 'd')",
        [JSON.stringify(tailMin)],
      );
    for (const [id, s, e] of OLD)
      db.run(
        "INSERT INTO presence_span (id, start_at, end_at, source, updated_at) VALUES (?, ?, ?, 'hid', ?)",
        [id, s, e, e],
      );
    return db;
  };

  test("区間の終わりから T（今の設定。無ければ 5 分）を引き、上限の分かる行に seen_until を入れる", () => {
    const db = before(null);
    const r = migrate(db, migrations, { backupDir: join(dir, "backups") });
    expect(r.applied).toEqual([
      "0014_d139_presence_raw",
      "0015_claude_limit",
      "0016_launch_exit",
      "0017_d218_stored_detail",
      "0018_d238_term_handle",
      "0019_subagent_hook",
      "0020_quota_horizon",
    ]);
    expect(spans(db)).toEqual([
      { id: "p1", start: at("09:00"), end: at("10:07"), seenUntil: null },
      { id: "p2", start: at("10:20"), end: at("10:20"), seenUntil: null },
      { id: "p3", start: at("10:40"), end: at("10:40"), seenUntil: at("10:43") },
      { id: "p4", start: at("11:00"), end: at("12:00"), seenUntil: null },
      { id: "p5", start: at("13:00"), end: at("13:55"), seenUntil: at("14:00") },
    ]);
    // 設定が 10 分なら 10 分を引く
    const db10 = before(10);
    migrate(db10, migrations);
    expect(spans(db10).map((x) => [x.end, x.seenUntil])).toEqual([
      [at("10:02"), null],
      [at("10:20"), at("10:25")],
      [at("10:40"), at("10:43")],
      [at("11:55"), null],
      [at("13:50"), at("14:00")],
    ]);
  });

  test("同じ T で読めば元の区間に戻り、その日の放置・猶予・不在は変わらない。T を変えると数え直せる", () => {
    const db = before(null);
    const now = at("14:00");
    const old = OLD.map(([, s, e]) => [s, e] as [number, number]);
    const pre = compute(fixture(), now, { presence: old });
    expect(pre.summary[D]?.idle).toBeGreaterThan(0);
    migrate(db, migrations);
    const raw = spans(db);
    expect(expandPresence(raw, 5 * MIN)).toEqual(old);
    const post = compute(fixture(), now, { presence: expandPresence(raw, 5 * MIN) });
    expect(post.summary).toEqual(pre.summary);
    expect(post.segments).toEqual(pre.segments);
    // 10 分で読むと、上限の無い区間の終わりが延びて放置が変わる（数え直せる）
    const p10 = compute(fixture(), now, { presence: expandPresence(raw, 10 * MIN) });
    expect(p10.summary).not.toEqual(pre.summary);
  });
});
