/**
 * hooks 設定ファイル（JSON）の読み書き。M1-10 の apps/cli/src/hooks-install/ の原型。
 *
 * - 書式（インデント幅、末尾改行）を元ファイルから検出して同じ書式で書く。元ファイルが
 *   `JSON.stringify(v, null, indent)` の出力と同じ（＝正規形）なら、install → uninstall で
 *   バイト単位で元に戻る。正規形でなければ uninstall 後は意味が同じで書式だけが正規化される
 * - シンボリックリンク（dotfiles 管理）は実体のパスに書く（リンクを壊さない）
 * - 書き込みは同じディレクトリの一時ファイル → rename。パーミッションを引き継ぐ
 * - 書く直前に再読込し、読んだ時点から内容が変わっていたら中止する（他プロセスとの競合）
 * - 変更が無ければ書かない（バックアップも作らない）
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface Loaded {
  path: string; // 実体のパス
  exists: boolean;
  raw: string;
  // biome-ignore lint/suspicious/noExplicitAny: JSON
  value: any;
  indent: string | number;
  trailingNewline: boolean;
  canonical: boolean;
}

export class ConfigParseError extends Error {}

export function detectIndent(raw: string): string | number {
  const m = raw.match(/^\{\r?\n([ \t]+)\S/);
  if (!m?.[1]) return 2;
  return m[1].startsWith("\t") ? "\t" : m[1].length;
}

export function load(path: string): Loaded {
  const real = existsSync(path) ? realpathSync(path) : path;
  if (!existsSync(real)) {
    return {
      path: real,
      exists: false,
      raw: "",
      value: {},
      indent: 2,
      trailingNewline: true,
      canonical: true,
    };
  }
  const raw = readFileSync(real, "utf8");
  let value: unknown;
  try {
    value = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch (e) {
    throw new ConfigParseError(`JSON として読めない: ${(e as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigParseError("トップレベルがオブジェクトではない");
  }
  const indent = detectIndent(raw);
  const trailingNewline = raw.endsWith("\n");
  const canonical = serialize(value, indent, trailingNewline) === raw;
  return { path: real, exists: true, raw, value, indent, trailingNewline, canonical };
}

export function serialize(value: unknown, indent: string | number, nl: boolean): string {
  return `${JSON.stringify(value, null, indent)}${nl ? "\n" : ""}`;
}

export interface SaveResult {
  changed: boolean;
  backup?: string;
}

export function save(
  file: Loaded,
  next: unknown,
  opts: { backupSuffix: string; dryRun?: boolean },
): SaveResult & { text: string } {
  const text = serialize(next, file.indent, file.trailingNewline);
  if (file.exists && text === file.raw) return { changed: false, text };
  if (!file.exists && isEmptyObject(next)) return { changed: false, text };
  if (opts.dryRun) return { changed: true, text };

  // 競合検出: 読んだ後に他プロセスが書き換えていたら中止
  const current = existsSync(file.path) ? readFileSync(file.path, "utf8") : "";
  if (current !== file.raw) throw new Error("読み込み後にファイルが変更された。やり直す");

  let backup: string | undefined;
  let mode = 0o600;
  if (file.exists) {
    backup = `${file.path}${opts.backupSuffix}`;
    copyFileSync(file.path, backup);
    mode = statSync(file.path).mode & 0o777;
  }
  const tmp = join(dirname(file.path), `.${basename(file.path)}.dayline-tmp-${process.pid}`);
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file.path);
  return { changed: true, backup, text };
}

function isEmptyObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && Object.keys(v).length === 0;
}
