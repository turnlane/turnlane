/**
 * 画面の経路（TanStack Router。コードで定義する）。`turnlane open board|queue` の /board・/queue に合わせる。
 * デイビュー（/day）の日付は画面の状態（dayNav）で持つ（null は今日に追従）。
 */
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import type { ComponentType } from "react";
import { WeekBoard } from "./board/WeekBoard.tsx";
import { DayView } from "./day/DayView.tsx";
import { ext } from "./ext/registry.ts";
import { useGlobalKeys } from "./keys/use-keys.ts";
import { OnboardingPage } from "./onboarding/OnboardingPage.tsx";
import { AiPage } from "./routes/AiPage.tsx";
import { DevComponents } from "./routes/DevComponents.tsx";
import { HealthScreen } from "./routes/health.tsx";
import { InboxPage } from "./routes/InboxPage.tsx";
import { QueuePage } from "./routes/QueuePage.tsx";
import { QuickAddPage } from "./routes/QuickAddPage.tsx";
import { SettingsPage } from "./routes/SettingsPage.tsx";
import { TrayPage } from "./routes/TrayPage.tsx";
import { Shell } from "./Shell.tsx";

const root = createRootRoute({ component: () => <Outlet /> });
const shell = createRoute({ getParentRoute: () => root, id: "shell", component: Shell });
const index = createRoute({
  getParentRoute: () => shell,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/board" });
  },
});
const board = createRoute({ getParentRoute: () => shell, path: "/board", component: WeekBoard });
const day = createRoute({ getParentRoute: () => shell, path: "/day", component: DayView });
const queue = createRoute({ getParentRoute: () => shell, path: "/queue", component: QueuePage });
const inbox = createRoute({ getParentRoute: () => shell, path: "/inbox", component: InboxPage });
const aiPage = createRoute({ getParentRoute: () => shell, path: "/ai", component: AiPage });
const settings = createRoute({
  getParentRoute: () => shell,
  path: "/settings",
  component: SettingsPage,
});
const health = createRoute({
  getParentRoute: () => shell,
  path: "/health",
  component: HealthScreen,
});
// 廃止した画面（朝の計画・一日を閉じる・日報。D-192）。古いブックマークと turnlane:// のリンクはボードへ
const retired = ["/morning", "/shutdown", "/daily-note"].map((path) =>
  createRoute({
    getParentRoute: () => root,
    path,
    beforeLoad: () => {
      throw redirect({ to: "/board" });
    },
  }),
);
// オンボーディング（onboarding.md 3章、M6-21）。サイドバーを出さない
const onboarding = createRoute({
  getParentRoute: () => root,
  path: "/onboarding",
  component: OnboardingPage,
});
// デスクトップアプリの小さなウインドウ（desktop-shell.md 4.2・5章）。サイドバーを出さない
const tray = createRoute({ getParentRoute: () => root, path: "/tray", component: TrayPage });
const quickAdd = createRoute({
  getParentRoute: () => root,
  path: "/quick-add",
  component: QuickAddPage,
});
const dev = createRoute({
  getParentRoute: () => root,
  path: "/dev/components",
  component: DevComponents,
});

function extPage(r: { component: ComponentType }) {
  const C = r.component;
  return () => <C />;
}

/** 枠なし（bare）の拡張の画面。サイドバーの枠（AppShell）が置くキーの受け口を置き、拡張の useKeys を効かせる */
function extBarePage(r: { component: ComponentType }) {
  const C = r.component;
  return function ExtBare() {
    useGlobalKeys();
    return <C />;
  };
}

// 拡張の画面（ADR 0015。`/ext/<id>` の下）。公開のビルドでは無い
const extShell = ext.routes
  .filter((r) => r.chrome !== "bare")
  .map((r) => createRoute({ getParentRoute: () => shell, path: r.path, component: extPage(r) }));
const extBare = ext.routes
  .filter((r) => r.chrome === "bare")
  .map((r) => createRoute({ getParentRoute: () => root, path: r.path, component: extBarePage(r) }));

export const router = createRouter({
  routeTree: root.addChildren([
    shell.addChildren([index, board, day, queue, inbox, aiPage, settings, health, ...extShell]),
    ...extBare,
    ...retired,
    onboarding,
    tray,
    quickAdd,
    dev,
  ]),
  defaultPreload: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
