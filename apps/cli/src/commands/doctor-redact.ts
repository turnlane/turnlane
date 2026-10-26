/**
 * turnlane doctor --redact（phase0-plan M6-6）: issue に貼れる環境情報。
 * 出すのは版・状態のコード・件数だけで、ホームのパス・ユーザー名・ホスト名・リポジトリ名・題名・カレンダー名・
 * 設定ディレクトリの名前（~/.claude-<名前>）は出さない。項目を許可リストで組み立てたうえで、最後に既知の秘匿語
 * （ホーム・ユーザー名・ホスト名・リポジトリ名）を文字列全体から伏せる（二重の安全策）。
 * 公開の issue に貼るものなので英語で出す（issue forms と同じ。M6-5）。
 */

export interface RedactSourceIn {
  tool: string;
  root_path: string;
  enabled: number;
  health_level: string;
  health_reason: string | null;
  detected_version: string | null;
  hooks_state: string;
}

export interface RedactInput {
  cliVersion: string;
  daemonVersion: string | null;
  os: { macos: string | null; arch: string };
  bunVersion: string;
  db: { userVersion: number; schemaVersion: number };
  audit: {
    maxLength: number;
    longValues: { table: string; column: string; count: number }[];
    /** 保存した待ちの中身の件数（ADR 0018。件数だけで中身は出さない） */
    stored?: { instructions: number; waits: number } | null;
  };
  sources: RedactSourceIn[];
  hooks: { file: string; state: string }[];
  /** MCP の登録（D-145）。dir はプロファイル（設定ディレクトリ）か CODEX_HOME */
  mcp?: { tool: string; dir: string; state: string }[];
  versions: { tool: string; version: string; tested: string; ok: boolean }[];
  calendar: {
    connected: boolean;
    authorization: string | null;
    holidays: string;
    holidayCalendars: string[];
  } | null;
  desktop: {
    installed: boolean;
    signature: string | null;
    launchAgent: { loaded: boolean; running: boolean };
    connected: boolean;
    app: { notifications: string; shortcut: { registered: boolean } } | null;
  };
  aiSummary: { enabled: boolean; tool: string; bin: string | null };
  onboarding: { state: string; consented: boolean } | null;
  update: {
    enabled: boolean;
    configured: boolean;
    /** 確認しない理由（setting / custom_build / dev_install） */
    off?: "setting" | "custom_build" | "dev_install" | null;
    available: boolean;
    latest: string | null;
  } | null;
  /** 配置の方式（M6-15）と常駐の登録（SMAppService。アプリが知らせた状態。M6-14）。場所は出さない */
  install?: InstallSummary | null;
}

export interface InstallSummary {
  mode: "app" | "dev" | "unknown";
  /** hooks・MCP の固定の場所がアプリの中の turnlane を指しているか（app のときだけ） */
  cliLinkOk: boolean | null;
  background: { daemon: string; calendarHelper: string; mainApp: string } | null;
  /** Turnlane.app の署名の種別（signatureKind）と公証のチケットが staple されているか（M6-8）。.app が無ければ null */
  signature?: { kind: string; stapled: boolean } | null;
  /** launchd から見た常駐の状態（app のときだけ。2026-10-21 の Neo: 署名の不一致で起動直後に殺され続けた） */
  launchd?: { daemon: LaunchdSummary | null; calendarHelper: LaunchdSummary | null } | null;
}

export interface LaunchdSummary {
  state: string | null;
  runs: number | null;
  lastExit: string | null;
}

/** 署名の不一致（Launch Constraint Violation など）で launchd に殺されているか */
export function codesignKilled(x: LaunchdSummary | null): boolean {
  return /CODESIGN|Code Signature|Launch Constraint/i.test(x?.lastExit ?? "");
}

function launchdPart(name: string, x: LaunchdSummary | null): string {
  if (!x) return `${name} not loaded`;
  const parts = [x.state ?? "unknown"];
  if (x.runs !== null) parts.push(`runs ${x.runs}`);
  if (x.lastExit) parts.push(`last exit: ${x.lastExit}`);
  return `${name} ${parts.join(", ")}`;
}

/** launchd の状態の行（doctor と --redact で同じ）。無ければ null */
export function launchdLines(x: InstallSummary): string[] {
  const l = x.launchd;
  if (!l) return [];
  const out = [
    `launchd: ${launchdPart("daemon", l.daemon)} · ${launchdPart("calendar helper", l.calendarHelper)}`,
  ];
  if (codesignKilled(l.daemon) || codesignKilled(l.calendarHelper))
    out.push(
      "  macOS stops Turnlane's background items because their signature doesn't match the registration. Reinstall Turnlane: quit it, move it to the Trash, download it again, and open it.",
    );
  return out;
}

const SIGNATURE_LABEL: Record<string, string> = {
  "Developer ID Application": "Developer ID",
  "Apple Development": "Apple Development",
  "ad-hoc": "ad-hoc",
  unsigned: "unsigned",
  other: "other certificate",
};

/**
 * 署名の行（doctor と --redact で同じ。M6-8）。Developer ID でカレンダーの許可が無いときは、証明書が変わって
 * 許可が外れた場合の再許可の場所を添える（docs/dev/codesign.md 5.6）
 */
export function signatureLines(
  x: InstallSummary,
  o: { calendarAccess?: string | null } = {},
): string[] {
  const s = x.signature;
  if (!s) return [];
  const label = SIGNATURE_LABEL[s.kind] ?? s.kind;
  const devId = s.kind === "Developer ID Application";
  const notarized = s.stapled ? "notarized (ticket stapled)" : "not notarized";
  const out = [`signature: ${label} · ${notarized}`];
  if (devId && o.calendarAccess && o.calendarAccess !== "fullAccess")
    out.push(
      "  If Calendar or Automation access stopped working after switching from a build signed with another certificate, allow Turnlane again in System Settings > Privacy & Security (docs/dev/codesign.md 5.6).",
    );
  return out;
}

export interface RedactContext {
  home: string;
  /** 伏せる語（ユーザー名・ホスト名・リポジトリ名など。3文字未満は無視する） */
  secrets: readonly string[];
}

/** 設定ディレクトリの呼び名: 既定の名前（.claude / .codex）なら default、それ以外は profile-N（名前を出さない） */
function profileAliases(paths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  let n = 0;
  for (const p of [...new Set(paths)].sort()) {
    const name = p.slice(p.lastIndexOf("/") + 1);
    if (name === ".claude" || name === ".codex" || name === "spool") out.set(p, "default");
    else out.set(p, `profile-${++n}`);
  }
  return out;
}

function dirOf(file: string): string {
  return file.slice(0, file.lastIndexOf("/"));
}

/** 状態の文字列から理由の文（パスを含みうる）を落とし、先頭のコードだけにする */
function stateCode(s: string): string {
  return s.split(":")[0]?.trim() ?? s;
}

/** 状態のコード（health の理由など）に残りうるパス・空白以外の長い語を伏せる */
function codeOnly(s: string | null): string | null {
  if (s === null) return null;
  return s.replace(/\/[^\s)]*/g, "<path>");
}

export interface RedactedReport {
  turnlane: { cli: string; daemon: string | null };
  os: { macos: string | null; arch: string };
  bun: string;
  db: { schema: string; longValues: { column: string; count: number }[] };
  sources: {
    tool: string;
    profile: string;
    enabled: boolean;
    health: string;
    reason: string | null;
    version: string | null;
    hooks: string;
  }[];
  hooks: { tool: string; profile: string; state: string }[];
  mcp: { tool: string; profile: string; state: string }[];
  untestedVersions: { tool: string; version: string; tested: string }[];
  calendar: {
    connected: boolean;
    authorization: string | null;
    holidays: string;
    holidayCalendars: number;
  } | null;
  desktop: {
    installed: boolean;
    signature: string | null;
    launchAgent: string;
    connected: boolean;
    notifications: string | null;
    shortcutRegistered: boolean | null;
  };
  aiSummary: { enabled: boolean; tool: string; cliFound: boolean };
  onboarding: { state: string; consented: boolean } | null;
  update: {
    enabled: boolean;
    configured: boolean;
    /** 確認しない理由（setting / custom_build / dev_install） */
    off?: "setting" | "custom_build" | "dev_install" | null;
    available: boolean;
    latest: string | null;
  } | null;
  install: InstallSummary | null;
}

export function buildRedacted(i: RedactInput): RedactedReport {
  const aliases = profileAliases([
    ...i.sources.map((s) => s.root_path),
    ...i.hooks.map((h) => dirOf(h.file)),
    ...(i.mcp ?? []).map((m) => m.dir),
  ]);
  const hookTool = (file: string) => (file.endsWith("/hooks.json") ? "codex" : "claude_code");
  return {
    turnlane: { cli: i.cliVersion, daemon: i.daemonVersion },
    os: i.os,
    bun: i.bunVersion,
    db: {
      schema: `${i.db.userVersion}/${i.db.schemaVersion}`,
      longValues: i.audit.longValues.map((h) => ({
        column: `${h.table}.${h.column}`,
        count: h.count,
      })),
      ...(i.audit.stored ? { storedDetail: i.audit.stored } : {}),
    },
    sources: i.sources.map((s) => ({
      tool: s.tool,
      profile: aliases.get(s.root_path) ?? "custom",
      enabled: s.enabled === 1,
      health: s.health_level,
      reason: codeOnly(s.health_reason),
      version: s.detected_version,
      hooks: s.hooks_state,
    })),
    hooks: i.hooks.map((h) => ({
      tool: hookTool(h.file),
      profile: aliases.get(dirOf(h.file)) ?? "custom",
      state: stateCode(h.state),
    })),
    mcp: (i.mcp ?? []).map((m) => ({
      tool: m.tool,
      profile: aliases.get(m.dir) ?? "custom",
      state: stateCode(m.state),
    })),
    untestedVersions: i.versions
      .filter((v) => !v.ok)
      .map((v) => ({ tool: v.tool, version: v.version, tested: v.tested })),
    calendar: i.calendar
      ? {
          connected: i.calendar.connected,
          authorization: i.calendar.authorization,
          holidays: i.calendar.holidays,
          holidayCalendars: i.calendar.holidayCalendars.length,
        }
      : null,
    desktop: {
      installed: i.desktop.installed,
      signature: i.desktop.signature,
      launchAgent: i.desktop.launchAgent.running
        ? "running"
        : i.desktop.launchAgent.loaded
          ? "loaded"
          : "not loaded",
      connected: i.desktop.connected,
      notifications: i.desktop.app?.notifications ?? null,
      shortcutRegistered: i.desktop.app ? i.desktop.app.shortcut.registered : null,
    },
    aiSummary: {
      enabled: i.aiSummary.enabled,
      tool: i.aiSummary.tool,
      cliFound: i.aiSummary.bin !== null,
    },
    onboarding: i.onboarding,
    update: i.update,
    install: i.install ?? null,
  };
}

/** 配置の方式の1行（doctor と --redact で同じ。場所は含めない） */
export function installLine(x: InstallSummary): string {
  const bg = x.background
    ? ` · background: daemon ${x.background.daemon}, calendar helper ${x.background.calendarHelper}, open at login ${x.background.mainApp}`
    : "";
  const link = x.cliLinkOk === null ? "" : ` · hooks path ${x.cliLinkOk ? "ok" : "not linked"}`;
  return `install: ${x.mode}${link}${bg}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 文字列全体から秘匿語を伏せる（ホームは ~、その他は <redacted>） */
export function scrub(text: string, ctx: RedactContext): string {
  let out = text;
  if (ctx.home.length > 1) out = out.split(ctx.home).join("~");
  const words = [...new Set(ctx.secrets.filter((w) => w.length >= 3))].sort(
    (a, b) => b.length - a.length,
  );
  for (const w of words) out = out.replace(new RegExp(escapeRe(w), "gi"), "<redacted>");
  return out;
}

/** issue に貼る形（Markdown のコードブロックに入れる前提の英語の行） */
export function redactedLines(r: RedactedReport): string[] {
  const yes = (b: boolean) => (b ? "yes" : "no");
  const lines = [
    "Turnlane diagnostics (redacted)",
    `turnlane ${r.turnlane.cli} (daemon ${r.turnlane.daemon ?? "not running"}) · macOS ${r.os.macos ?? "unknown"} · ${r.os.arch} · bun ${r.bun}`,
    `db schema ${r.db.schema} · long values: ${r.db.longValues.length === 0 ? "0" : r.db.longValues.map((h) => `${h.column} ${h.count}`).join(", ")}`,
  ];
  if (r.install)
    lines.push(installLine(r.install), ...signatureLines(r.install), ...launchdLines(r.install));
  if (r.onboarding)
    lines.push(
      `onboarding: ${r.onboarding.state} · import consent: ${yes(r.onboarding.consented)}`,
    );
  for (const s of r.sources)
    lines.push(
      `source: ${s.tool} ${s.profile}${s.enabled ? "" : " (disabled)"} · health ${s.health}${s.reason ? ` (${s.reason})` : ""} · hooks ${s.hooks}${s.version ? ` · v${s.version}` : ""}`,
    );
  for (const h of r.hooks) lines.push(`hooks file: ${h.tool} ${h.profile} · ${h.state}`);
  for (const m of r.mcp) lines.push(`mcp: ${m.tool} ${m.profile} · ${m.state}`);
  for (const v of r.untestedVersions)
    lines.push(`untested version: ${v.tool} ${v.version} (tested ${v.tested})`);
  lines.push(
    r.calendar
      ? `calendar: ${r.calendar.connected ? "connected" : "not connected"} · access ${r.calendar.authorization ?? "unknown"} · holidays ${r.calendar.holidays} (${r.calendar.holidayCalendars} calendars)`
      : "calendar: unknown (daemon not running)",
  );
  lines.push(
    `desktop app: ${r.desktop.installed ? `installed · ${r.desktop.signature ?? "unknown"} signature · launch agent ${r.desktop.launchAgent} · ${r.desktop.connected ? "connected" : "not connected"}${r.desktop.notifications ? ` · notifications ${r.desktop.notifications}` : ""}${r.desktop.shortcutRegistered === null ? "" : ` · quick add shortcut ${r.desktop.shortcutRegistered ? "registered" : "not registered"}`}` : "not installed"}`,
  );
  lines.push(
    `ai summary: ${r.aiSummary.enabled ? `on · ${r.aiSummary.tool} · cli ${r.aiSummary.cliFound ? "found" : "not found"}` : "off"}`,
  );
  if (r.update)
    lines.push(
      `update check: ${redactedUpdateState(r.update)}${r.update.available && r.update.latest ? ` · ${r.update.latest} is available` : ""}`,
    );
  return lines;
}

const UPDATE_OFF_LABEL = {
  setting: "off (setting)",
  custom_build: "off (custom build)",
  dev_install: "off (dev install)",
} as const;

/** 更新確認の状態（on / off (setting) / off (custom build) / off (dev install) / off (no feed in this build)） */
function redactedUpdateState(u: NonNullable<RedactedReport["update"]>): string {
  if (!u.configured) return "off (no feed in this build)";
  const off = u.off ?? (u.enabled ? null : "setting");
  return off ? UPDATE_OFF_LABEL[off] : "on";
}
