/**
 * CLI の言語（文言の見直し 問い 1）: 英語が正。TURNLANE_LANG > 設定 ui.language > LC_ALL・LC_MESSAGES・LANG。
 * env.lang を渡さなければ英語、ja を渡せば使い方もエラーも日本語。
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "@turnlane/core";
import type { CliEnv } from "../src/env.ts";
import { type CliLang, langFromVars, resolveLang, setLang, tr } from "../src/lang.ts";
import { FakeLaunchctl } from "../src/launchctl.ts";
import { runCommand } from "../src/run.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  setLang("en");
});

function dbWith(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "turnlane-lang-"));
  dirs.push(dir);
  const path = join(dir, "turnlane.db");
  const db = new Database(path);
  db.run("CREATE TABLE setting (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
  if (value !== undefined)
    db.query("INSERT INTO setting VALUES ('ui.language', ?)").run(JSON.stringify(value));
  db.close();
  return path;
}

function fakeEnv(lang?: CliLang): { env: CliEnv; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const paths = { ...resolvePaths({ HOME: "/nonexistent" }, "/nonexistent"), port: 1 };
  return {
    env: {
      paths,
      launchctl: new FakeLaunchctl(() => "x"),
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      execPath: "/usr/local/bin/bun",
      vars: {},
      ...(lang ? { lang } : {}),
    },
    out,
    err,
  };
}

describe("resolveLang", () => {
  test("環境変数: LC_ALL・LC_MESSAGES・LANG の順。ja で始まれば日本語、それ以外は英語", () => {
    expect(langFromVars({})).toBe("en");
    expect(langFromVars({ LANG: "ja_JP.UTF-8" })).toBe("ja");
    expect(langFromVars({ LANG: "en_US.UTF-8" })).toBe("en");
    expect(langFromVars({ LC_ALL: "en_US.UTF-8", LANG: "ja_JP.UTF-8" })).toBe("en");
    expect(langFromVars({ LC_MESSAGES: "ja_JP.UTF-8", LANG: "C" })).toBe("ja");
  });

  test("TURNLANE_LANG がいちばん強い", () => {
    expect(langFromVars({ TURNLANE_LANG: "en", LANG: "ja_JP.UTF-8" })).toBe("en");
    expect(resolveLang({ TURNLANE_LANG: "ja" }, dbWith("en"))).toBe("ja");
  });

  test("設定 ui.language が en / ja なら LANG より優先。system・未設定・DB 無しは LANG", () => {
    expect(resolveLang({ LANG: "ja_JP.UTF-8" }, dbWith("en"))).toBe("en");
    expect(resolveLang({ LANG: "en_US.UTF-8" }, dbWith("ja"))).toBe("ja");
    expect(resolveLang({ LANG: "ja_JP.UTF-8" }, dbWith("system"))).toBe("ja");
    expect(resolveLang({ LANG: "en_US.UTF-8" }, dbWith(undefined))).toBe("en");
    expect(resolveLang({ LANG: "ja_JP.UTF-8" }, "/nonexistent/turnlane.db")).toBe("ja");
  });

  test("tr は今の言語の文言を返す", () => {
    setLang("en");
    expect(tr("Hello", "こんにちは")).toBe("Hello");
    setLang("ja");
    expect(tr("Hello", "こんにちは")).toBe("こんにちは");
  });
});

describe("runCommand の言語", () => {
  test("lang を渡さなければ英語", async () => {
    const { env, out, err } = fakeEnv();
    expect(await runCommand("help", [], env)).toBe(0);
    expect(out[0]).toContain("Usage:");
    expect(out[0]).not.toContain("turnlane stats");
    expect(await runCommand("ls", ["--all"], env)).toBe(2);
    expect(err[0]).toContain("turnlane ls: unknown option: --all");
  });

  test("ja なら使い方もエラーも日本語（内部の名前を出さない）", async () => {
    const { env, out, err } = fakeEnv("ja");
    expect(await runCommand("help", [], env)).toBe(0);
    expect(out[0]).toContain("使い方:");
    expect(out[0]).toContain("AI の作業を日ごとに表示（AI の時間・放置・期限切れ）");
    expect(out[0]).toContain("取り込み元とその状態");
    for (const word of ["spool", "キュー", "論理削除", "縮退", "儀式", "カーソル", "Phase 0"])
      expect(out[0]).not.toContain(word);
    expect(await runCommand("ls", ["--all"], env)).toBe(2);
    expect(err[0]).toContain("turnlane ls: 不明なオプション: --all");
    expect(err[0]).toContain("使い方:");
  });
});
