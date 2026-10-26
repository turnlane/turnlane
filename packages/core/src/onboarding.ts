/**
 * オンボーディングの状態（onboarding.md 5.1、M6-18）。設定キー `onboarding`（setting テーブル、local_only）に置く。
 * `turnlane config` の一覧（CONFIG_SCHEMAS）には入れない（同意は /api/onboarding/consent か
 * `turnlane onboarding consent` でだけ記録する）。読み出しは壊れた値でも既定に寄せる。
 */

export const ONBOARDING_KEY = "onboarding";

export const ONBOARDING_STEPS = [
  "sources",
  "import",
  "calendar",
  "hooks",
  // AI から Turnlane を使えるようにする（MCP の登録。D-145）
  "mcp",
  "hours",
  "notifications",
  "start",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingStepStatus = "pending" | "done" | "skipped" | "failed";
export type OnboardingPhase = "pending" | "consented" | "done";

export interface Onboarding {
  state: OnboardingPhase;
  /** 今の段（途中で閉じたら次はここから） */
  step: OnboardingStep;
  /** 同意した時刻（epoch ms）。null の間は AI のセッションを取り込まない（5.2） */
  consentedAt: number | null;
  /**
   * 取り込む範囲の始まり（epoch ms。D-181）。最初の同意のときの「直近7日」の始まり（6日前の論理日の始まり）。
   * これより前に更新が止まったセッションのファイルは、今も後からも読まない。null は制限なし（既存の利用者）
   */
  importSince: number | null;
  steps: Record<OnboardingStep, OnboardingStepStatus>;
  /** 流れを変えたときに出し直す判断用 */
  version: 1;
}

const STEP_STATUSES = new Set<OnboardingStepStatus>(["pending", "done", "skipped", "failed"]);

export function isOnboardingStep(s: unknown): s is OnboardingStep {
  return typeof s === "string" && (ONBOARDING_STEPS as readonly string[]).includes(s);
}

export function isOnboardingStepStatus(s: unknown): s is OnboardingStepStatus {
  return typeof s === "string" && STEP_STATUSES.has(s as OnboardingStepStatus);
}

function allSteps(v: OnboardingStepStatus): Record<OnboardingStep, OnboardingStepStatus> {
  return Object.fromEntries(ONBOARDING_STEPS.map((s) => [s, v])) as Record<
    OnboardingStep,
    OnboardingStepStatus
  >;
}

/** 新しい DB の値 */
export function initialOnboarding(): Onboarding {
  return {
    state: "pending",
    step: "sources",
    consentedAt: null,
    importSince: null,
    steps: allSteps("pending"),
    version: 1,
  };
}

/**
 * 既存の利用者の値（5.1 のマイグレーション）: 取り込みのカーソルがある DB は、同意済みで流れも済んだものとする。
 * 同意の時刻は最初のカーソルの updated_at
 */
export function existingUserOnboarding(consentedAt: number): Onboarding {
  return {
    state: "done",
    step: "start",
    consentedAt,
    importSince: null,
    steps: allSteps("done"),
    version: 1,
  };
}

/** 保存値を読む（壊れた値は欠けたところを既定に寄せる。未設定なら null） */
export function readOnboarding(v: unknown): Onboarding | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const base = initialOnboarding();
  const state: OnboardingPhase =
    o.state === "done" || o.state === "consented" || o.state === "pending" ? o.state : base.state;
  const consentedAt =
    typeof o.consentedAt === "number" && Number.isFinite(o.consentedAt) ? o.consentedAt : null;
  const importSince =
    typeof o.importSince === "number" && Number.isFinite(o.importSince) ? o.importSince : null;
  const steps = { ...base.steps };
  if (o.steps && typeof o.steps === "object") {
    for (const s of ONBOARDING_STEPS) {
      const x = (o.steps as Record<string, unknown>)[s];
      if (isOnboardingStepStatus(x)) steps[s] = x;
    }
  }
  return {
    // 同意の時刻が無い consented は pending に戻す。done は同意なし（Not now）で流れを終えた場合もある。
    // 取り込みのゲートは state ではなく consentedAt で決める
    state: consentedAt === null && state === "consented" ? "pending" : state,
    step: isOnboardingStep(o.step) ? o.step : base.step,
    consentedAt,
    importSince,
    steps,
    version: 1,
  };
}

export function nextOnboardingStep(s: OnboardingStep): OnboardingStep {
  const i = ONBOARDING_STEPS.indexOf(s);
  return ONBOARDING_STEPS[Math.min(i + 1, ONBOARDING_STEPS.length - 1)] as OnboardingStep;
}

/**
 * 段の完了・スキップ・失敗・戻る（PUT /api/onboarding/step）。
 * - pending は「その段に戻る」（今の段をそこにする）
 * - done / skipped / failed はその段を記録し、次の段へ進める。`start` の done で state=done
 */
export function applyOnboardingStep(
  cur: Onboarding,
  step: OnboardingStep,
  status: OnboardingStepStatus,
): Onboarding {
  const steps = { ...cur.steps, [step]: status };
  if (status === "pending") return { ...cur, steps, step };
  const finished = step === "start" && status === "done";
  return {
    ...cur,
    steps,
    step: finished ? "start" : nextOnboardingStep(step),
    state: finished ? "done" : cur.state,
  };
}

/**
 * 同意（POST /api/onboarding/consent）。既に同意していれば時刻と取り込む範囲は保つ。
 * importSince は最初の同意のときの直近7日の始まり（D-181）
 */
export function applyOnboardingConsent(
  cur: Onboarding,
  now: number,
  importSince: number,
): Onboarding {
  const first = cur.consentedAt === null;
  return {
    ...cur,
    consentedAt: first ? now : cur.consentedAt,
    importSince: first ? importSince : cur.importSince,
    state: cur.state === "done" ? "done" : "consented",
    steps: { ...cur.steps, sources: "done" },
    step: cur.state === "done" ? cur.step : cur.step === "sources" ? "import" : cur.step,
  };
}

/**
 * `Run setup again`（POST /api/onboarding/restart）: 最初の段から通し直す。同意と取り込み済みのデータは消さない
 * （同意済みなら consented に戻すので取り込みは止まらない）
 */
export function restartOnboarding(cur: Onboarding): Onboarding {
  return {
    ...cur,
    state: cur.consentedAt !== null ? "consented" : "pending",
    step: "sources",
    steps: allSteps("pending"),
  };
}
