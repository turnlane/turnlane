/**
 * Ghostty の AppleScript が使えるか（D-244）。答えるの届け先（answer/deliver.ts）と、AI に頼むの tmux の包み
 * （launch/terminal.ts の wrapsInTmux）が見る。
 *
 * - 版は `.app` の Info.plist の CFBundleShortVersionString（plutil）。1.3 より古い Ghostty には AppleScript の口が無い
 * - 設定は同梱の CLI の `ghostty +show-config`（既定と違う設定だけを出す）の `macos-applescript = false` の行だけを見る。
 *   ほかの行は読み捨てる（持たない・ログに出さない）
 *
 * どちらも Apple Event を送らない（自動化の許可のダイアログを出さない）。読めなければ null（判定できない）。
 * 結果は短い間だけ覚える（待ちを開くたびに起動しない）
 */
import type { OpenSystem } from "./system.ts";

/** AppleScript（input text / send key / working directory）が入った版 */
export const GHOSTTY_SCRIPTABLE_SINCE = [1, 3] as const;
const CACHE_MS = 60_000;

/** `1.3.1` `1.3.0-dev+abc` → [1, 3]。読めなければ null */
export function parseGhosttyVersion(s: string | null): [number, number] | null {
  const m = /^\s*(\d+)\.(\d+)/.exec(s ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** `ghostty +show-config` の出力に `macos-applescript = false` があるか（無ければ既定の true） */
export function appleScriptDisabled(showConfig: string): boolean {
  return /^\s*macos-applescript\s*=\s*false\s*$/m.test(showConfig);
}

/** 版と設定 → 使えるか。版が読めなければ null、設定が読めなければ（版が足りていれば）null */
export function ghosttyScriptableFrom(
  version: string | null,
  showConfig: string | null,
): boolean | null {
  const v = parseGhosttyVersion(version);
  if (!v) return null;
  const [major, minor] = GHOSTTY_SCRIPTABLE_SINCE;
  if (v[0] < major || (v[0] === major && v[1] < minor)) return false;
  if (showConfig === null) return null;
  return !appleScriptDisabled(showConfig);
}

const cache = new WeakMap<OpenSystem, Map<string, { at: number; v: boolean | null }>>();

function memo(sys: OpenSystem): Map<string, { at: number; v: boolean | null }> {
  let m = cache.get(sys);
  if (!m) {
    m = new Map();
    cache.set(sys, m);
  }
  return m;
}

/** `.app` のパス（`/Applications/Ghostty.app`）→ AppleScript が使えるか（true / false / 判定できない null） */
export async function ghosttyScriptable(
  sys: OpenSystem,
  appPath: string,
  now: number = Date.now(),
): Promise<boolean | null> {
  const hit = memo(sys).get(appPath);
  if (hit && now - hit.at < CACHE_MS) return hit.v;
  let v: boolean | null = null;
  if (sys.capture) {
    const version = await sys.capture([
      "/usr/bin/plutil",
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      `${appPath}/Contents/Info.plist`,
    ]);
    const config =
      parseGhosttyVersion(version) !== null
        ? await sys.capture([`${appPath}/Contents/MacOS/ghostty`, "+show-config"])
        : null;
    v = ghosttyScriptableFrom(version, config);
  }
  memo(sys).set(appPath, { at: now, v });
  return v;
}

/** 送ってみて AppleScript が応答しなかった（切られている・古い）: しばらく使えないものとして扱う */
export function noteGhosttyUnscriptable(
  sys: OpenSystem,
  appPath: string,
  now: number = Date.now(),
): void {
  memo(sys).set(appPath, { at: now, v: false });
}
