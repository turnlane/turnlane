/**
 * 在席（Mac を使っていた時間。D-105・D-110・D-139、ADR 0013）。
 *
 * デーモンが 30 秒ごとに「最後の入力からの秒数」を読み、最後の入力から T 分（presence.tail_min、既定 5 分）までを
 * 在席とする。保存するのは「入力のあった区間」（始まり・最後の入力の時刻・続けて見ていた最後のサンプルの時刻）だけで、
 * どのアプリを使ったか・何を打ったかは取らない。T は保存のときではなく、読むとき（`expandPresence`）に足す（D-139）。
 * そのため T を変えると、過去の日も同じ規則で数え直せる。
 *
 * - サンプルの間が `PRESENCE_MAX_GAP_MS` 以上空いた（スリープ・デーモンの停止）ら、その間は不在。空いた後のサンプルは、
 *   最後の入力が空く前のサンプルより後のときだけ在席を足す
 * - 画面ロック中・別ユーザーに切り替えている間（ファストユーザスイッチ）は不在
 * - 区間の終わりはサンプルの時刻を超えない（スリープの直前に操作しても、眠っている間を在席にしない）。そのために
 *   「続けて見ていた最後のサンプルの時刻」（seen_until）を区間ごとに持つ
 */

type Range = [number, number];

/** サンプルの間隔 */
export const PRESENCE_SAMPLE_MS = 30_000;
/** これ以上サンプルが空いたら、その間は不在（スリープ・デーモンの停止） */
export const PRESENCE_MAX_GAP_MS = 120_000;
/** 「使っていた」とみなす長さ T の範囲（分）と既定値 */
export const PRESENCE_TAIL_MIN = { min: 2, max: 15, default: 5 } as const;
/**
 * 入力の間がこれ以下なら同じ区間にまとめる（T の下限。どの T でもつながる間なので、まとめても数え方は変わらない）。
 * これより長い間は区間を分けて残す（あとで短い T を評価できるように）
 */
export const PRESENCE_MERGE_MS = PRESENCE_TAIL_MIN.min * 60_000;

export interface PresenceSample {
  /** サンプルの時刻 */
  at: number;
  /** 最後の入力からの経過（ms）。読めなければ null（在席を足さない） */
  idleMs: number | null;
  /** 画面ロック中 */
  locked: boolean;
  /** このユーザーがコンソールにいない（別ユーザーに切り替え中） */
  offConsole: boolean;
}

/**
 * 前のサンプル（時刻と、そのときの最後の入力の時刻）。lastInput が null なのは、読めなかった・ロック中・別ユーザー・
 * 空いた後の証拠にならない入力だったとき（続きを足さない）
 */
export interface PrevSample {
  at: number;
  lastInput: number | null;
}

/**
 * 保存する在席の区間（presence_span の1行。D-139）。start〜end は入力のあった区間（end = 最後の入力の時刻）。
 * seenUntil は、その最後の入力から途切れずに見ていた最後のサンプルの時刻（T を足しても、これを超えない）。
 * null は上限なし（D-139 のマイグレーションで、T を足して保存していた古い行のうち上限の分からないもの）
 */
export interface PresenceRow {
  start: number;
  end: number;
  seenUntil: number | null;
}

export interface PresenceStep {
  /** 最後の行を書き換えた値（変わらなければ null） */
  update: PresenceRow | null;
  /** 新しく足す行（Mac に戻ってきた。無ければ null） */
  insert: PresenceRow | null;
  /** 次のサンプルの prev */
  prev: PrevSample;
}

/**
 * 1つのサンプルで保存する区間をどう変えるか（D-139）。last は保存されている最後の区間、prev は前のサンプル
 * （デーモンの起動直後は null。空いた後と同じに扱う。D-139 (3) で前回の続きを引き継いだときは、その最後の区間から作る）。
 * - 前のサンプルから途切れずに見ている（間が空かず、前のサンプルの入力が証拠になった）なら、最後の区間の seenUntil を今にする
 * - 新しい入力が最後の区間の終わりから `PRESENCE_MERGE_MS` 以内で、まだ見ていた間なら最後の区間を延ばす。離れていれば新しい区間
 * - 空いた後（起動直後を含む）は、空く前のサンプル（起動直後は1間隔前）より後の入力だけを証拠にする
 */
export function presenceStep(
  last: PresenceRow | null,
  s: PresenceSample,
  prev: PrevSample | null,
): PresenceStep {
  const none: PresenceStep = { update: null, insert: null, prev: { at: s.at, lastInput: null } };
  if (s.locked || s.offConsole || s.idleMs === null || s.idleMs < 0) return none;
  const input = s.at - s.idleMs;
  const unbroken = prev !== null && prev.lastInput !== null && s.at - prev.at < PRESENCE_MAX_GAP_MS;
  const floor = unbroken ? Number.NEGATIVE_INFINITY : (prev?.at ?? s.at - PRESENCE_SAMPLE_MS);
  if (input <= floor) return none;
  let cur: PresenceRow | null = last ? { ...last } : null;
  let changed = false;
  if (unbroken && cur && cur.seenUntil !== null && cur.seenUntil < s.at) {
    cur.seenUntil = s.at;
    changed = true;
  }
  let insert: PresenceRow | null = null;
  if (!cur || input > cur.end) {
    if (
      cur &&
      input - cur.end <= PRESENCE_MERGE_MS &&
      input <= (cur.seenUntil ?? Number.POSITIVE_INFINITY)
    ) {
      cur = { ...cur, end: input, seenUntil: s.at };
      changed = true;
    } else insert = { start: input, end: input, seenUntil: s.at };
  }
  return { update: changed ? cur : null, insert, prev: { at: s.at, lastInput: input } };
}

/**
 * 保存した区間に T を足して、在席の区間（和集合済み・開始順）にする（D-139）。各区間は [start, min(end + T, seenUntil)]。
 * 長さ 0 の区間は落とす
 */
export function expandPresence(rows: readonly PresenceRow[], tailMs: number): Range[] {
  const xs: Range[] = [];
  for (const r of rows) {
    const e = r.seenUntil === null ? r.end + tailMs : Math.min(r.end + tailMs, r.seenUntil);
    if (e > r.start) xs.push([r.start, e]);
  }
  xs.sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of xs) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** 区間（和集合済み・開始順）のうち、t 以降で最初に在席した時刻。t が区間の中なら t。無ければ null */
export function firstPresentAt(presence: readonly Range[], t: number): number | null {
  for (const [s, e] of presence) {
    if (e <= t) continue;
    return Math.max(s, t);
  }
  return null;
}

export type WorkOpCandidate =
  | { kind: "ai_turn"; at: number; initiator: string | null }
  | { kind: "usage_event"; at: number; usageKind: string }
  | { kind: "task_completed"; at: number; autoCompleted: boolean };

/**
 * 本人の操作か（D-076 の「実際に作業した日」と時間外の作業に使う。W22: MCP・ui_open・自動クローズ・カレンダーヘルパは
 * 操作にしない）
 */
export function isWorkOp(op: WorkOpCandidate): boolean {
  switch (op.kind) {
    case "ai_turn":
      return op.initiator === "human" || op.initiator === "queued";
    case "usage_event":
      return op.usageKind === "user_op";
    case "task_completed":
      return !op.autoCompleted;
  }
}
