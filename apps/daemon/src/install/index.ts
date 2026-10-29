/**
 * 配置の方式（ADR 0011 の決定 4・5・7、onboarding.md 2.2・2.4・2.5、phase0-plan M6-15・M6-17）のデーモン側。
 * - 起動時に install.json（データディレクトリ、600）へ方式・アプリの場所・版を書く
 * - app のとき、hooks と MCP に書く固定の場所 `<データ>/bin/turnlane` を、アプリの中の turnlane へのリンクに合わせる
 *   （アプリを動かしても・更新しても hooks の command と Codex の承認の hash が変わらない）
 * - app のとき、自分の入っているバンドルの Info.plist の版を 1 分ごとに確かめ、起動時と違えば正常終了する（launchd の
 *   KeepAlive が新しいバイナリで起こし直す）
 * - app のとき、同じ監視でカレンダーヘルパの版も見る。接続しているヘルパの版が同梱のヘルパの版と違えば（アプリを更新した後、
 *   古いヘルパが動いたまま）、アプリの `--setup reregister calendarHelper` で登録をし直す（解除で launchd が古いほうを止め、
 *   登録で新しいバンドルの plist から起こす。SMAppService を呼べるのはアプリのプロセスだけ。onboarding.md 2.5）。
 *   同じ組み合わせ（動いている版 → 同梱の版）では1回だけ試す
 * - app のとき、更新で終わる前にデスクトップアプリがつながっていれば印を残し、新しい版の起動でアプリを背景で起こす
 *   （relaunch.ts。onboarding.md 2.5）
 * - `turnlane` を PATH に置く（`~/.local/bin/turnlane` のリンク。O8 の Install ▸、設定 › 一般）。Homebrew 版では要らない
 * - app のとき、入れ替えで残した前の版のバンドル（`.Turnlane.app.old`。自動更新は古い版のプロセスが終わる途中なので消さない）を、
 *   起こし直しが終わってから消す: デスクトップアプリがつながったか一定の時間（既定 60 秒）が過ぎ、かつ古い版のカレンダー
 *   ヘルパが動いていない（つながっているヘルパの版が同梱の版と同じか、つながっていない）とき。10 分待っても古いヘルパが
 *   残るなら消さない（次の入れ替えが片付ける）。ログは install.old_bundle_removed / install.old_bundle_deferred
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { MetaOnlyLogger } from "@turnlane/collectors";
import { errorFields, meta } from "@turnlane/collectors";
import {
  BUNDLE_BUILD_KEY,
  BUNDLE_INFO_PLIST,
  BUNDLE_LOGIN_ITEMS,
  bundledBinary,
  bundledCliLinkPath,
  type InstallMode,
  type InstallStatus,
  installStatus,
  linkTarget,
  readInstallInfo,
  writeInstallInfo,
} from "@turnlane/core";
import { sideNames } from "./bundle.ts";
import { DESKTOP_RECENT_MS, takeRelaunchMark, writeRelaunchMark } from "./relaunch.ts";

export interface InstallOptions {
  mode: InstallMode;
  /** `Turnlane.app` の絶対パス（app のときだけ） */
  appPath: string | null;
}

/** link を target へのシンボリックリンクにする（既にそうなら何もしない）。一時名に作ってから rename で置き換える */
export function ensureSymlink(link: string, target: string): "created" | "updated" | "unchanged" {
  const cur = linkTarget(link);
  if (cur === target) return "unchanged";
  let existed = false;
  try {
    lstatSync(link);
    existed = true;
  } catch {}
  if (existed && cur === null) throw new Error("not_a_symlink");
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
  const tmp = `${link}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
  return existed ? "updated" : "created";
}

/** Info.plist（XML）から 1 つの文字列の値を読む（plutil を起こさない） */
export function plistString(xml: string, key: string): string | null {
  const re = new RegExp(
    `<key>${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</key>\\s*<string>([^<]*)</string>`,
  );
  return re.exec(xml)?.[1] ?? null;
}

/** バンドルのビルドの識別（Info.plist の TurnlaneBuild。無ければ CFBundleShortVersionString） */
export function bundleBuild(appPath: string): string | null {
  try {
    const xml = readFileSync(join(appPath, BUNDLE_INFO_PLIST), "utf8");
    return plistString(xml, BUNDLE_BUILD_KEY) ?? plistString(xml, "CFBundleShortVersionString");
  } catch {
    return null;
  }
}

/** 同梱のカレンダーヘルパ（`Contents/Library/LoginItems/TurnlaneCalendarHelper.app`） */
export const BUNDLED_HELPER_APP = "TurnlaneCalendarHelper.app";

/** 同梱のカレンダーヘルパの版（ヘルパが status で返すのと同じ CFBundleShortVersionString） */
export function bundledHelperVersion(appPath: string): string | null {
  try {
    const xml = readFileSync(
      join(appPath, BUNDLE_LOGIN_ITEMS, BUNDLED_HELPER_APP, BUNDLE_INFO_PLIST),
      "utf8",
    );
    return plistString(xml, "CFBundleShortVersionString");
  } catch {
    return null;
  }
}

/** アプリの `--setup <args>` を実行する（アプリの実行ファイルが SMAppService を呼ぶ。Tauri は起こさない） */
export async function runAppSetup(appPath: string, args: readonly string[]): Promise<boolean> {
  try {
    const p = Bun.spawn([join(appPath, "Contents", "MacOS", "turnlane"), "--setup", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "" },
    });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return false;
    return (JSON.parse(out) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

export interface InstallServiceOptions extends InstallOptions {
  dataDir: string;
  home: string;
  version: string;
  logger: MetaOnlyLogger;
  now: () => number;
  pathVar: string | undefined;
  homebrewCandidates?: readonly string[];
  /** 版の確認（既定は bundleBuild）と、違ったときの終了（既定は process.exit(0)） */
  readBuild?: (appPath: string) => string | null;
  exit?: () => void;
  watchMs?: number;
  /** 接続しているカレンダーヘルパの版（未接続なら null）。ヘルパの版の入れ替えに使う */
  helperVersion?: () => string | null;
  /** 同梱のヘルパの版の読み取り（既定は bundledHelperVersion）と、登録のし直し（既定は runAppSetup） */
  readHelperVersion?: (appPath: string) => string | null;
  reregisterHelper?: (appPath: string) => Promise<boolean>;
  /**
   * デスクトップアプリがつながっている、または直前（引数の ms 以内）までつながっていたか（更新の後の起こし直し。M6-17）。
   * 省略時は印を残さない
   */
  desktopSeenWithin?: (ms: number) => boolean;
  /** アプリを背景で起こす（既定なし: 起こさない。bin.ts が openDesktopInBackground を渡す。テストが実行環境のアプリを開かないように） */
  openDesktop?: () => Promise<boolean>;
  /** デスクトップアプリが今つながっているか（前の版のバンドルを消す合図。省略時は時間だけで決める） */
  desktopConnected?: () => boolean;
  /** 前の版のバンドル（.Turnlane.app.old）の確かめと削除（テストで差し替える） */
  oldBundle?: { exists: (path: string) => boolean; remove: (path: string) => void };
  /** 前の版のバンドルを消すまでの待ち（既定 60 秒）・見る間隔（既定 2 秒）・あきらめるまで（既定 10 分） */
  oldBundleWaitMs?: number;
  oldBundlePollMs?: number;
  oldBundleMaxMs?: number;
  /**
   * 起こし直しの印があるとき、アプリが自分で開き直してつながるのを待つ長さ（既定 5 秒。desktopConnected があるときだけ待つ）。
   * その間につながれば `open` しない（開き直したばかりのアプリに `open` が届くと Reopen が重なる）
   */
  relaunchWaitMs?: number;
  /** 待ちの予約（テストで差し替える。既定は setTimeout）。取り消す関数を返す */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export class InstallService {
  readonly #o: InstallServiceOptions;
  #timer: ReturnType<typeof setInterval> | null = null;
  /** 起動時のバンドルのビルド（版の監視の基準） */
  #started: string | null = null;
  /** 自動更新でアプリが動いていない間に入れた（終わるときにアプリを起こし直す印を書かない） */
  #noRelaunch = false;
  #replacedTimer: ReturnType<typeof setTimeout> | null = null;
  #oldTimer: (() => void) | null = null;
  /** 登録をし直した組み合わせ（`<動いている版>→<同梱の版>`）。同じ組み合わせでは繰り返さない */
  readonly #helperTried = new Set<string>();

  constructor(o: InstallServiceOptions) {
    this.#o = o;
  }

  #schedule(fn: () => void, ms: number): () => void {
    if (this.#o.schedule) return this.#o.schedule(fn, ms);
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  }

  get mode(): InstallMode {
    return this.#o.mode;
  }

  get appPath(): string | null {
    return this.#o.appPath;
  }

  /** hooks・MCP に書く turnlane（app なら固定の場所。dev なら null で、今までどおり） */
  get hooksCli(): string | null {
    return this.#o.mode === "app" ? bundledCliLinkPath(this.#o.dataDir) : null;
  }

  /** 起動時: install.json を書き、app なら固定の場所のリンクを合わせ、版の監視を始める */
  start(): void {
    const { mode, appPath, dataDir, logger } = this.#o;
    try {
      writeInstallInfo(dataDir, {
        mode,
        appPath,
        version: this.#o.version,
        writtenAt: this.#o.now(),
      });
    } catch (e) {
      logger.warn("install.write_failed", errorFields(e));
    }
    if (mode !== "app" || !appPath) return;
    void this.relaunchDesktop();
    this.cleanupOldBundle();
    try {
      const r = ensureSymlink(bundledCliLinkPath(dataDir), bundledBinary(appPath, "turnlane"));
      if (r !== "unchanged") logger.info("install.cli_link", { result: meta(r) });
    } catch (e) {
      logger.warn("install.cli_link_failed", errorFields(e));
    }
    const read = this.#o.readBuild ?? bundleBuild;
    const started = read(appPath);
    if (started === null) return;
    this.#started = started;
    void this.reregisterOnBuildChange(started);
    this.#timer = setInterval(() => {
      if (!this.checkBundle(started)) void this.checkHelper();
    }, this.#o.watchMs ?? 60_000);
  }

  /**
   * 動いているヘルパの版が同梱の版と違えば、登録をし直して入れ替える（M6-17）。し直したら true。
   * ヘルパが未接続・版が読めない・同じ・一度試した組み合わせなら何もしない
   */
  async checkHelper(): Promise<boolean> {
    const appPath = this.#o.appPath;
    if (this.#o.mode !== "app" || !appPath) return false;
    const running = this.#o.helperVersion?.() ?? null;
    if (!running) return false;
    const bundled = (this.#o.readHelperVersion ?? bundledHelperVersion)(appPath);
    if (!bundled || bundled === running) return false;
    const key = `${running}\0${bundled}`;
    if (this.#helperTried.has(key)) return false;
    this.#helperTried.add(key);
    const ok = await (
      this.#o.reregisterHelper ?? ((a: string) => runAppSetup(a, ["reregister", "calendarHelper"]))
    )(appPath);
    this.#o.logger[ok ? "info" : "warn"]("install.helper_reregistered", {
      running: meta(running),
      bundled: meta(bundled),
      ok,
    });
    return ok;
  }

  /**
   * アプリのビルド（TurnlaneBuild）が前回の起動と違えば、カレンダーヘルパの登録を 1 回し直す。ad-hoc 署名ではビルドのたびに
   * cdhash が変わり、同じ版のまま zip で置き換えると、launchd が登録の時のヘルパを起こせなくなることがある（2026-10-21 の Neo:
   * 置き換えの後、常駐のヘルパがログを書く前に終わるのを launchd が 44 回繰り返した。版が同じなので checkHelper は動かない）。
   * 登録していなければアプリの側で何もしない（reregister は enabled のときだけ）。前回のビルドは `<データ>/helper-build`。
   * 登録をし直すと、動いているヘルパも一度止まって起こし直される（同じビルドの間は起動のたびには行わない）
   */
  async reregisterOnBuildChange(build: string): Promise<boolean> {
    const appPath = this.#o.appPath;
    if (this.#o.mode !== "app" || !appPath) return false;
    const file = join(this.#o.dataDir, "helper-build");
    let prev: string | null = null;
    try {
      prev = readFileSync(file, "utf8").trim() || null;
    } catch {}
    if (prev === build) return false;
    const write = () => {
      try {
        writeFileSync(file, `${build}\n`, { mode: 0o600 });
      } catch (e) {
        this.#o.logger.warn("install.helper_build_write_failed", errorFields(e));
      }
    };
    // 記録が無い（初めての起動・この仕組みの前の版から更新した）ときもし直す。登録していなければアプリが何もしない
    const ok = await (
      this.#o.reregisterHelper ?? ((a: string) => runAppSetup(a, ["reregister", "calendarHelper"]))
    )(appPath);
    this.#o.logger.info("install.helper_reregistered_for_build", { ok });
    write();
    return ok;
  }

  /**
   * 起動時: 前の版のデーモンが残した印（更新で終わる前にアプリがつながっていた）があれば消し、10 分以内のものならアプリを
   * 背景で起こす。起こしたら true。app 以外・印が無い・古い印・起こす口が無いなら何もしない。失敗はログに残して続ける
   */
  async relaunchDesktop(): Promise<boolean> {
    if (this.#o.mode !== "app" || !this.#o.appPath) return false;
    let mark: ReturnType<typeof takeRelaunchMark>;
    try {
      mark = takeRelaunchMark(this.#o.dataDir, this.#o.now());
    } catch (e) {
      this.#o.logger.warn("install.relaunch_mark_failed", errorFields(e));
      return false;
    }
    if (mark === "none") return false;
    if (mark === "stale" || !this.#o.openDesktop) {
      this.#o.logger.info("install.desktop_relaunch_skipped", { reason: meta(mark) });
      return false;
    }
    // 自動更新の Restart to update では、前の版のアプリが自分で開き直す（setup::relaunch）。開き直したアプリが
    // つながるのを少し待ち、つながれば `open` しない（届いた Reopen で開き直したばかりのアプリが落ちていた）
    if (await this.#desktopConnectsWithin(this.#o.relaunchWaitMs ?? 5_000)) {
      this.#o.logger.info("install.desktop_relaunch_skipped", {
        reason: meta("already_connected"),
      });
      return false;
    }
    const ok = await this.#o.openDesktop().catch(() => false);
    this.#o.logger[ok ? "info" : "warn"]("install.desktop_relaunched", { ok });
    return ok;
  }

  /** バンドルの版が起動時と違えば終わる（入れ替えの後。launchd が新しい版で起こす）。違ったら true */
  checkBundle(started: string): boolean {
    const appPath = this.#o.appPath;
    if (!appPath) return false;
    const now = (this.#o.readBuild ?? bundleBuild)(appPath);
    // 入れ替えの途中（読めない）は次の回に見る
    if (now === null || now === started) return false;
    this.#o.logger.info("install.bundle_changed", {});
    // アプリがつながっていた（cask の uninstall が quit したばかり）なら、新しい版のデーモンに起こしてもらう印を残す。
    // 自動更新をアプリが動いていない間に入れたときは残さない（利用者が終えたアプリを起こさない）
    if (
      this.#o.mode === "app" &&
      !this.#noRelaunch &&
      this.#o.desktopSeenWithin?.(DESKTOP_RECENT_MS)
    ) {
      try {
        writeRelaunchMark(this.#o.dataDir, this.#o.now());
        this.#o.logger.info("install.relaunch_mark_written", {});
      } catch (e) {
        this.#o.logger.warn("install.relaunch_mark_failed", errorFields(e));
      }
    }
    this.stop();
    (this.#o.exit ?? (() => process.exit(0)))();
    return true;
  }

  /**
   * 自動更新でバンドルを入れ替えた直後（ADR 0008 の追記 4）。relaunchDesktop なら新しい版のデーモンにアプリを起こして
   * もらう印を書く（Restart to update を押したとき。アプリが自分で開き直していれば二重には開かない）。afterMs の後に
   * バンドルの版を確かめて終わる（SSE の installed を届けてから。launchd が新しい版で起こす）
   */
  bundleReplaced(o: { relaunchDesktop: boolean; afterMs?: number }): void {
    if (this.#o.mode !== "app" || !this.#o.appPath) return;
    if (o.relaunchDesktop) {
      try {
        writeRelaunchMark(this.#o.dataDir, this.#o.now());
        this.#o.logger.info("install.relaunch_mark_written", {});
      } catch (e) {
        this.#o.logger.warn("install.relaunch_mark_failed", errorFields(e));
      }
    } else this.#noRelaunch = true;
    const started = this.#started;
    if (started === null) return;
    if (this.#replacedTimer) clearTimeout(this.#replacedTimer);
    this.#replacedTimer = setTimeout(() => {
      this.#replacedTimer = null;
      this.checkBundle(started);
    }, o.afterMs ?? 2_000);
  }

  /** ms の間にデスクトップアプリがつながるか（desktopConnected が無ければ待たずに false） */
  #desktopConnectsWithin(ms: number): Promise<boolean> {
    const connected = this.#o.desktopConnected;
    if (!connected) return Promise.resolve(false);
    const step = 250;
    return new Promise((resolve) => {
      let waited = 0;
      const tick = () => {
        if (connected()) return resolve(true);
        if (waited >= ms) return resolve(false);
        waited += step;
        this.#schedule(tick, step);
      };
      tick();
    });
  }

  /**
   * 入れ替えで残した前の版のバンドル（.Turnlane.app.old）を、起こし直しが終わってから消す（起動時に呼ぶ）。
   * デスクトップアプリがつながったか oldBundleWaitMs が過ぎ、古い版のカレンダーヘルパが動いていなければ消す。
   * oldBundleMaxMs 待っても古いヘルパが残るなら消さない（次の replaceBundle が片付ける）
   */
  cleanupOldBundle(): void {
    const appPath = this.#o.appPath;
    if (this.#o.mode !== "app" || !appPath) return;
    const old = sideNames(appPath).old;
    const fs = this.#o.oldBundle ?? {
      exists: (p: string) => existsSync(p),
      remove: (p: string) => rmSync(p, { recursive: true, force: true }),
    };
    if (!fs.exists(old)) return;
    const wait = this.#o.oldBundleWaitMs ?? 60_000;
    const poll = this.#o.oldBundlePollMs ?? 2_000;
    const max = this.#o.oldBundleMaxMs ?? 600_000;
    const helperOld = () => {
      const running = this.#o.helperVersion?.() ?? null;
      if (!running) return false;
      const bundled = (this.#o.readHelperVersion ?? bundledHelperVersion)(appPath);
      return !!bundled && bundled !== running;
    };
    let elapsed = 0;
    const tick = () => {
      this.#oldTimer = null;
      const desktop = this.#o.desktopConnected?.() ?? false;
      if ((desktop || elapsed >= wait) && !helperOld()) {
        try {
          fs.remove(old);
          this.#o.logger.info("install.old_bundle_removed", {
            after: meta(desktop ? "desktop_connected" : "timeout"),
          });
        } catch (e) {
          this.#o.logger.warn("install.old_bundle_remove_failed", errorFields(e));
        }
        return;
      }
      if (elapsed >= max) {
        this.#o.logger.info("install.old_bundle_deferred", { reason: meta("old_helper_running") });
        return;
      }
      elapsed += poll;
      this.#oldTimer = this.#schedule(tick, poll);
    };
    this.#oldTimer = this.#schedule(tick, poll);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#oldTimer?.();
    this.#oldTimer = null;
    if (this.#replacedTimer) clearTimeout(this.#replacedTimer);
    this.#replacedTimer = null;
  }

  status(): InstallStatus {
    return installStatus({
      mode: this.#o.mode,
      appPath: this.#o.appPath,
      version: this.#o.version,
      dataDir: this.#o.dataDir,
      home: this.#o.home,
      pathVar: this.#o.pathVar,
      ...(this.#o.homebrewCandidates ? { homebrewCandidates: this.#o.homebrewCandidates } : {}),
    });
  }

  /**
   * POST /api/install/cli-link（O8 の Install ▸）: `~/.local/bin/turnlane` をアプリの中の turnlane へのリンクにする。
   * 管理者権限は求めない。そこに turnlane のリンク以外のファイル（開発時の配置のバイナリ）があれば置き換えない
   */
  installCliLink(): {
    ok: boolean;
    reason: "not_app" | "occupied" | "failed" | null;
    status: InstallStatus;
  } {
    const appPath = this.#o.appPath;
    if (this.#o.mode !== "app" || !appPath)
      return { ok: false, reason: "not_app", status: this.status() };
    const link = join(this.#o.home, ".local", "bin", "turnlane");
    try {
      ensureSymlink(link, bundledBinary(appPath, "turnlane"));
      this.#o.logger.info("install.local_bin_linked", {});
      return { ok: true, reason: null, status: this.status() };
    } catch (e) {
      const occupied = (e as Error).message === "not_a_symlink" && existsSync(link);
      if (!occupied) this.#o.logger.warn("install.local_bin_failed", errorFields(e));
      return { ok: false, reason: occupied ? "occupied" : "failed", status: this.status() };
    }
  }

  /** 前回の install.json（turnlane doctor・移行が読む） */
  previous() {
    return readInstallInfo(this.#o.dataDir);
  }
}
