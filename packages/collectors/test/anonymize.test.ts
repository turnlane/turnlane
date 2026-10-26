import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anonymize } from "../scripts/anonymize.ts";
import claudeCode from "../src/adapters/claude-code/index.ts";
import { textTraits } from "../src/closing-question.ts";
import { fixtureCtx, readAll, reduceEvents, rootFor } from "../src/testing/index.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "turnlane-anon-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const SID = "aaaaaaaa-1111-4222-8333-444444444444";
const CWD = "/Users/someone/source/secret-project";
const BRANCH = "feature/secret-thing";
const SECRET_TEXT = "SECRET_PROMPT_TEXT";

function line(o: unknown) {
  return `${JSON.stringify(o)}\n`;
}

describe("anonymize（phase0-plan 5.2）", () => {
  test("許可リストで絞り、cwd・ブランチ・ID・PR・タイトルを写像し、時刻をずらす。判定に要る性質は残す", () => {
    const root = join(tmp, "root");
    const dir = join(root, "projects", "-Users-someone-source-secret-project");
    mkdirSync(dir, { recursive: true });
    const common = {
      sessionId: SID,
      cwd: CWD,
      gitBranch: BRANCH,
      version: "2.1.287",
      entrypoint: "cli",
    };
    writeFileSync(
      join(dir, `${SID}.jsonl`),
      [
        line({
          ...common,
          type: "user",
          timestamp: "2026-01-05T10:00:00Z",
          uuid: "u1",
          promptId: "p1",
          origin: { kind: "human" },
          message: { role: "user", content: SECRET_TEXT },
        }),
        line({
          ...common,
          type: "assistant",
          timestamp: "2026-01-05T10:00:05Z",
          uuid: "u2",
          message: {
            id: "m1",
            model: "claude-x",
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 2 },
            content: [{ type: "text", text: `${SECRET_TEXT} どちらにしますか？` }],
          },
        }),
        line({
          ...common,
          type: "system",
          subtype: "turn_duration",
          timestamp: "2026-01-05T10:00:06Z",
          durationMs: 6000,
        }),
        line({
          type: "pr-link",
          sessionId: SID,
          timestamp: "2026-01-05T10:00:07Z",
          prNumber: 42,
          prRepository: "someone/secret-project",
          prUrl: "https://github.com/someone/secret-project/pull/42",
        }),
        line({ type: "ai-title", sessionId: SID, aiTitle: "Fix the secret thing" }),
        line({ type: "last-prompt", sessionId: SID, lastPrompt: SECRET_TEXT }),
      ].join(""),
    );
    const out = join(tmp, "out");
    const r = anonymize({ tool: "claude_code", root, out, files: [join(dir, `${SID}.jsonl`)] });
    expect(r.written).toHaveLength(1);
    const text = readFileSync(r.written[0] as string, "utf8");
    for (const s of [
      SECRET_TEXT,
      CWD,
      BRANCH,
      SID,
      "secret-project",
      "someone",
      "Fix the secret thing",
      "2026-01-05",
    ]) {
      expect(text).not.toContain(s);
    }
    expect(r.written[0]).toContain("/projects/-fixture-repo-a/");
    expect(text).toContain("/fixture/repo-a");
    expect(text).toContain("feat/branch-1");
    expect(text).toContain("fixture-org/repo-1");
    expect(text).toContain("2026-09-01T09:00:00.000Z");
    expect(text).not.toContain("last-prompt");
    // 質問で終わるという性質は合成文で残る
    const assistant = text
      .split("\n")
      .map((l) => (l ? JSON.parse(l) : null))
      .find((o) => o?.type === "assistant");
    expect(textTraits(assistant.message.content[0].text).question).toBe(true);
  });

  test("フィクスチャを読むと元のデータと同じ形のイベントになる（PR・質問・時間）", async () => {
    const root = join(tmp, "root");
    const dir = join(root, "projects", "-p");
    mkdirSync(dir, { recursive: true });
    const common = {
      sessionId: SID,
      cwd: CWD,
      gitBranch: "main",
      version: "2.1.287",
      entrypoint: "cli",
    };
    writeFileSync(
      join(dir, `${SID}.jsonl`),
      [
        line({
          ...common,
          type: "user",
          timestamp: "2026-01-05T10:00:00Z",
          uuid: "u1",
          promptId: "p1",
          origin: { kind: "human" },
          message: { role: "user", content: "x" },
        }),
        line({
          ...common,
          type: "assistant",
          timestamp: "2026-01-05T10:00:05Z",
          uuid: "u2",
          message: {
            id: "m1",
            model: "claude-x",
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 2 },
            content: [{ type: "text", text: "Anything else?" }],
          },
        }),
        line({
          ...common,
          type: "system",
          subtype: "turn_duration",
          timestamp: "2026-01-05T10:00:06Z",
          durationMs: 6000,
        }),
      ].join(""),
    );
    const out = join(tmp, "out");
    anonymize({ tool: "claude_code", root, out, files: [join(dir, `${SID}.jsonl`)] });
    const st = reduceEvents(await readAll(claudeCode, rootFor(claudeCode, out), fixtureCtx()));
    const t = Object.values(st.turns)[0] as {
      durationMs: number;
      endedWith: string;
      closingQuestion: boolean;
      gitBranch: string;
    };
    expect(t).toMatchObject({
      durationMs: 6000,
      endedWith: "question",
      closingQuestion: true,
      gitBranch: "main",
    });
  });

  test("元データの値が出力に残る場合は失敗する", () => {
    const root = join(tmp, "root");
    mkdirSync(join(root, "projects", "-p"), { recursive: true });
    const f = join(root, "projects", "-p", `${SID}.jsonl`);
    // 許可リストのキー（version）に cwd の一部が入っている異常なデータ
    writeFileSync(
      f,
      line({
        type: "user",
        sessionId: SID,
        cwd: CWD,
        version: "secret-project",
        timestamp: "2026-01-05T10:00:00Z",
      }),
    );
    expect(() =>
      anonymize({ tool: "claude_code", root, out: join(tmp, "out"), files: [f] }),
    ).toThrow(/残っています/);
  });
});
