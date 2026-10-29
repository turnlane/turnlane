/**
 * Turnlane.app のバンドルの読み取りと入れ替え（CLI の `turnlane desktop install`・`turnlane doctor` と、デーモンの自動更新で
 * 共通。ADR 0008 の追記 4、desktop-shell.md 6.2）。
 * - 署名の読み取りは `/usr/bin/codesign -dv --verbose=2`（種類・TeamIdentifier）。Team ID は定数に持たず、バンドルから読む
 * - 入れ替えは配置先の隣に `.Turnlane.app.new` として ditto で写し、今のものを `.Turnlane.app.old` に rename、新を本名に
 *   rename、old を消す。途中で失敗したら old を本名に戻す（本名の .app が無い時間を rename 2 回の間だけにする）
 * - keepOld: 古い版のプロセス（アプリ・デーモン・カレンダーヘルパ）がまだ動いているかもしれないときは old を消さずに残す。
 *   動いているプロセスの実行ファイルを消すと、まだ読み込んでいないページ（終わるときの処理など）に触れたときに落ちる
 *   （自動更新の Restart to update でアプリが「予期せず終了」した）。残した old は新しい版のデーモンが起動の後に消す
 *   （InstallService の cleanupOldBundle）。次の replaceBundle も最初に片付ける
 */
import { accessSync, constants, existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** 外部コマンドの実行（テストで差し替える）。out は stdout と stderr を続けたもの */
export type RunCommand = (cmd: readonly string[]) => Promise<{ code: number; out: string }>;

const ENV = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };

export const runCommand: RunCommand = async (cmd) => {
  try {
    const p = Bun.spawn([...cmd], { stdout: "pipe", stderr: "pipe", env: ENV });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, out: out + err };
  } catch {
    return { code: -1, out: "" };
  }
};

export function runCommandSync(cmd: readonly string[]): { code: number; out: string } {
  try {
    const p = Bun.spawnSync([...cmd], { stdout: "pipe", stderr: "pipe", env: ENV });
    return { code: p.exitCode ?? -1, out: p.stdout.toString() + p.stderr.toString() };
  } catch {
    return { code: -1, out: "" };
  }
}

export interface CodesignInfo {
  signed: boolean;
  adhoc: boolean;
  /** 最初の Authority（Apple Development / Developer ID Application など） */
  authority: string | null;
  /** TeamIdentifier（not set・読めないなら null） */
  teamId: string | null;
}

/** `codesign -dv --verbose=2` の出力を読む */
export function parseCodesignInfo(code: number, out: string): CodesignInfo {
  if (code !== 0) return { signed: false, adhoc: false, authority: null, teamId: null };
  const authority = /^Authority=(.+)$/m.exec(out)?.[1]?.trim() ?? null;
  const team = /^TeamIdentifier=(\S+)\s*$/m.exec(out)?.[1] ?? null;
  return {
    signed: true,
    adhoc: /Signature=adhoc/.test(out),
    authority,
    teamId: team && /^[A-Z0-9]{10}$/.test(team) ? team : null,
  };
}

export function codesignDisplayArgs(app: string): string[] {
  return ["/usr/bin/codesign", "-dv", "--verbose=2", app];
}

export async function codesignInfo(app: string, run: RunCommand = runCommand) {
  const r = await run(codesignDisplayArgs(app));
  return parseCodesignInfo(r.code, r.out);
}

export function codesignInfoSync(app: string): CodesignInfo {
  const r = runCommandSync(codesignDisplayArgs(app));
  return parseCodesignInfo(r.code, r.out);
}

/** 署名の種類（turnlane doctor・status）: Apple Development / Developer ID Application / ad-hoc / other / unsigned */
export function signatureKindOf(i: CodesignInfo): string {
  if (!i.signed) return "unsigned";
  if (i.adhoc) return "ad-hoc";
  const a = /^(Apple Development|Developer ID Application)/.exec(i.authority ?? "")?.[1];
  return a ?? "other";
}

export function signatureKind(app: string): string {
  return signatureKindOf(codesignInfoSync(app));
}

/** 入れ替えの失敗。not_writable は配置先に書けない（EACCES・EPERM・EROFS） */
export type ReplaceError = "not_writable" | "io";

export interface ReplaceOps {
  /** src を dst に写す（既定は /usr/bin/ditto。署名を壊さない）。成功なら true */
  copy: (src: string, dst: string) => Promise<boolean>;
  rename: (from: string, to: string) => void;
  remove: (path: string) => void;
}

export const defaultReplaceOps: ReplaceOps = {
  copy: async (src, dst) => (await runCommand(["/usr/bin/ditto", src, dst])).code === 0,
  rename: (a, b) => renameSync(a, b),
  remove: (p) => rmSync(p, { recursive: true, force: true }),
};

const NOT_WRITABLE = new Set(["EACCES", "EPERM", "EROFS"]);

function errorKind(e: unknown): ReplaceError {
  return NOT_WRITABLE.has((e as NodeJS.ErrnoException)?.code ?? "") ? "not_writable" : "io";
}

/** 配置先の隣の一時名（`.Turnlane.app.new`・`.Turnlane.app.old`） */
export function sideNames(dst: string): { next: string; old: string } {
  const dir = dirname(dst);
  const name = basename(dst);
  return { next: join(dir, `.${name}.new`), old: join(dir, `.${name}.old`) };
}

/**
 * src のバンドルを dst に入れる（dst が無ければ置くだけ）。成功なら null、失敗なら理由。どの失敗でも dst は前のまま残す
 */
export async function replaceBundle(
  src: string,
  dst: string,
  ops: ReplaceOps = defaultReplaceOps,
  opts: { keepOld?: boolean } = {},
): Promise<ReplaceError | null> {
  const { next, old } = sideNames(dst);
  try {
    accessSync(dirname(dst), constants.W_OK);
  } catch (e) {
    return errorKind(e);
  }
  try {
    // 前の回の残り（途中で終わった）を片付ける。本名が無く old だけあれば戻す
    if (!existsSync(dst) && existsSync(old)) ops.rename(old, dst);
    ops.remove(next);
    ops.remove(old);
  } catch (e) {
    return errorKind(e);
  }
  if (!(await ops.copy(src, next))) {
    try {
      ops.remove(next);
    } catch {}
    return "io";
  }
  const had = existsSync(dst);
  try {
    if (had) ops.rename(dst, old);
  } catch (e) {
    try {
      ops.remove(next);
    } catch {}
    return errorKind(e);
  }
  try {
    ops.rename(next, dst);
  } catch (e) {
    // 戻す
    try {
      if (had) ops.rename(old, dst);
    } catch {}
    try {
      ops.remove(next);
    } catch {}
    return errorKind(e);
  }
  if (opts.keepOld) return null;
  try {
    if (had) ops.remove(old);
  } catch {
    // 古いものが残るだけ（次の回に片付ける）
  }
  return null;
}

/**
 * そのバンドルの中から起動したプロセスがあるか（`pgrep -f <app>/Contents/`。アプリ・同梱のデーモン・カレンダーヘルパ）。
 * 確かめられなければ true（消さない側に倒す）
 */
export function processesRunningFrom(
  app: string,
  run: (cmd: readonly string[]) => { code: number; out: string } = runCommandSync,
): boolean {
  const r = run(["/usr/bin/pgrep", "-f", `${app}/Contents/`]);
  if (r.code === 1) return false;
  return true;
}
