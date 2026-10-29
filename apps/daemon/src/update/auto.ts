/**
 * アプリ内の自動更新の流れ（ADR 0008 の追記 4、onboarding.md 2.5）。更新確認（checker.ts）の上に載せる。
 * 1. 確認で新しい版があり、設定 update.download（既定オン）がオンで、配布版（install.json の mode が app）なら、背景で zip を
 *    取得する（downloader.ts）→ 検証する（verify.ts）→ ready
 * 2. ready で `POST /api/update/install`（ボードの `Restart to update`・メニューバーの項目）→ 置き換え（install.ts）→ SSE update
 *    に installed を流す。アプリはこれを受けて自分を開き直し、デーモンはバンドルの変化で終わって launchd が新しい版で起こす
 * 3. 押されないとき: デスクトップアプリが切れ、しばらく（既定 60 秒）つながらず、アプリのプロセスも無ければ、ready の更新を
 *    そのまま入れる（UI が動いていない間。次に開くと新しい版）。このときはアプリを起こし直さない
 * 4. 失敗は状態とログ（update.download_failed・update.install_failed）に残し、次の確認でやり直す。同じ版で 3 回失敗したら
 *    その版は手動の案内だけにする
 * どれか 1 つの検証に落ちたら何も入れない。置き換えの途中で失敗したら前のものを戻す
 */

import { existsSync } from "node:fs";
import { type MetaOnlyLogger, meta } from "@turnlane/collectors";
import {
  type Clock,
  downloadOnStart,
  idleDownload,
  type LatestRelease,
  nextDownload,
  shouldStartDownload,
  type UpdateDownload,
  type UpdateDownloadError,
  type UpdateDownloadEvent,
} from "@turnlane/core";
import { OpError } from "../derive/ops.ts";
import { runCommand } from "../install/bundle.ts";
import { type DownloadResult, downloadUpdate, removeUpdates } from "./downloader.ts";
import { installUpdate } from "./install.ts";
import { verifyUpdate } from "./verify.ts";

export type InstallReason = "user" | "app_quit";

export interface AutoUpdaterOptions {
  dataDir: string;
  /** 今の版 */
  version: string;
  clock: Clock;
  logger: MetaOnlyLogger;
  /** 取得してよいか（設定 update.check と update.download がオン） */
  enabled: () => boolean;
  /** 配置先（mode が app のときの appPath）。null なら何もしない（開発時の配置・テスト） */
  appPath: () => string | null;
  /** 確認の結果（latest） */
  latest: () => LatestRelease | null;
  load: () => UpdateDownload | null;
  save: (d: UpdateDownload) => void;
  /** 状態が変わったとき（SSE update。段階と版だけ。場所は載せない）。入れ終わったときは installed */
  publish: (data: {
    download: UpdateDownload["state"];
    version: string | null;
    installed?: true;
  }) => void;
  /** 確認先をループバックに差し替えたときの確認先のオリジン（開発・確かめ） */
  loopbackOrigin?: string | null;
  download?: (latest: LatestRelease) => Promise<DownloadResult>;
  verify?: (app: string, latest: LatestRelease) => Promise<UpdateDownloadError | null>;
  install?: (src: string, dst: string) => Promise<UpdateDownloadError | null>;
  /** 入れ終わった後（デーモンを終えて新しい版で起こし直す。user ならアプリも起こし直す印を書く） */
  afterInstall?: (reason: InstallReason) => void;
  /** デスクトップアプリがつながっているか */
  desktopConnected: () => boolean;
  /** アプリのプロセスが動いているか（既定は pgrep） */
  appRunning?: (appPath: string) => Promise<boolean>;
  /** アプリが切れてから入れるまでの待ち（既定 60 秒。つなぎ直し・スリープの復帰を待つ） */
  idleGraceMs?: number;
}

export async function appProcessRunning(appPath: string): Promise<boolean> {
  const r = await runCommand(["/usr/bin/pgrep", "-f", `${appPath}/Contents/MacOS/turnlane`]);
  // 1 は見つからない。それ以外の失敗は動いているとみなす（入れない側に倒す）
  return r.code !== 1;
}

export class AutoUpdater {
  readonly #o: AutoUpdaterOptions;
  #running: Promise<void> | null = null;
  #installing: Promise<UpdateDownload> | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(o: AutoUpdaterOptions) {
    this.#o = o;
  }

  #now(): number {
    return this.#o.clock.now();
  }

  status(): UpdateDownload {
    return this.#o.load() ?? idleDownload(0);
  }

  #set(ev: UpdateDownloadEvent, extra: { installed?: true } = {}): UpdateDownload {
    const d = nextDownload(this.#o.load(), ev, this.#now());
    this.#o.save(d);
    this.#o.publish({ download: d.state, version: d.version, ...extra });
    return d;
  }

  #enabled(): boolean {
    try {
      return this.#o.enabled() && this.#o.appPath() !== null;
    } catch {
      return false;
    }
  }

  /** 起動時: 保存した状態を読み直し（途中で終わったもの・済んだもの）、続きがあれば始める */
  start(): void {
    const prev = this.#o.load();
    const d = downloadOnStart(prev, this.#o.version, this.#now(), existsSync);
    // 保存した状態が無ければ書かない（確認の前に update.state を作らない）
    if (prev !== null && d !== prev) this.#o.save(d);
    // 済んだ・古い版のフォルダを消す（ready の版だけ残す）
    if (d.state !== "ready") {
      try {
        removeUpdates(this.#o.dataDir);
      } catch {}
    }
    if (d.state === "ready") this.#scheduleIdleInstall();
    else void this.maybeStart("start");
  }

  stop(): void {
    this.#stopped = true;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  /** 確認の後（checker の onChecked） */
  onChecked(): void {
    void this.maybeStart("check");
  }

  /** 取得を始めるべきなら始める（終わるまで待てる） */
  maybeStart(trigger: "check" | "start"): Promise<void> {
    if (this.#running) return this.#running;
    if (!this.#enabled()) return Promise.resolve();
    const latest = this.#o.latest();
    if (!latest || !shouldStartDownload(this.#o.load(), latest.version, this.#o.version, trigger))
      return Promise.resolve();
    this.#running = this.#run(latest).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #run(latest: LatestRelease): Promise<void> {
    const { logger } = this.#o;
    this.#set({ type: "start", version: latest.version });
    logger.info("update.download_started", { version: meta(latest.version) });
    const fail = (error: UpdateDownloadError) => {
      try {
        removeUpdates(this.#o.dataDir, latest.version);
      } catch {}
      const d = this.#set({ type: "failed", error });
      logger.warn("update.download_failed", {
        version: meta(latest.version),
        error: meta(error),
        attempts: d.attempts,
      });
    };
    let r: DownloadResult;
    try {
      r = await (
        this.#o.download ??
        ((l: LatestRelease) =>
          downloadUpdate(l, {
            dataDir: this.#o.dataDir,
            version: this.#o.version,
            loopbackOrigin: this.#o.loopbackOrigin ?? null,
          }))
      )(latest);
    } catch {
      r = { ok: false, error: "io" };
    }
    if (!r.ok) return fail(r.error);
    this.#set({ type: "verifying" });
    let err: UpdateDownloadError | null;
    try {
      err = await (
        this.#o.verify ??
        ((app: string, l: LatestRelease) =>
          verifyUpdate(app, {
            expectedVersion: l.version,
            currentVersion: this.#o.version,
            selfApp: this.#o.appPath(),
          }))
      )(r.app, latest);
    } catch {
      err = "io";
    }
    if (err) return fail(err);
    this.#set({ type: "ready", path: r.app });
    logger.info("update.download_ready", { version: meta(latest.version) });
    this.#scheduleIdleInstall();
  }

  /**
   * POST /api/update/install（user）と、アプリが動いていない間の自動（app_quit）。ready 以外は 409 update_not_ready。
   * 失敗は failed（理由）にして返す
   */
  install(reason: InstallReason): Promise<UpdateDownload> {
    if (this.#installing) return this.#installing;
    const d = this.#o.load();
    const appPath = this.#o.appPath();
    if (d?.state !== "ready" || !d.path || !appPath) throw new OpError(409, "update_not_ready");
    const src = d.path;
    this.#installing = this.#install(reason, src, appPath, d.version ?? "").finally(() => {
      this.#installing = null;
    });
    return this.#installing;
  }

  async #install(
    reason: InstallReason,
    src: string,
    appPath: string,
    version: string,
  ): Promise<UpdateDownload> {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.#set({ type: "installing" });
    let err: UpdateDownloadError | null;
    try {
      err = await (this.#o.install ?? installUpdate)(src, appPath);
    } catch {
      err = "io";
    }
    if (err) {
      try {
        removeUpdates(this.#o.dataDir, version);
      } catch {}
      const d = this.#set({ type: "failed", error: err });
      this.#o.logger.warn("update.install_failed", {
        version: meta(version),
        error: meta(err),
        reason: meta(reason),
        attempts: d.attempts,
      });
      return d;
    }
    const d = this.#set({ type: "installed" }, { installed: true });
    this.#o.logger.info("update.installed", { version: meta(version), reason: meta(reason) });
    // 前の版のバンドル（.Turnlane.app.old）は残す。新しい版のデーモンが起動の後に消す
    this.#o.logger.info("install.old_bundle_deferred", { reason: meta("update") });
    try {
      removeUpdates(this.#o.dataDir);
    } catch {}
    this.#o.afterInstall?.(reason);
    return d;
  }

  /** デスクトップアプリの購読が全部切れたとき（SseHub の onDesktopGone） */
  onDesktopGone(): void {
    this.#scheduleIdleInstall();
  }

  /** ready なら、待ちの後にアプリが動いていなければ入れる */
  #scheduleIdleInstall(): void {
    if (this.#stopped || this.#o.load()?.state !== "ready") return;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      void this.installIfIdle();
    }, this.#o.idleGraceMs ?? 60_000);
  }

  /** アプリがつながっておらず、プロセスも無ければ ready の更新を入れる。入れたら true */
  async installIfIdle(): Promise<boolean> {
    if (this.#stopped || !this.#enabled()) return false;
    const d = this.#o.load();
    const appPath = this.#o.appPath();
    if (d?.state !== "ready" || !appPath || this.#o.desktopConnected()) return false;
    const running = await (this.#o.appRunning ?? appProcessRunning)(appPath).catch(() => true);
    if (running || this.#o.desktopConnected() || this.#o.load()?.state !== "ready") return false;
    const r = await this.install("app_quit");
    return r.state === "installed";
  }
}
