/**
 * テスト用の拡張（デーモン側。ADR 0015）。拡張点がつながることだけを確かめる（中身は無い）。
 * 実行時に import するのは型だけ（拡張のリポジトリと同じ書き方）
 *
 * - 設定のキー `ext.test.greeting`、テーブル `ext_test_ping`
 * - GET /api/ext/test/ping: 呼ぶたびに1行足し、件数・設定・本体の部品の値を返す
 * - POST /api/ext/test/awake: スリープさせないを取って外す
 * - GET /api/ext/test/events?from&to: 予定の事実（calendar.events）
 * - POST /api/ext/test/later {taskId, repo}: 人のいないときの起動（launcher.launch の unattended）
 * - GET /api/ext/test/waits: 人のいないときの起動がロック中に待つか（launcher.waitsWhileLocked）
 * - GET /api/ext/test/marks?from&to: 時間軸の印の位置（範囲の終わりの4時間前を30分に丸めた時刻と、未完了のタスク1件）
 * - GET /api/ext/test/power: 電源とふたの状態（power.state）
 * - GET /api/ext/test/limits?account: Claude の利用枠（limits.claude。account を省略すると既定のアカウント）
 * - GET /api/ext/test/ai?taskId: タスクの頼んだ AI の状態とエラーの種類（tasks.get(id).ai の errorKind）
 * - POST /api/ext/test/tasks {title, date, estimateMin}: 拡張のタスク（external の source `ext.test`）を作り、その日の
 *   最初の空き枠（calendar.freeSlots）に見積の長さの時間ブロックを置く。稼働日か（calendar.isWorkday）も返す
 * - PUT /api/ext/test/tasks/:id {title?, notes?, estimateMin?, date?}・DELETE /api/ext/test/tasks/:id: tasks.update・tasks.remove
 * - GET /api/ext/test/tasks/:id/blocks: tasks.blocks
 * - PUT /api/ext/test/blocks/:id {startAt?, endAt?}・DELETE /api/ext/test/blocks/:id: timeBlocks.update・timeBlocks.remove
 * - POST /api/ext/test/tasks/:id/complete・POST /api/ext/test/tasks/:id/reopen {followUps?}: tasks.complete・tasks.reopen
 * - POST /api/ext/test/oneshot {tool, account?, schema?}: AI の1回の実行（ai.runOneShot。アカウントと応答の形）
 * - GET /api/ext/test/diff/:launchId・POST /api/ext/test/discard/:launchId: review.diff・launcher.discard
 * - start: 起動したことを記録し、stop で外す。通知の保留を1つ足す（題名に `[hold]` を含むカードを止める）。
 */
import type { DaemonExtension, DaemonExtHost } from "../../src/ext/types.ts";

export const testState: {
  started: number;
  stopped: number;
  held: number;
} = { started: 0, stopped: 0, held: 0 };

export default function create(host: DaemonExtHost): DaemonExtension {
  const { z } = host;
  return {
    id: "test",
    apiVersion: host.apiVersion,
    configSchemas: { "ext.test.greeting": z.string().min(1).max(40) },
    migrations: [
      {
        id: "0001_init",
        sql: "CREATE TABLE ext_test_ping (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL)",
      },
    ],
    routes(app, deps) {
      app.get("/ping", (c) => {
        deps.sqlite.run("INSERT INTO ext_test_ping (at) VALUES (?)", [deps.clock.now()]);
        const n =
          deps.sqlite.query<{ n: number }, []>("SELECT count(*) AS n FROM ext_test_ping").get()
            ?.n ?? 0;
        deps.events.publish();
        return c.json({
          pong: true,
          count: n,
          greeting: deps.settings.get<string>("ext.test.greeting") ?? null,
          tz: deps.settings.core().tz,
          launcher: deps.launcher.available(),
          lastActiveAt: deps.presence.lastActiveAt(),
        });
      });
      app.put("/greeting", async (c) => {
        const b = (await c.req.json()) as { value?: unknown };
        try {
          return c.json({ value: deps.settings.set("ext.test.greeting", b.value) });
        } catch {
          return c.json({ error: "invalid_value" }, 400);
        }
      });
      app.get("/events", (c) =>
        c.json(deps.calendar.events(Number(c.req.query("from")), Number(c.req.query("to")))),
      );
      app.post("/later", async (c) => {
        const b = (await c.req.json()) as { taskId: string; repo: string };
        const r = await deps.launcher.launch(
          { taskId: b.taskId, repo: b.repo, tool: "claude_code", worktree: false },
          "schedule",
          { unattended: true },
        );
        return c.json(r);
      });
      app.get("/waits", (c) => c.json({ waits: deps.launcher.waitsWhileLocked() }));
      app.get("/marks", (c) => {
        const from = Number(c.req.query("from"));
        const to = Number(c.req.query("to"));
        const half = 30 * 60_000;
        const task = deps.sqlite
          .query<{ id: string }, []>(
            "SELECT id FROM task WHERE deleted_at IS NULL AND status NOT IN ('done', 'canceled') ORDER BY created_at, id LIMIT 1",
          )
          .get();
        return c.json({
          at: Math.round(Math.max(from, to - 4 * 3_600_000) / half) * half,
          taskId: task?.id ?? null,
        });
      });
      app.get("/power", async (c) => c.json(await deps.power.state()));
      app.get("/limits", (c) => c.json({ limits: deps.limits.claude(c.req.query("account")) }));
      app.get("/ai", (c) => {
        const ai = deps.tasks.get(c.req.query("taskId") ?? "")?.ai ?? null;
        return c.json({ state: ai?.state ?? null, errorKind: ai?.errorKind ?? null });
      });
      app.post("/tasks", async (c) => {
        const b = (await c.req.json()) as { title: string; date: string; estimateMin: number };
        const task = deps.tasks.create({
          title: b.title,
          date: b.date,
          estimateMin: b.estimateMin,
          external: { source: "ext.test", id: `${b.date}:${b.title}` },
        });
        const dur = b.estimateMin * 60_000;
        const slot = deps.calendar.freeSlots(b.date).find((x) => x.end - x.start >= dur);
        const block =
          task && slot
            ? deps.timeBlocks.create({
                taskId: task.id,
                startAt: slot.start,
                endAt: slot.start + dur,
              })
            : null;
        return c.json({ task, block, workday: deps.calendar.isWorkday(b.date) });
      });
      app.put("/tasks/:id", async (c) =>
        c.json({ task: deps.tasks.update(c.req.param("id"), await c.req.json()) }),
      );
      app.delete("/tasks/:id", (c) => {
        deps.tasks.remove(c.req.param("id"));
        return c.json({ ok: true });
      });
      app.get("/tasks/:id/blocks", (c) => c.json(deps.tasks.blocks(c.req.param("id"))));
      app.put("/blocks/:id", async (c) =>
        c.json({ block: deps.timeBlocks.update(c.req.param("id"), await c.req.json()) }),
      );
      app.delete("/blocks/:id", (c) => {
        deps.timeBlocks.remove(c.req.param("id"));
        return c.json({ ok: true });
      });
      app.post("/tasks/:id/complete", (c) => {
        deps.tasks.complete(c.req.param("id"));
        return c.json({ ok: true });
      });
      app.post("/tasks/:id/reopen", async (c) => {
        const b = (await c.req.json()) as { followUps?: string[] };
        return c.json({
          task: deps.tasks.reopen(c.req.param("id"), b.followUps ? { followUps: b.followUps } : {}),
        });
      });
      app.post("/oneshot", async (c) => {
        const b = (await c.req.json()) as {
          tool: "claude_code" | "codex";
          account?: string;
          schema?: Record<string, unknown>;
        };
        return c.json(
          await deps.ai.runOneShot({
            tool: b.tool,
            input: "stats only",
            timeoutMs: 5000,
            ...(b.account ? { claudeAccount: b.account } : {}),
            ...(b.schema ? { schema: b.schema } : {}),
          }),
        );
      });
      app.get("/diff/:id", async (c) => {
        try {
          return c.json({ diff: await deps.review.diff(c.req.param("id"), { maxFiles: 5 }) });
        } catch (e) {
          return c.json({ error: (e as Error).message }, 409);
        }
      });
      app.post("/discard/:id", async (c) => {
        try {
          return c.json(await deps.launcher.discard(c.req.param("id")));
        } catch (e) {
          return c.json({ error: (e as Error).message }, 409);
        }
      });
      app.post("/awake", (c) => {
        const release = deps.power.keepAwake("test");
        release();
        return c.json({ ok: true });
      });
    },
    start(deps) {
      testState.started += 1;
      const unhold = deps.notify.hold(
        (item) => (item.title ?? "").includes("[hold]"),
        (items) => {
          testState.held += items.length;
        },
      );
      return {
        stop() {
          unhold();
          testState.stopped += 1;
        },
      };
    },
  };
}
