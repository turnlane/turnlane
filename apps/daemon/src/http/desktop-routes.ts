/**
 * デスクトップアプリ（Turnlane.app）との接点（desktop-shell.md 4.3・6.2）:
 * - POST /api/desktop/open { path }: アプリがつながっていれば SSE の desktop_open を送る（turnlane open が使う）
 * - POST /api/desktop/status: アプリが通知の許可・ホットキーの登録を知らせる（Rust が Bearer で送る）
 * - GET /api/desktop/status: `turnlane desktop status` と設定画面が読む
 * - POST /api/desktop/notifications { action }: 設定画面の「許可を求める」「システム設定を開く」（D-080）。アプリが
 *   つながっていれば SSE の desktop_notifications で渡す。開く URL・許可の要求はアプリが固定の処理で行う（値は渡さない）
 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { safeNext } from "./auth.ts";
import type { SseHub } from "./sse.ts";

export interface DesktopReport {
  version: string;
  /** unknown = まだ確かめていない、not_determined = 許可を求めたが答えていない（D-080） */
  notifications: NotificationPermission;
  shortcut: { accelerator: string; registered: boolean };
  /** 配布版の常駐の登録（SMAppService。M6-14）。managed が false なら開発時の配置か一時の環境 */
  background?: BackgroundStatus | undefined;
}

export const BACKGROUND_STATES = [
  "enabled",
  "requiresApproval",
  "notRegistered",
  "notFound",
  "unmanaged",
  "unsupported",
] as const;
export type BackgroundState = (typeof BACKGROUND_STATES)[number];
export interface BackgroundStatus {
  managed: boolean;
  daemon: BackgroundState;
  calendarHelper: BackgroundState;
  mainApp: BackgroundState;
}

export const NOTIFICATION_PERMISSIONS = [
  "unknown",
  "granted",
  "denied",
  "not_determined",
  "unsupported",
] as const;
export type NotificationPermission = (typeof NOTIFICATION_PERMISSIONS)[number];

export interface DesktopStatusStore {
  status: DesktopReport | null;
}

export interface DesktopStatusResponse {
  connected: boolean;
  /** アプリが最後に知らせた状態（つながっていないときは null） */
  app: DesktopReport | null;
}

const openInput = z.object({ path: z.string().min(1).max(512) });
const statusInput = z.object({
  version: z.string().max(64),
  notifications: z.enum(NOTIFICATION_PERMISSIONS),
  shortcut: z.object({ accelerator: z.string().max(64), registered: z.boolean() }),
  background: z
    .object({
      managed: z.boolean(),
      daemon: z.enum(BACKGROUND_STATES),
      calendarHelper: z.enum(BACKGROUND_STATES),
      mainApp: z.enum(BACKGROUND_STATES),
    })
    .optional(),
});

const notificationsInput = z.object({
  action: z.enum(["request", "open_settings", "open_automation_settings"]),
});

const invalid = (r: { success: boolean }, c: { json: (b: unknown, s: 400) => Response }) => {
  if (!r.success) return c.json({ error: "invalid_input" }, 400);
};

export function createDesktopRoutes(hub: SseHub, store: DesktopStatusStore) {
  return new Hono()
    .post("/desktop/open", zValidator("json", openInput, invalid), (c) => {
      if (hub.desktopClients === 0) return c.json({ delivered: false });
      hub.publish("desktop_open", { path: safeNext(c.req.valid("json").path) });
      return c.json({ delivered: true });
    })
    .post("/desktop/status", zValidator("json", statusInput, invalid), (c) => {
      const next = c.req.valid("json");
      const changed = JSON.stringify(next) !== JSON.stringify(store.status);
      store.status = next;
      if (changed) hub.publish("desktop_status");
      return c.json({ ok: true });
    })
    .post("/desktop/notifications", zValidator("json", notificationsInput, invalid), (c) => {
      if (hub.desktopClients === 0) return c.json({ delivered: false });
      hub.publish("desktop_notifications", { action: c.req.valid("json").action });
      return c.json({ delivered: true });
    })
    .get("/desktop/status", (c) => {
      const connected = hub.desktopClients > 0;
      return c.json({
        connected,
        app: connected ? store.status : null,
      } satisfies DesktopStatusResponse);
    });
}
