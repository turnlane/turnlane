import { join } from "node:path";
import { DAEMON_LABEL, resolvePaths, type TurnlanePaths } from "@turnlane/core";
import { type CliLang, resolveLang } from "./lang.ts";
import { DisabledLaunchctl, type Launchctl, SystemLaunchctl } from "./launchctl.ts";

/** コマンドの実行環境。テストでは一時 HOME と FakeLaunchctl を渡す */
export interface CliEnv {
  paths: TurnlanePaths;
  launchctl: Launchctl;
  out: (s: string) => void;
  err: (s: string) => void;
  /** 実行中の turnlane の絶対パス（self-install のコピー元を決める） */
  execPath: string;
  /** プロセス環境（plist に引き継ぐ TURNLANE_* を拾う） */
  vars: Record<string, string | undefined>;
  /** 文言の言語（無ければ英語。テストは指定しなければ英語になる） */
  lang?: CliLang;
}

export function systemEnv(): CliEnv {
  const paths = resolvePaths();
  return {
    paths,
    launchctl:
      process.env.TURNLANE_NO_LAUNCHD === "1" ? new DisabledLaunchctl() : new SystemLaunchctl(),
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    execPath: process.execPath,
    vars: process.env,
    lang: resolveLang(process.env, paths.dbPath),
  };
}

export function plistPath(paths: TurnlanePaths): string {
  return join(paths.launchAgentsDir, `${DAEMON_LABEL}.plist`);
}

/**
 * 簡単な引数解析: --flag、--key value、位置引数。同じキーを複数回指定した値は multi に入る。
 * `--` より後はすべて位置引数（`-` で始まる題名を turnlane add に渡すとき）
 */
export function parseArgs(args: string[]): {
  pos: string[];
  flags: Set<string>;
  opts: Map<string, string>;
  multi: Map<string, string[]>;
} {
  const pos: string[] = [];
  const flags = new Set<string>();
  const opts = new Map<string, string>();
  const multi = new Map<string, string[]>();
  const valued = new Set([
    "--from",
    "--out",
    "-n",
    "--lines",
    "--claude-dir",
    "--bin",
    "--date",
    "--days",
    "--source",
    "--since",
    "--until",
    "--est",
    "--project",
    "--note",
    "--external-id",
    "--url",
    "--role",
    "--set",
    "--app",
    "--lang",
    "--title",
    "--estimate",
    // turnlane ai report（ADR 0021）
    "--id",
    "--state",
    "--kind",
    "--text",
    "--option",
    "--label",
    "--error-kind",
    "--at",
    "--client-id",
  ]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (valued.has(a)) {
      const v = args[i + 1] ?? "";
      opts.set(a, v);
      multi.set(a, [...(multi.get(a) ?? []), v]);
      i++;
    } else if (a.startsWith("-")) flags.add(a);
    else pos.push(a);
  }
  return { pos, flags, opts, multi };
}
