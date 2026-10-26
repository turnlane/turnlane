/**
 * turnlane calendar（phase0-plan 3.6、M3-1・M3-2・M3-6）と turnlane config。
 *
 *   turnlane calendar status [--json]                 ヘルパの接続・権限、最後の同期、祝日カレンダー、稼働日
 *   turnlane calendar calendars [--json]              カレンダーの一覧（役割・祝日）
 *   turnlane calendar calendars --role <id> source|ignored
 *   turnlane calendar cleanup-timeblocks [--dry-run] [--yes] [--json]
 *                                               M3-3 で書いた時間ブロックの予定（dayline://timeblock/）の件数・期間を出し、
 *                                               確認してから消す（D-093。Turnlane で作った予定・目印の無い予定には触れない）
 *   turnlane calendar holidays [--set <id>... | --none | --auto] [--json]
 *   turnlane calendar sync                            窓を取り直す
 *   turnlane calendar authorize [--app <path>]        ヘルパを前面で起動して権限のダイアログを出す。許可が付いたら
 *                                               常駐のヘルパを起こし直して同期する（D-130）
 *   turnlane calendar install [--app <path>] [--dry-run]   ヘルパを ~/Applications に置き、LaunchAgent を登録する
 *   turnlane calendar uninstall [--dry-run]
 *   turnlane config [get [<key>] | set <key> <json>]
 *
 * ID は `turnlane calendar calendars` に出る calendar.id。先頭か末尾の一部でもよい（一意なら）。
 * UUIDv7 の先頭は作成時刻なので、同じ同期で見つかったカレンダーは先頭が揃う。末尾で区別できる
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  CALENDAR_HELPER_APP,
  CALENDAR_HELPER_LABEL,
  groupHolidaySources,
  isoWeekday,
} from "@turnlane/core";
import type {
  CalendarStatusView,
  CalendarView,
  EventsStatus,
  SyncResult,
  TimeblockEventsSummary,
} from "@turnlane/daemon";
import { helperPlist } from "@turnlane/daemon/launchd";
import { callApi, daemonHealth, fetchHealth } from "../client.ts";
import type { CliEnv } from "../env.ts";
import { notRunning, tr } from "../lang.ts";
import { bootoutAndWait, reloadService } from "../launchctl.ts";

const WEEKDAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dayLabel = (d: string) => `${d} (${WEEKDAY[isoWeekday(d)]})`;

async function requireDaemon(env: CliEnv): Promise<boolean> {
  if (await daemonHealth(env)) return true;
  env.err(notRunning());
  return false;
}

export function helperAppPath(env: CliEnv): string {
  return join(env.paths.home, "Applications", CALENDAR_HELPER_APP);
}

export function helperPlistPath(env: CliEnv): string {
  return join(env.paths.launchAgentsDir, `${CALENDAR_HELPER_LABEL}.plist`);
}

const AUTH_LABEL = (): Record<string, string> => ({
  fullAccess: tr("Full access", "フルアクセス"),
  denied: tr(
    "Denied (allow it in System Settings > Privacy & Security > Calendars)",
    "拒否（システム設定 > プライバシーとセキュリティ > カレンダー で許可）",
  ),
  notDetermined: tr(
    "Not decided (show the dialog with turnlane calendar authorize)",
    "未決定（turnlane calendar authorize でダイアログを出す）",
  ),
  writeOnly: tr("Write only (full access is needed)", "書き込みのみ（フルアクセスが必要）"),
});

/**
 * 祝日カレンダーの表示（turnlane calendar status と turnlane doctor が使う）。同じ名前のカレンダーが複数のアカウントから
 * 採用されていたら1つにまとめて件数を添える（D-057 (2)。判定は和集合のまま）
 */
export function holidaysLine(h: CalendarStatusView["holidays"]): string {
  if (h.mode === "none")
    return tr(
      "Holidays from: none (no holidays; go back to automatic with turnlane calendar holidays --auto)",
      "Holidays from: none（祝日なし。turnlane calendar holidays --auto で自動に戻す）",
    );
  if (h.calendars.length === 0)
    return h.mode === "auto"
      ? tr(
          "Holidays from: none (none found automatically)",
          "Holidays from: none（自動判定で該当なし）",
        )
      : tr(
          "Holidays from: (the chosen calendar was not found)",
          "Holidays from: (選んだカレンダーが見つかりません)",
        );
  const names = groupHolidaySources(h.calendars).map((g) =>
    g.count > 1
      ? tr(`${g.name} (${g.count} accounts)`, `${g.name}（${g.count} アカウント）`)
      : g.name,
  );
  return `Holidays from: ${names.join(", ")}${h.mode === "auto" ? tr(" (automatic)", "（自動）") : tr(" (manual)", "（手動）")}`;
}

export async function calendarCommand(
  env: CliEnv,
  sub: string | undefined,
  o: {
    json: boolean;
    role?: string | undefined;
    roleValue?: string | undefined;
    set?: string[] | undefined;
    none?: boolean;
    auto?: boolean;
    app?: string | undefined;
    dryRun?: boolean;
    /** cleanup-timeblocks の確認を省く */
    yes?: boolean;
    /** 確認の問い（端末なら y/N を聞く。無ければ --yes が要る） */
    confirm?: ((question: string) => Promise<boolean>) | undefined;
  },
): Promise<number> {
  switch (sub ?? "status") {
    case "status":
      return statusCmd(env, o.json);
    case "calendars":
      return calendarsCmd(env, o);
    case "holidays":
      return holidaysCmd(env, o);
    case "cleanup-timeblocks":
      return cleanupTimeblocksCmd(env, o);
    case "sync":
      return syncCmd(env, o.json);
    case "authorize":
      return authorizeCmd(env, o.app);
    case "install":
      return installCmd(env, o.app, o.dryRun === true);
    case "uninstall":
      return uninstallCmd(env, o.dryRun === true);
    default:
      env.err(
        tr(
          "Usage: turnlane calendar status|calendars|cleanup-timeblocks|holidays|sync|authorize|install|uninstall (see turnlane help)",
          "使い方: turnlane calendar status|calendars|cleanup-timeblocks|holidays|sync|authorize|install|uninstall（turnlane help を参照）",
        ),
      );
      return 2;
  }
}

async function statusCmd(env: CliEnv, json: boolean): Promise<number> {
  if (!(await requireDaemon(env))) return 1;
  const r = await callApi<CalendarStatusView>(env.paths, "GET", "/api/calendar/status");
  if (!r.ok) {
    env.err(tr(`Request failed (HTTP ${r.status})`, `取得に失敗しました（HTTP ${r.status}）`));
    return 1;
  }
  const s = r.data;
  if (json) {
    env.out(JSON.stringify(s));
    return 0;
  }
  if (!s.connected) {
    env.out(
      tr(
        "Helper: not connected (no calendar; events won't show, but everything else works. Keep it running with turnlane calendar install)",
        `Helper: 未接続（カレンダー未接続。予定は出ませんが他の機能は動きます。turnlane calendar install で常駐させる）`,
      ),
    );
  } else {
    env.out(
      tr(
        `Helper: connected ${s.helperVersion ?? ""} · Access: ${AUTH_LABEL()[s.authorization ?? ""] ?? s.authorization ?? "unknown"}`,
        `Helper: 接続中 ${s.helperVersion ?? ""} · 権限: ${AUTH_LABEL()[s.authorization ?? ""] ?? s.authorization ?? "不明"}`,
      ),
    );
  }
  env.out(
    tr(
      `Last sync: ${s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString() : "not yet"}${s.lastError ? ` (last error: ${s.lastError})` : ""} · Range ${s.window.from} to ${s.window.to}`,
      `Last sync: ${s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString() : "まだ"}${s.lastError ? `（直近のエラー: ${s.lastError}）` : ""} · 窓 ${s.window.from} 〜 ${s.window.to}`,
    ),
  );
  env.out(
    tr(
      `Calendars: ${s.calendars.total} (source ${s.calendars.source}, ignored ${s.calendars.ignored})`,
      `Calendars: ${s.calendars.total}（source ${s.calendars.source}、ignored ${s.calendars.ignored}）`,
    ),
  );
  env.out(eventsLine(s.events));
  env.out(holidaysLine(s.holidays));
  for (const h of s.holidays.upcoming.slice(0, 5)) env.out(`  ${dayLabel(h.date)} ${h.name ?? ""}`);
  env.out(
    `Workdays: ${s.workdays.weekdays.map((w) => WEEKDAY[w]).join(" ")} · Today ${dayLabel(s.workdays.today)}${s.workdays.isWorkday ? "" : tr(" (day off)", "（休み）")} · Next workday: ${s.workdays.nextWorkday ? dayLabel(s.workdays.nextWorkday) : tr("none", "なし")}`,
  );
  return 0;
}

/**
 * 「Events: Calendar.app のデフォルト → Work（Example）」（予定の書き先。D-093）。
 * デフォルトカレンダーが無い・書き込めない・ヘルパが古いときは案内を添える
 */
export function eventsLine(w: EventsStatus | undefined): string {
  if (!w)
    return tr(
      "Events: (update Turnlane: turnlane self-install)",
      "予定: （Turnlane を更新してください: turnlane self-install）",
    );
  const name = (c: { name: string; account: string | null }) =>
    `${c.name}${c.account ? tr(` (${c.account})`, `（${c.account}）`) : ""}`;
  const where =
    w.defaultCalendar === "none"
      ? tr(
          " (no default calendar; choose one in Calendar.app Settings > General > Default Calendar)",
          "（デフォルトカレンダーがありません。Calendar.app の 設定 > 一般 > デフォルトカレンダー で選ぶ）",
        )
      : w.defaultCalendar === "not_writable"
        ? tr(
            `${w.calendar ? ` → ${name(w.calendar)}` : ""} (not writable; choose another calendar in Calendar.app Settings > General)`,
            `${w.calendar ? ` → ${name(w.calendar)}` : ""}（書き込めません。Calendar.app の 設定 > 一般 で別のカレンダーを選ぶ）`,
          )
        : w.calendar
          ? ` → ${name(w.calendar)}`
          : "";
  const outdated = w.helperOutdated
    ? tr(
        " · the helper is too old to create or edit events (rebuild it and run turnlane calendar install; docs/dev/d093.md)",
        " · ヘルパが古いので予定を作成・編集できません（ビルドし直して turnlane calendar install。docs/dev/d093.md）",
      )
    : "";
  return tr(
    `Events: Calendar.app default${where}${outdated}`,
    `Events: Calendar.app のデフォルト${where}${outdated}`,
  );
}

const fmtDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** 時間ブロックの予定の件数・期間・カレンダーごとの件数（turnlane calendar cleanup-timeblocks。D-093） */
export function timeblockSummaryLines(s: TimeblockEventsSummary): string[] {
  if (s.count === 0)
    return [
      tr(
        "No time block events (dayline://timeblock/) are left.",
        "時間ブロックの予定（dayline://timeblock/）は残っていません。",
      ),
    ];
  const out = [
    tr(
      `Time block events (dayline://timeblock/): ${s.count} · ${s.from !== null ? fmtDay(s.from) : "?"} to ${s.to !== null ? fmtDay(s.to) : "?"}`,
      `時間ブロックの予定（dayline://timeblock/）: ${s.count} 件 · ${s.from !== null ? fmtDay(s.from) : "?"} 〜 ${s.to !== null ? fmtDay(s.to) : "?"}`,
    ),
  ];
  for (const c of s.calendars)
    out.push(
      tr(
        `  ${c.name}${c.account ? ` (${c.account})` : ""}: ${c.count}`,
        `  ${c.name}${c.account ? `（${c.account}）` : ""}: ${c.count} 件`,
      ),
    );
  out.push(
    tr(
      "Events made in Turnlane (turnlane://event/, dayline://event/) and events without the marker are left alone.",
      "Turnlane で作った予定（turnlane://event/・dayline://event/）と、目印の無い予定には触れません。",
    ),
  );
  return out;
}

const CLEANUP_ERR = (): Record<string, string> => ({
  helper_not_connected: tr(
    "The calendar helper isn't connected (turnlane calendar status)",
    "カレンダーヘルパが接続していません（turnlane calendar status）",
  ),
  helper_outdated: tr(
    "The calendar helper is too old to delete events (needs 0.4.0; rebuild it and run turnlane calendar install; docs/dev/d093.md)",
    "カレンダーヘルパが古いため削除できません（0.4.0 が要る。ビルドし直して turnlane calendar install。docs/dev/d093.md）",
  ),
  no_access: tr(
    "No calendar access (turnlane calendar authorize)",
    tr(
      "No calendar access (turnlane calendar authorize)",
      "カレンダーの権限がありません（turnlane calendar authorize）",
    ),
  ),
  changed: tr(
    "The count changed after the check. Run it again",
    "確認の後に件数が変わりました。もう一度実行してください",
  ),
});

async function cleanupTimeblocksCmd(
  env: CliEnv,
  o: {
    json: boolean;
    dryRun?: boolean;
    yes?: boolean;
    confirm?: ((question: string) => Promise<boolean>) | undefined;
  },
): Promise<number> {
  if (!(await requireDaemon(env))) return 1;
  const r = await callApi<TimeblockEventsSummary & { error?: string }>(
    env.paths,
    "GET",
    "/api/calendar/timeblock-events",
  );
  if (!r.ok) {
    env.err(
      CLEANUP_ERR()[r.data?.error ?? ""] ??
        tr(`Request failed (HTTP ${r.status})`, `取得に失敗しました（HTTP ${r.status}）`),
    );
    return 1;
  }
  const s = r.data;
  if (o.dryRun || s.count === 0) {
    if (o.json) env.out(JSON.stringify({ ...s, deleted: 0, dryRun: o.dryRun === true }));
    else {
      for (const l of timeblockSummaryLines(s)) env.out(l);
      if (o.dryRun && s.count > 0)
        env.out(
          tr(
            "(--dry-run: nothing deleted. To delete, run turnlane calendar cleanup-timeblocks)",
            "（--dry-run: 消していません。消すには turnlane calendar cleanup-timeblocks）",
          ),
        );
    }
    return 0;
  }
  if (!o.json) for (const l of timeblockSummaryLines(s)) env.out(l);
  if (!o.yes) {
    if (!o.confirm) {
      env.err(
        tr(
          "Can't ask for confirmation here. Check the list, then run it again with --yes",
          "確認できません。内容を確かめたうえで --yes を付けて実行してください",
        ),
      );
      return 2;
    }
    if (
      !(await o.confirm(
        tr(
          `Delete these ${s.count} events from your calendar? [y/N] `,
          `この ${s.count} 件の予定をカレンダーから削除しますか？ [y/N] `,
        ),
      ))
    ) {
      env.out(tr("Cancelled (nothing deleted)", "やめました（何も消していません）"));
      return 1;
    }
  }
  const d = await callApi<{ deleted: number; failed: number; error?: string }>(
    env.paths,
    "POST",
    "/api/calendar/timeblock-events/cleanup",
    { expected: s.count },
  );
  if (!d.ok) {
    env.err(
      CLEANUP_ERR()[d.data?.error ?? ""] ??
        tr(`Delete failed (HTTP ${d.status})`, `削除に失敗しました（HTTP ${d.status}）`),
    );
    return 1;
  }
  if (o.json) env.out(JSON.stringify({ ...s, deleted: d.data.deleted, failed: d.data.failed }));
  else
    env.out(
      tr(
        `Deleted ${d.data.deleted}${d.data.failed > 0 ? ` (${d.data.failed} failed; run it again to delete the rest)` : ""}`,
        `${d.data.deleted} 件を削除しました${d.data.failed > 0 ? `（${d.data.failed} 件は失敗。もう一度実行すると残りを消します）` : ""}`,
      ),
    );
  return d.data.failed > 0 ? 1 : 0;
}

async function listCalendars(env: CliEnv): Promise<CalendarView[] | null> {
  const r = await callApi<{ calendars: CalendarView[] }>(env.paths, "GET", "/api/calendars");
  if (!r.ok) {
    env.err(tr(`Request failed (HTTP ${r.status})`, `取得に失敗しました（HTTP ${r.status}）`));
    return null;
  }
  return r.data.calendars;
}

/** ID（全体・先頭・末尾の一部）→ calendar.id（一意でなければ null とエラー） */
function resolveId(env: CliEnv, cals: CalendarView[], prefix: string): string | null {
  const exact = cals.find((c) => c.id === prefix);
  if (exact) return exact.id;
  const hits = cals.filter((c) => c.id.startsWith(prefix) || c.id.endsWith(prefix));
  if (hits.length === 1) return (hits[0] as CalendarView).id;
  env.err(
    hits.length === 0
      ? tr(
          `Calendar not found: ${prefix} (check with turnlane calendar calendars)`,
          `カレンダーが見つかりません: ${prefix}（turnlane calendar calendars で確認）`,
        )
      : tr(`More than one calendar matches: ${prefix}`, `ID が一意ではありません: ${prefix}`),
  );
  return null;
}

async function calendarsCmd(
  env: CliEnv,
  o: { json: boolean; role?: string | undefined; roleValue?: string | undefined },
): Promise<number> {
  if (!(await requireDaemon(env))) return 1;
  let cals = await listCalendars(env);
  if (!cals) return 1;
  if (o.role !== undefined) {
    if (o.roleValue !== "source" && o.roleValue !== "ignored") {
      env.err(
        tr(
          "Usage: turnlane calendar calendars --role <id> source|ignored",
          "使い方: turnlane calendar calendars --role <id> source|ignored",
        ),
      );
      return 2;
    }
    const id = resolveId(env, cals, o.role);
    if (!id) return 1;
    const r = await callApi(env.paths, "PATCH", `/api/calendars/${id}`, { role: o.roleValue });
    if (!r.ok) {
      env.err(tr(`Change failed (HTTP ${r.status})`, `変更に失敗しました（HTTP ${r.status}）`));
      return 1;
    }
    cals = (await listCalendars(env)) ?? cals;
  }
  if (o.json) {
    env.out(JSON.stringify({ calendars: cals }));
    return 0;
  }
  if (cals.length === 0) {
    env.out(
      tr(
        "No calendars (the helper isn't connected or hasn't synced yet; turnlane calendar status)",
        "カレンダーがありません（ヘルパが未接続か、まだ同期していません。turnlane calendar status）",
      ),
    );
    return 0;
  }
  for (const c of cals) {
    const flags = [
      c.role,
      c.writable ? "writable" : "read-only",
      c.type ?? "",
      c.holiday ? "holidays" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    env.out(
      `${c.id.slice(0, 13)}  ${c.name}${c.account ? ` (${c.account})` : ""}  ${flags}  ${c.events} events`,
    );
  }
  return 0;
}

async function holidaysCmd(
  env: CliEnv,
  o: { json: boolean; set?: string[] | undefined; none?: boolean; auto?: boolean },
): Promise<number> {
  if (!(await requireDaemon(env))) return 1;
  const modes = [o.set && o.set.length > 0, o.none, o.auto].filter(Boolean).length;
  if (modes > 1) {
    env.err(tr("Use only one of --set / --none / --auto", "--set / --none / --auto はどれか1つ"));
    return 2;
  }
  let value: string[] | null | undefined;
  if (o.none) value = [];
  else if (o.auto) value = null;
  else if (o.set && o.set.length > 0) {
    const cals = await listCalendars(env);
    if (!cals) return 1;
    const ids: string[] = [];
    for (const p of o.set) {
      const id = resolveId(env, cals, p);
      if (!id) return 1;
      ids.push(id);
    }
    value = [...new Set(ids)];
  }
  if (value !== undefined) {
    const r = await callApi<{ error?: string; detail?: string }>(
      env.paths,
      "PUT",
      "/api/config/workdays.holiday_calendars",
      { value },
    );
    if (!r.ok) {
      env.err(
        tr(
          `Change failed (HTTP ${r.status} ${r.data?.error ?? ""})`,
          `変更に失敗しました（HTTP ${r.status} ${r.data?.error ?? ""}）`,
        ),
      );
      return 1;
    }
    // 取得するカレンダーが変わるので同期を待ってから表示する
    await callApi(env.paths, "POST", "/api/calendar/sync");
  }
  const r = await callApi<CalendarStatusView>(env.paths, "GET", "/api/calendar/status");
  if (!r.ok) {
    env.err(tr(`Request failed (HTTP ${r.status})`, `取得に失敗しました（HTTP ${r.status}）`));
    return 1;
  }
  if (o.json) {
    env.out(JSON.stringify(r.data.holidays));
    return 0;
  }
  env.out(holidaysLine(r.data.holidays));
  for (const h of r.data.holidays.upcoming) env.out(`  ${dayLabel(h.date)} ${h.name ?? ""}`);
  return 0;
}

async function syncCmd(env: CliEnv, json: boolean): Promise<number> {
  if (!(await requireDaemon(env))) return 1;
  const r = await callApi<SyncResult>(env.paths, "POST", "/api/calendar/sync");
  if (!r.ok) {
    env.err(tr(`Sync failed (HTTP ${r.status})`, `同期に失敗しました（HTTP ${r.status}）`));
    return 1;
  }
  if (json) {
    env.out(JSON.stringify(r.data));
    return r.data.ok ? 0 : 1;
  }
  if (!r.data.ok) {
    env.err(
      r.data.reason === "not_connected"
        ? tr(
            "No calendar connected (the helper isn't running; turnlane calendar status)",
            "カレンダー未接続です（ヘルパが動いていません。turnlane calendar status）",
          )
        : r.data.reason === "no_access"
          ? tr(
              "No calendar access (turnlane calendar authorize)",
              "カレンダーの権限がありません（turnlane calendar authorize）",
            )
          : tr("Sync failed (turnlane daemon logs)", "同期に失敗しました（turnlane daemon logs）"),
    );
    return 1;
  }
  env.out(
    tr(
      `Synced: ${r.data.calendars} calendars, ${r.data.events} events, ${r.data.changedDates.length} days changed`,
      `同期しました: カレンダー ${r.data.calendars}、予定 ${r.data.events}、変わった日 ${r.data.changedDates.length}`,
    ),
  );
  return 0;
}

/** ヘルパのログ（calendar-helper.log）の最後の event の行。since（ミリ秒）より前の行（前回の authorize）は見ない */
function lastLogEvent(env: CliEnv, event: string, since = 0): Record<string, unknown> | null {
  const p = helperLogPath(env);
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf8").trimEnd().split("\n").reverse();
  for (const l of lines) {
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      if (o.event !== event) continue;
      const ts = typeof o.ts === "string" ? Date.parse(o.ts) : Number.NaN;
      // ts の無い行（古い版・テスト）は今回のものとみなす。ログの ts は秒の精度なので 1 秒ゆるめる
      if (!Number.isNaN(ts) && ts < since - 1000) return null;
      return o;
    } catch {}
  }
  return null;
}

function helperLogPath(env: CliEnv): string {
  return join(env.paths.logDir, "calendar-helper.log");
}

export interface AuthorizeDeps {
  /** ヘルパを --authorize で前面に起動して終わるまで待つ（テストでは差し替える）。log はヘルパに書かせるログのパス */
  launch?: (appPath: string, log: string) => { ok: boolean; error: string };
  /** 常駐のヘルパがつながってフルアクセスを返すまで待つ上限（既定 15 秒） */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function launchAuthorize(appPath: string, log: string): { ok: boolean; error: string } {
  // open（LaunchServices）経由で起動する: 権限の帰属先がヘルパ自身（配布版は責任のあるアプリの Turnlane.app）になる（Terminal ではなく）。
  // open は環境変数を渡さないので、ログの場所は --log で渡す（turnlane が読むのと同じ場所に書かせる）
  const p = Bun.spawnSync(
    ["/usr/bin/open", "-n", "-W", appPath, "--args", "--authorize", "--log", log],
    { stdout: "pipe", stderr: "pipe" },
  );
  return { ok: p.exitCode === 0, error: p.stderr.toString().trim() };
}

/**
 * ヘルパの authorize.result の error（EventKit の NSError）を 1 語に。無ければ空
 */
function helperError(r: Record<string, unknown> | null): string {
  if (!r || r.error === null || r.error === undefined) return "";
  const domain = typeof r.error_domain === "string" ? r.error_domain : "";
  return domain ? `${domain} ${String(r.error)}` : `error ${String(r.error)}`;
}

/**
 * 常駐のヘルパ（LaunchAgent）を起こし直す（D-130: 起動したときの権限をプロセスの中で覚えたままになる）。
 * 許可されたときに加え、拒否のときも行う（2026-10-21 の Neo: authorize は拒否を読んだが、常駐のヘルパは「未決定」を返し続け、
 * 画面が拒否の案内ではなく失敗の案内になった）
 */
function restartResidentHelper(env: CliEnv): void {
  if (env.launchctl.print(CALENDAR_HELPER_LABEL).loaded) {
    try {
      env.launchctl.kickstart(CALENDAR_HELPER_LABEL, { kill: true });
      env.out(
        tr(
          "Restarted the background helper (to pick up the access)",
          "常駐のヘルパを起動し直しました（許可を読み直すため）",
        ),
      );
    } catch (e) {
      env.err(
        tr(
          `Could not restart the background helper: ${(e as Error).message}`,
          `常駐のヘルパを起動し直せませんでした: ${(e as Error).message}`,
        ),
      );
    }
  }
}

/**
 * turnlane calendar authorize。フルアクセスになったら、常駐のヘルパ（LaunchAgent）を起こし直す（D-130）:
 * 常駐のヘルパは起動したときの権限（未決定）をプロセスの中で覚えたままになることがあり、別のプロセスで許可しても
 * 予定を取れなかった。起こし直した後、つながってフルアクセスを返すのを待って同期を1回走らせる。
 *
 * 終了コード: 0 フルアクセス / 1 それ以外。1 のときは理由を stderr に 1 行で出す（デーモンが O4 の画面に要約を出す。
 * onboarding.md 4.4）: ヘルパが無い・起動できない（open の stderr）・結果を書かずに終わった・ダイアログが出ずに未決定のまま
 * （EventKit の error を添える）・拒否
 */
export async function authorizeCmd(
  env: CliEnv,
  app: string | undefined,
  deps: AuthorizeDeps = {},
): Promise<number> {
  const path = resolve(app ?? helperAppPath(env));
  if (!existsSync(path)) {
    env.err(
      tr(
        `${path} not found. Run turnlane calendar install first (or pass --app <path>)`,
        `${path} がありません。先に turnlane calendar install（または --app <path>）`,
      ),
    );
    return 1;
  }
  env.out(
    tr(
      'Showing the calendar access dialog. Choose "Allow Full Access".',
      "カレンダーの権限のダイアログを出します。「フルアクセスを許可」を選んでください。",
    ),
  );
  const since = (deps.now ?? Date.now)();
  const log = helperLogPath(env);
  const p = (deps.launch ?? launchAuthorize)(path, log);
  if (!p.ok) {
    env.err(
      tr(
        `Could not start the calendar helper: ${p.error || "open failed"}`,
        `カレンダーのヘルパを起動できませんでした: ${p.error || "open が失敗しました"}`,
      ),
    );
    return 1;
  }
  const result = lastLogEvent(env, "authorize.result", since);
  const r = result ?? lastLogEvent(env, "authorize.before", since);
  const a = String(r?.authorization ?? "");
  env.out(
    tr(
      `Access: ${AUTH_LABEL()[a] ?? (a || "unknown (check the helper log)")}`,
      `権限: ${AUTH_LABEL()[a] ?? (a || "不明（ヘルパのログを確認）")}`,
    ),
  );
  if (a !== "fullAccess") {
    if (a === "denied" || a === "writeOnly") restartResidentHelper(env);
    const why = helperError(result);
    if (!r)
      env.err(
        tr(
          `The calendar helper exited without recording a result (see ${log})`,
          `カレンダーのヘルパが結果を書かずに終わりました（${log} を確認）`,
        ),
      );
    else if (a === "notDetermined")
      env.err(
        tr(
          `macOS did not show the calendar access dialog; access is still not decided${why ? ` (${why})` : ""}`,
          `macOS がカレンダーの許可のダイアログを出しませんでした。権限は未決定のままです${why ? `（${why}）` : ""}`,
        ),
      );
    else
      env.err(
        tr(
          "Calendar access is off. Turn on Turnlane in System Settings › Privacy & Security › Calendars",
          "カレンダーの権限がオフです。システム設定 › プライバシーとセキュリティ › カレンダー で Turnlane をオンにしてください",
        ),
      );
    return 1;
  }
  restartResidentHelper(env);
  if (!(await fetchHealth(env.paths))) return 0;
  // つながってフルアクセスを返すまで待ってから同期する（起こし直しの直後は未接続）
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const until = Date.now() + (deps.waitMs ?? 15_000);
  let ready = false;
  for (;;) {
    const s = await callApi<CalendarStatusView>(env.paths, "GET", "/api/calendar/status");
    if (s.ok && s.data.connected) {
      const sync = await callApi<SyncResult>(env.paths, "POST", "/api/calendar/sync");
      if (sync.ok && sync.data.ok) {
        ready = true;
        env.out(
          tr(
            `Synced: ${sync.data.calendars} calendars, ${sync.data.events} events`,
            `同期しました: カレンダー ${sync.data.calendars}、予定 ${sync.data.events}`,
          ),
        );
        break;
      }
    }
    if (Date.now() >= until) break;
    await sleep(500);
  }
  if (!ready)
    env.err(
      tr(
        "The background helper hasn't returned events yet. Wait a moment and check with turnlane calendar status",
        "常駐のヘルパから予定を取れていません。少し待って turnlane calendar status で確かめてください",
      ),
    );
  return 0;
}

/** turnlane と同じディレクトリ（ビルドの out/）にある .app */
function sourceApp(env: CliEnv, app: string | undefined): string | null {
  if (app) return resolve(app);
  if (basename(env.execPath) !== "turnlane") return null;
  const p = join(dirname(env.execPath), CALENDAR_HELPER_APP);
  return existsSync(p) ? p : null;
}

const PASS_THROUGH = ["TURNLANE_DATA_DIR", "TURNLANE_LOG_DIR", "TURNLANE_PORT"] as const;

export function buildHelperPlist(env: CliEnv): string {
  const passed: Record<string, string> = {};
  for (const k of PASS_THROUGH) {
    const v = env.vars[k];
    if (v) passed[k] = v;
  }
  return helperPlist({
    label: CALENDAR_HELPER_LABEL,
    app: helperAppPath(env),
    logDir: env.paths.logDir,
    env: passed,
  });
}

/** ヘルパを ~/Applications に置き LaunchAgent を登録する（turnlane calendar install） */
export function installCalendarHelper(
  env: CliEnv,
  app: string | undefined,
  dryRun: boolean,
): number {
  return installCmd(env, app, dryRun);
}

function installCmd(env: CliEnv, app: string | undefined, dryRun: boolean): number {
  const src = sourceApp(env, app);
  if (!src || !existsSync(join(src, "Contents", "MacOS", "TurnlaneCalendarHelper"))) {
    env.err(
      tr(
        "Helper .app not found. Build it with native/calendar-helper/scripts/build-app.sh and pass it with --app <path>.",
        "ヘルパの .app が見つかりません。native/calendar-helper/scripts/build-app.sh でビルドし、--app <path> で指定してください。",
      ),
    );
    return 1;
  }
  const dst = helperAppPath(env);
  const plist = helperPlistPath(env);
  const content = buildHelperPlist(env);
  const step = (s: string) => env.out(`${dryRun ? "[dry-run] " : ""}${s}`);
  if (resolve(src) !== resolve(dst)) step(tr(`Copy: ${src} → ${dst}`, `コピー: ${src} → ${dst}`));
  step(`plist: ${plist}`);
  if (dryRun) {
    env.out(content);
    step(`launchctl bootstrap gui/<uid> ${plist}`);
    return 0;
  }
  if (resolve(src) !== resolve(dst)) {
    mkdirSync(dirname(dst), { recursive: true });
    rmSync(dst, { recursive: true, force: true });
    // ditto は署名を壊さずにバンドルを写す
    const p = Bun.spawnSync(["/usr/bin/ditto", src, dst], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) {
      env.err(
        tr(
          `Copy failed: ${p.stderr.toString().trim()}`,
          `コピーに失敗しました: ${p.stderr.toString().trim()}`,
        ),
      );
      return 1;
    }
  }
  mkdirSync(env.paths.launchAgentsDir, { recursive: true });
  mkdirSync(env.paths.logDir, { recursive: true, mode: 0o700 });
  writeFileSync(plist, content, { mode: 0o644 });
  // bootout 直後の bootstrap は launchd の解体待ちで error 5 になることがあるので、待って再試行する
  reloadService(env.launchctl, CALENDAR_HELPER_LABEL, plist, {
    retryHint: "turnlane calendar install",
    onReplace: () =>
      step(
        tr(
          "Stopping the registered helper to replace it",
          "登録済みのヘルパを停止して入れ替えます",
        ),
      ),
  });
  step(
    tr(
      `Registered with launchd (${CALENDAR_HELPER_LABEL}). Check the connection with turnlane calendar status`,
      `launchd に登録しました（${CALENDAR_HELPER_LABEL}）。turnlane calendar status で接続を確認してください`,
    ),
  );
  return 0;
}

function uninstallCmd(env: CliEnv, dryRun: boolean): number {
  const step = (s: string) => env.out(`${dryRun ? "[dry-run] " : ""}${s}`);
  if (env.launchctl.print(CALENDAR_HELPER_LABEL).loaded) {
    step(`launchctl bootout gui/<uid>/${CALENDAR_HELPER_LABEL}`);
    if (!dryRun) bootoutAndWait(env.launchctl, CALENDAR_HELPER_LABEL);
  }
  for (const p of [helperPlistPath(env), helperAppPath(env)]) {
    if (existsSync(p)) {
      step(tr(`Delete: ${p}`, `削除: ${p}`));
      if (!dryRun) rmSync(p, { recursive: true, force: true });
    }
  }
  env.out(
    tr(
      "The calendar access entry (System Settings > Privacy & Security > Calendars) stays. Remove it by hand if you don't need it.",
      "カレンダーの権限（システム設定 > プライバシーとセキュリティ > カレンダー）の項目は残ります。不要なら手で外してください。",
    ),
  );
  return 0;
}

/** turnlane config [get [<key>] | set <key> <json>] */
export async function configCommand(
  env: CliEnv,
  sub: string | undefined,
  key: string | undefined,
  raw: string | undefined,
): Promise<number> {
  if (!(await requireDaemon(env))) return 1;
  if (sub === undefined || (sub === "get" && key === undefined)) {
    const r = await callApi<{ values: Record<string, unknown> }>(env.paths, "GET", "/api/config");
    if (!r.ok) {
      env.err(tr(`Request failed (HTTP ${r.status})`, `取得に失敗しました（HTTP ${r.status}）`));
      return 1;
    }
    for (const [k, v] of Object.entries(r.data.values)) env.out(`${k} = ${JSON.stringify(v)}`);
    return 0;
  }
  if (sub === "get") {
    const r = await callApi<{ value: unknown; error?: string }>(
      env.paths,
      "GET",
      `/api/config/${encodeURIComponent(key as string)}`,
    );
    if (!r.ok) {
      env.err(
        r.status === 404
          ? tr(
              `Unknown key: ${key} (list them with turnlane config get)`,
              `不明なキー: ${key}（turnlane config get で一覧）`,
            )
          : `HTTP ${r.status}`,
      );
      return 1;
    }
    env.out(JSON.stringify(r.data.value));
    return 0;
  }
  if (sub === "set") {
    if (key === undefined || raw === undefined) {
      env.err(
        tr(
          "Usage: turnlane config set <key> <json> (for example: turnlane config set workdays.weekdays '[1,2,3,4,5]')",
          "使い方: turnlane config set <key> <json>（例: turnlane config set workdays.weekdays '[1,2,3,4,5]'）",
        ),
      );
      return 2;
    }
    // JSON として読めなければ文字列として扱う（turnlane config set tz Asia/Tokyo）
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {}
    const r = await callApi<{ value: unknown; error?: string; detail?: string }>(
      env.paths,
      "PUT",
      `/api/config/${encodeURIComponent(key)}`,
      { value },
    );
    if (!r.ok) {
      env.err(
        r.status === 404
          ? tr(
              `Unknown key: ${key} (list them with turnlane config get)`,
              `不明なキー: ${key}（turnlane config get で一覧）`,
            )
          : tr(
              `Invalid value: ${r.data?.detail ?? r.data?.error ?? r.status}`,
              `値が正しくありません: ${r.data?.detail ?? r.data?.error ?? r.status}`,
            ),
      );
      return 1;
    }
    env.out(`${key} = ${JSON.stringify(r.data.value)}`);
    return 0;
  }
  env.err(
    tr(
      "Usage: turnlane config [get [<key>] | set <key> <json>]",
      "使い方: turnlane config [get [<key>] | set <key> <json>]",
    ),
  );
  return 2;
}
