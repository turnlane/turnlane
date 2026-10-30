/**
 * 設定 › 一般の「更新」の行（ほかの Mac アプリの「アップデート」と同じく、版・最後の確認・結果・今すぐ確認を 1 か所に）。
 * 純粋関数にしてテストする。文言の組み立てだけで、判定はデーモンの GET /api/update
 *
 * - 確認しないビルド（拡張入り・開発時の配置・確認先なし）: `このビルドは更新を確認しません`（ボタンなし）
 * - 自動の確認がオフ: `v0.8.0+e820ba7 · 自動の確認はオフ`（ボタンあり。押したら結果も足す）
 * - それ以外: `v0.8.0+e820ba7 · 最後の確認 16:02 · 最新です` / `… · 0.8.1 があります` / `… · 確認できませんでした（オフライン）`
 */
import type { UpdateStatus } from "@turnlane/core/web";
import { fmtClock, wallClock } from "@turnlane/core/web";
import type { MessageKey } from "../i18n/index.tsx";

type T = (key: MessageKey, params?: Record<string, string | number>) => string;

export interface UpdateLine {
  text: string;
  /** 今すぐ確認のボタンを出す */
  canCheck: boolean;
}

/** 失敗の理由（デーモンの error のコード）→ 言葉 */
export function updateFailure(error: string | null, t: T): string {
  if (error === "network") return t("settings.update.why.offline");
  if (error === "timeout") return t("settings.update.why.timeout");
  return t("settings.update.why.server");
}

export function updateLine(s: UpdateStatus, now: number, tz: string, t: T): UpdateLine {
  if (!s.configured || s.off === "custom_build" || s.off === "dev_install")
    return { text: t("settings.update.notThisBuild"), canCheck: false };
  const parts = [`v${s.build ?? s.current}`];
  const off = s.off === "setting" || !s.enabled;
  if (off) parts.push(t("settings.update.autoOff"));
  if (s.checkedAt !== null) {
    const same = wallClock(s.checkedAt, tz);
    const today = wallClock(now, tz);
    const time =
      same.year === today.year && same.month === today.month && same.day === today.day
        ? fmtClock(s.checkedAt, tz)
        : `${same.month}/${same.day} ${fmtClock(s.checkedAt, tz)}`;
    parts.push(t("settings.update.lastChecked", { time }));
    const result = s.result ?? (s.error ? "failed" : s.available ? "available" : "up_to_date");
    if (result === "failed")
      parts.push(t("settings.update.failed", { why: updateFailure(s.error, t) }));
    else if (result === "available" && s.latest)
      parts.push(t("settings.update.available", { version: s.latest.version }));
    else parts.push(t("settings.update.upToDate"));
  } else if (!off) parts.push(t("settings.update.never"));
  return { text: parts.join(" · "), canCheck: true };
}

// ---------- アプリのメニューの「アップデートを確認…」（Rust → window.__turnlaneCheckUpdates） ----------

let request = 0;
const listeners = new Set<() => void>();

/** 「更新」の節に、開いたら確かめるよう頼む */
export function requestUpdateCheck(): void {
  request = Date.now();
  for (const l of listeners) l();
}

export function subscribeUpdateCheck(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getUpdateCheckRequest(): number {
  return request;
}
