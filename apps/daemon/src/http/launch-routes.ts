/**
 * タスクから AI に頼む（D-107・D-109 の無料の部分。m2-api 27章）の API。
 * 受け取り（claim）は turnlane ai run（Bearer）だけが呼べる。ブラウザ（クッキー）からは 403
 */
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { OpError } from "../derive/ops.ts";
import type { LaunchService } from "../launch/service.ts";

const invalid = (r: { success: boolean }, c: { json: (b: unknown, s: 400) => Response }) => {
  if (!r.success) return c.json({ error: "invalid_input" }, 400);
  return undefined;
};

const tool = z.enum(["claude_code", "codex"]);
const launchId = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) });
const launchInput = z
  .object({
    taskId: z.string().min(1).max(64),
    repo: z.string().min(1).max(1024),
    tool,
    templateId: z.string().min(1).max(64).optional(),
    worktree: z.boolean(),
    instruction: z.string().max(4000).optional(),
    claudeAccount: z.string().min(1).max(1024).optional(),
  })
  .strict();
const templateInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(8000),
    tool: tool.nullable(),
    readOnly: z.boolean(),
    worktree: z.boolean().nullable(),
  })
  .strict();

export function createLaunchRoutes(
  get: () => LaunchService | undefined,
  isBearer: (c: Context) => boolean,
) {
  const svc = () => {
    const s = get();
    if (!s) throw new OpError(409, "launch_unavailable");
    return s;
  };
  return (
    new Hono()
      .onError((e, c) => {
        if (e instanceof OpError) return c.json({ error: e.message }, e.status);
        throw e;
      })
      .get(
        "/ai/launch-options",
        zValidator("query", z.object({ taskId: z.string().min(1).max(64).optional() }), invalid),
        async (c) => c.json(await svc().options(c.req.valid("query").taskId ?? null)),
      )
      // 設定 > AI の Claude のアカウント（D-122。名前の変更・外すは /api/config の ai.claude_accounts）
      .get("/ai/claude-accounts", (c) => c.json(svc().claudeAccounts()))
      .post("/ai/launches", zValidator("json", launchInput, invalid), async (c) =>
        c.json(await svc().launch(c.req.valid("json"))),
      )
      .post("/ai/launches/:id/claim", zValidator("param", launchId, invalid), (c) => {
        if (!isBearer(c)) return c.json({ error: "forbidden" }, 403);
        return c.json(svc().claim(c.req.valid("param").id));
      })
      .post(
        "/ai/launches/:id/fail",
        zValidator("param", launchId, invalid),
        zValidator("json", z.object({ reason: z.literal("cli_missing") }).strict(), invalid),
        (c) => {
          if (!isBearer(c)) return c.json({ error: "forbidden" }, 403);
          svc().fail(c.req.valid("param").id, c.req.valid("json").reason);
          return c.json({ ok: true });
        },
      )
      // turnlane ai run が、AI の CLI の終了コードと始めてから終わるまでの時間を知らせる（セッションが見つからないときの理由）
      .post(
        "/ai/launches/:id/exit",
        zValidator("param", launchId, invalid),
        zValidator(
          "json",
          z
            .object({
              code: z.number().int().min(-1024).max(1024),
              afterMs: z
                .number()
                .int()
                .min(0)
                .max(366 * 24 * 3600_000),
            })
            .strict(),
          invalid,
        ),
        (c) => {
          if (!isBearer(c)) return c.json({ error: "forbidden" }, 403);
          const b = c.req.valid("json");
          svc().exited(c.req.valid("param").id, b.code, b.afterMs);
          return c.json({ ok: true });
        },
      )
      // 紐づかなかった依頼のフォルダをターミナルで開いて信頼する（B-5）
      .post("/ai/launches/:id/open-for-trust", zValidator("param", launchId, invalid), async (c) =>
        c.json(await svc().openForTrustOf(c.req.valid("param").id)),
      )
      .get("/ai/launches/:id/candidates", zValidator("param", launchId, invalid), (c) =>
        c.json(svc().candidates(c.req.valid("param").id)),
      )
      .post(
        "/ai/launches/:id/link",
        zValidator("param", launchId, invalid),
        zValidator("json", z.object({ sessionId: z.string().min(1).max(64) }).strict(), invalid),
        (c) => {
          svc().link(c.req.valid("param").id, c.req.valid("json").sessionId);
          return c.json({ ok: true });
        },
      )
      .post(
        "/ai/launches/:id/cleanup",
        zValidator("param", launchId, invalid),
        zValidator("json", z.object({ force: z.boolean() }).strict(), invalid),
        async (c) =>
          c.json(await svc().cleanup(c.req.valid("param").id, c.req.valid("json").force)),
      )
      // 完了のときの片付け（完了のシート）: AI を終了してタブを閉じる → worktree を消す。タスクの完了は画面が続けて呼ぶ
      .post(
        "/ai/launches/:id/finish",
        zValidator("param", launchId, invalid),
        zValidator(
          "json",
          z
            .object({ closeTerminal: z.boolean(), removeWorktree: z.boolean(), force: z.boolean() })
            .strict(),
          invalid,
        ),
        async (c) => c.json(await svc().finish(c.req.valid("param").id, c.req.valid("json"))),
      )
      // 完了にするタスクのうち、起動が生きている依頼（空ならシートを出さない）。taskIds はカンマ区切り
      .get(
        "/ai/finish-plan",
        zValidator(
          "query",
          z.object({
            taskIds: z
              .string()
              .max(64 * 51)
              .transform((v) => v.split(",").filter((x) => x.length > 0 && x.length <= 64)),
          }),
          invalid,
        ),
        async (c) => c.json(await svc().finishPlan(c.req.valid("query").taskIds)),
      )
      .post("/ai/launches/:id/test", zValidator("param", launchId, invalid), (c) =>
        c.json(svc().runTest(c.req.valid("param").id)),
      )
      .get(
        "/ai/check",
        zValidator(
          "query",
          z
            .object({
              workItemId: z.string().min(1).max(64).optional(),
              launchId: z
                .string()
                .regex(/^[0-9a-f]{32}$/)
                .optional(),
            })
            .refine((q) => (q.workItemId === undefined) !== (q.launchId === undefined)),
          invalid,
        ),
        async (c) => {
          const q = c.req.valid("query");
          return c.json(
            await svc().check(
              q.launchId ? { launchId: q.launchId } : { workItemId: q.workItemId ?? "" },
            ),
          );
        },
      )
      .get("/ai/templates", (c) => c.json(svc().templates()))
      .post("/ai/templates", zValidator("json", templateInput, invalid), (c) =>
        c.json(svc().saveTemplate(null, c.req.valid("json"))),
      )
      .patch(
        "/ai/templates/:id",
        zValidator("param", z.object({ id: z.string().min(1).max(64) }), invalid),
        zValidator("json", templateInput, invalid),
        (c) => c.json(svc().saveTemplate(c.req.valid("param").id, c.req.valid("json"))),
      )
      .delete(
        "/ai/templates/:id",
        zValidator("param", z.object({ id: z.string().min(1).max(64) }), invalid),
        (c) => {
          svc().deleteTemplate(c.req.valid("param").id);
          return c.json({ ok: true });
        },
      )
  );
}
