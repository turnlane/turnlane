/**
 * カレンダーの接続（オンボーディング O4 の主ボタン。onboarding.md 4.4）。アプリの `desktop_setup`（SMAppService でヘルパを
 * 登録する。M6-14）ができるまでの経路: デーモンが同梱の turnlane を起動して、`calendar install`（ヘルパを ~/Applications に
 * 置いて LaunchAgent を登録。既に入っていれば何もしない）→ `calendar authorize`（ヘルパを前面で起動して許可のダイアログを出し、
 * 許可が付いたら常駐のヘルパを起こし直す。D-130）を順に行う。画面は /api/calendar/status で許可を確かめ、終了コードが 0 で
 * なければ CalendarConnectError（stderr の要約）を GET /api/onboarding/calendar/connect で受け取る（onboarding.md 4.4）。
 * シェルを通さず引数の配列で起動する
 */
import type { MetaOnlyLogger } from "@turnlane/collectors";

export interface CalendarConnectDeps {
  /** 同梱の turnlane のパス */
  cli: string;
  logger: MetaOnlyLogger;
  /**
   * 配布版（install.json の app）: アプリの中のヘルパ（`Contents/Library/LoginItems/TurnlaneCalendarHelper.app`）。
   * 常駐の登録はアプリが SMAppService で先に行う（画面が IPC の registerCalendarHelper を呼んでから接続を始める）ので、
   * ここでは `calendar install` をせず、`calendar authorize --app <ヘルパ>` で許可のダイアログだけを出す
   */
  bundledHelper?: string | null;
  /** 起動（テストでは差し替える）。終了コードと stderr を返す */
  run?: (argv: string[]) => Promise<RunResult>;
  /**
   * 許可の後の確かめ（2026-10-21 の Neo: 許可のダイアログで許可した後、常駐のヘルパがつながり直さず
   * 「カレンダーのヘルパが起動しません」になった）: authorize が 0 で終わったら、常駐のヘルパがつながってフルアクセスを
   * 返すまで readyWaitMs 待つ。返さなければ restartHelper（配布版はアプリの `--setup reregister calendarHelper`）で
   * 起こし直し、もう一度待つ。どちらも無ければ確かめない
   */
  helperReady?: () => boolean;
  restartHelper?: (() => Promise<boolean>) | undefined;
  readyWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunResult {
  code: number;
  stderr: string;
}

/** 接続の失敗（turnlane の終了コードが 0 でない）。detail は stderr の要約（英語。画面に出す。ログには書かない） */
export class CalendarConnectError extends Error {
  override name = "CalendarConnectError";
  constructor(
    readonly step: "install" | "authorize",
    readonly exitCode: number,
    readonly detail: string,
  ) {
    super(`calendar ${step} exited with ${exitCode}`);
  }
}

/** stderr の要約: 空でない最後の 2 行を 1 行にして 300 文字まで（画面の理由の 1 行） */
export function summarizeStderr(s: string): string {
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const t = lines.slice(-2).join(" ");
  return t.length > 300 ? `${t.slice(0, 299)}…` : t;
}

async function spawnCode(argv: string[]): Promise<RunResult> {
  // 文言は英語を正とする（stderr の要約を画面の理由に出す）
  const p = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, TURNLANE_LANG: "en" },
  });
  const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  return { code, stderr };
}

export function cliCalendarConnect(d: CalendarConnectDeps): () => Promise<void> {
  const run = d.run ?? spawnCode;
  const step = async (name: "install" | "authorize", argv: string[]) => {
    const r = await run(argv);
    d.logger.info(`calendar.connect_${name}`, { code: r.code });
    if (r.code !== 0)
      throw new CalendarConnectError(
        name,
        r.code,
        summarizeStderr(r.stderr) || `turnlane calendar ${name} exited with ${r.code}`,
      );
  };
  const sleep = d.sleep ?? ((ms: number) => Bun.sleep(ms));
  const waitReady = async (ready: () => boolean) => {
    const n = Math.ceil((d.readyWaitMs ?? 20_000) / 500);
    for (let i = 0; i < n; i++) {
      if (ready()) return true;
      await sleep(500);
    }
    return ready();
  };
  /** 許可の後、常駐のヘルパがフルアクセスでつながるのを確かめ、つながらなければ起こし直す */
  const confirm = async () => {
    const ready = d.helperReady;
    if (!ready) return;
    if (await waitReady(ready)) return;
    if (!d.restartHelper) {
      d.logger.warn("calendar.connect_helper_not_ready", { restarted: false });
      return;
    }
    const ok = await d.restartHelper();
    const after = ok && (await waitReady(ready));
    d.logger[after ? "info" : "warn"]("calendar.connect_helper_restarted", { ok, ready: after });
    if (!after)
      throw new CalendarConnectError(
        "authorize",
        0,
        "Access was allowed, but the calendar helper did not reconnect. Quit and reopen Turnlane; if that doesn't help, reinstall it (see turnlane doctor)",
      );
  };
  return async () => {
    if (d.bundledHelper) {
      await step("authorize", [d.cli, "calendar", "authorize", "--app", d.bundledHelper]);
      await confirm();
      return;
    }
    await step("install", [d.cli, "calendar", "install"]);
    await step("authorize", [d.cli, "calendar", "authorize"]);
    await confirm();
  };
}

/** システム設定の画面を開く（/usr/bin/open）。O4 の拒否・O7 */
export async function openSystemSettings(url: string): Promise<boolean> {
  try {
    const p = Bun.spawn(["/usr/bin/open", url], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}
