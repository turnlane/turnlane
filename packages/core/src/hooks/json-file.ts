/**
 * hooks 設定ファイル（JSON）の読み書き（phase0-plan 3.6.1、S5）。
 * - 書式（インデント幅、末尾改行）を元ファイルから検出して同じ書式で書く。正規形なら install → uninstall で
 *   バイト単位で元に戻る。正規形でなければ意味が同じで書式だけが正規化される
 * - シンボリックリンク（dotfiles 管理）は実体のパスに書く（リンクを壊さない）
 * - 書き込みは同じディレクトリの一時ファイル → rename。パーミッションを引き継ぐ
 * - 書く直前に再読込し、読んだ時点から内容が変わっていたら中止する（他プロセスとの競合）
 * - 変更が無ければ書かない（バックアップも作らない）。新規作成はバックアップなし
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

export interface LoadedJson {
  /** 実体のパス */
  path: string;
  exists: boolean;
  raw: string;
  value: Record<string, unknown>;
  indent: string | number;
  trailingNewline: boolean;
  /** JSON.stringify(v, null, indent) と同じ書式か */
  canonical: boolean;
}

export class ConfigParseError extends Error {}

export function detectIndent(raw: string): string | number {
  const m = raw.match(/^\{\r?\n([ \t]+)\S/);
  if (!m?.[1]) return 2;
  return m[1].startsWith("\t") ? "\t" : m[1].length;
}

export function serialize(value: unknown, indent: string | number, nl: boolean): string {
  return `${JSON.stringify(value, null, indent)}${nl ? "\n" : ""}`;
}

export function loadJson(path: string): LoadedJson {
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
    throw new ConfigParseError(`JSON として読めません: ${(e as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigParseError("トップレベルがオブジェクトではありません");
  }
  const indent = detectIndent(raw);
  const trailingNewline = raw.endsWith("\n");
  const canonical = serialize(value, indent, trailingNewline) === raw;
  return {
    path: real,
    exists: true,
    raw,
    value: value as Record<string, unknown>,
    indent,
    trailingNewline,
    canonical,
  };
}

export interface SaveResult {
  changed: boolean;
  backup?: string;
  text: string;
}

function isEmptyObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && Object.keys(v).length === 0;
}

export function saveJson(
  file: LoadedJson,
  next: unknown,
  opts: { backupSuffix: string; dryRun?: boolean },
): SaveResult {
  const text = serialize(next, file.indent, file.trailingNewline);
  if (!file.exists && isEmptyObject(next)) return { changed: false, text };
  return saveText(file, text, opts);
}

/**
 * テキストの設定ファイルを書く（saveJson と Codex の config.toml の共通部分）。変更が無ければ書かない。
 * 既存のファイルは <実パス><backupSuffix> に退避し（パーミッションも同じにする）、一時ファイル → rename で書く
 */
export function saveText(
  file: { path: string; exists: boolean; raw: string },
  text: string,
  opts: { backupSuffix: string; dryRun?: boolean },
): SaveResult {
  if (file.exists && text === file.raw) return { changed: false, text };
  if (opts.dryRun) return { changed: true, text };
  // 競合検出: 読んだ後に他プロセスが書き換えていたら中止
  const current = existsSync(file.path) ? readFileSync(file.path, "utf8") : "";
  if (current !== file.raw)
    throw new Error("読み込み後にファイルが変更されました。もう一度実行してください");
  let backup: string | undefined;
  let mode = 0o600;
  if (file.exists) {
    backup = `${file.path}${opts.backupSuffix}`;
    mode = statSync(file.path).mode & 0o777;
    copyFileSync(file.path, backup);
    // 退避にも元と同じパーミッション（他人に読めるようにしない）
    chmodSync(backup, mode);
  }
  const tmp = join(dirname(file.path), `.${basename(file.path)}.turnlane-tmp-${process.pid}`);
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file.path);
  return backup ? { changed: true, backup, text } : { changed: true, text };
}
