/**
 * turnlane mcp: stdio の MCP サーバ（phase0-plan 3.5、M2-10）。デーモンの HTTP API を叩くだけで、DB を直接開かない。
 * - 改行区切りの JSON-RPC 2.0（MCP の stdio トランスポート）
 * - MCP からの書き込みは本人の「操作」に数えない（x-turnlane-client を付けない。W22）
 * - add_task は source=mcp、source_ref=mcp:<clientInfo.name>:<cwd>。既定は Inbox。source と external_id は
 *   両方指定か両方省略（片方だけはエラー）で、指定時は (source, external_id) で冪等
 * - 削除・一括更新のツールは作らない（安全設計）。会話本文は受け取らない・返さない
 */
import { createInterface } from "node:readline";
import { baseUrl, readToken, type TurnlanePaths, VERSION } from "@turnlane/core";
import type {
  BoardResponse,
  InboxResponse,
  QueueResponse,
  ReportResponse,
  TaskDetailResponse,
  TaskView,
  TaskWriteResponse,
} from "@turnlane/core/api";
import { planWindow } from "@turnlane/core/plan";
import { dayDiff, shiftByDays } from "@turnlane/core/web";
import type { CliEnv } from "../env.ts";
import { titleOf } from "./tasks.ts";

type Json = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  run: (args: Json, ctx: McpContext) => Promise<unknown>;
}

export interface McpContext {
  paths: TurnlanePaths;
  client: string;
  cwd: string;
}

/** MCP のツールからデーモンを呼ぶ（Bearer のみ。本人の操作には数えない） */
async function api<T>(
  ctx: McpContext,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${baseUrl(ctx.paths.port)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${readToken(ctx.paths.tokenPath)}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const code = (data as { error?: string } | null)?.error ?? `http_${res.status}`;
    const field = (data as { field?: string } | null)?.field;
    throw new McpToolError(field ? `${code}: ${field}` : code);
  }
  return { status: res.status, data: data as T };
}

export class McpToolError extends Error {}

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function brief(t: TaskView) {
  return {
    id: t.id,
    title: titleOf(t),
    status: t.status,
    date: t.scheduledDate,
    estimate_min: t.estimateMin,
    source: t.origin.externalSource ?? t.origin.source,
  };
}

async function today(ctx: McpContext): Promise<string> {
  return (await api<InboxResponse>(ctx, "GET", "/api/inbox")).data.today;
}

async function dayInfo(ctx: McpContext, date: string) {
  const b = (await api<BoardResponse>(ctx, "GET", `/api/board?from=${date}&to=${date}`)).data;
  const d = b.days[0];
  const q = (await api<QueueResponse>(ctx, "GET", "/api/queue")).data;
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    date,
    events: (d?.events ?? []).map((e) => ({
      title: e.title,
      start: iso(e.start),
      end: iso(e.end),
    })),
    tasks: (d?.tasks ?? []).map(brief),
    time_blocks: (d?.timeBlocks ?? []).map((x) => ({
      task_id: x.taskId,
      start: iso(x.start),
      end: iso(x.end),
    })),
    free_ms: d?.totals.freeMs ?? 0,
    planned_ms: d?.totals.plannedMs ?? 0,
    your_turn: q.items.filter((x) => x.followUps.some((f) => f.status === "open")).length,
  };
}

/** 空き枠: 計画の窓（計画の目安。今日は今より後。D-106）から予定と時間ブロックを引いたもの */
async function freeSlots(ctx: McpContext, date: string, minMinutes: number) {
  const b = (await api<BoardResponse>(ctx, "GET", `/api/board?from=${date}&to=${date}`)).data;
  const d = b.days[0];
  const w = d
    ? planWindow({ phase: d.logicalPhase, now: b.now, planned: d.plannedHours, workday: d.workday })
    : null;
  if (!d || !w) return [];
  const { start, end } = w;
  const busy = [
    ...d.events.filter((e) => e.busy).map((e) => [e.start, e.end] as const),
    ...d.timeBlocks.map((x) => [x.start, x.end] as const),
  ].sort((a, b2) => a[0] - b2[0]);
  const out: { start: string; end: string; minutes: number }[] = [];
  let cur = start;
  for (const [s, e] of busy) {
    if (s > cur && Math.min(s, end) - cur >= minMinutes * 60_000)
      out.push({
        start: new Date(cur).toISOString(),
        end: new Date(Math.min(s, end)).toISOString(),
        minutes: Math.round((Math.min(s, end) - cur) / 60_000),
      });
    cur = Math.max(cur, e);
  }
  if (end - cur >= minMinutes * 60_000)
    out.push({
      start: new Date(cur).toISOString(),
      end: new Date(end).toISOString(),
      minutes: Math.round((end - cur) / 60_000),
    });
  return out;
}

export const TOOLS: Tool[] = [
  {
    name: "add_task",
    description:
      "Add a task to Turnlane (goes to the Inbox unless a date is given). Pass source and external_id together to make it idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        estimate_min: { type: "number" },
        project: { type: "string" },
        notes: { type: "string" },
        source: {
          type: "string",
          description: "lowercase id of the external service, e.g. github",
        },
        external_id: { type: "string" },
        url: { type: "string" },
      },
      required: ["title"],
    },
    run: async (a, ctx) => {
      const title = str(a.title);
      if (!title) throw new McpToolError("title is required");
      const source = str(a.source);
      const externalId = str(a.external_id);
      if ((source === undefined) !== (externalId === undefined))
        throw new McpToolError("source and external_id must be given together");
      const r = await api<TaskWriteResponse>(ctx, "POST", "/api/tasks", {
        title,
        ...(str(a.project) ? { projectName: a.project } : {}),
        source: "mcp",
        client: ctx.client,
        cwd: ctx.cwd,
        ...(str(a.date) ? { date: a.date } : {}),
        ...(num(a.estimate_min) !== undefined
          ? { estimateMin: Math.round(a.estimate_min as number) }
          : {}),
        ...(str(a.notes) ? { notes: a.notes } : {}),
        ...(source && externalId
          ? { external: { source, id: externalId, ...(str(a.url) ? { url: a.url } : {}) } }
          : {}),
      });
      return {
        task: r.data.task ? brief(r.data.task) : null,
        created: r.data.created ?? false,
        ...(r.data.skipped ? { skipped: r.data.skipped } : {}),
      };
    },
  },
  {
    name: "list_tasks",
    description: 'List tasks for a date (default today), or the Inbox with date "inbox".',
    inputSchema: {
      type: "object",
      properties: { date: { type: "string" }, include_done: { type: "boolean" } },
    },
    run: async (a, ctx) => {
      let tasks: TaskView[];
      if (a.date === "inbox")
        tasks = (await api<InboxResponse>(ctx, "GET", "/api/inbox")).data.tasks;
      else {
        const date = str(a.date) ?? (await today(ctx));
        tasks =
          (await api<BoardResponse>(ctx, "GET", `/api/board?from=${date}&to=${date}`)).data.days[0]
            ?.tasks ?? [];
      }
      return {
        tasks: tasks.filter((t) => a.include_done === true || t.status !== "done").map(brief),
      };
    },
  },
  {
    name: "get_today",
    description:
      "Today's events, tasks, time blocks, free time and the number of items waiting on the user.",
    inputSchema: { type: "object", properties: {} },
    run: async (_a, ctx) => dayInfo(ctx, await today(ctx)),
  },
  {
    name: "get_day",
    description: "Same as get_today for any date.",
    inputSchema: { type: "object", properties: { date: { type: "string" } }, required: ["date"] },
    run: async (a, ctx) => dayInfo(ctx, str(a.date) ?? (await today(ctx))),
  },
  {
    name: "get_free_slots",
    description:
      "Free slots on a date: your planned hours (the plan guide in settings) minus busy events and time blocks. Today only after now.",
    inputSchema: {
      type: "object",
      properties: { date: { type: "string" }, min_minutes: { type: "number" } },
      required: ["date"],
    },
    run: async (a, ctx) => ({
      slots: await freeSlots(ctx, str(a.date) ?? (await today(ctx)), num(a.min_minutes) ?? 15),
    }),
  },
  {
    name: "schedule_task",
    description: "Move a task to a date; with start (HH:MM) also place it on the timeline.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        date: { type: "string" },
        start: { type: "string" },
        duration_min: { type: "number" },
      },
      required: ["task_id", "date"],
    },
    run: async (a, ctx) => {
      const id = str(a.task_id);
      const date = str(a.date);
      if (!id || !date) throw new McpToolError("task_id and date are required");
      // タスクの時間ブロックは1つ（ボードの DnD・キーの移動と同じ。m2-api 14章）。新しく作り足さず、今のブロックを動かす。
      // 以前は作り足していたので、前の日付・時刻のブロックが残ることがある。それは消さずに残す（削除のツールは作らない）
      const before = (await api<TaskDetailResponse>(ctx, "GET", `/api/tasks/${id}`)).data;
      const current = before.blocks.at(-1) ?? null;
      const r = await api<TaskWriteResponse>(ctx, "POST", `/api/tasks/${id}/move`, { date });
      const start = str(a.start);
      if (!(start && /^\d{1,2}:\d{2}$/.test(start))) {
        // 日付だけ変えたら、時間に置いたタスクは同じ時刻のまま日をずらす
        const from = before.task.scheduledDate;
        if (current && from && from !== date) {
          const n = dayDiff(from, date);
          await api(ctx, "PATCH", `/api/time-blocks/${current.id}`, {
            startAt: shiftByDays(current.start, n, before.tz),
            endAt: shiftByDays(current.end, n, before.tz),
          });
        }
      } else {
        const b = (await api<BoardResponse>(ctx, "GET", `/api/board?from=${date}&to=${date}`)).data;
        const d = b.days[0];
        if (!d) throw new McpToolError("bad_date");
        const [h, m] = start.split(":").map(Number) as [number, number];
        // その論理日の 0:00（暦の時間軸ではなく、日付区切りより前の時刻は翌日として置く）
        const base = d.logical.start - b.dayBoundary * 60_000;
        let at = base + (h * 60 + m) * 60_000;
        if (h * 60 + m < b.dayBoundary) at += 86_400_000;
        const dur = (num(a.duration_min) ?? r.data.task?.estimateMin ?? 30) * 60_000;
        if (current)
          await api(ctx, "PATCH", `/api/time-blocks/${current.id}`, {
            startAt: at,
            endAt: at + dur,
          });
        else
          await api(ctx, "POST", "/api/time-blocks", { taskId: id, startAt: at, endAt: at + dur });
      }
      return { task: r.data.task ? brief(r.data.task) : null };
    },
  },
  {
    name: "complete_task",
    description: "Complete a task by task_id, or by source + external_id.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        source: { type: "string" },
        external_id: { type: "string" },
      },
    },
    run: async (a, ctx) => {
      let id = str(a.task_id);
      if (!id) {
        const source = str(a.source);
        const ext = str(a.external_id);
        if (!source || !ext) throw new McpToolError("task_id or source + external_id is required");
        const r = await api<{ task: TaskView }>(
          ctx,
          "GET",
          `/api/tasks/by-external?source=${encodeURIComponent(source)}&id=${encodeURIComponent(ext)}`,
        );
        id = r.data.task.id;
      }
      const r = await api<TaskWriteResponse>(ctx, "POST", `/api/tasks/${id}/complete`);
      return { task: r.data.task ? brief(r.data.task) : null };
    },
  },
  {
    name: "list_your_turn",
    description:
      "AI work items waiting on the user (permission, question, PR review, error, resume after the usage limit).",
    inputSchema: { type: "object", properties: {} },
    run: async (_a, ctx) => {
      const q = (await api<QueueResponse>(ctx, "GET", "/api/queue")).data;
      return {
        items: q.items
          .filter((x) => x.followUps.some((f) => f.status === "open"))
          .map((x) => ({
            title: x.title,
            status: x.status,
            repo: x.repoRoot?.split("/").at(-1) ?? null,
            branch: x.branch,
            // 上限待ちが明けた後の再開は resume_limit（新しい値。中身は resume_error の行）
            kinds: x.followUps.map((f) => (f.limit ? "resume_limit" : f.kind)),
            waiting_min: Math.round((q.now - x.waitingSince) / 60_000),
          })),
      };
    },
  },
  {
    name: "get_ai_work",
    description:
      "AI work items (title, status, AI time) for a date. No conversation text is stored.",
    inputSchema: { type: "object", properties: { date: { type: "string" } } },
    run: async (a, ctx) => {
      const date = str(a.date) ?? (await today(ctx));
      const r = await api<{
        days: { items: { title: string | null; status: string; aiMs: number }[] }[];
      }>(ctx, "GET", `/api/work-items?date=${date}&days=1`);
      return {
        items: (r.data.days[0]?.items ?? []).map((x) => ({
          title: x.title,
          status: x.status,
          ai_min: Math.round(x.aiMs / 60_000),
        })),
      };
    },
  },
  {
    name: "report_ai_work",
    description:
      "Report the state of work done by your own script or agent so it shows in Turnlane next to Claude Code and Codex. " +
      "Send started when you begin, waiting when you need the user (it shows on their Your turn right away), and done or error at the end. " +
      "Same fields as `turnlane ai report`. Text is cut to short limits; do not send secrets or whole conversations.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "your lowercase id (2-32 of a-z, 0-9, _), e.g. myscript",
        },
        id: { type: "string", description: "id of this piece of work, unique within source" },
        state: { type: "string", enum: ["started", "running", "waiting", "done", "error"] },
        title: { type: "string", description: "short title (needed on the first report)" },
        project: { type: "string", description: "project name (created if missing)" },
        wait: {
          type: "object",
          description: "required when state is waiting",
          properties: {
            kind: { type: "string", enum: ["question", "permission"] },
            text: { type: "string" },
            options: { type: "array", items: { type: "string" } },
            label: { type: "string" },
          },
          required: ["kind", "text"],
        },
        error: {
          type: "object",
          properties: { kind: { type: "string" } },
          required: ["kind"],
        },
        url: { type: "string", description: "where the user answers (http(s) or an app URL)" },
        at: { type: "number", description: "epoch ms of the event (default now)" },
        client_id: {
          type: "string",
          description: "idempotency key (UUIDv7); one is added if missing",
        },
      },
      required: ["source", "id", "state"],
    },
    run: async (a, ctx) => {
      const body = { ...a, client_id: str(a.client_id) ?? Bun.randomUUIDv7() };
      const r = await api<ReportResponse>(ctx, "POST", "/api/ai/reports", body);
      return { accepted: true, work_item_id: r.data.workItemId, queued: r.data.queued };
    },
  },
  {
    name: "get_daily_report",
    description:
      "The daily note in Markdown for a date (default today). Past days are the note saved at the day boundary.",
    inputSchema: { type: "object", properties: { date: { type: "string" } } },
    run: async (a, ctx) => {
      const date = str(a.date) ?? "today";
      const r = await api<{
        markdown?: string;
        exportMarkdown?: string;
        saved?: boolean;
        error?: string;
      }>(ctx, "GET", `/api/reports/daily/${encodeURIComponent(date)}`);
      if (r.status !== 200 || typeof r.data.markdown !== "string")
        throw new McpToolError(r.data.error ?? `http_${r.status}`);
      // AI 要約がある日は先頭に Summary を付けたもの（M4-6）
      return {
        date,
        saved: r.data.saved === true,
        markdown: r.data.exportMarkdown ?? r.data.markdown,
      };
    },
  },
];

/** 1つの JSON-RPC メッセージを処理する（通知なら null） */
export async function handleMessage(msg: Json, state: { ctx: McpContext }): Promise<Json | null> {
  const id = msg.id as string | number | undefined;
  const method = msg.method as string | undefined;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  if (id === undefined) return null; // 通知（notifications/initialized など）
  switch (method) {
    case "initialize": {
      const p = (msg.params ?? {}) as { protocolVersion?: string; clientInfo?: { name?: string } };
      const name = p.clientInfo?.name;
      if (typeof name === "string" && /^[\w.@/-]{1,64}$/.test(name)) state.ctx.client = name;
      return reply({
        protocolVersion: p.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "turnlane", version: VERSION },
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const p = (msg.params ?? {}) as { name?: string; arguments?: Json };
      const tool = TOOLS.find((t) => t.name === p.name);
      if (!tool) return fail(-32602, `unknown tool: ${p.name}`);
      try {
        const out = await tool.run(p.arguments ?? {}, state.ctx);
        return reply({
          content: [{ type: "text", text: JSON.stringify(out) }],
          structuredContent: out,
        });
      } catch (e) {
        const message =
          e instanceof McpToolError
            ? e.message
            : e instanceof Error && /fetch|connect/i.test(e.message)
              ? "daemon_not_running"
              : "error";
        return reply({ content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

export async function mcpCommand(env: CliEnv): Promise<number> {
  const state = { ctx: { paths: env.paths, client: "unknown", cwd: process.cwd() } };
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`,
      );
      continue;
    }
    const out = await handleMessage(msg, state);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  }
  return 0;
}
