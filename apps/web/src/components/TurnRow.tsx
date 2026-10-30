/**
 * 自分の番の行（M2-6。YOUR TURN 帯・要対応キュー・儀式で共有）。
 * 状態アイコン、件名（何の件か）、理由（なぜ待っているか。表示の瞬間に読む中身。D-207）、薄く どこで（repo · branch）、
 * 右端の待ち。不在の間（Mac を使っていない間。D-105）に始まった待ちは長さでなく `since 22:51`（M1）、期限の24時間前から
 * `expires in 18h`。設定「行に中身を出す」がオフなら 2 行目は今までの どこで · 待ち。
 */
import {
  type ClosedTodayRow,
  fmtClock,
  fmtWait,
  isGrace,
  primaryFollowUp,
  type QueueItem,
} from "@turnlane/core/web";
import { ArrowRightToLine, Ban, ChevronRight, Reply, RotateCcw, Timer } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { type ItemActionsApi, useItemActions } from "../actions/item-actions.tsx";
import { answerable, useAnswerEnabled } from "../data/answer.ts";
import { useClosedSubject, useGlance, useSeen, useShowDetail } from "../data/glance.ts";
import { backToTurn } from "../data/mutations.ts";
import { useI18n } from "../i18n/index.tsx";
import { keyHint } from "../keys/keymap.ts";
import { whereName } from "../lib/where.ts";
import { changeText } from "./AwayLine.tsx";
import { EngagedLabel } from "./EngagedLabel.tsx";
import { HoverToolbar } from "./HoverToolbar.tsx";
import { titleText } from "./items.tsx";
import { OPEN_ICON, OpenHoverButton, openIconFor } from "./OpenWith.tsx";
import { StatusIcon } from "./StatusIcon.tsx";
import { turnHover, turnView, WhyContent, whyText } from "./TurnWhy.tsx";
import { Check } from "./ui.tsx";

/** カードの代表のフォローアップ（帯の1行の題名）。core と共有（通知の題名にも使う） */
export { primaryFollowUp };

/**
 * 帯・キューの行の状態（タスクがあるが状態が running などのカードは your_turn として描く）。猶予中の問い（D-245）は
 * 自分の番の →
 */
export function rowStatus(item: QueueItem): "needs_input" | "error" | "your_turn" {
  if (isGrace(item)) return "your_turn";
  return item.status === "needs_input" || item.status === "error" ? item.status : "your_turn";
}

/**
 * 一覧の行の面（自分の番の画面・Inbox で共有）: ふだんは地のまま、ホバーで沈んだ面、ブロック中（許可待ち）だけ琥珀 8% の面（Tier 1）。
 * 選択は無彩色の 1.5px の枠、複数選択は薄い枠
 */
export function rowSurface({
  selected = false,
  checked = false,
  amber = false,
}: {
  selected?: boolean;
  checked?: boolean;
  amber?: boolean;
}): string {
  return `${amber ? "bg-amber" : "hover:bg-sunken"} ${
    selected ? "shadow-[inset_0_0_0_1.5px_var(--dl-accent)]" : ""
  } ${checked ? "shadow-[inset_0_0_0_1.5px_var(--dl-text-3)]" : ""}`;
}

const ROW_BASE = "group relative flex min-w-0 cursor-default items-center gap-2.5 rounded-card";
/** 2行の一覧の行（自分の番の画面・Inbox。題名 / 2行目、右に時間。確定デザインの自分の番） */
export const QUEUE_ROW = `${ROW_BASE} min-h-[52px] px-3 py-2`;
/** 2行の一覧の行の題名・2行目 */
export const QUEUE_ROW_TITLE = "min-w-0 truncate font-medium text-[14px] leading-5";
export const QUEUE_ROW_SUB = "flex min-w-0 items-center gap-1 text-fg2 text-meta";

export function TurnRow({
  item,
  now,
  tz,
  selected = false,
  checked = false,
  showBranch = false,
  stacked = false,
  variant,
  onClick,
  onOpen,
  scheduledAt = null,
  roomy = false,
}: {
  item: QueueItem;
  now: number;
  tz: string;
  selected?: boolean;
  /** 複数選択（x）に入っている */
  checked?: boolean;
  showBranch?: boolean;
  /** 2行（件名 / 理由 · リポジトリ · 待ち）。デイビューの右の一覧（300px。デイビューのレビューの「実装で直すこと」1） */
  stacked?: boolean;
  /**
   * band: 3日ボードの帯（行の幅 560px 以上は 1 行 36px、300〜559px は 2 行 44px、300px 未満は 2 行で待ちを省く）/
   * panel: 2行（デイビューの右の一覧）/ queue: 2行 52px（自分の番の画面。件名 / 理由 · リポジトリ · ブランチ、右に待ち）/
   * compact: メニューバー（2行、余白を詰める）。D-207、spec-glance §3
   */
  variant?: "band" | "panel" | "queue" | "compact";
  onClick?: () => void;
  /** ホバーのアイコンのクリック（⏎ と同じ。既定の開き先。D-059） */
  onOpen?: () => void;
  /** 時間に置いた時刻（`@15:00`。D-051、ux-mvp 7章） */
  scheduledAt?: string | null;
  /** メニューバーで件が 3 件以下: 3 行目に repo · branch を出す（D-214 の §4） */
  roomy?: boolean;
}) {
  const { t, locale } = useI18n();
  const v = variant ?? (stacked ? "panel" : showBranch ? "queue" : "band");
  const fu = primaryFollowUp(item);
  // 猶予中の問い（D-245）: 返答タスクはまだ無い。薄く出し、右は `猶予 · あと 12m`。操作は 答える・開く・詳細 だけ
  const grace = isGrace(item);
  const status = rowStatus(item);
  // 表示の瞬間に中身を読む（D-207）。行が画面に見えてから
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  const show = useShowDetail();
  const glance = useGlance(item, seen);
  const view = turnView(item, glance, locale);
  const parts = view.parts;
  // マウスの操作（UX 監査 A2・A3）: 画面が文脈を配っていれば、クリック・右クリック・ダブルクリック・チェック・ホバーのボタン
  const actions = useItemActions();
  const key = `turn:${item.workItemId}`;
  const click = onClick ?? (actions ? () => actions.click(key) : undefined);
  const mouse = actions
    ? {
        onContextMenu: (e: React.MouseEvent) => actions.menu(e, key),
        onDoubleClick: () => actions.doubleClick(key),
      }
    : {};
  const compactRow = (variant ?? "") === "compact";
  // Turnlane から答える（D-238）: 問い・許可・エラーの待ちに「答える」（設定でオフにできる）
  const canAnswer = useAnswerEnabled() && answerable(item);
  // 左の ○ は出さない（ふだんは状態アイコンだけ）。完了は … と右クリックと Space（D-214 の §4 でホバーのボタンを 3 つに）
  const toolbar =
    actions && (fu || grace) ? (
      <TurnToolbar actions={actions} k={key} tray={compactRow} answer={canAnswer} grace={grace} />
    ) : null;
  // 件名（前置きの「許可:」「返答:」を外す。D-207 (5)）
  const title = view.subject || (fu ? titleText(fu.title, locale) : (item.title ?? ""));
  const dur = item.waitStartedAway
    ? t("turn.since", { time: fmtClock(item.waitingSince, tz) })
    : fmtWait(now - item.waitingSince);
  // 待ちは言葉を添える（`待ち 12m`。不在の間に始まった待ちは `22:51 から`）
  const graceLeft = item.grace ? fmtWait(Math.max(0, item.grace.until - now)) : "";
  const wait = grace
    ? t("turn.grace", { time: graceLeft })
    : item.waitStartedAway
      ? dur
      : t("turn.waitFor", { time: dur });
  const waitLabel = grace ? wait : item.waitStartedAway ? dur : t("turn.waitLabel", { time: dur });
  const exp = fu?.expiresAt ?? null;
  const expSoon = exp !== null && exp - now < 24 * 3_600_000 && exp > now;
  const repo = whereName(item, t("ai.scratch"));
  const link = [repo, v === "queue" ? item.branch : null].filter(Boolean).join(" · ");
  const where = [repo, item.branch].filter(Boolean).join(" · ");
  const blocked = status === "needs_input";
  const why = parts.why ? t(`turn.why.${parts.why}`) : "";
  const content = show && parts.hasContent ? <WhyContent parts={parts} /> : null;
  const hover = [
    turnHover({ ...view, subject: title }, where, waitLabel, t, locale),
    grace ? t("turn.graceHint", { time: graceLeft }) : "",
  ]
    .filter(Boolean)
    .join("\n");
  // 読み上げ（spec-glance §3.6）: 状態、件名、待ちの種類、中身、リポジトリ、待ち
  const aria = [
    t(`status.${status}`),
    title,
    why,
    show ? whyText(parts, t, locale) : "",
    repo,
    waitLabel,
  ]
    .filter(Boolean)
    .join("、");
  // ホバーの間はボタン（開く・答える・対応不要・…）の幅だけ右を空ける。理由の文は縮むが隠れず、待ちの時間はボタンの左に残る
  const reserve =
    toolbar && !compactRow
      ? grace
        ? canAnswer
          ? "hover:pr-[86px]"
          : "hover:pr-[60px]"
        : canAnswer
          ? "hover:pr-[112px]"
          : "hover:pr-[86px]"
      : "";
  // 行の面（rowSurface）。メニューバーは色を状態アイコンだけにするので琥珀の面を付けない
  // 猶予中は文字を薄く（text-fg3 相当。D-245）
  const surface = `${rowSurface({ selected, checked, amber: blocked && !compactRow })}${
    grace ? " text-fg3" : ""
  }`;
  const at = scheduledAt ? (
    <span className="shrink-0 font-mono text-fg2 text-meta" data-kind="turn-at">
      @{scheduledAt}
    </span>
  ) : null;
  const waitEl = (
    <span
      data-kind="turn-wait"
      data-grace={grace ? "" : undefined}
      title={item.waitStartedAway && !grace ? t("turn.sinceAway") : undefined}
      className={`shrink-0 whitespace-nowrap text-meta ${item.waitStartedAway || grace ? "text-fg3" : "text-fg2"}`}
    >
      <WaitText text={wait} />
    </span>
  );
  const icon = grace ? (
    <span className="inline-flex shrink-0 opacity-60">
      <StatusIcon status={status} estimated={item.estimated} size={16} />
    </span>
  ) : (
    <StatusIcon status={status} estimated={item.estimated} size={16} />
  );
  const expEl = expSoon ? (
    <span className="shrink-0 text-fg3">
      · {t("turn.expiresIn", { time: fmtWait((exp ?? now) - now) })}
    </span>
  ) : null;
  // 終わった件（PR の確認待ち・マージ待ち）の変更の量と CI（D-214 (2) の 6）。切られないよう理由の中身より先に置く。
  // 件名が PR の題名なら理由の中身は `PR #8` だけなので、番号を先に `PR #8 · 2 ファイル · +12 −8 · CI 通過`（fix-subject-pr）
  const change = changeText(item.change, t);
  const changeEl = change ? (
    parts.prFirst ? (
      <span className="text-fg2" data-kind="turn-change">
        <span className="text-fg3"> · </span>
        {change}
      </span>
    ) : (
      <span className="text-fg2" data-kind="turn-change">
        {change}
        <span className="text-fg3"> · </span>
      </span>
    )
  ) : null;
  /** 理由の行（待ちの種類の言葉を付けるか）。中身が無ければ言葉だけ（spec-glance §5.3） */
  const reason = (withWord: boolean) =>
    content ? (
      <span className="min-w-0 truncate" data-kind="turn-why">
        {withWord && why ? (
          <>
            {why}
            <span className="text-fg3"> · </span>
          </>
        ) : null}
        {parts.prFirst ? null : changeEl}
        {content}
        {parts.prFirst ? changeEl : null}
      </span>
    ) : (
      <span className="min-w-0 truncate" data-kind="turn-why">
        {why}
        {change ? (
          <span className="text-fg2" data-kind="turn-change">
            <span className="text-fg3"> · </span>
            {change}
          </span>
        ) : null}
      </span>
    );
  if (v !== "band") {
    const two = v === "queue";
    // メニューバーの「対応中 · iTerm2 · タブ 3」（D-214 (4)）は待ちの位置に置き、理由より先に切る（理由は読めるまま。§4）。
    // 3 行の形では 3 行目の repo · branch の後ろ
    const engagedEl =
      compactRow && fu?.engagedAt ? (
        <EngagedLabel
          followUpId={fu.id}
          engagedAt={fu.engagedAt}
          className="min-w-[2.5em] shrink-[20] truncate whitespace-nowrap text-fg3"
        />
      ) : null;
    const waitOrEngaged = engagedEl && !(roomy && show) ? engagedEl : waitEl;
    // 2 行目: 設定がオフなら今の形（どこで · 待ち）。オンなら 理由 ·（薄く）どこで（· 待ち）
    const sub = !show ? (
      <>
        <span className="min-w-0 truncate" data-kind="turn-link">
          {link}
        </span>
        {v === "panel" || v === "compact" ? (
          <>
            {link ? <span aria-hidden="true">·</span> : null}
            {waitOrEngaged}
          </>
        ) : null}
        {expEl}
      </>
    ) : two ? (
      <>
        {reason(true)}
        {link ? (
          <span className="ml-6 min-w-0 shrink-[3] truncate text-fg3" data-kind="turn-link">
            {link}
          </span>
        ) : null}
        {expEl}
      </>
    ) : (
      <>
        {/* メニューバー: 許可待ちだけ種類の言葉を付ける（琥珀の面が無いため。spec-glance §3.5） */}
        {reason(compactRow && parts.why === "approve")}
        {/* 切るのは理由の末尾から。repo は 16 文字まで切らない（D-214 の §4。どのセッションかを決める画面なので）。
            3 行の形では repo · branch を 3 行目に出す */}
        {repo && !roomy ? (
          <span className="shrink-0 whitespace-nowrap text-fg3" data-kind="turn-link">
            <span aria-hidden="true" className="mr-1">
              ·
            </span>
            {cutRepo(repo)}
          </span>
        ) : null}
        <span aria-hidden="true" className="shrink-0">
          ·
        </span>
        {waitOrEngaged}
        {expEl}
      </>
    );
    return (
      // biome-ignore lint/a11y/useSemanticElements: 行の中に開くボタンを置くため div
      <div
        ref={ref}
        role="button"
        tabIndex={-1}
        onClick={click}
        onKeyDown={undefined}
        {...mouse}
        data-kind="turn"
        data-id={item.workItemId}
        data-blocked={blocked ? "" : undefined}
        data-grace={grace ? "" : undefined}
        data-selected={selected ? "" : undefined}
        title={hover}
        aria-label={aria}
        className={`${two ? QUEUE_ROW : `${ROW_BASE} px-2 py-1.5`} ${surface} ${reserve}`}
      >
        {icon}
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            data-kind="turn-title"
            className={
              two
                ? QUEUE_ROW_TITLE
                : `min-w-0 truncate font-medium ${compactRow ? "text-body leading-5" : "text-body"}`
            }
          >
            {title}
          </span>
          <span className={grace ? QUEUE_ROW_SUB.replace("text-fg2", "text-fg3") : QUEUE_ROW_SUB}>
            {sub}
          </span>
          {roomy && show && (where || engagedEl) ? (
            <span className="flex min-w-0 text-fg3 text-meta" data-kind="turn-where">
              <span className="min-w-0 shrink truncate">{where}</span>
              {engagedEl && where ? (
                <span aria-hidden="true" className="mx-1 shrink-0">
                  ·
                </span>
              ) : null}
              {engagedEl}
            </span>
          ) : null}
        </div>
        {fu?.engagedAt && !compactRow ? (
          <EngagedLabel
            followUpId={fu.id}
            engagedAt={fu.engagedAt}
            className="max-w-[40%] shrink-0 truncate text-fg3 text-meta"
          />
        ) : null}
        {at}
        {two ? waitEl : null}
        {compactRow && fu ? (
          // メニューバー: 右に開く先のアプリ（ターミナル / GitHub / エディタ）。ホバーでボタンに替わる
          <AppIcon kind={fu.kind} />
        ) : null}
        {onOpen && fu && !toolbar && !compactRow ? (
          <OpenHoverButton kind={fu.kind} onOpen={onOpen} />
        ) : null}
        {toolbar}
      </div>
    );
  }
  // 帯（spec-glance §3.1〜3.3）: 行の幅 560px 以上は 1 行（件名 ｜ 理由 ｜ 待ち）、300〜559px は 2 行（件名 · 待ち /
  // 理由 · リポジトリ）、300px 未満は 2 行で待ちを省く（ツール名も省く）。設定がオフなら今の 1 行（件名 リポジトリ 待ち）
  const NARROW_HIDE = "@max-[299px]/turn:hidden";
  const WIDE_ONLY = "hidden @min-[560px]/turn:flex";
  const TWO_ONLY = "@min-[560px]/turn:hidden";
  return (
    <div className="@container/turn min-w-0">
      {/* biome-ignore lint/a11y/useSemanticElements: 行の中に完了のボタンを置くため div */}
      <div
        ref={ref}
        role="button"
        tabIndex={-1}
        onClick={click}
        onKeyDown={undefined}
        {...mouse}
        data-kind="turn"
        data-id={item.workItemId}
        data-blocked={blocked ? "" : undefined}
        data-grace={grace ? "" : undefined}
        data-selected={selected ? "" : undefined}
        title={hover}
        aria-label={aria}
        className={`group relative flex min-w-0 cursor-default items-center gap-2 rounded-card px-2 ${
          show ? "min-h-9 py-1 @max-[559px]/turn:min-h-11" : "h-9"
        } ${surface} ${reserve}`}
      >
        {icon}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <span
              data-kind="turn-title"
              className={`min-w-0 truncate font-medium text-body ${
                show
                  ? "shrink @min-[560px]/turn:max-w-[55%] @min-[560px]/turn:min-w-[40%]"
                  : "shrink"
              }`}
            >
              {title}
            </span>
            {show ? (
              <span
                className={`${WIDE_ONLY} min-w-0 flex-1 pl-2 text-meta ${grace ? "text-fg3" : "text-fg2"}`}
                data-kind="turn-why-inline"
              >
                {reason(false)}
              </span>
            ) : link ? (
              <span
                data-kind="turn-link"
                className={`min-w-0 shrink-[2] truncate text-fg2 text-meta ${NARROW_HIDE}`}
              >
                {link}
              </span>
            ) : null}
            {/* 1 行の形では理由が残りの幅を取る（空きの詰め物は 2 行の形とオフのときだけ） */}
            <span className={show ? "flex-1 @min-[560px]/turn:hidden" : "flex-1"} />
            {fu?.engagedAt ? (
              <EngagedLabel
                followUpId={fu.id}
                engagedAt={fu.engagedAt}
                className={`shrink-0 text-fg3 text-meta ${NARROW_HIDE}`}
              />
            ) : null}
            {at}
            <span className={NARROW_HIDE}>{waitEl}</span>
            {expSoon ? (
              <span className={`shrink-0 text-fg3 text-meta ${NARROW_HIDE}`}>
                {t("turn.expiresIn", { time: fmtWait((exp ?? now) - now) })}
              </span>
            ) : null}
          </div>
          {show ? (
            <div
              className={`${TWO_ONLY} flex min-w-0 items-center text-meta ${grace ? "text-fg3" : "text-fg2"}`}
            >
              <span className={`flex min-w-0 items-center ${NARROW_HIDE}`}>
                {reason(false)}
                {repo ? (
                  <span className="min-w-[40px] shrink-[3] truncate text-fg3" data-kind="turn-link">
                    <span aria-hidden="true" className="mx-1">
                      ·
                    </span>
                    {repo}
                  </span>
                ) : null}
              </span>
              <span className="hidden min-w-0 truncate @max-[299px]/turn:inline">
                {parts.hasContent ? <WhyContent parts={parts} mode="narrow" /> : why}
              </span>
            </div>
          ) : null}
        </div>
        {onOpen && fu && !toolbar ? <OpenHoverButton kind={fu.kind} onOpen={onOpen} /> : null}
        {toolbar}
      </div>
    </div>
  );
}

/** メニューバーの repo は 16 文字までは切らない（それより長ければ末尾を切る） */
const cutRepo = (r: string) => (r.length > 16 ? `${r.slice(0, 15)}…` : r);

/** 待ちの文（`待ち 12m`）: 時刻・長さだけを mono にする（確定デザイン: mono は時刻・長さ・キーだけ） */
export function WaitText({ text }: { text: string }) {
  const parts = text.split(/(\d[\dhm:<]*)/);
  return (
    <>
      {parts.map((p, i) =>
        /^\d/.test(p) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 文の切れ目の順は変わらない
          <span key={i} className="font-mono">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}

function AppIcon({ kind }: { kind: Parameters<typeof openIconFor>[0] }) {
  const Icon = openIconFor(kind);
  return (
    <span className="shrink-0 text-fg3 group-hover:invisible" aria-hidden="true">
      <Icon size={16} strokeWidth={1.5} />
    </span>
  );
}

/**
 * 自分の番の行のホバーのボタン（D-214 の §4）: 開く・対応不要・…（完了・明日へ・スヌーズは … と右クリック、キーは今のまま）。
 * 理由の文を隠さないよう 3 つに減らし、行はホバーの間ボタンの幅だけ右を空ける（待ちの時間はボタンの左に残る）。
 * メニューバー（tray）は行のクリックが開くなので、明日へ・スヌーズ・対応不要の3つ（確定デザインのメニューバー）
 */
function TurnToolbar({
  actions,
  k,
  tray = false,
  answer = false,
  grace = false,
}: {
  actions: ItemActionsApi;
  k: string;
  tray?: boolean;
  /** 「答える」を出す（D-238。問い・許可・エラーの待ちで、設定がオン） */
  answer?: boolean;
  /** 猶予中（D-245）: 返答タスクが無いので 開く・答える（と …）だけ。メニューバーは 答える だけ */
  grace?: boolean;
}) {
  const { t } = useI18n();
  const run = (id: string) => () => actions.run(k, id);
  const answerBtn = answer
    ? [
        {
          id: "answer",
          icon: Reply,
          label: t("answer.action"),
          keyId: "answer",
          onClick: run("answer"),
        },
      ]
    : [];
  const dismiss = {
    id: "dismiss",
    icon: Ban,
    label: t("menu.dismiss"),
    keyId: "dismiss",
    onClick: run("dismiss"),
  };
  if (!tray)
    return (
      <HoverToolbar
        tipSide="bottom"
        onMore={(e) => actions.menu(e, k)}
        buttons={[
          {
            id: "open",
            icon: OPEN_ICON,
            label: t("menu.openTurn"),
            keyId: "open",
            onClick: run("open"),
          },
          ...answerBtn,
          ...(grace ? [] : [dismiss]),
        ]}
      />
    );
  if (grace) return answerBtn.length > 0 ? <HoverToolbar buttons={answerBtn} /> : null;
  return (
    <HoverToolbar
      buttons={[
        ...answerBtn,
        {
          id: "move",
          icon: ArrowRightToLine,
          label: t("menu.tomorrow"),
          keyId: "move",
          onClick: run("move"),
        },
        {
          id: "snooze",
          icon: Timer,
          label: t("menu.snooze"),
          keyId: "snooze",
          onClick: run("snooze"),
        },
        dismiss,
      ]}
    />
  );
}

/**
 * 閉じた行の右の言葉（D-214 の §4 の統一）: 何で閉じたか（許可 / 返答 / 回答 / レビュー / マージ / 再開 / 完了）と時刻、
 * 解決（推定）/ 対応不要 / 期限切れ
 */
type Translate = ReturnType<typeof useI18n>["t"];

export function closedLabel(
  row: Pick<ClosedTodayRow, "kind" | "via" | "closedAt">,
  t: Translate,
  tz?: string,
): string {
  if (row.kind !== "replied") return t(`day.closed.${row.kind}`);
  const w = row.via ? t(`turn.closedVia.${row.via}`) : t("day.closed.replied");
  return tz ? `${w} ${fmtClock(row.closedAt, tz)}` : w;
}

/** 閉じた行の件名の既定（作ったときの件名。「返答:」などの前置きは右の言葉で分かるので付けない） */
export function closedFallback(row: Pick<ClosedTodayRow, "title">, locale: "en" | "ja"): string {
  return row.title.t === "auto" && row.title.params.title
    ? row.title.params.title
    : titleText(row.title, locale);
}

/**
 * 閉じた行: 状態アイコンの位置に塗った ✓（解決（推定）は破線のチェック）、薄い件名（行と同じ glance の件名。D-214 (1)）、
 * 右に何で閉じたかと時刻（取り消し線は付けない。T4。D-139 (4)）
 */
export function ClosedTurnRow({ row, tz }: { row: ClosedTodayRow; tz?: string }) {
  const { t, locale } = useI18n();
  const actions = useItemActions();
  const ref = useRef<HTMLDivElement>(null);
  const subject = useClosedSubject(row, ref, closedFallback(row, locale));
  const resolved = row.kind === "resolved";
  // 自分の番に戻す（Issue #3）: ホバーのボタンと右クリック。手で閉じるか新しい記録が来るまで自分の番に残る
  const back = () => void backToTurn(row.workItemId, row.followUpId);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 右クリックのメニュー（同じ操作はホバーのボタンにもある）
    <div
      ref={ref}
      className="group relative flex h-8 min-w-0 items-center gap-2 rounded-card px-2 text-fg3 hover:bg-sunken"
      data-kind="turn-closed"
      data-closed={row.kind}
      onContextMenu={(e) => {
        if (!actions) return;
        e.preventDefault();
        actions.openMenu(e.clientX, e.clientY, [
          {
            id: "backToTurn",
            label: t("menu.backToTurn"),
            icon: RotateCcw,
            keys: keyHint("backToTurn"),
            run: back,
          },
        ]);
      }}
    >
      <Check checked dashed={resolved} label={t("action.complete")} />
      <span className="min-w-0 flex-1 truncate text-body">{subject}</span>
      <span className="shrink-0 truncate text-meta">{whereName(row, t("ai.scratch"))}</span>
      <span className="shrink-0 font-mono text-meta">{closedLabel(row, t, tz)}</span>
      <HoverToolbar
        buttons={[
          {
            id: "backToTurn",
            icon: RotateCcw,
            label: t("menu.backToTurn"),
            keyId: "backToTurn",
            onClick: back,
          },
        ]}
      />
    </div>
  );
}

const FOLD_KEY = "turnlane.closedOpen";

function readFold(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * 今日閉じたものの畳み（D-074）: `✓ N closed ▸` の1行。押したときだけ中身（閉じた行の一覧）を開く。
 * 開閉はブラウザに覚える（YOUR TURN 帯とデイビューの左パネルで共有）
 */
export function ClosedFold({ count, children }: { count: number; children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(readFold);
  if (count === 0) return null;
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(FOLD_KEY, open ? "0" : "1");
    } catch {
      // 保存できなくても開閉はできる
    }
  };
  return (
    <div className="flex flex-col" data-testid="closed-fold">
      <button
        type="button"
        tabIndex={-1}
        onClick={toggle}
        aria-expanded={open}
        className="flex h-7 items-center gap-1.5 self-start rounded-control px-1 text-fg2 text-meta hover:text-fg"
      >
        <ChevronRight
          size={14}
          strokeWidth={1.5}
          aria-hidden="true"
          className={open ? "rotate-90" : ""}
        />
        <span>{t("board.closedFold", { count })}</span>
      </button>
      {open ? children : null}
    </div>
  );
}
