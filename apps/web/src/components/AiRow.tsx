/**
 * AI の画面の 1 行（ux-mvp 4.19）: 状態アイコン、件名、リポジトリ · ブランチ（同じ項目に生きたセッションが 2 つ以上なら
 * `· 2 セッション`）、札（状態の言葉。色は付けない）、`サブ 2`、PR、ソースバッジ、右端の時間（節ごとに意味が違う）。
 * 自分の番・後での行は自分の番の画面と同じ関数（turnView・laterLabel）で件名と札を作る（待ちの中身は出さない。ホバーと
 * 詳細パネルで読む）。行は 1 行のまま、幅が足りないときは件名から縮め、右から ソースバッジ → PR → サブ → ブランチ の
 * 順に省く（省いたものは title に）。右端の時間は縮めず、ほかの要素と重ならない
 */
import {
  aiItemSubject,
  cleanupKind,
  fmtClock,
  fmtWait,
  isGrace,
  type LiveItem,
  laterFollowUp,
  laterKind,
  primaryFollowUp,
  prLabel,
  type QueueItem,
  runningKind,
  stoppedKind,
  type WorkItemStatus,
} from "@turnlane/core/web";
import { Ban, BrushCleaning, Reply, Undo2 } from "lucide-react";
import { useRef } from "react";
import { useItemActions } from "../actions/item-actions.tsx";
import { answerable, useAnswerEnabled } from "../data/answer.ts";
import { useGlance, useItemGlance, useSeen } from "../data/glance.ts";
import { type MessageKey, useI18n } from "../i18n/index.tsx";
import { whereName } from "../lib/where.ts";
import { HoverToolbar, type ToolbarButton } from "./HoverToolbar.tsx";
import { titleText } from "./items.tsx";
import { laterLabel, laterViewItem, limitText } from "./LaterRow.tsx";
import { OPEN_ICON } from "./OpenWith.tsx";
import { StatusIcon } from "./StatusIcon.tsx";
import { rowStatus, rowSurface } from "./TurnRow.tsx";
import { turnView } from "./TurnWhy.tsx";
import { SourceBadges } from "./ui.tsx";

export type AiSection = "turn" | "later" | "running" | "stopped" | "cleanup" | "stale";
/** 下の節（生きている AI 項目の行） */
export type LiveSection = "running" | "stopped" | "cleanup" | "stale";

/**
 * 画面の 1 行（上の 2 節は自分の番の行、下の節は生きている AI 項目。stale は末尾の畳んだ「プロセスが残っている」の中の
 * 行で、札と時間は止まっていると同じ）
 */
export type AiRowData =
  | { section: "turn" | "later"; id: string; key: string; item: QueueItem }
  | { section: LiveSection; id: string; key: string; live: LiveItem };

type Translate = ReturnType<typeof useI18n>["t"];

/** 下の節の行の AI 項目（上の 2 節は null） */
export function liveOf(r: AiRowData): LiveItem | null {
  return "live" in r ? r.live : null;
}

/** 上の 2 節の行の自分の番（下の節は null） */
export function queueOf(r: AiRowData): QueueItem | null {
  return "item" in r ? r.item : null;
}

/**
 * 下の節の札（状態の言葉。stale は止まっていると同じ）。利用上限で止まった項目（done · rate_limit）は「完了」にせず、
 * 明ける時刻があれば `利用上限 · 03:00 まで`（見込みなら `利用上限 · 見込み 03:00`）、無ければ `利用上限`
 */
export function liveLabel(section: LiveSection, x: LiveItem, t: Translate, tz?: string) {
  if (section !== "running" && section !== "cleanup" && stoppedKind(x) === "limit")
    return x.limitWait && tz ? limitText(x.limitWait, tz, t) : t("ai.live.label.limit");
  const k =
    section === "running"
      ? runningKind(x)
      : section === "stopped" || section === "stale"
        ? stoppedKind(x)
        : cleanupKind(x);
  return t(`ai.live.label.${k}` as MessageKey);
}

/**
 * 下の節の右端の時間: 動いている = 今の作業が始まってから、止まっている・プロセスが残っている = 止まってから、
 * 片付け = 終わってから
 */
export function liveTime(section: LiveSection, x: LiveItem, now: number) {
  const from = section === "running" ? (x.runStartedAt ?? x.lastActivityAt) : x.lastActivityAt;
  return fmtWait(Math.max(0, now - from));
}

/** 自分の番の行の右端（待ち。不在の間に始まった待ちは `22:51 から`、猶予中の問いは `猶予 · あと 12m`） */
export function turnTime(item: QueueItem, now: number, tz: string, t: Translate): string {
  if (isGrace(item) && item.grace)
    return t("turn.grace", { time: fmtWait(Math.max(0, item.grace.until - now)) });
  return item.waitStartedAway
    ? t("turn.since", { time: fmtClock(item.waitingSince, tz) })
    : fmtWait(Math.max(0, now - item.waitingSince));
}

/** 行の操作の宛先のフォローアップ（自分の番は代表、後ではスヌーズ中のもの） */
export function rowFollowUp(r: AiRowData) {
  if (r.section === "turn") return primaryFollowUp(r.item);
  if (r.section === "later") return laterFollowUp(r.item);
  return undefined;
}

export function AiRow({
  row,
  now,
  tz,
  today,
  selected = false,
}: {
  row: AiRowData;
  now: number;
  tz: string;
  today: string;
  selected?: boolean;
}) {
  const { t, locale } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  const queueItem = queueOf(row);
  // 件名は自分の番の画面と同じ（その日の最初の指示を表示の瞬間に読む）。下の節はサーバーの件名
  const view0 = queueItem ? (row.section === "later" ? laterViewItem(queueItem) : queueItem) : null;
  const glance = useGlance(view0, seen);
  const view = view0 ? turnView(view0, glance, locale) : null;
  // 下の節の件名はボードの AI の線と同じ（直近の指示を表示の瞬間に読む）
  const liveRow = liveOf(row);
  const itemGlance = useItemGlance(
    liveRow?.id,
    `${liveRow?.status ?? ""}|${liveRow?.lastActivityAt ?? 0}`,
    seen && liveRow !== null && liveRow.titleSource !== "user",
  );
  const answerOn = useAnswerEnabled();
  const actions = useItemActions();
  const x = queueItem ?? liveRow;
  if (!x) return null;
  const fu = rowFollowUp(row);
  let title: string;
  let label: string;
  let time: string;
  let status: WorkItemStatus;
  let estimated: boolean;
  let dim = false;
  let quiet = false;
  let subs = 0;
  let sessions = 0;
  let sources: LiveItem["sources"];
  let prRef: string | null;
  let canAnswer = false;
  let lastActivity: number | null = null;
  if (row.section === "turn" || row.section === "later") {
    const it = row.item;
    title = view?.subject || (fu ? titleText(fu.title, locale) : (it.title ?? ""));
    sources = it.sources;
    prRef = it.prRef;
    estimated = it.estimated;
    if (row.section === "turn") {
      const why = view?.parts.why ? t(`turn.why.${view.parts.why}` as MessageKey) : "";
      label = why;
      time = turnTime(it, now, tz, t);
      status = rowStatus(it);
      dim = isGrace(it);
      canAnswer = answerOn && answerable(it);
    } else {
      label = laterLabel(it, today, now, tz, t);
      time = "";
      const kind = laterKind(it, today);
      status =
        kind === "limit"
          ? "done"
          : it.status === "needs_input" || it.status === "error"
            ? it.status
            : "your_turn";
      dim = true;
    }
  } else {
    const l = liveRow as LiveItem;
    title = aiItemSubject(l, itemGlance) ?? whereName(l, t("ai.scratch")) ?? "";
    label = liveLabel(row.section, l, t, tz);
    time = liveTime(row.section, l, now);
    status = l.status;
    estimated = l.estimated || l.process === "unknown";
    quiet = row.section !== "running";
    subs = l.subagentsRunning;
    sessions = l.liveSessions;
    sources = l.sources;
    prRef = l.prRef;
    canAnswer = answerOn && answerable(l);
    lastActivity = l.lastActivityAt;
  }
  const repo = whereName(x as { repoRoot: string | null; scratch?: boolean }, t("ai.scratch"));
  const branch = (x as { branch: string | null }).branch;
  const sessionsText = sessions >= 2 ? t("ai.live.sessions", { count: sessions }) : "";
  const pr = prLabel(prRef);
  const estimatedHint = liveRow?.process === "unknown" ? t("ai.live.estimatedHint") : "";
  const hover = [
    title,
    label,
    [repo, branch, sessionsText].filter(Boolean).join(" · "),
    subs > 0 ? t("ai.live.subHint", { count: subs }) : "",
    lastActivity !== null ? t("ai.live.lastActivity", { time: fmtClock(lastActivity, tz) }) : "",
    estimatedHint,
  ]
    .filter(Boolean)
    .join("\n");
  const buttons: ToolbarButton[] = [];
  const run = (id: string) => () => actions?.run(row.key, id);
  if (row.section === "later" && fu)
    buttons.push({ id: "wake", icon: Undo2, label: t("queue.later.wake"), onClick: run("wake") });
  if (row.section === "cleanup")
    buttons.push({
      id: "cleanup",
      icon: BrushCleaning,
      label: t("ai.live.cleanupAction"),
      keyId: "complete",
      onClick: run("complete"),
    });
  buttons.push({
    id: "open",
    icon: OPEN_ICON,
    label: t(row.section === "turn" || row.section === "later" ? "menu.openTurn" : "menu.openAi"),
    keyId: "open",
    onClick: run("open"),
  });
  if (canAnswer)
    buttons.push({
      id: "answer",
      icon: Reply,
      label: t("menu.answer"),
      keyId: "answer",
      onClick: run("answer"),
    });
  if ((row.section === "turn" && fu) || row.section === "later")
    buttons.push({
      id: "dismiss",
      icon: Ban,
      label: t("menu.dismiss"),
      keyId: "dismiss",
      onClick: run("dismiss"),
    });
  // 狭い画面（AI の画面の幅 480px 未満）では「開く」と「…」だけ出す（件名の幅を残す。ほかは「…」・右クリック・キーで）
  for (const b of buttons) if (b.id !== "open") b.display = "hidden @min-[480px]:inline-flex";
  const toolbar = actions ? (
    <HoverToolbar tipSide="bottom" onMore={(e) => actions.menu(e, row.key)} buttons={buttons} />
  ) : null;
  // ボタンが出ている間（ホバー・選んでいる行）はボタンの幅だけ右を空ける（時間は残し、件名から縮める）
  // （狭い画面ではボタンが「開く」と「…」の 2 つなので、その幅だけ）
  const reserve = (
    selected
      ? [
          "pr-[60px]",
          "pr-[86px]",
          "pr-[86px] @min-[480px]:pr-[112px]",
          "pr-[86px] @min-[480px]:pr-[138px]",
        ]
      : [
          "hover:pr-[60px]",
          "hover:pr-[86px]",
          "hover:pr-[86px] @min-[480px]:hover:pr-[112px]",
          "hover:pr-[86px] @min-[480px]:hover:pr-[138px]",
        ]
  )[Math.min(3, buttons.length)];
  const tone = dim ? "text-fg3" : quiet ? "text-fg2" : "text-fg";
  return (
    // biome-ignore lint/a11y/useSemanticElements: 行の中にボタンを置くため div
    <div
      ref={ref}
      role="button"
      tabIndex={-1}
      onClick={actions ? () => actions.click(row.key) : undefined}
      onKeyDown={undefined}
      onContextMenu={actions ? (e) => actions.menu(e, row.key) : undefined}
      onDoubleClick={actions ? () => actions.doubleClick(row.key) : undefined}
      data-kind="ai-row"
      data-section={row.section}
      data-id={row.id}
      data-selected={selected ? "" : undefined}
      title={hover}
      aria-label={[t(`status.${status}`), title, label, repo, time].filter(Boolean).join("、")}
      className={`group relative flex h-8 min-w-0 cursor-default items-center gap-3 rounded-card px-3 ${rowSurface({ selected, amber: status === "needs_input" && row.section === "turn" })} ${tone} ${reserve}`}
    >
      <span className={`inline-flex shrink-0 ${dim ? "opacity-60" : ""}`}>
        <StatusIcon status={status} estimated={estimated} size={16} />
      </span>
      {/*
        1 行のまま、幅が足りないときは件名から縮める（件名は残りの幅だけを使い、行の 20%（最低 6em）まで縮む。その先は
        リポジトリ · ブランチ → 札 → サブ・PR・ソースバッジ の順に縮む。shrink の大きい順）。右端の時間だけは縮めない。
        場所（560px 未満）・サブ・PR・ソースバッジは幅が狭ければ出さない（行のホバーに全部）。
        どれも min-w-0 で 0 まで縮められるので、右端の時間に重ならない
      */}
      <span
        data-kind="ai-title"
        className="min-w-[6em] flex-1 truncate font-medium text-[13px] leading-5 @min-[480px]:min-w-[max(6em,20%)]"
      >
        {title}
      </span>
      <span
        data-kind="ai-where"
        className="hidden min-w-0 max-w-[28%] shrink-[4] truncate whitespace-nowrap font-mono text-fg2 text-meta @min-[560px]:block"
      >
        {repo}
        {branch ? <span className="hidden @min-[560px]:inline"> · {branch}</span> : null}
        {sessionsText ? <span> · {sessionsText}</span> : null}
      </span>
      <span
        data-kind="ai-label"
        className="min-w-0 shrink-[2] truncate whitespace-nowrap text-fg2 text-meta"
      >
        {label}
      </span>
      {subs > 0 ? (
        <span
          data-kind="ai-sub"
          className="hidden min-w-0 shrink overflow-hidden whitespace-nowrap font-mono text-fg2 text-meta @min-[640px]:inline"
          title={t("ai.live.subHint", { count: subs })}
        >
          {t("ai.live.sub", { count: subs })}
        </span>
      ) : null}
      {pr ? (
        <span
          data-kind="ai-pr"
          className="hidden min-w-0 shrink overflow-hidden whitespace-nowrap font-mono text-fg3 text-meta @min-[680px]:inline"
        >
          PR {pr}
        </span>
      ) : null}
      {sources.length > 0 ? (
        <span
          data-kind="ai-sources"
          className="hidden min-w-0 shrink overflow-hidden @min-[900px]:inline-flex"
        >
          <SourceBadges sources={sources} />
        </span>
      ) : null}
      <span
        data-kind="ai-time"
        className="ml-auto min-w-14 shrink-0 whitespace-nowrap text-right font-mono text-fg2 text-meta tabular-nums"
      >
        {time}
      </span>
      {toolbar}
    </div>
  );
}
