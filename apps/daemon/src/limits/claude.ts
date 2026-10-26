/**
 * Claude の利用枠の最新の値。アカウント（設定ディレクトリ）ごとに1件をメモリと `claude_limit` に持つ（デーモンを起動し
 * 直しても、リセットの時刻までは使える）。値の入り口は 2 つ:
 * - statusLine の受け口 `turnlane statusline` が送る `rate_limits`（Turnlane が起動した Claude Code だけ。at は受けた時刻）
 * - Claude Code が設定ディレクトリの `.claude.json` にキャッシュした利用枠（取り込みの live probe が更新を見つけたとき。
 *   at は Claude Code が取得した時刻）。持っている値より新しく取得したものだけを記録する（statusLine から届いた新しい値を
 *   古いキャッシュで上書きしない）
 * 読むときは、リセットの時刻を過ぎた枠を落とす（Claude Code の statusLine と同じ扱い）。使用率とリセットの時刻のほかは持たない
 */
import type { Database } from "bun:sqlite";
import type { Clock } from "@turnlane/core";
import type { ClaudeLimits, ClaudeLimitWindow } from "@turnlane/core/api";

interface Row {
  account: string;
  five_hour_pct: number | null;
  five_hour_resets_at: number | null;
  seven_day_pct: number | null;
  seven_day_resets_at: number | null;
  at: number;
}

const win = (pct: number | null, at: number | null): ClaudeLimitWindow | undefined =>
  pct !== null && at !== null ? { usedPercentage: pct, resetsAt: at } : undefined;

/** アカウントの書き方をそろえる（末尾の / を落とす） */
export const normalizeAccount = (account: string): string => account.replace(/\/+$/, "") || "/";

export class ClaudeLimitsStore {
  readonly #mem = new Map<string, ClaudeLimits>();

  constructor(
    private readonly sqlite: Database,
    private readonly clock: Clock,
  ) {
    try {
      for (const r of sqlite.query<Row, []>("SELECT * FROM claude_limit").all()) {
        const fiveHour = win(r.five_hour_pct, r.five_hour_resets_at);
        const sevenDay = win(r.seven_day_pct, r.seven_day_resets_at);
        this.#mem.set(r.account, {
          ...(fiveHour ? { fiveHour } : {}),
          ...(sevenDay ? { sevenDay } : {}),
          at: r.at,
        });
      }
    } catch {}
  }

  /** 受け口から届いた値を記録する（届いた枠だけで置き換える） */
  record(account: string, v: { fiveHour?: ClaudeLimitWindow; sevenDay?: ClaudeLimitWindow }): void {
    this.#write(normalizeAccount(account), v, this.clock.now());
  }

  /**
   * 時刻 fetchedAt に取得された値（`.claude.json` のキャッシュ）を、持っている値（statusLine から受けた時刻か、前に記録した
   * キャッシュの取得時刻）より新しいときだけ記録する。記録したら true
   */
  recordFetched(
    account: string,
    v: { fiveHour?: ClaudeLimitWindow; sevenDay?: ClaudeLimitWindow },
    fetchedAt: number,
  ): boolean {
    const key = normalizeAccount(account);
    const cur = this.#mem.get(key);
    if (cur && cur.at >= fetchedAt) return false;
    if (!v.fiveHour && !v.sevenDay) return false;
    this.#write(key, v, fetchedAt);
    return true;
  }

  #write(
    key: string,
    v: { fiveHour?: ClaudeLimitWindow; sevenDay?: ClaudeLimitWindow },
    at: number,
  ): void {
    const next: ClaudeLimits = {
      ...(v.fiveHour ? { fiveHour: v.fiveHour } : {}),
      ...(v.sevenDay ? { sevenDay: v.sevenDay } : {}),
      at,
    };
    this.#mem.set(key, next);
    this.sqlite.run(
      `INSERT INTO claude_limit (account, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (account) DO UPDATE SET five_hour_pct = excluded.five_hour_pct,
         five_hour_resets_at = excluded.five_hour_resets_at, seven_day_pct = excluded.seven_day_pct,
         seven_day_resets_at = excluded.seven_day_resets_at, at = excluded.at`,
      [
        key,
        next.fiveHour?.usedPercentage ?? null,
        next.fiveHour?.resetsAt ?? null,
        next.sevenDay?.usedPercentage ?? null,
        next.sevenDay?.resetsAt ?? null,
        at,
      ],
    );
  }

  /** 最新の値。届いていない・どの枠もリセットの時刻を過ぎていれば null */
  get(account: string): ClaudeLimits | null {
    const v = this.#mem.get(normalizeAccount(account));
    if (!v) return null;
    const now = this.clock.now();
    const live = (w: ClaudeLimitWindow | undefined) => (w && w.resetsAt > now ? w : undefined);
    const fiveHour = live(v.fiveHour);
    const sevenDay = live(v.sevenDay);
    if (!fiveHour && !sevenDay) return null;
    return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), at: v.at };
  }
}
