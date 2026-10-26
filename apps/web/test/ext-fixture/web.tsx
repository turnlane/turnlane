/**
 * テスト用の拡張（Web 側。ADR 0015）。拡張点がつながることだけを確かめる（中身は無い）。
 * 実行時に import するのは `@turnlane/ext-host` と react だけ（拡張のリポジトリと同じ書き方）
 */
import {
  Button,
  extApi,
  Icon,
  LaunchRow,
  navigate,
  openAi,
  openAiPanel,
  SidebarNotice,
  StatusIcon,
  Switch,
  TodayNotice,
  TrayRow,
  toast,
  useExtQuery,
  useKeys,
  useT,
} from "@turnlane/ext-host";
import { useState } from "react";
import type {
  LaunchFieldProps,
  TimelineMark,
  TimelineRange,
  WebExtension,
} from "../../src/ext/types.ts";

const ID = "test";

function SettingsSection() {
  const t = useT();
  const q = useExtQuery<{ pong: boolean; count: number }>(ID, "/ping");
  return (
    <section className="flex flex-col gap-2" data-setting="ext-test-ping">
      <h2 className="text-section">{t("ext.test.settings.ping")}</h2>
      <p className="text-meta text-fg3" data-testid="ext-test-ping">
        {q.data ? t("ext.test.settings.count", { count: q.data.count }) : t("ext.test.loading")}
      </p>
    </section>
  );
}

/** キーで選ぶ・並べ替える・外す一覧（j/k・⌘↑↓・⌫）。並びを data-order に出す */
function KeyList({ testId }: { testId: string }) {
  const [items, setItems] = useState(["a", "b", "c"]);
  const [sel, setSel] = useState(0);
  const swap = (d: -1 | 1) => {
    const j = sel + d;
    if (j < 0 || j >= items.length) return true;
    const xs = [...items];
    [xs[sel], xs[j]] = [xs[j] as string, xs[sel] as string];
    setItems(xs);
    setSel(j);
    return true;
  };
  useKeys({
    next: () => {
      setSel((i) => Math.min(i + 1, items.length - 1));
      return true;
    },
    prev: () => {
      setSel((i) => Math.max(i - 1, 0));
      return true;
    },
    reorderUp: () => swap(-1),
    reorderDown: () => swap(1),
    remove: () => {
      setItems(items.filter((_, i) => i !== sel));
      setSel((i) => Math.max(0, Math.min(i, items.length - 2)));
      return true;
    },
  });
  return (
    <ul data-testid={testId} data-order={items.join("")} data-sel={items[sel] ?? ""}>
      {items.map((x, i) => (
        <li key={x} className={i === sel ? "text-body font-medium" : "text-body text-fg3"}>
          {x}
        </li>
      ))}
    </ul>
  );
}

/** 今日の列の先頭行の知らせ（押すと拡張の画面。D-192） */
function TodayItem() {
  const t = useT();
  return (
    <TodayNotice
      text={t("ext.test.today")}
      tone="needs"
      icon="moon"
      to="/ext/test"
      testId="ext-test-today"
    />
  );
}

/** サイドバーの下の1行（押すと拡張の画面） */
function SidebarItem() {
  const t = useT();
  return (
    <SidebarNotice
      text={t("ext.test.sidebar")}
      detail={t("ext.test.sidebar.detail")}
      tone="running"
      icon="pause"
      to="/ext/test"
      testId="ext-test-sidebar"
    />
  );
}

/** メニューバーのポップオーバーの1行 */
function TrayItem() {
  const t = useT();
  return (
    <TrayRow
      text={t("ext.test.tray")}
      meta="2/5"
      tone="running"
      to="/ext/test"
      testId="ext-test-tray"
    />
  );
}

function Panel() {
  const t = useT();
  return (
    <p className="text-meta text-fg3" data-testid="ext-test-panel">
      {t("ext.test.panel")}
    </p>
  );
}

function LaunchField({ value, onChange }: LaunchFieldProps) {
  const t = useT();
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 text-body">
      <span className="min-w-0 flex-1 truncate">{t("ext.test.launch.later")}</span>
      <Switch
        on={value === true}
        onChange={(v) => onChange(v)}
        label={t("ext.test.launch.later")}
        testId="ext-test-later"
      />
    </span>
  );
}

/** 行を自分で並べる欄（layout: "rows"）: オンにすると行が1つ増える */
function RowsField({ value, onChange }: LaunchFieldProps) {
  const t = useT();
  return (
    <>
      <LaunchRow label={t("ext.test.rows")}>
        <Switch
          on={value === true}
          onChange={(v) => onChange(v)}
          label={t("ext.test.rows")}
          testId="ext-test-rows"
        />
      </LaunchRow>
      {value === true ? (
        <LaunchRow label={t("ext.test.rows.extra")}>
          <span className="text-body" data-testid="ext-test-rows-extra">
            {t("ext.test.rows.extra")}
          </span>
        </LaunchRow>
      ) : null}
    </>
  );
}

/** 時間軸の印: 範囲の終わりの4時間前（30分に丸め）に30分の印を1つ。押すと未完了のタスクのパネル */
function useMarks(range: TimelineRange): TimelineMark[] {
  const t = useT();
  const q = useExtQuery<{ at: number; taskId: string | null }>(
    ID,
    `/marks?from=${range.from}&to=${range.to}`,
  );
  if (!q.data) return [];
  return [
    {
      id: "mark",
      at: q.data.at,
      end: q.data.at + 30 * 60_000,
      title: t("ext.test.mark"),
      detail: t("ext.test.mark.detail"),
      ...(q.data.taskId ? { taskId: q.data.taskId } : {}),
    },
  ];
}

/** 本体の画面の移動・AI の詳細パネル・本体の開き方（`?wi=<workItemId>` の AI を対象にする） */
function OpenButtons() {
  const wi = new URLSearchParams(location.search).get("wi") ?? "";
  return (
    <div className="flex gap-2">
      <Button onClick={() => navigate("/inbox")} data-testid="ext-test-nav">
        <Icon name="external-link" size={14} />
        Inbox
      </Button>
      <Button onClick={() => openAiPanel(wi)} data-testid="ext-test-panel-open">
        <Icon name="panel-right" size={14} />
        Panel
      </Button>
      <Button onClick={() => void openAi(wi, "session")} data-testid="ext-test-open-ai">
        <Icon name="square-terminal" size={14} />
        Terminal
      </Button>
    </div>
  );
}

function Page() {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 p-6 text-body" data-testid="ext-test-page">
      {t("ext.test.page")}
      <span className="flex gap-2" data-testid="ext-test-icons">
        <StatusIcon status="running" />
        <StatusIcon status="needs_input" />
        <Icon name="circle-pause" />
      </span>
      <OpenButtons />
      <KeyList testId="ext-test-list" />
    </div>
  );
}

/** 枠なしの画面（chrome: bare）でもキーが届く */
function BarePage() {
  return (
    <div className="flex flex-col gap-3 p-6 text-body" data-testid="ext-test-bare">
      <OpenButtons />
      <KeyList testId="ext-test-bare-list" />
    </div>
  );
}

const ext: WebExtension = {
  id: ID,
  apiVersion: 2,
  i18n: {
    en: {
      "ext.test.nav": "Test extension",
      "ext.test.origin": "Test list",
      "ext.test.origin.primary": "Open the test list",
      "ext.test.today": "Test extension · 2 to review",
      "ext.test.loading": "Loading",
      "ext.test.settings.ping": "Ping",
      "ext.test.settings.count": { one: "{count} ping", other: "{count} pings" },
      "ext.test.menu": "Test action",
      "ext.test.menu.done": "Test action ran",
      "ext.test.panel": "Panel section from the test extension",
      "ext.test.palette": "Run test command",
      "ext.test.palette.done": "Test command ran",
      "ext.test.launch": "Test",
      "ext.test.launch.later": "Hold for later",
      "ext.test.launch.held": "Held by the test extension",
      "ext.test.page": "Test extension page",
      "ext.test.rows": "Rows",
      "ext.test.rows.extra": "Extra row",
      "ext.test.mark": "Planned: test",
      "ext.test.mark.detail": "repo · test",
      "ext.test.sidebar": "Test extension · 2 of 5 running",
      "ext.test.sidebar.detail": "A line added by the test extension",
      "ext.test.tray": "Test extension · running",
      "ext.test.title": "Test page",
    },
    ja: {
      "ext.test.nav": "テスト用の拡張",
      "ext.test.origin": "テストの一覧",
      "ext.test.settings.ping": "Ping",
      "ext.test.settings.count": "{count} 回",
      "ext.test.today": "テスト用の拡張 · 確かめる 2 件",
    },
  },
  routes: [
    {
      path: "/ext/test",
      component: Page,
      title: "ext.test.title",
      titleAside: () => <span data-testid="ext-test-title-aside">T</span>,
    },
    { path: "/ext/test/bare", component: BarePage, chrome: "bare" },
  ],
  settingsSections: [
    {
      id: "main",
      title: "ext.test.nav",
      items: [{ anchor: "ext-test-ping", title: "ext.test.settings.ping" }],
      component: SettingsSection,
      titleAside: () => <span data-testid="ext-test-aside">T</span>,
    },
  ],
  sidebarItems: [{ id: "notice", component: SidebarItem }],
  trayItems: [{ id: "row", component: TrayItem }],
  todayNotices: [{ id: "today", component: TodayItem }],
  taskMenuItems: [
    {
      id: "action",
      label: "ext.test.menu",
      run: (task) => {
        void extApi(ID)
          .get("/ping")
          .then(() => toast(`${task.id}: ok`));
      },
    },
  ],
  panelSections: [{ id: "panel", component: Panel }],
  paletteCommands: [
    {
      id: "cmd",
      label: "ext.test.palette",
      run: () => toast("ext-test-palette"),
    },
  ],
  launchFields: [
    {
      id: "later",
      label: "ext.test.launch",
      component: LaunchField,
      intercept: ({ value }) => {
        if (value !== true) return false;
        toast("ext-test-held");
        return true;
      },
    },
    { id: "rows", label: "ext.test.rows", layout: "rows", component: RowsField },
  ],
  // 拡張が作ったタスク（デーモンの POST /api/ext/test/tasks）の出どころ
  taskOrigins: [
    {
      source: "ext.test",
      label: "ext.test.origin",
      to: "/ext/test",
      // 詳細パネルの主ボタン（D-192 §5.4 (3)）
      primary: "ext.test.origin.primary",
    },
  ],
  timelineMarks: useMarks,
};

export default ext;
