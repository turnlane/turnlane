/** ⌘K の検索（GET /api/search。m2-api.md 17章、M2-15）。本文は扱わない（題名・リポジトリ・ブランチ・PR 番号だけ） */
import { z } from "zod";
import type { SourceBadge, TaskView } from "./board.ts";
import type { EpochMs, LocalDate, ReadMeta, WorkItemStatus } from "./common.ts";

export const SEARCH_LIMIT_DEFAULT = 5;
export const SEARCH_LIMIT_MAX = 20;

export const searchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
});

export interface SearchTask {
  task: TaskView;
}

export interface SearchAiItem {
  id: string;
  title: string | null;
  status: WorkItemStatus;
  estimated: boolean;
  sources: SourceBadge[];
  /** リポジトリ名（repo_root の末尾） */
  repo: string | null;
  /** 壁打ち（D-135） */
  scratch?: boolean;
  branch: string | null;
  /** PR 番号（work_item.pr_ref と ai_artifact の PR。新しい順） */
  prs: number[];
  lastActivityAt: EpochMs;
  /** 最後に動いた暦日（表示用。D-054） */
  date: LocalDate;
}

export interface SearchEvent {
  id: string;
  title: string | null;
  start: EpochMs;
  end: EpochMs;
  allDay: boolean;
  /** 始まりの暦日（終日予定は start_date） */
  date: LocalDate;
}

export interface SearchResponse extends ReadMeta {
  q: string;
  tasks: SearchTask[];
  aiItems: SearchAiItem[];
  events: SearchEvent[];
}
