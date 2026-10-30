/**
 * 完了のときの片付け（AI に頼むで起動した作業）: 起動が生きている依頼のタスクを完了にするとき、完了のシートを出して
 * 「AI を終了してタブを閉じる」「worktree を消す」を選んでもらい、片付けてからタスクを完了にする（ux-mvp「AI に頼む」）。
 *
 * - シートを出すのは、完了にするタスクに頼んだ AI（TaskView.ai）があり、デーモンの finish-plan が起動の生きている依頼を
 *   返したときだけ。それ以外は今までどおりすぐ完了にする（MCP の complete_task・CLI の turnlane done はシートを出せないので
 *   デーモンの自動の片付けだけ）
 * - 初期値は設定 › AI に頼む の「完了したとき」（launch.finish_close_terminal・launch.finish_remove_worktree。既定オン）。
 *   シートで変えた値は覚えない
 * - 取り込まれていない worktree（unmerged・dirty）は、シートでチェックを入れたときだけ強制で消す
 * - 片付けのどれかが失敗してもタスクは完了にする（失敗はトーストで知らせる）。Esc で取り消すと完了にしない
 * - 片付けだけのシート（AI の画面の「片付けが残っている」。ux-mvp 4.19）: タスクが完了済み（片付けずに完了で済ませた後）の
 *   起動を片付ける。同じシート・同じ 2 つのチェックで、ボタンだけ「片付ける」（⏎）と「やめる」（Esc）
 */
import type {
  LaunchFinishItem,
  LaunchFinishPlan,
  LaunchFinishResult,
  TaskView,
} from "@turnlane/core/web";
import { queryClient } from "../data/client.ts";
import { getLocale } from "../i18n/current.ts";
import { type MessageKey, translate } from "../i18n/index.tsx";
import { api, unwrap } from "../lib/api.ts";
import { toast } from "../lib/store.ts";

export interface FinishChoice {
  closeTerminal: boolean;
  removeWorktree: boolean;
}

export type FinishDecision =
  | { kind: "cancel" }
  | { kind: "skip" }
  | { kind: "finish"; choice: FinishChoice };

export interface FinishSheetState {
  plan: LaunchFinishPlan;
  defaults: FinishChoice;
  /** complete = 完了のシート（完了 / 片付けずに完了）、cleanup = 片付けだけ（片付ける / やめる）。省略は complete */
  mode?: "complete" | "cleanup";
  /**
   * 片付けの途中（「完了」「片付ける」を押した後、終わるまで）。チェックとボタンを止め、主ボタンを `片付けています…` に
   * する。waitingAi は AI の終了を待つ（タブを閉じるを選んだ。最長 20 秒）
   */
  busy?: { waitingAi: boolean };
}

/** 完了にするタスクのうち、頼んだ AI があるもの（起動できなかった依頼は除く）。無ければ finish-plan を呼ばない */
export function tasksWithLaunch(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter((t) => t.status !== "done" && t.ai && t.ai.state !== "failed");
}

/** 設定の値 → シートの初期値（無ければ両方オン） */
export function finishDefaults(values: Record<string, unknown> | undefined): FinishChoice {
  return {
    closeTerminal: values?.["launch.finish_close_terminal"] !== false,
    removeWorktree: values?.["launch.finish_remove_worktree"] !== false,
  };
}

/** worktree が残っている依頼 */
export function planWorktrees(plan: LaunchFinishPlan): LaunchFinishItem[] {
  return plan.launches.filter((l) => l.worktree !== null);
}

/** 消すと変更が消える（取り込まれていない・未コミットの）ブランチの名前。ブランチが無ければフォルダの名前 */
export function riskyBranches(plan: LaunchFinishPlan): string[] {
  return planWorktrees(plan)
    .filter((l) => l.worktree?.state !== "clean")
    .map((l) => l.worktree?.branch ?? l.worktree?.path.split("/").at(-1) ?? "");
}

/** 依頼ごとに送る片付け（強制は取り込まれていない worktree をシートで消すと選んだときだけ） */
export function finishRequest(
  l: LaunchFinishItem,
  c: FinishChoice,
): { closeTerminal: boolean; removeWorktree: boolean; force: boolean } {
  const wt = c.removeWorktree && l.worktree !== null;
  return {
    closeTerminal: c.closeTerminal,
    removeWorktree: wt,
    force: wt && l.worktree?.state !== "clean",
  };
}

type T = (key: MessageKey, params?: Record<string, string | number>) => string;

/** 片付けの結果 → トーストの文（成功は 1 つにまとめ、失敗は理由ごとに） */
export function finishMessages(results: readonly LaunchFinishResult[], t: T): string[] {
  const closed = results.some((r) => r.terminal === "closed");
  const removed = results.some((r) => r.worktree?.removed === true);
  const out: string[] = [];
  if (closed && removed) out.push(t("finish.toast.both"));
  else if (closed) out.push(t("finish.toast.closed"));
  else if (removed) out.push(t("finish.toast.removed"));
  for (const r of results) {
    if (r.terminal && r.terminal !== "closed") {
      const why =
        r.terminal === "not_closable"
          ? r.app
            ? t("finish.why.unsupportedApp", { app: r.app })
            : t("finish.why.unsupported")
          : r.terminal === "ai_still_running"
            ? t("finish.why.not_exited")
            : t(`finish.why.${r.reason ?? "send_failed"}` as MessageKey);
      out.push(t("finish.toast.terminalFailed", { why }));
    }
    if (r.worktree && !r.worktree.removed && r.worktree.reason !== "missing") {
      out.push(
        t("finish.toast.worktreeKept", {
          why: t(`finish.wt.${r.worktree.reason ?? "failed"}` as MessageKey),
        }),
      );
    }
  }
  return [...new Set(out)];
}

// ---------- シートの状態（画面に 1 つ。FinishSheet が読む） ----------

let sheet: (FinishSheetState & { resolve: (d: FinishDecision) => void }) | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function subscribeFinishSheet(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getFinishSheet():
  | (FinishSheetState & { resolve: (d: FinishDecision) => void })
  | null {
  return sheet;
}

/**
 * シートを出して、選ばれるまで待つ（もう出ていれば前のものを取り消す）。「完了」「片付ける」を選んだら、シートは閉じずに
 * 片付けの途中の見え方にする（closeFinishSheet で閉じる）
 */
export function openFinishSheet(s: FinishSheetState): Promise<FinishDecision> {
  sheet?.resolve({ kind: "cancel" });
  return new Promise((resolve) => {
    let done = false;
    sheet = {
      ...s,
      resolve: (d) => {
        if (done) return;
        done = true;
        if (d.kind === "finish" && sheet)
          sheet = { ...sheet, busy: { waitingAi: d.choice.closeTerminal } };
        else sheet = null;
        emit();
        resolve(d);
      },
    };
    emit();
  });
}

/** 片付けが終わったらシートを閉じる */
export function closeFinishSheet(): void {
  if (!sheet) return;
  sheet = null;
  emit();
}

// ---------- 片付け中のタスク（行の札を `片付け中` にする） ----------

let cleaning: ReadonlySet<string> = new Set();
const cleaningListeners = new Set<() => void>();

export function subscribeCleaning(l: () => void): () => void {
  cleaningListeners.add(l);
  return () => cleaningListeners.delete(l);
}

/** 片付けの途中のタスクの ID */
export function getCleaning(): ReadonlySet<string> {
  return cleaning;
}

function setCleaning(ids: readonly string[]): void {
  cleaning = new Set(ids);
  for (const l of cleaningListeners) l();
}

async function configValues(): Promise<Record<string, unknown> | undefined> {
  try {
    return await queryClient.fetchQuery({
      queryKey: ["settings", "config"],
      queryFn: () =>
        unwrap<{ values: Record<string, unknown> }>(api.api.config.$get()).then((r) => r.values),
      staleTime: 30_000,
    });
  } catch {
    return undefined;
  }
}

/**
 * 完了の前の片付け。シートを出さずに進めるなら true、Esc で取り消したら false（完了にしない）。
 * 片付けたら結果をトーストで知らせる（失敗してもタスクは完了にするので true）
 */
export async function prepareFinish(tasks: readonly TaskView[]): Promise<boolean> {
  const cands = tasksWithLaunch(tasks);
  if (cands.length === 0) return true;
  let plan: LaunchFinishPlan;
  try {
    plan = await unwrap<LaunchFinishPlan>(
      api.api.ai["finish-plan"].$get({ query: { taskIds: cands.map((t) => t.id).join(",") } }),
    );
  } catch {
    return true;
  }
  if (!plan.launches || plan.launches.length === 0) return true;
  const d = await openFinishSheet({ plan, defaults: finishDefaults(await configValues()) });
  if (d.kind === "cancel") return false;
  if (d.kind === "skip") return true;
  await runFinish(plan, d.choice);
  return true;
}

/**
 * 片付けだけ（AI の画面の「片付けが残っている」。タスクは完了済み）: そのタスクの起動が生きている依頼をシートに出し、
 * 「片付ける」で片付ける。Esc（やめる）なら何もしない。片付けたら true
 */
export async function prepareCleanup(taskId: string): Promise<boolean> {
  let plan: LaunchFinishPlan;
  try {
    plan = await unwrap<LaunchFinishPlan>(
      api.api.ai["finish-plan"].$get({ query: { taskIds: taskId } }),
    );
  } catch {
    return false;
  }
  if (!plan.launches || plan.launches.length === 0) return false;
  const d = await openFinishSheet({
    plan,
    defaults: finishDefaults(await configValues()),
    mode: "cleanup",
  });
  if (d.kind !== "finish") return false;
  await runFinish(plan, d.choice);
  queryClient.invalidateQueries({ queryKey: ["aiLive"] });
  return true;
}

/**
 * シートで選んだ片付けを依頼ごとに送り、結果をトーストで知らせる。その間シートは片付けの途中の見え方で、タスクの行の札は
 * `片付け中`。終わったらシートを閉じる
 */
async function runFinish(plan: LaunchFinishPlan, choice: FinishChoice): Promise<void> {
  setCleaning(plan.launches.map((l) => l.taskId));
  try {
    await sendFinish(plan, choice);
  } finally {
    setCleaning([]);
    closeFinishSheet();
  }
}

async function sendFinish(plan: LaunchFinishPlan, choice: FinishChoice): Promise<void> {
  const locale = getLocale();
  const t: T = (k, p) => translate(locale, k, p);
  if (!choice.closeTerminal && !choice.removeWorktree) return;
  const results: LaunchFinishResult[] = [];
  for (const l of plan.launches) {
    const json = finishRequest(l, choice);
    if (!json.closeTerminal && !json.removeWorktree) continue;
    try {
      results.push(
        await unwrap<LaunchFinishResult>(
          api.api.ai.launches[":id"].finish.$post({ param: { id: l.launchId }, json }),
        ),
      );
    } catch {
      results.push({
        terminal: json.closeTerminal ? "failed" : null,
        reason: json.closeTerminal ? "send_failed" : null,
        app: null,
        worktree: json.removeWorktree
          ? { removed: false, reason: "failed", uncommitted: null }
          : null,
      });
    }
  }
  for (const m of finishMessages(results, t)) toast(m, undefined, 6000);
}
