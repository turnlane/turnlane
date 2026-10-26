import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
// 日本語は 400 / 500 だけ同梱する（1 ウェイトで約 4MB。600 は 500 で代用される）
import "@fontsource/noto-sans-jp/400.css";
import "@fontsource/noto-sans-jp/500.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { dispatchKey } from "./keys/use-keys.ts";
import { takePanelParam } from "./lib/desktop.ts";
import { type EditCommand, runEditCommand } from "./lib/editable.ts";
import { openInApp, setAppNavigate } from "./lib/open.ts";
import { setUi } from "./lib/store.ts";
import { router } from "./router.tsx";

setAppNavigate((path) => void router.navigate({ href: path }));
// デスクトップアプリ（Rust）が main ウインドウの画面を移すときに呼ぶ（通知のクリック、turnlane open。desktop-shell.md 4.3）
// `?panel=<workItemId>` は AI 詳細パネルを開く（メニューバーの → / ⌘⏎。D-067）
(window as unknown as { __turnlaneOpen?: (path: string) => void }).__turnlaneOpen = openInApp;
// デスクトップアプリの表示メニュー（⌘1〜⌘3。D-075）。WKWebView ではメニューのキーが先に取るので、Rust から呼ぶ
const VIEW_KEY = { three: "viewThree", week: "viewWeek", day: "viewDay" } as const;
(window as unknown as { __turnlaneView?: (v: keyof typeof VIEW_KEY) => void }).__turnlaneView = (
  v,
) => {
  const id = VIEW_KEY[v];
  if (id) dispatchKey(id);
};
// デスクトップアプリの Edit メニューの取り消し・やり直し（⌘Z・⇧⌘Z）。メニューのキーが先に取るので Rust から呼ぶ（lib/editable.ts）
(window as unknown as { __turnlaneEdit?: (c: EditCommand) => void }).__turnlaneEdit = (c) => {
  if (c === "undo" || c === "redo") runEditCommand(c);
};
{
  const { path, panel, answer } = takePanelParam(
    `${location.pathname}${location.search}${location.hash}`,
  );
  if (panel) {
    history.replaceState(history.state, "", path);
    setUi({ panelWorkItemId: panel, answerFor: answer ? panel : null });
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
