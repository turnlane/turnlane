/**
 * カレンダーヘルパの自動で確かめられる部分（S1・M3-1）。EventKit・TCC・launchd には触れない。
 *
 *   bun scripts/check-calendar-helper.ts [--skip-build]
 *
 * 1. native/calendar-helper/scripts/build-app.sh で out/TurnlaneCalendarHelper.app を作る
 * 2. Info.plist（bundle ID、LSUIElement、NSCalendarsFullAccessUsageDescription）とコード署名を確かめる
 * 3. open（LaunchServices）で --self-test を起動し、.app として起動できること（ad-hoc 署名でも）を確かめる
 * 4. 一時 HOME のデーモンを空いているポートで起動し、ヘルパを --fake-store で接続させて、
 *    WebSocket・JSON-RPC・同期が通ることを確かめる（予定はヘルパ内の固定のダミー）
 * 5. 予定（D-093、ヘルパ 0.4.0）: 時間ブロックはカレンダーに書かない。予定を作る（createEvent → デフォルトカレンダー）・
 *    動かす・題名を変える（updateEvent）・消す（removeEvent）。参加者のいる予定は not_editable。
 *    時間ブロックの予定（dayline://timeblock/）だけを数えて消し（listTimeblockEvents / deleteTimeblockEvent）、
 *    Turnlane で作った予定と目印の無い予定は残る
 * 6. 会議リンク（D-097、ヘルパ 0.5.0）: fetchEvents の hasMeetingLink が届き、会議（Weekly sync。場所に Meet の URL）は
 *    会議リンクあり、Turnlane で作った予定はなし
 * 8. カレンダーが 1 つも無い Mac（--fake-empty）: つながって同期が通り、ヘルパが動き続ける。ログに run.started が残り helper.crash が無い
 * 7. 権限の読み直し（D-130）: 起動時の権限をプロセスの中で覚えたまま別のプロセスで許可されたとき、同期の status で気づいて
 *    起動し直し（終了コード 75。launchd の KeepAlive が起こす）、起こし直した後はフルアクセスで同期する
 * 権限のダイアログとシステム設定の表示はオーナーが確かめる（docs/spikes/s1-eventkit-tcc.md）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EVENTS_HELPER,
  MEETING_LINK_HELPER,
  versionBelow,
} from "../apps/daemon/src/calendar/events.ts";
import type { CalendarView } from "../apps/daemon/src/calendar/index.ts";
import { startDaemon } from "../apps/daemon/src/main.ts";
import { nullLogger } from "../packages/collectors/src/index.ts";
import { resolvePaths } from "../packages/core/src/index.ts";

const ROOT = resolve(import.meta.dir, "..");
const APP = join(ROOT, "out", "TurnlaneCalendarHelper.app");
const BIN = join(APP, "Contents", "MacOS", "TurnlaneCalendarHelper");
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}
const run = (cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
};

if (!process.argv.includes("--skip-build")) {
  const b = run([join(ROOT, "native/calendar-helper/scripts/build-app.sh")]);
  check("build-app.sh builds the .app", b.code === 0 && existsSync(BIN), b.code === 0 ? "" : b.out);
}

const plist = (k: string) =>
  run([
    "/usr/libexec/PlistBuddy",
    "-c",
    `Print :${k}`,
    join(APP, "Contents", "Info.plist"),
  ]).out.trim();
check(
  "CFBundleIdentifier is dev.turnlane.calendar-helper",
  plist("CFBundleIdentifier") === "dev.turnlane.calendar-helper",
);
check("LSUIElement is true", plist("LSUIElement") === "true");
check(
  "NSCalendarsFullAccessUsageDescription is set",
  plist("NSCalendarsFullAccessUsageDescription").length > 20,
);
check(
  "plutil -lint",
  run(["/usr/bin/plutil", "-lint", join(APP, "Contents", "Info.plist")]).code === 0,
);
const sig = run(["/usr/bin/codesign", "-dv", "--verbose=2", APP]).out;
check("code signature identifier", sig.includes("Identifier=dev.turnlane.calendar-helper"));
check(
  "code signature verifies (--strict)",
  run(["/usr/bin/codesign", "--verify", "--strict", APP]).code === 0,
  /Signature=adhoc/.test(sig) ? "ad-hoc" : (/Authority=([^\n]+)/.exec(sig)?.[1] ?? ""),
);
check("--version", run([BIN, "--version"]).out.startsWith("TurnlaneCalendarHelper "));

const tmp = mkdtempSync(join(tmpdir(), "turnlane-helper-check-"));
try {
  // .app として LaunchServices から起動できるか（EventKit には触れない --self-test）
  const log = join(tmp, "self-test.log");
  const o = run(["/usr/bin/open", "-n", "-W", APP, "--args", "--self-test", "--log", log]);
  const lines = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
  const st = lines.find((l) => l.event === "helper.self_test");
  check(
    "launches as an app via open (LaunchServices) with this signature",
    o.code === 0 && st?.bundle_id === "dev.turnlane.calendar-helper" && st?.bundle_path === "app",
  );
  check(
    "runs as an accessory app (LSUIElement, no Dock icon)",
    st?.activation_policy === "accessory",
  );

  // ヘルパ ↔ デーモン（--fake-store。EventKit・TCC に触れない）
  const paths = resolvePaths({ HOME: tmp }, tmp);
  const d = await startDaemon({ paths, logger: nullLogger, port: 0, ingest: false });
  const helper = Bun.spawn(
    [
      BIN,
      "--fake-store",
      "--port",
      String(d.port),
      "--token-file",
      paths.tokenPath,
      "--log",
      join(tmp, "helper.log"),
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  let cals: CalendarView[] = [];
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const r = await fetch(`${d.url}/api/calendars`, {
      headers: { authorization: `Bearer ${d.token}` },
    });
    cals = ((await r.json()) as { calendars: CalendarView[] }).calendars;
    if (cals.length === 2 && cals.every((c) => c.events > 0)) break;
    await Bun.sleep(200);
  }
  check(
    "helper connects over WebSocket and the daemon syncs its calendars and events",
    cals.length === 2 && cals.every((c) => c.events > 0),
    cals.map((c) => `${c.name}:${c.events}`).join(", "),
  );
  const status = (await (
    await fetch(`${d.url}/api/calendar/status`, { headers: { authorization: `Bearer ${d.token}` } })
  ).json()) as {
    connected: boolean;
    authorization: string;
    holidays: { calendars: { name: string }[] };
  };
  check(
    "status: connected with full access, holiday calendar detected",
    status.connected &&
      status.authorization === "fullAccess" &&
      status.holidays.calendars[0]?.name === "Holidays",
  );
  // 予定（D-093）: 時間ブロックは書かず、予定を作る・動かす・消す。時間ブロックの予定だけを消す
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`${d.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${d.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { ...((await r.json()) as object), __status: r.status } as T;
  };
  const st0 = await api<{ helperVersion: string | null }>("GET", "/api/calendar/status");
  check(
    `helper version is ${EVENTS_HELPER} or later`,
    !versionBelow(st0.helperVersion ?? "0.0.0", EVENTS_HELPER),
    st0.helperVersion ?? "",
  );
  const listed = await api<{ calendars: { name: string; isDefault: boolean }[] }>(
    "GET",
    "/api/calendars",
  );
  check(
    "listCalendars marks Calendar.app's default calendar",
    listed.calendars
      .filter((c) => c.isDefault)
      .map((c) => c.name)
      .join() === "Work",
  );
  const workEvents = async () => {
    await api("POST", "/api/calendar/sync");
    const r = await api<{ calendars: { name: string; events: number }[] }>("GET", "/api/calendars");
    return r.calendars.find((c) => c.name === "Work")?.events ?? -1;
  };
  const before = await workEvents();
  const t = await api<{ task: { id: string } }>("POST", "/api/tasks", { title: "Helper check" });
  const start = Date.now() + 2 * 3_600_000;
  await api("POST", "/api/time-blocks", {
    taskId: t.task.id,
    startAt: start,
    endAt: start + 30 * 60_000,
  });
  await Bun.sleep(1500);
  check("time blocks are not written to the calendar", (await workEvents()) === before);
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const today = Date.now();
  type BoardEv = { id: string; title: string | null; editable: boolean };
  const boardEvents = async () =>
    (
      await api<{ days: { events: BoardEv[] }[] }>(
        "GET",
        `/api/board?from=${day(today - 86_400_000)}&to=${day(start + 86_400_000)}`,
      )
    ).days.flatMap((x) => x.events);
  const evs = await boardEvents();
  check(
    "editable: an event made in turnlane yes, a meeting with attendees no",
    evs.find((e) => e.title === "Made in Turnlane")?.editable === true &&
      evs.find((e) => e.title === "Weekly sync")?.editable === false,
    evs.map((e) => `${e.title}:${e.editable}`).join(", "),
  );
  check(
    "a time-block event is not shown as a calendar event",
    !evs.some((e) => e.title === "Old time block"),
  );
  const created = await api<{
    event: { id: string; editable: boolean; calendarName: string } | null;
  }>("POST", "/api/calendar-events", {
    title: "Helper check event",
    start,
    end: start + 30 * 60_000,
  });
  check(
    "createEvent: to Calendar.app's default calendar (Work), editable",
    created.event?.calendarName === "Work" && created.event.editable === true,
    JSON.stringify(created.event),
  );
  const id = created.event?.id ?? "";
  const moved = await api<{ id: string; start: number; end: number; title: string | null }>(
    "PATCH",
    `/api/calendar-events/${id}`,
    { start: start + 3_600_000, end: start + 3_600_000 + 45 * 60_000, title: "Helper check moved" },
  );
  check(
    "updateEvent: move, resize and rename keep the same event",
    moved.id === id &&
      moved.start === start + 3_600_000 &&
      moved.end - moved.start === 45 * 60_000 &&
      moved.title === "Helper check moved" &&
      (await workEvents()) === before + 1,
  );
  const sync = evs.find((e) => e.title === "Weekly sync");
  check(
    `helper version is ${MEETING_LINK_HELPER} or later (meeting links)`,
    !versionBelow(st0.helperVersion ?? "0.0.0", MEETING_LINK_HELPER),
    st0.helperVersion ?? "",
  );
  const link = async (title: string) => {
    const e = evs.find((x) => x.title === title);
    const d = await api<{ hasMeetingLink: boolean | null }>(
      "GET",
      `/api/calendar-events/${e?.id ?? "none"}`,
    );
    return d.hasMeetingLink;
  };
  check(
    "hasMeetingLink: the meeting has a link, an event made in turnlane does not",
    (await link("Weekly sync")) === true && (await link("Made in Turnlane")) === false,
  );
  const refused = await api<{ __status: number; error?: string }>(
    "PATCH",
    `/api/calendar-events/${sync?.id ?? "none"}`,
    { title: "x" },
  );
  check(
    "a meeting with attendees is not editable (409 not_editable)",
    refused.__status === 409 && refused.error === "not_editable",
    `${refused.__status} ${refused.error}`,
  );
  const removed = await api<{ __status: number }>("DELETE", `/api/calendar-events/${id}`);
  check(
    "removeEvent: the event is gone",
    removed.__status === 200 && (await workEvents()) === before,
  );
  const summary = await api<{ count: number }>("GET", "/api/calendar/timeblock-events");
  check(
    "listTimeblockEvents: counts only the time-block event",
    summary.count === 1,
    `${summary.count}`,
  );
  const cleaned = await api<{ deleted: number; failed: number }>(
    "POST",
    "/api/calendar/timeblock-events/cleanup",
    { expected: 1 },
  );
  const after = await boardEvents();
  check(
    "cleanup deletes the time-block event only (turnlane's and the user's events stay)",
    cleaned.deleted === 1 &&
      cleaned.failed === 0 &&
      (await api<{ count: number }>("GET", "/api/calendar/timeblock-events")).count === 0 &&
      after.some((e) => e.title === "Made in Turnlane") &&
      after.some((e) => e.title === "Weekly sync") &&
      (await workEvents()) === before - 1,
    JSON.stringify(cleaned),
  );
  helper.kill();
  await helper.exited;

  // 権限の読み直し（D-130）: 起動時の「未決定」をプロセスの中で覚えたまま、別のプロセスで許可された（実機の不具合の再現）。
  // --fake-auth-file は起動時に1回だけ読み、読み直しは子プロセス（--auth-status）が行う。常駐のヘルパは同期の status で
  // 食い違いに気づき、起動し直す（launchd の KeepAlive の代わりにここで起こし直す）
  const authFile = join(tmp, "auth");
  writeFileSync(authFile, "notDetermined");
  const staleLog = join(tmp, "helper-stale.log");
  const spawnFake = () =>
    Bun.spawn(
      [
        BIN,
        "--fake-store",
        "--fake-auth-file",
        authFile,
        "--min-uptime",
        "0",
        "--port",
        String(d.port),
        "--token-file",
        paths.tokenPath,
        "--log",
        staleLog,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
  const stale = spawnFake();
  const waitStatus = async (
    want: (s: { connected: boolean; authorization: string }) => boolean,
  ) => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      const s = await api<{ connected: boolean; authorization: string }>(
        "GET",
        "/api/calendar/status",
      );
      if (want(s)) return s;
      await Bun.sleep(200);
    }
    return null;
  };
  await waitStatus((s) => s.connected);
  const denied = await api<{ ok: boolean; reason: string | null }>("POST", "/api/calendar/sync");
  check(
    "stale authorization: before the grant the sync reports no_access",
    denied.ok === false && denied.reason === "no_access",
    JSON.stringify(denied),
  );
  writeFileSync(authFile, "fullAccess");
  await api("POST", "/api/calendar/sync");
  const code = await Promise.race([stale.exited, Bun.sleep(10_000).then(() => null)]);
  const staleLines = readFileSync(staleLog, "utf8");
  check(
    "stale authorization: the helper notices the grant made in another process and relaunches",
    code === 75 &&
      staleLines.includes('"authorization.stale"') &&
      staleLines.includes('"helper.relaunch"'),
    `exit ${code}`,
  );
  const relaunched = spawnFake();
  const ok = await waitStatus((s) => s.connected && s.authorization === "fullAccess");
  const synced = await api<{ ok: boolean }>("POST", "/api/calendar/sync");
  check(
    "stale authorization: after the relaunch the helper syncs with full access",
    ok !== null && synced.ok === true,
    JSON.stringify(synced),
  );
  relaunched.kill();
  await relaunched.exited;

  // カレンダーが 1 つも無い Mac（2026-10-21 の Neo: アカウントの無い Mac で許可した後、常駐のヘルパが起動直後に終わり続けた）:
  // フルアクセスでカレンダー 0 件でも、つながって同期が通り、ヘルパが動き続ける
  const emptyLog = join(tmp, "helper-empty.log");
  const empty = Bun.spawn(
    [
      BIN,
      "--fake-store",
      "--fake-empty",
      "--port",
      String(d.port),
      "--token-file",
      paths.tokenPath,
      "--log",
      emptyLog,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const emptyReady = await waitStatus((s) => s.connected && s.authorization === "fullAccess");
  const emptySync = await api<{ ok: boolean; calendars: number; events: number }>(
    "POST",
    "/api/calendar/sync",
  );
  const emptyCals = await api<{ calendars: CalendarView[] }>("GET", "/api/calendars");
  await Bun.sleep(1500);
  check(
    "no calendars: the helper connects, the sync succeeds with 0 calendars, and it keeps running",
    emptyReady !== null &&
      emptySync.ok === true &&
      emptySync.calendars === 0 &&
      empty.exitCode === null,
    JSON.stringify({
      sync: emptySync,
      calendars: emptyCals.calendars?.length,
      exit: empty.exitCode,
    }),
  );
  const emptyLines = readFileSync(emptyLog, "utf8");
  check(
    "no calendars: the helper log records the start in the background mode and no crash",
    emptyLines.includes('"run.started"') && !emptyLines.includes('"helper.crash"'),
  );
  empty.kill();
  await empty.exited;
  await d.stop();
  const helperLog = readFileSync(join(tmp, "helper.log"), "utf8");
  check(
    "helper log has no event titles",
    !helperLog.includes("Weekly sync") &&
      !helperLog.includes("Example Day") &&
      !helperLog.includes("Helper check") &&
      !helperLog.includes("Made in Turnlane"),
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\ncalendar helper: all automatic checks passed");
