import { describe, expect, test } from "bun:test";
import type { QueueItem } from "../../src/api/queue.ts";
import {
  BATCH_MS,
  countedTurns,
  initialNotifyState,
  isGrace,
  noticeMessage,
  PERMISSION_GRACE_MS,
  planNotifications,
  queueSummary,
  RESEND_MS,
  turnRows,
  visibleQueue,
  WHY_TEXT,
  whyOf,
} from "../../src/notify/plan.ts";

describe("通知の判定（M2-8・M2-D2。ux-mvp 4.7）", () => {
  const item = (id: string, status: QueueItem["status"], fu: string): QueueItem => ({
    workItemId: id,
    title: id,
    status,
    reason: null,
    estimated: false,
    repoRoot: "/w/app",
    branch: "feat/x",
    prRef: null,
    sources: [],
    waitingSince: 0,
    waitStartedAway: false,
    followUps: [
      {
        id: fu,
        kind: "reply",
        status: "open",
        title: { t: "text", text: "x" },
        triggerAt: 0,
        snoozeUntil: null,
        engagedAt: null,
        expiresAt: null,
        taskId: null,
        taskDate: null,
        task: null,
      },
    ],
  });
  test("許可待ちは 10 秒の猶予: その間に閉じれば（AI が進めば）通知しない。10 秒過ぎても止まっていれば即時", () => {
    const approve = (id: string, fu: string, triggerAt: number): QueueItem => {
      const x = item(id, "needs_input", fu);
      return { ...x, followUps: x.followUps.map((f) => ({ ...f, kind: "approve", triggerAt })) };
    };
    const T = 2_000_000;
    let s = planNotifications(initialNotifyState(), [], T).state;
    // 3 秒後: まだ出さない（もう一度見る時刻を返す）
    let r = planNotifications(s, [approve("a", "p1", T)], T + 3000);
    expect(r.notices).toEqual([]);
    expect(r.recheckAt).toBe(T + PERMISSION_GRACE_MS);
    s = r.state;
    // 5 秒後に許可待ちが閉じた（サブエージェントのトランスクリプトに活動）: 何も出さない
    r = planNotifications(s, [], T + 5000);
    expect(r.notices).toEqual([]);
    expect(r.recheckAt).toBeUndefined();
    // 別の許可待ちが 10 秒過ぎても開いたまま: 即時に出す
    s = r.state;
    r = planNotifications(s, [approve("b", "p2", T + 6000)], T + 9000);
    expect(r.notices).toEqual([]);
    s = r.state;
    r = planNotifications(s, [approve("b", "p2", T + 6000)], T + 6000 + PERMISSION_GRACE_MS);
    expect(r.notices.map((n) => n.kind)).toEqual(["immediate"]);
    // エラー・返答は猶予なしで今までどおり
    s = r.state;
    r = planNotifications(s, [item("c", "error", "e1")], T + 20_000);
    expect(r.notices.map((n) => n.kind)).toEqual(["immediate"]);
  });

  test("初回の読み込みでは通知しない。needs_input / error は即時、your_turn は15分まとめ、同じカードは5分以内に再送しない", () => {
    let s = initialNotifyState();
    const T = 1_000_000;
    let r = planNotifications(s, [item("a", "your_turn", "f0")], T);
    expect(r.notices).toEqual([]);
    s = r.state;
    r = planNotifications(
      s,
      [item("a", "your_turn", "f0"), item("b", "needs_input", "f1")],
      T + 1000,
    );
    expect(r.notices.map((n) => n.kind)).toEqual(["immediate"]);
    s = r.state;
    // 同じカードの新しいフォローアップは5分以内なら出さない
    r = planNotifications(s, [item("b", "needs_input", "f2")], T + 2000);
    expect(r.notices).toEqual([]);
    s = r.state;
    r = planNotifications(s, [item("b", "needs_input", "f3")], T + 2000 + RESEND_MS);
    expect(r.notices.map((n) => n.kind)).toEqual(["immediate"]);
    s = r.state;
    r = planNotifications(s, [item("c", "your_turn", "f4")], T + 3000 + RESEND_MS);
    expect(r.notices).toEqual([]);
    s = r.state;
    r = planNotifications(s, [item("c", "your_turn", "f4")], T + BATCH_MS + 10_000);
    expect(r.notices.map((n) => n.kind)).toEqual(["batch"]);
  });
  test("文言: 題名は件名（前置きなし）、副題は待ちの種類 · リポジトリ、本文はブランチ。needs_input だけ音を鳴らす（D-207 (4)(5)）", () => {
    const a = item("a", "needs_input", "f1");
    a.followUps = a.followUps.map((f) => ({
      ...f,
      kind: "approve" as const,
      title: {
        t: "auto" as const,
        key: "followup.approve" as const,
        params: { title: "Fix login", repo: "app", branch: "feat/x", pr: null, prTitle: null },
      },
    }));
    const m = noticeMessage({ kind: "immediate", item: a }, "en");
    expect(m).toEqual({
      id: "wi:a",
      kind: "immediate",
      status: "needs_input",
      title: "Fix login",
      subtitle: "Needs approval · app",
      body: "feat/x",
      path: "/queue?item=a&open=f1",
      sound: true,
      promptTitle: true,
    });
    const ja = noticeMessage({ kind: "immediate", item: a }, "ja");
    expect([ja.title, ja.subtitle]).toEqual(["Fix login", "許可待ち · app"]);
    // 件名も出さない設定: 題名は待ちの種類、副題はリポジトリ、本文は空
    const min = noticeMessage({ kind: "immediate", item: a }, "en", "minimal");
    expect([min.title, min.subtitle, min.body]).toEqual(["Needs approval", "app", ""]);
    // 直近の指示への差し替え（D-211）: 印だけで中身は入れない。名前を付けた件・件名も出さない設定では付けない
    expect(min.promptTitle).toBeUndefined();
    expect(
      noticeMessage({ kind: "immediate", item: { ...a, userTitled: true } }, "en").promptTitle,
    ).toBeUndefined();
    const e = item("b", "error", "f2");
    e.followUps = e.followUps.map((f) => ({ ...f, kind: "resume_error" as const }));
    const em = noticeMessage({ kind: "immediate", item: e }, "ja");
    expect([em.title, em.subtitle, em.sound]).toEqual(["x", "エラーで停止 · app", false]);
    const t = noticeMessage(
      { kind: "batch", items: [item("c", "your_turn", "f3"), item("d", "your_turn", "f4")] },
      "en",
    );
    expect(t).toMatchObject({
      id: "turn",
      title: "2 items are waiting on you",
      body: "x — Needs reply\nx — Needs reply",
      path: "/queue",
      sound: false,
    });
    // まとめの通知もアプリが出す直前に固定した件名を読む（D-214 (1)）: 行ごとの項目と後ろの言葉だけで、中身は入れない
    expect(t.promptLines).toEqual([
      { workItemId: "c", suffix: " — Needs reply" },
      { workItemId: "d", suffix: " — Needs reply" },
    ]);
    const named = noticeMessage(
      {
        kind: "batch",
        items: [
          { ...item("c", "your_turn", "f3"), userTitled: true },
          item("d", "your_turn", "f4"),
        ],
      },
      "en",
    );
    expect(named.promptLines).toEqual([null, { workItemId: "d", suffix: " — Needs reply" }]);
    expect(
      noticeMessage({ kind: "batch", items: [item("c", "your_turn", "f3")] }, "en", "minimal")
        .promptLines,
    ).toBeUndefined();
    expect(
      noticeMessage({ kind: "batch", items: [item("c", "your_turn", "f3")] }, "en", "minimal").body,
    ).toBe("app · feat/x");
    expect(
      noticeMessage({ kind: "batch", items: [item("c", "your_turn", "f3")] }, "en").title,
    ).toBe("1 item is waiting on you");
  });
  test("件数（メニューバー）: サイドバーと同じ visibleQueue で数え、状態ごとに分ける", () => {
    const snoozed = item("s", "needs_input", "f9");
    snoozed.followUps = snoozed.followUps.map((f) => ({ ...f, status: "snoozed" as const }));
    expect(
      queueSummary([
        item("a", "needs_input", "f1"),
        item("b", "error", "f2"),
        item("c", "your_turn", "f3"),
        item("d", "running", "f4"),
        snoozed,
      ]),
    ).toEqual({ count: 4, needsInput: 1, error: 1, yourTurn: 2 });
  });
});

describe("表示用の自分の番の行（D-245）: 猶予中の問いは末尾に足し、数と通知には入れない", () => {
  const base = (id: string, since: number): QueueItem => ({
    workItemId: id,
    title: id,
    status: "your_turn",
    reason: null,
    estimated: false,
    repoRoot: "/w/app",
    branch: "feat/x",
    prRef: null,
    sources: [],
    waitingSince: since,
    waitStartedAway: false,
    followUps: [],
  });
  const open = (id: string, since: number): QueueItem => ({
    ...base(id, since),
    followUps: [
      {
        id: `f-${id}`,
        kind: "reply",
        status: "open",
        title: { t: "text", text: id },
        triggerAt: since,
        snoozeUntil: null,
        engagedAt: null,
        expiresAt: null,
        taskId: null,
        taskDate: null,
        task: null,
      },
    ],
  });
  const grace = (id: string, since: number): QueueItem => ({
    ...base(id, since),
    wait: { kind: "question", turnId: `t-${id}`, followUpId: null },
    grace: { until: since + 15 * 60_000 },
  });

  test("猶予中は visibleQueue の後ろ（帯の上限の中でも最後）。見出しの数には含めない", () => {
    const rows = turnRows([open("a", 10), open("b", 20)], [grace("g", 5)]);
    expect(rows.map((x) => x.workItemId)).toEqual(["a", "b", "g"]);
    expect(rows.slice(0, 3).at(-1)?.workItemId).toBe("g");
    expect(countedTurns(rows)).toBe(2);
    expect(rows.map(isGrace)).toEqual([false, false, true]);
    // 通知・件数（visibleQueue）には入らない
    expect(visibleQueue([open("a", 10), grace("g", 5)]).map((x) => x.workItemId)).toEqual(["a"]);
    expect(queueSummary(rows).count).toBe(2);
  });

  test("猶予が過ぎて返答タスクができたら、同じ workItemId の普通の行（items）だけになる", () => {
    const before = turnRows([], [grace("g", 5)]);
    const after = turnRows(
      [{ ...open("g", 5), wait: { kind: "question", turnId: "t-g", followUpId: "f-g" } }],
      [grace("g", 5)],
    );
    expect(before.map((x) => [x.workItemId, isGrace(x)])).toEqual([["g", true]]);
    expect(after.map((x) => [x.workItemId, isGrace(x)])).toEqual([["g", false]]);
    expect(countedTurns(after)).toBe(1);
  });

  test("通知の判定は猶予中を見ない（planNotifications に visibleQueue を通す）", () => {
    let s = initialNotifyState();
    s = planNotifications(s, visibleQueue([]), 0).state;
    const r = planNotifications(s, visibleQueue([grace("g", 5)]), 60_000);
    expect(r.notices).toEqual([]);
  });
});

describe("待ちの種類の言葉", () => {
  test("上限待ちが明けた後の再開（resume_error・limit）は「再開できる」。ほかの再開はエラーで停止", () => {
    expect(whyOf({ kind: "resume_error", limit: true })).toBe("resume_limit");
    expect(WHY_TEXT.ja.resume_limit).toBe("再開できる");
    expect(WHY_TEXT.en.resume_limit).toBe("Can resume");
    expect(whyOf({ kind: "resume_error" })).toBe("resume_error");
    expect(whyOf({ kind: "reply", ask: true })).toBe("answer");
  });
});
