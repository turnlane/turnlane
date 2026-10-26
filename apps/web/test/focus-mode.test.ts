/**
 * 会議前に聞く集中モード（D-097。ux-mvp 4.15）の web の純粋な部分: SSE focus の無効化、⌘K の集中モードのコマンド、
 * キーボードの設定への登録（既定のキーは無く、割り当てられる）、設定の検索。
 * D-130: 集中モードの入口（予定の右クリック・詳細パネルの「この予定の間は集中する」）と、同じ決定で足したカレンダーの知らせ
 * （サイドバー下の1行）。
 */
import { describe, expect, test } from "bun:test";
import { eventFocusState, menuSpec } from "../src/actions/item-actions.tsx";
import { bandPlain, focusBandText, focusLeft } from "../src/components/focus-band.ts";
import { shouldInvalidate } from "../src/data/invalidate.ts";
import { makeI18n, translate } from "../src/i18n/index.tsx";
import { dispatchable, findConflicts, KEYMAP, keysOf } from "../src/keys/keymap.ts";
import { calendarNotice } from "../src/layout/sources-notice.ts";
import { type BuildInput, buildSections } from "../src/palette/model.ts";
import { searchSettings } from "../src/routes/settings-index.ts";

const today = "2026-10-02";

describe("D-097: SSE", () => {
  test("focus は集中の状態とキュー（ブラウザ通知の抑止）を取り直す。予定・設定の変化でも問いを取り直す", () => {
    expect(shouldInvalidate(["focus"], "focus", {}, today)).toBe(true);
    expect(shouldInvalidate(["queue"], "focus", {}, today)).toBe(true);
    expect(shouldInvalidate(["board", today, today], "focus", {}, today)).toBe(false);
    expect(shouldInvalidate(["focus"], "calendar", { dates: [today] }, today)).toBe(true);
    expect(shouldInvalidate(["focus"], "settings", {}, today)).toBe(true);
    expect(shouldInvalidate(["focus"], "desktop_status", {}, today)).toBe(true);
    expect(shouldInvalidate(["focus"], "notify", {}, today)).toBe(false);
  });
});

describe("D-097: ⌘K とキー", () => {
  const rows = (focus: NonNullable<BuildInput["focus"]>, q = "focus") => {
    const i18n = makeI18n("en");
    return buildSections({
      q,
      category: "commands",
      t: i18n.t,
      tEn: (k, x) => translate("en", k, x),
      shortDate: i18n.shortDate,
      titleOf: () => "",
      today,
      now: 0,
      tz: "Asia/Tokyo",
      selection: [],
      queue: [],
      recent: [],
      search: undefined,
      theme: "dark",
      language: "en",
      hooksText: null,
      calendarText: null,
      focus,
    })
      .flatMap((s) => s.rows)
      .filter((r) => r.id.startsWith("cmd:focus"));
  };

  test("30分・1時間はいつも、次の予定の終わりまでは予定があるとき、終了は集中中だけ", () => {
    expect(
      rows({ active: false, eventAvailable: false })
        .map((r) => r.label)
        .sort(),
    ).toEqual(["Focus: 1 hour", "Focus: 30 min"]);
    expect(
      rows({ active: true, eventAvailable: true })
        .map((r) => r.id)
        .sort(),
    ).toEqual(["cmd:focus30", "cmd:focus60", "cmd:focusEnd", "cmd:focusEvent"]);
    expect(
      rows({ active: false, eventAvailable: false }).find((r) => r.id === "cmd:focus30")?.run,
    ).toEqual({
      t: "key",
      id: "focus30",
    });
  });

  test("日本語の UI でも英語の語（focus）で引ける", () => {
    const i18n = makeI18n("ja");
    const r = buildSections({
      q: "focus",
      category: "commands",
      t: i18n.t,
      tEn: (k, x) => translate("en", k, x),
      shortDate: i18n.shortDate,
      titleOf: () => "",
      today,
      now: 0,
      tz: "Asia/Tokyo",
      selection: [],
      queue: [],
      recent: [],
      search: undefined,
      theme: "dark",
      language: "ja",
      hooksText: null,
      calendarText: null,
      focus: { active: false, eventAvailable: true },
    })
      .flatMap((s) => s.rows)
      .filter((r) => r.id.startsWith("cmd:focus"));
    expect(r.map((x) => x.label)).toContain("集中モード: 次の予定の終わりまで");
  });

  test("キーボードの設定に載る（既定のキーは無く、割り当てられる。衝突しない）", () => {
    for (const id of ["focus30", "focus60", "focusEvent", "focusEnd"]) {
      const d = KEYMAP.find((x) => x.id === id);
      expect(d).toMatchObject({ scope: "global", keys: [] });
      expect(d && dispatchable(d)).toBe(true);
    }
    expect(keysOf("focus30", { focus30: ["g f"] })).toEqual(["g f"]);
    expect(findConflicts({})).toEqual([]);
  });
});

test("設定の検索: 「集中」「focus」で通知の節の集中モードの項目", () => {
  const ja = makeI18n("ja");
  const tEn = (k: Parameters<typeof ja.t>[0]) => translate("en", k);
  const anchors = (q: string) => searchSettings(q, ja.t, tEn).map((h) => h.item?.anchor);
  expect(anchors("集中")).toContain("focus-prompt");
  const en = anchors("focus");
  expect(en).toEqual(expect.arrayContaining(["focus-prompt", "focus-auto", "focus-needs-input"]));
});

const NOW = Date.parse("2026-10-02T13:20:00+09:00");
const at = (hm: string) => Date.parse(`2026-10-02T${hm}:00+09:00`);

describe("カレンダーの知らせ（D-130）", () => {
  const { t } = makeI18n("ja");
  test("知らせるときだけ1行。理由はツールチップ", () => {
    expect(calendarNotice(null, t)).toBeNull();
    expect(calendarNotice(undefined, t)).toBeNull();
    for (const p of ["no_access", "not_connected", "sync_failing"] as const) {
      const n = calendarNotice(p, t);
      expect(n?.text).toBe("カレンダーの予定を取れていません");
      expect(n?.detail).not.toContain("calendar.notice");
    }
    expect(calendarNotice("no_access", t)?.detail).toContain("プライバシーとセキュリティ");
  });
  test("英語", () => {
    expect(calendarNotice("not_connected", makeI18n("en").t)?.text).toBe(
      "Can't get your calendar events",
    );
  });
});

describe("この予定の間は集中する（D-130）", () => {
  const ev = { id: "e1", start: at("14:00"), end: at("15:00"), allDay: false };
  test("これからの予定・進行中の予定は off、設定済みは on、終わった予定・終日は出さない", () => {
    expect(eventFocusState(ev, "e1", [], NOW)).toBe("off");
    expect(eventFocusState({ ...ev, start: at("13:00") }, "e1", [], NOW)).toBe("off");
    expect(eventFocusState(ev, "e1", [{ eventId: "e1" }], NOW)).toBe("on");
    expect(eventFocusState({ ...ev, end: at("13:00") }, "e1", [], NOW)).toBeNull();
    expect(eventFocusState({ ...ev, allDay: true }, "e1", [], NOW)).toBeNull();
    expect(eventFocusState(null, "e1", undefined, NOW)).toBeNull();
  });
  test("右クリックの並び: 詳細・カレンダーで開く / この予定の間は集中する / カレンダーの色 / 削除", () => {
    const ids = (focus: "on" | "off" | null) =>
      menuSpec([], { event: { editable: true, calendarId: "c", focus } }, []).map((s) => [
        s.id,
        s.label,
      ]);
    expect(ids("off")).toEqual([
      ["detail", "menu.detail"],
      ["eventOpen", "menu.eventOpen"],
      ["eventFocus", "menu.eventFocus"],
      ["calColor", "menu.calColor"],
      ["eventDelete", "menu.eventDelete"],
    ]);
    expect(ids("on")[2]).toEqual(["eventFocus", "menu.eventFocusOn"]);
    expect(ids(null).map(([id]) => id)).not.toContain("eventFocus");
    const { t } = makeI18n("ja");
    expect(t("menu.eventFocusOn")).toBe("この予定の間は集中する ✓");
  });
});

describe("集中モード中の帯（ux-mvp 4.15、R18）", () => {
  const tz = "Asia/Tokyo";
  const at = (hm: string) => Date.parse(`${today}T${hm}+09:00`);
  const text = (
    lang: "ja" | "en",
    active: { until: number; title: string | null },
    held: number,
    now: number,
  ) => {
    const b = focusBandText(active, held, now, tz, makeI18n(lang).t);
    return { line: bandPlain(b), right: b.right, held: b.held, b };
  };

  test("題名なし（手動）: 名前 · 終わり · 残り。止めた通知が 0 件なら止めている旨", () => {
    const r = text("ja", { until: at("14:58:00"), title: null }, 0, at("14:28:00"));
    expect(r.line).toBe("集中モード · 14:58 まで · 残り 30m");
    expect(r.right).toBe("自分の番の通知を止めています");
    expect(r.held).toBe(false);
    const e = text("en", { until: at("14:58:00"), title: null }, 0, at("14:28:00"));
    expect(e.line).toBe("Focus · until 14:58 · 30m left");
    expect(e.right).toBe("Your-turn notifications are paused");
  });

  test("題名あり（会議）: 予定の題名の間。止めた通知の件数", () => {
    const r = text("ja", { until: at("14:58:00"), title: " 定例 " }, 1, at("14:28:00"));
    expect(r.line).toBe("集中モード · 「定例」の間 · 14:58 まで · 残り 30m");
    expect(r.right).toBe("止めた通知 1");
    expect(r.held).toBe(true);
    const e = text("en", { until: at("14:58:00"), title: "Team sync" }, 3, at("14:28:00"));
    expect(e.line).toBe("Focus · during Team sync · until 14:58 · 30m left");
    expect(e.right).toBe("Muted 3");
  });

  test("時刻と残りは mono、題名は縮められる断片", () => {
    const { b } = text("ja", { until: at("14:58:00"), title: "定例" }, 0, at("14:28:00"));
    const kinds = b.groups.flat().map((s) => `${s.kind}:${s.text}`);
    expect(kinds).toEqual([
      "text:集中モード",
      "text:「",
      "title:定例",
      "text:」の間",
      "mono:14:58",
      "text: まで",
      "text:残り ",
      "mono:30m",
    ]);
  });

  test("残り時間は分の切り上げで、1分ごとに減る。1時間以上は 1h5m。過ぎたら 0m", () => {
    expect(focusLeft(at("14:58:00"), at("14:28:30"))).toBe("30m");
    expect(focusLeft(at("14:58:00"), at("14:29:00"))).toBe("29m");
    expect(focusLeft(at("14:58:00"), at("14:57:59"))).toBe("1m");
    expect(focusLeft(at("15:33:00"), at("14:28:00"))).toBe("1h5m");
    expect(focusLeft(at("14:58:00"), at("15:00:00"))).toBe("0m");
  });
});
