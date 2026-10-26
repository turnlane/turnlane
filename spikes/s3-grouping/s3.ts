// スパイク S3: 実データでのターン分割・WorkItem グルーピング・状態判定・フォローアップ生成の試算。
// 使い捨て。本番コードではない。
//
// 使い方:
//   bun run spikes/s3-grouping/s3.ts <出力ディレクトリ（リポジトリの外）> [--no-gh]
//
// 出力:
//   <out>/detail.json  WorkItem ごとの明細（repo 名・ブランチ名・ツール生成タイトルを含む。個人データなのでコミットしない）
//   <out>/stats.json   統計のみ（個人データを含まない）
//
// プライバシー:
//   - 会話本文（message.content の text、prompt、last_agent_message 等）は、
//     「質問で終わるか」「中断マーカーか」の真偽値をその場で求めるためだけに参照し、保持・出力しない。
//   - tool_use は name と id だけを読む（input は読まない）。
//   - auth.json / *.key / Cookies / *token* 等は開かない。sessions/ は *.json だけを読む。
//   - 書き込みは <out> だけ。git は読み取り系コマンドのみ（status は --no-optional-locks）。

import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// ---------- 設定 ----------
const HOME = process.env.HOME!;
const TZ_OFFSET_MS = 9 * 3600_000; // Asia/Tokyo 固定（DST なし）
const DAY_BOUNDARY_MS = 4 * 3600_000; // 日付の区切り 04:00
const WINDOW_DAYS = 7;
const RUNNING_FRESH_MS = { claude_code: 5 * 60_000, codex: 10 * 60_000 } as const;
const DONE_AFTER_MS = 24 * 3600_000;
const WAIT_CAP_MS = 24 * 3600_000;
const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop']);

const OUT = process.argv[2];
const USE_GH = !process.argv.includes('--no-gh');
if (!OUT) {
  console.error('usage: bun run s3.ts <outdir> [--no-gh]');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const NOW = Date.now();
const laneDate = (ms: number) => new Date(ms + TZ_OFFSET_MS - DAY_BOUNDARY_MS).toISOString().slice(0, 10);
const TODAY = laneDate(NOW);
const WINDOW_START = Date.parse(`${TODAY}T00:00:00Z`) - (WINDOW_DAYS - 1) * 86400_000 - TZ_OFFSET_MS + DAY_BOUNDARY_MS;

// ---------- 本文を保持しない判定 ----------
const QUESTION_TAIL = /([?？]|しますか|でしょうか|ますか|ですか|どちら(が|に|を)[^。]*$|いかがですか|よろしいですか|ください)\s*$/;
function endsWithQuestion(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim().replace(/[`*_\s]+$/g, '');
  if (!t) return false;
  const tail = t.slice(-80);
  return QUESTION_TAIL.test(tail);
}
function isInterruptMarker(content: unknown): boolean {
  const first = Array.isArray(content) ? content.find((c: any) => c?.type === 'text')?.text : content;
  return typeof first === 'string' && first.startsWith('[Request interrupted');
}

// ---------- 型 ----------
type Tool = 'claude_code' | 'codex';
interface Turn {
  tool: Tool;
  sid: string;
  key: string;
  idx: number;
  startedAt: number;
  endedAt?: number;
  lastTs: number;
  durationMs?: number;
  durationSource: 'turn_duration' | 'task_complete' | 'fallback' | 'none';
  turnDurationCount: number;
  status: 'running' | 'completed' | 'interrupted' | 'error';
  errorType?: string;
  initiator: 'human' | 'queued' | 'system' | 'suggestion';
  startBranch?: string;
  endBranch?: string;
  startCwd?: string;
  endCwd?: string;
  edits: number;
  toolCalls: number;
  askOpen: Set<string>;
  askUsed?: boolean;
  endedWithQuestion: boolean;
  lastStop?: string;
  prs: string[]; // "owner/repo#n"
  branchMs: Record<string, number>; // ターン内でブランチごとに過ごした時間（レコード間隔で按分）
  _prevTs?: number;
  _prevBranch?: string;
}
interface Session {
  tool: Tool;
  sid: string;
  root: string; // 設定ディレクトリのラベル
  file: string;
  entrypoint?: string;
  titles: { at: number; title: string }[];
  titleSource?: string;
  archived: boolean;
  turns: Turn[];
  prs: Map<string, number>; // ref -> first seen
  subagentFiles: number;
  live?: { status: string; alive: boolean };
  originator?: string;
  hasUserEvent?: boolean;
}

const stats: any = {
  generatedAt: new Date(NOW).toISOString(),
  window: { start: new Date(WINDOW_START).toISOString(), days: WINDOW_DAYS, today: TODAY },
  sources: {},
  claude: { userRecordsByOrigin: {}, turnsInWindow: 0, turnDurationPresent: 0, turnDurationMulti: 0, endedNoTurnDuration: 0, unendedTurns: 0, branchChangedWithinTurn: 0, cwdChangedWithinTurn: 0, initiators: {}, interrupted: 0, apiError: 0, askUserQuestionTurns: 0, questionEndTurns: 0, prLinkRecords: 0, prLinkFirstOccurrences: 0, askUsedTurns: 0, distinctPrs: 0, subagentFiles: 0 },
  codex: { sqlite: {}, turnsInWindow: 0, taskCompletePresent: 0, aborted: 0, abortedReasons: {}, branchSource: {}, questionEndTurns: 0 },
  repo: { cwdResolved: 0, cwdMissing: 0, cwdMissingRecoveredByParent: 0, nonGit: 0, worktreeCwd: 0 },
};
const inc = (o: any, k: string, n = 1) => (o[k] = (o[k] ?? 0) + n);

// ---------- 検出 ----------
function detectClaudeRoots() {
  const roots: { path: string; label: string }[] = [];
  const excluded: { label: string; reason: string }[] = [];
  const cands = new Set<string>();
  if (process.env.CLAUDE_CONFIG_DIR) cands.add(process.env.CLAUDE_CONFIG_DIR);
  for (const n of readdirSync(HOME)) if (n === '.claude' || n.startsWith('.claude-')) cands.add(join(HOME, n));
  for (const p of cands) {
    if (!existsSync(join(p, 'projects'))) continue;
    const label = basename(p).replace(/^\.claude-?/, '') || 'default';
    if (/work/i.test(label)) {
      excluded.push({ label: 'profile-with-work-in-name', reason: '勤務先用と思われるため対象外（依頼の指示）' });
      continue;
    }
    roots.push({ path: p, label });
  }
  return { roots, excluded };
}

function walk(dir: string, pred: (p: string) => boolean, out: string[] = []): string[] {
  let ents: import('node:fs').Dirent[];
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}

// ---------- Claude Code ----------
function parseClaudeSession(file: string, rootLabel: string): Session | null {
  const sid = basename(file, '.jsonl');
  const s: Session = { tool: 'claude_code', sid, root: rootLabel, file, titles: [], archived: false, turns: [], prs: new Map(), subagentFiles: 0 };
  const subDir = join(dirname(file), sid, 'subagents');
  if (existsSync(subDir)) s.subagentFiles = readdirSync(subDir).filter((n) => n.endsWith('.jsonl')).length;
  let cur: Turn | null = null;
  let idx = 0;
  const text = readFileSync(file, 'utf8');
  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0) nl = text.length;
    const line = text.slice(pos, nl);
    pos = nl + 1;
    if (!line) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = r.timestamp ? Date.parse(r.timestamp) : undefined;
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string') {
      s.titles.push({ at: cur?.lastTs ?? 0, title: r.aiTitle });
      continue;
    }
    if (r.type === 'pr-link' && r.prRepository && r.prNumber) {
      stats.claude.prLinkRecords++;
      const ref = `${r.prRepository}#${r.prNumber}`;
      // pr-link はセッション中に何度も再出力される。初出のターンだけに紐付ける
      if (!s.prs.has(ref)) {
        s.prs.set(ref, ts ?? cur?.lastTs ?? 0);
        stats.claude.prLinkFirstOccurrences++;
        if (cur) cur.prs.push(ref);
      }
      continue;
    }
    if (r.isSidechain) continue;
    if (r.entrypoint && !s.entrypoint) s.entrypoint = r.entrypoint;
    if (r.type === 'user') {
      const ok = r.origin?.kind ?? 'none';
      inc(stats.claude.userRecordsByOrigin, ok);
      if ((ok === 'human' || ok === 'task-notification') && ts) {
        if (cur) closeClaudeTurn(cur);
        const ps = r.promptSource;
        cur = {
          tool: 'claude_code', sid, key: r.promptId ?? r.uuid, idx: idx++, startedAt: ts, lastTs: ts,
          durationSource: 'none', turnDurationCount: 0, status: 'running',
          initiator: ok === 'task-notification' ? 'system' : ps === 'queued' ? 'queued' : ps === 'suggestion_accepted' ? 'suggestion' : 'human',
          startBranch: r.gitBranch, endBranch: r.gitBranch, startCwd: r.cwd, endCwd: r.cwd,
          edits: 0, toolCalls: 0, askOpen: new Set(), endedWithQuestion: false, prs: [], branchMs: {}, _prevTs: ts, _prevBranch: r.gitBranch,
        };
        s.turns.push(cur);
        continue;
      }
      if (!cur) continue;
      if (Array.isArray(r.message?.content)) {
        for (const c of r.message.content) if (c?.type === 'tool_result' && c.tool_use_id) cur.askOpen.delete(c.tool_use_id);
      }
      if (isInterruptMarker(r.message?.content)) cur.status = 'interrupted';
      if (ts) cur.lastTs = ts;
      continue;
    }
    if (!cur) continue;
    if (ts && r.gitBranch && r.type !== 'attachment') {
      if (cur._prevTs !== undefined && cur._prevBranch) cur.branchMs[cur._prevBranch] = (cur.branchMs[cur._prevBranch] ?? 0) + Math.max(0, ts - cur._prevTs);
      cur._prevTs = ts;
      cur._prevBranch = r.gitBranch;
    }
    if (r.gitBranch) cur.endBranch = r.gitBranch;
    if (r.cwd) cur.endCwd = r.cwd;
    if (r.type === 'assistant') {
      if (ts) cur.lastTs = ts;
      const m = r.message ?? {};
      if (m.stop_reason) cur.lastStop = m.stop_reason;
      if (r.isApiErrorMessage) {
        cur.status = 'error';
        cur.errorType = typeof r.error === 'string' ? r.error : 'api_error';
      }
      if (Array.isArray(m.content)) {
        let sawText = false;
        let q = false;
        for (const c of m.content) {
          if (c?.type === 'tool_use') {
            cur.toolCalls++;
            if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name)) cur.edits++;
            if (c.name === 'AskUserQuestion' && c.id) {
              cur.askOpen.add(c.id);
              cur.askUsed = true;
            }
          } else if (c?.type === 'text') {
            sawText = true;
            q = endsWithQuestion(c.text); // 真偽値だけを残す
          }
        }
        if (sawText) cur.endedWithQuestion = q;
        if (m.stop_reason === 'end_turn' && ts && cur.durationSource === 'none') cur.endedAt = ts;
      }
      continue;
    }
    if (r.type === 'system' && r.subtype === 'turn_duration' && typeof r.durationMs === 'number') {
      cur.turnDurationCount++;
      cur.durationMs = (cur.turnDurationCount > 1 ? cur.durationMs ?? 0 : 0) + r.durationMs;
      cur.durationSource = 'turn_duration';
      if (ts) {
        cur.endedAt = ts;
        cur.lastTs = ts;
      }
      continue;
    }
    if (ts && r.type !== 'attachment') cur.lastTs = Math.max(cur.lastTs, ts);
  }
  if (cur) closeClaudeTurn(cur, true);
  return s;
}
function closeClaudeTurn(t: Turn, isLast = false) {
  if (t.status === 'running') {
    if (t.durationSource === 'turn_duration' || t.lastStop === 'end_turn') t.status = 'completed';
    else if (!isLast) t.status = 'interrupted';
  }
  if (t.durationSource === 'none' && t.status !== 'running') {
    t.durationSource = 'fallback';
    t.endedAt = t.endedAt ?? t.lastTs;
    t.durationMs = Math.max(0, (t.endedAt ?? t.lastTs) - t.startedAt);
  }
}

// ---------- Claude Desktop ----------
function readDesktop() {
  const dir = join(HOME, 'Library/Application Support/Claude/claude-code-sessions');
  const map = new Map<string, { title?: string; titleSource?: string; archived: boolean; prs: string[]; lastActivityAt?: number }>();
  const files = walk(dir, (p) => /\/local_[^/]+\.json$/.test(p));
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      if (!j.cliSessionId) continue;
      const prs: string[] = [];
      for (const p of j.prs ?? []) if (p?.prRepository && p?.prNumber) prs.push(`${p.prRepository}#${p.prNumber}`);
      if (j.prRepository && j.prNumber) prs.push(`${j.prRepository}#${j.prNumber}`);
      map.set(j.cliSessionId, { title: j.title, titleSource: j.titleSource, archived: !!j.isArchived, prs, lastActivityAt: j.lastActivityAt });
    } catch {}
  }
  const inWindow = [...map.values()].filter((v) => (v.lastActivityAt ?? 0) >= WINDOW_START).length;
  stats.sources.claudeDesktop = { localFiles: files.length, withCliSessionId: map.size, activeInWindow: inWindow };
  return map;
}

// ---------- Codex ----------
function tryCodexSqlite() {
  const res: Record<string, string> = {};
  for (const n of ['state_5.sqlite', 'thread_history_1.sqlite']) {
    const p = join(HOME, '.codex', n);
    if (!existsSync(p)) {
      res[n] = 'missing';
      continue;
    }
    try {
      const db = new Database(p, { readonly: true });
      const row = db.query("select count(*) as c from sqlite_master where type='table'").get() as any;
      res[n] = `ok(tables=${row?.c})`;
      db.close();
    } catch (e: any) {
      res[n] = `fail: ${String(e?.message ?? e).slice(0, 80)}`;
    }
  }
  stats.codex.sqlite = res;
  return Object.values(res).every((v) => v.startsWith('ok'));
}

function parseCodexRollout(file: string, archived: boolean, names: Map<string, string>): Session | null {
  const text = readFileSync(file, 'utf8');
  let s: Session | null = null;
  const turns = new Map<string, Turn>();
  let cwd: string | undefined;
  let idx = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const p = r.payload ?? {};
    if (r.type === 'session_meta') {
      const id = p.id ?? p.session_id;
      s = { tool: 'codex', sid: id, root: 'codex', file, titles: [], archived, turns: [], prs: new Map(), subagentFiles: 0, originator: p.originator, hasUserEvent: false };
      const nm = names.get(id);
      if (nm) s.titles.push({ at: 0, title: nm });
      s.titleSource = nm ? 'thread_name' : undefined;
      cwd = p.cwd;
      if (typeof p.source === 'object' && p.source?.subagent) s.originator = `subagent:${JSON.stringify(p.source.subagent).slice(0, 40)}`;
      continue;
    }
    if (!s) continue;
    if (r.type === 'turn_context') {
      if (p.cwd) cwd = p.cwd;
      const t = turns.get(p.turn_id);
      if (t) t.endCwd = cwd;
      continue;
    }
    if (r.type !== 'event_msg') continue;
    if (p.type === 'task_started') {
      const t: Turn = {
        tool: 'codex', sid: s.sid, key: p.turn_id, idx: idx++, startedAt: p.started_at * 1000, lastTs: p.started_at * 1000,
        durationSource: 'none', turnDurationCount: 0, status: 'running', initiator: 'human', startCwd: cwd, endCwd: cwd,
        edits: 0, toolCalls: 0, askOpen: new Set(), endedWithQuestion: false, prs: [], branchMs: {},
      };
      turns.set(p.turn_id, t);
      s.turns.push(t);
    } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
      const t = turns.get(p.turn_id);
      if (!t) continue;
      t.endedAt = (p.completed_at ?? 0) * 1000 || t.lastTs;
      t.lastTs = t.endedAt;
      t.durationMs = p.duration_ms;
      t.durationSource = 'task_complete';
      if (p.type === 'task_complete') {
        t.status = 'completed';
        t.endedWithQuestion = endsWithQuestion(p.last_agent_message); // 真偽値だけ
      } else {
        t.status = 'interrupted';
        inc(stats.codex.abortedReasons, String(p.reason));
        stats.codex.aborted++;
      }
    } else if (p.type === 'item_completed') {
      const it = p.item ?? {};
      const t = [...turns.values()].at(-1);
      if (it.type === 'UserMessage') s.hasUserEvent = true;
      if (!t) continue;
      if (it.type === 'FileChange') t.edits++;
      if (['CommandExecution', 'FileChange', 'McpToolCall', 'ImageView'].includes(it.type)) t.toolCalls++;
      const ts = r.timestamp ? Date.parse(r.timestamp) : undefined;
      if (ts && t.status === 'running') t.lastTs = Math.max(t.lastTs, ts);
    }
  }
  return s;
}

// ---------- git ----------
function git(dir: string, ...args: string[]): string | null {
  const r = Bun.spawnSync(['git', '--no-optional-locks', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}
const repoCache = new Map<string, { repo: string | null; worktree: boolean; recovered: boolean; missing: boolean }>();
function resolveRepo(cwd: string | undefined) {
  if (!cwd) return { repo: null, worktree: false, recovered: false, missing: true };
  const hit = repoCache.get(cwd);
  if (hit) return hit;
  let dir = cwd;
  let missing = false;
  let recovered = false;
  while (!existsSync(dir) && dir !== '/') {
    missing = true;
    dir = dirname(dir);
  }
  let res = { repo: null as string | null, worktree: false, recovered: false, missing };
  const top = git(dir, 'rev-parse', '--show-toplevel');
  if (top) {
    const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const mainRoot = common && common.endsWith('/.git') ? dirname(common) : top;
    recovered = missing;
    res = { repo: mainRoot, worktree: mainRoot !== top, recovered, missing };
  }
  repoCache.set(cwd, res);
  return res;
}
const defaultBranchCache = new Map<string, string | null>();
function defaultBranch(repo: string) {
  if (!defaultBranchCache.has(repo)) {
    const r = git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
    defaultBranchCache.set(repo, r ? r.replace(/^origin\//, '') : null);
  }
  return defaultBranchCache.get(repo)!;
}
function isDefault(repo: string, branch: string | undefined) {
  if (!branch || branch === 'HEAD') return true;
  return DEFAULT_BRANCHES.has(branch) || branch === defaultBranch(repo);
}
const branchInfoCache = new Map<string, { exists: boolean; mergedIntoDefault: boolean | null }>();
function branchInfo(repo: string, branch: string) {
  const k = `${repo}#${branch}`;
  if (!branchInfoCache.has(k)) {
    const exists = git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`) !== null;
    let merged: boolean | null = null;
    const def = defaultBranch(repo) ?? 'main';
    if (exists) {
      const r = Bun.spawnSync(['git', '--no-optional-locks', '-C', repo, 'merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${def}`]);
      merged = r.exitCode === 0 ? true : r.exitCode === 1 ? false : null;
    }
    branchInfoCache.set(k, { exists, mergedIntoDefault: merged });
  }
  return branchInfoCache.get(k)!;
}

// ---------- gh ----------
const prCache = new Map<string, { state: string; headRefName?: string; reviewDecision?: string; reviewsByAuthor?: number } | null>();
function prInfo(ref: string) {
  if (prCache.has(ref)) return prCache.get(ref)!;
  let v: any = null;
  if (USE_GH) {
    const [repo, num] = ref.split('#');
    const r = Bun.spawnSync(['gh', 'pr', 'view', num, '-R', repo, '--json', 'state,headRefName,reviewDecision,reviews,author'], { stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
    if (r.exitCode === 0) {
      try {
        const j = JSON.parse(r.stdout.toString());
        // reviews の本文は読まない。author の一致数だけ数える
        const me = j.author?.login;
        const byOthers = (j.reviews ?? []).filter((x: any) => x?.author?.login && x.author.login !== me).length;
        v = { state: j.state, headRefName: j.headRefName, reviewDecision: j.reviewDecision || undefined, reviewsByOthers: byOthers };
      } catch {}
    }
  }
  prCache.set(ref, v);
  return v;
}

// ---------- 収集 ----------
const { roots, excluded } = detectClaudeRoots();
stats.sources.claudeRoots = roots.map((r) => r.label);
stats.sources.claudeExcluded = excluded;
const desktop = readDesktop();
const sessions: Session[] = [];
for (const root of roots) {
  const files = walk(join(root.path, 'projects'), (p) => p.endsWith('.jsonl') && !p.includes('/subagents/'));
  let considered = 0;
  for (const f of files) {
    if (statSync(f).mtimeMs < WINDOW_START) continue;
    considered++;
    const s = parseClaudeSession(f, root.label);
    if (!s) continue;
    const d = desktop.get(s.sid);
    if (d) {
      if (d.title) s.titles.push({ at: Number.MAX_SAFE_INTEGER, title: d.title });
      s.titleSource = 'desktop';
      s.archived = d.archived;
      for (const p of d.prs) if (!s.prs.has(p)) s.prs.set(p, 0);
    }
    stats.claude.subagentFiles += s.subagentFiles;
    sessions.push(s);
  }
  // ライブ状態（*.json だけを読む。*.key は開かない）
  const sd = join(root.path, 'sessions');
  if (existsSync(sd)) {
    for (const n of readdirSync(sd)) {
      if (!/^\d+\.json$/.test(n)) continue;
      try {
        const j = JSON.parse(readFileSync(join(sd, n), 'utf8'));
        let alive = false;
        try {
          process.kill(j.pid, 0);
          alive = true;
        } catch {}
        const s = sessions.find((x) => x.sid === j.sessionId);
        if (s) s.live = { status: j.status, alive };
      } catch {}
    }
  }
  stats.sources[`claudeRoot:${root.label}`] = { transcripts: files.length, touchedInWindow: considered };
}

const sqliteOk = tryCodexSqlite();
stats.codex.path = sqliteOk ? 'sqlite(not used in this spike; JSONL parsed for parity)' : 'jsonl-fallback';
{
  const names = new Map<string, string>();
  const idxFile = join(HOME, '.codex', 'session_index.jsonl');
  if (existsSync(idxFile)) {
    for (const l of readFileSync(idxFile, 'utf8').split('\n')) {
      try {
        const j = JSON.parse(l);
        if (j.id && j.thread_name) names.set(j.id, j.thread_name);
      } catch {}
    }
  }
  const live = walk(join(HOME, '.codex', 'sessions'), (p) => /rollout-.*\.jsonl$/.test(p));
  const arch = walk(join(HOME, '.codex', 'archived_sessions'), (p) => /rollout-.*\.jsonl$/.test(p));
  let n = 0;
  for (const [list, archived] of [[live, false], [arch, true]] as const) {
    for (const f of list) {
      if (statSync(f).mtimeMs < WINDOW_START) continue;
      const s = parseCodexRollout(f, archived, names);
      if (s) {
        sessions.push(s);
        n++;
      }
    }
  }
  stats.sources.codex = { rolloutFiles: live.length, archivedFiles: arch.length, touchedInWindow: n, sessionIndexNames: names.size };
}

// ---------- ターン → WorkItem ----------
interface TurnRow { t: Turn; s: Session; repo: string | null; branch?: string; branchDom?: string; keyA: string; keyC: string; date: string; prRefs: string[] }
const rows: TurnRow[] = [];
const keyFor = (s: Session, repo: string | null, branch: string | undefined) =>
  !repo || isDefault(repo, branch) ? `session:${s.tool}:${s.sid}` : `branch:${repo}#${branch}`;
for (const s of sessions) {
  // 窓内のターンだけ
  for (const t of s.turns) {
    if (t.startedAt < WINDOW_START) continue;
    const cwd = t.endCwd ?? t.startCwd;
    const rr = resolveRepo(cwd);
    if (rr.missing) stats.repo.cwdMissing++;
    if (rr.recovered) stats.repo.cwdMissingRecoveredByParent++;
    if (!rr.repo) stats.repo.nonGit++;
    else stats.repo.cwdResolved++;
    if (rr.worktree) stats.repo.worktreeCwd++;
    let branch = t.endBranch;
    let branchDom = Object.entries(t.branchMs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? branch;
    if (s.tool === 'codex') {
      // Desktop 起動の Codex は session_meta.git が無い → 現在のブランチで補完（推定）
      const b = cwd && existsSync(cwd) ? git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD') : null;
      branch = b ?? undefined;
      branchDom = branch;
      inc(stats.codex.branchSource, b ? 'git_current_head(estimated)' : 'unknown');
    }
    t.endBranch = branch;
    // 規則 A（phase0-plan 3.3 をそのまま。ターンのブランチ = ターン終了時の gitBranch）
    const keyA = keyFor(s, rr.repo, branch);
    // 規則 C（調整案）: ターンのブランチ = ターン内で最も長く過ごしたブランチ
    const keyC = keyFor(s, rr.repo, branchDom);
    rows.push({ t, s, repo: rr.repo, branch, branchDom, keyA, keyC, date: laneDate(t.startedAt), prRefs: t.prs });
  }
}
// PR の初出ターン
const prFirst = new Map<string, TurnRow>();
for (const r of rows) for (const p of r.prRefs) if (!prFirst.has(p)) prFirst.set(p, r);
// PR → WorkItem の帰属: gh の headRefName が分かり、そのブランチの WorkItem があればそこ。無ければ初出ターンの WorkItem
function prOwners(keyOf: (r: TurnRow) => string, keys: Set<string>) {
  const owner = new Map<string, string>();
  const how: Record<string, number> = {};
  for (const [ref, r] of prFirst) {
    const head = prInfo(ref)?.headRefName;
    const k = r.repo && head ? `branch:${r.repo}#${head}` : null;
    if (k && keys.has(k)) {
      owner.set(ref, k);
      inc(how, k === keyOf(r) ? 'head_match_same_as_first_turn' : 'head_match_moved');
    } else {
      owner.set(ref, keyOf(r));
      inc(how, head ? 'head_branch_not_in_window_first_turn' : 'no_head_info_first_turn');
    }
  }
  return { owner, how };
}

// ターン統計
for (const r of rows) {
  const t = r.t;
  if (t.tool === 'claude_code') {
    const c = stats.claude;
    c.turnsInWindow++;
    inc(c.initiators, t.initiator);
    if (t.durationSource === 'turn_duration') c.turnDurationPresent++;
    if (t.turnDurationCount > 1) c.turnDurationMulti++;
    if (t.status !== 'running' && t.durationSource !== 'turn_duration') c.endedNoTurnDuration++;
    if (t.status === 'running') c.unendedTurns++;
    if (t.startBranch !== t.endBranch) c.branchChangedWithinTurn++;
    if (t.startCwd !== t.endCwd) c.cwdChangedWithinTurn++;
    if (t.status === 'interrupted') c.interrupted++;
    if (t.status === 'error') c.apiError++;
    if (t.askOpen.size) c.askUserQuestionTurns++;
    if (t.askUsed) c.askUsedTurns++;
    if (t.endedWithQuestion) c.questionEndTurns++;
  } else {
    stats.codex.turnsInWindow++;
    if (t.durationSource === 'task_complete') stats.codex.taskCompletePresent++;
    if (t.endedWithQuestion) stats.codex.questionEndTurns++;
  }
}
stats.claude.aiTitleDistinctPerSession = {};
for (const se of sessions.filter((x) => x.tool === 'claude_code')) inc(stats.claude.aiTitleDistinctPerSession, String(new Set(se.titles.map((t) => t.title)).size));
stats.claude.distinctPrs = new Set(sessions.flatMap((s) => [...s.prs.keys()])).size;
stats.claude.turnDurationByInitiator = {};
for (const r of rows.filter((r) => r.t.tool === 'claude_code')) {
  const k = `${r.t.initiator}:${r.t.durationSource}`;
  inc(stats.claude.turnDurationByInitiator, k);
}

// ---------- WorkItem 化・状態・フォローアップ ----------
const PRIO = { error: 5, needs_input: 4, running: 3, your_turn: 2, done: 1 } as const;
type St = keyof typeof PRIO;

function buildItems(keyOf: (r: TurnRow) => string) {
  const items = new Map<string, TurnRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!items.has(k)) items.set(k, []);
    items.get(k)!.push(r);
  }
  return items;
}

// セッションの全ターン（窓外も含む）で「このターンより後に人間入力があるか」
function nextHumanAfter(s: Session, t: Turn): Turn | undefined {
  return s.turns.find((x) => x.idx > t.idx && x.initiator !== 'system');
}

function deriveItem(key: string, trs: TurnRow[], ownedPrs: string[]) {
  const bySession = new Map<string, TurnRow[]>();
  for (const r of trs) {
    const k = `${r.s.tool}:${r.s.sid}`;
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k)!.push(r);
  }
  const prRefs = ownedPrs;
  // ブランチ単位の WorkItem は、そのブランチを head に持つ PR も属性として拾う（セッションの pr-link から）
  const prStates = prRefs.map((p) => ({ ref: p, info: prInfo(p) }));
  const openPr = prStates.some((p) => p.info?.state === 'OPEN');
  const allPrClosed = prStates.length > 0 && prStates.every((p) => p.info && p.info.state !== 'OPEN');
  let best: { st: St; reason: string } | null = null;
  const sessReasons: string[] = [];
  const ambiguity = new Set<string>();
  for (const [, srows] of bySession) {
    const s = srows[0].s;
    const last = srows.at(-1)!.t;
    const nxt = nextHumanAfter(s, last);
    const lastTurnOfSession = s.turns.at(-1) === last;
    const ended = last.status !== 'running';
    const endAt = last.endedAt ?? last.lastTs;
    let st: St;
    let reason: string;
    if (s.archived) {
      st = 'done';
      reason = 'done_archived';
    } else if (last.status === 'error' && !nxt) {
      st = 'error';
      reason = 'error_api';
    } else if (last.askOpen.size && !nxt) {
      st = 'needs_input';
      reason = 'needs_input_ask_pending';
    } else if (!ended && lastTurnOfSession && s.live?.alive && s.live.status === 'idle') {
      st = 'needs_input';
      reason = 'needs_input_live_idle_unfinished';
    } else if (lastTurnOfSession && s.live?.alive && s.live.status === 'busy') {
      st = 'running';
      reason = 'running_live_busy';
    } else if (!ended && NOW - last.lastTs < RUNNING_FRESH_MS[s.tool]) {
      st = 'running';
      reason = 'running_recent_update';
    } else if (allPrClosed) {
      st = 'done';
      reason = prStates.some((p) => p.info?.state === 'MERGED') ? 'done_pr_merged' : 'done_pr_closed';
    } else if (openPr) {
      st = 'your_turn';
      reason = 'your_turn_open_pr';
    } else if (nxt) {
      // 同じセッションで後から人間が入力した＝この WorkItem の返答待ちは解消済み
      st = 'done';
      reason = 'done_moved_on';
      if (last.edits > 0) ambiguity.add('moved_on_with_edits');
    } else if (!ended) {
      st = 'done';
      reason = NOW - endAt > DONE_AFTER_MS ? 'done_unfinished_stale' : 'done_unfinished_recent';
      ambiguity.add('unfinished_last_turn');
    } else if (last.status === 'interrupted') {
      st = NOW - endAt > DONE_AFTER_MS ? 'done' : 'your_turn';
      reason = st === 'done' ? 'done_interrupted_stale' : 'your_turn_interrupted';
      ambiguity.add('interrupted_last_turn');
    } else if (last.endedWithQuestion) {
      st = 'your_turn';
      reason = 'your_turn_question';
    } else if (last.edits > 0) {
      st = 'your_turn';
      reason = 'your_turn_edits';
    } else if (NOW - endAt > DONE_AFTER_MS) {
      st = 'done';
      reason = 'done_timeout_24h';
    } else {
      st = 'done';
      reason = 'gap_no_signal_lt24h';
      ambiguity.add('spec_gap_no_signal_within_24h');
    }
    sessReasons.push(reason);
    if (!best || PRIO[st] > PRIO[best.st]) best = { st, reason };
  }
  if (!best) throw new Error('no session');
  if (bySession.size > 1) ambiguity.add('multi_session');
  const tools = new Set(trs.map((r) => r.s.tool));
  if (tools.size > 1) ambiguity.add('multi_tool');
  if (trs.some((r) => r.t.startBranch !== r.t.endBranch)) ambiguity.add('branch_changed_within_turn');
  if (key.startsWith('session:') && prRefs.length) ambiguity.add('pr_owned_by_default_branch_session');
  if (trs.some((r) => r.prRefs.some((p) => !prRefs.includes(p)))) ambiguity.add('pr_created_here_but_owned_by_other_item');
  if (prRefs.length > 1) ambiguity.add('multiple_prs_in_item');
  if (trs.some((r) => r.s.tool === 'codex')) ambiguity.add('codex_branch_estimated');
  if (best.reason === 'your_turn_edits' && key.startsWith('branch:')) {
    const [repo, br] = key.slice(7).split('#');
    const bi = branchInfo(repo, br);
    if (!bi.exists) ambiguity.add('edits_but_branch_deleted');
    else if (bi.mergedIntoDefault) ambiguity.add('edits_but_branch_merged');
  }
  if (best.reason === 'your_turn_edits' && key.startsWith('session:')) {
    ambiguity.add('edits_on_default_branch');
    const c = trs.at(-1)!.t.endCwd;
    if (c && existsSync(c) && trs.at(-1)!.repo) {
      const st = git(c, 'status', '--porcelain', '--untracked-files=no');
      if (st !== null) ambiguity.add(st ? 'edits_repo_dirty_now' : 'edits_repo_clean_now');
    }
  }
  return { status: best.st, reason: best.reason, sessReasons, ambiguity: [...ambiguity], prStates, openPr };
}

function followUps(key: string, trs: TurnRow[], d: ReturnType<typeof deriveItem>) {
  // ターン履歴を再生して「生成された」フォローアップと「今 open のもの」を数える
  const gen: { kind: string; open: boolean; closedBy?: string; date?: string; ref?: string }[] = [];
  for (const r of trs) {
    const t = r.t;
    const nxt = nextHumanAfter(r.s, t);
    if (t.status === 'completed' && t.endedWithQuestion) gen.push({ kind: 'reply', open: !nxt, closedBy: nxt ? 'human_input' : undefined, date: r.date });
    if (t.askOpen.size) gen.push({ kind: 'reply(ask)', open: !nxt, closedBy: nxt ? 'human_input' : undefined, date: r.date });
    if (t.status === 'error') gen.push({ kind: 'resume_error', open: !nxt, closedBy: nxt ? 'next_turn' : undefined, date: r.date });
    if (t.status === 'completed' && t.edits > 0 && !d.prStates.length) gen.push({ kind: 'check_changes(off)', open: false, date: r.date });
  }
  // supersede: 同じ WorkItem で reply が複数 open なら最新以外は superseded
  const openReplies = gen.filter((g) => g.kind.startsWith('reply') && g.open);
  for (const g of openReplies.slice(0, -1)) {
    g.open = false;
    g.closedBy = 'superseded';
  }
  for (const p of d.prStates) {
    const st = p.info?.state;
    gen.push({ kind: 'review_pr', date: prFirst.get(p.ref)?.date, ref: p.ref.replace(/^.*#/, '#'), open: st === 'OPEN' && !p.info?.reviewsByOthers, closedBy: st === 'MERGED' ? 'merged' : st === 'CLOSED' ? 'closed' : p.info?.reviewsByOthers ? 'reviewed' : st ? undefined : 'unknown_pr_state' });
  }
  // approve は hooks（PermissionRequest / Notification）が無いと出せない
  // check_changes の「既定オン」版（commit_changes）は件数だけ
  return gen;
}

function summarize(label: string, keyOf: (r: TurnRow) => string) {
  const items = buildItems(keyOf);
  const { owner, how } = prOwners(keyOf, new Set(items.keys()));
  stats[`prOwnership${label}`] = how;
  const out: any[] = [];
  for (const [key, trs] of items) {
    trs.sort((a, b) => a.t.startedAt - b.t.startedAt);
    const owned = [...owner].filter(([, k]) => k === key).map(([ref]) => ref);
    const d = deriveItem(key, trs, owned);
    const fu = followUps(key, trs, d);
    const byDate: Record<string, { turns: number; aiMs: number; waitMs: number; waitOpenMs: number }> = {};
    for (const r of trs) {
      const b = (byDate[r.date] ??= { turns: 0, aiMs: 0, waitMs: 0, waitOpenMs: 0 });
      b.turns++;
      b.aiMs += r.t.durationMs ?? 0;
      const end = r.t.endedAt ?? r.t.lastTs;
      const nxt = nextHumanAfter(r.s, r.t);
      if (r.t.status === 'running') continue;
      if (nxt) {
        const g = Math.max(0, nxt.startedAt - end);
        if (label === 'A') waitGaps.push(g);
        b.waitMs += Math.min(WAIT_CAP_MS, g);
      }
      else if (d.status !== 'done') b.waitOpenMs += Math.min(WAIT_CAP_MS, Math.max(0, NOW - end));
    }
    const kind = key.split(':')[0];
    const last = trs.at(-1)!;
    const title = (() => {
      // WorkItem の最終ターン時点のツール生成タイトル（ai-title / Desktop title / Codex thread_name）
      const ts = last.s.titles.filter((x) => x.at <= (last.t.endedAt ?? last.t.lastTs) || x.at === Number.MAX_SAFE_INTEGER);
      return (ts.at(-1) ?? last.s.titles.at(-1))?.title ?? null;
    })();
    out.push({
      key, kind, repo: last.repo ? basename(last.repo) : null, branch: kind === 'session' ? (last.branch ?? null) : key.split('#').slice(1).join('#'),
      tools: [...new Set(trs.map((r) => r.s.tool))], sessions: new Set(trs.map((r) => r.s.sid)).size,
      sessionIds: [...new Set(trs.map((r) => r.s.sid.slice(0, 8)))],
      entrypoints: [...new Set(trs.map((r) => r.s.entrypoint ?? r.s.originator ?? '?'))],
      turns: trs.length, prs: d.prStates.map((p) => ({ ref: p.ref.replace(/^.*\//, ''), state: p.info?.state ?? 'unknown', head: p.info?.headRefName })),
      title, status: d.status, reason: d.reason, sessReasons: d.sessReasons, ambiguity: d.ambiguity,
      followups: fu, byDate, firstAt: trs[0].t.startedAt, lastAt: last.t.endedAt ?? last.t.lastTs,
      turnDurationRate: trs.filter((r) => r.t.durationSource === 'turn_duration' || r.t.durationSource === 'task_complete').length / trs.length,
    });
  }
  return out;
}

const waitGaps: number[] = [];
const itemsA = summarize('A', (r) => r.keyA);
const itemsC = summarize('C', (r) => r.keyC);

// ---------- 統計 ----------
function agg(items: any[]) {
  const a: any = { workItems: items.length, byKind: {}, byStatus: {}, byReason: {}, bySessReason: {}, ambiguity: {}, followupsGenerated: {}, followupsOpen: {}, followupsClosedBy: {},
    turnsPerItem: {}, daysPerItem: {}, sessionsPerItem: {}, itemsPerDay: {}, tools: {}, aiHoursTotal: 0, waitHoursClosed: 0, waitHoursOpen: 0, itemsWithPr: 0 };
  const bucket = (n: number) => (n === 1 ? '1' : n <= 3 ? '2-3' : n <= 10 ? '4-10' : n <= 30 ? '11-30' : '31+');
  for (const it of items) {
    inc(a.byKind, it.kind);
    inc(a.byStatus, it.status);
    inc(a.byReason, it.reason);
    for (const r of it.sessReasons) inc(a.bySessReason, r);
    for (const x of it.ambiguity) inc(a.ambiguity, x);
    for (const f of it.followups) {
      inc(a.followupsGenerated, f.kind);
      if (f.open) inc(a.followupsOpen, f.kind);
      if (f.closedBy) inc(a.followupsClosedBy, `${f.kind}:${f.closedBy}`);
    }
    inc(a.turnsPerItem, bucket(it.turns));
    inc(a.daysPerItem, String(Object.keys(it.byDate).length));
    inc(a.sessionsPerItem, String(it.sessions));
    inc(a.tools, it.tools.join('+'));
    if (it.prs.length) a.itemsWithPr++;
    for (const [d, b] of Object.entries<any>(it.byDate)) {
      inc(a.itemsPerDay, d);
      a.aiHoursTotal += b.aiMs / 3600_000;
      a.waitHoursClosed += b.waitMs / 3600_000;
      a.waitHoursOpen += b.waitOpenMs / 3600_000;
    }
  }
  for (const k of ['aiHoursTotal', 'waitHoursClosed', 'waitHoursOpen']) a[k] = Math.round(a[k] * 10) / 10;
  // タイトル: ツール生成タイトルが他カードと重複している件数（セッション単位のタイトルを使い回している）
  const tc: Record<string, number> = {};
  for (const it of items) if (it.title) tc[it.title] = (tc[it.title] ?? 0) + 1;
  a.titles = { withTitle: items.filter((i) => i.title).length, noTitle: items.filter((i) => !i.title).length, sharedWithOtherItems: items.filter((i) => i.title && tc[i.title] > 1).length };
  a.statusByKind = {};
  for (const it of items) inc(a.statusByKind, `${it.kind}:${it.status}`);
  return a;
}
stats.ruleA = agg(itemsA);
stats.ruleC = agg(itemsC);
{
  const b: Record<string, number> = {};
  for (const g of waitGaps) inc(b, g < 60_000 ? '<1m' : g < 5 * 60_000 ? '1-5m' : g < 15 * 60_000 ? '5-15m' : g < 3600_000 ? '15-60m' : g < 4 * 3600_000 ? '1-4h' : g < 24 * 3600_000 ? '4-24h' : '24h+');
  const sorted = [...waitGaps].sort((x, y) => x - y);
  stats.waitGapsA = { n: sorted.length, buckets: b, medianMin: Math.round((sorted[Math.floor(sorted.length / 2)] ?? 0) / 60_000), p90Min: Math.round((sorted[Math.floor(sorted.length * 0.9)] ?? 0) / 60_000) };
  // AI 稼働時間の分布（ターン単位）
  const ai = rows.map((r) => r.t.durationMs ?? 0).sort((x, y) => x - y);
  stats.turnAiTime = { medianSec: Math.round((ai[Math.floor(ai.length / 2)] ?? 0) / 1000), p90Sec: Math.round((ai[Math.floor(ai.length * 0.9)] ?? 0) / 1000), maxMin: Math.round((ai.at(-1) ?? 0) / 60_000) };
}
stats.ruleC.keysChangedFromA = rows.filter((r) => r.keyA !== r.keyC).length;
stats.sessionsInWindow = { total: new Set(rows.map((r) => `${r.s.tool}:${r.s.sid}`)).size, byTool: {} };
for (const k of new Set(rows.map((r) => `${r.s.tool}:${r.s.sid}`))) inc(stats.sessionsInWindow.byTool, k.split(':')[0]);
stats.sessionsSpanningItemsA = {};
{
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = `${r.s.tool}:${r.s.sid}`;
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)!.add(r.keyA);
  }
  for (const v of m.values()) inc(stats.sessionsSpanningItemsA, v.size === 1 ? '1' : v.size <= 3 ? '2-3' : '4+');
}
stats.gh = { used: USE_GH, prsQueried: prCache.size, prsResolved: [...prCache.values()].filter(Boolean).length, states: {} };
for (const v of prCache.values()) inc(stats.gh.states, v?.state ?? 'unknown');
stats.prHeadVsTurnBranch = { sameAsEnd: 0, differentFromEnd: 0, turnEndOnDefault: 0, sameAsStart: 0, sameAsDominant: 0 };
for (const r of rows) {
  for (const p of r.prRefs) {
    const h = prInfo(p)?.headRefName;
    if (!h) continue;
    if (r.repo && isDefault(r.repo, r.branch)) stats.prHeadVsTurnBranch.turnEndOnDefault++;
    else if (h === r.branch) stats.prHeadVsTurnBranch.sameAsEnd++;
    else stats.prHeadVsTurnBranch.differentFromEnd++;
    if (h === r.t.startBranch) stats.prHeadVsTurnBranch.sameAsStart++;
    if (h === r.branchDom) stats.prHeadVsTurnBranch.sameAsDominant++;
  }
}

writeFileSync(join(OUT, 'detail.json'), JSON.stringify({ itemsA, itemsC: itemsC.map((i) => ({ key: i.key, turns: i.turns, status: i.status, reason: i.reason })) }, null, 2));
writeFileSync(join(OUT, 'stats.json'), JSON.stringify(stats, null, 2));
console.log(`items A=${itemsA.length} C=${itemsC.length} turns=${rows.length} -> ${OUT}`);
