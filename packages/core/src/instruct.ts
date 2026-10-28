/**
 * 次の指示（Issue #9、ADR 0019 の Decision 11）の純粋な部分: 送る前の条件。答えるの「待ちがまだ開いているか」に当たるもの。
 * 送るのは、プロセスが動いている（alive）・記録の末尾がターンの終わり・開いている待ちが無い、を全部満たすときだけ。
 * 端末のタブを探す（ps・tmux を呼ぶ）のは、この判定が通った後だけにする（終わったセッションには何も起動しない）。
 */
import type { InstructBlocked } from "./api/instruct.ts";

export interface InstructFacts {
  /** 設定「Turnlane から答える」（turn.answer） */
  enabled: boolean;
  /** 最後のセッションのプロセス（core の itemProcess と同じ言葉） */
  process: "alive" | "gone" | "unknown";
  /** 開いている待ち（derive.openWaitOf）がある */
  openWait: boolean;
  /** 記録の末尾（collectors の claudeTurnEnd / codexTurnEnd）。missing = 記録が無い・読めない */
  turn: "ended" | "running" | "unknown" | "missing";
}

/** 送らない理由（送ってよければ null）。順: 設定 → プロセス → 待ち → ターン */
export function instructBlock(f: InstructFacts): InstructBlocked | null {
  if (!f.enabled) return "off";
  if (f.process === "gone") return "session_ended";
  if (f.process === "unknown") return "process_unknown";
  if (f.openWait) return "wait_open";
  if (f.turn === "running" || f.turn === "unknown") return "turn_in_progress";
  if (f.turn === "missing") return "unreadable";
  return null;
}

/** 届け先が決まらない理由（答えると同じ）→ 送らない理由。動いていない（not_live）は終わったものとして扱う */
export function instructUndeliverable(
  reason: "not_live" | "unsupported" | "not_found" | "off",
): InstructBlocked {
  return reason === "not_live" ? "session_ended" : reason;
}
