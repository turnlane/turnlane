/**
 * Homebrew cask（phase0-plan M6-9、ADR 0011 決定 6、docs/release.md）。雛形 turnlane.rb.tmpl に版と sha256 を差し込む。
 * - app と binary（Contents/Helpers/turnlane）、arm64・Sonoma 以降、uninstall は quit だけ（launchctl は zap にだけ。
 *   uninstall は brew upgrade のたびに走るため）、postflight なし
 * - url は Releases の zip（core の releaseZipUrl と同じ形。テストで突き合わせる）。持ち主・リポジトリ・cask の名前は
 *   packages/core/src/release-config.ts から差し込む（名前を変えるときは docs/release.md の一覧）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CASK_TOKEN,
  RELEASE_REPO_URL,
  RELEASES_DOWNLOAD_URL,
} from "../../packages/core/src/release-config.ts";

export const CASK_TEMPLATE = join(import.meta.dir, "turnlane.rb.tmpl");

/** tap のリポジトリでの置き場 */
export const TAP_CASK_PATH = `Casks/${CASK_TOKEN}.rb`;

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** 雛形の名前の差し込み（release-config.ts） */
export const CASK_NAMES = {
  CASK_TOKEN,
  HOMEPAGE: RELEASE_REPO_URL,
  RELEASES_DOWNLOAD_URL,
} as const;

/** 雛形に版と sha256（と名前）を差し込む（純粋）。差し込み漏れ・不正な値は例外 */
export function renderCask(
  template: string,
  x: { version: string; sha256: string },
  names: Record<keyof typeof CASK_NAMES, string> = CASK_NAMES,
): string {
  if (!SEMVER.test(x.version)) throw new Error(`cask: invalid version ${x.version}`);
  if (!SHA256.test(x.sha256)) throw new Error("cask: sha256 must be 64 lowercase hex characters");
  let out = template.replaceAll("{{VERSION}}", x.version).replaceAll("{{SHA256}}", x.sha256);
  for (const [k, v] of Object.entries(names)) out = out.replaceAll(`{{${k}}}`, v);
  const left = /\{\{[A-Z0-9_]+\}\}/.exec(out);
  if (left) throw new Error(`cask: unfilled placeholder ${left[0]}`);
  return out;
}

/** 雛形のファイルから描く */
export function renderCaskFile(x: { version: string; sha256: string }): string {
  return renderCask(readFileSync(CASK_TEMPLATE, "utf8"), x);
}
