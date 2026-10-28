/**
 * 既定ブランチの session カードの編集（your_turn (b)）: コミットで解決した編集は、後でリポジトリが別の作業で汚れても
 * 確認待ち（edits）へ戻さない
 */
import { describe, expect, test } from "bun:test";
import { deriveStatus, editsResolved } from "../../src/derive/index.ts";
import { aiEnd, at, facts, followUp, SETTINGS, TIMING } from "./helpers.ts";

const status = (f: ReturnType<typeof facts>, now: number) => deriveStatus(f, now, SETTINGS, TIMING);

/** 編集ありで終わったターン（10:00。期限切れの前に、同じリポジトリが別の作業で汚れた形） */
const edited = () => aiEnd(at("10:00"), { id: "t-edit", editedFiles: 2 });

describe("コミットで解決した編集", () => {
  test("確認のタスクが auto:resolved:commit で閉じている: 後で dirty になっても done のまま", () => {
    const t = edited();
    const f = facts({
      kind: "session",
      defaultBranchCard: true,
      dirty: true,
      turns: [t],
      followUps: [
        followUp({
          kind: "check_changes",
          triggerAt: t.endedAt as number,
          triggerTurnId: t.id,
          status: "done",
          closedAt: at("10:10"),
          closeReason: "auto:resolved:commit",
        }),
      ],
    });
    expect(editsResolved(f, t.id)).toBe(true);
    expect(status(f, at("10:30"))).toEqual({ status: "done", reason: "ended", estimated: true });
  });

  test("ターンの終わりより後にコミットがある（editsCommitted）: 後で dirty になっても done のまま", () => {
    const t = edited();
    const f = facts({
      kind: "session",
      defaultBranchCard: true,
      dirty: true,
      turns: [t],
      editsCommitted: new Set([t.id]),
    });
    expect(status(f, at("10:45")).status).toBe("done");
  });

  test("未解決の編集（コミット無し・dirty）は今までどおり edits", () => {
    const t = aiEnd(at("10:00"), { id: "t-edit", editedFiles: 2 });
    const f = facts({ kind: "session", defaultBranchCard: true, dirty: true, turns: [t] });
    expect(status(f, at("10:30"))).toEqual({
      status: "your_turn",
      reason: "edits",
      estimated: true,
    });
  });

  test("手で閉じた・ほかの理由で閉じた確認のタスクは解決ではない", () => {
    const t = aiEnd(at("10:00"), { id: "t-edit", editedFiles: 2 });
    const f = facts({
      kind: "session",
      defaultBranchCard: true,
      dirty: true,
      turns: [t],
      followUps: [
        followUp({
          kind: "check_changes",
          triggerAt: t.endedAt as number,
          triggerTurnId: t.id,
          status: "dismissed",
          closeReason: "user",
        }),
      ],
    });
    expect(editsResolved(f, t.id)).toBe(false);
    expect(status(f, at("10:30")).reason).toBe("edits");
  });

  test("解決の後に同じセッションがまた編集した: 新しいターンで edits", () => {
    const t = edited();
    const next = aiEnd(at("10:40"), { id: "t-next", editedFiles: 1 });
    const f = facts({
      kind: "session",
      defaultBranchCard: true,
      dirty: true,
      turns: [t, next],
      editsCommitted: new Set([t.id]),
    });
    expect(status(f, at("10:45"))).toEqual({
      status: "your_turn",
      reason: "edits",
      estimated: true,
    });
  });
});
