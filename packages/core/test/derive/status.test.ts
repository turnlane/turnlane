/** 状態判定（phase0-plan 3.3）とフォローアップの差分（3.3・3.3.1）の表駆動テスト */
import { describe, expect, test } from "bun:test";
import {
  deriveStatus,
  desiredFollowUps,
  estimateResponse,
  isManualReply,
  manualRef,
  reconcileFollowUps,
} from "../../src/derive/index.ts";
import {
  aiEnd,
  at,
  facts,
  followUp,
  hook,
  human,
  MIN,
  pr,
  SETTINGS,
  session,
  shuffled,
  TIMING,
  turn,
} from "./helpers.ts";

const status = (f: ReturnType<typeof facts>, now: number) => {
  const a = deriveStatus(f, now, SETTINGS, TIMING);
  expect(deriveStatus(shuffled(f), now, SETTINGS, TIMING)).toEqual(a);
  return a;
};

describe("deriveStatus", () => {
  test.each([
    {
      name: "最終ターンが未完了で5分以内に更新 → running（推定）",
      f: () =>
        facts({
          turns: [turn({ start: at("10:00"), end: null })],
          sessions: [session({ lastActivityAt: at("10:03") })],
        }),
      now: at("10:05"),
      want: { status: "running", reason: "turn:open", estimated: true },
    },
    {
      name: "未完了でも更新が5分より前 → running にしない（done）",
      f: () =>
        facts({
          turns: [turn({ start: at("10:00"), end: null })],
          sessions: [session({ lastActivityAt: at("10:00") })],
        }),
      now: at("10:30"),
      want: { status: "done", reason: "ended", estimated: true },
    },
    {
      name: "Codex は10分まで running",
      f: () =>
        facts({
          turns: [turn({ start: at("10:00"), end: null })],
          sessions: [session({ tool: "codex", lastActivityAt: at("10:00") })],
        }),
      now: at("10:08"),
      want: { status: "running", reason: "turn:open", estimated: true },
    },
    {
      name: "sessions/<pid>.json が busy → running",
      f: () =>
        facts({
          turns: [turn({ start: at("10:00"), end: null })],
          sessions: [
            session({
              lastActivityAt: at("10:00"),
              liveStatus: "busy",
              liveCheckedAt: at("10:29"),
            }),
          ],
        }),
      now: at("10:30"),
      want: { status: "running", reason: "live:busy", estimated: true },
    },
    {
      name: "AskUserQuestion が未回答 → needs_input（推定）",
      f: () =>
        facts({
          turns: [turn({ start: at("10:00"), end: null, pendingQuestion: true })],
          sessions: [session({ lastActivityAt: at("10:01") })],
        }),
      now: at("10:30"),
      want: { status: "needs_input", reason: "ask_user_question", estimated: true },
    },
    {
      name: "hooks: PermissionRequest の後に活動・Stop が無い → needs_input",
      f: () =>
        facts({
          turns: [turn({ start: at("10:00"), end: null })],
          sessions: [session({ lastActivityAt: at("10:01") })],
          hooks: [hook("UserPromptSubmit", at("10:00")), hook("PermissionRequest", at("10:01"))],
        }),
      now: at("10:30"),
      want: { status: "needs_input", reason: "hook:permission_request", estimated: false },
    },
    {
      name: "hooks: 許可の後にトランスクリプトの活動があれば running",
      f: () =>
        facts({
          turns: [turn({ start: at("10:00"), end: null })],
          sessions: [session({ lastActivityAt: at("10:03") })],
          hooks: [hook("UserPromptSubmit", at("10:00")), hook("PermissionRequest", at("10:01"))],
        }),
      now: at("10:04"),
      want: { status: "running", reason: "hook:user_prompt_submit", estimated: false },
    },
    {
      name: "最終ターンが error → error",
      f: () =>
        facts({
          turns: [
            turn({ start: at("10:00"), end: at("10:01"), status: "error", endedWith: "error" }),
          ],
        }),
      now: at("11:00"),
      want: { status: "error", reason: "turn:error", estimated: true },
    },
    {
      name: "open な PR でレビュータスクが出ている → your_turn（期限なし。D-032）",
      f: () =>
        facts({
          turns: [aiEnd(at("10:00"))],
          prs: [pr({ firstSeenAt: at("09:59") })],
          followUps: [followUp({ kind: "review_pr", triggerAt: at("09:59") })],
        }),
      now: at("10:00", 10),
      want: { status: "your_turn", reason: "pr_open", estimated: false },
    },
    {
      name: "open な PR でもタスクが無ければ72時間で done（no_task_expired。D-048 (4)）",
      f: () => facts({ turns: [aiEnd(at("10:00"))], prs: [pr({ firstSeenAt: at("09:59") })] }),
      now: at("10:00", 3),
      want: { status: "done", reason: "no_task_expired", estimated: false },
    },
    {
      name: "PR が merged → done",
      f: () =>
        facts({
          turns: [aiEnd(at("10:00"))],
          prs: [pr({ firstSeenAt: at("09:59"), state: "merged", stateChangedAt: at("11:00") })],
        }),
      now: at("12:00"),
      want: { status: "done", reason: "pr_merged", estimated: false },
    },
    {
      name: "質問で終了 → your_turn、72時間で done",
      f: () => facts({ turns: [aiEnd(at("10:00"), { endedWith: "question" })] }),
      now: at("09:59", 3),
      want: { status: "your_turn", reason: "question", estimated: true },
    },
    {
      name: "質問で終了から72時間 → done",
      f: () => facts({ turns: [aiEnd(at("10:00"), { endedWith: "question" })] }),
      now: at("10:00", 3),
      want: { status: "done", reason: "ended", estimated: true },
    },
    {
      name: "git 管理外の編集は24時間で done",
      f: () =>
        facts({ nonGit: true, kind: "session", turns: [aiEnd(at("10:00"), { editedFiles: 1 })] }),
      now: at("10:00", 1),
      want: { status: "done", reason: "ended", estimated: true },
    },
    {
      name: "既定ブランチの編集は「今も未コミットの変更がある」ときだけ your_turn",
      f: () =>
        facts({
          kind: "session",
          defaultBranchCard: true,
          dirty: false,
          turns: [aiEnd(at("10:00"), { editedFiles: 1 })],
        }),
      now: at("11:00"),
      want: { status: "done", reason: "ended", estimated: true },
    },
    {
      name: "既定ブランチで未コミットの変更あり → your_turn",
      f: () =>
        facts({
          kind: "session",
          defaultBranchCard: true,
          dirty: true,
          turns: [aiEnd(at("10:00"), { editedFiles: 1 })],
        }),
      now: at("11:00"),
      want: { status: "your_turn", reason: "edits", estimated: true },
    },
    {
      name: "条件の無いターン終了は待たずに done",
      f: () => facts({ turns: [aiEnd(at("10:00"))] }),
      now: at("10:01"),
      want: { status: "done", reason: "ended", estimated: true },
    },
    {
      name: "同じセッションが後で別の作業へ移った（人間入力）→ done",
      f: () => {
        const t1 = aiEnd(at("10:00"), { endedWith: "question" });
        const t2 = human(at("10:30"));
        const f = facts({ turns: [t1] });
        f.sessionTurns.set("s1", [t1, t2]);
        return f;
      },
      now: at("11:00"),
      want: { status: "done", reason: "ended", estimated: true },
    },
    {
      name: "task-notification 起点のターンは人間入力ではない（質問の your_turn を解除しない）",
      f: () => {
        const t1 = aiEnd(at("10:00"), { endedWith: "question" });
        const t2 = turn({
          start: at("10:20"),
          end: at("10:21"),
          initiator: "system",
          endedWith: "question",
        });
        return facts({ turns: [t1, t2] });
      },
      now: at("11:00"),
      want: { status: "your_turn", reason: "question", estimated: true },
    },
    {
      name: "手動完了は、その後に新しいターンが始まっていなければ有効",
      f: () =>
        facts({ turns: [aiEnd(at("10:00"), { editedFiles: 1 })], manualDoneAt: at("10:30") }),
      now: at("11:00"),
      want: { status: "done", reason: "manual", estimated: false },
    },
    {
      name: "手動完了の後に新しいターン → 無効",
      f: () =>
        facts({
          turns: [aiEnd(at("10:00")), aiEnd(at("11:00"), { editedFiles: 1 })],
          manualDoneAt: at("10:30"),
        }),
      now: at("11:30"),
      want: { status: "your_turn", reason: "edits", estimated: true },
    },
  ])("$name", ({ f, now, want }) => {
    expect(status(f(), now)).toEqual(want as never);
  });

  test("優先順位: 複数セッションでは error > needs_input > running > your_turn > done", () => {
    const a = turn({ start: at("10:00"), end: null, sessionId: "a" });
    const b = aiEnd(at("10:00"), { sessionId: "b", endedWith: "question" });
    // エラーの状態は停止から 1 時間（それを過ぎたものは止まっているだけ）
    const c = turn({
      start: at("09:30"),
      end: at("09:31"),
      sessionId: "c",
      status: "error",
      endedWith: "error",
    });
    const f = facts({
      turns: [a, b],
      sessions: [
        session({ id: "a", externalId: "a", lastActivityAt: at("10:04") }),
        session({ id: "b", externalId: "b" }),
      ],
    });
    expect(status(f, at("10:05")).status).toBe("running");
    const g = facts({
      turns: [a, b, c],
      sessions: [
        session({ id: "a", externalId: "a", lastActivityAt: at("10:04") }),
        session({ id: "b", externalId: "b" }),
        session({ id: "c", externalId: "c" }),
      ],
    });
    expect(status(g, at("10:05")).status).toBe("error");
  });
});

describe("フォローアップ", () => {
  test("離れていた間に問いで止まったら猶予を待たずに返答タスク（D-214 (3)）。いたなら今までどおり15分", () => {
    const t1 = aiEnd(at("17:41"), { endedWith: "question" });
    const f = facts({ turns: [t1] });
    const kinds = (now: number, awayAt?: (x: number) => boolean) =>
      desiredFollowUps(f, status(f, now), now, SETTINGS, {
        ...TIMING,
        ...(awayAt ? { awayAt } : {}),
      }).map((d) => d.kind);
    // 在席の区間は 17:14 まで（17:41 にはいなかった）
    const away = (x: number) => x >= at("17:14");
    expect(kinds(at("17:42"), away)).toEqual(["reply"]);
    // いた（区間の中）なら 15 分待つ
    const present = () => false;
    expect(kinds(at("17:42"), present)).toEqual([]);
    expect(kinds(at("17:56"), present)).toEqual(["reply"]);
    // 在席を渡さない（記録が動いていない）ときも今までどおり
    expect(kinds(at("17:42"))).toEqual([]);
    // 待ちの始まりは止まった時刻のまま（放置の数え方は変えない）
    const d = desiredFollowUps(f, status(f, at("17:42")), at("17:42"), SETTINGS, {
      ...TIMING,
      awayAt: away,
    });
    expect(d[0]?.triggerAt).toBe(at("17:41"));
  });

  test("reply は15分後。dismissed は同じトリガで作り直さない。新しい質問は別のキーで作り、古いものは superseded", () => {
    const t1 = aiEnd(at("10:00"), { endedWith: "question" });
    const f = facts({ turns: [t1] });
    const d1 = desiredFollowUps(f, status(f, at("10:15")), at("10:15"), SETTINGS, TIMING);
    expect(d1.map((d) => d.kind)).toEqual(["reply"]);
    const dismissed = followUp({
      kind: "reply",
      triggerAt: at("10:00"),
      triggerTurnId: t1.id,
      status: "dismissed",
    });
    expect(
      reconcileFollowUps(facts({ turns: [t1], followUps: [dismissed] }), d1, at("10:16"), SETTINGS),
    ).toEqual([]);

    const t2 = aiEnd(at("11:00"), { endedWith: "question", initiator: "system" });
    const open1 = followUp({ kind: "reply", triggerAt: at("10:00"), triggerTurnId: t1.id });
    const g = facts({ turns: [t1, t2], followUps: [open1] });
    const d2 = desiredFollowUps(g, status(g, at("11:15")), at("11:15"), SETTINGS, TIMING);
    const acts = reconcileFollowUps(g, d2, at("11:15"), SETTINGS);
    expect(acts.map((a) => (a.type === "close" ? `close:${a.status}` : a.type))).toEqual([
      "create",
      "close:superseded",
    ]);
  });

  test("返答済み: 同じセッションに人間入力 → done（auto:human_input）", () => {
    const t1 = aiEnd(at("10:00"), { endedWith: "question" });
    const reply = followUp({ kind: "reply", triggerAt: at("10:00"), triggerTurnId: t1.id });
    const f = facts({ turns: [t1, human(at("10:40"))], followUps: [reply] });
    expect(reconcileFollowUps(f, [], at("10:41"), SETTINGS)).toEqual([
      { type: "close", id: reply.id, status: "done", reason: "auto:human_input", at: at("10:40") },
    ]);
  });

  test("review_pr は PR の初出で作り、merged で閉じる", () => {
    const t = aiEnd(at("10:00"));
    const open = facts({ turns: [t], prs: [pr({ firstSeenAt: at("09:59") })] });
    const d = desiredFollowUps(open, status(open, at("10:01")), at("10:01"), SETTINGS, TIMING);
    expect(d.map((x) => [x.kind, x.artifactRef])).toEqual([["review_pr", "org/repo#1"]]);
    const fu = followUp({
      kind: "review_pr",
      triggerAt: at("09:59"),
      artifactRef: "org/repo#1",
      dedupeKey: "wi|review_pr|org/repo#1",
    });
    const merged = facts({
      turns: [t],
      prs: [pr({ firstSeenAt: at("09:59"), state: "merged", stateChangedAt: at("12:00") })],
      followUps: [fu],
    });
    expect(reconcileFollowUps(merged, [], at("12:05"), SETTINGS)).toEqual([
      { type: "close", id: fu.id, status: "done", reason: "auto:pr_merged", at: at("12:00") },
    ]);
  });

  test("状態が分からない PR: gh で未確認なら作らない。確かめても分からなければ作る（72時間より古ければ reconcile で作らない）", () => {
    const t = aiEnd(at("10:00"));
    const want = (p: Parameters<typeof pr>[0], now: number) => {
      const f = facts({ turns: [t], prs: [pr(p)] });
      return desiredFollowUps(f, status(f, now), now, SETTINGS, TIMING).map((x) => x.kind);
    };
    expect(
      want({ firstSeenAt: at("09:59"), state: "unknown", stateCheckedAt: null }, at("10:01")),
    ).toEqual([]);
    expect(
      want(
        { firstSeenAt: at("09:59"), state: "unknown", stateCheckedAt: at("10:00") },
        at("10:01"),
      ),
    ).toEqual(["review_pr"]);
    // あるべき集合には残す（既にあるタスクを古さで閉じない）が、新しくは作らない（D-045 (3)）
    const old = {
      firstSeenAt: at("09:59"),
      state: "unknown" as const,
      stateCheckedAt: at("10:00"),
    };
    expect(want(old, at("10:00", 4))).toEqual(["review_pr"]);
    const f = facts({ turns: [t], prs: [pr(old)] });
    const d = desiredFollowUps(f, status(f, at("10:00", 4)), at("10:00", 4), SETTINGS, TIMING);
    expect(reconcileFollowUps(f, d, at("10:00", 4), SETTINGS)).toEqual([]);
  });

  test("approve は hooks の許可待ちで作り、次のツール実行・Stop・人間入力で閉じる", () => {
    const t = turn({ start: at("10:00"), end: null });
    const f = facts({
      turns: [t],
      sessions: [session({ lastActivityAt: at("10:01") })],
      hooks: [hook("PermissionRequest", at("10:01"))],
    });
    const d = desiredFollowUps(f, status(f, at("10:02")), at("10:02"), SETTINGS, TIMING);
    expect(d.map((x) => [x.kind, x.triggerAt])).toEqual([["approve", at("10:01")]]);
    const fu = followUp({
      kind: "approve",
      triggerAt: at("10:01"),
      triggerTurnId: t.id,
      dedupeKey: d[0]?.dedupeKey as string,
    });
    const g = facts({
      turns: [t],
      sessions: [session({ lastActivityAt: at("10:03") })],
      hooks: [hook("PermissionRequest", at("10:01")), hook("Stop", at("10:05"))],
      followUps: [fu],
    });
    expect(reconcileFollowUps(g, [], at("10:06"), SETTINGS)).toEqual([
      { type: "close", id: fu.id, status: "done", reason: "auto:next_turn_ok", at: at("10:05") },
    ]);
  });

  test("同じターンで許可した後にまた許可待ちになったら、閉じた approve とは別に作る（fix-stale-title）", () => {
    const t = turn({ start: at("10:00"), end: null });
    const first = facts({
      turns: [t],
      sessions: [session({ lastActivityAt: at("10:01") })],
      hooks: [hook("PermissionRequest", at("10:01"))],
    });
    const d1 = desiredFollowUps(first, status(first, at("10:02")), at("10:02"), SETTINGS, TIMING);
    const fu = followUp({
      kind: "approve",
      triggerAt: at("10:01"),
      triggerTurnId: t.id,
      dedupeKey: d1[0]?.dedupeKey as string,
      status: "done",
    });
    // 許可してツールが動き（10:03）、10:04 にまた PermissionRequest
    const g = facts({
      turns: [t],
      sessions: [session({ lastActivityAt: at("10:03") })],
      hooks: [hook("PermissionRequest", at("10:01")), hook("PermissionRequest", at("10:04"))],
      followUps: [fu],
    });
    expect(status(g, at("10:05")).status).toBe("needs_input");
    const d2 = desiredFollowUps(g, status(g, at("10:05")), at("10:05"), SETTINGS, TIMING);
    expect(d2.map((x) => [x.kind, x.triggerAt])).toEqual([["approve", at("10:04")]]);
    expect(d2[0]?.dedupeKey).not.toBe(fu.dedupeKey);
    expect(reconcileFollowUps(g, d2, at("10:05"), SETTINGS).map((a) => a.type)).toEqual(["create"]);
  });

  test("resume_error は error で作り、次のターンが成功したら閉じる。スヌーズが明けたら open に戻す", () => {
    const t = turn({ start: at("10:00"), end: at("10:01"), status: "error", endedWith: "error" });
    const f = facts({ turns: [t] });
    expect(
      desiredFollowUps(f, status(f, at("10:02")), at("10:02"), SETTINGS, TIMING).map((x) => x.kind),
    ).toEqual(["resume_error"]);
    const fu = followUp({
      kind: "resume_error",
      triggerAt: at("10:01"),
      triggerTurnId: t.id,
      status: "snoozed",
      snoozeUntil: at("10:30"),
    });
    const ok = facts({ turns: [t, aiEnd(at("10:20"))], followUps: [fu] });
    expect(reconcileFollowUps(ok, [], at("10:21"), SETTINGS)).toEqual([
      { type: "close", id: fu.id, status: "done", reason: "auto:next_turn_ok", at: at("10:21") },
    ]);
    const still = facts({ turns: [t], followUps: [fu] });
    const d = desiredFollowUps(still, status(still, at("10:31")), at("10:31"), SETTINGS, TIMING);
    expect(
      reconcileFollowUps(
        still,
        d.map((x) => ({ ...x, dedupeKey: fu.dedupeKey })),
        at("10:31"),
        SETTINGS,
      ),
    ).toEqual([{ type: "wake", id: fu.id }]);
  });

  test("check_changes は既定オフ", () => {
    const f = facts({ turns: [aiEnd(at("10:00"), { editedFiles: 1 })] });
    expect(desiredFollowUps(f, status(f, at("11:00")), at("11:00"), SETTINGS, TIMING)).toEqual([]);
    const on = { ...SETTINGS, followUpKinds: { ...SETTINGS.followUpKinds, check_changes: true } };
    expect(
      desiredFollowUps(f, status(f, at("11:00")), at("11:00"), on, TIMING).map((x) => x.kind),
    ).toEqual(["check_changes"]);
  });

  test("実績の推定（U7）: engaged_at からクローズまで（上限30分）、無ければ3分", () => {
    expect(estimateResponse(at("10:00"), at("10:10"))).toEqual({
      start: at("10:00"),
      end: at("10:10"),
    });
    expect(estimateResponse(at("10:00"), at("11:00"))).toEqual({
      start: at("10:00"),
      end: at("10:30"),
    });
    expect(estimateResponse(null, at("10:00"))).toEqual({
      start: at("10:00") - 3 * MIN,
      end: at("10:00"),
    });
  });
});

describe("手で作った返答タスク（AI カードの y。D-066 (2)）", () => {
  const manual = (
    turnId: string,
    triggerAt: number,
    p: Partial<ReturnType<typeof followUp>> = {},
  ) =>
    followUp({
      kind: "reply",
      triggerAt,
      triggerTurnId: turnId,
      artifactRef: manualRef(turnId),
      dedupeKey: `wi|reply|${manualRef(turnId)}`,
      ...p,
    });

  test("artifact_ref: 使用済みなら :manual:2、:manual:3 と避ける", () => {
    const used = new Set(["t1:manual", "t1:manual:2"]);
    expect(manualRef("t1")).toBe("t1:manual");
    expect(manualRef("t1", (r) => used.has(r))).toBe("t1:manual:3");
    expect(isManualReply({ kind: "reply", artifactRef: "t1:manual:3" })).toBe(true);
    expect(isManualReply({ kind: "reply", artifactRef: "t1:ask" })).toBe(false);
    expect(isManualReply({ kind: "approve", artifactRef: "t1:manual" })).toBe(false);
  });

  test("質問と判定されなかったターンでも、open な手動の返答タスクがあれば your_turn（question）", () => {
    const t1 = aiEnd(at("10:00"));
    expect(status(facts({ turns: [t1] }), at("10:30")).status).toBe("done");
    const f = facts({ turns: [t1], followUps: [manual(t1.id, at("10:30"))] });
    expect(status(f, at("10:31"))).toEqual({
      status: "your_turn",
      reason: "question",
      estimated: true,
    });
    // 閉じたら外れる
    const closed = facts({
      turns: [t1],
      followUps: [manual(t1.id, at("10:30"), { status: "dismissed", closedAt: at("10:40") })],
    });
    expect(status(closed, at("10:41")).status).toBe("done");
  });

  test("中断で終わったターンにも作れる。72時間の期限はターン終了からではなく作った時刻から", () => {
    const t1 = turn({ start: at("10:00"), end: at("10:05"), status: "interrupted" });
    const f = facts({ turns: [t1], followUps: [manual(t1.id, at("12:00", 3))] });
    expect(status(f, at("12:01", 3)).status).toBe("your_turn");
    const fu = f.followUps[0] as ReturnType<typeof followUp>;
    expect(reconcileFollowUps(f, [], at("11:59", 6), SETTINGS)).toEqual([]);
    expect(reconcileFollowUps(f, [], at("12:00", 6), SETTINGS)).toEqual([
      { type: "close", id: fu.id, status: "expired", reason: "auto:expired", at: at("12:00", 6) },
    ]);
  });

  test("同じターンに自動の返答タスクを重ねない。your_turn から外れても status_left では閉じない", () => {
    const t1 = aiEnd(at("10:00"), { endedWith: "question" });
    const m = manual(t1.id, at("10:05"));
    const f = facts({ turns: [t1], followUps: [m] });
    const d = desiredFollowUps(f, status(f, at("10:30")), at("10:30"), SETTINGS, TIMING);
    expect(d).toEqual([]);
    expect(reconcileFollowUps(f, d, at("10:30"), SETTINGS)).toEqual([]);
  });

  test("同じセッションに人間入力が来たら返答済みで閉じる", () => {
    const t1 = aiEnd(at("10:00"));
    const m = manual(t1.id, at("10:05"));
    const f = facts({ turns: [t1, human(at("10:20"))], followUps: [m] });
    expect(reconcileFollowUps(f, [], at("10:21"), SETTINGS)).toEqual([
      { type: "close", id: m.id, status: "done", reason: "auto:human_input", at: at("10:20") },
    ]);
  });
});
