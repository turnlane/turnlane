/**
 * doctor の launchd の行（2026-10-21 の Neo: SMAppService の常駐が署名の不一致で起動直後に殺され続け、
 * `launchctl print` の runs と state でしか分からなかった）
 */
import { describe, expect, test } from "bun:test";
import { codesignKilled, launchdLines } from "../src/commands/doctor-redact.ts";
import { parsePrint } from "../src/launchctl.ts";

describe("launchd の状態", () => {
  test("print の runs・最後の終わり方を読む", () => {
    const s = parsePrint(
      [
        "gui/501/dev.turnlane.calendar-helper = {",
        "\tactive count = 0",
        "\tstate = spawn scheduled",
        "\truns = 44",
        "\tlast exit code = 9: Killed: 9",
        "\tlast exit reason = OS_REASON_CODESIGNING | Launch Constraint Violation",
        "}",
      ].join("\n"),
    );
    expect(s).toMatchObject({
      loaded: true,
      state: "spawn scheduled",
      runs: 44,
      lastExitReason: "OS_REASON_CODESIGNING | Launch Constraint Violation",
    });
  });

  test("署名の不一致で殺されていれば、入れ直しの一手を出す", () => {
    const helper = { state: "spawn scheduled", runs: 44, lastExit: "OS_REASON_CODESIGNING" };
    const daemon = { state: "running", runs: 2, lastExit: null };
    expect(codesignKilled(helper)).toBe(true);
    const lines = launchdLines({
      mode: "app",
      cliLinkOk: true,
      background: null,
      launchd: { daemon, calendarHelper: helper },
    });
    expect(lines[0]).toBe(
      "launchd: daemon running, runs 2 · calendar helper spawn scheduled, runs 44, last exit: OS_REASON_CODESIGNING",
    );
    expect(lines[1]).toContain("Reinstall Turnlane");
    expect(
      launchdLines({
        mode: "app",
        cliLinkOk: true,
        background: null,
        launchd: { daemon, calendarHelper: null },
      }),
    ).toEqual(["launchd: daemon running, runs 2 · calendar helper not loaded"]);
    expect(launchdLines({ mode: "dev", cliLinkOk: null, background: null })).toEqual([]);
  });
});
