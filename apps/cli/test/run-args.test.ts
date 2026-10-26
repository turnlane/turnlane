/**
 * サブコマンドの引数: どのサブコマンドでも --help / -h で使い方を出す（一覧などを実行しない）、
 * 未知のオプション・余分な位置引数はエラーにして使い方を出す（`turnlane ls inbox`）。
 */
import { describe, expect, test } from "bun:test";
import { resolvePaths } from "@turnlane/core";
import type { CliEnv } from "../src/env.ts";
import { parseArgs } from "../src/env.ts";
import { FakeLaunchctl } from "../src/launchctl.ts";
import { ARG_SPECS, checkArgs, helpFor, runCommand, usage } from "../src/run.ts";

function fakeEnv(): { env: CliEnv; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  // ポート 1 にはデーモンがいない（実行に進めば接続できずに失敗する）
  const paths = { ...resolvePaths({ HOME: "/nonexistent" }, "/nonexistent"), port: 1 };
  return {
    env: {
      paths,
      launchctl: new FakeLaunchctl(() => "x"),
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      execPath: "/usr/local/bin/bun",
      vars: {},
    },
    out,
    err,
  };
}

describe("--help / -h", () => {
  test("すべてのサブコマンドで使い方を出して 0（そのコマンドの行を含む）", async () => {
    for (const cmd of Object.keys(ARG_SPECS))
      for (const h of ["--help", "-h"]) {
        const { env, out, err } = fakeEnv();
        expect(await runCommand(cmd, [h], env)).toBe(0);
        expect(err).toEqual([]);
        // turnlane stats は計測用なので使い方に載せない（K13）。全体の使い方を出す
        if (cmd === "stats") expect(out[0]).toBe(usage());
        else expect(out.join("\n")).toContain(`turnlane ${cmd}`);
      }
  });

  test("turnlane ls --help は一覧ではなく ls の使い方だけ", async () => {
    const { env, out } = fakeEnv();
    expect(await runCommand("ls", ["--help"], env)).toBe(0);
    expect(out[0]).toBe(helpFor("ls"));
    expect(out[0]).toContain("turnlane ls [--date YYYY-MM-DD | --inbox] [--json]");
    expect(out[0]).not.toContain("turnlane add");
  });

  test("turnlane help <command> と turnlane help", async () => {
    const a = fakeEnv();
    expect(await runCommand("help", ["edit"], a.env)).toBe(0);
    expect(a.out[0]).toContain("turnlane edit <id>");
    const b = fakeEnv();
    expect(await runCommand("help", [], b.env)).toBe(0);
    expect(b.out[0]).toBe(usage());
  });

  test("`--` より後の --help は題名の一部", () => {
    expect(parseArgs(["--", "-h", "x"]).pos).toEqual(["-h", "x"]);
    expect(checkArgs("add", ["--", "--help"])).toBeNull();
  });

  test("USAGE のすべてのサブコマンドに引数の定義がある", () => {
    const cmds = [...usage().matchAll(/^ {2}turnlane ([a-z][a-z-]*)/gm)].map((m) => m[1] as string);
    for (const c of cmds)
      if (!["hook", "help"].includes(c)) expect(Object.keys(ARG_SPECS)).toContain(c);
  });
});

describe("未知の引数", () => {
  test("turnlane ls inbox は余分な引数としてエラー（2）にし、使い方を出す", async () => {
    const { env, out, err } = fakeEnv();
    expect(await runCommand("ls", ["inbox"], env)).toBe(2);
    expect(out).toEqual([]);
    expect(err[0]).toContain("extra arguments: inbox");
    expect(err[0]).toContain("turnlane ls [--date");
  });

  test("未知のオプション・値の無いオプション・値を取らないフラグ", () => {
    expect(checkArgs("ls", ["--all"])).toContain("unknown option: --all");
    expect(checkArgs("ls", ["--date"])).toContain("--date needs a value");
    expect(checkArgs("done", ["a", "b"])).toContain("extra arguments: b");
    expect(checkArgs("edit", ["abc", "--title", "New", "--est", "30"])).toBeNull();
    expect(checkArgs("edit", ["abc", "--estimate", "30", "--no-project"])).toBeNull();
    expect(checkArgs("add", ["Write", "outline", "--est", "30"])).toBeNull();
    expect(checkArgs("calendar", ["calendars", "--role", "id1", "source"])).toBeNull();
    expect(checkArgs("daemon", ["logs", "-f", "-n", "20"])).toBeNull();
    expect(checkArgs("config", ["set", "workdays.weekdays", "[1,2]"])).toBeNull();
    expect(checkArgs("hooks", ["install", "--claude-dir", "a", "--claude-dir", "b"])).toBeNull();
  });
});
