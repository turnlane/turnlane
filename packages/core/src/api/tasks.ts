/** タスク・時間ブロックの操作と Inbox（m2-api.md 2.2）。入力は Zod で検証する */
import { z } from "zod";
import type { TaskView, TimeBlockView } from "./board.ts";
import type { ReadMeta } from "./common.ts";

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.string().min(1).max(64);
const externalSource = z.string().regex(/^[a-z0-9._-]{1,64}$/);

export const createTaskInput = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    /** 自然言語の入力（NL パーサを通す。title が無いときに使う） */
    raw: z.string().trim().min(1).max(500).optional(),
    date: localDate.nullable().optional(),
    estimateMin: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .nullable()
      .optional(),
    projectId: id.nullable().optional(),
    /** プロジェクト名（無ければ作る。MCP の add_task の project） */
    projectName: z.string().trim().min(1).max(64).optional(),
    notes: z.string().max(10_000).nullable().optional(),
    priority: z.number().int().min(0).max(3).optional(),
    /** UUIDv7。サーバーはそれを ID に採用する（再送で二重作成しない） */
    clientId: z.string().uuid().optional(),
    /** 経由（既定 manual）。MCP は client と cwd を付ける */
    source: z.enum(["manual", "cli", "mcp", "desktop"]).optional(),
    client: z.string().max(64).optional(),
    cwd: z.string().max(1024).optional(),
    /** 外部取り込みの冪等キー（両方指定か両方省略） */
    external: z
      .object({
        source: externalSource,
        id: z.string().min(1).max(256),
        url: z.string().url().max(2048).optional(),
      })
      .optional(),
    /** 先頭に置く（既定は末尾） */
    placeFirst: z.boolean().optional(),
  })
  .refine((v) => v.title !== undefined || v.raw !== undefined, { message: "title_or_raw" });
export type CreateTaskInput = z.infer<typeof createTaskInput>;

export const patchTaskInput = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  notes: z.string().max(10_000).nullable().optional(),
  estimateMin: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .nullable()
    .optional(),
  priority: z.number().int().min(0).max(3).optional(),
  projectId: id.nullable().optional(),
  isHighlight: z.boolean().optional(),
  status: z.enum(["canceled", "someday", "todo"]).optional(),
});
export type PatchTaskInput = z.infer<typeof patchTaskInput>;

/**
 * 未完了に戻す（本文は省略可）。完了の取り消し（⌘Z。D-139 (3)）は前の状態と、完了の応答の closedFollowUps
 * （完了と一緒に閉じた自分の番）を渡して元に戻す
 */
export const uncompleteTaskInput = z.object({
  status: z.enum(["todo", "doing"]).optional(),
  reopenFollowUps: z.array(id).max(50).optional(),
});
export type UncompleteTaskInput = z.infer<typeof uncompleteTaskInput>;

export const moveTaskInput = z.object({
  date: localDate.nullable(),
  beforeId: id.nullable().optional(),
  afterId: id.nullable().optional(),
  /** true のときだけ rollover_count を加算（朝の Step 2 の t、シャットダウンの自動持ち越し。9.2） */
  carry: z.boolean().optional(),
});
export type MoveTaskInput = z.infer<typeof moveTaskInput>;

export const createTimeBlockInput = z
  .object({
    taskId: id.nullable().optional(),
    title: z.string().max(500).nullable().optional(),
    startAt: z.number().int(),
    endAt: z.number().int(),
    clientId: z.string().uuid().optional(),
  })
  .refine((v) => v.endAt > v.startAt, { message: "end_before_start" });

export const patchTimeBlockInput = z
  .object({ startAt: z.number().int().optional(), endAt: z.number().int().optional() })
  .refine((v) => v.startAt === undefined || v.endAt === undefined || v.endAt > v.startAt, {
    message: "end_before_start",
  });

/** 週表示は from / to（両端を含む）、3日ボードは around（前の稼働日・その日・次の稼働日。D-074、m2-api 20章） */
export const boardQuery = z.object({
  from: localDate.optional(),
  to: localDate.optional(),
  around: localDate.optional(),
});

export const snoozeInput = z.object({
  until: z.number().int().optional(),
  preset: z.enum(["30m", "1h", "tomorrow_morning"]).optional(),
});

export const parseTaskInput = z.object({ raw: z.string().max(500), today: localDate.optional() });

export interface InboxResponse extends ReadMeta {
  /** 作成の新しい順。7日以上は UI が `8日前` を出す（createdAt から判断） */
  tasks: TaskView[];
  /** 今日（論理日）完了にした Inbox のタスク（完了の新しい順）。Inbox の下の「今日閉じた n」（D-139 (4)） */
  closed: TaskView[];
}

/** GET /api/tasks/:id（タスクの詳細パネル。D-070、m2-api 18章） */
export interface TaskDetailResponse extends ReadMeta {
  task: TaskView;
  /** メモ（端末の DB にだけ保存する） */
  notes: string | null;
  /** 時間ブロック（開始の早い順） */
  blocks: TimeBlockView[];
  /** プロジェクト名（無ければ null） */
  projectName: string | null;
}

/** 書き込み系の応答: 変えた行の View と rev */
export interface TaskWriteResponse {
  rev: number;
  task: TaskView | null;
  created?: boolean;
  skipped?: "deleted";
  /** 完了（POST /tasks/:id/complete）で一緒に閉じた自分の番。完了の取り消しで uncomplete に渡す */
  closedFollowUps?: string[];
}

export interface TimeBlockWriteResponse {
  rev: number;
  timeBlock: TimeBlockView | null;
}

/** POST /api/work-items/:id/check-task（AI カードを自分レーンへ落とす。m2-api 19章） */
export const checkTaskInput = z
  .object({
    title: z.string().trim().min(1).max(500),
    date: localDate,
    startAt: z.number().int(),
    endAt: z.number().int(),
    clientId: z.string().uuid().optional(),
  })
  .refine((v) => v.endAt > v.startAt, { message: "end_before_start" });
export type CheckTaskInput = z.infer<typeof checkTaskInput>;

/** POST /api/work-items/:id/merge（統合。phase0-plan 3.4、m2-api 19章） */
export const mergeWorkItemInput = z.object({ intoId: id });

/** POST /api/follow-ups/:id/defer（`m` 明日。date を渡せばその日。m2-api 19章） */
export const deferFollowUpInput = z.object({ date: localDate.optional() });

/** プロジェクト（設定画面のプロジェクトとリポジトリの対応。M2-9、m2-api 19章） */
export interface ProjectView {
  id: string;
  name: string;
  color: string | null;
  repoPaths: string[];
  archivedAt: number | null;
  /** AI に頼むときの worktree の既定（null = 使う。D-110 (5)） */
  worktreeDefault: boolean | null;
  /** worktree にコピーする追跡外のファイル（glob） */
  worktreeCopyGlobs: string[];
  /** 確認支援のテストのコマンド（空なら出さない） */
  testCommand: string | null;
}

const repoPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => s.startsWith("/"), "absolute path");

export const createProjectInput = z.object({
  name: z.string().trim().min(1).max(64),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  repoPaths: z.array(repoPath).max(50).optional(),
});

export const patchProjectInput = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  repoPaths: z.array(repoPath).max(50).optional(),
  archived: z.boolean().optional(),
  worktreeDefault: z.boolean().nullable().optional(),
  worktreeCopyGlobs: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(200)
        .refine((s) => !s.startsWith("/") && !s.split("/").includes(".."), "relative glob"),
    )
    .max(20)
    .optional(),
  testCommand: z.string().trim().max(500).nullable().optional(),
});

/** GET /api/projects/repos（対応付けの候補。AI 項目のリポジトリ） */
export interface ProjectReposResponse {
  repos: { path: string; lastActivityAt: number }[];
}
