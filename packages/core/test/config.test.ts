/** turnlane config の既知のキーと検証（M3-6） */
import { expect, test } from "bun:test";
import { isConfigKey, validateConfig } from "../src/config.ts";

test("既知のキーだけ受け付ける", () => {
  expect(isConfigKey("workdays.weekdays")).toBe(true);
  expect(isConfigKey("workdays.holiday_calendars")).toBe(true);
  expect(isConfigKey("unknown.key")).toBe(false);
  expect(isConfigKey("__proto__")).toBe(false);
});

test.each<[string, unknown, boolean]>([
  ["workdays.weekdays", [1, 2, 3, 4, 5], true],
  ["workdays.weekdays", [], false],
  ["workdays.weekdays", [0], false],
  ["workdays.weekdays", [8], false],
  ["workdays.weekdays", [1, 1], false],
  ["workdays.weekdays", "mon", false],
  ["workdays.holiday_calendars", null, true],
  ["workdays.holiday_calendars", [], true],
  ["workdays.holiday_calendars", ["abc"], true],
  ["workdays.holiday_calendars", [""], false],
  ["day_boundary", "04:00", true],
  ["day_boundary", "25:00", false],
  ["tz", "Asia/Tokyo", true],
  ["tz", "Mars/Base", false],
  ["presence.tail_min", 5, true],
  ["presence.tail_min", 2, true],
  ["presence.tail_min", 15, true],
  ["presence.tail_min", 1, false],
  ["presence.tail_min", 16, false],
  ["ui.theme", "dark", true],
  ["ui.theme", "blue", false],
  ["open.editor", "cursor", true],
  ["open.editor", "/Applications/Evil.app", false],
  ["open.terminal", "ghostty", true],
  ["open.terminal", "bash -c", false],
  ["open.diff", "github_desktop", true],
  ["open.diff", "zed", false],
  ["ui.keybindings", { viewThree: ["mod+4"], goBoard: ["g x"], toggleWeek: [] }, true],
  ["ui.keybindings", { "bad id": ["x"] }, false],
  ["ui.keybindings", { help: ["a b c"] }, false],
  ["ui.keybindings", { help: ["a", "b", "c", "d", "e"] }, false],
  ["ui.panel_width", 380, true],
  ["ui.panel_width", null, true],
  ["ui.panel_width", 319, false],
  ["ui.panel_width", 1601, false],
  ["ui.panel_width", 400.5, false],
])("%s = %j → %p", (k, v, ok) => {
  if (!isConfigKey(k)) throw new Error("unknown key");
  expect(validateConfig(k, v).ok).toBe(ok);
});

test("稼働曜日は並べて保存する", () => {
  expect(validateConfig("workdays.weekdays", [5, 1, 3])).toEqual({ ok: true, value: [1, 3, 5] });
});
