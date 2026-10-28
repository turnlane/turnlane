/**
 * AI の詳細パネル（S6。D-115・D-116 で作り直した。案 design/mock-ai-detail-v1 の A〜F。README の R37〜）: 右の 380px。
 * 自分の番の画面の詳細（確定画像 Q1、R16）と同じ作りで、見る人の問いの順に答える:
 * 1. 状態とすること（「自分の番 · 返答待ち · 1h24m」と文）→ 2. リポジトリ · ブランチと開く先（主のボタン1つ・他の開き方 ▾・⋯）
 * → 3. 成果（PR とレビューの判定、確認支援の CI・変更の量・テスト・worktree。M5-B）→ 4. この項目の流れと合計（直近だけ、古い区間は畳む）。
 * ターンの一覧・ツール呼び出しの数・取り込み元の札・壁時計・内部の種類名は出さない。自分の番に出ているときだけ、待っている理由
 * （許可を求めているコマンド・AI の問い。表示の瞬間に手元の記録から読む。保存しない。D-207、ADR 0005 の追記 2）を出す。
 * 状態を問わず、AI の最後の発言（「最後の返答」。表示の瞬間に記録から読む。保存しない。ADR 0019 の Decision 10）を出す
 */

import { useQuery } from "@tanstack/react-query";
import type { OpenOptions, WorkItemDetail } from "@turnlane/core/web";
import { aiItemSubject, fmtClock, fmtDuration, nextWeekday, prLabel } from "@turnlane/core/web";
import {
  ArrowRightToLine,
  Ban,
  Check,
  ChevronDown,
  Circle,
  Clock,
  EyeOff,
  GitBranch,
  GitPullRequest,
  MessagesSquare,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import { AnswerSection, openAnswer, useAnswerOpen } from "../components/AnswerSection.tsx";
import { ContextMenu, type MenuEntry } from "../components/ContextMenu.tsx";
import { FlowSection } from "../components/Flow.tsx";
import { LastReplySection } from "../components/LastReply.tsx";
import { Nums } from "../components/Nums.tsx";
import { openActionIcon, useOpenLabel } from "../components/OpenWith.tsx";
import { StatusIcon } from "../components/StatusIcon.tsx";
import { turnView, WhyBlock } from "../components/TurnWhy.tsx";
import { SdkChip, viaSdk } from "../components/ui.tsx";
import { useAnswerEnabled } from "../data/answer.ts";
import { useGlance, useItemGlance } from "../data/glance.ts";
import {
  completeFollowUp,
  createReplyTask,
  deferFollowUp,
  dismissFollowUps,
  openTask,
  patchWorkItem,
  snoozeFollowUp,
} from "../data/mutations.ts";
import { useQueue, useWorkItem } from "../data/queries.ts";
import { type MessageKey, useI18n } from "../i18n/index.tsx";
import { keyHint } from "../keys/keymap.ts";
import { useKeys } from "../keys/use-keys.ts";
import { CheckRows, hasCheckRows, useCheck } from "../launch/CheckRows.tsx";
import { api, unwrap } from "../lib/api.ts";
import { useNow } from "../lib/clock.ts";
import { deferredTurn, laterTextOf } from "../lib/later-text.ts";
import { setUi, useUi } from "../lib/store.ts";
import { whereName } from "../lib/where.ts";
import { type AiHead, type AiText, aiHeadOf, prStateKey } from "./ai-state.ts";
import { ActionButton, MoreButton, PanelFrame, PanelHead } from "./PanelFrame.tsx";

export function AiPanel() {
  const id = useUi((s) => s.panelWorkItemId);
  const { t } = useI18n();
  const q = useWorkItem(id);
  // y: 自分のタスクにする（返答タスクを手で作る。D-066 (2)）。パネルを開いている間はボードの選択より優先
  useKeys({
    replyTask: () => {
      if (!id) return false;
      void createReplyTask(id);
      return true;
    },
  });
  if (!id) return null;
  const d = q.data;
  return (
    <PanelFrame label={t("ai.detail")} testId="ai-panel" variant="detail">
      {!d ? (
        <>
          <PanelHead title={t("ai.detail")} onClose={closeAi} />
          <div className="text-body text-fg3">
            {q.isError ? t("ai.notFound") : t("common.loading")}
          </div>
        </>
      ) : (
        <AiDetail id={id} d={d} />
      )}
    </PanelFrame>
  );
}

const closeAi = () => setUi({ panelWorkItemId: null });

function AiDetail({ id, d }: { id: string; d: WorkItemDetail }) {
  const { t, locale } = useI18n();
  const now = useNow();
  const tz = d.tz;
  // 自分の番に出ていれば、待ちの長さは行と同じ始まりから（D-214 の §4）
  const item = useQueue().data?.items.find((x) => x.workItemId === id);
  // 後でにした自分の番（スヌーズ・明日へ・時間に置いた）は補足に戻る時刻（自分の番の画面の「後で」の行と同じ文）
  const later = deferredTurn(item) ? laterTextOf(item, d.today, now, tz) : null;
  const head = aiHeadOf(
    d,
    now,
    { clock: (ms) => fmtClock(ms, tz), dur: fmtDuration },
    item?.waitingSince,
    later,
  );
  // 差し込んだ言葉が英字で始まるとき（「API の混雑」「Web へのアクセス」）は「が」の後に空白を入れる（D-214 の §4）
  const text = (x: AiText) =>
    t(x.key, {
      ...x.params,
      ...Object.fromEntries(Object.entries(x.keyParams ?? {}).map(([k, v]) => [k, t(v)])),
    }).replace(/が([A-Za-z])/g, "が $1");
  const pr = d.artifacts.filter((a) => a.kind === "pr").at(-1) ?? null;
  // 確認支援（差分の量・テスト・CI・worktree。D-109・D-116）
  const check = useCheck({ workItemId: id }).data;
  const checks = hasCheckRows(check) ? check : undefined;
  // 見出しは件名（spec-glance §2.2・§3.7）。自分の番に出ていれば行と同じ件名、ほかは直近の指示 → 自動の題名
  // （fix-stale-title・D-214 (1)）
  const glance = useGlance(item ?? null);
  const itemGlance = useItemGlance(
    id,
    `${d.workItem.status}|${d.workItem.lastActivityAt}`,
    item === undefined,
  );
  const view = item ? turnView(item, glance, locale) : null;
  const heading = view ? view.subject : aiItemSubject(d.workItem, itemGlance);
  // Turnlane から答える（D-238）: 問い・許可・エラーの待ち。対象は待ちそのもの（D-240）で、猶予の間の問いのように
  // 自分の番の行がまだ無いときも詳細の openWait で出す
  const wait = item?.wait ?? d.openWait;
  const canAnswer = useAnswerEnabled() && !!wait;
  const answering = useAnswerOpen(id) && canAnswer;
  useKeys({
    answer: () => {
      if (!canAnswer) return false;
      openAnswer(id);
      return true;
    },
  });
  return (
    <>
      <PanelHead title={heading || t("common.none")} onClose={closeAi} />
      <div
        className={`flex flex-col gap-1.5 ${head.blocked ? "-mt-2 rounded-card bg-amber px-3 py-2.5" : "-mt-3"}`}
        data-testid="ai-state"
        data-blocked={head.blocked ? "1" : undefined}
      >
        <div className="flex items-center gap-2 text-body">
          <StatusIcon status={head.status} estimated={d.workItem.estimated} size={16} />
          <span className="font-medium text-fg">{t(head.head)}</span>
          <span className="min-w-0 truncate text-fg2">
            {head.sub ? ` · ${t(head.sub)}` : ""}
            {head.durMs !== null ? (
              <>
                {" · "}
                <span className="font-mono">{fmtDuration(head.durMs)}</span>
              </>
            ) : null}
          </span>
        </div>
        <p className="text-body text-fg" data-testid="ai-todo">
          {text(head.todo)}
        </p>
        {head.hint ? (
          <p className="text-fg2 text-meta" data-testid="ai-hint">
            <Nums text={text(head.hint)} />
          </p>
        ) : null}
      </div>
      {/* 答えている間の問いは「答える」の節が全文で出す（許可待ちのツールと中身は上に残す） */}
      {item && view && !(answering && wait?.kind !== "permission") ? (
        <WhyBlock view={view} prompt={glance?.prompt?.text} />
      ) : null}
      <div className="flex flex-col gap-2.5">
        {d.workItem.repoRoot || d.workItem.branch || d.workItem.scratch ? (
          <div className="flex items-center gap-1.5 text-fg2 text-meta">
            {/* 壁打ち（D-135）はリポジトリではないので会話のアイコン */}
            {d.workItem.scratch && !d.workItem.repoRoot ? (
              <MessagesSquare size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
            ) : (
              <GitBranch size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
            )}
            <span className="min-w-0 truncate">
              {[whereName(d.workItem, t("ai.scratch")), d.workItem.branch]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {viaSdk(d.workItem.sources) ? <SdkChip label={t("ai.viaSdk")} /> : null}
          </div>
        ) : null}
        <Actions id={id} d={d} head={head} answer={canAnswer} answering={answering} />
      </div>
      {/* 最後の返答（Issue #8）: 開いた瞬間に記録から読む。答えている間の問いは「答える」の節が全文で出すので出さない */}
      {answering && wait?.kind !== "permission" ? null : (
        <LastReplySection
          key={id}
          workItemId={id}
          version={`${d.workItem.status}|${d.workItem.lastActivityAt}`}
        />
      )}
      {canAnswer ? <AnswerSection workItemId={id} wait={wait} /> : null}
      {pr || checks ? (
        <section className="flex flex-col gap-2 border-line border-t pt-4" data-testid="ai-result">
          <h3 className="font-semibold text-fg2 text-meta">{t("ai.result")}</h3>
          {pr ? (
            <a
              href={pr.url ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-center gap-2 rounded-card border border-line px-3 py-2 text-body text-fg hover:border-fg3"
            >
              <GitPullRequest
                size={16}
                strokeWidth={1.5}
                className="shrink-0 text-fg2"
                aria-hidden="true"
              />
              <span className="shrink-0">{prLabel(pr.ref)}</span>
              <span className="min-w-0 flex-1 truncate">{pr.title}</span>
              {prStateKey(pr) ? (
                <span className="shrink-0 text-fg2 text-meta" data-testid="ai-pr-state">
                  {t(prStateKey(pr) as MessageKey)}
                </span>
              ) : null}
            </a>
          ) : null}
          {checks ? <CheckRows c={checks} /> : null}
        </section>
      ) : null}
      <FlowSection detail={d} now={now} tz={tz} />
      <p className="mt-auto text-[11px] text-fg3 leading-[14px]">{t("ai.foot")}</p>
    </>
  );
}

/** 主のボタン（状態の言葉で既定の開き方）・他の開き方 ▾・⋯（スヌーズ・明日へ・対応不要・自分のタスクにする・完了・非表示） */
function Actions({
  id,
  d,
  head,
  answer = false,
  answering = false,
}: {
  id: string;
  d: WorkItemDetail;
  head: AiHead;
  /** 「答える」を出す（D-238） */
  answer?: boolean;
  /** 「答える」の節を開いている（主ボタンは節の「送る」に譲る。1 画面に主ボタンは 1 つ） */
  answering?: boolean;
}) {
  const { t } = useI18n();
  const label = useOpenLabel();
  const opts = useQuery({
    queryKey: ["open-options", id],
    queryFn: () => unwrap<OpenOptions>(api.api.open.options.$get({ query: { workItemId: id } })),
    staleTime: 30_000,
  }).data?.options;
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  // 開いている自分の番（スヌーズ・明日へ・対応不要・完了は自分の番に効く）
  const fu =
    d.followUps.filter((f) => f.status === "open" || f.status === "snoozed").at(-1) ?? null;
  const at = (el: HTMLElement, alignRight = false) => {
    const r = el.getBoundingClientRect();
    return { x: alignRight ? r.right - 240 : r.left, y: r.bottom + 4 };
  };
  const primary = () => {
    if (head.primaryPr && opts?.some((o) => o.action === "pr"))
      void openTask({ workItemId: id, action: "pr" });
    else if (fu) void openTask({ followUpId: fu.id });
    else void openTask({ workItemId: id, ...(opts?.[0] ? { action: opts[0].action } : {}) });
  };
  const openEntries = (): MenuEntry[] =>
    (opts ?? []).map((o, i) => ({
      id: `open-${o.action}`,
      label: label(o),
      icon: openActionIcon(o.action),
      keys: i === 0 ? keyHint("open") : undefined,
      sep: o.action === "copy_resume" && i > 0,
      run: () => void openTask({ workItemId: id, action: o.action }),
    }));
  const snoozeEntries = (fid: string): MenuEntry[] =>
    (["30m", "1h", "tomorrow_morning"] as const).map((p) => ({
      id: `snooze-${p}`,
      label: t(p === "tomorrow_morning" ? "snooze.tomorrow" : (`snooze.${p}` as MessageKey)),
      run: () => void snoozeFollowUp(fid, p),
    }));
  const moreEntries = (anchor: { x: number; y: number }): MenuEntry[] => {
    const st = d.workItem.status;
    const out: MenuEntry[] = [];
    const done = (): MenuEntry => ({
      id: "done",
      label: t("ai.markDone"),
      icon: Check,
      keys: keyHint("complete"),
      run: () => void (fu ? completeFollowUp(fu.id) : patchWorkItem(id, { manualDone: true })),
    });
    const snooze = (fid: string): MenuEntry => ({
      id: "snooze",
      label: t("menu.snooze"),
      icon: Clock,
      keys: keyHint("snooze"),
      sub: true,
      run: () => setTimeout(() => setMenu({ ...anchor, entries: snoozeEntries(fid) }), 0),
    });
    const makeTask: MenuEntry = {
      id: "makeTask",
      label: t("ai.makeTask"),
      icon: Circle,
      keys: keyHint("replyTask"),
      run: () => void createReplyTask(id),
    };
    const hide: MenuEntry = {
      id: "hide",
      label: t("ai.hide"),
      icon: EyeOff,
      danger: true,
      run: () => void patchWorkItem(id, { hidden: true }),
    };
    if (st === "done") {
      if (d.workItem.manualDoneAt !== null)
        out.push({
          id: "undone",
          label: t("ai.unmarkDone"),
          icon: Undo2,
          run: () => void patchWorkItem(id, { manualDone: false }),
        });
      out.push({ ...hide, sep: out.length > 0 });
      return out;
    }
    if (st === "running") return [done(), makeTask, { ...hide, sep: true }];
    // 自分の番・ブロック中・エラー・PR の確認待ち
    if (head.primaryPr || d.workItem.reason === "edits") out.push(done());
    if (fu) out.push(snooze(fu.id));
    if (fu && st === "your_turn" && !head.primaryPr && d.workItem.reason !== "edits")
      out.push({
        id: "tomorrow",
        label: t("menu.tomorrow"),
        icon: ArrowRightToLine,
        keys: keyHint("move"),
        run: () => void deferFollowUp(fu.id, nextWeekday(d.today)),
      });
    out.push(makeTask);
    if (!(head.primaryPr || d.workItem.reason === "edits")) out.push(done());
    if (fu)
      out.push({
        id: "dismiss",
        label: t("menu.dismiss"),
        icon: Ban,
        keys: keyHint("dismiss"),
        danger: true,
        sep: true,
        run: () => void dismissFollowUps([fu.id]),
      });
    out.push({ ...hide, sep: !fu });
    return out;
  };
  return (
    // 「…」は 1 行目の右端に留める（絶対配置。右に幅を空け、ほかのボタンだけが幅に応じて左寄せで折り返す）
    <div
      className="relative mt-0.5 flex flex-wrap items-center gap-1.5 pr-10"
      data-testid="ai-actions"
    >
      <ActionButton
        primary={!answering}
        onClick={primary}
        keys={keyHint("open")}
        testId="ai-primary"
      >
        {t(head.primary)}
      </ActionButton>
      {answer && !answering ? (
        <ActionButton onClick={() => openAnswer(id)} keys={keyHint("answer")} testId="ai-answer">
          {t("answer.action")}
        </ActionButton>
      ) : null}
      {opts && opts.length > 0 ? (
        <ActionButton
          keys={keyHint("openWith")}
          onClick={(e) => setMenu({ ...at(e.currentTarget), entries: openEntries() })}
          testId="ai-open-with"
          trail={<ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />}
        >
          {t("ai.openWith")}
        </ActionButton>
      ) : null}
      <MoreButton
        testId="ai-more"
        className="absolute top-0 right-0"
        onClick={(e) => {
          const a = at(e.currentTarget, true);
          setMenu({ ...a, entries: moreEntries(a) });
        }}
      />
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
      ) : null}
    </div>
  );
}
