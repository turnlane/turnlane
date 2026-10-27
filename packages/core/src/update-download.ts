/**
 * アプリ内の自動更新（ADR 0008 の追記 4、onboarding.md 2.5）の純粋な部分: 取得・検証・置き換えの状態と遷移、
 * 画面（ボードの 1 行・メニューバーの 1 項目）に出す段階。
 * - 状態は設定 `update.state`（local_only）の download に置く
 * - 同じ版で UPDATE_DOWNLOAD_MAX_ATTEMPTS 回失敗したら、その版は手動の案内だけにする（版が変われば数え直す）
 * - 失敗はやり直しを次の確認（1日1回）に回す。起動のたびにはやり直さない（途中で終わったものだけ起動時に続ける）
 * DB・Bun の API に依存しない（web からも使う）
 */
import { compareVersions } from "./update.ts";

export type UpdateDownloadState =
  | "idle"
  | "downloading"
  | "verifying"
  | "ready"
  | "installing"
  | "installed"
  | "failed";

/**
 * 失敗の理由（短いコード）。sha256 は latest.json の値と違う・値が無い、signature は codesign の検証、team_id は
 * 動いている自分のバンドルと TeamIdentifier が違う・無い、version は Info.plist の版、notarization は spctl、
 * not_writable は配置先に書けない、io は取得・展開・写しの失敗
 */
export type UpdateDownloadError =
  | "sha256"
  | "signature"
  | "team_id"
  | "version"
  | "notarization"
  | "not_writable"
  | "io";

export const UPDATE_DOWNLOAD_ERRORS: readonly UpdateDownloadError[] = [
  "sha256",
  "signature",
  "team_id",
  "version",
  "notarization",
  "not_writable",
  "io",
];

const STATES: readonly UpdateDownloadState[] = [
  "idle",
  "downloading",
  "verifying",
  "ready",
  "installing",
  "installed",
  "failed",
];

export interface UpdateDownload {
  state: UpdateDownloadState;
  /** 対象の版 */
  version: string | null;
  /** 展開済みの Turnlane.app の場所（ready・installing のとき） */
  path: string | null;
  error: UpdateDownloadError | null;
  /** 同じ版の失敗の回数 */
  attempts: number;
  /** 最後の変化 */
  at: number;
}

/** 同じ版でこの回数失敗したら、その版は手動の案内だけにする */
export const UPDATE_DOWNLOAD_MAX_ATTEMPTS = 3;

/** 取得する zip の上限 */
export const UPDATE_DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024;

export function idleDownload(at: number): UpdateDownload {
  return { state: "idle", version: null, path: null, error: null, attempts: 0, at };
}

/** 保存した値を読む（壊れていれば null） */
export function readUpdateDownload(v: unknown): UpdateDownload | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.state !== "string" || !STATES.includes(o.state as UpdateDownloadState)) return null;
  if (typeof o.at !== "number") return null;
  return {
    state: o.state as UpdateDownloadState,
    version: typeof o.version === "string" ? o.version : null,
    path: typeof o.path === "string" ? o.path : null,
    error:
      typeof o.error === "string" && UPDATE_DOWNLOAD_ERRORS.includes(o.error as UpdateDownloadError)
        ? (o.error as UpdateDownloadError)
        : null,
    attempts:
      typeof o.attempts === "number" && Number.isInteger(o.attempts) && o.attempts >= 0
        ? o.attempts
        : 0,
    at: o.at,
  };
}

export type UpdateDownloadEvent =
  | { type: "start"; version: string }
  | { type: "verifying" }
  | { type: "ready"; path: string }
  | { type: "installing" }
  | { type: "installed" }
  | { type: "failed"; error: UpdateDownloadError };

/**
 * 遷移。start は版が変わったら失敗の回数を 0 に戻す（同じ版なら残す）。failed は回数を 1 増やし、場所を消す。
 * ほかは版と回数を保つ
 */
export function nextDownload(
  prev: UpdateDownload | null,
  ev: UpdateDownloadEvent,
  now: number,
): UpdateDownload {
  const p = prev ?? idleDownload(now);
  switch (ev.type) {
    case "start":
      return {
        state: "downloading",
        version: ev.version,
        path: null,
        error: null,
        attempts: p.version === ev.version ? p.attempts : 0,
        at: now,
      };
    case "verifying":
      return { ...p, state: "verifying", error: null, at: now };
    case "ready":
      return { ...p, state: "ready", path: ev.path, error: null, at: now };
    case "installing":
      return { ...p, state: "installing", error: null, at: now };
    case "installed":
      return { ...p, state: "installed", path: null, error: null, at: now };
    case "failed":
      return {
        ...p,
        state: "failed",
        path: null,
        error: ev.error,
        attempts: p.attempts + 1,
        at: now,
      };
  }
}

/** この版で手動の案内だけにするか（同じ版で上限の回数だけ失敗した） */
export function downloadGaveUp(d: UpdateDownload | null, version: string): boolean {
  return (
    !!d &&
    d.version === version &&
    d.state === "failed" &&
    d.attempts >= UPDATE_DOWNLOAD_MAX_ATTEMPTS
  );
}

/**
 * 取得を始めるか。trigger は check（1日1回の確認の後）か start（起動時。途中で終わったものだけ続ける）。
 * - latest が今より新しくなければ始めない
 * - 版が変わった（前の状態が別の版・無い）なら始める
 * - 同じ版: idle（途中で終わった）なら始める。failed は check のときだけ、上限の回数まで。ready 以降・取得中は始めない
 */
export function shouldStartDownload(
  d: UpdateDownload | null,
  latest: string,
  current: string,
  trigger: "check" | "start",
): boolean {
  if ((compareVersions(latest, current) ?? 0) <= 0) return false;
  if (!d || d.version !== latest) return true;
  switch (d.state) {
    case "idle":
      return true;
    case "failed":
      return trigger === "check" && d.attempts < UPDATE_DOWNLOAD_MAX_ATTEMPTS;
    default:
      return false;
  }
}

/**
 * 起動時に保存した状態を読み直す。
 * - 対象の版が今の版以下（入れ替えが済んだ・古い）なら idle に戻す
 * - 取得・検証・入れ替えの途中で終わった（前のプロセスが終わった）なら、同じ版の idle（回数は保つ。起動時に続ける）
 * - ready で展開済みの場所が無ければ idle
 */
export function downloadOnStart(
  d: UpdateDownload | null,
  current: string,
  now: number,
  exists: (path: string) => boolean,
): UpdateDownload {
  if (!d || d.version === null) return idleDownload(now);
  if ((compareVersions(d.version, current) ?? 0) <= 0) return idleDownload(now);
  if (d.state === "downloading" || d.state === "verifying" || d.state === "installing")
    return { ...d, state: "idle", path: null, error: null, at: now };
  if (d.state === "ready" && (d.path === null || !exists(d.path)))
    return { ...d, state: "idle", path: null, error: null, at: now };
  return d;
}

/**
 * 画面に出す段階（ボードの 1 行とメニューバーの 1 項目）。新しい版が無いときは null。
 * - manual: 手動の案内（Homebrew はコマンドのコピー、zip はリリースのページ）。update.download がオフ・自動の対象外・
 *   まだ始めていない・上限まで失敗したとき
 * - downloading: 取得・検証の途中（`… · Downloading…`。ボタンなし）
 * - ready: 入れる用意ができた（`Restart to update`）
 * - installing: 入れている・入れ終わった（ボタンを押せない）
 * - failed: 検証に落ちた（verify）か、置き換えられなかった（install）。手動の案内を添える
 */
export type UpdatePhase =
  | { kind: "manual"; version: string }
  | { kind: "downloading"; version: string }
  | { kind: "ready"; version: string }
  | { kind: "installing"; version: string }
  | { kind: "failed"; version: string; reason: "verify" | "install" };

export function updatePhase(s: {
  available: boolean;
  latest: { version: string } | null;
  downloadEnabled?: boolean;
  download?: UpdateDownload | null;
}): UpdatePhase | null {
  if (!s.available || !s.latest) return null;
  const version = s.latest.version;
  const d = s.download;
  if (s.downloadEnabled === false || !d || d.version !== version)
    return { kind: "manual", version };
  switch (d.state) {
    case "downloading":
    case "verifying":
      return { kind: "downloading", version };
    case "ready":
      return { kind: "ready", version };
    case "installing":
    case "installed":
      return { kind: "installing", version };
    case "failed":
      return {
        kind: "failed",
        version,
        reason: d.error === "not_writable" ? "install" : "verify",
      };
    default:
      return { kind: "manual", version };
  }
}

/**
 * 取得してよい URL か。最初の URL は GitHub（https://github.com/）だけ。GitHub の転送先（リリースの添付は
 * `*.githubusercontent.com` に転送される）は redirect のときだけ認める。loopbackOrigin は確認先を環境変数のループバックに
 * 差し替えたとき（開発・確かめ。TURNLANE_UPDATE_FEED_URL）の確認先のオリジンで、それと同じループバックのオリジンだけを足す
 */
export function downloadUrlAllowed(
  url: string,
  o: { redirect: boolean; loopbackOrigin: string | null },
): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (o.loopbackOrigin !== null && u.origin === o.loopbackOrigin) {
    const h = u.hostname;
    return (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK.has(h);
  }
  if (u.protocol !== "https:" || u.port !== "") return false;
  if (u.hostname === "github.com") return true;
  return o.redirect && u.hostname.endsWith(".githubusercontent.com");
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
