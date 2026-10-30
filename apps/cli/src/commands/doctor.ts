/**
 * turnlane doctor [--json]（phase0-plan 3.6・5.4、M1-12）。DB を読み取り専用で開いて点検する（デーモンが止まっていてもよい）。
 * - DB のプライバシー監査: TEXT 列で 300 文字を超える値を数える（ユーザー入力の列は除く）。0 でなければ失敗
 * - 取り込み元と縮退レベル、testedVersions の範囲外の注意
 * - hooks のインストール状態（読み取りのみ）
 * - MCP の登録（D-145。読み取りのみ。見るのは turnlane の項目だけ）
 * - カレンダー: ヘルパの接続と「Holidays from: <カレンダー名>」（M3-6。デーモンが動いているときだけ）
 * - デスクトップアプリ: .app の有無、署名（Apple Development か ad-hoc か）、LaunchAgent、接続（desktop-shell.md 6.2）
 * - 署名の種別（ad-hoc / Apple Development / Developer ID）と公証のチケットの有無（M6-8。staple のファイルを見るだけ）
 * - 日報の AI 要約（M4-6）: オンなら、選んだ CLI が見つかるか（デーモンが動いているときだけ）
 * - オンボーディング（取り込みの同意。M6-18）と更新確認（M6-12。デーモンが知っている結果を出すだけで、接続しない）
 * - --redact（M6-6）: issue に貼れる形。ホームのパス・ユーザー名・リポジトリ名・題名などを伏せる（doctor-redact.ts）
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { arch, hostname, userInfo } from "node:os";
import { basename, join } from "node:path";
import { builtinAdapters, satisfiesRange } from "@turnlane/collectors";
import {
  bundledBinary,
  bundledCliLinkPath,
  CALENDAR_HELPER_LABEL,
  DAEMON_LABEL,
  linkTarget,
  ONBOARDING_KEY,
  openDatabase,
  readAiSummary,
  readInstallInfo,
  readOnboarding,
  readUserVersion,
  SCHEMA_VERSION,
  summaryToolCommand,
  UPDATE_DOWNLOAD_MAX_ATTEMPTS,
  VERSION,
} from "@turnlane/core";
import type { SummaryToolsResponse, UpdateStatus } from "@turnlane/core/api";
import {
  claudePlan,
  codexHome,
  codexPlan,
  detectClaudeDirs,
  loadJson,
  status,
} from "@turnlane/core/hooks";
import { mcpTargets } from "@turnlane/core/mcp";
import type { CalendarStatusView } from "@turnlane/daemon";
import { callApi, fetchHealth } from "../client.ts";
import type { CliEnv } from "../env.ts";
import { tr } from "../lang.ts";
import { holidaysLine } from "./calendar.ts";
import {
  desktopAppPath,
  desktopLines,
  desktopStatus,
  notarizationStapled,
  signatureKind,
} from "./desktop.ts";
import {
  buildRedacted,
  type InstallSummary,
  installLine,
  type LaunchdSummary,
  launchdLines,
  redactedLines,
  scrub,
  signatureLines,
} from "./doctor-redact.ts";
import { resolveCliPath } from "./hooks.ts";
import { statusRows, statusRowText, toolName } from "./mcp-config.ts";

export const AUDIT_MAX = 300;

/** Turnlane.app の署名の種別と staple の有無（.app が無ければ null。M6-8） */
function signatureSummary(app: string | null): { kind: string; stapled: boolean } | null {
  if (!app || !existsSync(app)) return null;
  return { kind: signatureKind(app), stapled: notarizationStapled(app) };
}
/** 長い値が入りうるユーザー入力・内部状態の列（本文ではない） */
const AUDIT_EXEMPT = new Set([
  "task.title",
  "task.notes_md",
  "daily_note.plan_md",
  "daily_note.memo_md",
  "daily_note.report_md",
  "daily_note.ai_summary_md",
  "work_item.title_user",
  "setting.value_json",
  "change_log.patch_json",
  "ingest_cursor.carry_state_json",
  "ai_source.include_globs_json",
  "ai_source.exclude_globs_json",
  "follow_up.snoozes_json",
  "__migrations.id",
]);

/**
 * 限定して保存する待ちの中身（ADR 0018・D-218）の列ごとの上限。保存の上限（指示 120 文字、問い・コマンド 300 文字）を
 * 超える値があれば本文の混入とみなす。AskUserQuestion の問いと選択肢（options_json）は複数の問いの JSON なので広め
 */
export const AUDIT_LIMITS: Record<string, number> = {
  "ai_instruction.text": 120,
  "wait_detail.text": 300,
  "wait_detail.label": 300,
  "wait_detail.command": 300,
  "wait_detail.tool": 120,
  "wait_detail.options_json": 2000,
  // 報告（ADR 0021）: 待ちの中身の JSON（問い 300・選択肢 2000・説明 60 と伏せ字）と開く先の URL（2048）
  "ai_turn.wait_json": 2600,
  "ai_session.open_url": 2048,
};

/**
 * spool に残っている、まだ取り込んでいない報告の行の数（ADR 0021）。デーモンが止まっている間に `turnlane ai report` が
 * 書いたもの。ファイルの大きさとカーソルの位置だけを見て、カーソルより後の改行を数える（中身は読まない）
 */
export function reportSpoolBacklog(dbPath: string, spoolDir: string): number {
  let names: string[] = [];
  try {
    names = readdirSync(spoolDir).filter((f) => /^report-\d{8}\.jsonl$/.test(f));
  } catch {
    return 0;
  }
  if (names.length === 0) return 0;
  const offsets = new Map<string, number>();
  const db = existsSync(dbPath) ? openDatabase(dbPath, { readonly: true }) : null;
  try {
    for (const r of db
      ?.query<{ k: string; o: number }, []>(
        `SELECT c.stream_key AS k, c.byte_offset AS o FROM ingest_cursor c JOIN ai_source s ON s.id = c.source_id
         WHERE s.tool = 'report'`,
      )
      .all() ?? [])
      offsets.set(r.k, r.o);
  } catch {
    // 古いスキーマ
  } finally {
    db?.close();
  }
  let n = 0;
  for (const f of names) {
    try {
      const buf = readFileSync(join(spoolDir, f));
      for (let i = offsets.get(f) ?? 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
    } catch {}
  }
  return n;
}

/** 保存した待ちの中身の件数（ADR 0018。中身は出さない。古いスキーマなら null） */
export function storedDetailCounts(dbPath: string): { instructions: number; waits: number } | null {
  const db = openDatabase(dbPath, { readonly: true });
  try {
    const n = (t: string) =>
      db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${t}`).get()?.n ?? 0;
    return { instructions: n("ai_instruction"), waits: n("wait_detail") };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export interface AuditHit {
  table: string;
  column: string;
  count: number;
}

export function auditDb(dbPath: string): AuditHit[] {
  const db = openDatabase(dbPath, { readonly: true });
  try {
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((r) => r.name);
    const hits: AuditHit[] = [];
    for (const t of tables) {
      const cols = db
        .query<{ name: string; type: string }, []>(`PRAGMA table_info(${t})`)
        .all()
        .filter((c) => c.type.toUpperCase() === "TEXT" && !AUDIT_EXEMPT.has(`${t}.${c.name}`));
      for (const c of cols) {
        const n =
          db
            .query<{ n: number }, [number]>(
              `SELECT count(*) AS n FROM "${t}" WHERE length("${c.name}") > ?`,
            )
            .get(AUDIT_LIMITS[`${t}.${c.name}`] ?? AUDIT_MAX)?.n ?? 0;
        if (n > 0) hits.push({ table: t, column: c.name, count: n });
      }
    }
    return hits;
  } finally {
    db.close();
  }
}

async function calendarStatus(env: CliEnv): Promise<CalendarStatusView | null> {
  if (!(await fetchHealth(env.paths))) return null;
  try {
    const r = await callApi<CalendarStatusView>(env.paths, "GET", "/api/calendar/status");
    return r.ok ? r.data : null;
  } catch {
    return null;
  }
}

async function summaryTools(env: CliEnv): Promise<SummaryToolsResponse | null> {
  if (!(await fetchHealth(env.paths))) return null;
  try {
    const r = await callApi<SummaryToolsResponse>(env.paths, "GET", "/api/summary/tools");
    return r.ok ? r.data : null;
  } catch {
    return null;
  }
}

/** 日報の AI 要約の1行（M4-6） */
export function summaryLine(
  s: ReturnType<typeof readAiSummary>,
  tools: SummaryToolsResponse | null,
): string {
  if (!s.enabled) return tr("Daily note AI summary: off", "日報の AI 要約: オフ");
  const name = summaryToolCommand(s.tool);
  if (!tools)
    return tr(
      `Daily note AI summary: on (${name}). Can't check the CLI because Turnlane isn't running`,
      `日報の AI 要約: オン（${name}）。デーモンが止まっているので CLI を確認できません`,
    );
  const t = tools.tools.find((x) => x.tool === s.tool);
  if (!t?.bin)
    return tr(
      `Daily note AI summary: on. ${name} not found (no summary is made; the daily note is saved without one)`,
      `日報の AI 要約: オン。${name} が見つかりません（要約は作られず、日報は要約なしで保存されます）`,
    );
  const missing =
    t.missingFlags.length > 0
      ? tr(
          `; missing flags: ${t.missingFlags.join(" ")}`,
          `。無い起動フラグ: ${t.missingFlags.join(" ")}`,
        )
      : "";
  return tr(
    `Daily note AI summary: on (${name}: ${t.bin}${missing})`,
    `日報の AI 要約: オン（${name}: ${t.bin}${missing}）`,
  );
}

async function updateStatus(env: CliEnv): Promise<UpdateStatus | null> {
  try {
    const r = await callApi<UpdateStatus>(env.paths, "GET", "/api/update");
    return r.ok ? r.data : null;
  } catch {
    return null;
  }
}

function macosVersion(): string | null {
  try {
    const p = Bun.spawnSync(["/usr/bin/sw_vers", "-productVersion"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const v = p.stdout.toString().trim();
    return p.exitCode === 0 && /^[\d.]+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** 伏せる語: ユーザー名・ホスト名・ホームの名前・リポジトリの名前（DB の work_item.repo_root の末尾） */
function secretWords(home: string, repoRoots: readonly string[]): string[] {
  const out = [basename(home)];
  try {
    out.push(userInfo().username);
  } catch {}
  try {
    const h = hostname();
    out.push(h, h.replace(/\.local$/, ""));
  } catch {}
  for (const r of repoRoots) out.push(basename(r));
  return out;
}

export async function doctorCommand(
  env: CliEnv,
  o: { json: boolean; redact?: boolean },
): Promise<number> {
  const { paths } = env;
  if (!existsSync(paths.dbPath)) {
    env.err(tr(`No database at ${paths.dbPath}`, `DB がありません: ${paths.dbPath}`));
    return 1;
  }
  const audit = auditDb(paths.dbPath);
  const stored = storedDetailCounts(paths.dbPath);
  const reportBacklog = reportSpoolBacklog(paths.dbPath, paths.spoolDir);
  const db = openDatabase(paths.dbPath, { readonly: true });
  let sources: {
    tool: string;
    root_path: string;
    health_level: string;
    health_reason: string | null;
    detected_version: string | null;
    hooks_state: string;
    enabled: number;
  }[] = [];
  let userVersion = 0;
  let aiSummary = readAiSummary(undefined);
  let onboardingRaw: unknown;
  let repoRoots: string[] = [];
  try {
    userVersion = readUserVersion(db);
    const ob = db
      .query<{ value_json: string }, [string]>("SELECT value_json FROM setting WHERE key = ?")
      .get(ONBOARDING_KEY);
    if (ob) onboardingRaw = JSON.parse(ob.value_json);
    if (o.redact)
      repoRoots = db
        .query<{ r: string }, []>(
          "SELECT DISTINCT repo_root AS r FROM work_item WHERE repo_root IS NOT NULL",
        )
        .all()
        .map((x) => x.r);
    const v = db
      .query<{ value_json: string }, []>(
        "SELECT value_json FROM setting WHERE key = 'report.ai_summary'",
      )
      .get();
    if (v) aiSummary = readAiSummary(JSON.parse(v.value_json));
    sources = db
      .query<(typeof sources)[number], []>(
        "SELECT tool, root_path, health_level, health_reason, detected_version, hooks_state, enabled FROM ai_source ORDER BY tool, root_path",
      )
      .all();
  } catch {
    // マイグレーション前の DB
  } finally {
    db.close();
  }
  const cli = resolveCliPath(env);
  const hooks: { file: string; state: string }[] = [];
  for (const d of detectClaudeDirs(paths.home, env.vars)) {
    try {
      hooks.push({
        file: join(d, "settings.json"),
        state: status(loadJson(join(d, "settings.json")).value, claudePlan(cli)).state,
      });
    } catch (e) {
      hooks.push({ file: join(d, "settings.json"), state: `unreadable: ${(e as Error).message}` });
    }
  }
  const ch = join(codexHome(paths.home, env.vars), "hooks.json");
  if (existsSync(codexHome(paths.home, env.vars))) {
    try {
      hooks.push({ file: ch, state: status(loadJson(ch).value, codexPlan(cli)).state });
    } catch (e) {
      hooks.push({ file: ch, state: `unreadable: ${(e as Error).message}` });
    }
  }
  const mcp = statusRows(mcpTargets(paths.home, env.vars), cli);
  const versions = sources
    .filter((s) => s.detected_version)
    .map((s) => {
      const a = builtinAdapters.find((x) => x.tool === s.tool);
      return {
        tool: s.tool,
        version: s.detected_version as string,
        tested: a?.testedVersions ?? "*",
        ok: a ? satisfiesRange(s.detected_version as string, a.testedVersions) : true,
      };
    });
  const calendar = await calendarStatus(env);
  const desktop = await desktopStatus(env);
  const tools = aiSummary.enabled ? await summaryTools(env) : null;
  const health = await fetchHealth(env.paths);
  const update = health ? await updateStatus(env) : null;
  const info = readInstallInfo(paths.dataDir);
  const bg = desktop.app?.background;
  const install: InstallSummary = {
    mode: info?.mode ?? "unknown",
    cliLinkOk:
      info?.mode === "app" && info.appPath
        ? linkTarget(bundledCliLinkPath(paths.dataDir)) === bundledBinary(info.appPath, "turnlane")
        : null,
    background:
      bg?.managed === true
        ? { daemon: bg.daemon, calendarHelper: bg.calendarHelper, mainApp: bg.mainApp }
        : null,
    launchd: info?.mode === "app" ? launchdSummary(env) : null,
    signature: signatureSummary(
      info?.mode === "app" && info.appPath
        ? info.appPath
        : desktop.installed
          ? desktopAppPath(env)
          : null,
    ),
  };
  const ob = readOnboarding(onboardingRaw);
  const onboarding = ob ? { state: ob.state, consented: ob.consentedAt !== null } : null;
  if (o.redact) {
    const r = buildRedacted({
      cliVersion: VERSION,
      daemonVersion: health?.version ?? null,
      os: { macos: macosVersion(), arch: arch() },
      bunVersion: Bun.version,
      db: { userVersion, schemaVersion: SCHEMA_VERSION },
      audit: { maxLength: AUDIT_MAX, longValues: audit, stored },
      sources,
      hooks,
      mcp: mcp.map((m) => ({
        tool: m.tool,
        dir: m.dir,
        state: m.reason ? `${m.state}-${m.reason}` : m.state,
      })),
      versions,
      calendar: calendar
        ? {
            connected: calendar.connected,
            authorization: calendar.authorization,
            holidays: calendar.holidays.mode,
            holidayCalendars: calendar.holidays.calendars.map((c) => c.name),
          }
        : null,
      desktop,
      aiSummary: {
        enabled: aiSummary.enabled,
        tool: aiSummary.tool,
        bin: tools?.tools.find((t) => t.tool === aiSummary.tool)?.bin ?? null,
      },
      onboarding,
      update: update
        ? {
            enabled: update.enabled,
            configured: update.configured,
            off: update.off ?? (update.enabled ? null : "setting"),
            available: update.available,
            latest: update.latest?.version ?? null,
          }
        : null,
      install,
    });
    const ctx = { home: paths.home, secrets: secretWords(paths.home, repoRoots) };
    const text = o.json ? JSON.stringify(r) : redactedLines(r).join("\n");
    env.out(scrub(text, ctx));
    return audit.length > 0 ? 1 : 0;
  }
  const result = {
    desktop,
    db: { path: paths.dbPath, userVersion, schemaVersion: SCHEMA_VERSION },
    audit: { maxLength: AUDIT_MAX, longValues: audit },
    sources,
    hooks,
    mcp,
    versions,
    calendar: calendar
      ? {
          connected: calendar.connected,
          authorization: calendar.authorization,
          holidays: calendar.holidays.mode,
          holidayCalendars: calendar.holidays.calendars.map((c) => c.name),
        }
      : null,
    aiSummary: {
      enabled: aiSummary.enabled,
      tool: aiSummary.tool,
      bin: tools?.tools.find((t) => t.tool === aiSummary.tool)?.bin ?? null,
    },
    onboarding,
    update,
    install: { ...install, appPath: info?.appPath ?? null },
    reportSpool: { pending: reportBacklog },
  };
  if (o.json) {
    env.out(JSON.stringify(result));
    return audit.length > 0 ? 1 : 0;
  }
  env.out(
    tr(
      `DB: schema ${userVersion}/${SCHEMA_VERSION}`,
      `DB: スキーマ ${userVersion}/${SCHEMA_VERSION}`,
    ),
  );
  env.out(
    audit.length === 0
      ? tr(
          `DB audit: no values longer than ${AUDIT_MAX} characters (no conversation text)`,
          `DB 監査: ${AUDIT_MAX} 文字を超える値は 0 件（本文は入っていません）`,
        )
      : tr(
          `DB audit: values longer than ${AUDIT_MAX} characters: ${audit.map((h) => `${h.table}.${h.column} ${h.count}`).join(", ")}`,
          `DB 監査: ${AUDIT_MAX} 文字を超える値があります: ${audit.map((h) => `${h.table}.${h.column} ${h.count}件`).join(", ")}`,
        ),
  );
  if (stored)
    env.out(
      tr(
        `Stored wait details (masked, never sent): ${stored.instructions} instruction lines, ${stored.waits} waits`,
        `保存した待ちの中身（伏せ字の後、外には送らない）: 指示 ${stored.instructions} 件、待ち ${stored.waits} 件`,
      ),
    );
  if (reportBacklog > 0)
    env.out(
      tr(
        `Reports waiting in the spool (read when Turnlane runs): ${reportBacklog}`,
        `spool で取り込みを待っている報告（Turnlane が動くと読む）: ${reportBacklog} 件`,
      ),
    );
  for (const s of sources) {
    env.out(
      tr(
        `Source: ${s.tool} ${s.root_path} ${s.enabled ? "" : "(off) "}status ${s.health_level}${s.health_reason ? ` (${s.health_reason})` : ""} hooks ${s.hooks_state}`,
        `取り込み元: ${s.tool} ${s.root_path} ${s.enabled ? "" : "(無効) "}health ${s.health_level}${s.health_reason ? ` (${s.health_reason})` : ""} hooks ${s.hooks_state}`,
      ),
    );
  }
  for (const v of versions)
    if (!v.ok)
      env.out(
        tr(
          `Note: ${v.tool} ${v.version} is outside the tested range (${v.tested}). Import continues, but the format may have changed`,
          `注意: ${v.tool} ${v.version} は検証した範囲（${v.tested}）の外です。取り込みは続けますが、形式の変化に注意してください`,
        ),
      );
  for (const h of hooks) env.out(`hooks: ${h.file}: ${h.state}`);
  for (const m of mcp) env.out(`MCP: ${toolName(m)} ${m.dir} (${m.file}): ${statusRowText(m)}`);
  if (calendar) {
    env.out(
      tr(
        `Calendar: ${calendar.connected ? `helper connected (access ${calendar.authorization ?? "unknown"})` : "not connected (events won't show; everything else works)"}`,
        `カレンダー: ${calendar.connected ? `ヘルパ接続中（権限 ${calendar.authorization ?? "不明"}）` : "未接続（予定は出ません。他の機能は動きます）"}`,
      ),
    );
    env.out(holidaysLine(calendar.holidays));
  } else {
    env.out(
      tr(
        "Calendar: can't check because Turnlane isn't running (turnlane calendar status)",
        "カレンダー: デーモンが止まっているので確認できません（turnlane calendar status）",
      ),
    );
  }
  for (const l of desktopLines(desktop)) env.out(l);
  env.out(`${installLine(install)}${info?.appPath ? ` (${info.appPath})` : ""}`);
  for (const l of signatureLines(install, { calendarAccess: calendar?.authorization ?? null }))
    env.out(l);
  for (const l of launchdLines(install)) env.out(l);
  env.out(summaryLine(aiSummary, tools));
  if (onboarding && !onboarding.consented)
    env.out(
      tr(
        "Import: waiting for consent (start with turnlane onboarding consent)",
        "取り込み: 同意待ち（turnlane onboarding consent で始めます）",
      ),
    );
  if (update) {
    env.out(updateLine(update));
    const dl = updateDownloadLine(update);
    if (dl) env.out(dl);
  }
  return audit.length > 0 ? 1 : 0;
}

/**
 * 更新確認の1行（M6-12）。確かめた結果を出すだけ（doctor は接続しない）。
 * on / off (setting) / off (custom build) / off (dev install)、最後の確認、最新の版
 */
export function updateLine(u: UpdateStatus): string {
  if (!u.configured)
    return tr(
      "Update check: off (no update feed in this build)",
      "更新確認: オフ（このビルドには確認先がありません）",
    );
  const off = u.off ?? (u.enabled ? null : "setting");
  const at = u.checkedAt === null ? null : new Date(u.checkedAt).toISOString().slice(0, 16);
  const tail = [
    at ? tr(`last checked ${at}`, `最後の確認 ${at}`) : null,
    u.latest ? tr(`latest ${u.latest.version}`, `最新 ${u.latest.version}`) : null,
    at && u.error ? tr(`last check failed: ${u.error}`, `前回は失敗: ${u.error}`) : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");
  const withTail = (head: string) => (tail ? `${head} · ${tail}` : head);
  if (off === "custom_build")
    return withTail(
      tr(
        "Update check: off (custom build: includes an extension)",
        "更新確認: オフ（拡張を組み込んだビルド）",
      ),
    );
  if (off === "dev_install")
    return withTail(tr("Update check: off (dev install)", "更新確認: オフ（開発時の配置）"));
  if (off === "setting")
    return withTail(
      tr(
        "Update check: off (setting; turn on with turnlane config set update.check true)",
        "更新確認: オフ（設定。turnlane config set update.check true でオン）",
      ),
    );
  if (u.available && u.latest)
    return u.upgradeCommand
      ? tr(
          `Update check: on · ${u.latest.version} is available (you have ${u.current}). Run ${u.upgradeCommand}`,
          `更新確認: オン · ${u.latest.version} があります（今は ${u.current}）。${u.upgradeCommand} を実行してください`,
        )
      : tr(
          `Update check: on · ${u.latest.version} is available (you have ${u.current}). ${u.latest.url}`,
          `更新確認: オン · ${u.latest.version} があります（今は ${u.current}）。${u.latest.url}`,
        );
  if (at === null)
    return tr("Update check: on · not checked yet", "更新確認: オン · まだ確かめていません");
  return withTail(tr("Update check: on · up to date", "更新確認: オン · 最新です"));
}

/** launchd から見た常駐（dev.turnlane.daemon・dev.turnlane.calendar-helper）の状態 */
function launchdSummary(env: CliEnv): {
  daemon: LaunchdSummary | null;
  calendarHelper: LaunchdSummary | null;
} {
  const one = (label: string): LaunchdSummary | null => {
    try {
      const s = env.launchctl.print(label);
      if (!s.loaded) return null;
      return { state: s.state ?? null, runs: s.runs ?? null, lastExit: s.lastExitReason ?? null };
    } catch {
      return null;
    }
  };
  return { daemon: one(DAEMON_LABEL), calendarHelper: one(CALENDAR_HELPER_LABEL) };
}

/**
 * 自動更新の 1 行（ADR 0008 の追記 4）: update.download のオン・オフ、取得・検証・置き換えの状態、最後の失敗。
 * 古いデーモン（download が無い）・確認先の無いビルドでは出さない
 */
export function updateDownloadLine(u: UpdateStatus): string | null {
  if (!u.configured || !u.download) return null;
  if (u.downloadEnabled === false)
    return tr(
      "Update download: off (setting; turn on with turnlane config set update.download true)",
      "更新のダウンロード: オフ（設定。turnlane config set update.download true でオン）",
    );
  const off = u.off ?? (u.enabled ? null : "setting");
  if (off)
    return tr(
      "Update download: off (the update check is off)",
      "更新のダウンロード: オフ（更新確認がオフ）",
    );
  if (u.channel === "dev")
    return tr(
      "Update download: on · only for the app install (Turnlane.app)",
      "更新のダウンロード: オン · アプリの配置（Turnlane.app）だけ",
    );
  const d = u.download;
  const v = d.version ?? "";
  switch (d.state) {
    case "downloading":
      return tr(
        `Update download: on · downloading ${v}`,
        `更新のダウンロード: オン · ${v} を取得中`,
      );
    case "verifying":
      return tr(`Update download: on · verifying ${v}`, `更新のダウンロード: オン · ${v} を確認中`);
    case "ready":
      return tr(
        `Update download: on · ${v} is ready (Restart to update in the menu bar or at the top of the board)`,
        `更新のダウンロード: オン · ${v} の準備ができました（メニューバーかボードの上部の「再起動して更新」）`,
      );
    case "installing":
      return tr(
        `Update download: on · installing ${v}`,
        `更新のダウンロード: オン · ${v} を入れています`,
      );
    case "installed":
      return tr(
        `Update download: on · installed ${v} (restarting)`,
        `更新のダウンロード: オン · ${v} を入れました（再起動中）`,
      );
    case "failed": {
      const gaveUp = d.attempts >= UPDATE_DOWNLOAD_MAX_ATTEMPTS;
      return tr(
        `Update download: on · ${v} failed: ${d.error ?? "unknown"} (${gaveUp ? "gave up; update by hand" : `attempt ${d.attempts} of ${UPDATE_DOWNLOAD_MAX_ATTEMPTS}; retried at the next check`})`,
        `更新のダウンロード: オン · ${v} は失敗: ${d.error ?? "unknown"}（${gaveUp ? "やめました。手で更新してください" : `${UPDATE_DOWNLOAD_MAX_ATTEMPTS} 回のうち ${d.attempts} 回目。次の確認でやり直します`}）`,
      );
    }
    default:
      return tr("Update download: on", "更新のダウンロード: オン");
  }
}
