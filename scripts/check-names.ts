/**
 * 旧名（dayline、CLI `dl`）の残りの検査（ADR 0016）。
 *
 *   bun scripts/check-names.ts          残ってはいけない旧名を一覧し、あれば終了コード 1
 *   bun scripts/check-names.ts --list   残してよい旧名も理由ごとに数えて出す
 *
 * git が管理するテキストのファイルを走査する。残してよいもの（ALLOWED_FILES・ALLOWED_PATTERNS）以外に
 * `dayline`（大文字小文字を問わない。前が英字なら語の途中なので見ない）か、コマンドとしての `dl`（`dl <サブコマンド>`、`bin/dl`、`out/dl`、`` `dl` ``、`"dl"`）
 * があれば違反とする。CSS の設計トークン `--dl-*`・クラス `dl-*`・HTML の `<dl>` はコマンドではないので見ない。
 * test/check-names.test.ts が `bun test` で実行する。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/** 旧名を残してよいファイル（パスの先頭一致）と理由 */
export const ALLOWED_FILES: readonly { prefix: string; reason: string }[] = [
  { prefix: "docs/adr/", reason: "既存の ADR の本文は書き換えない（原則 2）。0016 は名前の対応表" },
  { prefix: "docs/spikes/", reason: "スパイクの記録（当時の名前での実験の結果）" },
  { prefix: "spikes/", reason: "スパイクのコード（使い捨て。本体のビルド・テストの対象外）" },
  {
    prefix: "packages/core/src/db/migrations/",
    reason: "適用済みのマイグレーションの SQL は変えない",
  },
  {
    prefix: "packages/core/src/legacy.ts",
    reason: "旧名の版が予定に付けた目印の定義（読み続けるため）",
  },
  { prefix: "scripts/check-names.ts", reason: "この検査" },
  { prefix: "test/check-names.test.ts", reason: "この検査のテスト" },
];

/** 旧名を含んでよい行の形と理由（どのファイルでも） */
export const ALLOWED_PATTERNS: readonly { re: RegExp; reason: string }[] = [
  {
    re: /source\/dayline/g,
    reason: "過去の手順書に残る当時の手元のディレクトリ（D-211 で ~/source/turnlane に変えた）",
  },
  {
    re: /dayline:(\\?\/){2}timeblock\\?\//g,
    reason: "M3-3 の旧の版が書いた時間ブロックの予定の目印（読み続ける）",
  },
  { re: /dayline:\/\/event\//g, reason: "旧の版が作った予定の目印（読み続ける）" },
  { re: /settings-dayline-en-dark/g, reason: "過去の画面の画像のファイル名" },
];

const SUBCOMMANDS =
  "self-install|uninstall|hook|hooks|daemon|open|add|mcp|calendar|desktop|doctor|report|ai|backup|export|config|today|ls|done|edit|rm|queue|rederive|reingest|sources|stats|--version|-v|help";
const LEGACY_RES: readonly RegExp[] = [
  // 語の途中（holidayLine の dayLine など）は旧名ではない。前が英字でないときだけ
  /(?<![a-z])dayline/gi,
  new RegExp(`(?<![\\w<\\/.$-])dl(?= +(?:${SUBCOMMANDS})\\b)`, "g"),
  /(?<![\w.-])(?:bin|out|Helpers)\/dl(?![\w-])/g,
  /`dl`/g,
  /"dl"/g,
];

const BINARY = /\.(png|jpe?g|gif|icns|ico|webp|woff2?|ttf|lockb)$/;

export interface Finding {
  file: string;
  line: number;
  text: string;
}

export interface CheckResult {
  violations: Finding[];
  /** 残してよい旧名の件数（理由ごと） */
  allowed: Map<string, number>;
}

function trackedFiles(root: string): string[] {
  const p = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe" });
  return p.stdout.toString().split("\0").filter(Boolean);
}

/** 1行を検査する。旧名が残っていれば、許される形を除いた残りがあるかを返す */
export function checkLine(text: string): {
  legacy: boolean;
  violation: boolean;
  reasons: string[];
} {
  if (!LEGACY_RES.some((re) => new RegExp(re.source, re.flags).test(text)))
    return { legacy: false, violation: false, reasons: [] };
  let rest = text;
  const reasons: string[] = [];
  for (const a of ALLOWED_PATTERNS) {
    const next = rest.replace(a.re, "");
    if (next !== rest) reasons.push(a.reason);
    rest = next;
  }
  const violation = LEGACY_RES.some((re) => new RegExp(re.source, re.flags).test(rest));
  return { legacy: true, violation, reasons };
}

export function checkNames(root = ROOT, files = trackedFiles(root)): CheckResult {
  const violations: Finding[] = [];
  const allowed = new Map<string, number>();
  const bump = (reason: string) => allowed.set(reason, (allowed.get(reason) ?? 0) + 1);
  for (const file of files) {
    if (BINARY.test(file)) continue;
    const fileAllow = ALLOWED_FILES.find((a) => file.startsWith(a.prefix));
    let text: string;
    try {
      const buf = readFileSync(join(root, file));
      if (buf.includes(0)) continue;
      text = buf.toString("utf8");
    } catch {
      continue; // 消したが git に未反映のファイルなど
    }
    const lines = text.split("\n");
    for (const [i, line] of lines.entries()) {
      const r = checkLine(line);
      if (!r.legacy) continue;
      if (fileAllow) bump(fileAllow.reason);
      else if (r.violation) violations.push({ file, line: i + 1, text: line.trim().slice(0, 160) });
      else for (const reason of r.reasons) bump(reason);
    }
  }
  return { violations, allowed };
}

if (import.meta.main) {
  const r = checkNames();
  if (process.argv.includes("--list")) {
    console.log("残してよい旧名（行数）:");
    for (const [reason, n] of [...r.allowed].sort((a, b) => b[1] - a[1]))
      console.log(`  ${String(n).padStart(5)}  ${reason}`);
  }
  if (r.violations.length > 0) {
    console.error(`旧名が残っています（${r.violations.length} 行）:`);
    for (const v of r.violations) console.error(`  ${v.file}:${v.line}: ${v.text}`);
    process.exit(1);
  }
  console.log("旧名の残り: 違反なし");
}
