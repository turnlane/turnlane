import { tokenEquals } from "@turnlane/core";
import { Hono } from "hono";
import type { CalendarDeps } from "../calendar/index.ts";
import type { FocusService } from "../focus/service.ts";
import type { HealthReport } from "../health.ts";
import type { InstallService } from "../install/index.ts";
import type { LaunchService } from "../launch/service.ts";
import type { ClaudeLimitsStore } from "../limits/claude.ts";
import type { OnboardingService } from "../onboarding/service.ts";
import type { UpdateChecker } from "../update/checker.ts";
import { type AiDeps, createAiRoutes } from "./ai-routes.ts";
import { apiAuth, authenticate, hostGuard, issueCookie, safeNext } from "./auth.ts";
import { createCalendarRoutes } from "./calendar-routes.ts";
import { createDesktopRoutes, type DesktopStatusStore } from "./desktop-routes.ts";
import { createFocusRoutes } from "./focus-routes.ts";
import { createInstallRoutes } from "./install-routes.ts";
import { createLaunchRoutes } from "./launch-routes.ts";
import { createLimitsRoutes } from "./limits-routes.ts";
import { createOnboardingRoutes } from "./onboarding-routes.ts";
import { createPlannerRoutes, type PlannerDeps } from "./planner-routes.ts";
import type { SseHub } from "./sse.ts";
import { PLACEHOLDER_HTML, type StaticAssets } from "./static.ts";

export interface AppDeps {
  token: string;
  port: number;
  hub: SseHub;
  health: () => HealthReport;
  /** 保守操作（POST /api/admin/*）。M0 は即時バックアップだけ */
  admin: { backup: () => { date: string; path: string } };
  assets?: StaticAssets | undefined;
  /** 取り込み・判定の API（M1）。無ければ 409 */
  ai?: () => AiDeps | undefined;
  /** ボード系の API（M2）。無ければ 409 */
  planner?: () => PlannerDeps | undefined;
  /** カレンダーと設定の API（M3）。無ければ 409 */
  calendar?: () => CalendarDeps | undefined;
  /**
   * 本人の「操作」の記録（D-076 の作業した日・閉じた後の作業に使う）（phase0-plan 3.3.1、W22）。ブラウザ（クッキー）と turnlane CLI（x-turnlane-client: cli）の
   * 状態を変える API 呼び出しだけを数える。MCP・カレンダーヘルパ・/api/usage は数えない
   */
  recordUserOp?: (at: number) => void;
  /** デスクトップアプリの状態（POST /api/desktop/status）。無ければ作る */
  desktop?: DesktopStatusStore;
  /** 集中モード（D-097）。無ければ 409。キューと件数の集中の表示にも使う */
  focus?: () => FocusService | undefined;
  /** タスクから AI に頼む（D-107）。無ければ 409 */
  launch?: () => LaunchService | undefined;
  /** オンボーディング（M6-18〜M6-20）。無ければ 409 */
  onboarding?: () => OnboardingService | undefined;
  /** 更新確認（M6-12）。無ければ 409 */
  update?: () => UpdateChecker | undefined;
  /** 配置の方式（M6-15）。無ければ 409 */
  install?: () => InstallService | undefined;
  /** Claude の利用枠の受け口（POST /api/limits/claude）。無ければ 409 */
  limits?: () => ClaudeLimitsStore | undefined;
  /** 拡張のルート（ADR 0015）。`/api/ext/<id>/*` に付ける。型付きクライアント（AppType）には入らない */
  extRoutes?: readonly { id: string; app: Hono }[];
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
} as const;

function createApi(deps: AppDeps) {
  const api = createCoreApi(deps);
  // 拡張のルートは本体の API の後に付ける（認証・no-store・操作の記録は本体と同じものを通る）
  for (const r of deps.extRoutes ?? []) api.route(`/ext/${r.id}`, r.app);
  return api;
}

function createCoreApi(deps: AppDeps) {
  return new Hono()
    .use("*", apiAuth(deps.token, deps.port))
    .use("*", async (c, next) => {
      await next();
      c.header("cache-control", "no-store");
    })
    .use("*", async (c, next) => {
      await next();
      if (!deps.recordUserOp || SAFE.has(c.req.method) || c.res.status >= 400) return;
      if (c.req.path.endsWith("/api/usage")) return;
      const kind = authenticate(c, deps.token);
      const client = c.req.header("x-turnlane-client");
      if (kind === "cookie" || (kind === "bearer" && client === "cli"))
        deps.recordUserOp(Date.now());
    })
    .get("/health", (c) => c.json(deps.health()))
    .get("/events", (c) => deps.hub.handle(c))
    .post("/admin/backup", (c) => c.json(deps.admin.backup()))
    .route(
      "/",
      createAiRoutes(
        () => deps.ai?.(),
        () => deps.hub.desktopClients > 0,
        () => deps.focus?.(),
      ),
    )
    .route(
      "/",
      createFocusRoutes(() => deps.focus?.()),
    )
    .route(
      "/",
      createLaunchRoutes(
        () => deps.launch?.(),
        (c) => authenticate(c, deps.token) === "bearer",
      ),
    )
    .route(
      "/",
      createLimitsRoutes(
        () => deps.limits?.(),
        (c) => authenticate(c, deps.token) === "bearer",
      ),
    )
    .route("/", createDesktopRoutes(deps.hub, deps.desktop ?? { status: null }))
    .route(
      "/",
      createInstallRoutes(() => deps.install?.()),
    )
    .route(
      "/",
      createPlannerRoutes(() => deps.planner?.()),
    )
    .route(
      "/",
      createCalendarRoutes(() => deps.calendar?.()),
    )
    .route(
      "/",
      createOnboardingRoutes(
        () => deps.onboarding?.(),
        () => deps.update?.(),
      ),
    );
}

export function createApp(deps: AppDeps) {
  const assets = deps.assets ?? {};
  const index = assets["/index.html"];

  return new Hono()
    .use("*", hostGuard(deps.port))
    .use("*", async (c, next) => {
      await next();
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
    })
    .get("/auth", (c) => {
      const t = c.req.query("t") ?? "";
      if (!tokenEquals(t, deps.token))
        return c.text("認証に失敗しました。turnlane open で開き直してください。", 401);
      issueCookie(c, deps.token);
      return c.redirect(safeNext(c.req.query("next")), 303);
    })
    .route("/api", createApi(deps))
    .all("/api/*", (c) => c.json({ error: "not_found" }, 404))
    .get("*", (c) => {
      // 静的ファイルにはデータが無いので認証しない。データは /api 経由でだけ取れる
      const hit = assets[c.req.path] ?? (c.req.path === "/" ? index : undefined);
      if (hit) return new Response(Bun.file(hit.file), { headers: { "content-type": hit.type } });
      if (c.req.path.startsWith("/assets/")) return c.text("Not Found", 404);
      // SPA のフォールバック（/board 等のクライアントルート）
      if (index) {
        return new Response(Bun.file(index.file), { headers: { "content-type": index.type } });
      }
      return c.html(PLACEHOLDER_HTML);
    });
}

/** web / cli が hc<AppType> で型付きクライアントを作るための型 */
export type AppType = ReturnType<typeof createApp>;
