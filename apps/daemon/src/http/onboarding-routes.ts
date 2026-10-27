/**
 * オンボーディングの API（onboarding.md 5.4、M6-18〜M6-20）:
 * - GET  /api/onboarding                      状態（段・同意・バックフィルの完了）
 * - PUT  /api/onboarding/step { step, status } 段の完了・スキップ・失敗・戻る（pending）。`start` の done で state=done
 * - GET  /api/onboarding/detect               検出のやり直しと結果（ファイルの数と更新時刻だけ）
 * - POST /api/onboarding/sources { path }     設定ディレクトリを手で足す（Choose a folder…）
 * - POST /api/onboarding/consent { enabledSourceIds } 同意と取り込みの開始
 * - GET  /api/onboarding/progress             新しい日からの進捗（SSE import_progress と同じ形）
 * - GET  /api/onboarding/board?days=7         O3 の日ごとの列（AI の作業のラベル）
 * - GET  /api/onboarding/summary?days=7       O3 の1行（AI 時間・作業の数・待った回数）
 * - POST /api/onboarding/restart              Run setup again（データは消さない）
 * - POST /api/onboarding/hooks { dryRun }     O5: 同意した取り込み元に hooks を入れる（turnlane hooks install と同じ）
 * - POST /api/onboarding/mcp { dryRun }       O5a: 同意した取り込み元に MCP を登録する（turnlane mcp install と同じ）
 * - POST /api/onboarding/calendar/connect     O4: ヘルパの常駐と許可のダイアログを始める（結果は /api/calendar/status）
 * - GET  /api/onboarding/calendar/connect     O4: 最後に始めた接続の結果（失敗の理由。{ attempt }）
 * - POST /api/onboarding/open-settings { pane } システム設定の画面を開く（calendars / notifications）
 * 更新確認（M6-12）:
 * - GET  /api/update                          状態（接続しない）
 * - POST /api/update/check                    今すぐ確かめる（update.check がオフなら 409 update_check_off）
 * - POST /api/update/dismiss { version }       ボードの更新の知らせを閉じる（その版は次の起動まで出さない。接続しない）
 */
import { zValidator } from "@hono/zod-validator";
import { ONBOARDING_STEPS } from "@turnlane/core";
import { Hono } from "hono";
import { z } from "zod";
import { OpError } from "../derive/ops.ts";
import type { OnboardingService } from "../onboarding/service.ts";
import type { UpdateChecker } from "../update/checker.ts";

const stepInput = z.object({
  step: z.enum(ONBOARDING_STEPS),
  status: z.enum(["pending", "done", "skipped", "failed"]),
});
const consentInput = z.object({
  enabledSourceIds: z.array(z.string().min(1).max(64)).max(100),
});
const sourceInput = z.object({ path: z.string().min(1).max(1024) });
const installInput = z.object({ dryRun: z.boolean().optional() });
const paneInput = z.object({ pane: z.enum(["calendars", "notifications"]) });
const dismissInput = z.object({ version: z.string().min(1).max(64) }).strict();

const invalid = (r: { success: boolean }, c: { json: (b: unknown, s: 400) => Response }) => {
  if (!r.success) return c.json({ error: "invalid_input" }, 400);
};

export function createOnboardingRoutes(
  get: () => OnboardingService | undefined,
  update: () => UpdateChecker | undefined,
) {
  const svc = () => {
    const s = get();
    if (!s) throw new OpError(409, "onboarding_unavailable");
    return s;
  };
  const upd = () => {
    const u = update();
    if (!u) throw new OpError(409, "update_unavailable");
    return u;
  };
  return new Hono()
    .onError((e, c) => {
      if (e instanceof OpError) return c.json({ error: e.message }, e.status);
      throw e;
    })
    .get("/onboarding", (c) => c.json(svc().view()))
    .put("/onboarding/step", zValidator("json", stepInput, invalid), (c) => {
      const b = c.req.valid("json");
      return c.json(svc().setStep(b.step, b.status));
    })
    .get("/onboarding/detect", async (c) => c.json(await svc().detect()))
    .post("/onboarding/sources", zValidator("json", sourceInput, invalid), async (c) =>
      c.json(await svc().addSource(c.req.valid("json").path)),
    )
    .post("/onboarding/consent", zValidator("json", consentInput, invalid), async (c) =>
      c.json(await svc().consent(c.req.valid("json").enabledSourceIds)),
    )
    .get("/onboarding/progress", (c) => c.json(svc().progress()))
    .get("/onboarding/board", (c) => {
      const n = Number(c.req.query("days") ?? 7);
      if (!Number.isInteger(n) || n < 1 || n > 30) return c.json({ error: "invalid_input" }, 400);
      return c.json(svc().board(n));
    })
    .get("/onboarding/summary", (c) => {
      const n = Number(c.req.query("days") ?? 7);
      if (!Number.isInteger(n) || n < 1 || n > 30) return c.json({ error: "invalid_input" }, 400);
      return c.json(svc().summary(n));
    })
    .post("/onboarding/restart", (c) => c.json(svc().restart()))
    .post("/onboarding/hooks", zValidator("json", installInput, invalid), async (c) =>
      c.json(await svc().installHooks(c.req.valid("json").dryRun === true)),
    )
    .post("/onboarding/mcp", zValidator("json", installInput, invalid), (c) =>
      c.json(svc().installMcp(c.req.valid("json").dryRun === true)),
    )
    .post("/onboarding/calendar/connect", async (c) => c.json(await svc().connectCalendar()))
    .get("/onboarding/calendar/connect", (c) => c.json({ attempt: svc().calendarAttempt() }))
    .post("/onboarding/open-settings", zValidator("json", paneInput, invalid), async (c) =>
      c.json(await svc().openSettings(c.req.valid("json").pane)),
    )
    .get("/update", (c) => c.json(upd().status()))
    .post("/update/check", async (c) => c.json(await upd().checkNow()))
    .post("/update/dismiss", zValidator("json", dismissInput, invalid), (c) =>
      c.json(upd().dismiss(c.req.valid("json").version)),
    );
}
