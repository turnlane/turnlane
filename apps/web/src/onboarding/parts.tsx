/**
 * オンボーディングの共通の部品（確定デザイン onb-P-parts と docs/design/README.md の調整点）:
 * 段の表示、同じ幅の対のボタン（文言が変わっても幅を変えない）、足のキーの帯、保存するものの欄とポップオーバー、
 * 起動しない（B2）の塊。枠（OnboardingLayout）は儀式と同じくサイドバーなしで、下の帯（ボタン）を固定する
 */
import type { OnboardingView } from "@turnlane/core/web";
import {
  ArrowLeft,
  Check as CheckIcon,
  ChevronRight,
  LoaderCircle,
  Minus,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Kbd, Popover } from "../components/ui.tsx";
import type { MessageKey } from "../i18n/en.ts";
import { useI18n } from "../i18n/index.tsx";
import { isImeKey } from "../lib/ime.ts";
import { type Act, STEP_LABEL, type StartMark, stepMarks, stepPosition } from "./steps.ts";

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <LoaderCircle size={size} strokeWidth={1.5} className="dl-spin shrink-0" aria-hidden="true" />
  );
}

/** 上部の段の表示（O2 以降）。済み = 灰のチェック、飛ばした = ダッシュ、今 = 下線 */
export function StepBar({
  view,
}: {
  view: Pick<OnboardingView, "step" | "steps" | "consentedAt">;
}) {
  const { t } = useI18n();
  const pos = stepPosition(view.step);
  return (
    <header
      className="relative flex h-14 shrink-0 items-stretch justify-center border-line border-b px-6"
      data-tauri-drag-region
    >
      <ol
        className="flex items-stretch gap-4 min-[1100px]:gap-[22px]"
        aria-label={t("onb.stepsLabel")}
      >
        {stepMarks(view).map(({ step, mark }) => (
          <li
            key={step}
            data-step={step}
            data-mark={mark}
            aria-current={mark === "current" ? "step" : undefined}
            className={`-mb-px flex items-center gap-1 whitespace-nowrap border-b-2 text-body ${
              mark === "current"
                ? "border-accent font-medium text-fg"
                : mark === "done"
                  ? "border-transparent text-fg2"
                  : "border-transparent text-fg3"
            }`}
          >
            {mark === "done" ? <CheckIcon size={12} strokeWidth={1.75} aria-hidden="true" /> : null}
            {mark === "skipped" ? <Minus size={12} strokeWidth={1.75} aria-hidden="true" /> : null}
            {t(STEP_LABEL[step])}
          </li>
        ))}
      </ol>
      <span className="absolute top-0 right-5 flex h-full items-center font-mono text-fg3 text-meta">
        {pos.n} / {pos.total}
      </span>
    </header>
  );
}

/**
 * 文言が変わっても幅を変えない中身（候補の文言を同じ場所に重ねて、最も長いものの幅を取る。review §5 の 6）
 */
export function StableLabel({ labels, active }: { labels: ReactNode[]; active: number }) {
  return (
    <span className="grid">
      {labels.map((l, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: 候補の文言の並びは固定
          key={i}
          aria-hidden={i !== active}
          className={`col-start-1 row-start-1 flex items-center justify-center gap-1.5 ${i === active ? "" : "invisible"}`}
        >
          {l}
        </span>
      ))}
    </span>
  );
}

export interface PairButton {
  /** 候補の文言（幅は最長のもの。active で今の文言を選ぶ） */
  labels: ReactNode[];
  active?: number;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}

/**
 * 右寄せの対のボタン: 枠の「今はしない」系と、主ボタン（インクの塗り）。2つは同じ幅（最長の文言に合わせる）。
 * secondary が無ければ主ボタンだけ（O6・O8）
 */
export function ButtonPair({
  secondary,
  primary,
}: {
  secondary?: PairButton | undefined;
  primary: PairButton;
}) {
  const all = [...(secondary?.labels ?? []), ...primary.labels];
  const base =
    "col-start-1 row-start-1 inline-flex h-8 items-center justify-center whitespace-nowrap rounded-card px-4 text-body font-medium transition-colors focus-visible:outline focus-visible:outline-[1.5px] focus-visible:outline-accent focus-visible:outline-offset-2";
  // 2つの幅をそろえる: 両方に全部の候補を重ね、見えるのは自分の文言だけ
  const sizer = (mine: ReactNode[], active: number, offset: number) => (
    <StableLabel labels={all} active={offset + Math.min(active, mine.length - 1)} />
  );
  return (
    <div className="flex items-center justify-end gap-2">
      {secondary ? (
        <button
          type="button"
          data-testid={secondary.testId}
          disabled={secondary.disabled}
          onClick={secondary.onClick}
          className={`${base} border border-line bg-raised text-fg hover:border-fg3 disabled:text-fg3 disabled:hover:border-line`}
        >
          {sizer(secondary.labels, secondary.active ?? 0, 0)}
        </button>
      ) : null}
      <button
        type="button"
        data-testid={primary.testId}
        disabled={primary.disabled}
        onClick={primary.onClick}
        className={`${base} border border-accent bg-accent text-onaccent hover:opacity-90 active:opacity-80 disabled:opacity-45 disabled:hover:opacity-45`}
      >
        {sizer(primary.labels, primary.active ?? 0, secondary?.labels.length ?? 0)}
      </button>
    </div>
  );
}

/** 主ボタンの文言（⏎ を添える） */
export function withEnter(label: string): ReactNode {
  return (
    <>
      {label}
      <span className="font-mono text-micro opacity-70" aria-hidden="true">
        ⏎
      </span>
    </>
  );
}

export interface FootKey {
  key: string;
  label: string;
}

/** 足のキーの帯（その画面で効くキーだけ） */
export function FootKeys({ keys }: { keys: FootKey[] }) {
  return (
    <footer className="flex h-10 shrink-0 items-center justify-center gap-5 text-fg3 text-meta">
      {keys.map((k) => (
        <span key={k.key} className="flex items-center gap-1.5">
          <Kbd>{k.key}</Kbd>
          {k.label}
        </span>
      ))}
    </footer>
  );
}

/** ⏎・Esc・⌘[ の処理（入力欄の中と変換中は受けない。⌘[ は入力欄の中でも受ける） */
export function useOnbKeys(h: { enter?: () => void; escape?: () => void; back?: () => void }) {
  const ref = useRef(h);
  ref.current = h;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isImeKey(e) || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      const editing =
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "[" && e.metaKey && ref.current.back) {
        e.preventDefault();
        ref.current.back();
        return;
      }
      if (editing || e.metaKey || e.ctrlKey || e.altKey) return;
      // ボタンにフォーカスがあるときの ⏎ はそのボタン（ブラウザの既定）
      // （チェックボックスの ⏎ は主ボタン。押したばかりの行の印を変えない）
      const ownButton = el?.tagName === "BUTTON" && el.getAttribute("role") !== "checkbox";
      if (e.key === "Enter" && !ownButton && ref.current.enter) {
        e.preventDefault();
        ref.current.enter();
      } else if (e.key === "Escape" && ref.current.escape) {
        e.preventDefault();
        ref.current.escape();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * 画面の枠: 上に段の表示、中は縦にスクロール、下の帯（ボタンの上の1文・戻る・対のボタン）は固定、最下段に足のキー。
 * wide は O3（窓の幅いっぱい）
 */
export function OnboardingLayout({
  view,
  wide = false,
  note,
  lead,
  back,
  buttons,
  foot,
  keys,
  children,
}: {
  view: Pick<OnboardingView, "step" | "steps" | "consentedAt">;
  /** ⏎・Esc・⌘[（⌘[ は back があるときだけ） */
  keys: { enter?: () => void; escape?: () => void };
  wide?: boolean;
  note?: ReactNode;
  /** 下の帯の左上（O3 の取り込み元の行） */
  lead?: ReactNode;
  back?: (() => void) | null;
  buttons: ReactNode;
  foot: FootKey[];
  children: ReactNode;
}) {
  const { t } = useI18n();
  useOnbKeys({ ...keys, ...(back ? { back } : {}) });
  // 中がスクロールするとき（最小の窓）だけ、下の帯の上に細い線を引く（確定画像 O2-D）
  const mainRef = useRef<HTMLElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const el = mainRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const check = () => setOverflow(el.scrollHeight > el.clientHeight + 1);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    check();
    return () => ro.disconnect();
  }, []);
  const col = wide ? "px-8" : "mx-auto w-full max-w-[792px] px-4";
  return (
    <div className="flex h-full flex-col bg-bg text-fg" data-kind="onboarding">
      <StepBar view={view} />
      <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto" data-scroll="onboarding">
        <div className={`${col} pt-8 pb-6 ${wide ? "flex h-full flex-col" : ""}`}>{children}</div>
      </main>
      <div
        className={`shrink-0 border-t ${overflow ? "border-line" : "border-transparent"}`}
        data-bar="onboarding"
      >
        <div className={`${col} flex flex-col gap-2 pt-3 pb-2`}>
          {lead ? <div className="pb-2">{lead}</div> : null}
          {note ? (
            <div className="text-right text-fg3 text-meta" data-part="note">
              {note}
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-4">
            {back ? (
              <button
                type="button"
                onClick={back}
                data-testid="onb-back"
                className="flex items-center gap-1 text-body text-fg2 hover:text-fg"
              >
                <ArrowLeft size={14} strokeWidth={1.5} aria-hidden="true" />
                {t("onb.back")}
              </button>
            ) : (
              <span />
            )}
            {buttons}
          </div>
        </div>
        <FootKeys keys={foot} />
      </div>
    </div>
  );
}

const KEPT: MessageKey[] = [
  "onb.kept.titles",
  "onb.kept.repos",
  "onb.kept.times",
  "onb.kept.prs",
  "onb.kept.counts",
];
const NEVER: MessageKey[] = [
  "onb.never.text",
  "onb.never.prompts",
  "onb.never.code",
  "onb.never.files",
];

function FieldLists({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const list = (head: MessageKey, items: MessageKey[]) => (
    <div className="min-w-0">
      <div className="mb-1.5 font-medium text-fg2 text-meta">{t(head)}</div>
      <ul className={`list-disc pl-4 text-fg ${compact ? "text-meta" : "text-body"} leading-6`}>
        {items.map((k) => (
          <li key={k}>{t(k)}</li>
        ))}
      </ul>
    </div>
  );
  return (
    <div className="grid grid-cols-2 gap-6">
      {list("onb.kept", KEPT)}
      {list("onb.neverKept", NEVER)}
    </div>
  );
}

/** 保存するもの / 保存も送信もしないもの（2列。アイコンなし）と、その下の1行・ポップオーバー */
export function PrivacyPanel() {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <div data-part="privacy">
      <div className="rounded-pop border border-line bg-raised px-5 py-4">
        <FieldLists />
      </div>
      <p className="mt-2 text-body text-fg2">
        {t("onb.staysHere")}{" "}
        <button
          type="button"
          className="text-fg2 underline underline-offset-2 hover:text-fg"
          onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
          data-testid="onb-see-all"
        >
          {t("onb.seeAll")}
        </button>
      </p>
      {anchor ? (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="w-[420px] !p-4">
          <FieldLists compact />
          <p className="mt-3 border-line border-t pt-3 text-fg2 text-meta">{t("onb.titlesOff")}</p>
        </Popover>
      ) : null}
    </div>
  );
}

/** 起動しない（B2）。O3 の中断が30秒戻らないとき（O1 の B2 と同じ文言・ボタン） */
export function StartFailed({ onRetry, onCopy }: { onRetry: () => void; onCopy: Act }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2" data-part="b2">
      <div className="flex items-center gap-2 font-medium text-body text-fg">
        <TriangleAlert size={16} strokeWidth={1.5} className="text-error" aria-hidden="true" />
        {t("onb.b2.title")}
      </div>
      <p className="text-body text-fg2">
        {t("onb.b2.line")} {t("onb.b2.kept")}
      </p>
      <ButtonPair
        secondary={{
          labels: [
            t("onb.b2.copy"),
            <>
              <CheckIcon size={12} strokeWidth={1.75} aria-hidden="true" />
              {t("onb.b2.copied")}
            </>,
          ],
          active: copied ? 1 : 0,
          onClick: () =>
            void onCopy().then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }),
        }}
        primary={{ labels: [t("onb.b2.retry")], onClick: onRetry }}
      />
    </div>
  );
}

/** 状態のドット（確定デザイン onb-P-parts の 4）: ● 済み / ◐ 待ち / ○ 未設定 / ⚠ 問題あり。灰・インク・赤だけ */
export function StatusDot({ mark, className = "" }: { mark: StartMark; className?: string }) {
  const { t } = useI18n();
  const label = t(
    mark === "done"
      ? "onb.status.done"
      : mark === "waiting"
        ? "onb.status.waiting"
        : mark === "notSet"
          ? "onb.status.notSet"
          : "onb.status.problem",
  );
  if (mark === "problem")
    return (
      <TriangleAlert
        size={12}
        strokeWidth={1.75}
        className={`shrink-0 text-error ${className}`}
        role="img"
        aria-label={label}
        data-mark={mark}
      />
    );
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      className={`shrink-0 ${mark === "notSet" ? "text-fg3" : "text-fg"} ${className}`}
      role="img"
      aria-label={label}
      data-mark={mark}
    >
      <circle
        cx="5"
        cy="5"
        r="4"
        fill={mark === "done" ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.25"
      />
      {mark === "waiting" ? <path d="M5 1 A4 4 0 0 1 5 9 Z" fill="currentColor" /> : null}
    </svg>
  );
}

/** 本文の箇条書き（O4・O7。アイコンなし） */
export function Points({ items }: { items: string[] }) {
  return (
    <ul className="mt-4 flex list-disc flex-col gap-1.5 pl-5 text-body text-fg leading-6">
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

/** 結果の塊（O4 の許可済み・拒否・0件・起動しない、O7 の拒否）。見出し行と 1〜2 行 */
export function ResultBox({
  mark,
  title,
  lines,
  testId,
  children,
}: {
  mark: StartMark;
  title: string;
  lines?: string[];
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className="mt-6 flex flex-col gap-1.5 rounded-pop border border-line bg-raised px-5 py-4"
      data-part="result"
      data-mark={mark}
      data-testid={testId}
    >
      <div className="flex items-center gap-2 font-medium text-body text-fg">
        <StatusDot mark={mark} />
        {title}
      </div>
      {(lines ?? []).map((l) => (
        <p key={l} className="text-body text-fg2">
          {l}
        </p>
      ))}
      {children}
    </div>
  );
}

/**
 * 設定ディレクトリの行（O5・O5a。O2 の取り込み元の行と同じ並び: ツール名・名前の札・パス、右に結果）。
 * mark があれば左に状態のドット（インストールの後）
 */
export function TargetRow({
  name,
  label,
  path,
  right,
  mark,
  testId,
  state,
}: {
  name: string;
  label: string | null;
  path: string;
  right: ReactNode;
  mark?: StartMark | undefined;
  testId?: string;
  state?: string;
}) {
  return (
    <div
      className="flex h-11 min-w-0 items-center gap-3 rounded-card px-4"
      data-target={testId}
      data-state={state}
    >
      <span className="flex w-4 shrink-0 items-center justify-center">
        {mark ? <StatusDot mark={mark} /> : null}
      </span>
      <span className="shrink-0 font-medium text-body text-fg">{name}</span>
      {label ? (
        <span className="shrink-0 rounded-chip border border-line px-1.5 text-fg2 text-meta">
          {label}
        </span>
      ) : null}
      <span
        title={path}
        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-fg2 text-meta"
      >
        {path}
      </span>
      <span
        className={`ml-auto shrink-0 whitespace-nowrap pl-3 text-meta ${mark === "problem" ? "text-error" : "text-fg2"}`}
      >
        {right}
      </span>
    </div>
  );
}

/** 「変更を見る ▸」の開閉（O5・O5a の差分） */
export function Disclosure({
  open,
  onToggle,
  showLabel,
  hideLabel,
  testId,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  showLabel: string;
  hideLabel: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        data-testid={testId}
        aria-expanded={open}
        className="flex items-center gap-1 font-medium text-body text-fg2 hover:text-fg hover:underline"
      >
        {open ? hideLabel : showLabel}
        <ChevronRight
          size={12}
          strokeWidth={1.75}
          className={open ? "rotate-90" : ""}
          aria-hidden="true"
        />
      </button>
      {open ? children : null}
    </div>
  );
}
