/**
 * スリープさせない（ExtDeps.power。ADR 0015）。拡張が長い処理の間だけ、システムのアイドルスリープを止める。
 * `caffeinate -i -w <デーモンの pid>` を1つだけ起こし、保持する理由が無くなったら止める（デーモンが落ちても caffeinate は
 * pid の終わりで自分から終わる）。ディスプレイのスリープは止めない（`-d`・`-u` は使わない: 在席に見えてしまうため。ADR 0013）。
 * root は要らない。蓋を閉じたとき（外部ディスプレイなし）は止められない
 */
import type { MetaOnlyLogger } from "@turnlane/collectors";
import { meta } from "@turnlane/collectors";

export interface PowerSystem {
  /** 保持を始める。止める関数を返す（起こせなければ null） */
  hold(): (() => void) | null;
  /** 電源とふたの状態を読む（ExtDeps.power.state）。無ければ値なし */
  read?(): Promise<PowerState>;
}

/**
 * 電源とふたの状態（ExtDeps.power.state）。読めないときは null（デスクトップの Mac にふたは無い）。
 * - ac: 電源につながっているか（`pmset -g batt` の `Now drawing from 'AC Power'`）
 * - lidClosed: ふたが閉じているか（`ioreg -r -k AppleClamshellState -d 1` の `AppleClamshellState`）
 */
export interface PowerState {
  ac: boolean | null;
  lidClosed: boolean | null;
}

export const NO_POWER_STATE: PowerState = { ac: null, lidClosed: null };

export const CAFFEINATE = "/usr/bin/caffeinate";
const PMSET = "/usr/bin/pmset";
const IOREG = "/usr/sbin/ioreg";

/** `pmset -g batt` の出力 → 電源につながっているか（分からなければ null） */
export function parsePmsetBatt(out: string): boolean | null {
  const m = /Now drawing from '([^']+)'/.exec(out);
  if (!m) return null;
  if (m[1] === "AC Power") return true;
  if (m[1] === "Battery Power") return false;
  return null;
}

/** `ioreg -r -k AppleClamshellState -d 1` の出力 → ふたが閉じているか（ふたの無い Mac・分からなければ null） */
export function parseClamshell(out: string): boolean | null {
  const m = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(out);
  return m ? m[1] === "Yes" : null;
}

async function readOut(argv: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => p.kill(), 3000);
    const out = await new Response(p.stdout).text();
    clearTimeout(timer);
    return (await p.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}

/** 本物の電源とふたの状態（root は要らない。読むだけ） */
export async function readPowerState(): Promise<PowerState> {
  const [batt, lid] = await Promise.all([
    readOut([PMSET, "-g", "batt"]),
    readOut([IOREG, "-r", "-k", "AppleClamshellState", "-d", "1"]),
  ]);
  return {
    ac: batt === null ? null : parsePmsetBatt(batt),
    lidClosed: lid === null ? null : parseClamshell(lid),
  };
}

/** 本物（caffeinate を起こす） */
export const systemPower: PowerSystem = {
  hold() {
    try {
      const p = Bun.spawn([CAFFEINATE, "-i", "-w", String(process.pid)], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      return () => {
        try {
          p.kill();
        } catch {}
      };
    } catch {
      return null;
    }
  },
  read: readPowerState,
};

/** テスト用: 保持しているかだけを覚える */
export class FakePower implements PowerSystem {
  holding = false;
  holds = 0;
  state: PowerState = { ...NO_POWER_STATE };
  async read(): Promise<PowerState> {
    return { ...this.state };
  }
  hold(): () => void {
    this.holding = true;
    this.holds += 1;
    return () => {
      this.holding = false;
    };
  }
}

/** 理由ごとの保持を数え、1つ以上あれば保持する */
export class KeepAwake {
  readonly #reasons = new Map<number, string>();
  #seq = 0;
  #release: (() => void) | null = null;

  constructor(
    private readonly sys: PowerSystem,
    private readonly logger?: MetaOnlyLogger,
  ) {}

  get active(): boolean {
    return this.#reasons.size > 0;
  }

  /** 保持を始める。返した関数で止める（2回呼んでもよい） */
  keepAwake(reason: string): () => void {
    const n = ++this.#seq;
    this.#reasons.set(n, reason);
    if (!this.#release) {
      this.#release = this.sys.hold();
      this.logger?.info("power.keep_awake", { reason: meta(reason), ok: this.#release !== null });
    }
    return () => {
      if (!this.#reasons.delete(n)) return;
      if (this.#reasons.size === 0) this.stop();
    };
  }

  stop(): void {
    this.#reasons.clear();
    this.#release?.();
    if (this.#release) this.logger?.info("power.released", {});
    this.#release = null;
  }
}
