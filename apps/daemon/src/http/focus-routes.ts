/**
 * 集中モードの API（D-097。m2-api 25章）:
 * - GET /api/focus（状態・開いている問い・問いの出し方・「次の予定の終わり」）
 * - POST /api/focus/start { minutes: 30 | 60 } | { until: "event_end" }（手動。409 no_event）
 * - POST /api/focus/end
 * - POST /api/focus/prompt { key, answer: "focus" | "skip" }（通知のボタン・帯。開いている問いか、閉じたばかりでまだ続く
 *   予定の問いの key。どちらでもなければ 409 stale）
 * - POST /api/focus/events/:id（「この予定の間は集中する」。D-130。404 not_found / 409 ended）
 * - DELETE /api/focus/events/:id（取り消す。その予定の集中の最中なら終える）
 * 応答の FocusView には、今の集中の間に止めた通知の数（held）を足す（帯の `止めた通知 3`）
 * 4xx はデーモンのログに残す（通知のボタンが効かないときの切り分け。stale は FocusService.answer が詳しく残す）
 */
import { zValidator } from "@hono/zod-validator";
import type { FocusView } from "@turnlane/core/api";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { OpError } from "../derive/ops.ts";
import type { FocusService } from "../focus/service.ts";

const startInput = z.union([
  z.object({ minutes: z.union([z.literal(30), z.literal(60)]) }),
  z.object({ until: z.literal("event_end") }),
]);
const promptInput = z.object({
  key: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_:-]+$/),
  answer: z.enum(["focus", "skip"]),
});

/** FocusView に止めた通知の数を足す（集中していなければ 0） */
export function focusViewWithHeld(f: FocusService): FocusView {
  const v = f.view();
  return { ...v, held: v.active ? f.state.held.length : 0 };
}

export function createFocusRoutes(get: () => FocusService | undefined) {
  const svc = () => {
    const f = get();
    if (!f) throw new OpError(409, "focus_unavailable");
    return f;
  };
  /** 操作をしてから、止めた通知の数を足した FocusView を返す */
  const after = (run: (f: FocusService) => unknown) => {
    const f = svc();
    run(f);
    return focusViewWithHeld(f);
  };
  const invalid = (r: { success: boolean }, c: Context) => {
    if (!r.success) {
      get()?.logRejected(c.req.path, 400, "invalid_input");
      return c.json({ error: "invalid_input" }, 400);
    }
  };
  return new Hono()
    .onError((e, c) => {
      if (e instanceof OpError) {
        if (e.message !== "stale") get()?.logRejected(c.req.path, e.status, e.message);
        return c.json({ error: e.message }, e.status);
      }
      throw e;
    })
    .get("/focus", (c) => c.json(focusViewWithHeld(svc())))
    .post("/focus/start", zValidator("json", startInput, invalid), (c) =>
      c.json(after((f) => f.start(c.req.valid("json")))),
    )
    .post("/focus/end", (c) => c.json(after((f) => f.end())))
    .post("/focus/prompt", zValidator("json", promptInput, invalid), (c) => {
      const b = c.req.valid("json");
      return c.json(after((f) => f.answer(b.key, b.answer)));
    })
    .post("/focus/events/:id", (c) => c.json(after((f) => f.reserve(c.req.param("id")))))
    .delete("/focus/events/:id", (c) => c.json(after((f) => f.cancel(c.req.param("id")))));
}
