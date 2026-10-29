/**
 * 検証の済んだ更新を配置先（install.json の appPath）に入れる（ADR 0008 の追記 4）。入れ替えは install/bundle.ts の
 * replaceBundle（`turnlane desktop install` と共通）: 隣に `.Turnlane.app.new` として ditto → 今のものを `.Turnlane.app.old` に
 * rename → 新を本名に rename。途中で失敗したら old を戻す。書けない（EACCES など）なら not_writable
 * （管理者権限は求めない。手動の案内に戻す）。old はここでは消さない（古い版のアプリ・デーモン・ヘルパがまだ終わる途中で、
 * 実行ファイルを消すと落ちる）。新しい版のデーモンが起動の後に消す（InstallService の cleanupOldBundle）
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BUNDLE_INFO_PLIST, type UpdateDownloadError } from "@turnlane/core";
import { type ReplaceOps, replaceBundle } from "../install/bundle.ts";

export async function installUpdate(
  src: string,
  appPath: string,
  ops?: ReplaceOps,
): Promise<UpdateDownloadError | null> {
  if (!existsSync(join(src, BUNDLE_INFO_PLIST))) return "io";
  return await replaceBundle(src, appPath, ops, { keepOld: true });
}
