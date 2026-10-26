/**
 * 設定画面の純粋な部分:
 * - 節分け（D-083。ux-mvp 4.14）: 節の目録（settings-index.ts）と画面の data-setting が一致すること、既存の項目がすべてどこかの
 *   節に入っていること（漏れの一覧）、検索、`/settings#<節>` のリンク
 * - デスクトップアプリの通知の表示と、⌘K からキーボードの節へ（D-080。アコーディオンは D-083 で外した）
 * - 「Holidays from」のまとめ表示（M2-9・D-057 (2)）、選択の欄は OS の select でなくメニューのボタン（D-138）
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageKey } from "../src/i18n/en.ts";
import { en } from "../src/i18n/en.ts";
import type { AnyMessageKey } from "../src/i18n/index.tsx";
import { makeI18n, translate } from "../src/i18n/index.tsx";
import { ja } from "../src/i18n/ja.ts";
import { type BuildInput, buildSections, flatRows } from "../src/palette/model.ts";
import { desktopNotificationView } from "../src/routes/SettingsPage.tsx";
import { holidaySummary } from "../src/routes/SettingsSections.tsx";
import {
  SETTINGS_SECTION_IDS,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  searchSettings,
  sectionOfHash,
} from "../src/routes/settings-index.ts";

const src = (f: string) => readFileSync(join(import.meta.dir, "../src", f), "utf8");
const ROUTES = [
  "routes/SettingsPage.tsx",
  "routes/SettingsSections.tsx",
  "routes/PlanGuideSection.tsx",
  "routes/KeyboardSection.tsx",
  "routes/LaunchSettings.tsx",
];
const code = ROUTES.map(src).join("\n");

/** 画面に置いた anchor（data-setting="…" と、Row / InfoRow の setting="…"） */
const anchorsInCode = new Set(
  [...code.matchAll(/(?:data-setting|\bsetting)="([\w-]+)"/g)].map((m) => m[1] as string),
);

/**
 * D-083 より前の設定画面にあった項目（見出しの文言キー）。どれも目録のどこかの節に入っていること。
 * 節分けの後で足した項目（hooks・持ち越し・状態・ログイン時起動・データ）は目録に入っていればよい
 */
const LEGACY_ITEMS: MessageKey[] = [
  "settings.theme",
  "settings.language",
  "settings.sources",
  "settings.sources.exclude",
  "settings.planGuide",
  "settings.planGuide.workday",
  "settings.holidays",
  "settings.dayBoundary",
  "settings.presenceTail",
  "settings.calendars",
  "settings.timeblocks.title",
  "settings.followUps",
  "settings.followUps.kind.approve",
  "settings.followUps.kind.reply",
  "settings.followUps.kind.review_pr",
  "settings.followUps.kind.resume_error",
  "settings.followUps.kind.check_changes",
  "settings.followUps.grace",
  "settings.followUps.replyExpire",
  "settings.followUps.nonGitExpire",
  "settings.privacy",
  "settings.projects",
  "settings.aiSummary",
  "settings.openWith",
  "settings.openWith.editor",
  "settings.openWith.terminal",
  "settings.openWith.diff",
  "settings.keyboard",
  "settings.desktop.shortcut",
  "settings.notifications.browser", // 旧見出し「通知」。節の名前と重なるので「ブラウザ通知」にした
  "settings.desktop.notificationsTitle",
];

describe("節の目録（D-083）", () => {
  test("節は PO 決定の12個をこの順で", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([...SETTINGS_SECTION_IDS]);
    expect(SETTINGS_SECTIONS.map((s) => translate("ja", s.title))).toEqual([
      "一般",
      "計画の目安と稼働日",
      "カレンダー",
      "AI の取り込み",
      "自分の番",
      "通知",
      "記録",
      "開くアプリ",
      "プロジェクト",
      "キーボード",
      "デスクトップアプリ",
      "データ",
    ]);
    for (const s of SETTINGS_SECTIONS) expect(s.items.length).toBeGreaterThan(0);
  });

  test("漏れの一覧: D-083 より前の項目はすべてどこかの節に入っている", () => {
    const inIndex = new Set(SETTINGS_SECTIONS.flatMap((s) => s.items.map((i) => i.title)));
    const missing = LEGACY_ITEMS.filter((k) => !inIndex.has(k));
    expect(missing).toEqual([]);
  });

  test("目録の項目は画面に anchor がある。画面の anchor はすべて目録にある", () => {
    const inIndex = new Set(SETTINGS_SECTIONS.flatMap((s) => s.items.map((i) => i.anchor)));
    expect([...inIndex].filter((a) => !anchorsInCode.has(a))).toEqual([]);
    expect([...anchorsInCode].filter((a) => !inIndex.has(a))).toEqual([]);
  });

  test("節の中身（SettingsPane）は全節を持ち、既存の部品をすべて置く", () => {
    const page = src("routes/SettingsPage.tsx");
    const pane = page.slice(page.indexOf("export function SettingsPane"));
    for (const id of SETTINGS_SECTION_IDS) expect(pane).toContain(`case "${id}":`);
    for (const c of [
      "GeneralPane",
      "PlanGuideSection",
      "HolidaysSection",
      "DayBoundarySection",
      "CalendarsSection",
      "SourcesSection",
      "StoreTitlesSection",
      "FollowUpSection",
      "NotifyPane",
      "AiSummarySection",
      "OpenWithSection",
      "ProjectsSection",
      "KeyboardSection",
      "DesktopStatusRow",
    ])
      expect(pane).toContain(`<${c} />`);
    expect(page).toContain("<DesktopNotificationsRow />");
  });

  test("キーボードの節はアコーディオンにしない（D-080 の開閉を外した）", () => {
    const kb = src("routes/KeyboardSection.tsx");
    expect(kb).not.toContain("aria-expanded");
    expect(kb).not.toContain("keyboardOpen");
  });
});

describe("D-083: `/settings#<節>`", () => {
  test("ハッシュから節。知らない値・空は一般", () => {
    expect(sectionOfHash("keyboard")).toBe("keyboard");
    expect(sectionOfHash("#ai")).toBe("ai");
    expect(sectionOfHash("")).toBe("general");
    expect(sectionOfHash(undefined)).toBe("general");
    expect(sectionOfHash("privacy")).toBe("general");
  });

  test("`?` の一覧の「設定 › キーボード」とメニューバーのホットキーの案内はキーボードの節へ", () => {
    expect(src("keys/KeyHelp.tsx")).toContain('nav({ to: "/settings", hash: "keyboard" })');
    const tray = readFileSync(join(import.meta.dir, "../../desktop/src-tauri/src/tray.rs"), "utf8");
    expect(tray).toContain('"shortcut" => windows::open_main(app, Some("/settings#keyboard"');
  });

  for (const [locale, q, id, hash] of [
    ["ja", "キーボード", "cmd:keyboard", "keyboard"],
    ["en", "hooks", "cmd:hooks", "ai"],
    ["en", "calendar", "cmd:calendar", "calendar"],
  ] as const) {
    test(`⌘K の「${q}」は設定の ${hash} の節へ（${locale}）`, () => {
      const i18n = makeI18n(locale);
      const input: BuildInput = {
        q,
        category: "all",
        t: i18n.t,
        tEn: (k, x) => translate("en", k, x),
        shortDate: i18n.shortDate,
        titleOf: (x) => (x.t === "text" ? x.text : (x.params.title ?? "")),
        today: "2026-10-06",
        now: Date.parse("2026-10-06T10:00:00+09:00"),
        tz: "Asia/Tokyo",
        selection: [],
        queue: [],
        recent: [],
        search: undefined,
        theme: "light",
        language: locale,
        hooksText: "",
        calendarText: "",
      };
      const row = flatRows(buildSections(input)).find((r) => r.id === id);
      expect(row?.run).toEqual({ t: "nav", to: "/settings", hash: hash as SettingsSectionId });
    });
  }
});

describe("D-083: 設定の検索", () => {
  const ja = (k: AnyMessageKey) => translate("ja", k);
  const en = (k: AnyMessageKey) => translate("en", k);
  const find = (q: string, t = ja) =>
    searchSettings(q, t, en).map((h) => `${h.section}:${h.item?.anchor ?? "-"}`);

  test("空なら何も出さない", () => {
    expect(find("  ")).toEqual([]);
  });

  test("項目名で絞り、該当の節と項目を返す", () => {
    expect(find("猶予")).toEqual(["turn:grace"]);
    expect(find("題名")).toContain("ai:store-titles");
    expect(find("祝日")).toContain("time:holidays");
  });

  test("説明でも当たる（日付の区切りの説明の「放置」）", () => {
    expect(find("集計")).toContain("time:day-boundary");
  });

  test("表示が日本語でも英語の名前で当たる。大文字小文字を区別しない", () => {
    expect(find("Grace")).toEqual(["turn:grace"]);
    expect(find("BACKUP")).toEqual(["data:backup"]);
  });

  test("節の名前に当たれば節ごと出す", () => {
    expect(find("キーボード")).toContain("keyboard:-");
    expect(find("データ")).toContain("data:-");
  });

  test("語はすべて含むものだけ（AND）。同じ anchor は1つにまとめる", () => {
    expect(find("期限 質問")).toEqual(["turn:reply-expire"]);
    const ed = find("Editor", en);
    expect(ed.filter((x) => x === "open:open-with")).toHaveLength(1);
  });
});

describe("デスクトップアプリの通知の表示（D-080 (3)）", () => {
  const text = (k: keyof typeof en, lang: "ja" | "en") => (lang === "ja" ? ja[k] : en[k]);
  test("granted → オン（ボタンなし）", () => {
    const v = desktopNotificationView("granted");
    expect(text(v.text, "ja")).toBe("通知: オン");
    expect(text(v.text, "en")).toBe("Notifications: On");
    expect(v.action).toBeNull();
  });
  test("denied → オフ — システム設定で許可、とシステム設定を開くボタン", () => {
    const v = desktopNotificationView("denied");
    expect(text(v.text, "ja")).toBe(
      "通知: オフ — システム設定で Turnlane の通知を許可してください",
    );
    expect(v.action?.kind).toBe("open_settings");
    expect(text(v.action?.label ?? "settings.desktop.status", "ja")).toBe("システム設定を開く");
  });
  test("not_determined → 未設定と許可を求めるボタン", () => {
    const v = desktopNotificationView("not_determined");
    expect(text(v.text, "ja")).toBe("通知: 未設定");
    expect(v.action?.kind).toBe("request");
    expect(text(v.action?.label ?? "settings.desktop.status", "ja")).toBe("許可を求める");
  });
  test("どの状態でも生の値を出さない", () => {
    for (const st of ["granted", "denied", "not_determined", "unknown", "unsupported"] as const) {
      const v = desktopNotificationView(st);
      for (const lang of ["ja", "en"] as const) {
        const s = String(text(v.text, lang));
        expect(s).not.toContain(st);
        expect(s).not.toContain("{state}");
      }
    }
  });
});

describe("⌘K からキーボードの節へ（D-080 (4)。D-083 でアコーディオンは外した）", () => {
  for (const [locale, q] of [
    ["en", "keyboard"],
    ["ja", "キーボード"],
  ] as const) {
    test(`⌘K の「${q}」で設定 › キーボードを開いた状態で出す（${locale}）`, () => {
      const i18n = makeI18n(locale);
      const input: BuildInput = {
        q,
        category: "all",
        t: i18n.t,
        tEn: (k, x) => translate("en", k, x),
        shortDate: i18n.shortDate,
        titleOf: (x) => (x.t === "text" ? x.text : (x.params.title ?? "")),
        today: "2026-10-06",
        now: Date.parse("2026-10-06T10:00:00+09:00"),
        tz: "Asia/Tokyo",
        selection: [],
        queue: [],
        recent: [],
        search: undefined,
        theme: "light",
        language: locale,
        hooksText: "",
        calendarText: "",
      };
      const row = flatRows(buildSections(input)).find((r) => r.id === "cmd:keyboard");
      expect(row?.run).toEqual({ t: "nav", to: "/settings", hash: "keyboard" });
    });
  }
});

describe("holidaySummary", () => {
  const cals = [
    { name: "日本の祝日" },
    { name: "日本の祝日" },
    { name: "日本の祝日" },
    { name: "US Holidays" },
  ];
  test("同じ名前は1つにまとめて件数を添える（英語）", () => {
    expect(holidaySummary(cals, (k, p) => translate("en", k, p))).toBe(
      "日本の祝日 (3 accounts), US Holidays",
    );
  });
  test("日本語", () => {
    expect(holidaySummary(cals, (k, p) => translate("ja", k, p))).toBe(
      "日本の祝日（3 アカウント）, US Holidays",
    );
  });
  test("1つなら名前だけ", () => {
    expect(holidaySummary([{ name: "Holidays" }], (k, p) => translate("en", k, p))).toBe(
      "Holidays",
    );
  });
});

describe("設定の選択の欄は OS の select でなくメニューのボタン（D-138）", () => {
  test("設定画面・プロジェクト・AI に頼むの設定に <select が無く、MenuSelect を使う", () => {
    const dir = join(import.meta.dir, "../src/routes");
    for (const f of ["SettingsPage.tsx", "SettingsSections.tsx", "LaunchSettings.tsx"]) {
      const s = readFileSync(join(dir, f), "utf8");
      expect(s).not.toContain("<select");
      expect(s).toContain("<MenuSelect");
    }
  });
});
