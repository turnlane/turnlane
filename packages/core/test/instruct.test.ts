import { describe, expect, test } from "bun:test";
import { type InstructFacts, instructBlock, instructUndeliverable } from "../src/instruct.ts";

const base: InstructFacts = { enabled: true, process: "alive", openWait: false, turn: "ended" };

describe("instructBlock（次の指示を送る前の条件。ADR 0019 の Decision 11）", () => {
  const procs = ["alive", "gone", "unknown"] as const;
  const turns = ["ended", "running", "unknown", "missing"] as const;
  const waits = [false, true] as const;
  const rows = procs.flatMap((process) =>
    turns.flatMap((turn) => waits.map((openWait) => ({ process, turn, openWait }))),
  );

  test.each(rows)("プロセス $process × ターン $turn × 待ち $openWait", (r) => {
    const got = instructBlock({ ...base, ...r });
    // 送ってよいのは alive・ターンの終わり・待ち無しの 1 通りだけ
    if (r.process === "alive" && r.turn === "ended" && !r.openWait) expect(got).toBeNull();
    else expect(got).not.toBeNull();
    // プロセスが終わっていれば、ほかが何でも session_ended（端末を探しに行かない）
    if (r.process === "gone") expect(got).toBe("session_ended");
    if (r.process === "unknown") expect(got).toBe("process_unknown");
    if (r.process === "alive" && r.openWait) expect(got).toBe("wait_open");
    if (r.process === "alive" && !r.openWait && r.turn !== "ended")
      expect(got).toBe(r.turn === "missing" ? "unreadable" : "turn_in_progress");
  });

  test("設定でオフなら off（何より先）", () => {
    expect(instructBlock({ ...base, enabled: false, process: "gone" })).toBe("off");
  });

  test("届け先が決まらない理由は答えると同じ（動いていない = 終わった）", () => {
    expect(instructUndeliverable("not_live")).toBe("session_ended");
    expect(instructUndeliverable("unsupported")).toBe("unsupported");
    expect(instructUndeliverable("not_found")).toBe("not_found");
  });
});
