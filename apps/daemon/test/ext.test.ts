/**
 * 拡張点（デーモン側。ADR 0015）: テスト用の拡張（ext-fixture/daemon.ts）で、設定・マイグレーション・ルート・start / stop・
 * 通知の保留・スリープさせない がつながることと、拡張なしでは何も増えないことを確かめる
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { FakeClock, resolvePaths } from "@turnlane/core";
import type { QueueItem } from "@turnlane/core/api";
import { checkExtension, loadExtensions } from "../src/ext/host.ts";
import { FakePower, KeepAwake } from "../src/ext/power.ts";
import type { DaemonExtension, DaemonExtensionFactory } from "../src/ext/types.ts";
import type { HealthReport } from "../src/health.ts";
import { type RunningDaemon, startDaemon } from "../src/main.ts";
import { NotifyHolds } from "../src/notify/runner.ts";
import fixture, { testState } from "./ext-fixture/daemon.ts";
import { FakeLaunchSystem } from "./helpers/launch-system.ts";
import { FakeOpenSystem } from "./helpers/open-system.ts";

let home: string;
let daemon: RunningDaemon | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "turnlane-ext-"));
});
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  rmSync(home, { recursive: true, force: true });
});

const call = (d: RunningDaemon, method: string, path: string, body?: unknown) =>
  fetch(`${d.url}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${d.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("拡張なし（公開のビルド）", () => {
  test("health の extensions は空で、/api/ext は 404、設定の一覧に ext. のキーが無い、__ext_migrations も作らない", async () => {
    const paths = resolvePaths({ HOME: home }, home);
    daemon = await startDaemon({ paths, logger: nullLogger, port: 0, ingest: false });
    const h = (await (await call(daemon, "GET", "/health")).json()) as HealthReport;
    expect(h.extensions).toEqual([]);
    expect((await call(daemon, "GET", "/ext/test/ping")).status).toBe(404);
    const cfg = (await (await call(daemon, "GET", "/config")).json()) as {
      values: Record<string, unknown>;
    };
    expect(Object.keys(cfg.values).some((k) => k.startsWith("ext."))).toBe(false);
    expect((await call(daemon, "PUT", "/config/ext.test.greeting", { value: "hi" })).status).toBe(
      404,
    );
    await daemon.stop();
    daemon = null;
    const db = new Database(paths.dbPath);
    const t = db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'ext\\_%' ESCAPE '\\' OR name = '__ext_migrations'",
      )
      .get();
    db.close();
    expect(t?.n).toBe(0);
  });
});

describe("テスト用の拡張", () => {
  test("マイグレーション・ルート・設定・start / stop・スリープさせない がつながる", async () => {
    const paths = resolvePaths({ HOME: home }, home);
    const power = new FakePower();
    const before = { ...testState };
    daemon = await startDaemon({
      paths,
      logger: nullLogger,
      port: 0,
      ingest: false,
      extensions: [fixture],
      power,
    });
    expect(testState.started).toBe(before.started + 1);
    const h = (await (await call(daemon, "GET", "/health")).json()) as HealthReport;
    expect(h.extensions).toEqual(["test"]);

    // ルート（認証は本体と同じ）
    expect((await fetch(`${daemon.url}/api/ext/test/ping`)).status).toBe(401);
    const p1 = (await (await call(daemon, "GET", "/ext/test/ping")).json()) as {
      count: number;
      greeting: string | null;
      launcher: boolean;
    };
    expect(p1).toMatchObject({ count: 1, greeting: null, launcher: false });

    // 設定のキー（turnlane config と同じ /api/config で検証つき）
    expect((await call(daemon, "PUT", "/config/ext.test.greeting", { value: "" })).status).toBe(
      400,
    );
    expect((await call(daemon, "PUT", "/config/ext.test.greeting", { value: "hi" })).status).toBe(
      200,
    );
    const p2 = (await (await call(daemon, "GET", "/ext/test/ping")).json()) as {
      count: number;
      greeting: string | null;
    };
    expect(p2).toMatchObject({ count: 2, greeting: "hi" });
    // 拡張は自分のキーだけ書ける（ExtDeps.settings.set）
    expect((await call(daemon, "PUT", "/ext/test/greeting", { value: "yo" })).status).toBe(200);

    // スリープさせない（取って外す）
    expect((await call(daemon, "POST", "/ext/test/awake")).status).toBe(200);
    expect(power.holds).toBe(1);
    expect(power.holding).toBe(false);

    await daemon.stop();
    daemon = null;
    expect(testState.stopped).toBe(before.stopped + 1);

    // 拡張のテーブルは __ext_migrations で管理し、本体の user_version は変えない
    const db = new Database(paths.dbPath);
    expect(
      db.query<{ id: string }, []>("SELECT ext || '/' || id AS id FROM __ext_migrations").all(),
    ).toEqual([{ id: "test/0001_init" }]);
    db.close();

    // 同じ DB を拡張なしで開いても動く（拡張のテーブルは残る）
    daemon = await startDaemon({ paths, logger: nullLogger, port: 0, ingest: false });
    expect((await call(daemon, "GET", "/health")).status).toBe(200);
    await daemon.stop();
    // もう一度拡張つきで開くとマイグレーションを再適用しない
    daemon = await startDaemon({
      paths,
      logger: nullLogger,
      port: 0,
      ingest: false,
      extensions: [fixture],
    });
    const p3 = (await (await call(daemon, "GET", "/ext/test/ping")).json()) as { count: number };
    expect(p3.count).toBe(3);
  });

  test("予定の事実（calendar.events）と人のいないときの起動（launcher.launch の unattended）", async () => {
    const paths = resolvePaths({ HOME: home }, home);
    const sys = new FakeLaunchSystem();
    sys.paths.add("/w/app");
    sys.locked = true;
    daemon = await startDaemon({
      paths,
      logger: nullLogger,
      port: 0,
      ingest: false,
      calendar: false,
      launch: { cliPath: "/u/bin/turnlane", sys, open: new FakeOpenSystem() },
      extensions: [fixture],
    });
    // 予定: 会議（参加者あり）・会議リンクだけ・ただの予定・空き（free）・終日・取り消し
    const db = new Database(paths.dbPath);
    const T = Date.UTC(2026, 9, 2, 1, 0);
    const H = 3_600_000;
    db.run(
      `INSERT INTO calendar (id, provider, external_id, name, role, is_writable, created_at, updated_at)
       VALUES ('cal1', 'eventkit', 'cal1', 'Work', 'source', 0, 0, 0)`,
    );
    const ev = (
      id: string,
      start: number,
      o: {
        attendees?: number;
        link?: number;
        availability?: string;
        allDay?: number;
        status?: string;
      } = {},
    ) =>
      db.run(
        `INSERT INTO calendar_event (id, calendar_id, external_id, occurrence_start, title, start_at, end_at, all_day, status,
           availability, is_own_timeblock, has_attendees, has_meeting_link, fetched_at)
         VALUES (?, 'cal1', ?, ?, 'secret title', ?, ?, ?, ?, ?, 0, ?, ?, 0)`,
        [
          id,
          id,
          start,
          start,
          start + H,
          o.allDay ?? 0,
          o.status ?? "confirmed",
          o.availability ?? "busy",
          o.attendees ?? 0,
          o.link ?? 0,
        ],
      );
    ev("m1", T, { attendees: 1 });
    ev("m2", T + 2 * H, { link: 1 });
    ev("p1", T + 4 * H);
    ev("f1", T + 5 * H, { availability: "free", attendees: 1 });
    ev("a1", T, { allDay: 1, attendees: 1 });
    ev("c1", T + 6 * H, { status: "cancelled", attendees: 1 });
    db.close();
    const evs = (await (
      await call(daemon, "GET", `/ext/test/events?from=${T - H}&to=${T + 24 * H}`)
    ).json()) as unknown[];
    expect(evs).toEqual([
      { id: "m1", start: T, end: T + H, meeting: true },
      { id: "m2", start: T + 2 * H, end: T + 3 * H, meeting: true },
      { id: "p1", start: T + 4 * H, end: T + 5 * H, meeting: false },
    ]);
    expect(JSON.stringify(evs)).not.toContain("secret");

    // 人のいないときの起動: 画面がロック中は locked。外れても端末が無ければコピーに落とさず not_opened
    const t = (await (
      await call(daemon, "POST", "/tasks", { title: "Update deps", date: "2026-10-02" })
    ).json()) as { task: { id: string } };
    const later = async () =>
      (await (
        await call(daemon as RunningDaemon, "POST", "/ext/test/later", {
          taskId: t.task.id,
          repo: "/w/app",
        })
      ).json()) as { outcome: string; reason?: string };
    expect(await later()).toEqual({ outcome: "locked", reason: "screen_locked" });
    // 端末が Orca でなければロック中は待つ
    expect(await (await call(daemon, "GET", "/ext/test/waits")).json()).toEqual({ waits: true });
    sys.locked = false;
    expect(await later()).toEqual({ outcome: "locked", reason: "not_opened" });
  });

  test("タスクと時間ブロックの口（tasks.update・remove・blocks、timeBlocks、calendar.isWorkday）", async () => {
    const paths = resolvePaths({ HOME: home }, home);
    // 2026-10-01（木）23:00（テストの TZ は Asia/Tokyo）。計画の目安は既定の 10:00〜19:00
    const clock = new FakeClock(Date.UTC(2026, 9, 1, 14, 0));
    daemon = await startDaemon({
      paths,
      logger: nullLogger,
      port: 0,
      ingest: false,
      calendar: false,
      clock,
      extensions: [fixture],
    });
    const H = 3_600_000;
    const D = Date.UTC(2026, 9, 1, 15); // 10/2 0:00 JST
    // 翌日の 10:00〜11:00 に busy な予定
    const db = new Database(paths.dbPath);
    db.run(
      `INSERT INTO calendar (id, provider, external_id, name, role, is_writable, created_at, updated_at)
       VALUES ('cal1', 'eventkit', 'cal1', 'Work', 'source', 0, 0, 0)`,
    );
    db.run(
      `INSERT INTO calendar_event (id, calendar_id, external_id, occurrence_start, title, start_at, end_at, all_day, status,
         availability, is_own_timeblock, has_attendees, has_meeting_link, fetched_at)
       VALUES ('e1', 'cal1', 'e1', ?, 'x', ?, ?, 0, 'confirmed', 'busy', 0, 0, 0, 0)`,
      [D + 10 * H, D + 10 * H, D + 11 * H],
    );
    db.close();
    type Made = {
      task: { id: string; estimateMin: number; scheduledDate: string; origin: unknown } | null;
      block: { id: string; start: number; end: number } | null;
      workday: boolean;
    };
    const made = (await (
      await call(daemon, "POST", "/ext/test/tasks", {
        title: "Look back",
        date: "2026-10-02",
        estimateMin: 15,
      })
    ).json()) as Made;
    expect(made.workday).toBe(true);
    expect(made.task?.origin).toMatchObject({ externalSource: "ext.test" });
    // 予定の後の最初の空き
    expect(made.block).toMatchObject({ start: D + 11 * H, end: D + 11 * H + 15 * 60_000 });
    const id = made.task?.id ?? "";
    const blockId = made.block?.id ?? "";
    // ボードにも出る（本体の時間ブロックと同じ）
    const board = (await (await call(daemon, "GET", "/day/2026-10-02")).json()) as {
      day: { timeBlocks: { id: string; taskId: string }[]; freeSlots: { start: number }[] };
    };
    expect(board.day.timeBlocks.map((b) => b.id)).toContain(blockId);
    expect(board.day.freeSlots[0]?.start).toBe(D + 11 * H + 15 * 60_000);

    // 土曜は稼働日でなく、空き枠も無い
    const sat = (await (
      await call(daemon, "POST", "/ext/test/tasks", {
        title: "Sat",
        date: "2026-10-03",
        estimateMin: 15,
      })
    ).json()) as Made;
    expect(sat.workday).toBe(false);
    expect(sat.block).toBeNull();

    // 変える: 見積と日付（渡したものだけ）
    const up = (await (
      await call(daemon, "PUT", `/ext/test/tasks/${id}`, { estimateMin: 30, date: "2026-10-05" })
    ).json()) as { task: { estimateMin: number; scheduledDate: string; title: unknown } };
    expect(up.task).toMatchObject({
      estimateMin: 30,
      scheduledDate: "2026-10-05",
      title: { t: "text", text: "Look back" },
    });
    const blocks = async () =>
      (await (
        await call(daemon as RunningDaemon, "GET", `/ext/test/tasks/${id}/blocks`)
      ).json()) as { id: string; start: number; end: number }[];
    expect((await blocks()).map((b) => b.id)).toEqual([blockId]);
    const moved = (await (
      await call(daemon, "PUT", `/ext/test/blocks/${blockId}`, { endAt: D + 11 * H + 30 * 60_000 })
    ).json()) as { block: { end: number } };
    expect(moved.block.end).toBe(D + 11 * H + 30 * 60_000);
    expect((await call(daemon, "DELETE", `/ext/test/blocks/${blockId}`)).status).toBe(200);
    expect(await blocks()).toEqual([]);
    // 消したブロックは null、2回目の削除は何もしない
    expect(
      await (
        await call(daemon, "PUT", `/ext/test/blocks/${blockId}`, { endAt: D + 12 * H })
      ).json(),
    ).toEqual({ block: null });
    expect((await call(daemon, "DELETE", `/ext/test/blocks/${blockId}`)).status).toBe(200);

    // タスクを消す。消したタスクの変更は null、ブロックは空、2回目の削除も何もしない
    expect((await call(daemon, "DELETE", `/ext/test/tasks/${id}`)).status).toBe(200);
    expect((await call(daemon, "GET", `/tasks/${id}`)).status).toBe(404);
    expect(
      await (await call(daemon, "PUT", `/ext/test/tasks/${id}`, { estimateMin: 10 })).json(),
    ).toEqual({ task: null });
    expect(await blocks()).toEqual([]);
    expect((await call(daemon, "DELETE", `/ext/test/tasks/${id}`)).status).toBe(200);
  });

  test("版の合わない拡張・接頭辞の違う設定のキーは組み込まない", async () => {
    const wrongVersion: DaemonExtensionFactory = (host) => ({
      ...fixture(host),
      apiVersion: host.apiVersion + 1,
    });
    const badKey: DaemonExtensionFactory = (host) => ({
      ...fixture(host),
      id: "other",
      migrations: [],
    });
    expect(loadExtensions([wrongVersion, badKey], nullLogger)).toEqual([]);
    const ok = loadExtensions([fixture, fixture], nullLogger);
    expect(ok.map((e) => e.id)).toEqual(["test"]);
    expect(() => checkExtension({ id: "Bad", apiVersion: 1 } as DaemonExtension)).toThrow();
  });

  test("本体のテーブルに触れるマイグレーションの拡張では起動しない", async () => {
    const evil: DaemonExtensionFactory = (host) => ({
      ...fixture(host),
      migrations: [{ id: "0001_init", sql: "DROP TABLE task" }],
    });
    const paths = resolvePaths({ HOME: home }, home);
    await expect(
      startDaemon({ paths, logger: nullLogger, port: 0, ingest: false, extensions: [evil] }),
    ).rejects.toThrow(/ext_test_/);
  });
});

describe("部品", () => {
  const item = (id: string, title: string): QueueItem => ({
    workItemId: id,
    title,
    status: "your_turn",
    reason: null,
    estimated: false,
    repoRoot: null,
    branch: null,
    prRef: null,
    sources: [],
    waitingSince: 0,
    waitStartedAway: false,
    followUps: [],
  });

  test("通知の保留: 当たったカードを外して渡す。まとめは残りがあれば残す。外したら効かない", () => {
    const holds = new NotifyHolds();
    const got: string[] = [];
    const off = holds.add(
      (x) => (x.title ?? "").includes("[hold]"),
      (xs) => got.push(...xs.map((x) => x.workItemId)),
    );
    const out = holds.apply([
      { kind: "immediate", item: item("a", "[hold] a") },
      { kind: "immediate", item: item("b", "b") },
      { kind: "batch", items: [item("c", "[hold] c"), item("d", "d")] },
      { kind: "batch", items: [item("e", "[hold] e")] },
    ]);
    expect(
      out.map((n) =>
        n.kind === "immediate" ? n.item.workItemId : n.items.map((x) => x.workItemId).join("+"),
      ),
    ).toEqual(["b", "d"]);
    expect(got).toEqual(["a", "c", "e"]);
    off();
    expect(holds.apply([{ kind: "immediate", item: item("a", "[hold] a") }])).toHaveLength(1);
  });

  test("スリープさせない: 理由が1つ以上ある間だけ保持する", () => {
    const p = new FakePower();
    const k = new KeepAwake(p);
    const a = k.keepAwake("a");
    const b = k.keepAwake("b");
    expect(p.holding).toBe(true);
    expect(p.holds).toBe(1);
    a();
    a();
    expect(p.holding).toBe(true);
    b();
    expect(p.holding).toBe(false);
  });
});
