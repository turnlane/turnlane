/**
 * 在席のサンプルを読む（D-105、ADR 0013）。読むのは「最後の入力からの経過」と「画面ロック中か・このユーザーが
 * コンソールにいるか」だけ。キー・ポインタの位置・アプリ名・ウインドウ名は読まない。権限（入力監視・アクセシビリティ）は要らない。
 *
 * - 最後の入力からの経過: CoreGraphics の CGEventSourceSecondsSinceLastEventType(HIDSystemState, AnyInputEventType) を
 *   Bun FFI で呼ぶ。FFI が使えない（JIT が無い署名など）・失敗したら `ioreg -c IOHIDSystem` の HIDIdleTime（ns）で代える
 * - ロック・コンソール: `ioreg -n Root -d1` の IOConsoleUsers のうち、このプロセスの uid の項目の
 *   CGSSessionScreenIsLocked（ロック中だけ現れる）と kCGSSessionOnConsoleKey（別ユーザーに切り替えると No）
 */

export interface PresenceReading {
  /** 最後の入力からの経過（ms）。読めなければ null */
  idleMs: number | null;
  locked: boolean;
  offConsole: boolean;
}

export interface PresenceReader {
  read(): Promise<PresenceReading>;
  /** 最後の入力の読み方（ログ用） */
  readonly method: () => "ffi" | "ioreg" | "none";
}

const CG_PATH = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
/** kCGEventSourceStateHIDSystemState */
const HID_SYSTEM_STATE = 1;
/** kCGAnyInputEventType */
const ANY_INPUT_EVENT = 0xffffffff;

/** `ioreg -c IOHIDSystem` の出力から HIDIdleTime（ns）を ms で返す。無ければ null */
export function parseHidIdleMs(out: string): number | null {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out);
  if (!m?.[1]) return null;
  const ns = Number(m[1]);
  return Number.isFinite(ns) ? Math.floor(ns / 1_000_000) : null;
}

/**
 * `ioreg -n Root -d1` の出力から、uid のセッションのロック・コンソールの状態を返す。IOConsoleUsers が無い・uid の項目が
 * 無ければ「ロックなし・コンソールにいる」とみなす（読めないことで在席を落とさない）
 */
export function parseConsoleState(
  out: string,
  uid: number,
): { locked: boolean; offConsole: boolean } {
  const line = out.split("\n").find((l) => l.includes('"IOConsoleUsers"'));
  if (!line) return { locked: false, offConsole: false };
  for (const dict of line.match(/\{[^{}]*\}/g) ?? []) {
    const m = /"kCGSSessionUserIDKey"\s*=\s*(\d+)/.exec(dict);
    if (!m || Number(m[1]) !== uid) continue;
    return {
      locked: /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(dict),
      offConsole: /"kCGSSessionOnConsoleKey"\s*=\s*No/.test(dict),
    };
  }
  return { locked: false, offConsole: false };
}

async function run(cmd: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}

type IdleFn = () => number;

/** FFI で最後の入力からの経過（秒）を読む関数。使えなければ null */
async function loadFfi(): Promise<IdleFn | null> {
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const lib = dlopen(CG_PATH, {
      CGEventSourceSecondsSinceLastEventType: {
        args: [FFIType.i32, FFIType.u32],
        returns: FFIType.f64,
      },
    });
    const f = lib.symbols.CGEventSourceSecondsSinceLastEventType;
    return () => f(HID_SYSTEM_STATE, ANY_INPUT_EVENT) as number;
  } catch {
    return null;
  }
}

/** macOS の実機から読む */
export class SystemPresenceReader implements PresenceReader {
  #ffi: IdleFn | null | undefined;
  #method: "ffi" | "ioreg" | "none" = "none";
  readonly #uid: number;

  constructor(uid: number = process.getuid?.() ?? -1) {
    this.#uid = uid;
  }

  method = () => this.#method;

  async #idleMs(): Promise<number | null> {
    if (this.#ffi === undefined) this.#ffi = await loadFfi();
    if (this.#ffi) {
      try {
        const sec = this.#ffi();
        if (Number.isFinite(sec) && sec >= 0) {
          this.#method = "ffi";
          return Math.floor(sec * 1000);
        }
      } catch {
        this.#ffi = null;
      }
    }
    const out = await run(["/usr/sbin/ioreg", "-c", "IOHIDSystem", "-d", "4"]);
    const ms = out ? parseHidIdleMs(out) : null;
    this.#method = ms === null ? "none" : "ioreg";
    return ms;
  }

  async read(): Promise<PresenceReading> {
    const idleMs = await this.#idleMs();
    const root = await run(["/usr/sbin/ioreg", "-n", "Root", "-d1"]);
    const st = root ? parseConsoleState(root, this.#uid) : { locked: false, offConsole: false };
    return { idleMs, ...st };
  }
}
