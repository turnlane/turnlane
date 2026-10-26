/**
 * Claude の利用枠の受け口（POST /api/limits/claude）。Turnlane が起動した Claude Code の statusLine（`turnlane statusline`）
 * だけが Bearer で呼ぶ。ブラウザ（クッキー）からは 403。受け取るのはアカウント（設定ディレクトリ）と、5時間・7日の
 * 使用率とリセットの時刻（ms）だけ
 */
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { ClaudeLimitsStore } from "../limits/claude.ts";

const window = z
  .object({ usedPercentage: z.number().min(0).max(1000), resetsAt: z.number().int().positive() })
  .strict();
const body = z
  .object({
    account: z.string().min(1).max(1024).startsWith("/"),
    fiveHour: window.optional(),
    sevenDay: window.optional(),
  })
  .strict();

export function createLimitsRoutes(
  get: () => ClaudeLimitsStore | undefined,
  isBearer: (c: Context) => boolean,
) {
  return new Hono().post(
    "/limits/claude",
    zValidator("json", body, (r, c) => {
      if (!r.success) return c.json({ error: "invalid_input" }, 400);
      return undefined;
    }),
    (c) => {
      if (!isBearer(c)) return c.json({ error: "forbidden" }, 403);
      const s = get();
      if (!s) return c.json({ error: "limits_unavailable" }, 409);
      const b = c.req.valid("json");
      s.record(b.account, {
        ...(b.fiveHour ? { fiveHour: b.fiveHour } : {}),
        ...(b.sevenDay ? { sevenDay: b.sevenDay } : {}),
      });
      return c.json({ ok: true });
    },
  );
}
