/**
 * 通知の判定（ux-mvp 4.7、D-052 (2)、desktop-shell.md 3章）。純粋関数にしてテストする。
 * デーモンの NotifyRunner（デスクトップアプリへの `notify` イベント）と web のブラウザ通知（M2-8）が同じ関数を使う。
 * - needs_input / error は即時、your_turn は15分ごとにまとめる
 * - 同じカードの通知は5分以内に再送しない
 * - 新しく出た（前回に無かった）フォローアップだけを対象にする（m2-api.md 7章: followUps[].id を前回と比べる）
 * - 許可待ち（approve）は PermissionRequest から 10 秒（PERMISSION_GRACE_MS）待つ。その間に AI が進めば（セッションか
 *   サブエージェントのトランスクリプトに活動があり、許可待ちが閉じれば）通知しない。10 秒過ぎても止まっていれば即時に出す
 * - 閉店モード（Close the day から翌朝 Mac を使い始めるまで。D-110 (1)）はすべて止める。設定でオンなら needs_input だけ出す（D-052 (2)）
 */
import type { QueueFollowUp, QueueItem } from "../api/queue.ts";
import { repoName } from "../format.ts";
import { formatTaskSubject, type Locale } from "../i18n/task-title.ts";

export const BATCH_MS = 15 * 60_000;
export const RESEND_MS = 5 * 60_000;
/** 許可待ちの即時の通知を待つ時間（自動で許可されてすぐ進む許可の hook で鳴らさない） */
export const PERMISSION_GRACE_MS = 10_000;

/** 帯・サイドバー・メニューバーに出すカード（open なフォローアップがあるもの。スヌーズ中だけのカードは数えない。D-048 (4)） */
export function visibleQueue(items: readonly QueueItem[] | undefined): QueueItem[] {
  return (items ?? []).filter((x) => x.followUps.some((f) => f.status === "open"));
}

/**
 * 表示用の自分の番の行（D-245）: visibleQueue（通知と同じ）の後ろに猶予中の問い（`grace`）を足す。帯の上限の中でも猶予中は
 * 最後。同じ項目が items にもあれば items のほうだけ（猶予が過ぎて返答タスクができたら、同じ workItemId のまま普通の行になる）。
 * 見出しの数は `countedTurns`（猶予中を含めない）
 */
export function turnRows(
  items: readonly QueueItem[] | undefined,
  grace: readonly QueueItem[] | undefined,
): QueueItem[] {
  const shown = visibleQueue(items);
  const ids = new Set(shown.map((x) => x.workItemId));
  return [...shown, ...(grace ?? []).filter((x) => isGrace(x) && !ids.has(x.workItemId))];
}

/** 猶予中の行（D-245。返答タスクの無い問いの待ち） */
export function isGrace(item: Pick<QueueItem, "grace" | "followUps">): boolean {
  return item.grace !== undefined && !item.followUps.some((f) => f.status === "open");
}

/** 後でに出すフォローアップの状態（スヌーズ中・時間に置いた開始の前） */
const isDeferred = (f: Pick<QueueFollowUp, "status">) =>
  f.status === "snoozed" || f.status === "scheduled";

/** フォローアップが帯に戻る時刻（スヌーズの終わり・時間ブロックの開始。分からなければ Infinity） */
const backAtOf = (f: QueueFollowUp): number =>
  (f.status === "scheduled" ? f.scheduledAt : f.snoozeUntil) ?? Number.POSITIVE_INFINITY;

/**
 * 「後で」の行（自分の番の画面だけ）: open なフォローアップが無く、スヌーズ中か時間に置いた開始の前（scheduled）のものが
 * あるカード（スヌーズ・明日へ・時間に置いた）と、リセット前の上限待ち（`limitWaits`）。帯・件数・通知には入れない。
 * 同じカードが普通の行にあれば出さない。戻る早い順（種類を混ぜて時刻順）
 */
export function laterRows(
  items: readonly QueueItem[] | undefined,
  limitWaits: readonly QueueItem[] | undefined,
): QueueItem[] {
  const shown = new Set(visibleQueue(items).map((x) => x.workItemId));
  const deferred = (items ?? []).filter(
    (x) => !shown.has(x.workItemId) && x.followUps.some(isDeferred),
  );
  const ids = new Set([...shown, ...deferred.map((x) => x.workItemId)]);
  const limits = (limitWaits ?? []).filter((x) => x.limitWait && !ids.has(x.workItemId));
  return [...deferred, ...limits].sort((a, b) => laterBackAt(a) - laterBackAt(b));
}

/** 後での行か（普通の行・猶予中の行でない） */
export function isLater(item: Pick<QueueItem, "grace" | "followUps" | "limitWait">): boolean {
  if (item.limitWait) return true;
  const fus = item.followUps ?? [];
  return item.grace === undefined && fus.length > 0 && !fus.some((f) => f.status === "open");
}

/** 後での行のフォローアップ（スヌーズ中・時間に置いた開始の前のうち、戻るのがいちばん早いもの）。上限待ちの行は undefined */
export function laterFollowUp(item: QueueItem): QueueFollowUp | undefined {
  return item.followUps.filter(isDeferred).sort((a, b) => backAtOf(a) - backAtOf(b))[0];
}

/**
 * 後での行の種類: limit = リセット前の上限待ち、scheduled = 時間に置いた自分の番（開始の前）、tomorrow = 明日へ
 * （タスクの日付が今日より後のスヌーズ）、snoozed = スヌーズ
 */
export type LaterKind = "limit" | "scheduled" | "tomorrow" | "snoozed";

export function laterKind(item: QueueItem, today: string): LaterKind {
  if (item.limitWait) return "limit";
  const f = laterFollowUp(item);
  if (f?.status === "scheduled") return "scheduled";
  return f?.taskDate && f.taskDate > today ? "tomorrow" : "snoozed";
}

/** 後での行が戻る時刻（分からなければ Infinity） */
export function laterBackAt(item: QueueItem): number {
  if (item.limitWait) return item.limitWait.until;
  const f = laterFollowUp(item);
  return f ? backAtOf(f) : Number.POSITIVE_INFINITY;
}

/** 見出しの「自分の番 N」の数（猶予中を含めない。D-245） */
export function countedTurns(rows: readonly QueueItem[]): number {
  return rows.filter((x) => !isGrace(x)).length;
}

const KIND_RANK: Record<string, number> = { approve: 0, resume_error: 1, reply: 2, review_pr: 3 };

/** カードの代表のフォローアップ（帯の1行の題名） */
export function primaryFollowUp(item: QueueItem): QueueFollowUp | undefined {
  return [...item.followUps]
    .filter((f) => f.status === "open")
    .sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9))[0];
}

export interface NotifyState {
  /** 通知の対象として見た followUp の id（初回の読み込みでは通知しない） */
  seen: Set<string>;
  /** カード → 最後に通知した時刻 */
  lastByCard: Map<string, number>;
  /** まとめ待ちの your_turn（カードの id） */
  pending: Set<string>;
  lastBatchAt: number;
  initialized: boolean;
}

export function initialNotifyState(): NotifyState {
  return {
    seen: new Set(),
    lastByCard: new Map(),
    pending: new Set(),
    lastBatchAt: 0,
    initialized: false,
  };
}

export type Notice = { kind: "immediate"; item: QueueItem } | { kind: "batch"; items: QueueItem[] };

export function planNotifications(
  s: NotifyState,
  items: readonly QueueItem[],
  now: number,
): {
  state: NotifyState;
  notices: Notice[];
  /** 許可待ちの猶予の間で通知を見送ったとき、もう一度判定する時刻 */
  recheckAt?: number;
} {
  const open = items.filter((x) => x.followUps.some((f) => f.status === "open"));
  const ids = new Set(
    open.flatMap((x) => x.followUps.filter((f) => f.status === "open").map((f) => f.id)),
  );
  const state: NotifyState = {
    seen: new Set([...s.seen].filter((id) => ids.has(id))),
    lastByCard: new Map(s.lastByCard),
    pending: new Set([...s.pending].filter((id) => open.some((x) => x.workItemId === id))),
    lastBatchAt: s.lastBatchAt || now,
    initialized: true,
  };
  const notices: Notice[] = [];
  let recheckAt: number | undefined;
  for (const item of open) {
    const fresh = item.followUps.filter((f) => f.status === "open" && !s.seen.has(f.id));
    // 許可待ちの猶予: 新しい許可待ちだけで、どれも PERMISSION_GRACE_MS より新しければ、まだ見ていないことにして見送る
    if (
      s.initialized &&
      item.status === "needs_input" &&
      fresh.length > 0 &&
      fresh.every((f) => f.kind === "approve" && now - f.triggerAt < PERMISSION_GRACE_MS)
    ) {
      const due = Math.max(...fresh.map((f) => f.triggerAt)) + PERMISSION_GRACE_MS;
      recheckAt = Math.min(recheckAt ?? due, due);
      for (const f of item.followUps)
        if (f.status === "open" && s.seen.has(f.id)) state.seen.add(f.id);
      continue;
    }
    for (const f of item.followUps) if (f.status === "open") state.seen.add(f.id);
    if (!s.initialized || fresh.length === 0) continue;
    const last = state.lastByCard.get(item.workItemId) ?? Number.NEGATIVE_INFINITY;
    if (now - last < RESEND_MS) continue;
    if (item.status === "needs_input" || item.status === "error") {
      notices.push({ kind: "immediate", item });
      state.lastByCard.set(item.workItemId, now);
    } else state.pending.add(item.workItemId);
  }
  if (state.pending.size > 0 && now - state.lastBatchAt >= BATCH_MS) {
    const batch = open.filter((x) => state.pending.has(x.workItemId));
    if (batch.length > 0) notices.push({ kind: "batch", items: batch });
    for (const x of batch) state.lastByCard.set(x.workItemId, now);
    state.pending.clear();
    state.lastBatchAt = now;
  }
  return { state, notices, ...(recheckAt !== undefined ? { recheckAt } : {}) };
}

// ---- 文言（web の辞書から移した。web とデーモンが同じものを使う。desktop-shell.md 3.2） ----

const TEXT = {
  en: {
    needs: "Blocked",
    error: "Error",
    turnOne: "1 item is waiting on you",
    turnOther: "{count} items are waiting on you",
  },
  ja: {
    needs: "ブロック中",
    error: "エラー",
    turnOne: "自分の番が {count} 件あります",
    turnOther: "自分の番が {count} 件あります",
  },
} as const;

/** 待ちの種類の言葉（英語は文頭に置く短い形。web の turn.why.* と同じ。spec-glance §2.3） */
export type WhyKind =
  | "approve"
  | "reply"
  | "answer"
  | "review_pr"
  | "merge_pr"
  | "resume_error"
  | "resume_limit"
  | "check_changes";

export const WHY_TEXT: Record<Locale, Record<WhyKind, string>> = {
  en: {
    approve: "Needs approval",
    reply: "Needs reply",
    answer: "Needs answer",
    review_pr: "Needs review",
    merge_pr: "Ready to merge",
    resume_error: "Stopped on error",
    resume_limit: "Can resume",
    check_changes: "Changes to check",
  },
  ja: {
    approve: "許可待ち",
    reply: "返答待ち",
    answer: "回答待ち",
    review_pr: "レビュー待ち",
    merge_pr: "マージ待ち",
    resume_error: "エラーで停止",
    resume_limit: "再開できる",
    check_changes: "変更の確認待ち",
  },
};

/** フォローアップの待ちの種類（AskUserQuestion への返答は回答待ち、上限待ちが明けた後の再開は再開できる） */
export function whyOf(
  f: (Pick<QueueFollowUp, "kind" | "ask"> & { limit?: boolean }) | undefined,
): WhyKind | null {
  if (!f) return null;
  if (f.kind === "reply") return f.ask ? "answer" : "reply";
  if (f.kind === "resume_error" && f.limit) return "resume_limit";
  return f.kind;
}

/**
 * 自分の番の件名（D-207 (3)(5)。前置きの「許可:」「返答:」を外したもの）。通知・メニューバーの既定。表示の瞬間に読む
 * 直近の指示（glance）はここに入れない（通知は macOS が保存し、SSE で送るため。D-207 (4)）
 */
export function followUpSubject(item: QueueItem, locale: Locale): string {
  const spec = primaryFollowUp(item)?.title;
  if (!spec) return item.title ?? "";
  return spec.t === "text" ? spec.text : formatTaskSubject(spec.key, spec.params, locale);
}

/**
 * 通知に出す中身（設定 notify.content。D-207 (4)）: subject = 件名と待ちの種類 · リポジトリ（既定）、minimal = 件名も
 * 出さず、待ちの種類とリポジトリだけ。AI の問い・コマンドを出す選択肢は作らない
 */
export type NotifyContent = "subject" | "minimal";

const fill = (s: string, p: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(p[k] ?? ""));

/** 通知の1件（デーモンの `notify` イベントの notices[]、web のブラウザ通知） */
export interface NoticeMessage {
  /** 通知の識別子。即時は `wi:<workItemId>`、まとめは `turn`（同じ id は OS 側で置き換わる） */
  id: string;
  /** focus_prompt は集中モードの問い（ボタン付き）、focus_summary は集中の終わりのまとめ（D-097。m2-api 25章） */
  kind: "immediate" | "batch" | "focus_prompt" | "focus_summary";
  status: "needs_input" | "error" | "your_turn" | "focus";
  title: string;
  /** 副題（即時の通知の `待ちの種類 · リポジトリ`。D-207 (4)）。macOS の通知の副題。ブラウザ通知は本文の先頭に置く */
  subtitle?: string;
  /**
   * 即時はブランチ（minimal では空）、まとめは1行に1件（`件名 — 待ちの種類`、minimal は `repo · branch`）。
   * 会話本文・コマンド・AI の問い・表示の瞬間に読む中身（glance）は入れない（ADR 0005 の追記 2、D-207 (4)）。
   * 直近の指示はここに入れず、アプリが出す直前に読む（promptTitle。D-211）
   */
  body: string;
  /** クリックで開く画面。即時は `/queue?item=<workItemId>&open=<followUpId>`（open があればアプリはそのタスクを開く） */
  path: string;
  /** needs_input だけ鳴らす（D-056 (3)） */
  sound: boolean;
  /** 通知上のボタン（集中モードの問いだけ。id は focus / skip、title は表示の文言。desktop-shell.md 3.5） */
  actions?: { id: string; title: string }[];
  /**
   * 即時の通知で、題名を直近の意味のある指示に差し替えてよい（D-211。spec-glance §2.2）。真偽値だけで中身は入れない。
   * デスクトップアプリが出す直前に glance（`GET /api/work-items/:id/glance`）を読み、`prompt` があれば題名にする。
   * 無ければ（設定「行に中身を出す」がオフ・読めない）`title`（名前 → ai-title → PR の題名 → ブランチ → リポジトリ）のまま。
   * 自分で付けた名前・「件名も出さない」では付けない（PR の確認待ち・マージ待ちも付ける。D-214 (1)）
   */
  promptTitle?: boolean;
  /**
   * まとめの通知で、body の各行を直近の意味のある指示（行と同じ件名）に差し替えてよい（D-214 (1)。D-211 の即時の通知と同じ）。
   * body の行と同じ順。差し替えてよい行は項目の ID と行の後ろ（` — 待ちの種類`）、差し替えない行は null。中身は入れない。
   * デスクトップアプリが出す直前に各項目の glance を読み、`prompt` があれば `<prompt><suffix>` にする
   */
  promptLines?: ({ workItemId: string; suffix: string } | null)[];
}

export const noticeWhere = (i: QueueItem) => `${repoName(i.repoRoot) ?? "-"} · ${i.branch ?? "-"}`;

export function noticeMessage(
  n: Notice,
  locale: Locale,
  content: NotifyContent = "subject",
): NoticeMessage {
  const t = TEXT[locale];
  if (n.kind === "immediate") {
    const f = primaryFollowUp(n.item);
    const status = n.item.status === "error" ? "error" : "needs_input";
    const why = whyOf(f);
    const state = why ? WHY_TEXT[locale][why] : status === "error" ? t.error : t.needs;
    const repo = repoName(n.item.repoRoot);
    const subject = content === "minimal" ? "" : followUpSubject(n.item, locale);
    const promptTitle = subject !== "" && !n.item.userTitled;
    // 題名 = 件名、副題 = 待ちの種類 · リポジトリ、本文 = ブランチ（D-207 (4)）。minimal は題名を待ちの種類にする
    return {
      id: `wi:${n.item.workItemId}`,
      kind: "immediate",
      status,
      title: subject || state,
      subtitle: subject ? [state, repo].filter(Boolean).join(" · ") : (repo ?? ""),
      body: content === "minimal" ? "" : (n.item.branch ?? ""),
      // open=<followUpId>: クリックでタスクの既定の開き先を開く（D-059。m2-api 13章）
      path: `/queue?item=${encodeURIComponent(n.item.workItemId)}${
        f ? `&open=${encodeURIComponent(f.id)}` : ""
      }`,
      sound: status === "needs_input",
      ...(promptTitle ? { promptTitle: true } : {}),
    };
  }
  const count = n.items.length;
  const lines = n.items.map((i) => {
    if (content === "minimal") return { text: noticeWhere(i), prompt: null };
    const why = whyOf(primaryFollowUp(i));
    const s = followUpSubject(i, locale);
    const suffix = why ? ` — ${WHY_TEXT[locale][why]}` : "";
    return {
      text: `${s}${suffix}`,
      prompt: i.userTitled ? null : { workItemId: i.workItemId, suffix },
    };
  });
  const promptLines = lines.map((l) => l.prompt);
  return {
    id: "turn",
    kind: "batch",
    status: "your_turn",
    title: fill(count === 1 ? t.turnOne : t.turnOther, { count }),
    body: lines.map((l) => l.text).join("\n"),
    path: "/queue",
    sound: false,
    ...(promptLines.some((x) => x !== null) ? { promptLines } : {}),
  };
}

/** メニューバーの件数（GET /api/queue/summary。desktop-shell.md 4.1） */
export interface QueueSummary {
  count: number;
  needsInput: number;
  error: number;
  yourTurn: number;
}

export function queueSummary(items: readonly QueueItem[]): QueueSummary {
  const v = visibleQueue(items);
  const n = (s: string) => v.filter((x) => x.status === s).length;
  const needsInput = n("needs_input");
  const error = n("error");
  return { count: v.length, needsInput, error, yourTurn: v.length - needsInput - error };
}
