import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { FakeClock } from "../src/clock.ts";
import { createDb, type DB } from "../src/db/client.ts";
import { ensureSelfDevice } from "../src/db/device.ts";
import { migrate } from "../src/db/migrate.ts";
import { migrations } from "../src/db/migrations/index.ts";
import {
  getSetting,
  insertRow,
  insertRowIfAbsent,
  type MutateCtx,
  maxChangeLogHlc,
  putSetting,
  RowNotFoundError,
  softDelete,
  updateRow,
} from "../src/db/mutate.ts";
import { openDatabase } from "../src/db/open.ts";
import { changeLog, project, task, workItem } from "../src/db/schema.ts";
import { HlcClock, parseHlc } from "../src/hlc.ts";
import { isUuidV7 } from "../src/ids.ts";

const T0 = Date.parse("2026-10-02T00:00:00Z");
let clock: FakeClock;
let db: DB;
let ctx: MutateCtx;

beforeEach(() => {
  clock = new FakeClock(T0);
  const sqlite = openDatabase(":memory:");
  migrate(sqlite, migrations);
  db = createDb(sqlite);
  const deviceId = ensureSelfDevice(db, clock);
  ctx = { db, clock, hlc: new HlcClock(deviceId, clock), deviceId };
});

const logs = () => db.select().from(changeLog).orderBy(changeLog.seq).all();

const newTask = (title = "書く") =>
  ({ title, laneOrder: "a0", source: "manual" }) as const satisfies Parameters<
    typeof insertRow<typeof task>
  >[2];

describe("insertRow", () => {
  test("id / created_at / updated_at / hlc / device_id を付け、change_log に insert を記録する", () => {
    const row = insertRow(ctx, task, newTask());
    expect(isUuidV7(row.id)).toBe(true);
    expect(row.createdAt).toBe(T0);
    expect(row.updatedAt).toBe(T0);
    expect(row.deviceId).toBe(ctx.deviceId);
    expect(parseHlc(row.hlc).physical).toBe(T0);
    expect(row.syncScope).toBe("synced");
    const [log] = logs();
    expect(log).toMatchObject({ tbl: "task", rowId: row.id, op: "insert", hlc: row.hlc });
    const patch = JSON.parse(log?.patchJson ?? "{}");
    expect(patch).toMatchObject({ title: "書く", lane_order: "a0", source: "manual" });
    expect(log?.pushedAt).toBeNull();
  });

  test("sync_scope='local_only' の行（work_item の既定）は change_log を書かない", () => {
    insertRow(ctx, workItem, {
      groupKey: "session:codex:x",
      status: "running",
      statusChangedAt: T0,
      firstActivityAt: T0,
      lastActivityAt: T0,
    });
    expect(logs()).toHaveLength(0);
  });

  test("制約違反なら何も書かない（トランザクションで巻き戻る）", () => {
    expect(() => insertRow(ctx, task, { ...newTask(), priority: 9 })).toThrow(/CHECK/);
    expect(db.select().from(task).all()).toHaveLength(0);
    expect(logs()).toHaveLength(0);
  });
});

describe("updateRow / softDelete", () => {
  test("変更したフィールドだけを patch_json に入れ、hlc を進める", () => {
    const row = insertRow(ctx, task, newTask());
    clock.advance(1000);
    const updated = updateRow(ctx, task, row.id, { title: "直した", estimateMin: 30 });
    expect(updated.title).toBe("直した");
    expect(updated.updatedAt).toBe(T0 + 1000);
    expect(updated.createdAt).toBe(T0);
    expect(updated.hlc > row.hlc).toBe(true);
    const log = logs()[1];
    expect(log?.op).toBe("update");
    expect(JSON.parse(log?.patchJson ?? "")).toEqual({ title: "直した", estimate_min: 30 });
  });

  test("存在しない行の更新は RowNotFoundError", () => {
    expect(() => updateRow(ctx, task, "nope", { title: "x" })).toThrow(RowNotFoundError);
  });

  test("論理削除は deleted_at を入れ、2回目は何もしない", () => {
    const row = insertRow(ctx, task, newTask());
    clock.advance(5000);
    softDelete(ctx, task, row.id);
    softDelete(ctx, task, row.id);
    const after = db.select().from(task).where(eq(task.id, row.id)).get();
    expect(after?.deletedAt).toBe(T0 + 5000);
    const ops = logs().map((l) => l.op);
    expect(ops).toEqual(["insert", "delete"]);
    expect(JSON.parse(logs()[1]?.patchJson ?? "")).toEqual({ deleted_at: T0 + 5000 });
  });

  test("削除の取り消しは updateRow で deleted_at を null にする", () => {
    const row = insertRow(ctx, task, newTask());
    softDelete(ctx, task, row.id);
    const restored = updateRow(ctx, task, row.id, { deletedAt: null });
    expect(restored.deletedAt).toBeNull();
    expect(JSON.parse(logs()[2]?.patchJson ?? "")).toEqual({ deleted_at: null });
  });
});

describe("insertRowIfAbsent（外部取り込みの冪等性）", () => {
  const external = (title: string) => ({
    ...newTask(title),
    source: "mcp" as const,
    externalSource: "github",
    externalId: "issue-1",
  });
  const where = sql`external_source IS NOT NULL`;

  test("同じ (external_source, external_id) は1件だけ。2回目は既存行を返し、上書きしない", () => {
    const a = insertRowIfAbsent(
      ctx,
      task,
      external("最初"),
      ["externalSource", "externalId"],
      where,
    );
    const b = insertRowIfAbsent(
      ctx,
      task,
      external("二回目"),
      ["externalSource", "externalId"],
      where,
    );
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.row.id).toBe(a.row.id);
    expect(b.row.title).toBe("最初");
    expect(db.select().from(task).all()).toHaveLength(1);
    expect(logs().map((l) => l.op)).toEqual(["insert"]);
  });

  test("ユーザーが削除済みでも作り直さない（削除済みの行を返す）", () => {
    const a = insertRowIfAbsent(ctx, task, external("x"), ["externalSource", "externalId"], where);
    softDelete(ctx, task, a.row.id);
    const b = insertRowIfAbsent(ctx, task, external("x"), ["externalSource", "externalId"], where);
    expect(b.created).toBe(false);
    expect(b.row.deletedAt).not.toBeNull();
  });
});

describe("setting と HLC の復元", () => {
  test("putSetting は upsert。local_only は change_log を書かない", () => {
    putSetting(ctx, "day_boundary", "04:00");
    putSetting(ctx, "day_boundary", "05:00");
    expect(getSetting<string>(db, "day_boundary")).toBe("05:00");
    expect(getSetting(db, "missing")).toBeUndefined();
    expect(logs()).toHaveLength(0);
    putSetting(ctx, "followup.kinds", ["reply"], "synced");
    expect(logs()[0]).toMatchObject({ tbl: "setting", rowId: "followup.kinds", op: "update" });
  });

  test("change_log の最大 hlc から HLC を復元すると、以降の hlc はそれより大きい", () => {
    insertRow(ctx, project, { name: "p1" });
    clock.advance(10);
    const last = insertRow(ctx, project, { name: "p2" }).hlc;
    expect(maxChangeLogHlc(db)).toBe(last);
    clock.set(T0 - 3_600_000); // 時計が戻った端末
    const restored: MutateCtx = {
      ...ctx,
      hlc: new HlcClock(ctx.deviceId, clock, maxChangeLogHlc(db)),
    };
    const next = insertRow(restored, project, { name: "p3" }).hlc;
    expect(next > last).toBe(true);
  });

  test("ensureSelfDevice は2回目以降同じ id を返す", () => {
    expect(ensureSelfDevice(db, clock)).toBe(ctx.deviceId);
  });
});
