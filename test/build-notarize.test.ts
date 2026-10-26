/**
 * 署名の種別・タイムスタンプ・公証と staple（M6-8、docs/dev/codesign.md 5 章）。
 * 実際の証明書・notarytool・stapler は使わない（キーチェーンと Apple に触れない）。コマンドの組み立てと、
 * 偽の exec での公証の流れと、乾式（buildPlan）の出力を確かめる。証明書の名前は架空の値
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENTITLEMENTS, signCommand } from "../scripts/build.ts";
import {
  APP_ENTITLEMENTS,
  appSignCommand,
  buildPlan,
  HELPER_ENTITLEMENTS,
  HELPER_REQUIRED_ENTITLEMENTS,
  helperSignCommand,
  verifyDistribution,
} from "../scripts/build-app.ts";
import {
  codesignFailureHint,
  describeSpctl,
  type ExecResult,
  FORBIDDEN_ENTITLEMENTS,
  isDistribution,
  notarize,
  notarizeDecision,
  notaryProfile,
  parseSubmit,
  STAPLE_ATTEMPTS,
  StapleError,
  signatureProblems,
  signKind,
  timestampArgs,
} from "../scripts/signing.ts";

const ROOT = resolve(import.meta.dir, "..");
const DEV_ID = "Developer ID Application: Example Co (ABCDE12345)";
const APPLE_DEV = "Apple Development: Someone (ABCDE12345)";

describe("署名の種別", () => {
  test("Developer ID Application: で始まるときだけ配布用", () => {
    expect(signKind(DEV_ID)).toBe("developer-id");
    expect(signKind(` ${DEV_ID} `)).toBe("developer-id");
    expect(signKind(APPLE_DEV)).toBe("apple-development");
    expect(signKind("-")).toBe("ad-hoc");
    expect(signKind("")).toBe("ad-hoc");
    expect(signKind(null)).toBe("ad-hoc");
    expect(signKind(undefined)).toBe("ad-hoc");
    // SHA-1 での指定は種別が分からないので配布用とはみなさない
    expect(signKind("0123456789ABCDEF0123456789ABCDEF01234567")).toBe("other");
    expect(isDistribution(DEV_ID)).toBe(true);
    expect(isDistribution(APPLE_DEV)).toBe(false);
  });

  test("タイムスタンプ: 配布用は --timestamp、それ以外は --timestamp=none", () => {
    expect(timestampArgs(DEV_ID)).toEqual(["--timestamp"]);
    for (const id of [APPLE_DEV, "-", null])
      expect(timestampArgs(id)).toEqual(["--timestamp=none"]);
  });

  test("TURNLANE_NOTARY_PROFILE: 空なら null", () => {
    expect(notaryProfile({})).toBeNull();
    expect(notaryProfile({ TURNLANE_NOTARY_PROFILE: " " })).toBeNull();
    expect(notaryProfile({ TURNLANE_NOTARY_PROFILE: " turnlane-notary " })).toBe("turnlane-notary");
  });

  test("シェル用の口（bun scripts/signing.ts timestamp-flag）が同じ判定を返す", () => {
    const flag = (id: string) =>
      Bun.spawnSync([process.execPath, "scripts/signing.ts", "timestamp-flag"], {
        cwd: ROOT,
        stdout: "pipe",
        env: { ...process.env, TURNLANE_CODESIGN_IDENTITY: id },
      })
        .stdout.toString()
        .trim();
    expect(flag(DEV_ID)).toBe("--timestamp");
    expect(flag(APPLE_DEV)).toBe("--timestamp=none");
    expect(flag("-")).toBe("--timestamp=none");
  });
});

describe("署名のコマンド（全部の部品で同じ判定）", () => {
  const all = (id: string) => [
    signCommand("/s/bin/turnlaned", "turnlaned", id),
    signCommand("/s/bin/turnlane", "turnlane", id),
    helperSignCommand("/s/helper/TurnlaneCalendarHelper.app", id),
    appSignCommand("/s/Turnlane.app", id),
  ];

  test("配布用: どれも --timestamp を付け、--timestamp=none を付けない。hardened runtime", () => {
    for (const c of all(DEV_ID)) {
      expect(c).toContain("--timestamp");
      expect(c).not.toContain("--timestamp=none");
      expect(c.slice(c.indexOf("--options"), c.indexOf("--options") + 2)).toEqual([
        "--options",
        "runtime",
      ]);
      expect(c.filter((a) => a === DEV_ID)).toHaveLength(1);
    }
  });

  test("Apple Development・ad-hoc: 今までどおり --timestamp=none", () => {
    for (const id of [APPLE_DEV, "-"])
      for (const c of all(id)) {
        expect(c).toContain("--timestamp=none");
        expect(c).not.toContain("--timestamp");
      }
  });

  test("ヘルパ: hardened runtime とカレンダーの entitlement。build-app.sh も同じ引数で署名する", () => {
    const c = helperSignCommand("/x/TurnlaneCalendarHelper.app", "-");
    expect(c[c.indexOf("--entitlements") + 1]).toBe(HELPER_ENTITLEMENTS);
    expect(c[c.indexOf("--identifier") + 1]).toBe("dev.turnlane.calendar-helper");
    const sh = readFileSync(join(ROOT, "native/calendar-helper/scripts/build-app.sh"), "utf8");
    expect(sh).toMatch(/codesign --force --options runtime \$\{TIMESTAMP\} --entitlements/);
    expect(sh).toContain("Resources/CalendarHelper.entitlements");
    expect(sh).toContain("bun scripts/signing.ts timestamp-flag");
    expect(sh).toContain("--identifier dev.turnlane.calendar-helper");
    expect(sh).not.toContain("--timestamp=none");
  });

  test("entitlements: 公証で拒まれるもの（get-task-allow など）が入っていない", () => {
    const json = (f: string) => {
      const p = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", f], { stdout: "pipe" });
      expect(p.exitCode).toBe(0);
      return JSON.parse(p.stdout.toString()) as Record<string, boolean>;
    };
    // Bun の単一バイナリは allow-jit だけ（現状を保つ）
    expect(json(ENTITLEMENTS)).toEqual({ "com.apple.security.cs.allow-jit": true });
    expect(json(HELPER_ENTITLEMENTS)).toEqual(
      Object.fromEntries(HELPER_REQUIRED_ENTITLEMENTS.map((k) => [k, true])),
    );
    for (const f of [ENTITLEMENTS, HELPER_ENTITLEMENTS, APP_ENTITLEMENTS])
      for (const k of FORBIDDEN_ENTITLEMENTS) expect(Object.keys(json(f))).not.toContain(k);
  });
});

describe("署名の検査（checkBundle の部品ごとの確認）", () => {
  const info = (o: { runtime?: boolean; devId?: boolean; ts?: boolean }) =>
    [
      "Identifier=dev.turnlane.turnlaned",
      `CodeDirectory v=20500 size=1 flags=0x${o.runtime === false ? "2(adhoc)" : "10000(runtime)"} hashes=1+0 location=embedded`,
      o.devId ? `Authority=${DEV_ID}` : "Signature=adhoc",
      o.ts ? "Timestamp=Oct 24, 2026 at 10:00:00" : "",
    ].join("\n");
  const xml = (keys: string[]) =>
    `<plist><dict>${keys.map((k) => `<key>${k}</key><true/>`).join("")}</dict></plist>`;

  test("ad-hoc（配布用でない）: runtime と entitlements だけ見る", () => {
    expect(signatureProblems("x", info({}), xml([]), { distribution: false })).toEqual([]);
    expect(
      signatureProblems("x", info({ runtime: false }), xml([]), { distribution: false }),
    ).toEqual(["x: hardened runtime is off"]);
    expect(
      signatureProblems("x", info({}), xml(["com.apple.security.get-task-allow"]), {
        distribution: false,
        requiredEntitlements: ["com.apple.security.personal-information.calendars"],
      }),
    ).toEqual([
      "x: entitlement not allowed: com.apple.security.get-task-allow",
      "x: entitlement missing: com.apple.security.personal-information.calendars",
    ]);
  });

  test("配布用: Developer ID の証明書とセキュアタイムスタンプが要る", () => {
    expect(
      signatureProblems("x", info({ devId: true, ts: true }), xml([]), { distribution: true }),
    ).toEqual([]);
    expect(signatureProblems("x", info({ devId: true }), xml([]), { distribution: true })).toEqual([
      "x: no secure timestamp",
    ]);
    expect(signatureProblems("x", info({ ts: true }), xml([]), { distribution: true })).toEqual([
      "x: not signed with a Developer ID Application certificate",
    ]);
  });

  test("タイムスタンプが取れない失敗には補足を付ける（配布用だけ）", () => {
    const out = "Turnlane.app: The timestamp service is not available.";
    expect(codesignFailureHint(DEV_ID, out)).toContain("network");
    expect(codesignFailureHint(APPLE_DEV, out)).toBeNull();
    expect(codesignFailureHint(DEV_ID, "errSecInternalComponent")).toBeNull();
  });
});

describe("公証をするか", () => {
  test("配布用かつプロファイルありなら公証する", () => {
    expect(notarizeDecision({ identity: DEV_ID, profile: "p" })).toEqual({
      action: "notarize",
      profile: "p",
    });
  });
  test("配布用でプロファイルなしなら警告 1 行（失敗にはしない）。--skip-notarize なら黙る", () => {
    const d = notarizeDecision({ identity: DEV_ID, profile: null });
    expect(d.action).toBe("skip");
    expect(d.action === "skip" && d.warning).toContain("not notarized");
    expect(notarizeDecision({ identity: DEV_ID, profile: null, skip: true })).toEqual({
      action: "skip",
      warning: null,
    });
    expect(notarizeDecision({ identity: DEV_ID, profile: "p", skip: true }).action).toBe("skip");
  });
  test("Apple Development・ad-hoc は公証を省く（プロファイルがあれば無視すると伝える）", () => {
    expect(notarizeDecision({ identity: APPLE_DEV, profile: null })).toEqual({
      action: "skip",
      warning: null,
    });
    const d = notarizeDecision({ identity: "-", profile: "p" });
    expect(d.action === "skip" && d.warning).toContain("ignored");
  });
});

describe("公証の流れ（偽の exec。Apple に送らない）", () => {
  const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
  const fake = (submit: ExecResult) => {
    const calls: string[][] = [];
    const exec = (cmd: string[]) => {
      calls.push(cmd);
      if (cmd.includes("submit")) return submit;
      if (cmd.includes("log")) return ok('{"issues":[{"message":"The binary is not signed."}]}');
      return ok();
    };
    return { calls, exec };
  };

  test("Accepted: zip を送り、.app に staple して validate する", () => {
    const f = fake(
      ok('{"id":"11111111-2222-3333-4444-555555555555","status":"Accepted","message":"ok"}'),
    );
    const r = notarize("/s/Turnlane.app", "/s/notarize.zip", "turnlane-notary", f.exec, () => {});
    expect(r.id).toBe("11111111-2222-3333-4444-555555555555");
    expect(f.calls).toEqual([
      ["/usr/bin/ditto", "-c", "-k", "--keepParent", "/s/Turnlane.app", "/s/notarize.zip"],
      [
        "xcrun",
        "notarytool",
        "submit",
        "/s/notarize.zip",
        "--keychain-profile",
        "turnlane-notary",
        "--wait",
        "--output-format",
        "json",
      ],
      ["xcrun", "stapler", "staple", "/s/Turnlane.app"],
      ["xcrun", "stapler", "validate", "/s/Turnlane.app"],
    ]);
  });

  test("Invalid: notarytool log を取って出力に含め、失敗にする（staple しない）", () => {
    const f = fake({
      code: 1,
      stdout: '{"id":"abc","status":"Invalid","message":"Processing complete"}',
      stderr: "",
    });
    expect(() => notarize("/s/A.app", "/s/a.zip", "p", f.exec, () => {})).toThrow(
      /notarization Invalid \(submission abc\)[\s\S]*The binary is not signed/,
    );
    expect(f.calls.at(-1)).toEqual([
      "xcrun",
      "notarytool",
      "log",
      "abc",
      "--keychain-profile",
      "p",
    ]);
    expect(f.calls.some((c) => c.includes("staple"))).toBe(false);
  });

  test("submit の出力が読めない（資格情報が無いなど）: 失敗にして、プロファイルの確かめ方を出す", () => {
    const f = fake({ code: 69, stdout: "", stderr: "Error: No Keychain password item found" });
    expect(() => notarize("/s/A.app", "/s/a.zip", "p", f.exec, () => {})).toThrow(
      /notarytool submit failed[\s\S]*No Keychain password item found[\s\S]*notarytool history/,
    );
    expect(parseSubmit("not json")).toBeNull();
  });
});

describe("staple の再試行（票の配布待ち）", () => {
  const ID = "11111111-2222-3333-4444-555555555555";
  const accepted: ExecResult = {
    code: 0,
    stdout: `{"id":"${ID}","status":"Accepted","message":"ok"}`,
    stderr: "",
  };
  // staple の n 回目の結果を results[n-1] で返す（足りなければ最後のものを繰り返す）
  const fake = (results: ExecResult[]) => {
    const calls: string[][] = [];
    let staples = 0;
    const exec = (cmd: string[]): ExecResult => {
      calls.push(cmd);
      if (cmd.includes("submit")) return accepted;
      if (cmd.includes("staple")) {
        staples++;
        return results[Math.min(staples, results.length) - 1] as ExecResult;
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    return { calls, exec, staples: () => staples };
  };
  const err73: ExecResult = {
    code: 73,
    stdout: 'Processing: /s/A.app\nCloudKit query for A.app failed due to "Record not found".\n',
    stderr: "The staple and validate action failed! Error 73.\n",
  };
  const ok: ExecResult = { code: 0, stdout: "The staple and validate action worked!", stderr: "" };

  test("1 回目 Error 73、2 回目成功: 待ってやり直し、validate まで進む", () => {
    const f = fake([err73, ok]);
    const logs: string[] = [];
    const r = notarize("/s/A.app", "/s/a.zip", "p", f.exec, (s) => logs.push(s), 0);
    expect(r.id).toBe(ID);
    expect(f.staples()).toBe(2);
    expect(f.calls.at(-1)).toEqual(["xcrun", "stapler", "validate", "/s/A.app"]);
    expect(logs).toContain("staple: attempt 1/10 failed (Error 73), retrying in 0s");
  });

  test("Error 65 も再試行する", () => {
    const f = fake([
      { code: 65, stdout: "", stderr: "The staple and validate action failed! Error 65." },
      ok,
    ]);
    notarize("/s/A.app", "/s/a.zip", "p", f.exec, () => {}, 0);
    expect(f.staples()).toBe(2);
  });

  test("10 回とも Error 73: 提出 ID と手でやり直す手順を含む StapleError（validate しない）", () => {
    const f = fake([err73]);
    const logs: string[] = [];
    let thrown: unknown;
    try {
      notarize("/s/A.app", "/s/a.zip", "p", f.exec, (s) => logs.push(s), 0);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(StapleError);
    const e = thrown as StapleError;
    expect(e.id).toBe(ID);
    expect(e.message).toContain(`submission ${ID}`);
    expect(e.message).toContain('xcrun stapler staple "/s/A.app"');
    expect(e.message).toMatch(/Wait a few minutes/);
    expect(f.staples()).toBe(STAPLE_ATTEMPTS);
    expect(STAPLE_ATTEMPTS).toBe(10);
    expect(logs.filter((l) => l.startsWith("staple: attempt"))).toHaveLength(9);
    expect(f.calls.some((c) => c.includes("validate"))).toBe(false);
  });

  test("Error 73 / 65 以外の失敗: 1 回で例外（やり直さない）", () => {
    const f = fake([
      { code: 1, stdout: "", stderr: "The staple and validate action failed! Error 68." },
    ]);
    let thrown: unknown;
    try {
      notarize("/s/A.app", "/s/a.zip", "p", f.exec, () => {}, 0);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(StapleError);
    expect((thrown as Error).message).toMatch(/stapler staple failed[\s\S]*Error 68/);
    expect(f.staples()).toBe(1);
  });
});

describe("最後の確認（spctl・stapler validate）", () => {
  test("公証済み: source=Notarized Developer ID と staple 済み", () => {
    const exec = (cmd: string[]): ExecResult =>
      cmd[0] === "/usr/sbin/spctl"
        ? {
            code: 0,
            stdout: "",
            stderr: `/o/Turnlane.app: accepted\nsource=Notarized Developer ID\norigin=${DEV_ID}\n`,
          }
        : { code: 0, stdout: "The validate action worked!\n", stderr: "" };
    expect(verifyDistribution("/o/Turnlane.app", true, exec)).toEqual([
      "spctl: accepted · source=Notarized Developer ID",
      "stapler validate: ok (ticket stapled)",
    ]);
  });

  test("未公証: spctl の結果に「not notarized」を付ける", () => {
    const exec = (cmd: string[]): ExecResult =>
      cmd[0] === "/usr/sbin/spctl"
        ? {
            code: 3,
            stdout: "",
            stderr: "/o/Turnlane.app: rejected\nsource=Unnotarized Developer ID\n",
          }
        : { code: 65, stdout: "", stderr: "does not have a ticket stapled to it." };
    expect(verifyDistribution("/o/Turnlane.app", false, exec)).toEqual([
      "spctl: rejected · source=Unnotarized Developer ID (not notarized)",
      "stapler validate: no ticket (not notarized)",
    ]);
    expect(describeSpctl({ code: 3, stdout: "", stderr: "x: rejected" }, false)).toBe(
      "spctl: rejected (not notarized)",
    );
  });
});

describe("乾式（bun run build:app --dry-run）", () => {
  const plan = (identity: string, profile: string | null, o: { skip?: boolean } = {}) =>
    buildPlan({
      identity,
      profile,
      skipNotarize: !!o.skip,
      zip: true,
      outDir: "/o",
      version: "0.7.0",
    }).join("\n");

  test("配布用 + プロファイル: --timestamp で 4 つ署名し、公証 → staple → 改めて zip → 確認", () => {
    const p = plan(DEV_ID, "turnlane-notary");
    expect(p).toContain("identity: Developer ID");
    expect(p.match(/codesign --force --options runtime --timestamp /g)).toHaveLength(4);
    expect(p).not.toContain("--timestamp=none");
    expect(p).toContain(
      "xcrun notarytool submit '<stage>/notarize.zip' --keychain-profile turnlane-notary --wait --output-format json",
    );
    expect(p).toContain("xcrun stapler staple '<stage>/Turnlane.app'");
    expect(p).toContain("# 5. zip (the stapled app)");
    expect(p.indexOf("stapler staple")).toBeLessThan(p.indexOf("Turnlane-0.7.0.zip"));
    expect(p).toContain("/usr/sbin/spctl -a -vv -t exec /o/Turnlane.app");
    // 名前に空白のある証明書は 1 つの引数として引用する
    expect(p).toContain(`-s '${DEV_ID}'`);
  });

  test("配布用でプロファイルなし: 公証を省いて警告。--skip-notarize なら警告なし", () => {
    expect(plan(DEV_ID, null)).toContain("warning: signed with Developer ID but not notarized");
    const s = plan(DEV_ID, null, { skip: true });
    expect(s).toContain("# 4. notarize: skipped (--skip-notarize)");
    expect(s).not.toContain("warning:");
  });

  test("Apple Development: --timestamp=none で公証を省き、確認もしない", () => {
    const p = plan(APPLE_DEV, null);
    expect(p).toContain("identity: Apple Development (no notarization)");
    expect(p.match(/--timestamp=none/g)).toHaveLength(4);
    expect(p).toContain("# 4. notarize: skipped (not a Developer ID certificate)");
    expect(p).not.toContain("notarytool");
    expect(p).not.toContain("spctl");
  });

  test("ad-hoc（-）: ad-hoc の警告が出る", () => {
    const p = plan("-", null);
    expect(p).toContain("identity: ad-hoc (-)");
    expect(p).toContain("warning: signing Turnlane.app ad-hoc");
    expect(p).not.toContain("notarytool");
  });
});
