/**
 * 開く先の解決（D-059。m2-api 13章）: フォローアップ／カードの ID から、リポジトリのフォルダ・PR の URL・
 * 再開するセッションを DB から引く。クライアントから受け取るのは ID だけで、パス・URL・コマンドは受け取らない。
 * 引いた値も検証する（絶対パスの実在するディレクトリ、github.com の PR の URL、英数字のセッション ID）。
 */
import type { Database } from "bun:sqlite";
import { isAbsolute, join, normalize } from "node:path";
import type { FollowUpKind } from "@turnlane/core/api";
import { OpError } from "../derive/ops.ts";
import type { OpenSystem } from "./system.ts";

export interface SessionRef {
  tool: "claude_code" | "codex";
  externalId: string;
  /** セッションの cwd（実在するディレクトリだけ） */
  cwd: string | null;
  /** 設定ディレクトリ（~/.claude 以外なら CLAUDE_CONFIG_DIR、~/.codex 以外なら CODEX_HOME を付ける） */
  rootPath: string;
  entrypoint: string | null;
  /** 動いているセッションの PID（Claude Code の live。live_checked_at が新しいときだけ） */
  livePid: number | null;
  /** hooks が最後に記録した Orca の端末のハンドル（ORCA_TERMINAL_HANDLE。D-238。無ければ null） */
  termHandle?: string | null;
}

const TERM_HANDLE = /^term_[0-9A-Za-z-]{8,64}$/;

/** hooks が最後に記録したそのセッションの Orca の端末のハンドル（D-238） */
export function lastTermHandle(db: Database, tool: string, externalId: string): string | null {
  const v =
    db
      .query<{ h: string | null }, [string, string]>(
        `SELECT term_handle AS h FROM hook_event
         WHERE session_external_id = ? AND tool = ? AND term_handle IS NOT NULL
         ORDER BY occurred_at DESC LIMIT 1`,
      )
      .get(externalId, tool)?.h ?? null;
  return v && TERM_HANDLE.test(v) ? v : null;
}

export interface OpenTargetInfo {
  workItemId: string;
  followUp: { id: string; kind: FollowUpKind; status: string } | null;
  /** 開いている（open / snoozed）フォローアップの種類（カードだけで開いたときの既定に使う） */
  openKind: FollowUpKind | null;
  folder: string | null;
  /**
   * Turnlane が頼んだ AI の worktree（その AI の項目のセッションを起動した依頼で、片付けていない・実在するもの）。
   * 差分ツールで開くとき（diff）は、元のリポジトリ（folder）ではなくこちらを開く
   */
  worktree: string | null;
  prUrl: string | null;
  session: SessionRef | null;
}

/** live とみなす live_checked_at の新しさ（PID の再利用に備える。探索は5秒ごと） */
export const LIVE_FRESH_MS = 2 * 60_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を拒むための正規表現
const CONTROL = /[\u0000-\u001f\u007f]/;

/** 絶対パスで、制御文字・`..` を含まず、実在するディレクトリだけ */
export function safeDir(p: string | null | undefined, sys: OpenSystem): string | null {
  if (!p || !isAbsolute(p) || CONTROL.test(p)) return null;
  if (p.split("/").includes("..")) return null;
  const n = normalize(p);
  return sys.isDir(n) ? n : null;
}

const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

/** 許可するのは github.com の PR の URL だけ */
export function safePrUrl(url: string | null | undefined): string | null {
  return url && PR_URL.test(url) ? url : null;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** シェルに貼れる形にクォートする */
export function shq(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

/** resume コマンド。cd を付けるのはコピーだけで使うとき（ターミナルを cwd で開くときは付けない） */
export function resumeCommand(s: SessionRef, home: string, withCd: boolean): string {
  const parts: string[] = [];
  if (withCd && s.cwd) parts.push(`cd ${shq(s.cwd)} &&`);
  if (s.tool === "claude_code") {
    if (s.rootPath !== join(home, ".claude")) parts.push(`CLAUDE_CONFIG_DIR=${shq(s.rootPath)}`);
    parts.push(`claude --resume ${s.externalId}`);
  } else {
    if (s.rootPath !== join(home, ".codex")) parts.push(`CODEX_HOME=${shq(s.rootPath)}`);
    parts.push(`codex resume ${s.externalId}`);
  }
  const cmd = parts.join(" ");
  // 改行・制御文字があると、入力済みにしたときに実行されてしまう
  if (CONTROL.test(cmd)) throw new OpError(409, "unavailable");
  return cmd;
}

export function loadTarget(
  db: Database,
  sys: OpenSystem,
  ref: { followUpId?: string; workItemId?: string },
  now: number,
): OpenTargetInfo {
  let workItemId = ref.workItemId ?? null;
  let followUp: OpenTargetInfo["followUp"] = null;
  if (ref.followUpId) {
    const f = db
      .query<{ id: string; work_item_id: string; kind: FollowUpKind; status: string }, [string]>(
        "SELECT id, work_item_id, kind, status FROM follow_up WHERE id = ? AND deleted_at IS NULL",
      )
      .get(ref.followUpId);
    if (!f) throw new OpError(404, "not_found");
    followUp = { id: f.id, kind: f.kind, status: f.status };
    workItemId = f.work_item_id;
  }
  if (!workItemId) throw new OpError(400, "invalid_input");
  const w = db
    .query<{ id: string; repo_root: string | null; branch: string | null }, [string]>(
      "SELECT id, repo_root, branch FROM work_item WHERE id = ? AND deleted_at IS NULL",
    )
    .get(workItemId);
  if (!w) throw new OpError(404, "not_found");
  const openKind =
    followUp && (followUp.status === "open" || followUp.status === "snoozed")
      ? followUp.kind
      : (db
          .query<{ kind: FollowUpKind }, [string]>(
            `SELECT kind FROM follow_up WHERE work_item_id = ? AND deleted_at IS NULL
             AND status IN ('open', 'snoozed') ORDER BY trigger_at DESC LIMIT 1`,
          )
          .get(workItemId)?.kind ?? null);
  const last = db
    .query<
      {
        external_id: string;
        tool: string;
        cwd: string | null;
        root_path: string;
        entrypoint: string | null;
        live_status: string | null;
        live_pid: number | null;
        live_checked_at: number | null;
      },
      [string]
    >(
      `SELECT s.external_id, s.tool, COALESCE(t.cwd, s.cwd) AS cwd, src.root_path, s.entrypoint,
              s.live_status, s.live_pid, s.live_checked_at
       FROM ai_turn t JOIN ai_session s ON s.id = t.session_id JOIN ai_source src ON src.id = s.source_id
       WHERE t.work_item_id = ? AND s.is_subagent = 0 ORDER BY t.started_at DESC LIMIT 1`,
    )
    .get(workItemId);
  let session: SessionRef | null = null;
  if (
    last &&
    (last.tool === "claude_code" || last.tool === "codex") &&
    SESSION_ID.test(last.external_id) &&
    isAbsolute(last.root_path) &&
    !CONTROL.test(last.root_path)
  ) {
    const live =
      (last.live_status === "busy" || last.live_status === "idle") &&
      Number.isInteger(last.live_pid) &&
      (last.live_pid as number) > 1 &&
      last.live_checked_at !== null &&
      now - last.live_checked_at <= LIVE_FRESH_MS;
    session = {
      tool: last.tool,
      externalId: last.external_id,
      cwd: safeDir(last.cwd, sys),
      rootPath: last.root_path,
      entrypoint: last.entrypoint,
      livePid: live ? (last.live_pid as number) : null,
      termHandle: live ? lastTermHandle(db, last.tool, last.external_id) : null,
    };
  }
  // セッションの無いカード（PR だけのカード）: PR の属するリポジトリ（repo_root）で、head ブランチを取り出している
  // worktree があればそこ。repo_root がパスでない（手元にクローンが無い `owner/repo`）ならフォルダは無い
  const repoDir = safeDir(w.repo_root, sys);
  const branchDir =
    !session && repoDir && w.branch ? safeDir(sys.worktreeOf?.(repoDir, w.branch), sys) : null;
  const folder = branchDir ?? repoDir ?? session?.cwd ?? null;
  const wt = db
    .query<{ worktree_path: string }, [string]>(
      `SELECT l.worktree_path FROM ai_launch l
        WHERE l.worktree_path IS NOT NULL AND l.cleaned_at IS NULL
          AND l.session_id IN (SELECT t.session_id FROM ai_turn t WHERE t.work_item_id = ?)
        ORDER BY l.created_at DESC LIMIT 1`,
    )
    .get(workItemId);
  const worktree = safeDir(wt?.worktree_path, sys) ?? branchDir;
  const pr = db
    .query<{ url: string | null; ref: string }, [string]>(
      "SELECT url, ref FROM ai_artifact WHERE work_item_id = ? AND kind = 'pr' ORDER BY first_seen_at DESC LIMIT 1",
    )
    .get(workItemId);
  const m = pr ? /^([^#]+)#(\d+)$/.exec(pr.ref) : null;
  const prUrl =
    safePrUrl(pr?.url) ?? safePrUrl(m ? `https://github.com/${m[1]}/pull/${m[2]}` : null);
  return { workItemId, followUp, openKind, folder, worktree, prUrl, session };
}
