/**
 * ボード系 API（m2-api.md 2.2）: /api/board、/api/inbox、タスクと時間ブロックの操作、画面の設定（テーマ・言語）。
 * 入力は core/api の Zod スキーマで検証する（@hono/zod-validator）。エラーは { error: "<code>" } だけを返す。
 */

import { zValidator } from "@hono/zod-validator";
import { KEYBINDINGS_SCHEMA, PANEL_WIDTH_SCHEMA } from "@turnlane/core";
import {
  type BoardResponse,
  boardQuery,
  carryDayInput,
  checkTaskInput,
  createProjectInput,
  createTaskInput,
  createTimeBlockInput,
  type DayResponse,
  deferFollowUpInput,
  moveTaskInput,
  type ProjectReposResponse,
  type ProjectView,
  patchProjectInput,
  patchTaskInput,
  patchTimeBlockInput,
  putDailyNoteInput,
  putSummaryInput,
  SEARCH_LIMIT_DEFAULT,
  type SearchResponse,
  searchQuery,
  startSummaryInput,
  uncompleteTaskInput,
  undoCarryInput,
  usageInput,
} from "@turnlane/core/api";
import { Hono } from "hono";
import { z } from "zod";
import { OpError } from "../derive/ops.ts";
import type { DailyNoteService } from "../planner/daily-note.ts";
import type { TaskService } from "../planner/tasks.ts";
import type { SummaryService } from "../summary/service.ts";

export type ThemeSetting = "system" | "light" | "dark";
export type LanguageSetting = "system" | "en" | "ja";
export interface UiPrefs {
  theme: ThemeSetting;
  language: LanguageSetting;
  /** キーの割り当ての上書き（D-077。id → キーの表記。既定と同じものは入れない。端末ごと） */
  keybindings: Record<string, string[]>;
  /** 会議の前に集中モードを聞く（focus.prompt、既定オン。D-097） */
  focusPrompt: boolean;
  /** 集中モードの対象の予定（focus.target。meetings = 参加者・会議リンクのある予定 / busy = 予定ありのすべて） */
  focusTarget: "meetings" | "busy";
  /** 何分前に聞くか（focus.lead_min、1〜30、既定5） */
  focusLeadMin: number;
  /** 答えなければ開始の時刻に自動で集中（focus.auto、既定オフ） */
  focusAuto: boolean;
  /** 集中中も許可待ちは通知する（focus.allow_needs_input、既定オフ） */
  focusAllowNeedsInput: boolean;
  /** 集中の終わりを知らせる（focus.notify_end、既定オン。オフなら止めた通知が無いときは出さない） */
  focusNotifyEnd: boolean;
  /** 右の詳細パネルの幅（ui.panel_width、px。null は既定の 380px。この Mac に1つ。ux-mvp 4.12.1） */
  panelWidth: number | null;
}

export interface PlannerDeps {
  tasks: TaskService;
  dailyNote: DailyNoteService;
  /** 日報の AI 要約（M4-6）。無ければ 409 summary_unavailable */
  summary: SummaryService | null;
  board(from: string, to: string): BoardResponse;
  /** 3日ボード（D-074）: 前の稼働日・around・次の稼働日 */
  boardAround(around: string): BoardResponse;
  /** デイビュー（M2-19） */
  day(date: string): DayResponse;
  /** ⌘K の検索（M2-15。m2-api.md 17章） */
  search(q: string, limit: number): SearchResponse;
  projects: {
    list(all: boolean): ProjectView[];
    create(p: {
      name: string;
      color?: string | null | undefined;
      repoPaths?: string[] | undefined;
    }): ProjectView;
    patch(
      id: string,
      p: {
        name?: string | undefined;
        color?: string | null | undefined;
        repoPaths?: string[] | undefined;
        archived?: boolean | undefined;
      },
    ): ProjectView;
    repos(): ProjectReposResponse;
  };
  ui: {
    get(): UiPrefs;
    put(p: {
      theme?: ThemeSetting | undefined;
      language?: LanguageSetting | undefined;
      keybindings?: Record<string, string[]> | undefined;
      focusPrompt?: boolean | undefined;
      focusTarget?: "meetings" | "busy" | undefined;
      focusLeadMin?: number | undefined;
      focusAuto?: boolean | undefined;
      focusAllowNeedsInput?: boolean | undefined;
      focusNotifyEnd?: boolean | undefined;
      panelWidth?: number | null | undefined;
    }): UiPrefs;
  };
}

const uiInput = z.object({
  theme: z.enum(["system", "light", "dark"]).optional(),
  language: z.enum(["system", "en", "ja"]).optional(),
  keybindings: KEYBINDINGS_SCHEMA.optional(),
  focusPrompt: z.boolean().optional(),
  focusTarget: z.enum(["meetings", "busy"]).optional(),
  focusLeadMin: z.number().int().min(1).max(30).optional(),
  focusAuto: z.boolean().optional(),
  focusAllowNeedsInput: z.boolean().optional(),
  focusNotifyEnd: z.boolean().optional(),
  panelWidth: PANEL_WIDTH_SCHEMA.optional(),
});

/** 入力の検証に失敗したら 400 { error: "invalid_input" } */
const invalid = (r: { success: boolean }, c: { json: (b: unknown, s: 400) => Response }) => {
  if (!r.success) return c.json({ error: "invalid_input" }, 400);
};

const MAX_DAYS = 31;

const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reportQuery = z.object({
  date: dateParam.optional(),
  lang: z.enum(["en", "ja"]).optional(),
});

export function createPlannerRoutes(get: () => PlannerDeps | undefined) {
  const deps = () => {
    const d = get();
    if (!d) throw new OpError(409, "planner_unavailable");
    return d;
  };
  return (
    new Hono()
      .onError((e, c) => {
        if (e instanceof OpError) return c.json({ error: e.message }, e.status);
        throw e;
      })
      .get("/board", zValidator("query", boardQuery, invalid), (c) => {
        const { from, to, around } = c.req.valid("query");
        if (around !== undefined) {
          if (from !== undefined || to !== undefined) return c.json({ error: "bad_range" }, 400);
          return c.json(deps().boardAround(around));
        }
        if (from === undefined || to === undefined) return c.json({ error: "bad_range" }, 400);
        const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
        if (!(days >= 0 && days < MAX_DAYS)) return c.json({ error: "bad_range" }, 400);
        return c.json(deps().board(from, to));
      })
      .get("/day/:date", zValidator("param", z.object({ date: dateParam }), invalid), (c) =>
        c.json(deps().day(c.req.valid("param").date)),
      )
      .get("/inbox", (c) => c.json(deps().tasks.inbox()))
      .get("/search", zValidator("query", searchQuery, invalid), (c) => {
        const { q, limit } = c.req.valid("query");
        return c.json(deps().search(q, limit ?? SEARCH_LIMIT_DEFAULT));
      })
      .get("/projects", (c) =>
        c.json({ projects: deps().projects.list(c.req.query("all") === "1") }),
      )
      .get("/projects/repos", (c) => c.json(deps().projects.repos()))
      .post("/projects", zValidator("json", createProjectInput, invalid), (c) =>
        c.json({ project: deps().projects.create(c.req.valid("json")) }, 201),
      )
      .patch("/projects/:id", zValidator("json", patchProjectInput, invalid), (c) =>
        c.json({ project: deps().projects.patch(c.req.param("id"), c.req.valid("json")) }),
      )
      .post("/work-items/:id/check-task", zValidator("json", checkTaskInput, invalid), (c) =>
        c.json(deps().tasks.createCheckTask(c.req.param("id"), c.req.valid("json")), 201),
      )
      .post("/tasks", zValidator("json", createTaskInput, invalid), (c) => {
        const { status, ...r } = deps().tasks.create(c.req.valid("json"));
        return c.json(r, status);
      })
      .get(
        "/tasks/by-external",
        zValidator("query", z.object({ source: z.string(), id: z.string() }), invalid),
        (c) => {
          const q = c.req.valid("query");
          const t = deps().tasks.byExternal(q.source, q.id);
          return t ? c.json({ task: t }) : c.json({ error: "not_found" }, 404);
        },
      )
      .get("/tasks/:id", (c) => c.json(deps().tasks.detail(c.req.param("id"))))
      .patch("/tasks/:id", zValidator("json", patchTaskInput, invalid), (c) =>
        c.json(deps().tasks.patch(c.req.param("id"), c.req.valid("json"))),
      )
      .post("/tasks/:id/move", zValidator("json", moveTaskInput, invalid), (c) =>
        c.json(deps().tasks.move(c.req.param("id"), c.req.valid("json"))),
      )
      .post("/tasks/:id/complete", (c) => c.json(deps().tasks.complete(c.req.param("id"))))
      // 本文は省略可（{status?, reopenFollowUps?}。完了の取り消し。D-139 (3)）
      .post("/tasks/:id/uncomplete", zValidator("json", uncompleteTaskInput, invalid), (c) =>
        c.json(deps().tasks.uncomplete(c.req.param("id"), c.req.valid("json"))),
      )
      .post("/tasks/:id/start", (c) => c.json(deps().tasks.start(c.req.param("id"))))
      .delete("/tasks/:id", (c) => c.json(deps().tasks.remove(c.req.param("id"))))
      .post("/tasks/:id/restore", (c) => c.json(deps().tasks.restore(c.req.param("id"))))
      .post("/time-blocks", zValidator("json", createTimeBlockInput, invalid), (c) =>
        c.json(deps().tasks.createTimeBlock(c.req.valid("json")), 201),
      )
      .patch("/time-blocks/:id", zValidator("json", patchTimeBlockInput, invalid), (c) =>
        c.json(deps().tasks.patchTimeBlock(c.req.param("id"), c.req.valid("json"))),
      )
      .delete("/time-blocks/:id", (c) => c.json(deps().tasks.deleteTimeBlock(c.req.param("id"))))
      // 記録（日報）・持ち越し・利用計測（M4-2・M4-3・M5-1。儀式の API は D-192 で廃止）
      .post("/follow-ups/:id/defer", async (c) => {
        // 本文は省略可（{date?}。m2-api 19章）
        const raw = await c.req.json().catch(() => ({}));
        const r = deferFollowUpInput.safeParse(raw ?? {});
        if (!r.success) return c.json({ error: "invalid_input" }, 400);
        return c.json(deps().dailyNote.defer(c.req.param("id"), r.data.date));
      })
      // 今やる（自分の番の画面の「後で」）: スヌーズを外し、明日へ移したタスクは今日へ戻す（m2-api 2.3）
      .post("/follow-ups/:id/wake", (c) => c.json(deps().dailyNote.wake(c.req.param("id"))))
      // 「残り N 件を今日へ」（D-192）。本文は {older?}
      .post("/days/:date/carry", zValidator("json", carryDayInput, invalid), (c) => {
        const date = c.req.param("date");
        if (!dateParam.safeParse(date).success) return c.json({ error: "invalid_input" }, 400);
        return c.json(deps().dailyNote.carry(date, c.req.valid("json")));
      })
      .post("/days/carry/undo", zValidator("json", undoCarryInput, invalid), (c) =>
        c.json(deps().dailyNote.undoCarry(c.req.valid("json"))),
      )
      .get(
        "/reports/daily/:date",
        zValidator(
          "query",
          reportQuery.extend({ format: z.enum(["json", "md"]).optional() }),
          invalid,
        ),
        (c) => {
          // `today` は今日の論理日付（turnlane report・MCP の既定）
          const p = c.req.param("date");
          const date = p === "today" ? undefined : p;
          if (date !== undefined && !dateParam.safeParse(date).success)
            return c.json({ error: "invalid_input" }, 400);
          const q = c.req.valid("query");
          const r = deps().dailyNote.daily(date, q.lang);
          // Markdown は先頭に Summary を付けたもの（turnlane report・M4-6）
          if (q.format === "md")
            return c.text(r.exportMarkdown, 200, {
              "content-type": "text/markdown; charset=utf-8",
            });
          return c.json(r);
        },
      )
      .put("/daily-notes/:date", zValidator("json", putDailyNoteInput, invalid), (c) => {
        const date = c.req.param("date");
        if (!dateParam.safeParse(date).success) return c.json({ error: "invalid_input" }, 400);
        return c.json(deps().dailyNote.putNote(date, c.req.valid("json").note));
      })
      .post("/daily-notes/:date/summary", zValidator("json", startSummaryInput, invalid), (c) => {
        const date = c.req.param("date");
        if (!dateParam.safeParse(date).success) return c.json({ error: "invalid_input" }, 400);
        const sv = deps().summary;
        if (!sv) throw new OpError(409, "summary_unavailable");
        const d = deps().dailyNote.checkDate(date);
        return c.json(sv.start(d, c.req.valid("json").lang));
      })
      .put("/daily-notes/:date/summary", zValidator("json", putSummaryInput, invalid), (c) => {
        const date = c.req.param("date");
        if (!dateParam.safeParse(date).success) return c.json({ error: "invalid_input" }, 400);
        const sv = deps().summary;
        if (!sv) throw new OpError(409, "summary_unavailable");
        const d = deps().dailyNote.checkDate(date);
        return c.json(sv.put(d, c.req.valid("json").summary));
      })
      .get(
        "/summary/tools",
        zValidator("query", z.object({ refresh: z.enum(["0", "1"]).optional() }), invalid),
        async (c) => {
          const sv = deps().summary;
          if (!sv) throw new OpError(409, "summary_unavailable");
          const r = await sv.tools(c.req.valid("query").refresh === "1");
          return c.json(r);
        },
      )
      .post("/usage", zValidator("json", usageInput, invalid), (c) => {
        deps().dailyNote.recordUsage(c.req.valid("json").kind);
        return c.json({ ok: true });
      })
      .get(
        "/stats",
        zValidator(
          "query",
          z.object({ days: z.coerce.number().int().min(1).max(90).optional() }),
          invalid,
        ),
        (c) => c.json(deps().dailyNote.stats(c.req.valid("query").days ?? 14)),
      )
      .get("/settings/ui", (c) => c.json(deps().ui.get()))
      .put("/settings/ui", zValidator("json", uiInput, invalid), (c) =>
        c.json(deps().ui.put(c.req.valid("json"))),
      )
  );
}
