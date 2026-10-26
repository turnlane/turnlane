/**
 * オンボーディングの読み取りと操作（onboarding.md 5.4）。鮮度は SSE（onboarding・import_progress・source・work_item）の
 * 無効化が保つ
 */
import { useQuery } from "@tanstack/react-query";
import type {
  CalendarConnectResponse,
  DetectedSourceView,
  DetectResponse,
  HooksInstallResponse,
  ImportProgress,
  InstallStatus,
  McpInstallResponse,
  OnboardingBoard,
  OnboardingStep,
  OnboardingStepStatus,
  OnboardingSummary,
  OnboardingView,
} from "@turnlane/core/web";
import type { CalendarStatusView } from "@turnlane/daemon";
import { queryClient } from "../data/client.ts";
import { keys } from "../data/invalidate.ts";
import { api, unwrap } from "../lib/api.ts";
import { desktopSetup } from "../lib/desktop.ts";

type InstallCliLinkResponse = {
  ok: boolean;
  reason: "not_app" | "occupied" | "failed" | null;
  status: InstallStatus;
};

export function useOnboardingState(enabled = true) {
  return useQuery({
    queryKey: keys.onboarding("state"),
    queryFn: () => unwrap<OnboardingView>(api.api.onboarding.$get()),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useDetect(enabled = true) {
  return useQuery({
    queryKey: keys.onboarding("detect"),
    queryFn: () => unwrap<DetectResponse>(api.api.onboarding.detect.$get()),
    enabled,
    staleTime: 60_000,
  });
}

export function useImportProgress() {
  return useQuery({
    queryKey: keys.onboarding("progress"),
    queryFn: () => unwrap<ImportProgress>(api.api.onboarding.progress.$get()),
  });
}

export function useOnboardingBoard() {
  return useQuery({
    queryKey: keys.onboarding("board"),
    queryFn: () => unwrap<OnboardingBoard>(api.api.onboarding.board.$get({ query: { days: "7" } })),
    placeholderData: (prev) => prev,
  });
}

export function useOnboardingSummary(enabled: boolean) {
  return useQuery({
    queryKey: keys.onboarding("summary"),
    queryFn: () =>
      unwrap<OnboardingSummary>(api.api.onboarding.summary.$get({ query: { days: "7" } })),
    enabled,
  });
}

function setState(v: OnboardingView): OnboardingView {
  queryClient.setQueryData(keys.onboarding("state"), v);
  return v;
}

/** 段の完了・スキップ・戻る（PUT /api/onboarding/step） */
export async function putStep(
  step: OnboardingStep,
  status: OnboardingStepStatus,
): Promise<OnboardingView> {
  return setState(
    await unwrap<OnboardingView>(api.api.onboarding.step.$put({ json: { step, status } })),
  );
}

/** 同意と取り込みの開始（空の一覧でもよい。D-181） */
export async function consent(enabledSourceIds: string[]): Promise<OnboardingView> {
  return setState(
    await unwrap<OnboardingView>(api.api.onboarding.consent.$post({ json: { enabledSourceIds } })),
  );
}

/** Choose a folder…（Claude Code の設定フォルダを手で足す） */
export async function addSource(path: string): Promise<DetectedSourceView> {
  const v = await unwrap<DetectedSourceView>(api.api.onboarding.sources.$post({ json: { path } }));
  await queryClient.invalidateQueries({ queryKey: keys.onboarding("detect") });
  return v;
}

/** 配置の方式（GET /api/install。M6-15） */
export function useInstallStatus() {
  return useQuery({
    queryKey: ["install"],
    queryFn: () => unwrap<InstallStatus>(api.api.install.$get()),
    staleTime: 30_000,
    retry: false,
  });
}

async function installMode(): Promise<InstallStatus["mode"] | null> {
  try {
    return (await unwrap<InstallStatus>(api.api.install.$get())).mode;
  } catch {
    return null;
  }
}

/**
 * O4: カレンダーの接続（ヘルパの常駐と許可のダイアログ）を始める。結果は useCalendarStatus で確かめる。
 * 配布版（install.json の app）は、先にアプリが SMAppService でヘルパを登録し（IPC registerCalendarHelper）、
 * デーモンは許可のダイアログだけを出す。アプリの中でなければ（ブラウザ）登録できないので unavailable
 */
export async function connectCalendar(): Promise<CalendarConnectResponse> {
  if ((await installMode()) === "app") {
    try {
      const r = await desktopSetup({ action: "registerCalendarHelper" });
      if (!r) return { started: false, reason: "unavailable" };
    } catch {
      return { started: false, reason: "failed" };
    }
  }
  return unwrap<CalendarConnectResponse>(api.api.onboarding.calendar.connect.$post());
}

/**
 * O2 の Choose a folder…: アプリの中ならネイティブのフォルダの選択（隠しフォルダも出す）。選ばなければ null。
 * アプリの外・古いアプリなら undefined（画面はパスを入れる欄に落とす）
 */
export async function chooseFolderNative(prompt: string): Promise<string | null | undefined> {
  const r = await desktopSetup({ action: "chooseFolder", prompt }).catch(() => null);
  if (!r) return undefined;
  return r.path ?? null;
}

/** O8 の Install ▸: ~/.local/bin/turnlane をアプリの中の turnlane へのリンクにする */
export async function installCliLink(): Promise<InstallCliLinkResponse> {
  const r = await unwrap<InstallCliLinkResponse>(api.api.install["cli-link"].$post());
  queryClient.setQueryData(["install"], r.status);
  return r;
}

/** O4 の拒否・O7: システム設定の画面を開く（開けなければ false） */
export async function openSystemSettings(pane: "calendars" | "notifications"): Promise<boolean> {
  try {
    const r = await unwrap<{ opened: boolean }>(
      api.api.onboarding["open-settings"].$post({ json: { pane } }),
    );
    return r.opened;
  } catch {
    return false;
  }
}

/** カレンダーの状態（接続・権限・カレンダー数・祝日）。O4 の許可待ちの間は 1 秒ごとに取り直す */
export function useCalendarStatus(pollMs: number | false = false) {
  return useQuery({
    // 設定 › カレンダーと同じキー（SSE calendar で取り直す）
    queryKey: ["settings", "calendar-status"],
    queryFn: () => unwrap<CalendarStatusView>(api.api.calendar.status.$get()),
    refetchInterval: pollMs,
    retry: false,
  });
}

/** O5: hooks を入れる（dryRun なら書かずに差分だけ） */
export async function installHooks(dryRun: boolean): Promise<HooksInstallResponse> {
  return unwrap<HooksInstallResponse>(api.api.onboarding.hooks.$post({ json: { dryRun } }));
}

/** O5a: MCP を登録する（dryRun なら書かずに差分だけ） */
export async function installMcp(dryRun: boolean): Promise<McpInstallResponse> {
  return unwrap<McpInstallResponse>(api.api.onboarding.mcp.$post({ json: { dryRun } }));
}

/** O6: 設定の値（計画の目安・稼働日・一日の始まり。設定画面と同じ API） */
export async function getConfig<T>(key: string): Promise<T | null> {
  const r = await unwrap<{ value: T | null }>(api.api.config[":key"].$get({ param: { key } }));
  return r.value;
}

export async function putConfig(key: string, value: unknown): Promise<void> {
  await unwrap(api.api.config[":key"].$put({ param: { key }, json: { value } }));
}

/** O7: デスクトップアプリに通知の許可を求める・システム設定を開く（D-080）。アプリがつながっていなければ false */
export async function desktopNotifications(action: "request" | "open_settings"): Promise<boolean> {
  try {
    const r = await unwrap<{ delivered: boolean }>(
      api.api.desktop.notifications.$post({ json: { action } }),
    );
    return r.delivered;
  } catch {
    return false;
  }
}
