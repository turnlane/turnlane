/**
 * 設定画面（D-083。ux-mvp 4.14）: 左に節の目次（macOS の設定と同様。狭い幅ではプルダウン）と設定の検索。節は
 * `/settings#<節>`（settings-index.ts）で開き、1度に1つの節だけを出す。検索は項目名と説明で絞り、選ぶと該当の節を開いて
 * 項目へスクロールし、少しの間強調する。
 * - 一般: 言語（D-023）・テーマ（D-027）
 * - 計画の目安と稼働日: 計画の目安と稼働日（D-062・D-106、PlanGuideSection）・祝日・日付の区切り・Mac を使っていたとみなす長さ（D-110）
 * - カレンダー: 接続・役割・書き戻し（D-072）
 * - AI の取り込み: 取り込み元・プロファイル・除外（M2-9）・hooks・MCP（D-145）・題名の保存
 * - 自分の番: 種類・猶予・期限
 * - 通知: ブラウザ通知（アプリの中では出さない）・閉じた後の許可待ち（D-052 (2)、文言は D-080・D-105）・デスクトップの通知の状態（D-080）
 * - 朝と夕方: 朝の計画の案内・日報の AI 要約・持ち越し
 * - 開く（D-059。ux-mvp 4.11）/ プロジェクト / キーボード（D-077。D-080 のアコーディオンは外した）
 * - デスクトップアプリ: 状態・ログイン時起動 / データ: バックアップ・書き出し・プライバシー
 * 説明文の側が折り返し、セグメント・ボタンは折り返さない（D-069 (2)）。
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { OpenAppChoice, OpenAppKind, OpenAppsResponse } from "@turnlane/core/web";
import type { NotificationPermission } from "@turnlane/daemon";
import { Search } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { MenuSelect } from "../components/MenuSelect.tsx";
import { type ThemeSetting, usePrefs, useSavePrefs } from "../data/prefs.tsx";
import { useDesktopStatus } from "../data/queries.ts";
import { ext } from "../ext/registry.ts";
import type { LanguageSetting } from "../i18n/index.tsx";
import { type AnyMessageKey, type MessageKey, translate, useI18n, useT } from "../i18n/index.tsx";
import { api, unwrap } from "../lib/api.ts";
import { inDesktop } from "../lib/desktop.ts";
import { isImeKey } from "../lib/ime.ts";
import { KeyboardSection } from "./KeyboardSection.tsx";
import { LaunchSection } from "./LaunchSettings.tsx";
import { PlanGuideSection } from "./PlanGuideSection.tsx";
import {
  AiSummarySection,
  CalendarsSection,
  DayBoundarySection,
  FollowUpSection,
  HolidaysSection,
  NumInput,
  ProjectsSection,
  ScratchDirsSection,
  Segmented,
  SourcesSection,
  StoredDetailSection,
  StoreTitlesSection,
  TurnDetailSection,
  UpdateSettingsRows,
} from "./SettingsSections.tsx";
import {
  SETTINGS_SECTIONS,
  type SettingsHit,
  type SettingsSectionId,
  searchSettings,
  sectionOfHash,
} from "./settings-index.ts";

const tEn = (k: AnyMessageKey) => translate("en", k);

/** 検索で飛んだ項目を探す（データの読み込みを待つため、見つかるまで少しの間試す）。見つけたら中央へ寄せて強調する */
function flashSetting(anchor: string, tries = 30): void {
  const el = document.querySelector<HTMLElement>(`[data-setting="${anchor}"]`);
  if (!el) {
    if (tries > 0) setTimeout(() => flashSetting(anchor, tries - 1), 50);
    return;
  }
  el.scrollIntoView({ block: "center" });
  el.classList.remove("dl-flash");
  void el.offsetWidth;
  el.classList.add("dl-flash");
  setTimeout(() => el.classList.remove("dl-flash"), 1600);
}

export function SettingsPage() {
  const { t } = useI18n();
  const hash = useRouterState({ select: (s) => s.location.hash });
  const section = sectionOfHash(hash);
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const hits = useMemo(() => searchSettings(q, t, tEn), [q, t]);
  const top = useRef<HTMLDivElement>(null);
  const go = (id: SettingsSectionId, anchor?: string) => {
    void nav({ to: "/settings", hash: id });
    if (anchor) flashSetting(anchor);
    else top.current?.scrollIntoView({ block: "start" });
  };
  // 節を変えたら先頭から見せる
  // biome-ignore lint/correctness/useExhaustiveDependencies: 節が変わったときだけ
  useEffect(() => {
    top.current?.scrollIntoView({ block: "start" });
  }, [section]);
  const title = SETTINGS_SECTIONS.find((x) => x.id === section)?.title ?? "settings.nav.general";
  // 拡張の節の見出しの右（ADR 0015）
  const Aside = ext.settingsSections.find((x) => x.key === section)?.titleAside;
  const hitLabel = (h: SettingsHit) => {
    const s = SETTINGS_SECTIONS.find((x) => x.id === h.section);
    return { section: s ? t(s.title) : "", item: h.item ? t(h.item.title) : null };
  };
  const searchBox = (
    <label className="flex h-7 items-center gap-1.5 rounded-card border border-line bg-bg px-2 focus-within:border-accent">
      <Search size={14} strokeWidth={1.75} className="shrink-0 text-fg3" aria-hidden="true" />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (isImeKey(e)) return;
          if (e.key === "Enter" && hits[0]) {
            e.preventDefault();
            go(hits[0].section, hits[0].item?.anchor);
          } else if (e.key === "Escape" && q) {
            e.preventDefault();
            e.stopPropagation();
            setQ("");
          }
        }}
        placeholder={t("settings.search")}
        aria-label={t("settings.search")}
        className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-fg3 focus-visible:outline-none"
        data-testid="settings-search"
      />
    </label>
  );
  const results =
    hits.length === 0 ? (
      <p className="px-2 py-1 text-meta text-fg3">{t("settings.search.none")}</p>
    ) : (
      <ul className="flex flex-col gap-0.5" data-testid="settings-hits">
        {hits.map((h) => {
          const l = hitLabel(h);
          return (
            <li key={`${h.section}:${h.item?.anchor ?? ""}:${h.item?.title ?? ""}`}>
              <button
                type="button"
                className="flex w-full min-w-0 flex-col rounded-chip px-2 py-1 text-left hover:bg-raised"
                onClick={() => go(h.section, h.item?.anchor)}
              >
                <span className="truncate text-body">{l.item ?? l.section}</span>
                {l.item ? <span className="truncate text-fg3 text-meta">{l.section}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    );
  return (
    <div className="@container" ref={top}>
      <div className="mx-auto flex max-w-[960px] flex-col gap-4 px-6 py-6 @min-[720px]:flex-row @min-[720px]:gap-8">
        {/* 目次と検索（広い幅は左の列、狭い幅は上にプルダウン） */}
        <nav
          aria-label={t("settings.nav.label")}
          className="flex shrink-0 flex-col gap-3 @min-[720px]:sticky @min-[720px]:top-6 @min-[720px]:w-[200px] @min-[720px]:self-start"
          data-testid="settings-nav"
        >
          <div className="font-semibold text-section">{t("settings.title")}</div>
          {searchBox}
          {q.trim() ? (
            results
          ) : (
            <>
              <ul className="hidden flex-col gap-0.5 @min-[720px]:flex">
                {SETTINGS_SECTIONS.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      aria-current={s.id === section ? "page" : undefined}
                      className={`w-full truncate rounded-chip px-2 py-1 text-left text-body ${
                        s.id === section
                          ? "bg-raised font-medium text-fg"
                          : "text-fg2 hover:bg-raised"
                      }`}
                      onClick={() => go(s.id)}
                      data-section={s.id}
                    >
                      {t(s.title)}
                    </button>
                  </li>
                ))}
              </ul>
              <span className="@min-[720px]:hidden">
                <MenuSelect
                  label={t("settings.nav.label")}
                  className="w-full"
                  value={section}
                  onChange={(v) => go(v)}
                  options={SETTINGS_SECTIONS.map((s) => ({ value: s.id, label: t(s.title) }))}
                />
              </span>
            </>
          )}
        </nav>
        <div className="flex min-w-0 max-w-[640px] flex-1 flex-col gap-6" data-pane={section}>
          <div className="flex items-center gap-2">
            <h1 className="font-semibold text-title">{t(title)}</h1>
            {Aside ? <Aside /> : null}
          </div>
          <SettingsPane section={section} />
        </div>
      </div>
    </div>
  );
}

/** 節の中身。既存の項目はすべてどこかの節に入れる（漏れは settings.test.ts で見る） */
export function SettingsPane({ section }: { section: SettingsSectionId }) {
  // 拡張の節（ADR 0015）
  const extSection = ext.settingsSections.find((s) => s.key === section);
  if (extSection) {
    const C = extSection.component;
    return (
      <div className="flex flex-col gap-6" data-ext={extSection.ext}>
        <C />
      </div>
    );
  }
  switch (section) {
    case "general":
      return <GeneralPane />;
    case "time":
      return (
        <>
          <PlanGuideSection />
          <HolidaysSection />
          <DayBoundarySection />
        </>
      );
    case "calendar":
      return <CalendarsSection />;
    case "ai":
      return (
        <>
          <SourcesSection />
          <InfoRow setting="hooks" k="settings.hooks" hintKey="settings.hooks.hint" />
          <InfoRow setting="mcp" k="settings.mcp" hintKey="settings.mcp.hint" />
          <StoreTitlesSection />
          <ScratchDirsSection />
          <LaunchSection />
        </>
      );
    case "turn":
      return (
        <>
          <TurnDetailSection part="turn" />
          <TurnDetailSection part="away" />
          <TurnDetailSection part="answer" />
          <TurnDetailSection part="tmux" />
          <FollowUpSection />
        </>
      );
    case "notify":
      return <NotifyPane />;
    case "record":
      return (
        <>
          <AiSummarySection />
          <InfoRow setting="carry-over" k="settings.carryOver" hintKey="settings.carryOver.hint" />
        </>
      );
    case "open":
      return <OpenWithSection />;
    case "projects":
      return <ProjectsSection />;
    case "keyboard":
      return <KeyboardSection />;
    case "desktop":
      return (
        <>
          <DesktopStatusRow />
          <InfoRow
            setting="desktop-login"
            k="settings.desktop.login"
            hintKey="settings.desktop.login.hint"
          />
        </>
      );
    case "data":
      return (
        <>
          <InfoRow setting="backup" k="settings.data.backup" hintKey="settings.data.backup.hint" />
          <InfoRow setting="export" k="settings.data.export" hintKey="settings.data.export.hint" />
          <InfoRow
            setting="privacy"
            k="settings.data.privacy"
            hintKey="settings.data.privacy.hint"
          />
          <StoredDetailSection />
        </>
      );
  }
}

/** 説明だけの行（操作は CLI。値を持たない） */
function InfoRow({ setting, k, hintKey }: { setting: string; k: MessageKey; hintKey: MessageKey }) {
  const t = useT();
  return (
    <section className="flex flex-col" data-setting={setting}>
      <h2 className="text-section">{t(k)}</h2>
      <p className="text-meta text-fg3">{t(hintKey)}</p>
    </section>
  );
}

function SettingRow({
  setting,
  title,
  hint,
  children,
  className = "",
}: {
  setting: string;
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`flex items-center justify-between gap-4 ${className}`}
      data-setting={setting}
    >
      <div className="min-w-0">
        <h2 className="text-section">{title}</h2>
        {hint ? <p className="text-meta text-fg3">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function GeneralPane() {
  const t = useT();
  const prefs = usePrefs();
  const save = useSavePrefs();
  const themes: { v: ThemeSetting; k: MessageKey }[] = [
    { v: "system", k: "settings.theme.system" },
    { v: "light", k: "settings.theme.light" },
    { v: "dark", k: "settings.theme.dark" },
  ];
  const langs: { v: LanguageSetting; label: string }[] = [
    { v: "system", label: t("settings.language.system") },
    // 言語名はその言語で書く
    { v: "en", label: "English" },
    { v: "ja", label: "日本語" },
  ];
  return (
    <>
      <SettingRow setting="language" title={t("settings.language")}>
        <Segmented
          label={t("settings.language")}
          value={prefs.language}
          options={langs}
          onChange={(v) => save.mutate({ language: v })}
        />
      </SettingRow>
      <SettingRow setting="theme" title={t("settings.theme")}>
        <Segmented
          label={t("settings.theme")}
          value={prefs.theme}
          options={themes.map((x) => ({ v: x.v, label: t(x.k) }))}
          onChange={(v) => save.mutate({ theme: v })}
        />
      </SettingRow>
      <UpdateSettingsRows />
    </>
  );
}

function NotifyPane() {
  const t = useT();
  const prefs = usePrefs();
  const save = useSavePrefs();
  const [perm, setPerm] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "denied",
  );
  return (
    <>
      <SettingRow
        setting="browser-notifications"
        title={t("settings.notifications.browser")}
        className={inDesktop() ? "hidden" : ""}
      >
        {perm === "granted" ? (
          <span className="text-body text-fg2">{t("settings.notifications.on")}</span>
        ) : perm === "denied" ? (
          <span className="text-body text-fg2">{t("settings.notifications.denied")}</span>
        ) : (
          <button
            type="button"
            className="h-7 rounded-card border border-line px-3 text-body hover:border-fg3"
            onClick={() => void Notification.requestPermission().then(setPerm)}
          >
            {t("settings.notifications.enable")}
          </button>
        )}
      </SettingRow>
      <DesktopNotificationsRow />
      <TurnDetailSection part="notify" />
      <FocusRows />
    </>
  );
}

/** 集中モード（D-097。ux-mvp 4.15）: 会議の前に聞く・対象の予定・何分前・答えなければ自動で集中・集中中も許可待ちは通知・集中の終わりを知らせる */
function FocusRows() {
  const t = useT();
  const prefs = usePrefs();
  const save = useSavePrefs();
  const onOff = [
    { v: "off" as const, label: t("settings.off") },
    { v: "on" as const, label: t("settings.on") },
  ];
  return (
    <>
      <SettingRow
        setting="focus-prompt"
        title={t("settings.focus.prompt")}
        hint={t("settings.focus.prompt.hint")}
      >
        <Segmented
          label={t("settings.focus.prompt")}
          value={prefs.focusPrompt ? "on" : "off"}
          options={onOff}
          onChange={(v) => save.mutate({ focusPrompt: v === "on" })}
        />
      </SettingRow>
      <SettingRow
        setting="focus-target"
        title={t("settings.focus.target")}
        hint={t("settings.focus.target.hint")}
      >
        <Segmented
          label={t("settings.focus.target")}
          value={prefs.focusTarget}
          options={[
            { v: "meetings", label: t("settings.focus.target.meetings") },
            { v: "busy", label: t("settings.focus.target.busy") },
          ]}
          onChange={(v) => save.mutate({ focusTarget: v })}
        />
      </SettingRow>
      <SettingRow setting="focus-lead" title={t("settings.focus.lead")}>
        <NumInput
          value={prefs.focusLeadMin}
          min={1}
          max={30}
          label={t("settings.focus.lead")}
          unit={t("settings.unit.min")}
          onCommit={(v) => save.mutate({ focusLeadMin: v })}
        />
      </SettingRow>
      <SettingRow
        setting="focus-auto"
        title={t("settings.focus.auto")}
        hint={t("settings.focus.auto.hint")}
      >
        <Segmented
          label={t("settings.focus.auto")}
          value={prefs.focusAuto ? "on" : "off"}
          options={onOff}
          onChange={(v) => save.mutate({ focusAuto: v === "on" })}
        />
      </SettingRow>
      <SettingRow
        setting="focus-needs-input"
        title={t("settings.focus.allowNeedsInput")}
        hint={t("settings.focus.allowNeedsInput.hint")}
      >
        <Segmented
          label={t("settings.focus.allowNeedsInput")}
          value={prefs.focusAllowNeedsInput ? "on" : "off"}
          options={onOff}
          onChange={(v) => save.mutate({ focusAllowNeedsInput: v === "on" })}
        />
      </SettingRow>
      <SettingRow
        setting="focus-notify-end"
        title={t("settings.focus.notifyEnd")}
        hint={t("settings.focus.notifyEnd.hint")}
      >
        <Segmented
          label={t("settings.focus.notifyEnd")}
          value={prefs.focusNotifyEnd ? "on" : "off"}
          options={onOff}
          onChange={(v) => save.mutate({ focusNotifyEnd: v === "on" })}
        />
      </SettingRow>
    </>
  );
}

/** デスクトップアプリの状態（起動中ならバージョン。D-083） */
function DesktopStatusRow() {
  const t = useT();
  const st = useDesktopStatus().data;
  return (
    <section className="flex flex-col" data-setting="desktop-status" data-testid="desktop-status">
      <h2 className="text-section">{t("settings.desktop.status")}</h2>
      <p className="text-body text-fg2">
        {st?.connected && st.app
          ? t("settings.desktop.running", { version: st.app.version })
          : t("settings.desktop.notConnected")}
      </p>
    </section>
  );
}

/** デスクトップアプリの通知の許可 → 表示の文言とボタン（D-080: 生の値を出さない） */
export function desktopNotificationView(state: NotificationPermission): {
  text: MessageKey;
  action: { kind: "request" | "open_settings"; label: MessageKey } | null;
} {
  switch (state) {
    case "granted":
      return { text: "settings.desktop.notifications.granted", action: null };
    case "denied":
      return {
        text: "settings.desktop.notifications.denied",
        action: { kind: "open_settings", label: "settings.desktop.notifications.openSettings" },
      };
    case "not_determined":
      return {
        text: "settings.desktop.notifications.notDetermined",
        action: { kind: "request", label: "settings.desktop.notifications.request" },
      };
    case "unsupported":
      return { text: "settings.desktop.notifications.unsupported", action: null };
    default:
      return { text: "settings.desktop.notifications.unknown", action: null };
  }
}

/**
 * デスクトップの通知（通知の節。D-083）。アプリがつながっていなければ「起動していません」。
 * 通知の許可は「オン / オフ / 未設定」で出し、オフは「システム設定を開く」、未設定は「許可を求める」（D-080）。
 * ボタンはデーモン経由でアプリに渡し、アプリが固定の処理（OS の許可の要求・システム設定の通知の画面）を行う
 */
function DesktopNotificationsRow() {
  const t = useT();
  const qc = useQueryClient();
  const st = useDesktopStatus().data;
  const [failed, setFailed] = useState(false);
  if (!st?.connected || !st.app)
    return (
      <section className="flex flex-col" data-setting="desktop-notifications">
        <h2 className="text-section">{t("settings.desktop.notificationsTitle")}</h2>
        <p className="text-body text-fg3">{t("settings.desktop.notConnected")}</p>
      </section>
    );
  const view = desktopNotificationView(st.app.notifications);
  const run = async (action: "request" | "open_settings") => {
    setFailed(false);
    try {
      const r = await unwrap<{ delivered: boolean }>(
        api.api.desktop.notifications.$post({ json: { action } }),
      );
      if (!r.delivered) setFailed(true);
    } catch {
      setFailed(true);
    }
    // アプリが状態を読み直して送るまで少し待つ（desktop_status の SSE でも取り直す）
    setTimeout(() => void qc.invalidateQueries({ queryKey: ["desktop"] }), 1000);
  };
  return (
    <section
      className="flex items-center justify-between gap-4"
      data-testid="desktop-section"
      data-setting="desktop-notifications"
    >
      <div className="min-w-0">
        <h2 className="text-section">{t("settings.desktop.notificationsTitle")}</h2>
        <p className="text-body text-fg2" data-testid="desktop-notifications">
          {t(view.text)}
        </p>
        {failed ? (
          <p className="text-error text-meta">{t("settings.desktop.notifications.failed")}</p>
        ) : null}
      </div>
      {view.action ? (
        <button
          type="button"
          className="h-7 shrink-0 rounded-card border border-line px-3 text-body hover:border-fg3"
          onClick={() => void run(view.action?.kind ?? "request")}
        >
          {t(view.action.label)}
        </button>
      ) : null}
    </section>
  );
}

const APP_NAMES: Record<string, string> = {
  zed: "Zed",
  cursor: "Cursor",
  vscode: "VS Code",
  sublime: "Sublime Text",
  ghostty: "Ghostty",
  warp: "Warp",
  iterm: "iTerm2",
  terminal: "Terminal",
  orca: "Orca",
  github_desktop: "GitHub Desktop",
  fork: "Fork",
  tower: "Tower",
};

/** 開くアプリ（D-059）。選べるのはインストール済みのものだけ。設定のアプリが無ければ「（未インストール）」で残す */
function OpenWithSection() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["open-apps"],
    queryFn: () => unwrap<OpenAppsResponse>(api.api.open.apps.$get()),
  });
  const [err, setErr] = useState(false);
  if (!q.data) return null;
  const save = async (kind: OpenAppKind, id: string) => {
    setErr(false);
    try {
      await unwrap(
        api.api.config[":key"].$put({ param: { key: `open.${kind}` }, json: { value: id } }),
      );
    } catch {
      setErr(true);
    }
    void qc.invalidateQueries({ queryKey: ["open-apps"] });
    void qc.invalidateQueries({ queryKey: ["open-options"] });
  };
  const row = (kind: OpenAppKind, c: OpenAppChoice) => {
    const missing = !c.installed.some((a) => a.id === c.selected);
    return (
      <div key={kind} className="flex items-center justify-between gap-4">
        <h3 className="text-body">{t(`settings.openWith.${kind}`)}</h3>
        {c.installed.length === 0 ? (
          <span className="text-body text-fg3">
            {kind === "diff" ? t("settings.openWith.noDiff") : t("common.none")}
          </span>
        ) : (
          <MenuSelect
            label={t(`settings.openWith.${kind}`)}
            className="w-48"
            testId={`settings-open-with-${kind}`}
            value={c.selected}
            onChange={(v) => void save(kind, v)}
            // 入っていないアプリが選ばれているときは、その旨をボタンに出す（選択肢には入れない）
            {...(missing
              ? {
                  display: (
                    <span className="min-w-0 flex-1 truncate text-fg2">
                      {t("settings.openWith.notInstalled", {
                        app: APP_NAMES[c.selected] ?? c.selected,
                      })}
                    </span>
                  ),
                }
              : {})}
            options={c.installed.map((a) => ({ value: a.id, label: a.name }))}
          />
        )}
      </div>
    );
  };
  return (
    <section
      className="flex flex-col gap-2"
      data-testid="settings-open-with"
      data-setting="open-with"
    >
      <div>
        <h2 className="text-section">{t("settings.openWith")}</h2>
        <p className={`text-meta ${err ? "text-error" : "text-fg3"}`}>
          {t("settings.openWith.hint")}
        </p>
      </div>
      {row("editor", q.data.editor)}
      {row("terminal", q.data.terminal)}
      {row("diff", q.data.diff)}
    </section>
  );
}
