/**
 * Inbox（S4。M2-4）: 日付なしのタスク。行は自分の番の画面と同じ部品（InboxRow。Inbox のレビュー v1）で、2行目に
 * プロジェクトと出どころ（利用者の言葉。手で入れたものは出さない）、右端に見積もり・メモの印、7日以上残ったものは薄い字の
 * `8日前`（自動削除はしない）。見出しは上部バーの「Inbox」と数の丸。先頭の「＋ タスクを追加」の行に自然言語で書いて ⏎ で追加
 * （日付が無ければ Inbox。段階 B (1)）。c でも追加、m で日付へ、t で今日へ、r で題名をその場で変える。クリック・⏎・→ で
 * タスクの詳細パネル（D-070）。
 * 完了にした行はその場に塗った ✓ で少し残し（LINGER_MS）、その後は下の「今日閉じた n」の畳みへ移す（自分の番の画面と同じ
 * 畳み。D-139 (4)）。畳みの中の ✓ を押すと未完了に戻す
 */
import type { TaskView } from "@turnlane/core/web";
import { useState } from "react";
import {
  ItemActionsProvider,
  useItemActionsHost,
  usePanelFollow,
} from "../actions/item-actions.tsx";
import { type Prompt, PromptView } from "../board/editors.tsx";
import { AddRow } from "../components/AddRow.tsx";
import { InboxRow } from "../components/InboxRow.tsx";
import { titleText } from "../components/items.tsx";
import { ClosedFold } from "../components/TurnRow.tsx";
import { createTask, deleteTask, moveTask, renameTask, setComplete } from "../data/mutations.ts";
import { useInbox, useProjects } from "../data/queries.ts";
import { useI18n } from "../i18n/index.tsx";
import { useKeys } from "../keys/use-keys.ts";
import { addDaysSafe } from "../lib/dates.ts";
import { type SelItem, setUi, useUi } from "../lib/store.ts";
import { useFocusRequest, usePublishSelection } from "../palette/selection.ts";

export function InboxPage() {
  const { t, locale } = useI18n();
  const q = useInbox();
  const projects = useProjects().data ?? [];
  const projectOf = (id: string | null) => (id ? projects.find((p) => p.id === id) : null);
  // 完了にした直後の行はその場に残す（作成の新しい順に並べ直す。D-139 (4)）
  const recent = useUi((s) => s.recentDone);
  const closedAll = q.data?.closed ?? [];
  const tasks = [...(q.data?.tasks ?? []), ...closedAll.filter((x) => x.id in recent)].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
  const closed = closedAll.filter((x) => !(x.id in recent));
  const aiReady = (x: TaskView) => {
    const p = projectOf(x.projectId);
    return !!p && p.repoPaths.length > 0 && !x.ai;
  };
  const [cur, setCur] = useState(0);
  // 選択の枠は、キーで動かした後か詳細パネルを開いている間だけ（自分の番の画面と同じ。開いた直後は出さない）
  const [navigated, setNavigated] = useState(false);
  const panelTaskId = useUi((s) => s.panelTaskId);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const sel: TaskView | undefined = tasks[Math.min(cur, tasks.length - 1)];
  const anchor = () =>
    sel ? document.querySelector<HTMLElement>(`[data-kind="task"][data-id="${sel.id}"]`) : null;
  const today = q.data?.today ?? "";
  useKeys({
    next: () => {
      setNavigated(true);
      setCur((c) => Math.min(tasks.length - 1, c + 1));
      return true;
    },
    prev: () => {
      setNavigated(true);
      setCur((c) => Math.max(0, c - 1));
      return true;
    },
    new: () => {
      setPrompt({ kind: "new", date: null, anchor: document.querySelector("h1") });
      return true;
    },
    today: () => {
      if (sel) void moveTask(sel, today);
      return true;
    },
    move: () => {
      if (!sel) return false;
      const task = sel;
      setPrompt({ kind: "move", anchor: anchor(), onSubmit: (d) => void moveTask(task, d) });
      return true;
    },
    rename: () => {
      if (!sel) return false;
      const task = sel;
      setPrompt({
        kind: "rename",
        initial: titleText(task.title, locale),
        anchor: anchor(),
        onSubmit: (v) => void renameTask(task, v),
      });
      return true;
    },
    complete: () => {
      if (sel) void setComplete(sel, sel.status !== "done");
      return true;
    },
    // ⏎ と → / ⌘⏎ はタスクの詳細パネル（D-070）
    open: () => {
      if (!sel) return false;
      setUi({ panelTaskId: sel.id });
      return true;
    },
    detail: () => {
      if (!sel) return false;
      setUi({ panelTaskId: sel.id });
      return true;
    },
    delete: () => {
      if (sel) void deleteTask(sel);
      return true;
    },
    // 1日後へ（日付の無いタスクは明日へ。右クリックメニュー・ホバーのボタンと同じ。UX 監査 A1）
    later: () => {
      if (!sel || !today) return false;
      void moveTask(sel, addDaysSafe(sel.scheduledDate ?? today, 1));
      return true;
    },
  });
  // ⌘K（ux-mvp 6.1）: 選んでいるタスクをパレットに渡し、検索結果から来たタスクを選ぶ
  usePublishSelection(sel ? [{ kind: "task", task: sel }] : []);
  useFocusRequest(
    (f) => {
      if (f.date !== null) return false;
      const i = tasks.findIndex((x) => `task:${x.id}` === f.key);
      if (i < 0) return false;
      setCur(i);
      return true;
    },
    [tasks],
  );
  // マウスの操作（UX 監査 A1〜A3）: 1クリックで選択とパネル、ダブルクリックで名前の変更、右クリック・ホバーのボタン
  const host = useItemActionsHost({
    select: (k) => {
      const i = tasks.findIndex((x) => `task:${x.id}` === k);
      if (i >= 0) setCur(i);
    },
    inMulti: () => false,
    itemsFor: (k) =>
      tasks.filter((x) => `task:${x.id}` === k).map((task): SelItem => ({ kind: "task", task })),
  });
  usePanelFollow(sel ? `task:${sel.id}` : null);
  const now = q.data?.now ?? 0;
  return (
    <ItemActionsProvider value={host.api}>
      {/* 一覧の幅と余白は自分の番の画面と同じ（詳細パネルを開いても同じ並び）。見出しは上部バー */}
      <div className="flex h-full min-w-0 flex-col gap-4 overflow-y-auto px-8 py-6">
        <AddRow today={today} />
        {tasks.length === 0 && q.isSuccess ? (
          <p className="py-8 text-center text-body text-fg3">{t("inbox.empty")}</p>
        ) : null}
        <div className="flex flex-col gap-1.5" data-testid="inbox-list">
          {tasks.map((x, i) => (
            <InboxRow
              key={x.id}
              task={x}
              now={now}
              project={projectOf(x.projectId)}
              selected={i === cur && (navigated || panelTaskId === x.id)}
              onClick={() => host.api.click(`task:${x.id}`)}
              onToggle={() => void setComplete(x, x.status !== "done")}
              aiReady={aiReady(x)}
              lingering={x.status === "done"}
            />
          ))}
        </div>
        {closed.length > 0 ? (
          <section className="pl-2" data-testid="inbox-closed">
            <ClosedFold count={closed.length}>
              <div className="flex flex-col gap-1.5">
                {closed.map((x) => (
                  <InboxRow
                    key={x.id}
                    task={x}
                    now={now}
                    project={projectOf(x.projectId)}
                    onClick={() => setUi({ panelTaskId: x.id })}
                    onToggle={() => void setComplete(x, false)}
                  />
                ))}
              </div>
            </ClosedFold>
          </section>
        ) : null}
        {prompt ? (
          <PromptView
            prompt={prompt}
            today={today}
            onClose={() => setPrompt(null)}
            onCreate={(raw, date, extra) =>
              void createTask({
                raw,
                date: extra.date ?? date,
                ...(extra.estimateMin !== undefined ? { estimateMin: extra.estimateMin } : {}),
              })
            }
          />
        ) : null}
        {host.node}
      </div>
    </ItemActionsProvider>
  );
}
