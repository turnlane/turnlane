/**
 * PR 状態のポーラ（phase0-plan 3.3「PR 状態の取得」、M1-11、D-005）。
 * ユーザーの gh CLI がログイン済みなら、open（と draft・unknown）な PR を5分ごとに `gh pr view` で確かめる。
 * - headRefName → ai_artifact.head_ref（カードへの帰属に使う）
 * - mergedAt / closedAt → state_changed_at（待ちの終点と解決の兆候に使う）
 * - title → タイトル候補の最上位
 * - 自分（gh の viewer）のレビュー → my_review_at
 * レビューの本文は読まない（JSON に含まれるが、作者のログインと時刻だけを取り出して捨てる）。
 * gh が無い・ログインしていない場合は何もしない（review_pr は手動完了で代用。state_changed_at は検知した時刻で代用）。
 */
import type { Database } from "bun:sqlite";
import { errorFields, type MetaOnlyLogger } from "@turnlane/collectors";
import type { Clock } from "@turnlane/core";

export interface GhPr {
  state: "open" | "draft" | "merged" | "closed";
  reviewDecision: string | null;
  title: string | null;
  url: string | null;
  headRefName: string | null;
  mergedAt: number | null;
  closedAt: number | null;
  /** レビューした人のログインと時刻（本文は持たない） */
  reviews: { author: string; at: number }[];
}

export interface GhClient {
  /** gh が使えてログイン済みなら viewer のログイン。使えなければ null */
  viewer(): string | null;
  prView(repo: string, number: number): GhPr | null;
}

function gh(args: string[], timeoutMs = 20_000): string | null {
  try {
    const p = Bun.spawnSync(["gh", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    });
    return p.exitCode === 0 ? p.stdout.toString() : null;
  } catch {
    return null;
  }
}

const ms = (v: unknown) => {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/** gh の JSON から必要な値だけを取り出す（レビュー本文などは捨てる） */
export function parsePrView(json: string): GhPr | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const st = String(j.state ?? "").toUpperCase();
  const state =
    st === "MERGED" ? "merged" : st === "CLOSED" ? "closed" : j.isDraft === true ? "draft" : "open";
  const reviews = Array.isArray(j.reviews)
    ? (j.reviews as Record<string, unknown>[]).flatMap((r) => {
        const login = (r.author as { login?: unknown } | undefined)?.login;
        const at = ms(r.submittedAt);
        return typeof login === "string" && at !== null ? [{ author: login, at }] : [];
      })
    : [];
  return {
    state,
    reviewDecision:
      typeof j.reviewDecision === "string" && j.reviewDecision ? j.reviewDecision : null,
    title: typeof j.title === "string" ? j.title.slice(0, 300) : null,
    url: typeof j.url === "string" ? j.url : null,
    headRefName: typeof j.headRefName === "string" ? j.headRefName : null,
    mergedAt: ms(j.mergedAt),
    closedAt: ms(j.closedAt),
    reviews,
  };
}

export class SystemGh implements GhClient {
  #viewer: string | null | undefined;

  viewer(): string | null {
    if (this.#viewer === undefined) {
      const out = gh(["api", "user", "--jq", ".login"], 10_000);
      this.#viewer = out?.trim() || null;
    }
    return this.#viewer;
  }

  prView(repo: string, number: number): GhPr | null {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
    const out = gh([
      "pr",
      "view",
      String(number),
      "-R",
      repo,
      "--json",
      "state,isDraft,reviewDecision,reviews,title,url,headRefName,mergedAt,closedAt",
    ]);
    return out ? parsePrView(out) : null;
  }
}

export interface PrPollerOptions {
  sqlite: Database;
  clock: Clock;
  logger: MetaOnlyLogger;
  gh?: GhClient;
  intervalMs?: number;
  onChanged: () => void;
}

const INTERVAL = 5 * 60_000;

export class PrPoller {
  readonly #o: PrPollerOptions;
  readonly #gh: GhClient;
  #timer: ReturnType<typeof setInterval> | null = null;
  #warned = false;

  constructor(o: PrPollerOptions) {
    this.#o = o;
    this.#gh = o.gh ?? new SystemGh();
  }

  start(): void {
    setTimeout(() => this.pollOnce(), 5_000);
    this.#timer = setInterval(() => this.pollOnce(), this.#o.intervalMs ?? INTERVAL);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 確かめた件数を返す */
  pollOnce(): number {
    const o = this.#o;
    const now = o.clock.now();
    const due = o.sqlite
      .query<{ id: string; ref: string; state: string; state_changed_at: number | null }, [number]>(
        "SELECT id, ref, state, state_changed_at FROM ai_artifact WHERE kind = 'pr' AND state IN ('open', 'draft', 'unknown') AND (state_checked_at IS NULL OR state_checked_at < ?)",
      )
      .all(now - (o.intervalMs ?? INTERVAL) + 1000);
    if (due.length === 0) return 0;
    let viewer: string | null;
    try {
      viewer = this.#gh.viewer();
    } catch (e) {
      viewer = null;
      o.logger.warn("github.viewer_failed", errorFields(e));
    }
    if (!viewer) {
      if (!this.#warned) o.logger.info("github.gh_unavailable", {});
      this.#warned = true;
      // 確かめられなかったことを記録する（状態は unknown のまま。review_pr は初出から72時間以内のものだけ作る）
      o.sqlite.transaction(() => {
        for (const a of due)
          o.sqlite.run("UPDATE ai_artifact SET state_checked_at = ? WHERE id = ?", [now, a.id]);
      })();
      o.onChanged();
      return 0;
    }
    let changed = false;
    let n = 0;
    for (const a of due) {
      const i = a.ref.lastIndexOf("#");
      const repo = a.ref.slice(0, i);
      const num = Number(a.ref.slice(i + 1));
      const pr = this.#gh.prView(repo, num);
      n++;
      if (!pr) {
        o.sqlite.run("UPDATE ai_artifact SET state_checked_at = ? WHERE id = ?", [now, a.id]);
        continue;
      }
      const closedAt =
        pr.state === "merged"
          ? (pr.mergedAt ?? pr.closedAt)
          : pr.state === "closed"
            ? pr.closedAt
            : null;
      const stateChangedAt =
        pr.state === "merged" || pr.state === "closed"
          ? (closedAt ?? a.state_changed_at ?? now)
          : null;
      const mine = pr.reviews.filter((r) => r.author === viewer).map((r) => r.at);
      o.sqlite.run(
        `UPDATE ai_artifact SET state = ?, review_decision = ?, title = COALESCE(?, title), url = COALESCE(?, url),
           head_ref = COALESCE(?, head_ref), state_changed_at = ?, my_review_at = ?, state_checked_at = ?, updated_at = ?
         WHERE id = ?`,
        [
          pr.state,
          pr.reviewDecision,
          pr.title,
          pr.url,
          pr.headRefName,
          stateChangedAt,
          mine.length > 0 ? Math.min(...mine) : null,
          now,
          now,
          a.id,
        ],
      );
      changed = true;
    }
    if (changed) o.onChanged();
    return n;
  }
}
