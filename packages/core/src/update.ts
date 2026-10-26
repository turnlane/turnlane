/**
 * 更新確認（ADR 0008 の追記 2、phase0-plan M6-12、D-014）の純粋な部分。
 * - 確認先は GitHub Releases の最新リリースに添付した静的ファイル `latest.json`（`releases/latest/download/latest.json`）だけ。
 *   作者のホスト・独自 API・`api.github.com` は使わない
 * - 送るのは HTTP の GET だけ（User-Agent は `turnlane/<version>`。Cookie・識別子・利用状況は付けない）
 * - 設定 `update.check`（既定オン）でオフにでき、オフなら接続のコードを通らない
 */
import { LATEST_JSON_URL } from "./release-config.ts";

/**
 * 確認先（ビルドに組み込む）。最新リリースに添付した `latest.json`（release-config.ts の LATEST_JSON_URL）。
 * 拡張を組み込んだビルドと開発時の配置では確認しない（updateBuildOff）
 */
export const UPDATE_FEED_URL: string | null = LATEST_JSON_URL;

/** 確認の間隔（1日1回） */
export const UPDATE_CHECK_INTERVAL_MS = 86_400_000;

/** 開発・テスト用に確認先を差し替える環境変数。ループバック（127.0.0.1・localhost）の http だけ受け付ける */
export const UPDATE_FEED_ENV = "TURNLANE_UPDATE_FEED_URL";

/** 環境変数の差し替えを受け付けるか（ループバックの http(s) だけ） */
export function isLoopbackFeed(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

/** 確認先を決める（環境変数はループバックだけ。それ以外はビルドの値） */
export function resolveUpdateFeed(
  vars: Record<string, string | undefined>,
  built: string | null = UPDATE_FEED_URL,
): string | null {
  const v = vars[UPDATE_FEED_ENV];
  if (v && isLoopbackFeed(v)) return v;
  return built;
}

/** 環境変数のループバックの確認先に差し替えているか（スモーク・開発の確かめ） */
export function isUpdateFeedOverridden(vars: Record<string, string | undefined>): boolean {
  const v = vars[UPDATE_FEED_ENV];
  return !!v && isLoopbackFeed(v);
}

/**
 * 更新確認がオフの理由。setting は設定 update.check、custom_build は拡張を組み込んだビルド、dev_install は開発時の配置
 * （install.json の mode が dev）。後の 2 つは公開版を勧めないため（公開の配布物は本体だけ）
 */
export type UpdateOffReason = "setting" | "custom_build" | "dev_install";

/**
 * ビルドと配置で決まる「確認しない」理由（設定より先に見る。起動時に 1 回決まる）。
 * - 拡張を組み込んだビルド → custom_build
 * - 開発時の配置（mode が dev）→ dev_install。mode が null（配置を渡さない起動。テスト）は対象外
 * - 確認先を環境変数のループバックに差し替えたとき（スモーク）はどちらも見ない
 */
export function updateBuildOff(o: {
  extensions: number;
  mode: "app" | "dev" | null;
  feedOverridden: boolean;
}): Exclude<UpdateOffReason, "setting"> | null {
  if (o.feedOverridden) return null;
  if (o.extensions > 0) return "custom_build";
  if (o.mode === "dev") return "dev_install";
  return null;
}

export interface LatestRelease {
  version: string;
  /** ダウンロードの URL（GitHub の https か、確認先と同じオリジン） */
  url: string;
  sha256: string | null;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** SemVer の比較（a > b なら正）。読めなければ null */
export function compareVersions(a: string, b: string): number | null {
  const x = SEMVER_RE.exec(a.replace(/^v/, ""));
  const y = SEMVER_RE.exec(b.replace(/^v/, ""));
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d;
  }
  const px = x[4];
  const py = y[4];
  if (px === py) return 0;
  // プレリリースは正式版より前
  if (px === undefined) return 1;
  if (py === undefined) return -1;
  const ax = px.split(".");
  const ay = py.split(".");
  for (let i = 0; i < Math.max(ax.length, ay.length); i++) {
    const p = ax[i];
    const q = ay[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const np = /^\d+$/.test(p) ? Number(p) : null;
    const nq = /^\d+$/.test(q) ? Number(q) : null;
    if (np !== null && nq !== null && np !== nq) return np - nq;
    if (np !== null && nq === null) return -1;
    if (np === null && nq !== null) return 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * `latest.json` を検証する。`{ version, url, sha256 }`。url は GitHub（https://github.com/）か確認先と同じオリジンだけ
 * （画面に出すリンクを確認先の外に向けない）。読めなければ null
 */
export function parseLatest(v: unknown, feedUrl: string): LatestRelease | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.version !== "string" || !SEMVER_RE.test(o.version.replace(/^v/, ""))) return null;
  if (typeof o.url !== "string" || o.url.length > 2048) return null;
  let url: URL;
  let feed: URL;
  try {
    url = new URL(o.url);
    feed = new URL(feedUrl);
  } catch {
    return null;
  }
  const github = url.protocol === "https:" && url.hostname === "github.com";
  if (!github && url.origin !== feed.origin) return null;
  const sha256 =
    typeof o.sha256 === "string" && /^[0-9a-f]{64}$/i.test(o.sha256)
      ? o.sha256.toLowerCase()
      : null;
  return { version: o.version.replace(/^v/, ""), url: url.toString(), sha256 };
}
