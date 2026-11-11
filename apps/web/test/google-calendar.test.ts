/** Google カレンダーの Web の画面を開く URL（「Google カレンダーで招待」。0.8.2） */
import { describe, expect, test } from "bun:test";
import {
  googleAccountOf,
  googleDateTime,
  googleEventEditUrl,
  googleEventIdOf,
  googleNewEventUrl,
  looksLikeEmail,
  parseGuests,
} from "../src/lib/google-calendar.ts";

const TZ = "Asia/Tokyo";
// 2026-11-12 14:00 JST
const START = Date.UTC(2026, 10, 12, 5, 0);
const END = START + 60 * 60_000;

const params = (url: string) => new URL(url).searchParams;

describe("招待する人", () => {
  test("カンマ・セミコロン・空白で区切り、メールの形のものだけ（重複を除く）", () => {
    expect(parseGuests(" a@example.com, b@example.co.jp;nope  a@example.com\nc@x.io ,")).toEqual([
      "a@example.com",
      "b@example.co.jp",
      "c@x.io",
    ]);
    expect(parseGuests("someone, @example.com, x@y")).toEqual([]);
    expect(looksLikeEmail("you@example.com")).toBe(true);
    expect(looksLikeEmail("Work")).toBe(false);
    expect(looksLikeEmail(null)).toBe(false);
  });
});

describe("新しい予定の作成の画面", () => {
  test("題名・日時（ctz の時間帯の壁時計）・時間帯・招待する人。記号はエスケープする", () => {
    const url = googleNewEventUrl({
      title: "Plan & review: Q4 / 50% #1",
      start: START,
      end: END,
      tz: TZ,
      guests: ["a@example.com", "b+x@example.com"],
      location: "Room 3 & 4",
      account: "you@example.com",
    });
    expect(url.startsWith("https://calendar.google.com/calendar/render?")).toBe(true);
    const q = params(url);
    expect(q.get("action")).toBe("TEMPLATE");
    expect(q.get("text")).toBe("Plan & review: Q4 / 50% #1");
    expect(q.get("dates")).toBe("20261112T140000/20261112T150000");
    expect(q.get("ctz")).toBe(TZ);
    expect(q.get("add")).toBe("a@example.com,b+x@example.com");
    expect(q.get("location")).toBe("Room 3 & 4");
    expect(q.get("authuser")).toBe("you@example.com");
    // & と # と + は値の中でエスケープされている（URL の区切りにならない）
    expect(url).not.toContain("Plan & review");
    expect(url).toContain("b%2Bx%40example.com");
  });

  test("終日は YYYYMMDD/翌日。場所・アカウントが無ければ付けない", () => {
    const url = googleNewEventUrl({
      title: "Offsite",
      allDay: { startDate: "2026-11-12", endDate: "2026-11-13" },
      tz: TZ,
      guests: ["a@example.com"],
      location: "  ",
      account: null,
    });
    const q = params(url);
    expect(q.get("dates")).toBe("20261112/20261113");
    expect(q.has("location")).toBe(false);
    expect(q.has("authuser")).toBe(false);
  });

  test("時間帯の壁時計（夏時間のある時間帯も）", () => {
    expect(googleDateTime(Date.UTC(2026, 6, 1, 16, 30, 5), "America/Los_Angeles")).toBe(
      "20260701T093005",
    );
    expect(googleDateTime(Date.UTC(2026, 0, 1, 0, 0), TZ)).toBe("20260101T090000");
  });

  test("authuser: カレンダーの名前、無ければアカウントの名前がメールの形のとき", () => {
    expect(googleAccountOf("you@example.com", "Google")).toBe("you@example.com");
    expect(googleAccountOf("Team", "me@example.com")).toBe("me@example.com");
    expect(googleAccountOf("Team", "Google")).toBeNull();
  });
});

describe("既存の予定の編集画面", () => {
  test("eid = base64url（パディングなし）の「イベント ID 空白 カレンダーのメール」。繰り返しの回の印は残す", () => {
    expect(googleEventIdOf("7kq2c3m9g1v0p8r5example@google.com")).toBe("7kq2c3m9g1v0p8r5example");
    expect(googleEventIdOf("abc_20261112T050000Z@google.com")).toBe("abc_20261112T050000Z");
    expect(googleEventIdOf("040000008200E00074C5B7101A82E008@example.com")).toBeNull();
    const url = googleEventEditUrl({
      externalId: "abc_20261112T050000Z@google.com",
      calendarName: "you@example.com",
      date: "2026-11-12",
    });
    const eid = url.slice(url.lastIndexOf("/") + 1);
    expect(url.startsWith("https://calendar.google.com/calendar/u/0/r/eventedit/")).toBe(true);
    expect(eid).not.toMatch(/[=+/]/);
    const decoded = Buffer.from(eid.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString(
      "utf8",
    );
    expect(decoded).toBe("abc_20261112T050000Z you@example.com");
  });

  test("カレンダーのメールかイベント ID が分からなければ、その日の表示", () => {
    expect(
      googleEventEditUrl({ externalId: "x@google.com", calendarName: "Team", date: "2026-11-05" }),
    ).toBe("https://calendar.google.com/calendar/u/0/r/day/2026/11/05");
    expect(
      googleEventEditUrl({
        externalId: "uid-1",
        calendarName: "you@example.com",
        date: "2026-11-05",
      }),
    ).toBe("https://calendar.google.com/calendar/u/0/r/day/2026/11/05");
  });
});
