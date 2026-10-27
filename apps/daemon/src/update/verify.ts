/**
 * 取得した更新の検証（ADR 0008 の追記 4）。どれか 1 つでも落ちたら入れない:
 * 1. `/usr/bin/codesign --verify --deep --strict` が通る（signature）
 * 2. `codesign -dv --verbose=2` の TeamIdentifier が、動いている自分のバンドル（install.json の appPath）の TeamIdentifier と
 *    同じ（team_id）。Team ID は定数に持たない。どちらかが無い（ad-hoc・未署名）なら落とす
 * 3. Info.plist の CFBundleShortVersionString が latest.json の版と同じで、今の版より新しい（version）
 * 4. `/usr/sbin/spctl --assess --type execute` が accepted（notarization。チケットが staple 済みなら通常は Apple に接続しない）
 * 外部コマンドは run で差し替える（テスト）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLE_INFO_PLIST, compareVersions, type UpdateDownloadError } from "@turnlane/core";
import { codesignInfo, type RunCommand, runCommand } from "../install/bundle.ts";
import { plistString } from "../install/index.ts";

export interface VerifyOptions {
  /** latest.json の版 */
  expectedVersion: string;
  /** 今の版 */
  currentVersion: string;
  /** 動いている自分のバンドル（install.json の appPath）。無ければ落とす */
  selfApp: string | null;
  run?: RunCommand;
}

export function bundleShortVersion(app: string): string | null {
  try {
    return plistString(
      readFileSync(join(app, BUNDLE_INFO_PLIST), "utf8"),
      "CFBundleShortVersionString",
    );
  } catch {
    return null;
  }
}

/** 通れば null、落ちたら理由 */
export async function verifyUpdate(
  app: string,
  o: VerifyOptions,
): Promise<UpdateDownloadError | null> {
  const run = o.run ?? runCommand;
  const sig = await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
  if (sig.code !== 0) return "signature";
  if (!o.selfApp) return "team_id";
  const [mine, theirs] = await Promise.all([codesignInfo(o.selfApp, run), codesignInfo(app, run)]);
  if (!mine.teamId || !theirs.teamId || mine.teamId !== theirs.teamId) return "team_id";
  const v = bundleShortVersion(app);
  if (v !== o.expectedVersion || (compareVersions(v, o.currentVersion) ?? 0) <= 0) return "version";
  const gk = await run(["/usr/sbin/spctl", "--assess", "--type", "execute", app]);
  if (gk.code !== 0) return "notarization";
  return null;
}
