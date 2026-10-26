/**
 * bootout 直後の bootstrap の競合（launchd の解体待ちで error 5）への対策のテスト。
 * launchctl は偽物で、実際の launchd には触れない。スリープは記録するだけ。
 */
import { describe, expect, test } from "bun:test";

import {
  bootoutAndWait,
  bootstrapWithRetry,
  FakeLaunchctl,
  LaunchctlError,
  reloadService,
  type ServiceStatus,
  waitUntilUnloaded,
} from "../src/launchctl.ts";

const LABEL = "dev.turnlane.test";
const PLIST = "/tmp/dev.turnlane.test.plist";
const EIO = () => new LaunchctlError("bootstrap", 5, "Bootstrap failed: 5: Input/output error");

/** bootout 後もしばらく print に残り、bootstrap が指定の回数だけ失敗する偽の launchctl */
class RacyLaunchctl extends FakeLaunchctl {
  /** bootout 後、print が loaded を返し続ける回数 */
  lingerPrints = 0;
  /** bootstrap が投げるエラー（先頭から順に1回ずつ）。空なら成功 */
  bootstrapFailures: Array<() => Error> = [];
  #linger = 0;

  constructor() {
    super(() => LABEL);
  }
  override bootout(label: string): void {
    super.bootout(label);
    this.#linger = this.lingerPrints;
  }
  override print(label: string): ServiceStatus {
    if (this.#linger > 0) {
      this.#linger--;
      this.calls.push(`print ${label} (loaded)`);
      return { loaded: true, state: "stopping" };
    }
    return super.print(label);
  }
  override bootstrap(plistPath: string): void {
    const fail = this.bootstrapFailures.shift();
    if (fail) {
      this.calls.push(`bootstrap ${plistPath} (failed)`);
      throw fail();
    }
    super.bootstrap(plistPath);
  }
}

function recorder() {
  const slept: number[] = [];
  return { slept, sleep: (ms: number) => void slept.push(ms) };
}

describe("waitUntilUnloaded / bootoutAndWait", () => {
  test("print が見つからないになるまで 100ms 間隔で待つ", () => {
    const lc = new RacyLaunchctl();
    lc.loaded.set(LABEL, { loaded: true });
    lc.lingerPrints = 3;
    const r = recorder();
    expect(bootoutAndWait(lc, LABEL, { sleep: r.sleep })).toBe(true);
    expect(r.slept).toEqual([100, 100, 100]);
  });

  test("上限（既定 5 秒）を過ぎても外れなければ false", () => {
    const lc = new RacyLaunchctl();
    lc.loaded.set(LABEL, { loaded: true });
    const r = recorder();
    expect(waitUntilUnloaded(lc, LABEL, { sleep: r.sleep })).toBe(false);
    expect(r.slept.reduce((a, b) => a + b, 0)).toBe(5000);
  });
});

describe("bootstrapWithRetry", () => {
  test("error 5 の後に再試行して成功する", () => {
    const lc = new RacyLaunchctl();
    lc.bootstrapFailures = [EIO, EIO];
    const r = recorder();
    bootstrapWithRetry(lc, PLIST, LABEL, { sleep: r.sleep });
    expect(lc.calls).toEqual([
      `bootstrap ${PLIST} (failed)`,
      `bootstrap ${PLIST} (failed)`,
      `bootstrap ${PLIST}`,
    ]);
    expect(r.slept).toEqual([500, 1000]);
    expect(lc.print(LABEL).loaded).toBe(true);
  });

  test("error 37（Operation already in progress）も再試行する", () => {
    const lc = new RacyLaunchctl();
    lc.bootstrapFailures = [() => new LaunchctlError("bootstrap", 37, "in progress")];
    const r = recorder();
    bootstrapWithRetry(lc, PLIST, LABEL, { sleep: r.sleep });
    expect(r.slept).toEqual([500]);
  });

  test("恒常的に失敗したら 5 回（合計 5 秒）で諦め、次の一手を書いたエラーにする", () => {
    const lc = new RacyLaunchctl();
    lc.bootstrapFailures = Array.from({ length: 10 }, () => EIO);
    const r = recorder();
    let msg = "";
    try {
      bootstrapWithRetry(lc, PLIST, LABEL, { sleep: r.sleep, retryHint: "turnlane daemon start" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(lc.calls.filter((c) => c.startsWith("bootstrap"))).toHaveLength(5);
    expect(r.slept.reduce((a, b) => a + b, 0)).toBe(5000);
    expect(msg).toContain(`Could not register with launchd (${LABEL}, tried bootstrap 5 times)`);
    expect(msg).toContain("Bootstrap failed: 5: Input/output error");
    expect(msg).toContain("then run turnlane daemon start again");
    expect(msg).toContain(`launchctl print gui/$(id -u)/${LABEL}`);
  });

  test("再試行しても意味のない失敗（error 5 / 37 以外）はすぐ諦める", () => {
    const lc = new RacyLaunchctl();
    lc.bootstrapFailures = [() => new LaunchctlError("bootstrap", 122, "Path had bad ownership")];
    const r = recorder();
    expect(() => bootstrapWithRetry(lc, PLIST, LABEL, { sleep: r.sleep })).toThrow(
      "tried bootstrap 1 times",
    );
    expect(r.slept).toEqual([]);
  });
});

describe("reloadService（入れ替え）", () => {
  test("bootout → 外れるのを待つ → bootstrap が error 5 → 再試行で成功", () => {
    const lc = new RacyLaunchctl();
    lc.loaded.set(LABEL, { loaded: true, state: "running" });
    lc.lingerPrints = 2;
    lc.bootstrapFailures = [EIO];
    const r = recorder();
    let replaced = false;
    expect(
      reloadService(lc, LABEL, PLIST, { sleep: r.sleep, onReplace: () => (replaced = true) }),
    ).toBe(true);
    expect(replaced).toBe(true);
    expect(lc.calls).toEqual([
      `bootout ${LABEL}`,
      `print ${LABEL} (loaded)`,
      `print ${LABEL} (loaded)`,
      `bootstrap ${PLIST} (failed)`,
      `bootstrap ${PLIST}`,
    ]);
    expect(r.slept).toEqual([100, 100, 500]);
  });

  test("未登録なら bootout せずに bootstrap だけ", () => {
    const lc = new RacyLaunchctl();
    const r = recorder();
    expect(reloadService(lc, LABEL, PLIST, { sleep: r.sleep })).toBe(false);
    expect(lc.calls).toEqual([`bootstrap ${PLIST}`]);
  });
});
