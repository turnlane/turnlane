/**
 * 更新の後のアプリの起こし直し（onboarding.md 2.5 の 1 行目、M6-17）。
 * `brew upgrade --cask turnlane` は旧版の uninstall でアプリを終了（quit）してから .app を置き換える。デーモンはバンドルの版の
 * 変化に気づいて終わり、launchd が新しい版で起こす。アプリ（KeepAlive なし）は終わったままなので、
 * - 古いデーモンが終わるとき、デスクトップアプリがつながっていた（または直前までつながっていた）なら `<データ>/relaunch-desktop`
 *   に印（書いた時刻）を残す
 * - 新しいデーモンが起動したとき、印があれば消し、10 分以内のものなら `open -g -b dev.turnlane.desktop --args --background` で
 *   アプリを背景で起こす（ウインドウは開かない。メニューバーだけ）。古い印では起こさない
 * 配布版（install.json の mode が app）だけ。open の失敗はログに残して続ける
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 印のファイル（データディレクトリ） */
export const RELAUNCH_MARK_FILE = "relaunch-desktop";
/** 印が有効な長さ（これより古い印では起こさない） */
export const RELAUNCH_MARK_MAX_AGE_MS = 10 * 60_000;
/** 「直前までつながっていた」とみなす長さ（cask の uninstall の quit から置き換えまで） */
export const DESKTOP_RECENT_MS = 5 * 60_000;
/** 時計のずれの許し（未来の時刻の印は壊れているとみなす） */
const FUTURE_SLACK_MS = 60_000;

const DESKTOP_BUNDLE_ID = "dev.turnlane.desktop";

export function relaunchMarkPath(dataDir: string): string {
  return join(dataDir, RELAUNCH_MARK_FILE);
}

/** 印を書く（600） */
export function writeRelaunchMark(dataDir: string, at: number): void {
  writeFileSync(relaunchMarkPath(dataDir), `${JSON.stringify({ at })}\n`, { mode: 0o600 });
}

/**
 * 印を読んで消す。fresh は 10 分以内（起こす）、stale は古い・壊れた・未来の時刻（起こさない）、none は印が無い
 */
export function takeRelaunchMark(dataDir: string, now: number): "fresh" | "stale" | "none" {
  const p = relaunchMarkPath(dataDir);
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return "none";
  }
  rmSync(p, { force: true });
  let at: unknown;
  try {
    at = (JSON.parse(text) as { at?: unknown }).at;
  } catch {
    return "stale";
  }
  if (typeof at !== "number" || !Number.isFinite(at)) return "stale";
  if (at > now + FUTURE_SLACK_MS) return "stale";
  return now - at <= RELAUNCH_MARK_MAX_AGE_MS ? "fresh" : "stale";
}

/** アプリを背景で起こす（`open -g -b dev.turnlane.desktop --args --background`）。成功なら true */
export async function openDesktopInBackground(): Promise<boolean> {
  try {
    const p = Bun.spawn(
      ["/usr/bin/open", "-g", "-b", DESKTOP_BUNDLE_ID, "--args", "--background"],
      {
        stdout: "ignore",
        stderr: "ignore",
        env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "" },
      },
    );
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}
