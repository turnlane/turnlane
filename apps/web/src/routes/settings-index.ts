/**
 * 設定画面の節と項目の目録（D-083。ux-mvp 4.14）。左の目次・検索・`/settings#<節>` のリンクはここから作る。
 * 各項目の anchor は画面の `data-setting="<anchor>"`（検索で飛んだ先の強調に使う）。項目が複数の行を持つ部品の中に
 * あるときは、部品の anchor を共有する。目録と画面の data-setting が一致することはテスト（settings.test.ts）で見る
 */
import { ext } from "../ext/registry.ts";
import type { AnyMessageKey } from "../i18n/index.tsx";

export const SETTINGS_SECTION_IDS = [
  "general",
  "time",
  "calendar",
  "ai",
  "turn",
  "notify",
  "record",
  "open",
  "projects",
  "keyboard",
  "desktop",
  "data",
] as const;
/** 本体の節と、拡張の節（ADR 0015。`ext-<拡張の id>-<節の id>`） */
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number] | `ext-${string}`;

export interface SettingItem {
  /** 画面の data-setting の値 */
  anchor: string;
  title: AnyMessageKey;
  hint?: AnyMessageKey;
}

export interface SettingsSection {
  id: SettingsSectionId;
  title: AnyMessageKey;
  items: SettingItem[];
}

const CORE_SECTIONS: SettingsSection[] = [
  {
    id: "general",
    title: "settings.nav.general",
    items: [
      { anchor: "language", title: "settings.language" },
      { anchor: "theme", title: "settings.theme" },
    ],
  },
  {
    id: "time",
    title: "settings.nav.time",
    items: [
      { anchor: "plan-guide", title: "settings.planGuide", hint: "settings.planGuide.hint" },
      { anchor: "plan-guide", title: "settings.planGuide.workday" },
      { anchor: "holidays", title: "settings.holidays", hint: "settings.holidays.hint" },
      { anchor: "day-boundary", title: "settings.dayBoundary", hint: "settings.dayBoundary.hint" },
      {
        anchor: "presence-tail",
        title: "settings.presenceTail",
        hint: "settings.presenceTail.hint",
      },
    ],
  },
  {
    id: "calendar",
    title: "settings.nav.calendar",
    items: [
      { anchor: "calendars", title: "settings.calendars", hint: "settings.calendars.hint" },
      { anchor: "events", title: "settings.events.title", hint: "settings.events.hint" },
      { anchor: "timeblocks", title: "settings.timeblocks.title" },
    ],
  },
  {
    id: "ai",
    title: "settings.nav.ai",
    items: [
      { anchor: "sources", title: "settings.sources", hint: "settings.sources.hint" },
      { anchor: "hooks", title: "settings.hooks", hint: "settings.hooks.hint" },
      { anchor: "mcp", title: "settings.mcp", hint: "settings.mcp.hint" },
      { anchor: "sources", title: "settings.sources.exclude" },
      { anchor: "store-titles", title: "settings.privacy", hint: "settings.privacy.hint" },
      { anchor: "scratch-dirs", title: "settings.scratchDirs", hint: "settings.scratchDirs.hint" },
      { anchor: "launch", title: "settings.launch", hint: "settings.launch.hint" },
      {
        anchor: "launch",
        title: "settings.launch.worktreeDir",
        hint: "settings.launch.worktreeDir.hint",
      },
      { anchor: "launch", title: "settings.launch.templates" },
      {
        anchor: "launch-finish",
        title: "settings.launch.finish",
        hint: "settings.launch.finish.hint",
      },
    ],
  },
  {
    id: "turn",
    title: "settings.nav.turn",
    items: [
      {
        anchor: "turn-show-detail",
        title: "settings.turn.showDetail",
        hint: "settings.turn.showDetail.hint",
      },
      {
        anchor: "turn-away-summary",
        title: "settings.turn.awaySummary",
        hint: "settings.turn.awaySummary.hint",
      },
      { anchor: "turn-answer", title: "settings.turn.answer", hint: "settings.turn.answer.hint" },
      {
        anchor: "launch-tmux-wrap",
        title: "settings.turn.tmuxWrap",
        hint: "settings.turn.tmuxWrap.hint",
      },
      { anchor: "follow-up-kinds", title: "settings.followUps", hint: "settings.followUps.hint" },
      { anchor: "follow-up-kinds", title: "settings.followUps.kind.approve" },
      { anchor: "follow-up-kinds", title: "settings.followUps.kind.reply" },
      { anchor: "follow-up-kinds", title: "settings.followUps.kind.review_pr" },
      { anchor: "follow-up-kinds", title: "settings.followUps.kind.resume_error" },
      { anchor: "follow-up-kinds", title: "settings.followUps.kind.check_changes" },
      { anchor: "grace", title: "settings.followUps.grace", hint: "settings.followUps.grace.hint" },
      {
        anchor: "reply-expire",
        title: "settings.followUps.replyExpire",
        hint: "settings.followUps.replyExpire.hint",
      },
      {
        anchor: "non-git-expire",
        title: "settings.followUps.nonGitExpire",
        hint: "settings.followUps.nonGitExpire.hint",
      },
    ],
  },
  {
    id: "notify",
    title: "settings.nav.notify",
    items: [
      { anchor: "browser-notifications", title: "settings.notifications.browser" },
      { anchor: "desktop-notifications", title: "settings.desktop.notificationsTitle" },
      {
        anchor: "notify-content",
        title: "settings.notify.content",
        hint: "settings.notify.content.hint",
      },
      // 集中モード（D-097）
      {
        anchor: "focus-prompt",
        title: "settings.focus.prompt",
        hint: "settings.focus.prompt.hint",
      },
      {
        anchor: "focus-target",
        title: "settings.focus.target",
        hint: "settings.focus.target.hint",
      },
      { anchor: "focus-lead", title: "settings.focus.lead" },
      { anchor: "focus-auto", title: "settings.focus.auto", hint: "settings.focus.auto.hint" },
      {
        anchor: "focus-needs-input",
        title: "settings.focus.allowNeedsInput",
        hint: "settings.focus.allowNeedsInput.hint",
      },
      {
        anchor: "focus-notify-end",
        title: "settings.focus.notifyEnd",
        hint: "settings.focus.notifyEnd.hint",
      },
    ],
  },
  {
    id: "record",
    title: "settings.nav.record",
    items: [
      { anchor: "ai-summary", title: "settings.aiSummary" },
      { anchor: "carry-over", title: "settings.carryOver", hint: "settings.carryOver.hint" },
    ],
  },
  {
    id: "open",
    title: "settings.nav.open",
    items: [
      { anchor: "open-with", title: "settings.openWith", hint: "settings.openWith.hint" },
      { anchor: "open-with", title: "settings.openWith.editor" },
      { anchor: "open-with", title: "settings.openWith.terminal" },
      { anchor: "open-with", title: "settings.openWith.diff" },
    ],
  },
  {
    id: "projects",
    title: "settings.nav.projects",
    items: [
      { anchor: "projects", title: "settings.projects", hint: "settings.projects.hint" },
      {
        anchor: "projects",
        title: "settings.projects.testCommand",
        hint: "settings.projects.testCommand.hint",
      },
      { anchor: "projects", title: "settings.projects.worktree" },
      {
        anchor: "projects",
        title: "settings.projects.copyGlobs",
        hint: "settings.projects.copyGlobs.hint",
      },
    ],
  },
  {
    id: "keyboard",
    title: "settings.nav.keyboard",
    items: [
      { anchor: "keyboard", title: "settings.keyboard", hint: "settings.keyboard.hint" },
      { anchor: "keyboard", title: "settings.desktop.shortcut" },
    ],
  },
  {
    id: "desktop",
    title: "settings.nav.desktop",
    items: [
      { anchor: "desktop-status", title: "settings.desktop.status" },
      {
        anchor: "desktop-login",
        title: "settings.desktop.login",
        hint: "settings.desktop.login.hint",
      },
    ],
  },
  {
    id: "data",
    title: "settings.nav.data",
    items: [
      { anchor: "backup", title: "settings.data.backup", hint: "settings.data.backup.hint" },
      { anchor: "export", title: "settings.data.export", hint: "settings.data.export.hint" },
      { anchor: "privacy", title: "settings.data.privacy", hint: "settings.data.privacy.hint" },
      {
        anchor: "stored-detail",
        title: "settings.data.storeDetail",
        hint: "settings.data.storeDetail.hint",
      },
    ],
  },
];

/** 拡張の節（ADR 0015）は「データ」の前に入れる。公開のビルドでは本体の節だけ */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  ...CORE_SECTIONS.filter((s) => s.id !== "data"),
  ...ext.settingsSections.map((s) => ({ id: s.key, title: s.title, items: s.items ?? [] })),
  ...CORE_SECTIONS.filter((s) => s.id === "data"),
];

/** `/settings#<節>` のハッシュ → 節（知らない値・空は一般） */
export function sectionOfHash(hash: string | undefined | null): SettingsSectionId {
  const h = (hash ?? "").replace(/^#/, "");
  return SETTINGS_SECTIONS.some((s) => s.id === h) ? (h as SettingsSectionId) : "general";
}

export interface SettingsHit {
  section: SettingsSectionId;
  /** 節の名前に当たったときは null（節の先頭へ） */
  item: SettingItem | null;
}

type T = (k: AnyMessageKey) => string;

/**
 * 設定の検索: 項目名と説明（表示中の言語と英語）を、空白で区切った語のすべてが含まれるかで絞る（大文字小文字を区別しない）。
 * 節の名前に当たれば節ごと出す。並びは節の順、節の中は目録の順。同じ anchor の重複は1つにまとめる
 */
export function searchSettings(q: string, t: T, tEn: T): SettingsHit[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hit = (keys: (AnyMessageKey | undefined)[]) => {
    const text = keys
      .flatMap((k) => (k ? [t(k), tEn(k)] : []))
      .join(" ")
      .toLowerCase();
    return words.every((w) => text.includes(w));
  };
  const out: SettingsHit[] = [];
  for (const s of SETTINGS_SECTIONS) {
    if (hit([s.title])) out.push({ section: s.id, item: null });
    const seen = new Set<string>();
    for (const it of s.items) {
      if (!hit([it.title, it.hint]) || seen.has(it.anchor)) continue;
      seen.add(it.anchor);
      out.push({ section: s.id, item: it });
    }
  }
  return out;
}
