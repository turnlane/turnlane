/**
 * 公開前の検査（phase0-plan M6-7、ADR 0015）: 本体のツリー（と --history で全履歴）に、渡した一覧の文字列が無いことを確かめる。
 *
 *   bun scripts/audit-public.ts --deny <一覧のファイル> [--history] [--root <dir>]
 *
 * 一覧のファイルは本体のリポジトリに置かない（拡張のリポジトリが持つ。一覧そのものが拡張の中身を含むため）。
 * バイナリのファイル（画像など）は中身を見ず、パスだけを検査する（画像の中の文字は M6-7 の目視）。
 * 1行に1つ。`#` で始まる行と空行は読み飛ばす。`/.../flags` は正規表現、それ以外は大文字小文字を区別しない部分一致。
 * 見つかったら `<ファイル>:<行>: <一覧の行>`（--history はコミットとファイル）を出して終了コード 1。本文は出さない
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface DenyRule {
  label: string;
  test: (s: string) => boolean;
}

export function parseDenyList(text: string): DenyRule[] {
  const out: DenyRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^\/(.+)\/([a-z]*)$/.exec(line);
    if (m) {
      const re = new RegExp(m[1] as string, m[2]);
      out.push({ label: line, test: (s) => re.test(s) });
    } else {
      const needle = line.toLowerCase();
      out.push({ label: line, test: (s) => s.toLowerCase().includes(needle) });
    }
  }
  return out;
}

export interface Hit {
  where: string;
  rule: string;
}

/** テキストの各行を検査する */
export function scanText(where: string, text: string, rules: readonly DenyRule[]): Hit[] {
  const hits: Hit[] = [];
  text.split("\n").forEach((line, i) => {
    for (const r of rules)
      if (r.test(line)) hits.push({ where: `${where}:${i + 1}`, rule: r.label });
  });
  return hits;
}

function git(root: string, args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

/** 今のツリー（追跡しているファイル。バイナリも文字列として読む） */
export function scanTree(root: string, rules: readonly DenyRule[]): Hit[] {
  const files = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const hits: Hit[] = [];
  for (const f of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(resolve(root, f));
    } catch {
      continue;
    }
    // バイナリ（画像など。先頭に NUL を含む）は中身を見ずパスだけ検査する。画像の中の文字は目視で確かめる（M6-7）
    if (!buf.subarray(0, 8000).includes(0)) hits.push(...scanText(f, buf.toString("utf8"), rules));
    for (const r of rules) if (r.test(f)) hits.push({ where: `${f} (path)`, rule: r.label });
  }
  return hits;
}

/** 全履歴（全ブランチのパッチとコミットメッセージ） */
export function scanHistory(root: string, rules: readonly DenyRule[]): Hit[] {
  const log = git(root, ["log", "--all", "-p", "--format=@@commit %H%n%B", "--no-color"]);
  const hits: Hit[] = [];
  let commit = "";
  let file = "";
  for (const line of log.split("\n")) {
    if (line.startsWith("@@commit ")) {
      commit = line.slice(9, 21);
      file = "(message)";
      continue;
    }
    if (line.startsWith("diff --git ")) {
      file = line.split(" b/")[1] ?? line;
      continue;
    }
    for (const r of rules)
      if (r.test(line)) hits.push({ where: `${commit} ${file}`, rule: r.label });
  }
  // 同じコミット・ファイル・規則は1つにまとめる
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = `${h.where}\0${h.rule}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const deny = opt("--deny");
  if (!deny) {
    console.error("usage: bun scripts/audit-public.ts --deny <file> [--history] [--root <dir>]");
    process.exit(2);
  }
  const root = resolve(opt("--root") ?? resolve(import.meta.dir, ".."));
  const rules = parseDenyList(readFileSync(deny, "utf8"));
  const hits = [
    ...scanTree(root, rules),
    ...(args.includes("--history") ? scanHistory(root, rules) : []),
  ];
  for (const h of hits) console.log(`${h.where}: ${h.rule}`);
  console.log(`${rules.length} rules, ${hits.length} hits`);
  process.exit(hits.length > 0 ? 1 : 0);
}
