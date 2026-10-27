/**
 * 更新の取得（ADR 0008 の追記 4、onboarding.md 2.5）。
 * - 取得先は latest.json の url だけ。GitHub（https://github.com/）以外は拒否し、転送は GitHub の添付の置き場
 *   （`*.githubusercontent.com`）だけ追う。確認先を環境変数のループバックに差し替えたときだけ、同じループバックのオリジンも認める
 * - 送るのは GET だけ。User-Agent は更新確認と同じ `turnlane/<version>`。Cookie・識別子・クエリを足さない
 * - 保存先は `<データ>/updates/<version>/`。始める前に他の版のフォルダを消す。上限 500 MB、時間の上限あり。途中のファイルは消す
 * - sha256 を latest.json の値と照らす（値が無ければ入れない）。展開は `/usr/bin/ditto -x -k`（unzip は署名を壊しうる）。
 *   中身が `Turnlane.app` 1 つだけであること。展開できたら zip は消す
 */
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  downloadUrlAllowed,
  type LatestRelease,
  UPDATE_DOWNLOAD_MAX_BYTES,
  type UpdateDownloadError,
} from "@turnlane/core";

export const UPDATES_DIR = "updates";
export const UPDATE_APP_NAME = "Turnlane.app";

export function updatesDir(dataDir: string): string {
  return join(dataDir, UPDATES_DIR);
}

/** 版のフォルダ（版は SemVer で検証済み。区切り文字を含まない） */
export function updateVersionDir(dataDir: string, version: string): string {
  if (!/^[0-9A-Za-z.+-]+$/.test(version) || version.includes("..")) throw new Error("bad_version");
  return join(updatesDir(dataDir), version);
}

/** 版のフォルダを消す（version を省くと updates ごと） */
export function removeUpdates(dataDir: string, version?: string): void {
  rmSync(version ? updateVersionDir(dataDir, version) : updatesDir(dataDir), {
    recursive: true,
    force: true,
  });
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DownloadOptions {
  dataDir: string;
  /** 今の版（User-Agent） */
  version: string;
  fetch?: FetchLike;
  /** 全体の時間の上限（既定 20 分） */
  timeoutMs?: number;
  maxBytes?: number;
  /** 確認先をループバックに差し替えたときの確認先のオリジン（それ以外は null） */
  loopbackOrigin?: string | null;
  /** 展開（既定は /usr/bin/ditto -x -k）。成功なら true */
  extract?: (zip: string, dest: string) => Promise<boolean>;
}

export type DownloadResult = { ok: true; app: string } | { ok: false; error: UpdateDownloadError };

const MAX_REDIRECTS = 5;

export async function dittoExtract(zip: string, dest: string): Promise<boolean> {
  try {
    const p = Bun.spawn(["/usr/bin/ditto", "-x", "-k", zip, dest], {
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: "/usr/bin:/bin" },
    });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

/** GET して転送を自分で追う（転送先も downloadUrlAllowed で確かめる） */
async function getFollowing(
  url: string,
  o: DownloadOptions,
  signal: AbortSignal,
): Promise<Response | null> {
  const f = o.fetch ?? ((u: string, init: RequestInit) => fetch(u, init));
  const loopbackOrigin = o.loopbackOrigin ?? null;
  let cur = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!downloadUrlAllowed(cur, { redirect: i > 0, loopbackOrigin })) return null;
    const res = await f(cur, {
      method: "GET",
      headers: { "user-agent": `turnlane/${o.version}`, accept: "application/octet-stream" },
      redirect: "manual",
      credentials: "omit",
      signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel();
      if (!loc) return null;
      cur = new URL(loc, cur).toString();
      continue;
    }
    return res;
  }
  return null;
}

/**
 * latest の zip を取得して展開する。成功なら展開した Turnlane.app の場所。失敗なら版のフォルダを消して理由を返す
 */
export async function downloadUpdate(
  latest: LatestRelease,
  o: DownloadOptions,
): Promise<DownloadResult> {
  if (!latest.sha256) return { ok: false, error: "sha256" };
  let dir: string;
  try {
    dir = updateVersionDir(o.dataDir, latest.version);
  } catch {
    return { ok: false, error: "io" };
  }
  const root = updatesDir(o.dataDir);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // 他の版（と同じ版の前の残り）を消す
    for (const name of readdirSync(root))
      rmSync(join(root, name), { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false, error: "io" };
  }
  const fail = (error: UpdateDownloadError): DownloadResult => {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, error };
  };
  const zip = join(dir, `Turnlane-${latest.version}.zip`);
  const part = `${zip}.part`;
  const max = o.maxBytes ?? UPDATE_DOWNLOAD_MAX_BYTES;
  const hasher = new Bun.CryptoHasher("sha256");
  const signal = AbortSignal.timeout(o.timeoutMs ?? 20 * 60_000);
  let fd: number | null = null;
  try {
    const res = await getFollowing(latest.url, o, signal);
    if (!res?.ok || !res.body) {
      await res?.body?.cancel();
      return fail("io");
    }
    const len = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(len) && len > max) {
      await res.body.cancel();
      return fail("io");
    }
    fd = openSync(part, "w", 0o600);
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return fail("io");
      }
      hasher.update(value);
      let off = 0;
      while (off < value.byteLength) off += writeSync(fd, value, off);
    }
    closeSync(fd);
    fd = null;
  } catch {
    return fail("io");
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (hasher.digest("hex") !== latest.sha256.toLowerCase()) return fail("sha256");
  const out = join(dir, "app");
  try {
    renameSync(part, zip);
    mkdirSync(out, { mode: 0o700 });
  } catch {
    return fail("io");
  }
  if (!(await (o.extract ?? dittoExtract)(zip, out))) return fail("io");
  try {
    const names = readdirSync(out);
    if (names.length !== 1 || names[0] !== UPDATE_APP_NAME) return fail("io");
    const st = lstatSync(join(out, UPDATE_APP_NAME));
    if (!st.isDirectory() || st.isSymbolicLink()) return fail("io");
    rmSync(zip, { force: true });
  } catch {
    return fail("io");
  }
  return { ok: true, app: join(out, UPDATE_APP_NAME) };
}
