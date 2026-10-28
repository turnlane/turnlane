/**
 * derive runner（phase0-plan 3.2・3.3、M1-7〜M1-9）。
 * 事実を DB から読む → core/derive の純粋関数 → 差分を書く → SSE。
 * 取り込みの後（デバウンス 1 秒）と 60 秒ごとの tick で動く。毎回、全カードを再計算する（Phase0 の規模では十分速い）。
 *
 * 1. グルーピング: ターン → カード（work_item）。ユーザーの統合（merged_into_id）を優先する
 * 2. 状態: 変化したら work_item を更新し、work_item_status_log を閉じて新しい行を足す
 * 3. フォローアップ: あるべき集合との差分で follow_up / task を作成・クローズする
 * 4. 待ち区間（ai_wait_segment）を作り直す（キャッシュ。カレンダーの窓と在席の記録を始めた日より古い日は確定扱い）。
 *    放置に数えうる時間は在席（presence_span）と、一日を閉じていた区間で決める（D-105・D-110）
 */
import type { Database } from "bun:sqlite";
import { errorFields, type MetaOnlyLogger, meta } from "@turnlane/collectors";
import {
  addDays,
  type Clock,
  dayStartMs,
  derive,
  insertRow,
  type MutateCtx,
  newId,
  orderKeyAfter,
  orderKeyBefore,
  orderKeyBetween,
  parseRepoPaths,
  readSettings,
  schema,
  softDelete,
  type TaskTitleParams,
  type TurnlaneSettings,
  taskTitleKeyFor,
  toLocalDate,
  updateRow,
} from "@turnlane/core";
import { type GitProbe, isDefaultBranch } from "../ingest/git.ts";
import { isLaunchTask, launchForSessions, loadLaunchLinks } from "../launch/link.ts";
import {
  type FollowUpRow,
  HOOK_WINDOW_MS,
  loadClaudeLimits,
  loadFollowUps,
  loadHooks,
  loadPrs,
  loadSessions,
  loadTurns,
  loadWorkItems,
  type PrRow,
  prNumber,
  type SessionRow,
  type TurnRow,
  toFollowUpFact,
  toPrFact,
  toSessionFact,
  toSubagentFact,
  toTurnFact,
  type WorkItemRow,
} from "./load.ts";
import { mergeCardInto } from "./merge.ts";
import { projectIdForRepo } from "./projects.ts";
import { cardTitle } from "./titles.ts";
import { presenceFrom, presentAt } from "./views.ts";

export interface RunnerOptions {
  sqlite: Database;
  mutate: MutateCtx;
  git: GitProbe;
  clock: Clock;
  logger: MetaOnlyLogger;
  /** ツール → runningStaleMs */
  runningStaleMs: Record<string, number>;
  /**
   * SSE（m2-api.md 3.2）。work_item はターンの追加・更新、状態・タイトルの変化、待ち区間の追加・削除・区分の変化
   * があった日付と ID、follow_up は作成・クローズの ID、task は自動生成・自動クローズしたタスクの日付。
   * 進行中の区間が伸びるだけでは送らない
   */
  publish?: (type: "work_item" | "follow_up" | "task", data: Record<string, unknown>) => void;
  debounceMs?: number;
  tickMs?: number;
  /** 非同期の実行でイベントループに譲る間隔（ms。既定 SLICE_MS。テストは 0 で区切りごとに譲る） */
  sliceMs?: number;
  settings?: () => TurnlaneSettings;
  /** 壁打ちのフォルダか（D-135。ai.ts の scratchMatcher）。省略時は壁打ちを作らない */
  isScratch?: (cwd: string) => boolean;
  /** 実行の最後に呼ぶ（新しい自分の番の待ちの中身を保存する。ADR 0018。ai.ts） */
  afterRun?: (now: number, settings: TurnlaneSettings) => void;
}

export interface RunStats {
  workItems: number;
  statusChanged: number;
  followUpsCreated: number;
  followUpsClosed: number;
  waitSegments: number;
}

/** 待ち区間を作り直す範囲より前に閉じた日を、閉じていた区間として見る日数（長い休みの前に閉じた日も拾う） */
const PRESENCE_LOOKBACK_DAYS = 14;

export class DeriveRunner {
  readonly #o: RunnerOptions;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #tick: ReturnType<typeof setInterval> | null = null;
  #running = false;
  #again = false;
  #stopped = false;
  /** 続けて打ち切った回数 */
  #aborts = 0;
  #idleWaiters: (() => void)[] = [];
  #waitSince: string | undefined;
  /** 前回の実行の「ターン」「待ち区間」の要約（変化した日付だけ SSE で知らせる） */
  #turnSig = new Map<string, string>();
  #waitSig = new Map<string, string>();
  lastRun: RunStats | null = null;
  /** 譲っている間に DB が書き換わって打ち切った回数（確認・テスト用） */
  abortedRuns = 0;
  /**
   * 最後の実行で見つけた待ちの始まり（全期間。在席・カレンダーで区分する前）。オンボーディングの要約の
   * 「AI が人を待った回数」に使う（onboarding.md 4.3。窓より古い日は待ち区間の行を作らないため、行からは数えない）
   */
  #waitStarts: number[] = [];
  /**
   * 最後の実行で見つけたセッションの待ち（フォローアップの有無・猶予によらない。D-240）。「答える」の対象の 2 番目
   * （開いているフォローアップが無いとき）。メモリだけに持つ（起動の直後は 1 回目の判定が埋める）
   */
  #sessionWaits = new Map<string, derive.SessionWait>();
  /** 1 回の実行の間だけ使う git・壁打ちの判定（同じ cwd をターンごとに何度も見るので、実行の始めに作り直す） */
  #git: GitProbe;
  #isScratch: ((cwd: string) => boolean) | undefined;

  constructor(o: RunnerOptions) {
    this.#o = o;
    this.#git = o.git;
    this.#isScratch = o.isScratch;
  }

  #settings(): TurnlaneSettings {
    return this.#o.settings?.() ?? readSettings(this.#o.mutate.db);
  }

  start(): void {
    this.#stopped = false;
    this.#tick = setInterval(() => this.schedule(0), this.#o.tickMs ?? 60_000);
    this.schedule(0);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#tick) clearInterval(this.#tick);
    this.#timer = null;
    this.#tick = null;
  }

  /** 取り込みの後に呼ぶ（デバウンス） */
  schedule(delayMs = this.#o.debounceMs ?? 1000): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#runSafe();
    }, delayMs);
  }

  /** turnlane rederive --wait --since: 窓より古い日の待ち区間も作り直す */
  rederive(opts: { waitSince?: string } = {}): RunStats {
    this.#waitSince = opts.waitSince;
    try {
      return this.runOnce();
    } finally {
      this.#waitSince = undefined;
    }
  }

  /** [from, to) に始まった待ちの数（最後の実行の時点） */
  waitsStartedBetween(from: number, to: number): number {
    let n = 0;
    for (const t of this.#waitStarts) if (t >= from && t < to) n++;
    return n;
  }

  /**
   * セッションの repo_root（取り込み時の値）。壁打ちのフォルダのセッションは持たない（印を付ける前に取り込んだ値を
   * 使わない。D-135）。fromCwd は cwd から今求めた値（あればそれを優先）
   */
  #sessionRepo(s: SessionRow, fromCwd?: string | null | undefined): string | null {
    if (fromCwd) return fromCwd;
    if (s.cwd && this.#isScratch?.(s.cwd)) return null;
    return s.repo_root;
  }

  /** 壁打ちのカードか（D-135）: リポジトリを持たない session カードで、壁打ちのフォルダで動いたターンがある */
  #isScratchCard(f: derive.WorkItemFacts, repoRoot: string | null): boolean {
    const isScratch = this.#isScratch;
    return (
      f.kind === "session" &&
      repoRoot === null &&
      !!isScratch &&
      f.turns.some((x) => !!x.cwd && isScratch(x.cwd))
    );
  }

  #runSafe(): void {
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    void this.#runSafeAsync();
  }

  async #runSafeAsync(): Promise<void> {
    let completed = true;
    try {
      // 打ち切りが続いたら（取り込み・操作が絶えず書いている）、譲らずに 1 回で終える
      if (this.#aborts >= MAX_ABORTS) this.runOnce();
      else completed = await this.#runAsync();
    } catch (e) {
      this.#o.logger.error("derive.failed", errorFields(e, { includeMessage: true }));
    } finally {
      this.#aborts = completed ? 0 : this.#aborts + 1;
      if (!completed) this.abortedRuns++;
      this.#running = false;
      for (const w of this.#idleWaiters.splice(0)) w();
      if (!this.#stopped && (this.#again || !completed)) {
        this.#again = false;
        this.schedule();
      }
    }
  }

  /** 今すぐ非同期で 1 回実行し、終わるまで待つ（走っていれば、それが終わってから） */
  async runNow(): Promise<void> {
    await this.idle();
    if (this.#stopped) return;
    if (this.#running) return this.idle();
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#running = true;
    await this.#runSafeAsync();
  }

  /** 非同期の実行（取り込みの後・tick）が終わるまで待つ。走っていなければすぐ返る */
  idle(): Promise<void> {
    if (!this.#running) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /** カードのセッションの待ち（D-240。derive.openWaitOf の 2 番目）。無ければ null */
  sessionWait(workItemId: string): derive.SessionWait | null {
    return this.#sessionWaits.get(workItemId) ?? null;
  }

  /** セッションの待ちの全部（D-245 の猶予中の行。graceQueue） */
  sessionWaits(): ReadonlyMap<string, derive.SessionWait> {
    return this.#sessionWaits;
  }

  /** 1 回実行する（同期。区切りでイベントループに譲らない。rederive・まとめての取り込みの後・テスト） */
  runOnce(): RunStats {
    const steps = this.#steps();
    for (;;) {
      const r = steps.next();
      if (r.done) return r.value;
    }
  }

  /**
   * 1 回実行する（非同期。取り込みの後・tick）。SLICE_MS ごとにイベントループに譲り、HTTP（health・hook の受け口）を
   * 止めない。譲っている間に DB が他から書き換わったら、読んだ事実が古くなるので打ち切る（それまでに書いたものは、書いた
   * 時点の DB と食い違っていない）。打ち切ったら false
   */
  async #runAsync(): Promise<boolean> {
    const steps = this.#steps();
    let sliceAt = performance.now();
    for (;;) {
      const r = steps.next();
      if (r.done) return true;
      if (performance.now() - sliceAt < (this.#o.sliceMs ?? SLICE_MS)) continue;
      const stamp = this.#dbStamp();
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.#stopped || this.#dbStamp() !== stamp) {
        // finally（それまでの変化の SSE）を走らせて終える
        steps.return(undefined as never);
        return false;
      }
      sliceAt = performance.now();
    }
  }

  /** この接続の書き込みの累計と、他の接続の書き込みの印（PRAGMA data_version） */
  #dbStamp(): string {
    const db = this.#o.sqlite;
    const c = db.query<{ c: number }, []>("SELECT total_changes() AS c").get()?.c ?? 0;
    const v = db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version;
    return `${c}:${v ?? 0}`;
  }

  /** 実行の本体。yield はイベントループに譲ってよい区切り（DB のトランザクションの外） */
  *#steps(): Generator<void, RunStats, void> {
    const o = this.#o;
    const settings = this.#settings();
    const now = o.clock.now();
    const today = toLocalDate(now, settings.tz, settings.dayBoundary);
    const stats: RunStats = {
      workItems: 0,
      statusChanged: 0,
      followUpsCreated: 0,
      followUpsClosed: 0,
      waitSegments: 0,
    };

    const sessions = loadSessions(o.sqlite);
    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    const allTurns = loadTurns(o.sqlite);
    const turns = allTurns.filter((t) => {
      const s = sessionById.get(t.session_id);
      return s && s.is_noise !== 1;
    });
    const prs = loadPrs(o.sqlite);
    const hooks = loadHooks(o.sqlite, now - HOOK_WINDOW_MS);
    // 利用枠（上限待ちの終わりの時刻。D-116 の rate_limit で止まったセッション）
    const claudeLimits = loadClaudeLimits(o.sqlite);

    // ---------- 1. グルーピング ----------
    const isScratch = o.isScratch ? memo(o.isScratch) : undefined;
    this.#isScratch = isScratch;
    const git = memoGit(o.git);
    this.#git = git;
    const repoOf = (cwd: string | null): string | null | undefined => {
      if (!cwd) return null;
      if (!git.cwdExists(cwd)) return undefined;
      return git.repoRoot(cwd);
    };
    const isDefault = (repo: string, branch: string | null) => isDefaultBranch(git, repo, branch);
    const wiRows = loadWorkItems(o.sqlite);
    const wiById = new Map(wiRows.map((w) => [w.id, w]));
    const keyOfWi = new Map(wiRows.map((w) => [w.id, w.group_key]));
    // PR の属するリポジトリ（owner/repo）を手元のパスに結ぶ候補: セッション・カード・プロジェクトのリポジトリ
    let candidates: string[] | null = null;
    const repoCandidates = (): string[] => {
      if (candidates) return candidates;
      const set = new Set<string>();
      for (const s of sessions) {
        const r = this.#sessionRepo(s, repoOf(s.cwd));
        if (r) set.add(r);
      }
      for (const t of turns) {
        const r = repoOf(t.cwd);
        if (r) set.add(r);
      }
      for (const w of wiRows)
        if (w.deleted_at === null && w.repo_root?.startsWith("/") && git.cwdExists(w.repo_root))
          set.add(w.repo_root);
      for (const r of o.sqlite
        .query<{ repo_paths_json: string }, []>(
          "SELECT repo_paths_json FROM project WHERE deleted_at IS NULL AND repo_paths_json <> '[]'",
        )
        .all())
        for (const p of parseRepoPaths(r.repo_paths_json)) {
          const root = p.startsWith("/") ? repoOf(p) : null;
          if (root) set.add(root);
        }
      candidates = [...set];
      return candidates;
    };
    const group = derive.groupTurns(
      turns.map((t) => {
        const s = sessionById.get(t.session_id) as SessionRow;
        return {
          turnId: t.id,
          sessionId: t.session_id,
          tool: s.tool,
          sessionExternalId: s.external_id,
          parentSessionId: s.is_subagent === 1 ? s.parent_session_id : null,
          startedAt: t.started_at,
          repoRoot: repoOf(t.cwd),
          branch: t.git_branch,
          existingKey: t.work_item_id ? (keyOfWi.get(t.work_item_id) ?? null) : null,
        };
      }),
      prs.map((p) => {
        // turn_id が無ければ、同じセッションで PR が初めて出た時点のターン
        const firstTurn =
          p.turn_id ??
          [...turns]
            .reverse()
            .find((t) => t.session_id === p.session_id && t.started_at <= p.first_seen_at)?.id ??
          null;
        const s = p.session_id ? sessionById.get(p.session_id) : undefined;
        return {
          ref: p.ref,
          number: prNumber(p.ref),
          // PR のカードのリポジトリは PR の属するリポジトリ（セッションの cwd ではない。fix-pr-card-repo）
          repoRoot: derive.prRepoRoot(
            derive.prRepoOf(p.ref),
            s ? this.#sessionRepo(s, repoOf(s.cwd)) : null,
            repoCandidates(),
            (r) => git.remoteRepos(r),
          ),
          headRef: p.head_ref,
          firstTurnId: firstTurn,
          firstSeenAt: p.first_seen_at,
          stateChangedAt: p.state_changed_at,
        };
      }),
      isDefault,
    );

    // キー → カード（統合されたものは統合先へ）
    const liveByKey = new Map<string, WorkItemRow>();
    const deletedByKey = new Map<string, WorkItemRow>();
    for (const w of wiRows) {
      if (w.deleted_at === null) liveByKey.set(w.group_key, w);
      else if (w.merged_into_id) deletedByKey.set(w.group_key, w);
    }
    const resolveMerged = (w: WorkItemRow): WorkItemRow => {
      let cur = w;
      for (let i = 0; i < 10 && cur.merged_into_id; i++) {
        const next = wiById.get(cur.merged_into_id);
        if (!next) break;
        cur = next;
      }
      return cur;
    };
    const wiForKey = new Map<string, string>();
    const newKeys: [string, derive.CardInfo][] = [];
    for (const [key, card] of group.cards) {
      const merged = deletedByKey.get(key);
      if (merged && !liveByKey.has(key)) {
        wiForKey.set(key, resolveMerged(merged).id);
        continue;
      }
      const existing = liveByKey.get(key);
      if (existing) {
        wiForKey.set(key, existing.id);
        continue;
      }
      newKeys.push([key, card]);
    }
    // 付け替え: キーが変わって空になるカード（今のキーにターンも PR も残らない）の PR が別のキーへ移るなら、
    // カードごと移す（PR のカードのリポジトリを PR の属するリポジトリに直したとき。fix-pr-card-repo）。
    // 移る先のカードが無ければキーとリポジトリを書き換え（ID・題名・フォローアップを保つ）、あれば統合する
    const used = new Set(wiForKey.values());
    const movedTo = (w: WorkItemRow): string | null => {
      if (w.deleted_at !== null || used.has(w.id) || group.cards.has(w.group_key)) return null;
      const keys = new Set(
        prs.filter((p) => p.work_item_id === w.id).map((p) => group.prKeys.get(p.ref) ?? null),
      );
      const [k] = [...keys];
      return keys.size === 1 && k && k.startsWith("branch:") && k !== w.group_key ? k : null;
    };
    const rekeyed = new Set<string>();
    for (const [key, card] of newKeys) {
      const from = wiRows.find((w) => !rekeyed.has(w.id) && movedTo(w) === key);
      if (from) {
        rekeyed.add(from.id);
        used.add(from.id);
        updateRow(o.mutate, schema.workItem, from.id, {
          groupKey: key,
          repoRoot: card.repoRoot,
          branch: card.branch,
        });
        from.group_key = key;
        from.repo_root = card.repoRoot;
        from.branch = card.branch;
        keyOfWi.set(from.id, key);
        wiForKey.set(key, from.id);
        continue;
      }
      const row = insertRow(o.mutate, schema.workItem, {
        groupKey: key,
        repoRoot: card.repoRoot,
        branch: card.branch,
        status: "done",
        statusChangedAt: now,
        firstActivityAt: card.firstActivityAt,
        lastActivityAt: card.lastActivityAt,
        toolsJson: "[]",
      });
      const fresh = o.sqlite
        .query<WorkItemRow, [string]>("SELECT * FROM work_item WHERE id = ?")
        .get(row.id);
      if (fresh) wiById.set(row.id, fresh);
      wiForKey.set(key, row.id);
    }
    for (const w of wiRows) {
      const k = rekeyed.has(w.id) ? null : movedTo(w);
      const into = k ? wiForKey.get(k) : undefined;
      if (!into || into === w.id) continue;
      mergeCardInto(o.sqlite, o.mutate, w.id, into, now);
      w.deleted_at = now;
      w.merged_into_id = into;
      for (const p of prs) if (p.work_item_id === w.id) p.work_item_id = into;
    }
    const turnWi = new Map<string, string>();
    const turnSession = new Map(turns.map((t) => [t.id, t.session_id]));
    o.sqlite.transaction(() => {
      for (const t of turns) {
        const key = group.turnKeys.get(t.id);
        const wi = key ? wiForKey.get(key) : undefined;
        if (!wi) continue;
        turnWi.set(t.id, wi);
        if (t.work_item_id !== wi)
          o.sqlite.run("UPDATE ai_turn SET work_item_id = ? WHERE id = ?", [wi, t.id]);
      }
      for (const p of prs) {
        const key = group.prKeys.get(p.ref);
        const wi = key ? wiForKey.get(key) : undefined;
        if (wi && p.work_item_id !== wi)
          o.sqlite.run("UPDATE ai_artifact SET work_item_id = ? WHERE id = ?", [wi, p.id]);
        if (wi) p.work_item_id = wi;
      }
    })();

    // ---------- 2・3. 状態とフォローアップ ----------
    // セッション → ターンを持つカード（題名の「他のカードにまたがるか」。D-066 (3)）
    const cardsBySession = new Map<string, Set<string>>();
    for (const [turnId, wi] of turnWi) {
      const sid = turnSession.get(turnId);
      if (!sid) continue;
      const set = cardsBySession.get(sid) ?? new Set<string>();
      set.add(wi);
      cardsBySession.set(sid, set);
    }
    const turnsByWi = new Map<string, TurnRow[]>();
    for (const t of turns) {
      const wi = turnWi.get(t.id);
      if (!wi) continue;
      pushTo(turnsByWi, wi, t);
    }
    const prsByWi = new Map<string, PrRow[]>();
    for (const p of prs) if (p.work_item_id) pushTo(prsByWi, p.work_item_id, p);
    // サブエージェント（ターンを持たないもの）: 親のセッション → サブエージェント（親が動いているかの判定に使う）
    const withTurns = new Set(allTurns.map((t) => t.session_id));
    const subagentsByParent = new Map<string, derive.SubagentFact[]>();
    for (const s of sessions) {
      if (withTurns.has(s.id) || s.is_noise === 1) continue;
      const x = toSubagentFact(s);
      if (x) pushTo(subagentsByParent, x.parentId, x);
    }
    const turnsBySession = new Map<string, derive.TurnFact[]>();
    for (const t of allTurns) {
      pushTo(turnsBySession, t.session_id, toTurnFact(t));
    }
    const hooksBySession = new Map<string, derive.HookFact[]>();
    for (const h of hooks) {
      pushTo(hooksBySession, h.sessionExternalId, h);
    }
    let followUps = loadFollowUps(o.sqlite);
    // 離れていた間に止まった問いは猶予を飛ばす（D-214 (3)）。在席の記録が動いていない（直近 72 時間に 1 つも区間が無い）
    // ときは、いなかったとは言えないので今までどおり猶予を待つ
    const presence = presenceFrom(o.sqlite, settings, now - settings.replyExpireMs);
    const timing: derive.DeriveTiming = {
      runningStaleMs: o.runningStaleMs,
      awayAt: (at) => presence.length > 0 && !presentAt(presence, at, now),
    };
    // タスクから頼んだ AI（D-107）: セッション → 頼んだタスク
    const launches = loadLaunchLinks(o.sqlite);
    const launchOf = (wiId: string) =>
      launches.length === 0
        ? null
        : launchForSessions(launches, [
            ...new Set((turnsByWi.get(wiId) ?? []).map((t) => t.session_id)),
          ]);

    const factsFor = (wiId: string): derive.WorkItemFacts | null => {
      const w = wiById.get(wiId);
      const ts = turnsByWi.get(wiId) ?? [];
      const ps = prsByWi.get(wiId) ?? [];
      if (!w || (ts.length === 0 && ps.length === 0)) return null;
      const sessIds = [...new Set(ts.map((t) => t.session_id))];
      const sess = sessIds.map((id) => sessionById.get(id)).filter((s): s is SessionRow => !!s);
      const key = w.group_key;
      const repo = key.startsWith("branch:")
        ? w.repo_root
        : (ts.map((t) => repoOf(t.cwd)).find((r) => r) ?? null);
      const defaultBranchCard = key.startsWith("session:") && !!repo;
      const dirty =
        defaultBranchCard && repo && ts.some((t) => t.edited_files_count > 0)
          ? git.isDirty(repo)
          : null;
      // 汚れているときだけ、セッションの最後の編集ありのターンがその後にコミットされたかを見る（返答タスクの resolved:commit と
      // 同じ git の源）。別のセッションの編集で汚れても、コミット済みの編集を確認待ちに戻さない
      const editsCommitted = new Set<string>();
      if (dirty === true)
        for (const sid of sessIds) {
          const last = [...ts].reverse().find((t) => t.session_id === sid);
          const r = last ? repoOf(last.cwd) : null;
          if (!last || last.edited_files_count === 0 || !r || !last.git_branch) continue;
          if (git.firstCommitAfter(r, last.git_branch, last.ended_at ?? last.started_at) !== null)
            editsCommitted.add(last.id);
        }
      return {
        workItemId: wiId,
        kind: key.startsWith("branch:") ? "branch" : "session",
        nonGit: !repo,
        defaultBranchCard,
        turns: ts.map(toTurnFact),
        sessions: sess.map(toSessionFact),
        sessionTurns: new Map(sessIds.map((id) => [id, turnsBySession.get(id) ?? []])),
        hooks: sess.flatMap((s) => hooksBySession.get(s.external_id) ?? []),
        prs: ps.map(toPrFact),
        manualDoneAt: w.manual_done_at,
        dirty,
        ...(editsCommitted.size > 0 ? { editsCommitted } : {}),
        followUps: followUps.filter((f) => f.work_item_id === wiId).map(toFollowUpFact),
        launch: (() => {
          const l = launchOf(wiId);
          return l ? { at: l.createdAt, closedAt: l.closedAt } : null;
        })(),
        claudeLimits,
        subagents: sessIds.flatMap((id) => subagentsByParent.get(id) ?? []),
      };
    };

    const activeWis = [...new Set([...turnWi.values(), ...[...prsByWi.keys()]])];
    stats.workItems = activeWis.length;
    const tasksTouched = new Set<string>();
    const changedWis = new Set<string>();
    const changedDates = new Set<string>();
    const fuIds = new Set<string>();
    const fuWis = new Set<string>();
    const sessionWaits = new Map<string, derive.SessionWait>();
    // ここから後は打ち切られても、それまでに書いた変化を SSE で知らせる（次の実行では差分にならないため）
    try {
      for (const wiId of activeWis) {
        yield;
        try {
          let f = factsFor(wiId);
          if (!f) continue;
          let st = derive.deriveStatus(f, now, settings, timing);
          const desired = derive.desiredFollowUps(f, st, now, settings, timing);
          const signals = this.#signals(f, turns, sessionById, prs, repoOf, isDefault);
          const actions = derive.reconcileFollowUps(f, desired, now, settings, signals);
          if (actions.length > 0) {
            const l = launchOf(wiId);
            const r = this.#applyFollowUps(wiId, f, actions, today, l?.alive ? l.taskId : null);
            stats.followUpsCreated += r.created;
            stats.followUpsClosed += r.closed;
            for (const t of r.tasks) tasksTouched.add(t);
            for (const x of r.followUps) fuIds.add(x);
            if (r.followUps.length > 0) fuWis.add(wiId);
            followUps = loadFollowUps(o.sqlite);
            f = factsFor(wiId);
            if (!f) continue;
            st = derive.deriveStatus(f, now, settings, timing);
          }
          // 答える対象（D-240）: 猶予の間の問いのようにフォローアップがまだ無い待ちも持っておく
          const sw = derive.sessionWaitOf(f, st, now, settings, timing);
          if (sw) sessionWaits.set(wiId, sw);
          const prevWait = this.#sessionWaits.get(wiId);
          if (prevWait?.turnId !== sw?.turnId || prevWait?.kind !== sw?.kind) {
            changedWis.add(wiId);
            changedDates.add(today);
          }
          const exclusive = f.sessions.every((s) => (cardsBySession.get(s.id)?.size ?? 0) <= 1);
          const w = this.#writeWorkItem(
            wiId,
            f,
            st,
            now,
            sessionById,
            prs,
            exclusive,
            launchOf(wiId)?.taskId ?? null,
          );
          if (w.status) stats.statusChanged++;
          if (w.any) {
            changedWis.add(wiId);
            changedDates.add(today);
          }
        } catch (e) {
          o.logger.warn("derive.work_item_failed", {
            work_item: meta(wiId),
            ...errorFields(e, { includeMessage: true }),
          });
        }
      }
      for (const id of this.#sessionWaits.keys())
        if (!sessionWaits.has(id) && activeWis.includes(id)) {
          changedWis.add(id);
          changedDates.add(today);
        }
      this.#sessionWaits = sessionWaits;
      // ターンも PR も無くなったカード（キーが変わった等）は、ユーザーが触っていなければ論理削除する
      for (const w of wiRows) {
        if (w.deleted_at !== null || activeWis.includes(w.id)) continue;
        if (w.title_user || w.hidden_at || w.manual_done_at) continue;
        if (followUps.some((f) => f.work_item_id === w.id)) continue;
        softDelete(o.mutate, schema.workItem, w.id);
      }

      // ターンの追加・更新（取り込みが書いたもの）を日付ごとの要約で比べる
      const turnSig = new Map<string, string>();
      for (const t of turns) {
        const wi = turnWi.get(t.id);
        if (!wi) continue;
        const k = `${wi}|${t.local_date}`;
        turnSig.set(k, `${turnSig.get(k) ?? ""}${t.id}:${t.ended_at ?? "-"}:${t.status};`);
      }
      diffSig(this.#turnSig, turnSig, changedWis, changedDates);
      this.#turnSig = turnSig;

      // ---------- 4. 待ち ----------
      const waits = yield* this.#waits(activeWis, factsFor, settings, now, today, timing);
      stats.waitSegments = waits.count;
      diffSig(this.#waitSig, waits.sig, changedWis, changedDates);
      this.#waitSig = waits.sig;

      this.lastRun = stats;
      try {
        o.afterRun?.(now, settings);
      } catch (e) {
        o.logger.warn("derive.after_run_failed", errorFields(e));
      }
      return stats;
    } finally {
      if (changedWis.size > 0)
        o.publish?.("work_item", { dates: [...changedDates].sort(), ids: [...changedWis].sort() });
      if (fuIds.size > 0)
        o.publish?.("follow_up", { ids: [...fuIds].sort(), workItemIds: [...fuWis].sort() });
      if (tasksTouched.size > 0) {
        const dates = new Set<string>([today]);
        for (const id of tasksTouched) {
          const d = o.sqlite
            .query<{ scheduled_date: string | null }, [string]>(
              "SELECT scheduled_date FROM task WHERE id = ?",
            )
            .get(id)?.scheduled_date;
          if (d) dates.add(d);
        }
        o.publish?.("task", {
          dates: [...dates].sort(),
          ids: [...tasksTouched].sort(),
          inbox: false,
        });
      }
    }
  }

  /** 返答タスクの解決の兆候（同じ repo_root・ブランチ）。3.3.1 */
  #signals(
    f: derive.WorkItemFacts,
    turns: TurnRow[],
    sessionById: Map<string, SessionRow>,
    prs: PrRow[],
    repoOf: (cwd: string | null) => string | null | undefined,
    isDefault: (repo: string, branch: string | null) => boolean,
  ): derive.ResolutionSignals {
    const triggerOf = (since: number) =>
      [...f.turns].reverse().find((t) => (t.endedAt ?? t.startedAt) <= since + 1) ?? f.turns.at(-1);
    const where = (since: number) => {
      const t = triggerOf(since);
      if (!t) return null;
      const repo = repoOf(t.cwd);
      if (!repo || !t.gitBranch) return null;
      return { repo, branch: t.gitBranch, sessionId: t.sessionId };
    };
    return {
      commitAfter: (since) => {
        const w = where(since);
        return w ? this.#git.firstCommitAfter(w.repo, w.branch, since) : null;
      },
      newSessionAfter: (since) => {
        const w = where(since);
        if (!w) return null;
        let best: number | null = null;
        for (const t of turns) {
          if (t.session_id === w.sessionId || t.started_at <= since) continue;
          if (t.initiator !== "human" && t.initiator !== "queued") continue;
          if (t.git_branch !== w.branch || repoOf(t.cwd) !== w.repo) continue;
          const s = sessionById.get(t.session_id);
          if (s?.is_noise === 1) continue;
          // トリガの後に始まったセッションだけ（前から並行して開いていたセッションへの入力は兆候にしない）
          if (!s || s.started_at <= since) continue;
          if (best === null || t.started_at < best) best = t.started_at;
        }
        return best;
      },
      prMergedAfter: (since) => {
        const w = where(since);
        if (!w || isDefault(w.repo, w.branch)) return null;
        let best: number | null = null;
        for (const p of prs) {
          if (p.state !== "merged" || p.head_ref !== w.branch || p.state_changed_at === null)
            continue;
          if (p.state_changed_at <= since) continue;
          if (best === null || p.state_changed_at < best) best = p.state_changed_at;
        }
        return best;
      },
    };
  }

  #applyFollowUps(
    wiId: string,
    f: derive.WorkItemFacts,
    actions: derive.FollowUpAction[],
    today: string,
    /** 頼んだタスク（D-107）。あれば自分の番は新しいタスクを作らずにこれに付ける */
    launchTaskId: string | null = null,
  ): { created: number; closed: number; tasks: string[]; followUps: string[] } {
    const o = this.#o;
    const out = { created: 0, closed: 0, tasks: [] as string[], followUps: [] as string[] };
    const w = o.sqlite
      .query<
        {
          title_user: string | null;
          title_auto: string | null;
          repo_root: string | null;
          branch: string | null;
          scratch: number;
        },
        [string]
      >("SELECT title_user, title_auto, repo_root, branch, scratch FROM work_item WHERE id = ?")
      .get(wiId);
    for (const a of actions) {
      if (a.type === "create") {
        const spec = a.spec;
        const pr =
          spec.kind === "review_pr" ? f.prs.find((p) => p.ref === spec.artifactRef) : undefined;
        // 題名は文字列で保存せず、種類とパラメータを保存して表示時に組み立てる（D-046）
        const params: TaskTitleParams = {
          title: w?.title_user ?? w?.title_auto ?? null,
          repo: w?.repo_root ? (w.repo_root.split("/").at(-1) ?? null) : null,
          branch: w?.branch ?? null,
          pr: pr?.number ?? null,
          prTitle: pr?.title ?? null,
          ...(w?.scratch === 1 || this.#isScratchCard(f, w?.repo_root ?? null)
            ? { scratch: true }
            : {}),
        };
        const fuId = newId(o.clock);
        if (launchTaskId) {
          insertRow(o.mutate, schema.followUp, {
            id: fuId,
            workItemId: wiId,
            kind: spec.kind,
            artifactRef: spec.artifactRef,
            dedupeKey: spec.dedupeKey,
            triggerAt: spec.triggerAt,
            triggerTurnId: spec.triggerTurnId,
            status: "open",
            taskId: launchTaskId,
          });
          out.created++;
          out.tasks.push(launchTaskId);
          out.followUps.push(fuId);
          continue;
        }
        // 止まっている AI への対応（許可・AskUserQuestion への返答・再開）は「自分」の先頭（D-049 (1)）
        const head =
          spec.kind === "approve" ||
          spec.kind === "resume_error" ||
          derive.isAskReply({ kind: spec.kind, artifactRef: spec.artifactRef });
        const task = insertRow(o.mutate, schema.task, {
          title: "",
          titleKey: taskTitleKeyFor(spec.kind),
          titleParams: JSON.stringify(params),
          status: "todo",
          scheduledDate: today,
          laneOrder: this.#laneOrder(today, head),
          source: "ai",
          sourceRef: `follow_up:${fuId}`,
          // プロジェクトとリポジトリの対応（m2-api.md 19章）
          projectId: projectIdForRepo(o.sqlite, w?.repo_root),
        });
        insertRow(o.mutate, schema.followUp, {
          id: fuId,
          workItemId: wiId,
          kind: spec.kind,
          artifactRef: spec.artifactRef,
          dedupeKey: spec.dedupeKey,
          triggerAt: spec.triggerAt,
          triggerTurnId: spec.triggerTurnId,
          status: "open",
          taskId: task.id,
        });
        out.created++;
        out.tasks.push(task.id);
        out.followUps.push(fuId);
        continue;
      }
      const row = o.sqlite
        .query<FollowUpRow, [string]>("SELECT * FROM follow_up WHERE id = ?")
        .get(a.id);
      if (!row) continue;
      out.followUps.push(a.id);
      if (a.type === "wake") {
        updateRow(o.mutate, schema.followUp, a.id, { status: "open" });
        continue;
      }
      if (a.type === "reopen") {
        // 上限待ちの明ける時刻が伸びて自動で閉じた再開のタスクを、明けた時点で同じ行のまま開き直す（作り直さない。
        // 通知は開いた行として 1 回）。タスクも今日の「自分」の先頭に戻す。旧版が完了として数えた見込みの時間は消す
        updateRow(o.mutate, schema.followUp, a.id, {
          status: "open",
          triggerAt: a.triggerAt,
          closedAt: null,
          closeReason: null,
          engagedAt: null,
        });
        out.created++;
        if (row.task_id && !isLaunchTask(o.sqlite, row.task_id)) {
          updateRow(o.mutate, schema.task, row.task_id, {
            status: "todo",
            autoCompleted: 0,
            completedAt: null,
            scheduledDate: today,
            laneOrder: this.#laneOrder(today, true),
          });
          for (const e of o.sqlite
            .query<{ id: string }, [string]>(
              "SELECT id FROM task_time_entry WHERE task_id = ? AND source = 'followup_estimate' AND deleted_at IS NULL",
            )
            .all(row.task_id))
            softDelete(o.mutate, schema.taskTimeEntry, e.id);
        }
        if (row.task_id) out.tasks.push(row.task_id);
        continue;
      }
      updateRow(o.mutate, schema.followUp, a.id, {
        status: a.status,
        closedAt: a.at,
        closeReason: a.reason,
        snoozesJson: capSnoozes(row.snoozes_json, a.at),
      });
      out.closed++;
      if (row.task_id && isLaunchTask(o.sqlite, row.task_id)) {
        // 頼んだタスク（D-107）は閉じない。帯から外れてボードに戻る
        out.tasks.push(row.task_id);
      } else if (row.task_id) {
        const done = a.status === "done";
        updateRow(o.mutate, schema.task, row.task_id, {
          status: done ? "done" : "canceled",
          autoCompleted: 1,
          completedAt: done ? a.at : null,
        });
        if (done) {
          const est = derive.estimateResponse(row.engaged_at, a.at);
          insertRow(o.mutate, schema.taskTimeEntry, {
            taskId: row.task_id,
            startAt: est.start,
            endAt: est.end,
            source: "followup_estimate",
          });
        }
        out.tasks.push(row.task_id);
      }
    }
    return out;
  }

  /** 今日の「自分」の先頭（approve / resume_error）か末尾 */
  #laneOrder(date: string, head: boolean): string {
    const rows = this.#o.sqlite
      .query<{ lane_order: string }, [string]>(
        "SELECT lane_order FROM task WHERE scheduled_date = ? AND deleted_at IS NULL ORDER BY lane_order",
      )
      .all(date);
    if (rows.length === 0) return orderKeyBetween(null, null);
    return head
      ? orderKeyBefore((rows[0] as { lane_order: string }).lane_order)
      : orderKeyAfter((rows.at(-1) as { lane_order: string }).lane_order);
  }

  #writeWorkItem(
    wiId: string,
    f: derive.WorkItemFacts,
    st: derive.StatusResult,
    now: number,
    sessionById: Map<string, SessionRow>,
    prs: PrRow[],
    exclusive: boolean,
    /** 頼んだタスク（D-107）。あればその題名をカードの題名にする（ツールの要約・ブランチ名より分かりやすい） */
    launchTaskId: string | null = null,
  ): { status: boolean; any: boolean } {
    const o = this.#o;
    const w = o.sqlite
      .query<WorkItemRow, [string]>("SELECT * FROM work_item WHERE id = ?")
      .get(wiId);
    if (!w) return { status: false, any: false };
    const myPrs = prs
      .filter((p) => p.work_item_id === wiId)
      .sort((a, b) => a.first_seen_at - b.first_seen_at);
    const sess = f.sessions
      .map((s) => sessionById.get(s.id))
      .filter((s): s is SessionRow => !!s)
      .sort((a, b) => b.last_activity_at - a.last_activity_at);
    const launchTitle = launchTaskId
      ? (o.sqlite
          .query<{ title: string }, [string]>("SELECT title FROM task WHERE id = ?")
          .get(launchTaskId)?.title ?? null)
      : null;
    const t = launchTitle
      ? { title: launchTitle, source: "session_name" as const }
      : cardTitle({
          kind: f.kind,
          branch: w.branch,
          repoRoot:
            w.repo_root ??
            f.turns.map((x) => (x.cwd ? this.#git.repoRoot(x.cwd) : null)).find((r) => r) ??
            null,
          prTitles: myPrs.map((p) => p.title).reverse(),
          sessionTitles: sess
            .filter((s) => s.title)
            .map((s) => ({ title: s.title as string, source: s.title_source })),
          exclusive,
        });
    const tools = [...new Set(f.sessions.map((s) => s.tool))].sort();
    const first = Math.min(
      ...f.turns.map((x) => x.startedAt),
      ...myPrs.map((p) => p.first_seen_at),
    );
    const last = Math.max(
      ...f.turns.map((x) => x.endedAt ?? x.startedAt),
      ...myPrs.map((p) => p.first_seen_at),
    );
    const patch: Record<string, unknown> = {};
    const set = (k: string, cur: unknown, v: unknown) => {
      if (cur !== v) patch[k] = v;
    };
    set("titleAuto", w.title_auto, t.title);
    set("titleSource", w.title_source, t.source);
    set("prRef", w.pr_ref, myPrs.at(-1)?.ref ?? null);
    // 既定ブランチの session カードもリポジトリを持つ（git 管理外だけが「(no repo)」。D-061）
    const repoRoot =
      f.kind === "session"
        ? derive.sessionCardRepoRoot(
            [...f.turns]
              .sort((a, b) => a.startedAt - b.startedAt)
              .map((x) =>
                !x.cwd ? null : this.#git.cwdExists(x.cwd) ? this.#git.repoRoot(x.cwd) : undefined,
              ),
            sess.map((s) => this.#sessionRepo(s)),
          )
        : w.repo_root;
    if (f.kind === "session") set("repoRoot", w.repo_root, repoRoot);
    set("scratch", w.scratch, this.#isScratchCard(f, repoRoot) ? 1 : 0);
    set("toolsJson", w.tools_json, JSON.stringify(tools));
    set("firstActivityAt", w.first_activity_at, first);
    set("lastActivityAt", w.last_activity_at, last);
    const changed = w.status !== st.status;
    // 理由だけの変化（done の ended ↔ 上限待ちの rate_limit など）もレーンの表示が変わるので知らせる
    const any =
      changed || w.status_reason !== st.reason || Object.keys(patch).some((k) => k !== "toolsJson");
    if (changed) {
      patch.status = st.status;
      patch.statusChangedAt = now;
    }
    set("statusReason", w.status_reason, st.reason);
    set("statusEstimated", w.status_estimated, st.estimated ? 1 : 0);
    if (Object.keys(patch).length > 0) {
      updateRow(o.mutate, schema.workItem, wiId, patch as never);
    }
    if (changed) {
      o.sqlite.transaction(() => {
        o.sqlite.run(
          "UPDATE work_item_status_log SET to_at = ? WHERE work_item_id = ? AND to_at IS NULL",
          [now, wiId],
        );
        o.sqlite.run(
          "INSERT INTO work_item_status_log (id, work_item_id, status, from_at, to_at, reason) VALUES (?, ?, ?, ?, NULL, ?)",
          [newId(o.clock), wiId, st.status, now, st.reason],
        );
      })();
    }
    return { status: changed, any };
  }

  /** 待ち区間を作り直す（窓より古い日は自動では作り直さない。W25） */
  *#waits(
    wis: string[],
    factsFor: (id: string) => derive.WorkItemFacts | null,
    settings: TurnlaneSettings,
    now: number,
    today: string,
    timing: derive.DeriveTiming,
  ): Generator<void, { count: number; sig: Map<string, string> }, void> {
    const o = this.#o;
    const sig = new Map<string, string>();
    const presenceSinceDate =
      settings.presenceSince !== null
        ? toLocalDate(settings.presenceSince, settings.tz, settings.dayBoundary)
        : null;
    const from = derive.waitRecomputeFrom(today, settings, this.#waitSince, presenceSinceDate);
    // 在席（D-105）。作り直す範囲より少し前（PRESENCE_LOOKBACK_DAYS 日前）からの在席を読む
    const presence = presenceFrom(
      o.sqlite,
      settings,
      dayStartMs(addDays(from, -PRESENCE_LOOKBACK_DAYS), settings.tz, settings.dayBoundary),
    );
    const busy = o.sqlite
      .query<derive.CalendarEventFact & { role: "source" | "writeback" | "ignored" }, []>(
        `SELECT e.start_at AS startAt, e.end_at AS endAt, e.status, e.availability, e.self_response AS selfResponse,
                e.is_own_timeblock AS isOwnTimeblock, c.role AS calendarRole
         FROM calendar_event e JOIN calendar c ON c.id = e.calendar_id`,
      )
      .all()
      .map((e) => ({ ...e, isOwnTimeblock: Boolean(e.isOwnTimeblock) }))
      .filter((e) => derive.isBusyEvent(e))
      .map((e) => [e.startAt, e.endAt] as [number, number]);
    const ctx = { settings, presence, busy };
    const starts: number[] = [];
    // 区間を先に計算し（カードごとに譲る）、書き込みは最後に 1 つのトランザクションでまとめる
    const rows: (string | number | null)[][] = [];
    for (const wiId of wis) {
      yield;
      const f = factsFor(wiId);
      if (!f) continue;
      for (const iv of derive.waitIntervals(f, now, settings, timing)) {
        starts.push(iv.start);
        for (const s of derive.classifyWait(iv, ctx)) {
          if (s.localDate < from) continue;
          rows.push([
            newId(o.clock),
            wiId,
            iv.waitKey,
            iv.followUpId,
            s.localDate,
            s.kind,
            s.excludedBy,
            s.start,
            s.end,
            iv.isOpen ? 1 : 0,
            iv.endReason,
            iv.estimated ? 1 : 0,
            now,
          ]);
          // 区間の行の増減・区分の変化だけを比べる（開いている区間の伸びは比べない）
          const k = `${wiId}|${s.localDate}`;
          sig.set(
            k,
            `${sig.get(k) ?? ""}${iv.waitKey}:${s.kind}:${s.excludedBy ?? ""}:${s.start}:${iv.isOpen ? "open" : s.end};`,
          );
        }
      }
    }
    yield;
    // 前回と同じ行は残し、変わった分だけ消して足す（毎回全部を書き直すと、行が多いときに書き込みが長くなる）
    const sigOf = (r: readonly unknown[]) => JSON.stringify(r);
    const keep = new Map<string, string[]>();
    for (const e of o.sqlite
      .query<{ id: string; r: string }, [string]>(
        `SELECT id, json_array(work_item_id, wait_key, follow_up_id, local_date, kind, excluded_by, start_at, end_at,
           is_open, end_reason, estimated) AS r FROM ai_wait_segment WHERE local_date >= ?`,
      )
      .all(from)) {
      const k = sigOf(JSON.parse(e.r) as unknown[]);
      const ids = keep.get(k);
      if (ids) ids.push(e.id);
      else keep.set(k, [e.id]);
    }
    const added: (string | number | null)[][] = [];
    for (const r of rows) {
      const ids = keep.get(sigOf(r.slice(1, 12)));
      if (ids && ids.length > 0) ids.pop();
      else added.push(r);
    }
    const insert = o.sqlite.query(
      `INSERT INTO ai_wait_segment (id, work_item_id, wait_key, follow_up_id, local_date, kind, excluded_by,
         start_at, end_at, is_open, end_reason, estimated, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const remove = o.sqlite.query("DELETE FROM ai_wait_segment WHERE id = ?");
    o.sqlite.transaction(() => {
      for (const ids of keep.values()) for (const id of ids) remove.run(id);
      for (const r of added) insert.run(...(r as [string]));
    })();
    const n = rows.length;
    this.#waitStarts = starts;
    return { count: n, sig };
  }
}

/** 非同期の実行でイベントループに譲る間隔（ms）。health が 100 ms 以内に返る目安より十分短く */
const SLICE_MS = 15;
/** 続けて打ち切ったら、次は譲らずに実行する回数 */
const MAX_ABORTS = 3;

function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

function memo<T>(fn: (k: string) => T): (k: string) => T {
  const m = new Map<string, T>();
  return (k) => {
    if (m.has(k)) return m.get(k) as T;
    const v = fn(k);
    m.set(k, v);
    return v;
  };
}

/** 1 回の実行の間だけ cwd の存在とリポジトリを覚える GitProbe（ターンごとに同じ cwd を何度も見る） */
function memoGit(git: GitProbe): GitProbe {
  const exists = memo((cwd) => git.cwdExists(cwd));
  const root = memo((cwd) => git.repoRoot(cwd));
  return {
    repoRoot: root,
    cwdExists: exists,
    currentBranch: (cwd) => git.currentBranch(cwd),
    defaultBranch: (r) => git.defaultBranch(r),
    isDirty: (r) => git.isDirty(r),
    firstCommitAfter: (r, b, since) => git.firstCommitAfter(r, b, since),
    remoteRepos: (r) => git.remoteRepos(r),
  };
}

/** 「AI 項目 | 日付」→ 要約 の前後を比べ、変わったものの ID と日付を足す */
function diffSig(
  prev: Map<string, string>,
  next: Map<string, string>,
  ids: Set<string>,
  dates: Set<string>,
): void {
  for (const k of new Set([...prev.keys(), ...next.keys()])) {
    if (prev.get(k) === next.get(k)) continue;
    const i = k.lastIndexOf("|");
    ids.add(k.slice(0, i));
    dates.add(k.slice(i + 1));
  }
}

/** スヌーズの最後の区間を、閉じた・⏎ した時刻で切る（D-032） */
export function capSnoozes(json: string, at: number): string {
  let v: [number, number][] = [];
  try {
    v = JSON.parse(json) as [number, number][];
  } catch {
    return json;
  }
  const last = v.at(-1);
  if (last && last[1] > at) last[1] = Math.max(last[0], at);
  return JSON.stringify(v);
}
