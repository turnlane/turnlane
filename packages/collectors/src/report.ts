/**
 * 外の作業の報告（ADR 0021）の型と検証。報告は CLI `turnlane ai report`・MCP `report_ai_work`・HTTP `POST /api/ai/reports`
 * が同じ型で受け、spool の `report-YYYYMMDD.jsonl` に同じ 1 行を書く。adapters/report が読んで取り込む。
 *
 * - 文は ADR 0018 の上限で切る（件名 120・待ちの文 300・選択肢 10 個 × 60・選択肢の JSON 2000・許可の説明 60）。伏せ字は
 *   シンクが通す
 * - spool の 1 行のキーは平たく持つ（`wait_text` など。本文系のキー名 `text` を許可リストに入れない。ADR 0005）
 * - 1 行は 4 KB 未満（O_APPEND の 1 回の書き込みで行が混ざらない大きさ）
 */

/** 出どころの識別子（ai_session.tool の CHECK と同じ） */
export const REPORT_SOURCE_RE = /^[a-z0-9_]{2,32}$/;
/** Turnlane が自分で読む取り込み元の名前。報告の出どころには使えない */
export const RESERVED_REPORT_SOURCES: readonly string[] = [
  "claude_code",
  "codex",
  "claude_desktop",
  "hook_spool",
  "report",
];
export const REPORT_STATES = ["started", "running", "waiting", "done", "error"] as const;
export type ReportState = (typeof REPORT_STATES)[number];
/** 報告のセッションの entrypoint（isReportSession） */
export const REPORT_ENTRYPOINT = "report";

export const REPORT_LIMITS = {
  id: 128,
  title: 120,
  project: 80,
  text: 300,
  options: 10,
  option: 60,
  optionsJson: 2000,
  label: 60,
  errorKind: 32,
  url: 2048,
  clientId: 64,
  /** spool の 1 行（改行を含めてこれ未満） */
  lineBytes: 4096,
} as const;

/** 3 つの口が受ける 1 つの型（MCP・HTTP の JSON はこのまま。CLI はオプションから組み立てる） */
export interface ReportInput {
  source: string;
  id: string;
  title?: string;
  project?: string;
  state: ReportState;
  wait?: {
    kind: "question" | "permission";
    text: string;
    options?: string[];
    label?: string;
  };
  error?: { kind: string };
  url?: string;
  at?: number;
  client_id?: string;
}

/** spool の 1 行（v1） */
export interface ReportSpoolLine {
  v: 1;
  kind: "report";
  received_at: number;
  client_id: string;
  source: string;
  id: string;
  state: ReportState;
  title?: string;
  project?: string;
  wait_kind?: "question" | "permission";
  wait_text?: string;
  wait_options?: string[];
  wait_label?: string;
  error_kind?: string;
  url?: string;
  at?: number;
}

/** spool の 1 行に入るキー（アダプタの許可リスト） */
export const REPORT_LINE_KEYS = [
  "v",
  "kind",
  "received_at",
  "client_id",
  "source",
  "id",
  "state",
  "title",
  "project",
  "wait_kind",
  "wait_text",
  "wait_options[]",
  "wait_label",
  "error_kind",
  "url",
  "at",
] as const;

export type ReportParse = { ok: true; report: ReportInput } | { ok: false; field: string };

const TOP_KEYS = new Set([
  "source",
  "id",
  "title",
  "project",
  "state",
  "wait",
  "error",
  "url",
  "at",
  "client_id",
]);
const WAIT_KEYS = new Set(["kind", "text", "options", "label"]);
const CLIENT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const ERROR_KIND_RE = /^[A-Za-z0-9_.-]{1,32}$/;
/** 開く先にしないスキーム（ファイル・スクリプト・データ。http(s) とアプリの URL スキームだけ受ける） */
const DENIED_SCHEMES = new Set([
  "file",
  "javascript",
  "data",
  "vbscript",
  "blob",
  "about",
  "turnlane",
]);
const SCHEME_RE = /^([a-z][a-z0-9+.-]{1,31}):/i;

/** 1 行の文にする（改行・制御文字を空白に、前後の空白を落とし、n 文字で切る） */
export function reportText(s: string, n: number): string {
  let flat = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    flat += c < 0x20 || c === 0x7f ? " " : ch;
  }
  const one = flat.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** 開く先にできる URL か（http(s) か、アプリの URL スキーム。file: や javascript: は受けない） */
export function isOpenableReportUrl(u: string): boolean {
  if (u.length === 0 || u.length > REPORT_LIMITS.url || /\s/.test(u)) return false;
  const m = SCHEME_RE.exec(u);
  if (!m?.[1]) return false;
  const scheme = m[1].toLowerCase();
  if (DENIED_SCHEMES.has(scheme)) return false;
  if (scheme === "http" || scheme === "https") {
    try {
      return new URL(u).host.length > 0;
    } catch {
      return false;
    }
  }
  return true;
}

/** 選択肢を上限に収める（10 個・各 60 文字、JSON で 2000 文字まで。後ろから落とす） */
function fitOptions(xs: string[]): string[] {
  const out = xs
    .map((x) => reportText(x, REPORT_LIMITS.option))
    .filter((x) => x.length > 0)
    .slice(0, REPORT_LIMITS.options);
  while (out.length > 0 && JSON.stringify(out).length > REPORT_LIMITS.optionsJson) out.pop();
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 報告の検証（3 つの口で同じ）。だめなら最初にだめだった項目の名前だけを返す（値は返さない）。文は上限で切る。
 * 知らないキーは受けない（綴りの間違いを黙って落とさない）
 */
export function parseReport(v: unknown): ReportParse {
  if (!isObj(v)) return { ok: false, field: "body" };
  for (const k of Object.keys(v)) if (!TOP_KEYS.has(k)) return { ok: false, field: k };
  const bad = (field: string): ReportParse => ({ ok: false, field });
  const { source, id, title, project, state, wait, error, url, at } = v;
  const clientId = v.client_id;
  if (typeof source !== "string" || !REPORT_SOURCE_RE.test(source)) return bad("source");
  if (RESERVED_REPORT_SOURCES.includes(source)) return bad("source");
  if (typeof id !== "string" || id.trim().length === 0 || id.length > REPORT_LIMITS.id)
    return bad("id");
  if (typeof state !== "string" || !(REPORT_STATES as readonly string[]).includes(state))
    return bad("state");
  const r: ReportInput = { source, id: id.trim(), state: state as ReportState };
  if (title !== undefined) {
    if (typeof title !== "string") return bad("title");
    const t = reportText(title, REPORT_LIMITS.title);
    if (t) r.title = t;
  }
  if (project !== undefined) {
    if (typeof project !== "string") return bad("project");
    const p = reportText(project, REPORT_LIMITS.project);
    if (p) r.project = p;
  }
  if (wait !== undefined) {
    if (!isObj(wait)) return bad("wait");
    for (const k of Object.keys(wait)) if (!WAIT_KEYS.has(k)) return bad(`wait.${k}`);
    if (wait.kind !== "question" && wait.kind !== "permission") return bad("wait.kind");
    if (typeof wait.text !== "string") return bad("wait.text");
    const text = reportText(wait.text, REPORT_LIMITS.text);
    if (!text) return bad("wait.text");
    const w: NonNullable<ReportInput["wait"]> = { kind: wait.kind, text };
    if (wait.options !== undefined) {
      if (!Array.isArray(wait.options) || wait.options.some((o) => typeof o !== "string"))
        return bad("wait.options");
      const o = fitOptions(wait.options as string[]);
      if (o.length > 0) w.options = o;
    }
    if (wait.label !== undefined) {
      if (typeof wait.label !== "string") return bad("wait.label");
      const l = reportText(wait.label, REPORT_LIMITS.label);
      if (l) w.label = l;
    }
    r.wait = w;
  }
  if (r.state === "waiting" && !r.wait) return bad("wait");
  if (r.state !== "waiting" && r.wait) return bad("wait");
  if (error !== undefined) {
    if (!isObj(error) || Object.keys(error).some((k) => k !== "kind")) return bad("error");
    if (typeof error.kind !== "string" || !ERROR_KIND_RE.test(error.kind)) return bad("error.kind");
    if (r.state !== "error") return bad("error");
    r.error = { kind: error.kind };
  }
  if (url !== undefined) {
    if (typeof url !== "string" || !isOpenableReportUrl(url)) return bad("url");
    r.url = url;
  }
  if (at !== undefined) {
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return bad("at");
    r.at = Math.floor(at);
  }
  if (clientId !== undefined) {
    if (typeof clientId !== "string" || !CLIENT_ID_RE.test(clientId)) return bad("client_id");
    r.client_id = clientId;
  }
  return { ok: true, report: r };
}

/** 検証した報告 → spool の 1 行（client_id が無ければ呼び出し側が付けたものを使う） */
export function toReportSpoolLine(
  r: ReportInput,
  receivedAt: number,
  clientId: string,
): ReportSpoolLine {
  const line: ReportSpoolLine = {
    v: 1,
    kind: "report",
    received_at: receivedAt,
    client_id: r.client_id ?? clientId,
    source: r.source,
    id: r.id,
    state: r.state,
  };
  if (r.title) line.title = r.title;
  if (r.project) line.project = r.project;
  if (r.wait) {
    line.wait_kind = r.wait.kind;
    line.wait_text = r.wait.text;
    if (r.wait.options) line.wait_options = r.wait.options;
    if (r.wait.label) line.wait_label = r.wait.label;
  }
  if (r.error) line.error_kind = r.error.kind;
  if (r.url) line.url = r.url;
  if (r.at !== undefined) line.at = r.at;
  return line;
}

/**
 * spool の 1 行の文字列（改行つき）。4 KB を超えるなら、待ちの選択肢 → 待ちの文 → 件名の順に削って収める
 * （それでも超えるなら null。呼び出し側は 400 にする）
 */
export function reportSpoolText(line: ReportSpoolLine): string | null {
  const l: ReportSpoolLine = { ...line };
  const size = () => new TextEncoder().encode(`${JSON.stringify(l)}\n`).length;
  if (size() < REPORT_LIMITS.lineBytes) return `${JSON.stringify(l)}\n`;
  delete l.wait_options;
  if (size() < REPORT_LIMITS.lineBytes) return `${JSON.stringify(l)}\n`;
  if (l.wait_text) l.wait_text = reportText(l.wait_text, 100);
  if (l.title) l.title = reportText(l.title, 60);
  return size() < REPORT_LIMITS.lineBytes ? `${JSON.stringify(l)}\n` : null;
}

/** spool の 1 行 → 報告（許可リストを通した後の値。形が合わなければ null） */
export function fromReportSpoolLine(
  v: Record<string, unknown>,
): { receivedAt: number; clientId: string; report: ReportInput } | null {
  if (v.v !== 1 || v.kind !== "report") return null;
  if (typeof v.received_at !== "number" || typeof v.client_id !== "string") return null;
  const body: Record<string, unknown> = {
    source: v.source,
    id: v.id,
    state: v.state,
    client_id: v.client_id,
  };
  for (const k of ["title", "project", "url", "at"] as const)
    if (v[k] !== undefined) body[k] = v[k];
  if (v.wait_kind !== undefined)
    body.wait = {
      kind: v.wait_kind,
      text: v.wait_text,
      ...(v.wait_options !== undefined ? { options: v.wait_options } : {}),
      ...(v.wait_label !== undefined ? { label: v.wait_label } : {}),
    };
  if (v.error_kind !== undefined) body.error = { kind: v.error_kind };
  const p = parseReport(body);
  if (!p.ok) return null;
  return { receivedAt: v.received_at, clientId: v.client_id, report: p.report };
}

/** spool のファイル名（受けた時刻の論理日ではなく、手元の暦日。hooks の spool と同じ） */
export function reportSpoolName(at: number): string {
  const d = new Date(at);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `report-${ymd}.jsonl`;
}
