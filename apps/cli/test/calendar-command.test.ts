/**
 * turnlane calendar / turnlane config / turnlane doctor のカレンダーの行（M3-1・M3-6）。一時 HOME のデーモンに偽のカレンダーを付けて動かす。
 * launchd は FakeLaunchctl、ヘルパの .app はダミーのファイル（EventKit・TCC には触れない）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { CALENDAR_HELPER_LABEL, resolvePaths, type TurnlanePaths } from "@turnlane/core";
import { FakeCalendarProvider, type HelperEvent } from "../../daemon/src/calendar/provider.ts";
import { type RunningDaemon, startDaemon } from "../../daemon/src/main.ts";
import {
  authorizeCmd,
  calendarCommand,
  configCommand,
  eventsLine,
  helperAppPath,
  helperPlistPath,
  holidaysLine,
  timeblockSummaryLines,
} from "../src/commands/calendar.ts";
import { doctorCommand } from "../src/commands/doctor.ts";
import type { CliEnv } from "../src/env.ts";
import { FakeLaunchctl } from "../src/launchctl.ts";

let home: string;
let daemon: RunningDaemon | null = null;
let out: string[] = [];
let launchctl: FakeLaunchctl;

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  rmSync(home, { recursive: true, force: true });
});

function holiday(date: string, title: string): HelperEvent {
  const start = Date.parse(`${date}T00:00:00+09:00`);
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    calendarId: "ek-h",
    externalId: `h-${date}`,
    occurrenceStart: start,
    title,
    start,
    end: start + 86_399_000,
    allDay: true,
    startDate: date,
    endDate: next,
    availability: "free",
    status: "confirmed",
  };
}

/** 以前の版が書いた時間ブロックの予定（D-093 の削除の対象）と、Turnlane で作った予定・目印の無い予定 */
function marked(id: string, url: string | null, startMs: number): HelperEvent {
  return {
    calendarId: "ek-w",
    externalId: `x-${id}`,
    eventId: id,
    occurrenceStart: startMs,
    title: id,
    start: startMs,
    end: startMs + 1_800_000,
    allDay: false,
    url,
    hasAttendees: false,
    recurring: false,
  };
}

let provider: FakeCalendarProvider;

async function setup(
  o: { connected?: boolean } = {},
): Promise<{ env: CliEnv; paths: TurnlanePaths }> {
  home = mkdtempSync(join(tmpdir(), "turnlane-cli-cal-"));
  const paths = resolvePaths({ HOME: home }, home);
  // 今日から数日後の月曜を祝日にする（実時計で動くので日付は今日から決める）
  const today = new Date();
  const d = new Date(today.getTime() + 10 * 86_400_000);
  while (d.getDay() !== 1) d.setTime(d.getTime() + 86_400_000);
  const ymd = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  const now = Date.now();
  provider = new FakeCalendarProvider({
    connected: o.connected ?? true,
    calendars: [
      { id: "ek-w", title: "Work", allowsModify: true, type: "calDAV" },
      { id: "ek-h", title: "Holidays", allowsModify: false, type: "subscription" },
    ],
    events: [
      holiday(ymd(d), "Example Day"),
      marked("tb-1", "dayline://timeblock/a", now - 3 * 86_400_000),
      marked("tb-2", "dayline://timeblock/b", now + 86_400_000),
      marked("ev-1", "turnlane://event/c", now + 2 * 86_400_000),
      marked("plain-1", null, now + 2 * 86_400_000),
    ],
  });
  provider.defaultCalendarId = "ek-w";
  daemon = await startDaemon({
    paths,
    logger: nullLogger,
    port: 0,
    ingest: false,
    calendar: { provider },
  });
  const p = { ...paths, port: daemon.port };
  await daemon.calendar?.service.whenIdle();
  launchctl = new FakeLaunchctl(() => CALENDAR_HELPER_LABEL);
  return {
    paths: p,
    env: {
      paths: p,
      launchctl,
      out: (s) => out.push(s),
      err: (s) => out.push(`ERR ${s}`),
      execPath: "/usr/local/bin/bun",
      vars: { HOME: home },
    },
  };
}

describe("turnlane calendar", () => {
  test("status: 接続・権限・祝日カレンダー（自動）・次の稼働日", async () => {
    const { env } = await setup();
    out = [];
    expect(await calendarCommand(env, "status", { json: false })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Helper: connected");
    expect(text).toContain("Full access");
    expect(text).toContain("Holidays from: Holidays (automatic)");
    expect(text).toContain("Example Day");
    expect(text).toContain("Next workday:");
    out = [];
    expect(await calendarCommand(env, "status", { json: true })).toBe(0);
    expect(JSON.parse(out[0] as string)).toMatchObject({
      connected: true,
      holidays: { mode: "auto" },
    });
  });

  test("未接続でも status は動き、「カレンダー未接続」と出る。sync は失敗を返す", async () => {
    const { env } = await setup({ connected: false });
    out = [];
    expect(await calendarCommand(env, "status", { json: false })).toBe(0);
    expect(out.join("\n")).toContain("not connected");
    out = [];
    expect(await calendarCommand(env, "sync", { json: false })).toBe(1);
    expect(out.join("\n")).toContain("No calendar connected");
  });

  test("status: 予定の書き先は Calendar.app のデフォルト（D-093）", async () => {
    const { env } = await setup();
    expect(await calendarCommand(env, "sync", { json: false })).toBe(0);
    out = [];
    expect(await calendarCommand(env, "status", { json: false })).toBe(0);
    expect(out).toContain("Events: Calendar.app default → Work");
    expect(out.join("\n")).not.toContain("Writeback");
    out = [];
    expect(await calendarCommand(env, "writeback", { json: false })).toBe(2);
  });

  test("cleanup-timeblocks --dry-run: 件数と期間を出し、何も消さない", async () => {
    const { env } = await setup();
    out = [];
    expect(await calendarCommand(env, "cleanup-timeblocks", { json: false, dryRun: true })).toBe(0);
    expect(out[0]).toMatch(
      /^Time block events \(dayline:\/\/timeblock\/\): 2 · \d{4}-\d{2}-\d{2} to /,
    );
    expect(out.join("\n")).toContain("Work: 2");
    expect(out.join("\n")).toContain("--dry-run: nothing deleted");
    expect(provider.writes).toEqual([]);
  });

  test("cleanup-timeblocks: 確認を断ると消さない。端末でなければ --yes が要る", async () => {
    const { env } = await setup();
    out = [];
    expect(
      await calendarCommand(env, "cleanup-timeblocks", {
        json: false,
        confirm: async () => false,
      }),
    ).toBe(1);
    expect(out.at(-1)).toContain("Cancelled");
    out = [];
    expect(await calendarCommand(env, "cleanup-timeblocks", { json: false })).toBe(2);
    expect(out.at(-1)).toContain("--yes");
    expect(provider.writes).toEqual([]);
  });

  test("cleanup-timeblocks: 時間ブロックの予定だけを消す。turnlane で作った予定・目印の無い予定は残る", async () => {
    const { env } = await setup();
    let asked = "";
    out = [];
    expect(
      await calendarCommand(env, "cleanup-timeblocks", {
        json: false,
        confirm: async (q) => {
          asked = q;
          return true;
        },
      }),
    ).toBe(0);
    expect(asked).toContain("these 2 events");
    expect(out.at(-1)).toBe("Deleted 2");
    expect(provider.events.map((e) => e.eventId).sort()).toEqual(
      ["ev-1", "plain-1", undefined].sort(),
    );
    out = [];
    expect(await calendarCommand(env, "cleanup-timeblocks", { json: false, yes: true })).toBe(0);
    expect(out).toEqual(["No time block events (dayline://timeblock/) are left."]);
  });

  test("calendars --role と holidays --set（ID の先頭部分）/ --none / --auto", async () => {
    const { env } = await setup();
    out = [];
    expect(await calendarCommand(env, "calendars", { json: true })).toBe(0);
    const cals = JSON.parse(out[0] as string).calendars as { id: string; name: string }[];
    const h = cals.find((c) => c.name === "Holidays")?.id as string;
    const w = cals.find((c) => c.name === "Work")?.id as string;
    out = [];
    expect(
      await calendarCommand(env, "calendars", { json: false, role: w, roleValue: "ignored" }),
    ).toBe(0);
    expect(out.find((l) => l.includes("Work"))).toContain("ignored");
    // 役割の writeback は D-093 でやめた
    expect(
      await calendarCommand(env, "calendars", { json: false, role: w, roleValue: "writeback" }),
    ).toBe(2);
    expect(
      await calendarCommand(env, "calendars", { json: false, role: w, roleValue: "owner" }),
    ).toBe(2);

    out = [];
    expect(await calendarCommand(env, "holidays", { json: false, none: true })).toBe(0);
    expect(out[0]).toContain("Holidays from: none");
    out = [];
    expect(await calendarCommand(env, "holidays", { json: false, set: [h.slice(-8)] })).toBe(0);
    expect(out[0]).toBe("Holidays from: Holidays (manual)");
    out = [];
    expect(await calendarCommand(env, "holidays", { json: false, set: ["zzz"] })).toBe(1);
    expect(out[0]).toContain("not found");
    out = [];
    expect(await calendarCommand(env, "holidays", { json: false, auto: true })).toBe(0);
    expect(out[0]).toBe("Holidays from: Holidays (automatic)");
    expect(await calendarCommand(env, "holidays", { json: false, auto: true, none: true })).toBe(2);
  });

  /**
   * D-130 の再現: 常駐のヘルパが起動時の「未決定」を覚えたまま。authorize（別のプロセス）では許可が付いたが、常駐の
   * ヘルパは no_access を返し続ける。authorize は常駐のヘルパを起こし直し（偽の launchctl の kickstart -k で、
   * 新しいプロセスがフルアクセスでつながり直したことにする）、同期を1回走らせる
   */
  test("authorize: 許可が付いたら常駐のヘルパを起こし直して同期する（D-130）", async () => {
    const { env } = await setup();
    provider.setAuthorization("notDetermined");
    await daemon?.calendar?.service.whenIdle();
    expect((await daemon?.calendar?.service.syncNow())?.reason).toBe("no_access");
    const app = helperAppPath(env);
    mkdirSync(app, { recursive: true });
    const kick = launchctl.kickstart.bind(launchctl);
    launchctl.kickstart = (label, opts) => {
      kick(label, opts);
      // 起こし直したヘルパは新しいプロセスなので、許可を正しく読む
      provider.setConnected(false);
      provider.authorization = "fullAccess";
      setTimeout(() => provider.setConnected(true), 50);
    };
    launchctl.loaded.set(CALENDAR_HELPER_LABEL, { loaded: true, state: "running", pid: 1 });
    out = [];
    const code = await authorizeCmd(env, undefined, {
      launch: () => {
        mkdirSync(env.paths.logDir, { recursive: true });
        writeFileSync(
          join(env.paths.logDir, "calendar-helper.log"),
          `${JSON.stringify({ event: "authorize.result", authorization: "fullAccess" })}\n`,
        );
        return { ok: true, error: "" };
      },
      sleep: (ms) => Bun.sleep(Math.min(ms, 20)),
    });
    expect(code).toBe(0);
    expect(launchctl.calls).toContain(`kickstart -k ${CALENDAR_HELPER_LABEL}`);
    const text = out.join("\n");
    expect(text).toContain("Access: Full access");
    expect(text).toContain("Restarted the background helper");
    expect(text).toContain("Synced");
    expect(daemon?.calendar?.service.status()).toMatchObject({
      authorization: "fullAccess",
      lastError: null,
    });
  });

  test("authorize: LaunchAgent が無ければ起こし直さない。許可が付かなければ 1", async () => {
    const { env } = await setup();
    mkdirSync(helperAppPath(env), { recursive: true });
    const launch = (a: string) => () => {
      mkdirSync(env.paths.logDir, { recursive: true });
      writeFileSync(
        join(env.paths.logDir, "calendar-helper.log"),
        `${JSON.stringify({ event: "authorize.result", authorization: a })}\n`,
      );
      return { ok: true, error: "" };
    };
    out = [];
    expect(await authorizeCmd(env, undefined, { launch: launch("fullAccess") })).toBe(0);
    expect(launchctl.calls.some((c) => c.startsWith("kickstart"))).toBe(false);
    out = [];
    expect(await authorizeCmd(env, undefined, { launch: launch("denied") })).toBe(1);
    expect(out.join("\n")).toContain("Denied");
    expect(out.some((l) => l.startsWith("ERR Calendar access is off"))).toBe(true);
    // 拒否でも常駐のヘルパを起こし直す（古い「未決定」を返し続けないように。2026-10-21 の Neo）
    launchctl.loaded.set(CALENDAR_HELPER_LABEL, { loaded: true, state: "running", pid: 1 });
    out = [];
    expect(await authorizeCmd(env, undefined, { launch: launch("denied") })).toBe(1);
    expect(launchctl.calls).toContain(`kickstart -k ${CALENDAR_HELPER_LABEL}`);
    expect(out[out.length - 1]?.startsWith("ERR Calendar access is off")).toBe(true);
  });

  /**
   * 2026-10-21 の Neo（初めての Mac、配布版）: ダイアログが出ずに未決定のまま 1 で終わり、画面は理由が分からず待ち続けた。
   * 1 のときは理由を stderr に 1 行で出す（デーモンが O4 に出す）。前回の authorize の行は読まない。ログの場所は --log で渡す
   */
  test("authorize: 1 のときの理由（未決定・EventKit の error・結果なし・起動できない）を stderr に出す", async () => {
    const { env } = await setup();
    mkdirSync(helperAppPath(env), { recursive: true });
    mkdirSync(env.paths.logDir, { recursive: true });
    const logFile = join(env.paths.logDir, "calendar-helper.log");
    const t0 = Date.parse("2026-10-21T10:00:00Z");
    const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
    let logArg = "";
    const launchWriting = (lines: string) => (_app: string, log: string) => {
      logArg = log;
      writeFileSync(logFile, lines, { flag: "a" });
      return { ok: true, error: "" };
    };
    // 前回（1 時間前）にフルアクセスの行があっても、今回の未決定を読む
    writeFileSync(
      logFile,
      line({ ts: "2026-10-21T09:00:00Z", event: "authorize.result", authorization: "fullAccess" }),
    );
    out = [];
    expect(
      await authorizeCmd(env, undefined, {
        now: () => t0,
        launch: launchWriting(
          line({
            ts: "2026-10-21T10:00:01Z",
            event: "authorize.before",
            authorization: "notDetermined",
          }) +
            line({
              ts: "2026-10-21T10:00:01Z",
              event: "authorize.result",
              granted: false,
              authorization: "notDetermined",
              error: 1,
              error_domain: "EKErrorDomain",
            }),
        ),
      }),
    ).toBe(1);
    expect(logArg).toBe(logFile);
    expect(out).toContain(
      "ERR macOS did not show the calendar access dialog; access is still not decided (EKErrorDomain 1)",
    );
    // 結果を書かずに終わった（前回の行だけ）
    out = [];
    expect(
      await authorizeCmd(env, undefined, {
        now: () => t0 + 3_600_000,
        launch: launchWriting(""),
      }),
    ).toBe(1);
    expect(
      out.some((l) => l.startsWith("ERR The calendar helper exited without recording a result")),
    ).toBe(true);
    // open が失敗した
    out = [];
    expect(
      await authorizeCmd(env, undefined, {
        launch: () => ({
          ok: false,
          error: "The application cannot be opened because its executable is missing.",
        }),
      }),
    ).toBe(1);
    expect(out).toContain(
      "ERR Could not start the calendar helper: The application cannot be opened because its executable is missing.",
    );
    // ヘルパが無い
    out = [];
    expect(await authorizeCmd(env, join(home, "nope.app"))).toBe(1);
    expect(out.some((l) => l.startsWith("ERR ") && l.includes("not found"))).toBe(true);
  });

  test("install / uninstall: .app を ~/Applications へ写し、LaunchAgent を登録する（launchd は偽物）", async () => {
    const { env } = await setup();
    const src = join(home, "build", "TurnlaneCalendarHelper.app");
    mkdirSync(join(src, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(src, "Contents", "MacOS", "TurnlaneCalendarHelper"), "#!/bin/sh\n");
    writeFileSync(join(src, "Contents", "Info.plist"), "<plist/>");
    out = [];
    expect(await calendarCommand(env, "install", { json: false, app: src, dryRun: true })).toBe(0);
    expect(existsSync(helperAppPath(env))).toBe(false);
    expect(launchctl.calls).toEqual([]);
    expect(await calendarCommand(env, "install", { json: false, app: src })).toBe(0);
    expect(
      existsSync(join(helperAppPath(env), "Contents", "MacOS", "TurnlaneCalendarHelper")),
    ).toBe(true);
    const plist = readFileSync(helperPlistPath(env), "utf8");
    expect(plist).toContain(`<string>${CALENDAR_HELPER_LABEL}</string>`);
    expect(plist).toContain(`${helperAppPath(env)}/Contents/MacOS/TurnlaneCalendarHelper`);
    expect(plist).toContain("<string>Aqua</string>");
    const lint = Bun.spawnSync(["/usr/bin/plutil", "-lint", helperPlistPath(env)]);
    expect(lint.exitCode).toBe(0);
    expect(launchctl.calls).toEqual([`bootstrap ${helperPlistPath(env)}`]);
    // 2回目は入れ替え
    expect(await calendarCommand(env, "install", { json: false, app: src })).toBe(0);
    expect(launchctl.calls.slice(1)).toEqual([
      `bootout ${CALENDAR_HELPER_LABEL}`,
      `bootstrap ${helperPlistPath(env)}`,
    ]);
    expect(await calendarCommand(env, "uninstall", { json: false })).toBe(0);
    expect(existsSync(helperAppPath(env))).toBe(false);
    expect(existsSync(helperPlistPath(env))).toBe(false);
    expect(await calendarCommand(env, "install", { json: false })).toBe(1);
  });
});

describe("turnlane config", () => {
  test("get / set（既知のキーだけ、値は検証）", async () => {
    const { env } = await setup();
    out = [];
    expect(await configCommand(env, "set", "workdays.weekdays", "[5,1,2,3,4]")).toBe(0);
    expect(out).toEqual(["workdays.weekdays = [1,2,3,4,5]"]);
    out = [];
    expect(await configCommand(env, "get", "workdays.weekdays", undefined)).toBe(0);
    expect(out).toEqual(["[1,2,3,4,5]"]);
    out = [];
    expect(await configCommand(env, "set", "workdays.weekdays", "[]")).toBe(1);
    expect(out[0]).toContain("Invalid value");
    out = [];
    expect(await configCommand(env, "set", "nope", "1")).toBe(1);
    expect(out[0]).toContain("Unknown key");
    out = [];
    expect(await configCommand(env, "set", "tz", "Asia/Tokyo")).toBe(0);
    expect(out).toEqual(['tz = "Asia/Tokyo"']);
    out = [];
    expect(await configCommand(env, undefined, undefined, undefined)).toBe(0);
    expect(out).toContain("workdays.holiday_calendars = null");
  });
});

test("turnlane doctor に Holidays from が出る", async () => {
  const { env } = await setup();
  out = [];
  expect(await doctorCommand(env, { json: false })).toBe(0);
  expect(out).toContain("Holidays from: Holidays (automatic)");
});

test("holidaysLine: 同じ名前の祝日カレンダーが複数アカウントから採用されたら1つにまとめる（D-057 (2)）", () => {
  const cal = (id: string, name: string) => ({ id, name });
  const h = (calendars: { id: string; name: string }[]) => ({
    mode: "auto" as const,
    calendars,
    upcoming: [],
  });
  expect(
    holidaysLine(h([cal("a", "日本の祝日"), cal("b", "日本の祝日"), cal("c", "日本の祝日")])),
  ).toBe("Holidays from: 日本の祝日 (3 accounts) (automatic)");
  expect(
    holidaysLine(h([cal("a", "日本の祝日"), cal("b", "US Holidays"), cal("c", "日本の祝日")])),
  ).toBe("Holidays from: 日本の祝日 (2 accounts), US Holidays (automatic)");
});

describe("turnlane calendar status の予定の行（D-093）", () => {
  test("デフォルトのカレンダー・無い・書き込めない・古いヘルパ", () => {
    const base = { defaultCalendar: "ok" as const, helperOutdated: false };
    const work = { id: "w", name: "Work", account: "Example", color: null, colorKey: null };
    expect(eventsLine({ ...base, calendar: work })).toBe(
      "Events: Calendar.app default → Work (Example)",
    );
    expect(eventsLine({ ...base, defaultCalendar: "none", calendar: null })).toContain(
      "no default calendar",
    );
    expect(
      eventsLine({ ...base, defaultCalendar: "not_writable", calendar: { ...work, name: "H" } }),
    ).toContain("not writable");
    expect(eventsLine({ ...base, calendar: work, helperOutdated: true })).toContain(
      "helper is too old",
    );
  });

  test("時間ブロックの予定の一覧", () => {
    expect(timeblockSummaryLines({ count: 0, from: null, to: null, calendars: [] })).toEqual([
      "No time block events (dayline://timeblock/) are left.",
    ]);
    const lines = timeblockSummaryLines({
      count: 3,
      from: new Date(2026, 9, 3, 10).getTime(),
      to: new Date(2026, 9, 9, 11).getTime(),
      calendars: [{ name: "Work", account: "Example", count: 3 }],
    });
    expect(lines[0]).toBe("Time block events (dayline://timeblock/): 3 · 2026-10-03 to 2026-10-09");
    expect(lines[1]).toBe("  Work (Example): 3");
    expect(lines[2]).toContain("are left alone");
  });
});
