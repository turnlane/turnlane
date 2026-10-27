/**
 * AI 取り込み・自分の番の API（phase0-plan 3.4 のうち M1 で使うもの）。
 * 入力は手で検証する（M2 で Zod スキーマを core/types.ts に置くときに置き換える）。
 */

import { zValidator } from "@hono/zod-validator";
import { ANSWER_MAX, isLocalDate, OPEN_ACTIONS } from "@turnlane/core";
import type {
  AiLiveResponse,
  AwayResponse,
  GlanceResponse,
  LiveItem,
  OpenAction,
  QueueResponse,
  QueueSummaryResponse,
  ReadMeta,
} from "@turnlane/core/api";
import { mergeWorkItemInput, snoozeInput } from "@turnlane/core/api";
import { queueSummary, type UpdateMenuItem } from "@turnlane/core/web";
import { Hono } from "hono";
import { z } from "zod";
import type { Answerer } from "../answer/index.ts";
import { OpError, type UserOps } from "../derive/ops.ts";
import type { AiDaysView, QueueItem, queueExtras } from "../derive/views.ts";
import type { FocusService } from "../focus/service.ts";
import type { Opener } from "../open/index.ts";

export interface SourceView {
  id: string;
  tool: string;
  rootPath: string;
  profileLabel: string | null;
  enabled: boolean;
  hooksState: string;
  /**
   * MCP の登録（D-145）: installed / none / outdated（別の turnlane を指す）/ unreadable（設定が読めない）/
   * unknown（Claude Code / Codex 以外、同意の前）
   */
  mcpState: "installed" | "none" | "outdated" | "unreadable" | "unknown";
  healthLevel: string;
  healthReason: string | null;
  detectedVersion: string | null;
  lastIngestAt: number | null;
  lastHookAt: number | null;
  excludeGlobs: string[];
  includeGlobs: string[];
}

export interface AiDeps {
  days(date: string | undefined, days: number): AiDaysView;
  detail(id: string): unknown;
  /**
   * 待っている件の中身を表示の瞬間に読む（D-207、ADR 0005 の追記 2）。AI 項目が無ければ null。結果は応答にだけ入れ、
   * ログ・SSE・MCP・通知には出さない
   */
  glance(id: string): GlanceResponse | null;
  /** 保存した待ちの中身の件数（設定 › データ。ADR 0018） */
  storedDetail(): { instructions: number; waits: number };
  /** 保存した待ちの中身を消す（指示の 1 行目と待ちの中身。ADR 0018） */
  clearStoredDetail(): { instructions: number; waits: number };
  queue(): QueueItem[];
  /** 猶予中の問い（D-245。返答タスクの無い問いの待ち。GET /api/queue の grace だけに出す） */
  graceQueue?(): QueueItem[];
  /** リセット前の上限待ち（GET /api/queue の limitWaits。自分の番の画面の「後で」だけに出す） */
  limitQueue?(): QueueItem[];
  /** AI の画面の生きている AI 項目の候補（GET /api/ai/live。m2-api 33章） */
  live?(): Promise<LiveItem[]>;
  /** 離れていた間のまとめ（ux-mvp 4.13、D-214 (2)）。出さないときは digest: null */
  away(): Promise<AwayResponse>;
  /** まとめを閉じる（key = 戻った時刻。同じ離席のまとめはもう出さない） */
  dismissAway(key: string): void;
  /** タスクから開く（D-059。m2-api 13章） */
  opener: Opener;
  /** Turnlane から答える（D-238。m2-api 31章） */
  answerer: Answerer;
  /** スヌーズのプリセットの時刻（明日朝 = 次の稼働日の計画の目安の開始。D-064・D-106） */
  snoozeUntil(preset: "30m" | "1h" | "tomorrow_morning"): number;
  queueExtras(): ReturnType<typeof queueExtras>;
  meta(): ReadMeta;
  ops: UserOps;
  sources(): SourceView[];
  patchSource(
    id: string,
    p: {
      enabled?: boolean;
      excludeGlobs?: string[];
      includeGlobs?: string[];
      profileLabel?: string;
    },
  ): void;
  rescan(): Promise<void>;
  reingest(sourceId?: string): Promise<void>;
  rederive(opts: { waitSince?: string }): unknown;
  ingestStatus(): { backfillDone: boolean };
}

/** API に返すフォローアップ（DB の行から必要な列だけ） */
export interface FollowUpView {
  id: string;
  workItemId: string;
  kind: string;
  status: string;
  triggerAt: number;
  snoozeUntil: number | null;
  engagedAt: number | null;
  closedAt: number | null;
  closeReason: string | null;
  taskId: string | null;
}

function fuView(r: {
  id: string;
  work_item_id: string;
  kind: string;
  status: string;
  trigger_at: number;
  snooze_until: number | null;
  engaged_at: number | null;
  closed_at: number | null;
  close_reason: string | null;
  task_id: string | null;
}): FollowUpView {
  return {
    id: r.id,
    workItemId: r.work_item_id,
    kind: r.kind,
    status: r.status,
    triggerAt: r.trigger_at,
    snoozeUntil: r.snooze_until,
    engagedAt: r.engaged_at,
    closedAt: r.closed_at,
    closeReason: r.close_reason,
    taskId: r.task_id,
  };
}

function bad(message: string): never {
  throw new OpError(400, message);
}

async function body(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const v = await c.req.json();
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : bad("body must be an object");
  } catch (e) {
    if (e instanceof OpError) throw e;
    return {};
  }
}

const strList = (v: unknown, k: string): string[] | undefined => {
  if (v === undefined) return undefined;
  return Array.isArray(v) && v.every((x) => typeof x === "string")
    ? (v as string[])
    : bad(`${k} must be a string array`);
};

const patchWorkItemInput = z.object({
  titleUser: z.string().max(500).nullable().optional(),
  hidden: z.boolean().optional(),
  manualDone: z.boolean().optional(),
});
const openRef = {
  followUpId: z.string().min(1).max(64).optional(),
  workItemId: z.string().min(1).max(64).optional(),
};
/** ID はどちらか1つ。開く先（パス・URL・コマンド）は受け取らない（m2-api 13章） */
const oneId = (v: { followUpId?: string | undefined; workItemId?: string | undefined }) =>
  (v.followUpId === undefined) !== (v.workItemId === undefined);
const openInput = z
  .object({ ...openRef, action: z.enum(OPEN_ACTIONS as [OpenAction, ...OpenAction[]]).optional() })
  .strict()
  .refine(oneId);
const openQuery = z.object(openRef).strict().refine(oneId);
const ref = (v: { followUpId?: string | undefined; workItemId?: string | undefined }) => ({
  ...(v.followUpId !== undefined ? { followUpId: v.followUpId } : {}),
  ...(v.workItemId !== undefined ? { workItemId: v.workItemId } : {}),
});
/** 答え: 文か、許可待ちの「許可する」（m2-api 31章）。どちらか 1 つ */
const answerInput = z.union([
  z.object({ text: z.string().min(1).max(ANSWER_MAX) }).strict(),
  z.object({ allow: z.literal(true) }).strict(),
]);
const bulkInput = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) });

/** 入力の検証に失敗したら 400 { error: "invalid_input" } */
const invalid = (r: { success: boolean }, c: { json: (b: unknown, s: 400) => Response }) => {
  if (!r.success) return c.json({ error: "invalid_input" }, 400);
};

export function createAiRoutes(
  get: () => AiDeps | undefined,
  /** デスクトップアプリがつながっているか（QueueResponse.desktopNotifier。desktop-shell.md 3.4） */
  desktopNotifier: () => boolean = () => false,
  /** 集中モード（QueueResponse.focus と、メニューバーの件数に足す表示。D-097） */
  focus: () => Pick<FocusService, "queueFocus" | "summaryExtras"> | undefined = () => undefined,
  /** メニューバーの更新の知らせ（M6-17。新しい版が無ければ null） */
  updateMenu: () => UpdateMenuItem | null = () => null,
) {
  const deps = () => {
    const d = get();
    if (!d) throw new OpError(409, "ingestion is not running");
    return d;
  };
  return (
    new Hono()
      .onError((e, c) => {
        if (e instanceof OpError) return c.json({ error: e.message }, e.status);
        throw e;
      })
      .get("/work-items", (c) => {
        const date = c.req.query("date");
        if (date !== undefined && !isLocalDate(date)) bad("date must be YYYY-MM-DD");
        const days = Number(c.req.query("days") ?? "1");
        if (!Number.isInteger(days) || days < 1 || days > 62) bad("days must be 1..62");
        return c.json(deps().days(date, days));
      })
      .get("/work-items/:id", (c) => {
        const d = deps().detail(c.req.param("id"));
        return d ? c.json(d) : c.json({ error: "not_found" }, 404);
      })
      // 待っている件の中身（D-207）。読んだ中身はこの応答にだけ入れる。ブラウザ・WebView にも残さない（no-store）
      .get("/work-items/:id/glance", (c) => {
        c.header("Cache-Control", "no-store");
        const g = deps().glance(c.req.param("id"));
        return g ? c.json(g) : c.json({ error: "not_found" }, 404);
      })
      // Turnlane から答える（D-238）: 待ちの中身（問いの全文は表示の瞬間に読む。保存しない）と届け先。no-store
      .get("/work-items/:id/wait", async (c) => {
        c.header("Cache-Control", "no-store");
        const w = await deps().answerer.wait(c.req.param("id"));
        return w ? c.json(w) : c.json({ error: "not_found" }, 404);
      })
      // 答えをその端末のタブに文字として届ける。答えの文は保存しない（ログは文字数と届け先の種類だけ）
      .post("/work-items/:id/answer", zValidator("json", answerInput, invalid), async (c) => {
        c.header("Cache-Control", "no-store");
        return c.json(await deps().answerer.answer(c.req.param("id"), c.req.valid("json")));
      })
      // 保存した待ちの中身（ADR 0018、D-218）: 件数と、消す操作
      .get("/stored-detail", (c) => c.json(deps().storedDetail()))
      .delete("/stored-detail", (c) => c.json(deps().clearStoredDetail()))
      .patch("/work-items/:id", zValidator("json", patchWorkItemInput, invalid), (c) => {
        const b = c.req.valid("json");
        deps().ops.patchWorkItem(c.req.param("id"), {
          ...(b.titleUser !== undefined ? { titleUser: b.titleUser } : {}),
          ...(b.hidden !== undefined ? { hidden: b.hidden } : {}),
          ...(b.manualDone !== undefined ? { manualDone: b.manualDone } : {}),
        });
        return c.json({ ok: true });
      })
      // AI カードを別の AI カードへ落とした統合（m2-api 19章）
      .post("/work-items/:id/merge", zValidator("json", mergeWorkItemInput, invalid), (c) => {
        const d = deps();
        d.ops.mergeWorkItem(c.req.param("id"), c.req.valid("json").intoId);
        return c.json({ rev: d.meta().rev, ok: true });
      })
      // リセット前の上限待ちの対応不要（自分の番の画面の「後で」。m2-api 2.3）: 明けた後の「再開できる」を出さない
      .post("/work-items/:id/dismiss-limit", (c) => {
        const d = deps();
        return c.json({
          rev: d.meta().rev,
          followUp: fuView(d.ops.dismissLimit(c.req.param("id"))),
        });
      })
      // AI カードの y: 返答タスクを手で作る（D-066 (2)。phase0-plan 3.3）
      .post("/work-items/:id/reply-task", (c) => {
        const d = deps();
        const r = d.ops.createReplyTask(c.req.param("id"));
        return c.json(
          {
            rev: d.meta().rev,
            followUp: r.row ? fuView(r.row) : null,
            created: r.created,
            taskId: r.taskId,
          },
          r.created ? 201 : 200,
        );
      })
      .get("/open/options", zValidator("query", openQuery, invalid), (c) =>
        c.json(deps().opener.options(ref(c.req.valid("query")))),
      )
      .get("/open/apps", (c) => c.json(deps().opener.apps()))
      .post("/open", zValidator("json", openInput, invalid), async (c) => {
        const b = c.req.valid("json");
        return c.json(
          await deps().opener.open({ ...ref(b), ...(b.action ? { action: b.action } : {}) }),
        );
      })
      .get("/queue", (c) => {
        const d = deps();
        return c.json({
          ...d.meta(),
          items: d.queue(),
          grace: d.graceQueue?.() ?? [],
          limitWaits: d.limitQueue?.() ?? [],
          ...d.queueExtras(),
          desktopNotifier: desktopNotifier(),
          focus: focus()?.queueFocus() ?? null,
        } satisfies QueueResponse);
      })
      // AI の画面（ux-mvp 4.19）: 生きている AI 項目の候補。節への振り分けは画面（core の liveSections）
      .get("/ai/live", async (c) => {
        const d = deps();
        return c.json({ ...d.meta(), items: (await d.live?.()) ?? [] } satisfies AiLiveResponse);
      })
      // 離れていた間のまとめ（ux-mvp 4.13、D-214 (2)）。保存は閉じた印だけ。通知は出さない
      .get("/away", async (c) => {
        c.header("Cache-Control", "no-store");
        return c.json(await deps().away());
      })
      .post(
        "/away/dismiss",
        zValidator("json", z.object({ key: z.string().regex(/^\d{1,16}$/) }).strict(), invalid),
        (c) => {
          deps().dismissAway(c.req.valid("json").key);
          return c.json({ ok: true });
        },
      )
      // メニューバーの件数（desktop-shell.md 4.1）。サイドバー・タブタイトルと同じ数（visibleQueue）
      .get("/queue/summary", (c) => {
        const d = deps();
        const update = updateMenu();
        return c.json({
          ...queueSummary(d.queue()),
          rev: d.meta().rev,
          ...(focus()?.summaryExtras() ?? {}),
          ...(update ? { update } : {}),
        } satisfies QueueSummaryResponse);
      })
      .post("/follow-ups/bulk-dismiss", zValidator("json", bulkInput, invalid), (c) =>
        c.json({ dismissed: deps().ops.bulkDismiss(c.req.valid("json").ids) }),
      )
      .post("/follow-ups/:id/engage", (c) => c.json(fuView(deps().ops.engage(c.req.param("id")))))
      .post("/follow-ups/:id/snooze", zValidator("json", snoozeInput, invalid), (c) => {
        const b = c.req.valid("json");
        // 「明日朝」はクライアントが決めずにサーバーに任せる（m2-api.md 2.2）
        const until = b.preset !== undefined ? deps().snoozeUntil(b.preset) : b.until;
        if (typeof until !== "number") bad("until is required");
        return c.json(fuView(deps().ops.snooze(c.req.param("id"), until)));
      })
      .post("/follow-ups/:id/dismiss", (c) => c.json(fuView(deps().ops.dismiss(c.req.param("id")))))
      .post("/follow-ups/:id/complete", (c) =>
        c.json(fuView(deps().ops.complete(c.req.param("id")))),
      )
      // 手での完了の取り消し（⌘Z。D-139 (3)）
      .post("/follow-ups/:id/reopen", (c) => c.json(fuView(deps().ops.reopen(c.req.param("id")))))
      .get("/sources", (c) => c.json({ sources: deps().sources(), ...deps().ingestStatus() }))
      .patch("/sources/:id", async (c) => {
        const b = await body(c);
        const p: {
          enabled?: boolean;
          excludeGlobs?: string[];
          includeGlobs?: string[];
          profileLabel?: string;
        } = {};
        if (b.enabled !== undefined)
          p.enabled = typeof b.enabled === "boolean" ? b.enabled : bad("enabled");
        const ex = strList(b.excludeGlobs, "excludeGlobs");
        if (ex) p.excludeGlobs = ex;
        const inc = strList(b.includeGlobs, "includeGlobs");
        if (inc) p.includeGlobs = inc;
        if (b.profileLabel !== undefined)
          p.profileLabel =
            typeof b.profileLabel === "string" ? b.profileLabel : bad("profileLabel");
        deps().patchSource(c.req.param("id"), p);
        return c.json({ ok: true });
      })
      .post("/sources/rescan", async (c) => {
        await deps().rescan();
        return c.json({ ok: true });
      })
      .post("/admin/reingest", async (c) => {
        const b = await body(c);
        const source = typeof b.source === "string" ? b.source : undefined;
        await deps().reingest(source);
        return c.json({ ok: true });
      })
      .post("/admin/rederive", async (c) => {
        const b = await body(c);
        const since = b.waitSince;
        if (since !== undefined && (typeof since !== "string" || !isLocalDate(since)))
          bad("waitSince must be YYYY-MM-DD");
        return c.json(deps().rederive(since ? { waitSince: since as string } : {}));
      })
  );
}
