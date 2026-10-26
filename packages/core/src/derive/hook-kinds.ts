/** hook の種類の判定（状態・待ち・サブエージェントの判定が共有する。status.ts が再エクスポートする） */
import type { HookFact } from "./types.ts";

const PERMISSION_NOTIFICATIONS = new Set(["permission_prompt", "agent_needs_input"]);
const CLEARING_HOOKS = new Set(["Stop", "StopFailure", "UserPromptSubmit", "SessionEnd"]);

/** 自動で許可される権限のモード（許可の hook が出ても、ダイアログを出さずにすぐ実行される） */
export const AUTO_APPROVED_MODES: readonly string[] = ["bypassPermissions"];

/**
 * 許可待ちの hook か（PermissionRequest・Notification の permission_prompt / agent_needs_input）。権限のモードが
 * bypassPermissions のものは自動で許可されるので待ちにしない（Claude Code はこのモードでもサブエージェントの呼び出しで
 * PermissionRequest と permission_prompt を出し、すぐ許可する）
 */
export function isPermissionHook(
  h: Pick<HookFact, "name" | "notificationType"> & { permissionMode?: string | null },
): boolean {
  if (h.permissionMode && AUTO_APPROVED_MODES.includes(h.permissionMode)) return false;
  return (
    h.name === "PermissionRequest" ||
    (h.name === "Notification" && PERMISSION_NOTIFICATIONS.has(h.notificationType ?? ""))
  );
}

export function isClearingHook(h: Pick<HookFact, "name">): boolean {
  return CLEARING_HOOKS.has(h.name);
}

/**
 * Claude Code の利用枠の自動再開の通知（Notification の notification_type。Claude Code v2.1.234 以降。公式の hooks の
 * Notification の節）:
 * - fired: 利用枠で止まった作業を続けた（リセットの時刻か、それより前に枠が空いたとき）。上限待ちは終わり、ターンは続く
 * - stale: スリープ中（約 30 分より長く）にリセットした。続けずに ⏎ を待つ（いま再開できる）
 * - disabled: 待つのをやめた（自動で続けない設定・リセットが 24 時間より先・続けてもまた枠に当たった など）。上限待ちのまま
 */
export const QUOTA_RESUME_FIRED = "quota_auto_resume_fired";
export const QUOTA_RESUME_STALE = "quota_auto_resume_stale";
export const QUOTA_RESUME_DISABLED = "quota_auto_resume_disabled";
const QUOTA_PREFIX = "quota_auto_resume_";

/** 利用枠の自動再開の通知か（type を渡せばその種類だけ） */
export function isQuotaNotice(
  h: Pick<HookFact, "name" | "notificationType">,
  type?: string,
): boolean {
  if (h.name !== "Notification") return false;
  const n = h.notificationType ?? "";
  return type === undefined ? n.startsWith(QUOTA_PREFIX) : n === type;
}
