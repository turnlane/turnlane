/**
 * 完了のシート（AI に頼むで起動した作業の片付け。launch/finish.ts・FinishSheet.tsx）:
 * - シートが出る条件（頼んだ AI があり、デーモンの finish-plan が起動の生きている依頼を返す）と出ない条件
 * - 初期値は設定（launch.finish_close_terminal・launch.finish_remove_worktree。無ければ両方オン）
 * - 取り込まれていない worktree の赤字と、チェックを入れたときだけの強制
 * - 「片付けずに完了」は片付けずに完了、Esc（取り消し）は完了にしない、「完了」は片付けてから完了
 * - 片付けだけのシート（AI の画面の片付けの節）: 「片付ける」で片付けるだけ（タスクは完了にしない）、「やめる」は何もしない
 * fetch を差し替えて、送った要求で確かめる。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LaunchFinishPlan, LaunchFinishResult, TaskView } from "@turnlane/core/web";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { queryClient } from "../src/data/client.ts";
import { completeItems, setComplete, undoLast } from "../src/data/mutations.ts";
import { I18nProvider, makeI18n } from "../src/i18n/index.tsx";
import { FinishSheetView } from "../src/launch/FinishSheet.tsx";
import {
  finishDefaults,
  finishMessages,
  finishRequest,
  getFinishSheet,
  prepareCleanup,
  riskyBranches,
  tasksWithLaunch,
} from "../src/launch/finish.ts";
import { getUi, setUi } from "../src/lib/store.ts";

const LID = "a".repeat(32);

const task = (id: string, ai: boolean, p: Partial<TaskView> = {}): TaskView =>
  ({
    id,
    title: { t: "text", text: id },
    status: "todo",
    scheduledDate: null,
    laneOrder: "a",
    createdAt: 1000,
    completedAt: null,
    followUpId: null,
    ai: ai
      ? {
          launchId: LID,
          tool: "claude_code",
          state: "done_check",
          workItemId: null,
          followUpId: null,
          repoRoot: "/w/app",
          branch: "tl/fix-lanes-1234",
          worktreePath: "/w/app-wt/tl-fix-lanes-1234",
          since: 0,
          failReason: null,
        }
      : null,
    ...p,
  }) as unknown as TaskView;

const item = (
  state: "clean" | "unmerged" | "dirty" | null,
  aiRunning = true,
): LaunchFinishPlan["launches"][number] => ({
  launchId: LID,
  taskId: "t1",
  tool: "claude_code",
  aiRunning,
  worktree:
    state === null
      ? null
      : { path: "/w/app-wt/tl-fix-lanes-1234", branch: "tl/fix-lanes-1234", state },
});

let plan: LaunchFinishPlan = { launches: [] };
let config: Record<string, unknown> = {};
let sent: { method: string; path: string; body: Record<string, unknown> }[] = [];
const finishReply: LaunchFinishResult = {
  terminal: "closed",
  reason: null,
  app: "iTerm2",
  worktree: { removed: true, reason: null, uncommitted: 0 },
};
const realFetch = globalThis.fetch;
const toasts = () => getUi().toasts.map((t) => t.text);
const paths = () => sent.map((s) => `${s.method} ${s.path}`);

/** シートが出るのを待つ */
async function sheetShown(): Promise<NonNullable<ReturnType<typeof getFinishSheet>>> {
  for (let i = 0; i < 100; i++) {
    const s = getFinishSheet();
    if (s) return s;
    await Bun.sleep(1);
  }
  throw new Error("sheet not shown");
}

beforeEach(async () => {
  for (let i = 0; i < 30; i++) await undoLast();
  plan = { launches: [] };
  config = {};
  sent = [];
  setUi({ toasts: [] });
  queryClient.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://x");
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const raw = init?.body ?? (input instanceof Request ? await input.text() : null);
    const body = raw ? (JSON.parse(String(raw)) as Record<string, unknown>) : {};
    sent.push({ method, path: url.pathname, body });
    if (url.pathname === "/api/ai/finish-plan") return Response.json(plan);
    if (url.pathname === "/api/config") return Response.json({ values: config });
    if (url.pathname.endsWith("/finish")) return Response.json(finishReply);
    if (method === "GET") return Response.json({});
    return Response.json({ rev: 1, task: null, closedFollowUps: [] });
  }) as typeof fetch;
});
afterEach(() => {
  getFinishSheet()?.resolve({ kind: "cancel" });
  globalThis.fetch = realFetch;
});

describe("シートが出る条件", () => {
  test("頼んだ AI の無いタスク・起動できなかった依頼・完了済みは finish-plan を呼ばずにすぐ完了", async () => {
    expect(
      tasksWithLaunch([
        task("a", false),
        task("b", true, {
          ai: { ...task("x", true).ai, state: "failed" } as NonNullable<TaskView["ai"]>,
        }),
        task("c", true, { status: "done" }),
        task("d", true),
      ]).map((t) => t.id),
    ).toEqual(["d"]);
    await setComplete(task("a", false), true);
    expect(paths()).toEqual(["POST /api/tasks/a/complete"]);
    expect(getFinishSheet()).toBeNull();
  });

  test("起動が生きていなければ（finish-plan が空）シートを出さずに完了", async () => {
    await setComplete(task("t1", true), true);
    expect(paths()).toEqual(["GET /api/ai/finish-plan", "POST /api/tasks/t1/complete"]);
    expect(getFinishSheet()).toBeNull();
  });

  test("生きていればシートを出す。初期値は設定（無ければ両方オン、オフにしていればオフ）", async () => {
    plan = { launches: [item("clean")] };
    const p = setComplete(task("t1", true), true);
    const s = await sheetShown();
    expect(s.defaults).toEqual({ closeTerminal: true, removeWorktree: true });
    s.resolve({ kind: "cancel" });
    await p;
    queryClient.clear();
    config = { "launch.finish_close_terminal": false };
    const p2 = setComplete(task("t1", true), true);
    expect((await sheetShown()).defaults).toEqual({ closeTerminal: false, removeWorktree: true });
    getFinishSheet()?.resolve({ kind: "cancel" });
    await p2;
    expect(finishDefaults({ "launch.finish_remove_worktree": false })).toEqual({
      closeTerminal: true,
      removeWorktree: false,
    });
  });
});

describe("シートの操作", () => {
  test("Esc（取り消し）は完了にしない・片付けない", async () => {
    plan = { launches: [item("unmerged")] };
    const p = setComplete(task("t1", true), true);
    (await sheetShown()).resolve({ kind: "cancel" });
    await p;
    expect(paths().filter((x) => x.startsWith("POST"))).toEqual([]);
  });

  test("「片付けずに完了」は片付けずに完了にする", async () => {
    plan = { launches: [item("unmerged")] };
    const p = setComplete(task("t1", true), true);
    (await sheetShown()).resolve({ kind: "skip" });
    await p;
    expect(paths().filter((x) => x.startsWith("POST"))).toEqual(["POST /api/tasks/t1/complete"]);
  });

  test("「完了」: 片付け（finish）→ タスクの完了の順。取り込まれていない worktree は強制。結果をトーストで知らせる", async () => {
    plan = { launches: [item("unmerged")] };
    const p = setComplete(task("t1", true), true);
    (await sheetShown()).resolve({
      kind: "finish",
      choice: { closeTerminal: true, removeWorktree: true },
    });
    await p;
    expect(sent.filter((x) => x.method === "POST")).toEqual([
      {
        method: "POST",
        path: `/api/ai/launches/${LID}/finish`,
        body: { closeTerminal: true, removeWorktree: true, force: true },
      },
      { method: "POST", path: "/api/tasks/t1/complete", body: {} },
    ]);
    expect(toasts()).toEqual(["Closed the tab and removed the worktree.", "Completed."]);
  });

  test("まとめて完了（複数選択）でもシートを通す", async () => {
    plan = { launches: [item("clean")] };
    const p = completeItems([task("t1", true), task("t2", false)], []);
    (await sheetShown()).resolve({ kind: "cancel" });
    await p;
    expect(paths().filter((x) => x.startsWith("POST"))).toEqual([]);
  });

  test("強制は、取り込まれていない worktree を消すと選んだときだけ。clean・消さないなら強制しない", () => {
    const on = { closeTerminal: false, removeWorktree: true };
    expect(finishRequest(item("unmerged"), on).force).toBe(true);
    expect(finishRequest(item("dirty"), on).force).toBe(true);
    expect(finishRequest(item("clean"), on).force).toBe(false);
    expect(finishRequest(item("unmerged"), { ...on, removeWorktree: false })).toEqual({
      closeTerminal: false,
      removeWorktree: false,
      force: false,
    });
    expect(finishRequest(item(null), on).removeWorktree).toBe(false);
  });

  test("失敗の知らせ: タブを閉じられない理由・worktree を残した理由", () => {
    const t = makeI18n("ja").t;
    expect(
      finishMessages(
        [
          { terminal: "not_closable", reason: "unsupported", app: "Warp", worktree: null },
          {
            terminal: "ai_still_running",
            reason: "not_exited",
            app: "iTerm2",
            worktree: { removed: false, reason: "unmerged", uncommitted: 0 },
          },
        ],
        t,
      ),
    ).toEqual([
      "タブは閉じられませんでした（Warp には送れません）。",
      "タブは閉じられませんでした（AI が終了しませんでした）。",
      "worktree は残しました（取り込まれていません）。",
    ]);
  });
});

describe("片付けだけのシート", () => {
  test("そのタスクの finish-plan を出し、「片付ける」で片付けるだけ（タスクの完了は呼ばない）", async () => {
    plan = { launches: [item("unmerged", false)] };
    const p = prepareCleanup("t1");
    const s = await sheetShown();
    expect(s.mode).toBe("cleanup");
    s.resolve({ kind: "finish", choice: { closeTerminal: true, removeWorktree: true } });
    expect(await p).toBe(true);
    expect(sent[0]?.path).toBe("/api/ai/finish-plan");
    expect(sent.filter((x) => x.method === "POST")).toEqual([
      {
        method: "POST",
        path: `/api/ai/launches/${LID}/finish`,
        body: { closeTerminal: true, removeWorktree: true, force: true },
      },
    ]);
    expect(toasts()).toEqual(["Closed the tab and removed the worktree."]);
  });

  test("「やめる」（Esc）は何もしない。起動が生きていなければシートを出さない", async () => {
    plan = { launches: [item("clean")] };
    const p = prepareCleanup("t1");
    (await sheetShown()).resolve({ kind: "cancel" });
    expect(await p).toBe(false);
    expect(paths().filter((x) => x.startsWith("POST"))).toEqual([]);
    plan = { launches: [] };
    expect(await prepareCleanup("t1")).toBe(false);
    expect(getFinishSheet()).toBeNull();
  });

  test("ボタンは「やめる」と「片付ける」（片付けずに完了・完了は出さない）", () => {
    for (const [locale, cancel, confirm] of [
      ["ja", "やめる", "片付ける"],
      ["en", "Cancel", "Clean up"],
    ] as const) {
      const out = renderToStaticMarkup(
        createElement(
          I18nProvider,
          { locale } as Parameters<typeof I18nProvider>[0],
          createElement(FinishSheetView, {
            state: {
              plan: { launches: [item("unmerged")] },
              defaults: { closeTerminal: true, removeWorktree: true },
              mode: "cleanup",
            },
            onDecide: () => {},
          }),
        ),
      );
      expect(out).toContain('data-mode="cleanup"');
      expect(out).toContain(cancel);
      expect(out).toContain(confirm);
      expect(out).toContain("finish-cancel");
      expect(out).not.toContain("finish-skip");
    }
  });
});

describe("シートの見た目", () => {
  const html = (p: LaunchFinishPlan) =>
    renderToStaticMarkup(
      createElement(
        I18nProvider,
        { locale: "ja" } as Parameters<typeof I18nProvider>[0],
        createElement(FinishSheetView, {
          state: { plan: p, defaults: { closeTerminal: true, removeWorktree: true } },
          onDecide: () => {},
        }),
      ),
    );

  test("未マージなら worktree の行の下に赤字（ブランチ名）。取り込み済みなら注記なし。worktree が無ければ行を出さない", () => {
    const risky = html({ launches: [item("unmerged")] });
    expect(risky).toContain("AI を終了してタブを閉じる");
    expect(risky).toContain("worktree を消す");
    expect(risky).toContain("ブランチの変更が消えます（tl/fix-lanes-1234）");
    expect(risky).toMatch(/class="[^"]*text-error[^"]*"[^>]*data-testid="finish-risky"/);
    expect(risky).toContain("片付けずに完了");
    const clean = html({ launches: [item("clean")] });
    expect(clean).toContain("worktree を消す");
    expect(clean).not.toContain("finish-risky");
    const none = html({ launches: [item(null)] });
    expect(none).not.toContain("worktree を消す");
    expect(riskyBranches({ launches: [item("dirty"), item("clean")] })).toEqual([
      "tl/fix-lanes-1234",
    ]);
  });
});
