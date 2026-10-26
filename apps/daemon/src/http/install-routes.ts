/**
 * 配置の方式（M6-15。onboarding.md 2.4・4.8）:
 * - GET  /api/install            方式（app / dev）・アプリの場所・版・turnlane のリンクの状態
 * - POST /api/install/cli-link   `~/.local/bin/turnlane` をアプリの中の turnlane へのリンクにする（O8 の Install ▸）
 */
import { Hono } from "hono";
import type { InstallService } from "../install/index.ts";

export function createInstallRoutes(get: () => InstallService | undefined) {
  return new Hono()
    .get("/install", (c) => {
      const s = get();
      if (!s) return c.json({ error: "install_unavailable" }, 409);
      return c.json(s.status());
    })
    .post("/install/cli-link", (c) => {
      const s = get();
      if (!s) return c.json({ error: "install_unavailable" }, 409);
      return c.json(s.installCliLink());
    });
}
