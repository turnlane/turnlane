import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import claudeCode from "../src/adapters/claude-code/index.ts";
import { questionExcerpt } from "../src/closing-question.ts";
import {
  claudeGlanceHints,
  claudeLastText,
  claudeToolResultIds,
  claudeToolUse,
  claudeUserText,
  findClaudeTranscript,
  readJsonLineAt,
  readTailRecords,
} from "../src/glance.ts";
import type { Cursor } from "../src/index.ts";
import { promptSubject, promptTraits } from "../src/prompt-traits.ts";
import { fixtureCtx, readStreamAll, rootFor, withRootJail } from "../src/testing/index.ts";

const CASE = join(import.meta.dir, "fixtures/claude_code/2.1.x/permission-pending");
const SID = "0000aaaa-0000-4000-8000-0000000000b1";
const FILE = join(CASE, "projects/-fixture-repo-b", `${SID}.jsonl`);

describe("promptSubject（件名に使える指示か。spec-glance §2.2）", () => {
  test.each([
    [
      "Fix the 401 when the refresh token expires\n\nmore",
      "Fix the 401 when the refresh token expires",
    ],
    [
      "リフレッシュトークンの期限切れで 401 になるのを直して",
      "リフレッシュトークンの期限切れで 401 になるのを直して",
    ],
    ["# 見出しの印は外す", "見出しの印は外す"],
    ["- 箇条書きの印も外す", "箇条書きの印も外す"],
    ["```\ncode\n```\nコードの次の行", "コードの次の行"],
    ["https://example.com/a\nURL だけの行は飛ばす", "URL だけの行は飛ばす"],
    ["src/app/main.ts\nパスだけの行は飛ばす", "パスだけの行は飛ばす"],
    ["/review 認証のところを見て", "認証のところを見て"],
    [
      "<command-name>/plan</command-name>\n<command-args>移行の手順を考えて</command-args>",
      "移行の手順を考えて",
    ],
    ["yarn build が落ちる", "yarn build が落ちる"],
    ["no, use the other one", "no, use the other one"],
    [
      "はい、その方針でテストも足して進めてください",
      "はい、その方針でテストも足して進めてください",
    ],
    // 相づちだけの行・貼り付けの塊は飛ばす（ai-session-ingestion 4.4。貼り付けた本文は件名にしない）
    ["OK\n丸め方を直して", "丸め方を直して"],
    [
      'OK\n<pasted_content id="1">貼り付けた本文\n2 行目</pasted_content>\n税率を直して',
      "税率を直して",
    ],
    ['税率を直して <pasted_content id="1">貼り付けた本文</pasted_content>', "税率を直して"],
  ])("%p → %p", (input, want) => {
    expect(promptSubject(input)).toBe(want);
  });

  test.each([
    'OK\n<pasted_content id="1">貼り付けた本文\n2 行目</pasted_content>',
    '<pasted_content id="1">',
    "はい",
    "続けて",
    "お願いします",
    "ok",
    "OK!",
    "yes",
    "go ahead",
    "2",
    "  ",
    "/compact",
    "<command-name>/clear</command-name>\n<command-args></command-args>",
    "<local-command-stdout>x</local-command-stdout>",
    "```\nonly code\n```",
  ])("使えない: %p", (input) => {
    expect(promptSubject(input)).toBeNull();
    expect(promptTraits(input).usable).toBe(false);
  });

  test("120 文字で切る", () => {
    const s = promptSubject("a".repeat(300)) ?? "";
    expect(s.length).toBe(120);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("questionExcerpt（返答待ちの問い。spec-glance §4.2）", () => {
  test("問いの文を優先し、締めの決まり文句は除く", () => {
    const q = questionExcerpt(
      "Done.\n\nOption A is fast. Option B is safe. Which one should I go with? Let me know if you need anything else.",
    );
    expect(q?.row).toBe("Which one should I go with?");
  });
  test("2 文まで詳細に", () => {
    const q = questionExcerpt("右の列も同じ幅にしますか？ 左の列も揃えますか？");
    expect(q?.row).toBe("左の列も揃えますか？");
    expect(q?.detail).toBe("右の列も同じ幅にしますか？ 左の列も揃えますか？");
  });
  test("問いが無ければ最後の文。インラインコードは中身を残す", () => {
    expect(questionExcerpt("Added tests and ran `bun test`.")?.row).toBe(
      "Added tests and ran bun test.",
    );
  });
  test("80 文字で切る", () => {
    const q = questionExcerpt(`${"x".repeat(100)}?`);
    expect(q?.row.length).toBe(80);
  });
  test("文字列でなければ null", () => {
    expect(questionExcerpt(undefined)).toBeNull();
  });
});

async function hintsOf(path: string, root: string) {
  const stream = claudeCode.streamFor(rootFor(claudeCode, root), path);
  if (!stream) throw new Error("no stream");
  const r = await readStreamAll(claudeCode, stream, fixtureCtx());
  return { hints: claudeGlanceHints(r.cursor?.carry), cursor: r.cursor as Cursor };
}

describe("carry の位置（D-207。本文ではなくバイト位置だけ）", () => {
  test("件名に使える直近の指示・結果の無い tool_use・最後のテキストの行を指す", async () => {
    const { hints, cursor } = await withRootJail([CASE], () => hintsOf(FILE, CASE));
    expect(hints).not.toBeNull();
    // carry に本文が入っていない
    const carry = JSON.stringify(cursor.carry);
    expect(carry).not.toContain("refresh token");
    expect(carry).not.toContain("git push");
    expect(carry).not.toContain("Pushing");
    const h = hints as NonNullable<typeof hints>;
    expect(h.turnKey).toBe("p3");
    const prompt = readJsonLineAt(FILE, h.promptAt ?? -1);
    expect(prompt.ok && claudeUserText(prompt.value)).toStartWith("Fix the 401");
    // Read は結果が届いたので残らず、Bash だけが待ち
    expect(h.pend.map((x) => [x.id, x.name])).toEqual([["tu-bash-1", "Bash"]]);
    const tool = readJsonLineAt(FILE, h.pend[0]?.at ?? -1);
    const tu = tool.ok ? claudeToolUse(tool.value, "tu-bash-1") : null;
    expect(tu?.name).toBe("Bash");
    expect(tu?.input.command).toBe("git push origin fix/token-refresh");
    const text = readJsonLineAt(FILE, h.textAt ?? -1);
    expect(text.ok && claudeLastText(text.value)).toBe("Pushing the branch now.");
  });

  test("分けて読んでも同じ位置になる（位置はファイルの先頭からの絶対値）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "turnlane-glance-"));
    try {
      const dir = join(tmp, "projects/-fixture-repo-b");
      const path = join(dir, `${SID}.jsonl`);
      const full = readFileSync(FILE);
      await Bun.write(path, full.subarray(0, Math.floor(full.length / 2)));
      const stream = claudeCode.streamFor(rootFor(claudeCode, tmp), path);
      if (!stream) throw new Error("no stream");
      const first = await readStreamAll(claudeCode, stream, fixtureCtx());
      writeFileSync(path, full);
      const second = await readStreamAll(claudeCode, stream, fixtureCtx(), first.cursor);
      const once = await hintsOf(FILE, CASE);
      expect(claudeGlanceHints(second.cursor?.carry)).toEqual(once.hints);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("1 行の読み取り", () => {
  test("長すぎる行は読まない・無いファイル・壊れた行は理由のコードだけ", () => {
    const tmp = mkdtempSync(join(tmpdir(), "turnlane-glance-"));
    try {
      const p = join(tmp, "a.jsonl");
      writeFileSync(p, `${JSON.stringify({ type: "user", x: "y".repeat(2000) })}\n{broken\n`);
      expect(readJsonLineAt(p, 0, 100)).toEqual({ ok: false, reason: "too_long" });
      expect(readJsonLineAt(p, 0).ok).toBe(true);
      const broken = readFileSync(p).indexOf("{broken");
      expect(readJsonLineAt(p, broken)).toEqual({ ok: false, reason: "unreadable" });
      expect(readJsonLineAt(join(tmp, "none.jsonl"), 0)).toEqual({ ok: false, reason: "missing" });
      expect(readJsonLineAt(join(tmp, "auth.json"), 0)).toEqual({
        ok: false,
        reason: "unreadable",
      });
      const tail = readTailRecords(p);
      expect(tail.ok && tail.records.length).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("tool_result の ID・セッションのファイルを ID で探し直す", () => {
    expect(
      claudeToolResultIds({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "a" }] },
      }),
    ).toEqual(["a"]);
    expect(findClaudeTranscript(CASE, null, SID)).toBe(FILE);
    expect(findClaudeTranscript(CASE, `${CASE}/projects/-trimmed/${SID}.jsonl`, SID)).toBe(FILE);
    expect(findClaudeTranscript(CASE, null, "../etc")).toBeNull();
  });
});
