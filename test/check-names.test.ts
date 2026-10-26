import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLine, checkNames } from "../scripts/check-names.ts";

// 旧名は組み立てて書く（このファイル自体は検査の対象外だが、例を読みやすくするため）
const OLD = ["day", "line"].join("");
const OLD_CLI = ["d", "l"].join("");

describe("旧名の残りの検査（ADR 0016）", () => {
  test("リポジトリに残してはいけない旧名が無い", () => {
    const r = checkNames();
    expect(r.violations.map((v) => `${v.file}:${v.line}: ${v.text}`)).toEqual([]);
    expect(r.allowed.size).toBeGreaterThan(0);
  });

  test("旧名とコマンドとしての旧の CLI を見つけ、CSS のトークンや HTML の dl は見ない", () => {
    expect(checkLine(`${OLD} shows your board`).violation).toBe(true);
    expect(checkLine(`export ${OLD.toUpperCase()}_PORT=1`).violation).toBe(true);
    expect(checkLine(`run ${OLD_CLI} self-install`).violation).toBe(true);
    expect(checkLine(`out/${OLD_CLI} hooks install`).violation).toBe(true);
    expect(checkLine(`const BINS = ["${OLD_CLI}"]`).violation).toBe(true);
    expect(checkLine("color: var(--dl-text-3);").legacy).toBe(false);
    expect(checkLine('<dl className="grid">').legacy).toBe(false);
    expect(checkLine("turnlane self-install").legacy).toBe(false);
  });

  test("残してよい形（予定の目印、リポジトリのディレクトリ）は違反にしない", () => {
    expect(checkLine(`url: "${OLD}://timeblock/abc"`).violation).toBe(false);
    expect(checkLine(`cd ~/source/${OLD}`).violation).toBe(false);
    expect(checkLine(`cd ~/source/${OLD} && ${OLD_CLI} open`).violation).toBe(true);
  });

  test("許されたファイルの外の旧名を一覧する", () => {
    const root = mkdtempSync(join(tmpdir(), "turnlane-names-"));
    try {
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      writeFileSync(join(root, "docs", "adr", "0001-x.md"), `${OLD} は ${OLD_CLI} open で開く\n`);
      writeFileSync(join(root, "a.ts"), `// ok\nconst x = "${OLD}";\n`);
      const r = checkNames(root, ["docs/adr/0001-x.md", "a.ts"]);
      expect(r.violations).toEqual([{ file: "a.ts", line: 2, text: `const x = "${OLD}";` }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
