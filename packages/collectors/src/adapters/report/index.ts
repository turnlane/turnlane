/**
 * report アダプタ（Turnlane 固有。ADR 0021）。`turnlane ai report`・MCP `report_ai_work`・`POST /api/ai/reports` が
 * spool に書いた `report-YYYYMMDD.jsonl` を読み、Claude Code・Codex の記録と同じ形（セッション・ターン・許可待ちの hook）に
 * 直す。その先の判定（5 状態・自分の番・待ちの区間・通知・放置）は既存のものがそのまま動く。
 *
 * 写し方（出どころ = セッションの tool、作業の ID = external_id、entrypoint = "report"）:
 * - started: 新しいターンを開く（そのセッションの前の開いたターンはシンクが閉じる）
 * - running: 開いているターンの最後の活動を進める（無ければ started と同じ）。待ちは「先に進んだ」として外れる
 * - waiting(question): ターンを開いたまま pendingQuestion（AskUserQuestion と同じ needs_input。返答タスクはすぐ）
 * - waiting(permission): ターンを開いたまま許可待ちの hook（PermissionRequest と同じ needs_input。許可のタスク）
 * - done: ターンを end_turn で閉じる / error: ターンを error で閉じる（再開のタスク）
 *
 * 1 つの spool のファイルの中の開いたターンは carry に覚える。別の日のファイルに続きが来たら、その報告の時刻で新しい
 * ターンを始め、前の開いたターンはシンクが閉じる（closeOpen）。client_id の同じ行は 1 回だけ。出どころ 1 つにつき
 * 1 分 60 件を超えた行は捨てる（ログは件数と出どころの名前だけ）
 */
import { pickAllowed } from "../../allowlist.ts";
import { defineAdapter, toolId } from "../../define.ts";
import { io } from "../../io.ts";
import { meta } from "../../logger.ts";
import { readJsonlIncremental } from "../../readers/jsonl.ts";
import {
  fromReportSpoolLine,
  REPORT_ENTRYPOINT,
  REPORT_LINE_KEYS,
  type ReportInput,
} from "../../report.ts";
import {
  ADAPTER_API_VERSION,
  type NormalizedEvent,
  type ReadContext,
  type StreamSpec,
  type TurnEvent,
} from "../../types.ts";
import { spoolDirOf } from "../hook-spool/index.ts";

export const REPORT_TOOL = toolId("report");
const PARSER_VERSION = 1;
const SPOOL_RE = /\/report-\d{8}\.jsonl$/;
/** 覚えておく client_id の数 */
const SEEN_MAX = 500;
/** 出どころ 1 つにつき 1 分にこれを超えたら捨てる */
export const REPORT_RATE_PER_MIN = 60;

interface OpenTurn {
  turnKey: string;
  startedAt: number;
  /** 待ちの種類（待っていなければ省略） */
  waiting?: "question" | "permission";
}

interface Carry {
  open: Record<string, OpenTurn>;
  seen: string[];
  /** 出どころ → [分, 件数] */
  rate: Record<string, [number, number]>;
}

const emptyCarry = (): Carry => ({ open: {}, seen: [], rate: {} });

function carryOf(v: unknown): Carry {
  if (!v || typeof v !== "object") return emptyCarry();
  const c = v as Partial<Carry>;
  return {
    open: { ...(c.open ?? {}) },
    seen: [...(c.seen ?? [])],
    rate: { ...(c.rate ?? {}) },
  };
}

/** 1 つの報告 → イベント */
function eventsOf(
  r: ReportInput,
  at: number,
  pos: { file: string; offset: number },
  carry: Carry,
  ctx: ReadContext,
): NormalizedEvent[] {
  const ref = { tool: toolId(r.source), externalId: r.id };
  const key = `${r.source}\u0000${r.id}`;
  const out: NormalizedEvent[] = [];
  out.push({
    kind: "session_seen",
    ref,
    at,
    startedAt: at,
    entrypoint: REPORT_ENTRYPOINT,
    ...(r.title && ctx.privacy.storeTitles ? { title: r.title, titleSource: "session_name" } : {}),
    ...(r.project ? { project: r.project } : {}),
    ...(r.url ? { openUrl: r.url } : {}),
  });
  const prev = carry.open[key];
  const fresh = (): OpenTurn => ({ turnKey: `r:${pos.file}:${pos.offset}`, startedAt: at });
  // 新しいターン（started、または開いたターンを知らない続きの報告）は、前の開いたターンをシンクに閉じさせる
  let open: OpenTurn;
  let closeOpen = false;
  if (r.state === "started" || !prev) {
    open = fresh();
    closeOpen = true;
  } else open = prev;
  const turn = (t: Partial<TurnEvent> & Pick<TurnEvent, "status">): TurnEvent => ({
    kind: "turn",
    ref,
    turnKey: open.turnKey,
    startedAt: open.startedAt,
    initiator: "system",
    lastActivityAt: at,
    ...(closeOpen ? { closeOpen: true } : {}),
    ...t,
  });
  switch (r.state) {
    case "started":
    case "running": {
      out.push(turn({ status: "running" }));
      carry.open[key] = { turnKey: open.turnKey, startedAt: open.startedAt };
      break;
    }
    case "waiting": {
      const w = r.wait;
      if (!w) break;
      const detail = ctx.privacy.storeDetails
        ? {
            reportWait: {
              kind: w.kind,
              text: w.text,
              ...(w.options ? { options: w.options } : {}),
              ...(w.label ? { label: w.label } : {}),
            },
          }
        : {};
      if (w.kind === "question") {
        out.push(turn({ status: "running", pendingQuestion: true, ...detail }));
      } else {
        out.push(turn({ status: "running", ...detail }));
        out.push({
          kind: "hook",
          ref,
          at,
          name: "PermissionRequest",
          toolName: w.label ?? "permission",
          source: REPORT_ENTRYPOINT,
          spool: pos,
        });
      }
      carry.open[key] = { turnKey: open.turnKey, startedAt: open.startedAt, waiting: w.kind };
      break;
    }
    case "done":
    case "error": {
      const error = r.state === "error";
      out.push(
        turn({
          status: error ? "error" : "completed",
          endedAt: at,
          durationMs: Math.max(0, at - open.startedAt),
          endedWith: error ? "error" : "end_turn",
        }),
      );
      delete carry.open[key];
      break;
    }
  }
  return out;
}

export default defineAdapter({
  apiVersion: ADAPTER_API_VERSION,
  tool: REPORT_TOOL,
  displayName: "Reports",
  parserId: "report.v1",
  parserVersion: PARSER_VERSION,
  testedVersions: "*",
  capabilities: {
    liveStatus: false,
    turns: true,
    tokens: false,
    gitBranch: false,
    prLinks: false,
    hooks: false,
  },
  // 報告は止まらずに長く動く作業（バッチ・定期の仕事）なので、最後の報告から 1 日は実行中のままにする
  timing: { runningStaleMs: 24 * 3_600_000 },
  allowlist: { line: REPORT_LINE_KEYS },

  async detect(env) {
    // spool はまだ無くてもよい（最初の報告で作られる）
    return [{ tool: REPORT_TOOL, rootPath: spoolDirOf(env), profileLabel: "spool", evidence: [] }];
  },

  watch(root) {
    return [
      {
        dir: root.rootPath,
        recursive: false,
        match: (p) => SPOOL_RE.test(p),
        reconcileEveryMs: 60_000,
      },
    ];
  },

  async listStreams(root, opts) {
    const out: StreamSpec[] = [];
    for (const e of io.readdir(root.rootPath)) {
      const p = `${root.rootPath}/${e.name}`;
      if (!e.isFile() || !SPOOL_RE.test(p)) continue;
      if (opts.sinceMs !== undefined && (io.stat(p)?.mtimeMs ?? 0) < opts.sinceMs) continue;
      out.push({ key: e.name, kind: "jsonl", path: p, priority: "live" });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  },

  streamFor(root, absPath) {
    if (!absPath.startsWith(`${root.rootPath}/`) || !SPOOL_RE.test(absPath)) return null;
    return {
      key: absPath.slice(root.rootPath.length + 1),
      kind: "jsonl",
      path: absPath,
      priority: "live",
    };
  },

  async read(stream, cursor, ctx) {
    const stats = { records: 0, skipped: 0, unknownTypes: 0, missingRequired: 0 };
    const chunk = readJsonlIncremental(stream.path, cursor, { maxBytes: ctx.maxBytes });
    if (!chunk) {
      return {
        events: [],
        next: cursor ?? { byteOffset: 0, parserVersion: PARSER_VERSION },
        stats,
        done: true,
        missing: true,
      };
    }
    const carry = chunk.reset ? emptyCarry() : carryOf(cursor?.carry);
    const seen = new Set(carry.seen);
    const limited = new Set<string>();
    const events: NormalizedEvent[] = [];
    for (const line of chunk.lines) {
      if (!line.value || typeof line.value !== "object") {
        stats.skipped++;
        continue;
      }
      const v = fromReportSpoolLine(pickAllowed(line.value, REPORT_LINE_KEYS));
      stats.records++;
      if (!v) {
        stats.missingRequired++;
        continue;
      }
      // 同じ client_id は 1 回だけ（再送）
      if (seen.has(v.clientId)) {
        stats.skipped++;
        continue;
      }
      seen.add(v.clientId);
      carry.seen.push(v.clientId);
      if (carry.seen.length > SEEN_MAX) carry.seen.splice(0, carry.seen.length - SEEN_MAX);
      // 出どころごとの上限（受けた時刻の 1 分ごと）
      const minute = Math.floor(v.receivedAt / 60_000);
      const [m, n] = carry.rate[v.report.source] ?? [minute, 0];
      const count = m === minute ? n + 1 : 1;
      carry.rate[v.report.source] = [minute, count];
      if (count > REPORT_RATE_PER_MIN) {
        stats.skipped++;
        if (!limited.has(v.report.source)) {
          limited.add(v.report.source);
          ctx.log.warn("report.rate_limited", { source: meta(v.report.source) });
        }
        continue;
      }
      // 時刻: 報告の at（未来は受けた時刻に丸める）。無ければ受けた時刻
      const at = Math.min(v.report.at ?? v.receivedAt, v.receivedAt);
      events.push(...eventsOf(v.report, at, { file: stream.key, offset: line.offset }, carry, ctx));
    }
    return {
      events,
      next: { ...chunk.next, carry, parserVersion: PARSER_VERSION },
      stats,
      done: chunk.done,
    };
  },
});
