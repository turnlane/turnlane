/**
 * オンボーディングの段（onboarding.md 3章）。純粋関数にしてテストする。
 * - 上部の段の表示は O2 以降の8段（O1 は boot ページで出さない）。飛ばした段は消さずにダッシュで残す
 * - 画面は O2〜O8 の全部の段にある（M6-21〜M6-26）。同意が無い・取り込み元が無いときの hooks・AI tools は自動で飛ばす
 */
import { ONBOARDING_STEPS, type OnboardingStep, type OnboardingView } from "@turnlane/core/web";
import type { MessageKey } from "../i18n/en.ts";

export const STEP_LABEL: Record<OnboardingStep, MessageKey> = {
  sources: "onb.step.sources",
  import: "onb.step.import",
  calendar: "onb.step.calendar",
  hooks: "onb.step.hooks",
  mcp: "onb.step.mcp",
  hours: "onb.step.hours",
  notifications: "onb.step.notifications",
  start: "onb.step.start",
};

export type StepMark = "done" | "skipped" | "current" | "upcoming";

/** 同意しないと出ない段（O2 の Not now・0件の後。4.2・4.5・4.5a） */
const NEEDS_CONSENT: readonly OnboardingStep[] = ["import", "hooks", "mcp"];

/** 段の表示の印。current は今の段（view.step） */
export function stepMarks(
  v: Pick<OnboardingView, "step" | "steps" | "consentedAt">,
): { step: OnboardingStep; mark: StepMark }[] {
  const declined = v.consentedAt === null && v.steps.sources === "skipped";
  return ONBOARDING_STEPS.map((step) => {
    if (step === v.step) return { step, mark: "current" };
    const s = v.steps[step];
    if (s === "done") return { step, mark: "done" };
    // 失敗した段（hooks が一部書けなかったなど）も、済みではないのでダッシュで残す
    if (s === "skipped" || s === "failed" || (declined && NEEDS_CONSENT.includes(step)))
      return { step, mark: "skipped" };
    return { step, mark: "upcoming" };
  });
}

/** 今の段の番号（1 始まり）と段の数 */
export function stepPosition(step: OnboardingStep): { n: number; total: number } {
  return { n: ONBOARDING_STEPS.indexOf(step) + 1, total: ONBOARDING_STEPS.length };
}

/** 画面のある段（O2〜O8 の全部。M6-21〜M6-26） */
export const SCREEN_STEPS: readonly OnboardingStep[] = [...ONBOARDING_STEPS];

export function hasScreen(step: OnboardingStep): boolean {
  return SCREEN_STEPS.includes(step);
}

/**
 * 画面を出さずに飛ばす段（4.2・4.5・4.5a）: 同意が無ければ取り込み・hooks・AI tools、取り込む Claude Code / Codex が
 * 無ければ hooks・AI tools。取り込みは同意のときに画面側で skipped にするので、ここでは同意の有無だけを見る
 */
export function autoSkipped(
  step: OnboardingStep,
  v: Pick<OnboardingView, "consentedAt" | "steps">,
  hasSources: boolean,
): boolean {
  if (!NEEDS_CONSENT.includes(step)) return false;
  if (v.consentedAt === null) return true;
  if (step === "import") return v.steps.import === "skipped";
  return !hasSources;
}

/**
 * 戻る先（O3 以降だけ。O2 には戻るが無い。D-184）。前の段のうち、画面を出さずに飛ばした段は飛ばす
 * （Not now の後の O4 から戻ると O2、取り込み元が無いときの O6 から戻ると O4）
 */
export function backTarget(
  step: OnboardingStep,
  v: Pick<OnboardingView, "consentedAt" | "steps"> = { consentedAt: 1, steps: {} as never },
  hasSources = true,
): OnboardingStep | null {
  if (step === "sources") return null;
  const i = ONBOARDING_STEPS.indexOf(step);
  for (let k = i - 1; k >= 0; k--) {
    const s = ONBOARDING_STEPS[k] as OnboardingStep;
    if (hasScreen(s) && !autoSkipped(s, v, hasSources)) return s;
  }
  return null;
}

/** O8 の行の印（状態のドット。確定デザイン onb-P-parts の 4） */
export type StartMark = "done" | "waiting" | "notSet" | "problem";

export interface StartInput {
  steps: OnboardingView["steps"];
  consented: boolean;
  /** 取り込む元の数（O2 でチェックした Claude Code / Codex） */
  sources: number;
  /** 7日分の取り込みが終わったか */
  importDone: boolean;
  calendar: { connected: boolean; authorization: string | null; calendars: number } | null;
  /** 取り込む元ごとの hooks の状態（ai_source.hooks_state） */
  hooks: string[];
  mcp: string[];
  notifications: "granted" | "denied" | "off" | "unknown";
}

export interface StartRow {
  key: "import" | "calendar" | "hooks" | "mcp" | "notifications";
  mark: StartMark;
  /** 行の文言（辞書のキーと差し込み） */
  text: { key: MessageKey; params?: Record<string, string | number> };
  /** クリックで開く設定の節 */
  section: "ai" | "calendar" | "notify";
}

/** O8 の各行（4.8）。飛ばした・失敗した段は ○ / ◐ / ⚠ で示し、設定の該当の節を開く */
export function startRows(x: StartInput): StartRow[] {
  const rows: StartRow[] = [];
  if (x.consented && x.sources > 0)
    rows.push({
      key: "import",
      mark: x.importDone ? "done" : "waiting",
      text: x.importDone
        ? { key: "onb.start.import.sources", params: { count: x.sources } }
        : { key: "onb.start.import.rest" },
      section: "ai",
    });
  else
    rows.push({
      key: "import",
      mark: "notSet",
      text: { key: "onb.start.import.off" },
      section: "ai",
    });
  const c = x.calendar;
  if (c?.connected && c.authorization === "fullAccess")
    rows.push({
      key: "calendar",
      mark: c.calendars > 0 ? "done" : "waiting",
      text: { key: "onb.start.calendar.on", params: { count: c.calendars } },
      section: "calendar",
    });
  else if (c?.connected && c.authorization !== null && c.authorization !== "notDetermined")
    rows.push({
      key: "calendar",
      mark: "problem",
      text: { key: "onb.start.calendar.denied" },
      section: "calendar",
    });
  else
    rows.push({
      key: "calendar",
      mark: "notSet",
      text: { key: "onb.start.calendar.off" },
      section: "calendar",
    });
  if (x.consented && x.sources > 0) {
    const on = x.hooks.filter((h) => h === "installed" || h === "receiving").length;
    const pending = x.hooks.filter((h) => h === "pending_trust").length;
    const silent = x.hooks.filter((h) => h === "silent").length;
    if (on + pending + silent === 0)
      rows.push({
        key: "hooks",
        mark: "notSet",
        text: { key: "onb.start.hooks.off" },
        section: "ai",
      });
    else if (silent > 0)
      rows.push({
        key: "hooks",
        mark: "problem",
        text: { key: "onb.start.hooks.problem" },
        section: "ai",
      });
    else if (pending > 0)
      rows.push({
        key: "hooks",
        mark: "waiting",
        text: { key: "onb.start.hooks.codex" },
        section: "ai",
      });
    else
      rows.push({ key: "hooks", mark: "done", text: { key: "onb.start.hooks.on" }, section: "ai" });
    const registered = x.mcp.filter((m) => m === "installed").length;
    rows.push(
      registered === x.mcp.length && registered > 0
        ? { key: "mcp", mark: "done", text: { key: "onb.start.mcp.on" }, section: "ai" }
        : { key: "mcp", mark: "notSet", text: { key: "onb.start.mcp.off" }, section: "ai" },
    );
  }
  rows.push(
    x.notifications === "granted"
      ? {
          key: "notifications",
          mark: "done",
          text: { key: "onb.start.notify.on" },
          section: "notify",
        }
      : {
          key: "notifications",
          mark: "notSet",
          text: { key: "onb.start.notify.off" },
          section: "notify",
        },
  );
  return rows;
}

/** 「last used …」の日数（論理日ではなく暦日の差。0 = 今日） */
export function daysAgo(at: number, now: number): number {
  const a = new Date(at);
  const b = new Date(now);
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.max(0, Math.round((db - da) / 86_400_000));
}

/** パスを ~ で短くする */
export function tildePath(p: string, home: string): string {
  if (home && (p === home || p.startsWith(`${home}/`))) return `~${p.slice(home.length)}`;
  return p;
}

/** 列に出せるラベルの数（入りきらなければ最後の1行を「+N more」にする） */
export function visibleCount(total: number, fit: number): { shown: number; more: number } {
  if (total <= fit) return { shown: total, more: 0 };
  const shown = Math.max(0, fit - 1);
  return { shown, more: total - shown };
}

/** 画面の操作（終わるまでボタンを押せなくする） */
export type Act = () => Promise<void>;
/** 書いた結果を受けて進む（O5・O5a の Continue。失敗があれば true） */
export type FailAct = (failed: boolean) => Promise<void>;
export type ImportAct = (ids: string[], empty: boolean) => Promise<void>;
