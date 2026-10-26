/** ボード系（M2）の組み立て: タスクの操作、週ボードの集約、画面の設定 */
import type { Database } from "bun:sqlite";
import type { MetaOnlyLogger } from "@turnlane/collectors";
import {
  addDays,
  boardPrevDay,
  type Clock,
  type MutateCtx,
  nextWorkday,
  putSetting,
  readSettings,
  type WorkdayRule,
} from "@turnlane/core";
import type { AiSystem } from "../ai.ts";
import { lastWorkedDate } from "../derive/views.ts";
import type { PlannerDeps } from "../http/planner-routes.ts";
import type { SseHub } from "../http/sse.ts";
import type { DetectOptions } from "../summary/cli.ts";
import { SummaryService } from "../summary/service.ts";
import { buildBoard } from "./board.ts";
import { DailyNoteService } from "./daily-note.ts";
import { buildDay } from "./day.ts";
import { ProjectService } from "./projects.ts";
import { searchAll } from "./search.ts";
import { TaskService } from "./tasks.ts";
import { readUiPrefs } from "./ui-prefs.ts";

export function createPlanner(o: {
  sqlite: Database;
  mutate: MutateCtx;
  clock: Clock;
  hub: SseHub;
  ai: AiSystem | null;
  /** 稼働日の規則と祝日名（M3-6。稼働曜日 + 祝日）。無ければ設定の稼働曜日だけ */
  workdays?: () => { rule: WorkdayRule; names: ReadonlyMap<string, string | null> };
  /** 日報の AI 要約（M4-6）。無ければ要約を作らない */
  summary?: {
    workDir: string;
    logger: MetaOnlyLogger;
    detect: DetectOptions;
    killGraceMs?: number;
  };
}): PlannerDeps & {
  tasks: TaskService;
  dailyNote: DailyNoteService;
  summary: SummaryService | null;
} {
  const settings = () => readSettings(o.mutate.db);
  const ai = o.ai;
  const tasks = new TaskService({
    sqlite: o.sqlite,
    mutate: o.mutate,
    clock: o.clock,
    settings,
    rev: () => o.hub.rev,
    publish: (type, data) => o.hub.publish(type, data),
    ...(ai
      ? {
          completeFollowUp: (id: string) => void ai.deps.ops.complete(id),
          reopenFollowUp: (id: string) => void ai.deps.ops.reopen(id),
        }
      : {}),
    onChanged: () => ai?.runner.schedule(),
  });
  const locale = (): "en" | "ja" => (readUiPrefs(o.mutate.db).language === "ja" ? "ja" : "en");
  let summary: SummaryService | null = null;
  const dailyNote = new DailyNoteService({
    sqlite: o.sqlite,
    mutate: o.mutate,
    clock: o.clock,
    settings,
    rev: () => o.hub.rev,
    locale,
    tasks,
    publish: (type, data) => o.hub.publish(type, data),
    ops: ai?.deps.ops,
    ...(o.workdays ? { workdays: o.workdays } : {}),
    summary: () => summary,
  });
  if (o.summary) {
    summary = new SummaryService({
      sqlite: o.sqlite,
      mutate: o.mutate,
      clock: o.clock,
      settings,
      logger: o.summary.logger,
      workDir: o.summary.workDir,
      detect: o.summary.detect,
      markdown: (date, l) => dailyNote.reportMarkdown(date, l),
      locale,
      publish: (dates) => o.hub.publish("daily_note", { dates }),
      ...(o.summary.killGraceMs !== undefined ? { killGraceMs: o.summary.killGraceMs } : {}),
    });
  }
  return {
    tasks,
    dailyNote,
    summary,
    // プロジェクトの変化は週ボード・Inbox のプロジェクト名にも出る（task イベントで projects を取り直す）
    projects: new ProjectService(o.sqlite, o.mutate, () =>
      o.hub.publish("task", { dates: [], ids: [], inbox: false }),
    ),
    board: (from, to) => {
      const s = settings();
      const rule = o.workdays?.().rule ?? { weekdays: s.workdays, holidays: new Set<string>() };
      return buildBoard(o.sqlite, s, o.clock.now(), o.hub.rev, from, to, rule);
    },
    boardAround: (around) => {
      const s = settings();
      const rule = o.workdays?.().rule ?? { weekdays: s.workdays, holidays: new Set<string>() };
      // 左の列は前の稼働日と実際に作業した直近の日（本人の操作があった論理日）の新しい方（D-076）
      const prev = boardPrevDay(around, rule, lastWorkedDate(o.sqlite, s, around));
      const next = nextWorkday(around, rule) ?? addDays(around, 1);
      const b = buildBoard(o.sqlite, s, o.clock.now(), o.hub.rev, prev, next, rule);
      const keep = new Set([prev, around, next]);
      return { ...b, days: b.days.filter((d) => keep.has(d.date)) };
    },
    day: (date) => {
      const s = settings();
      const rule = o.workdays?.().rule ?? { weekdays: s.workdays, holidays: new Set<string>() };
      return buildDay(o.sqlite, s, o.clock.now(), o.hub.rev, date, rule);
    },
    search: (q, limit) => searchAll(o.sqlite, settings(), o.clock.now(), o.hub.rev, q, limit),
    ui: {
      get: () => readUiPrefs(o.mutate.db),
      put: (p) => {
        if (p.theme !== undefined) putSetting(o.mutate, "ui.theme", p.theme);
        if (p.language !== undefined) putSetting(o.mutate, "ui.language", p.language);
        if (p.keybindings !== undefined) putSetting(o.mutate, "ui.keybindings", p.keybindings);
        if (p.focusPrompt !== undefined) putSetting(o.mutate, "focus.prompt", p.focusPrompt);
        if (p.focusTarget !== undefined) putSetting(o.mutate, "focus.target", p.focusTarget);
        if (p.focusLeadMin !== undefined) putSetting(o.mutate, "focus.lead_min", p.focusLeadMin);
        if (p.focusAuto !== undefined) putSetting(o.mutate, "focus.auto", p.focusAuto);
        if (p.focusAllowNeedsInput !== undefined)
          putSetting(o.mutate, "focus.allow_needs_input", p.focusAllowNeedsInput);
        if (p.focusNotifyEnd !== undefined)
          putSetting(o.mutate, "focus.notify_end", p.focusNotifyEnd);
        if (p.panelWidth !== undefined) putSetting(o.mutate, "ui.panel_width", p.panelWidth);
        o.hub.publish("settings", {});
        return readUiPrefs(o.mutate.db);
      },
    },
  };
}
