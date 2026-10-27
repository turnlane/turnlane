/**
 * 更新確認（ADR 0008 の追記 2、phase0-plan M6-12、D-014。onboarding.md 2.5）。
 * - 1日1回、GitHub Releases の最新リリースに添付した静的ファイル `latest.json` を GET する（確認先はビルドの値）
 * - 拡張を組み込んだビルドと開発時の配置（install.json の mode が dev）では確認しない（公開の配布物は本体だけなので、
 *   公開版を勧めない）。理由は status().off に出す
 * - 送るのは HTTP の GET だけ。User-Agent は `turnlane/<version>`。Cookie・端末やユーザーの識別子・利用状況・
 *   クエリ文字列は付けない
 * - 設定 `update.check`（既定オン）が false なら接続のコードを通らない（確認の直前に毎回見る）
 * - 新しい版があれば UI（GET /api/update と SSE `update`。ボードの上部の 1 行とメニューバーの 1 項目）と `turnlane doctor` に
 *   知らせる。配布版で設定 update.download がオンなら、確認の後に自動更新（auto.ts）が同じ GitHub Releases から取得・検証・
 *   置き換えをする（ADR 0008 の追記 4）。オフ・検証に落ちたときは手動の案内（Homebrew 版は brew upgrade --cask、zip の版は
 *   最新リリースのページ。M6-17）
 * - ボードの知らせを閉じた版（dismiss）はこのプロセスの中だけ覚える（次の起動でまた出す。設定に残さない）
 */
import { errorFields, type MetaOnlyLogger, meta } from "@turnlane/collectors";
import {
  type Clock,
  compareVersions,
  HOMEBREW_UPGRADE_COMMAND,
  idleDownload,
  type LatestRelease,
  parseLatest,
  RELEASES_LATEST_PAGE_URL,
  readUpdateDownload,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateDownload,
  type UpdateOffReason,
} from "@turnlane/core";
import type { UpdateStatus } from "@turnlane/core/api";
import { OpError } from "../derive/ops.ts";

/** 最後の確認の結果（設定 update.state。local_only の内部の設定） */
export interface UpdateState {
  checkedAt: number;
  latest: LatestRelease | null;
  error: string | null;
  /** 取得・検証・置き換えの状態（ADR 0008 の追記 4。auto.ts が書く。確認はそのまま残す） */
  download?: UpdateDownload | null;
}

export const UPDATE_STATE_KEY = "update.state";

export function readUpdateState(v: unknown): UpdateState | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.checkedAt !== "number") return null;
  const l = o.latest as Record<string, unknown> | null | undefined;
  const latest =
    l && typeof l.version === "string" && typeof l.url === "string"
      ? {
          version: l.version,
          url: l.url,
          sha256: typeof l.sha256 === "string" ? l.sha256 : null,
        }
      : null;
  return {
    checkedAt: o.checkedAt,
    latest,
    error: typeof o.error === "string" ? o.error : null,
    download: readUpdateDownload(o.download),
  };
}

export interface UpdateCheckerOptions {
  /** 確認先（null なら確認しない） */
  feedUrl: string | null;
  /** 今の版 */
  version: string;
  clock: Clock;
  logger: MetaOnlyLogger;
  /** 設定 update.check（既定オン） */
  enabled: () => boolean;
  load: () => UpdateState | null;
  save: (s: UpdateState) => void;
  /** 結果が変わったとき（SSE update） */
  publish: () => void;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** 確認の間隔（既定 1日） */
  intervalMs?: number;
  /** 間隔が過ぎたかを見る周期（既定 1時間） */
  tickMs?: number;
  /** 起動から最初に見るまで（既定 60秒。起動を遅らせない） */
  firstDelayMs?: number;
  timeoutMs?: number;
  /** 入れ方（M6-17。homebrew なら brew upgrade を案内）。省略時は dev */
  channel?: () => "homebrew" | "download" | "dev";
  /**
   * ビルドと配置で決まる「確認しない」理由（core の updateBuildOff。拡張を組み込んだビルド・開発時の配置）。
   * 値があれば設定に関わらず接続のコードを通らない。省略時は null
   */
  buildOff?: Exclude<UpdateOffReason, "setting"> | null;
  /** 確認が終わったとき（自動更新の取得を始める。auto.ts） */
  onChecked?: () => void;
  /** 設定 update.download（既定オン） */
  downloadEnabled?: () => boolean;
  /** 取得・検証・置き換えの状態（auto.ts）。省略時は idle */
  download?: () => UpdateDownload;
  /** 取得・検証の済んだ更新を入れる（auto.ts の install("user")。ready 以外は 409）。省略時は 409 */
  install?: () => Promise<unknown>;
}

export class UpdateChecker {
  readonly #o: UpdateCheckerOptions;
  #first: ReturnType<typeof setTimeout> | null = null;
  #tick: ReturnType<typeof setInterval> | null = null;
  #inflight: Promise<void> | null = null;
  /** ボードの知らせを閉じた版（次の起動まで） */
  #dismissed: string | null = null;

  constructor(o: UpdateCheckerOptions) {
    this.#o = o;
  }

  get configured(): boolean {
    return this.#o.feedUrl !== null;
  }

  /** 設定 update.check */
  #setting(): boolean {
    try {
      return this.#o.enabled();
    } catch {
      return false;
    }
  }

  /** 確認しない理由（ビルド・配置が先、次に設定）。null なら確認してよい */
  #off(): UpdateOffReason | null {
    return this.#o.buildOff ?? (this.#setting() ? null : "setting");
  }

  #enabled(): boolean {
    return this.#off() === null;
  }

  start(): void {
    if (!this.configured || this.#o.buildOff) return;
    this.#first = setTimeout(() => {
      this.#first = null;
      void this.tick();
    }, this.#o.firstDelayMs ?? 60_000);
    this.#tick = setInterval(() => void this.tick(), this.#o.tickMs ?? 3_600_000);
  }

  stop(): void {
    if (this.#first) clearTimeout(this.#first);
    if (this.#tick) clearInterval(this.#tick);
    this.#first = null;
    this.#tick = null;
  }

  /** 間隔が過ぎていれば確かめる（オフ・確認先なしなら何もしない） */
  async tick(): Promise<void> {
    if (!this.configured || !this.#enabled()) return;
    const s = this.#o.load();
    const interval = this.#o.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
    if (s && this.#o.clock.now() - s.checkedAt < interval) return;
    await this.check();
  }

  /** 今すぐ確かめる（POST /api/update/check）。オフなら 409 */
  async checkNow(): Promise<UpdateStatus> {
    if (!this.configured) throw new OpError(409, "update_not_configured");
    const off = this.#off();
    if (off === "custom_build") throw new OpError(409, "update_check_custom_build");
    if (off === "dev_install") throw new OpError(409, "update_check_dev_install");
    if (off) throw new OpError(409, "update_check_off");
    await this.check();
    return this.status();
  }

  /** 1回確かめる。オフなら接続しない */
  check(): Promise<void> {
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#check().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #check(): Promise<void> {
    const url = this.#o.feedUrl;
    // オフ（update.check=false・拡張を組み込んだビルド・開発時の配置）・確認先なしのときは、ここより先（接続）に進まない
    if (url === null || !this.#enabled()) return;
    const prev = this.#o.load();
    let latest: LatestRelease | null = prev?.latest ?? null;
    let error: string | null = null;
    try {
      const f = this.#o.fetch ?? ((u: string, init: RequestInit) => fetch(u, init));
      const res = await f(url, {
        method: "GET",
        headers: { "user-agent": `turnlane/${this.#o.version}`, accept: "application/json" },
        redirect: "follow",
        credentials: "omit",
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 15_000),
      });
      if (!res.ok) error = `http_${res.status}`;
      else {
        const parsed = parseLatest(await res.json(), url);
        if (parsed) latest = parsed;
        else error = "invalid_latest_json";
      }
    } catch (e) {
      error = (e as Error).name === "TimeoutError" ? "timeout" : "network";
      this.#o.logger.info("update.check_failed", errorFields(e));
    }
    // 取得の状態（download）は確認の結果と一緒に残す（接続の間に変わりうるので読み直す）
    const download = this.#o.load()?.download ?? null;
    const next: UpdateState = {
      ...(download ? { download } : {}),
      checkedAt: this.#o.clock.now(),
      latest,
      error,
    };
    this.#o.save(next);
    const was = prev ? statusOf(prev, this.#o.version) : null;
    const now = statusOf(next, this.#o.version);
    if (
      !was ||
      was.available !== now.available ||
      was.version !== now.version ||
      was.error !== now.error
    )
      this.#o.publish();
    if (now.available)
      this.#o.logger.info("update.available", { version: meta(next.latest?.version ?? "") });
    this.#o.onChecked?.();
  }

  /** POST /api/update/install: 取得・検証の済んだ更新を入れる。ready 以外は 409 update_not_ready */
  async installNow(): Promise<UpdateStatus> {
    if (!this.#o.install) throw new OpError(409, "update_not_ready");
    await this.#o.install();
    return this.status();
  }

  /** ボードの更新の知らせを閉じる（POST /api/update/dismiss）。その版はこのプロセスの間は出さない */
  dismiss(version: string): UpdateStatus {
    if (this.#dismissed !== version) {
      this.#dismissed = version;
      this.#o.publish();
    }
    return this.status();
  }

  status(): UpdateStatus {
    const s = this.#o.load();
    const latest = s?.latest ?? null;
    const channel = this.#o.channel?.() ?? "dev";
    return {
      enabled: this.#setting(),
      configured: this.configured,
      current: this.#o.version,
      latest,
      available: latest !== null && (compareVersions(latest.version, this.#o.version) ?? 0) > 0,
      checkedAt: s?.checkedAt ?? null,
      error: s?.error ?? null,
      channel,
      upgradeCommand: channel === "homebrew" ? HOMEBREW_UPGRADE_COMMAND : null,
      releasesUrl: channel === "download" ? RELEASES_LATEST_PAGE_URL : null,
      dismissed: this.#dismissed,
      off: this.#off(),
      downloadEnabled: (() => {
        try {
          return this.#o.downloadEnabled?.() ?? true;
        } catch {
          return false;
        }
      })(),
      download: this.#o.download?.() ?? idleDownload(0),
    };
  }
}

function statusOf(s: UpdateState, current: string) {
  const v = s.latest?.version ?? null;
  return {
    available: v !== null && (compareVersions(v, current) ?? 0) > 0,
    version: v,
    error: s.error,
  };
}
