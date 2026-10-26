/**
 * launchctl の薄いラッパ（phase0-plan 3.6 の turnlane daemon）。テストでは FakeLaunchctl に差し替える。
 * ドメインは gui/<uid>（ログイン中のユーザーの LaunchAgent）。
 */
import { tr } from "./lang.ts";

export interface ServiceStatus {
  loaded: boolean;
  state?: string;
  pid?: number;
  lastExitCode?: number;
  /** 起動した回数（runs） */
  runs?: number;
  /** 最後の終わり方（last exit reason / last terminating signal。署名の不一致で殺されると OS_REASON_CODESIGNING など） */
  lastExitReason?: string;
}

export interface Launchctl {
  bootstrap(plistPath: string): void;
  bootout(label: string): void;
  kickstart(label: string, opts?: { kill?: boolean }): void;
  print(label: string): ServiceStatus;
}

/** launchctl が 0 以外で終わった。code は launchctl の終了コード */
export class LaunchctlError extends Error {
  constructor(
    readonly op: string,
    readonly code: number,
    readonly output: string,
  ) {
    super(`launchctl ${op} failed (${code}): ${output}`);
    this.name = "LaunchctlError";
  }
}

export function parsePrint(output: string): ServiceStatus {
  const get = (key: string) => new RegExp(`^\\s*${key} = (.+)$`, "m").exec(output)?.[1]?.trim();
  const pid = get("pid");
  const exit = get("last exit code");
  const runs = get("runs");
  const reason = get("last exit reason") ?? get("last terminating signal");
  return {
    loaded: true,
    ...(get("state") ? { state: get("state") as string } : {}),
    ...(pid && /^\d+$/.test(pid) ? { pid: Number(pid) } : {}),
    ...(exit && /^-?\d+$/.test(exit) ? { lastExitCode: Number(exit) } : {}),
    ...(runs && /^\d+$/.test(runs) ? { runs: Number(runs) } : {}),
    ...(reason ? { lastExitReason: reason.slice(0, 120) } : {}),
  };
}

export class SystemLaunchctl implements Launchctl {
  readonly domain: string;

  constructor(uid: number = process.getuid?.() ?? 501) {
    this.domain = `gui/${uid}`;
  }

  #run(args: string[]): { code: number; out: string } {
    const p = Bun.spawnSync(["/bin/launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
  }

  bootstrap(plistPath: string): void {
    const r = this.#run(["bootstrap", this.domain, plistPath]);
    if (r.code !== 0) throw new LaunchctlError("bootstrap", r.code, r.out.trim());
  }

  bootout(label: string): void {
    const r = this.#run(["bootout", `${this.domain}/${label}`]);
    // 3 = No such process（登録されていない）は成功扱い
    if (r.code !== 0 && r.code !== 3 && r.code !== 113) {
      throw new LaunchctlError("bootout", r.code, r.out.trim());
    }
  }

  kickstart(label: string, opts: { kill?: boolean } = {}): void {
    const r = this.#run(["kickstart", ...(opts.kill ? ["-k"] : []), `${this.domain}/${label}`]);
    if (r.code !== 0) throw new LaunchctlError("kickstart", r.code, r.out.trim());
  }

  print(label: string): ServiceStatus {
    const r = this.#run(["print", `${this.domain}/${label}`]);
    if (r.code !== 0) return { loaded: false };
    return parsePrint(r.out);
  }
}

/**
 * bootout 直後の bootstrap の競合への対策。
 * bootout は launchd がサービスを解体し終える前に戻ることがあり、直後の bootstrap が
 * 「Bootstrap failed: 5: Input/output error」（または 37: Operation already in progress）で失敗する。
 * そこで bootout の後は print が「見つからない」になるまで待ち、bootstrap は間隔を空けて再試行する。
 */
export interface LaunchdWaitOptions {
  /** 同期スリープ。テストでは記録するだけの関数に差し替える */
  sleep?: (ms: number) => void;
  /** bootout 後に登録解除を確かめる間隔と上限 */
  pollIntervalMs?: number;
  unloadTimeoutMs?: number;
  /** bootstrap の再試行の待ち時間（要素数 + 1 回試す）。既定は合計 5 秒 */
  retryDelaysMs?: readonly number[];
  /** 最終的に失敗したとき、利用者が次に打つコマンド（例: turnlane daemon start） */
  retryHint?: string;
}

/** 再試行すると通ることがある bootstrap の終了コード（5 = EIO、37 = EALREADY） */
export const RETRYABLE_BOOTSTRAP_CODES: ReadonlySet<number> = new Set([5, 37]);
const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 1500, 2000] as const;

/** print が「見つからない」になるまで待つ。上限までに外れなければ false */
export function waitUntilUnloaded(
  lc: Launchctl,
  label: string,
  opts: LaunchdWaitOptions = {},
): boolean {
  const sleep = opts.sleep ?? Bun.sleepSync;
  const interval = opts.pollIntervalMs ?? 100;
  const timeout = opts.unloadTimeoutMs ?? 5000;
  for (let waited = 0; ; waited += interval) {
    if (!lc.print(label).loaded) return true;
    if (waited >= timeout) return false;
    sleep(interval);
  }
}

/** bootout して、登録が外れるまで待つ */
export function bootoutAndWait(
  lc: Launchctl,
  label: string,
  opts: LaunchdWaitOptions = {},
): boolean {
  lc.bootout(label);
  return waitUntilUnloaded(lc, label, opts);
}

/**
 * bootstrap を再試行付きで行う。error 5 / 37 は間隔を空けて試し直す。
 * それでも失敗したら、次の一手を書いたエラーを投げる。
 */
export function bootstrapWithRetry(
  lc: Launchctl,
  plistPath: string,
  label: string,
  opts: LaunchdWaitOptions = {},
): void {
  const sleep = opts.sleep ?? Bun.sleepSync;
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      lc.bootstrap(plistPath);
      return;
    } catch (e) {
      const retryable = e instanceof LaunchctlError && RETRYABLE_BOOTSTRAP_CODES.has(e.code);
      const delay = delays[attempt - 1];
      if (!retryable || delay === undefined) {
        throw new Error(bootstrapFailureMessage(label, plistPath, attempt, e, opts.retryHint));
      }
      sleep(delay);
    }
  }
}

function bootstrapFailureMessage(
  label: string,
  plistPath: string,
  attempts: number,
  cause: unknown,
  retryHint: string | undefined,
): string {
  const last = cause instanceof Error ? cause.message : String(cause);
  const retry = retryHint ?? `launchctl bootstrap gui/$(id -u) ${plistPath}`;
  return [
    tr(
      `Could not register with launchd (${label}, tried bootstrap ${attempts} times).`,
      `launchd への登録に失敗しました（${label}、bootstrap を ${attempts} 回試行）。`,
    ),
    tr(`  Last error: ${last}`, `  最後のエラー: ${last}`),
    tr(
      "  launchd may still be tearing down the service that was just stopped. Try this:",
      "  直前に止めた旧サービスの解体が launchd で終わっていない可能性があります。次を試してください:",
    ),
    tr(
      `  1. Wait a few seconds, then run ${retry} again`,
      `  1. 数秒待ってから ${retry} を実行し直す`,
    ),
    tr(
      `  2. Check the registration with launchctl print gui/$(id -u)/${label} ("Could not find service" means not registered)`,
      `  2. launchctl print gui/$(id -u)/${label} で登録状態を確かめる（"Could not find service" なら未登録）`,
    ),
  ].join("\n");
}

/**
 * 登録済みなら bootout して外れるまで待ち、bootstrap を再試行付きで行う（入れ替え）。
 * 入れ替えた（登録済みだった）なら true
 */
export function reloadService(
  lc: Launchctl,
  label: string,
  plistPath: string,
  opts: LaunchdWaitOptions & { onReplace?: () => void } = {},
): boolean {
  const replaced = lc.print(label).loaded;
  if (replaced) {
    opts.onReplace?.();
    bootoutAndWait(lc, label, opts);
  }
  bootstrapWithRetry(lc, plistPath, label, opts);
  return replaced;
}

/** テスト用。呼び出しを記録し、登録状態を真似る */
export class FakeLaunchctl implements Launchctl {
  readonly calls: string[] = [];
  readonly loaded = new Map<string, ServiceStatus>();

  constructor(private readonly labelOf: (plistPath: string) => string) {}

  bootstrap(plistPath: string): void {
    this.calls.push(`bootstrap ${plistPath}`);
    this.loaded.set(this.labelOf(plistPath), { loaded: true, state: "running", pid: 4242 });
  }
  bootout(label: string): void {
    this.calls.push(`bootout ${label}`);
    this.loaded.delete(label);
  }
  kickstart(label: string, opts: { kill?: boolean } = {}): void {
    this.calls.push(`kickstart${opts.kill ? " -k" : ""} ${label}`);
  }
  print(label: string): ServiceStatus {
    return this.loaded.get(label) ?? { loaded: false };
  }
}

/**
 * launchd を操作しない実装（TURNLANE_NO_LAUNCHD=1）。スモークテストや一時 HOME での確認で、
 * 同じラベルの本物の LaunchAgent（gui ドメインは HOME と無関係に共有）に触れないようにする。
 */
export class DisabledLaunchctl implements Launchctl {
  bootstrap(): void {
    throw new Error(
      tr(
        "launchd control is turned off (TURNLANE_NO_LAUNCHD=1)",
        "launchd の操作は無効です（TURNLANE_NO_LAUNCHD=1）",
      ),
    );
  }
  bootout(): void {
    throw new Error(
      tr(
        "launchd control is turned off (TURNLANE_NO_LAUNCHD=1)",
        "launchd の操作は無効です（TURNLANE_NO_LAUNCHD=1）",
      ),
    );
  }
  kickstart(): void {
    throw new Error(
      tr(
        "launchd control is turned off (TURNLANE_NO_LAUNCHD=1)",
        "launchd の操作は無効です（TURNLANE_NO_LAUNCHD=1）",
      ),
    );
  }
  print(): ServiceStatus {
    return { loaded: false };
  }
}
