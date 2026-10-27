/**
 * 取得した更新の検証（ADR 0008 の追記 4）。合成のバンドルを ad-hoc 署名（codesign -s -）して、本物の codesign で
 * 「署名は通るが TeamIdentifier が無い → 拒否」「改ざん → 拒否」を見る。実在の証明書は使わない。
 * Team ID の一致・版・spctl は偽のコマンドで見る
 */
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCodesignInfo,
  type RunCommand,
  runCommand,
  signatureKindOf,
} from "../src/install/bundle.ts";
import { verifyUpdate } from "../src/update/verify.ts";

const work = mkdtempSync(join(tmpdir(), "turnlane-verify-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function plist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>turnlane</string>
  <key>CFBundleIdentifier</key>
  <string>dev.turnlane.update-test</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
</dict>
</plist>
`;
}

/** 合成の .app（実行ファイルは /usr/bin/true の写し）。sign なら ad-hoc で署名する */
function makeApp(name: string, version: string, o: { sign?: boolean } = {}): string {
  const app = join(work, name, "Turnlane.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), plist(version));
  copyFileSync("/usr/bin/true", join(app, "Contents", "MacOS", "turnlane"));
  writeFileSync(join(app, "Contents", "Resources", "data.txt"), "original\n");
  if (o.sign) {
    const p = Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", "-", app], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) throw new Error(`codesign failed: ${p.stderr.toString()}`);
  }
  return app;
}

/** 偽のコマンド: codesign --verify・spctl は ok の値、codesign -dv は app ごとの Team ID を返す */
function fake(o: { verify?: number; spctl?: number; teams: Record<string, string | null> }): {
  run: RunCommand;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: RunCommand = async (cmd) => {
    calls.push([...cmd]);
    const app = cmd.at(-1) ?? "";
    if (cmd[0] === "/usr/bin/codesign" && cmd[1] === "--verify")
      return { code: o.verify ?? 0, out: "" };
    if (cmd[0] === "/usr/bin/codesign" && cmd[1] === "-dv") {
      const t = o.teams[app];
      return {
        code: 0,
        out: `Executable=${app}\nAuthority=Developer ID Application: Example (X)\nTeamIdentifier=${t ?? "not set"}\n`,
      };
    }
    if (cmd[0] === "/usr/sbin/spctl") return { code: o.spctl ?? 0, out: "" };
    return { code: 127, out: "" };
  };
  return { run, calls };
}

const TEAM = "ABCDE12345";

describe("合成のバンドル（ad-hoc 署名、本物の codesign）", () => {
  test("署名は通るが TeamIdentifier が無い → team_id で拒否", async () => {
    const self = makeApp("self", "0.7.1", { sign: true });
    const app = makeApp("new", "0.7.2", { sign: true });
    // codesign --verify は通る
    expect(
      (await runCommand(["/usr/bin/codesign", "--verify", "--deep", "--strict", app])).code,
    ).toBe(0);
    const err = await verifyUpdate(app, {
      expectedVersion: "0.7.2",
      currentVersion: "0.7.1",
      selfApp: self,
    });
    expect(err).toBe("team_id");
  });

  test("署名の後に中身を書き換えた → signature で拒否", async () => {
    const self = makeApp("self2", "0.7.1", { sign: true });
    const app = makeApp("tampered", "0.7.2", { sign: true });
    writeFileSync(join(app, "Contents", "Resources", "data.txt"), "changed\n");
    expect(
      await verifyUpdate(app, { expectedVersion: "0.7.2", currentVersion: "0.7.1", selfApp: self }),
    ).toBe("signature");
  });

  test("未署名 → signature で拒否", async () => {
    const app = makeApp("unsigned", "0.7.2");
    expect(
      await verifyUpdate(app, { expectedVersion: "0.7.2", currentVersion: "0.7.1", selfApp: app }),
    ).toBe("signature");
  });

  test("codesign -dv の読み取り: ad-hoc は TeamIdentifier なし", async () => {
    const app = makeApp("read", "0.7.2", { sign: true });
    const r = await runCommand(["/usr/bin/codesign", "-dv", "--verbose=2", app]);
    const info = parseCodesignInfo(r.code, r.out);
    expect(info).toMatchObject({ signed: true, adhoc: true, teamId: null });
    expect(signatureKindOf(info)).toBe("ad-hoc");
  });
});

describe("Team ID・版・公証（偽のコマンド）", () => {
  const self = join(work, "fake-self", "Turnlane.app");
  const app = () => makeApp("fake-new", "0.7.2");
  const opts = (run: RunCommand, o: Partial<Parameters<typeof verifyUpdate>[1]> = {}) => ({
    expectedVersion: "0.7.2",
    currentVersion: "0.7.1",
    selfApp: self,
    run,
    ...o,
  });

  test("全部通れば null。順に codesign --verify → -dv（自分と新）→ spctl", async () => {
    const a = app();
    const f = fake({ teams: { [self]: TEAM, [a]: TEAM } });
    expect(await verifyUpdate(a, opts(f.run))).toBeNull();
    expect(f.calls.map((c) => `${c[0]} ${c[1]}`)).toEqual([
      "/usr/bin/codesign --verify",
      "/usr/bin/codesign -dv",
      "/usr/bin/codesign -dv",
      "/usr/sbin/spctl --assess",
    ]);
  });

  test("Team ID が自分と違う・自分に無い・自分の場所が分からない → team_id", async () => {
    const a = app();
    expect(
      await verifyUpdate(a, opts(fake({ teams: { [self]: TEAM, [a]: "ZZZZZ99999" } }).run)),
    ).toBe("team_id");
    expect(await verifyUpdate(a, opts(fake({ teams: { [self]: null, [a]: TEAM } }).run))).toBe(
      "team_id",
    );
    expect(await verifyUpdate(a, opts(fake({ teams: { [a]: TEAM } }).run, { selfApp: null }))).toBe(
      "team_id",
    );
  });

  test("Info.plist の版が latest と違う・今より新しくない → version", async () => {
    const a = app();
    const f = fake({ teams: { [self]: TEAM, [a]: TEAM } });
    expect(await verifyUpdate(a, opts(f.run, { expectedVersion: "0.7.3" }))).toBe("version");
    expect(await verifyUpdate(a, opts(f.run, { currentVersion: "0.7.2" }))).toBe("version");
  });

  test("spctl が受け付けない → notarization。codesign --verify が落ちれば先に signature", async () => {
    const a = app();
    expect(
      await verifyUpdate(a, opts(fake({ spctl: 3, teams: { [self]: TEAM, [a]: TEAM } }).run)),
    ).toBe("notarization");
    const f = fake({ verify: 1, teams: { [self]: TEAM, [a]: TEAM } });
    expect(await verifyUpdate(a, opts(f.run))).toBe("signature");
    expect(f.calls).toHaveLength(1);
  });
});

describe("codesign -dv の読み取り（parseCodesignInfo）", () => {
  test.each([
    [
      0,
      "Authority=Developer ID Application: X (ABCDE12345)\nTeamIdentifier=ABCDE12345\n",
      "Developer ID Application",
      "ABCDE12345",
    ],
    [
      0,
      "Authority=Apple Development: X (Y)\nTeamIdentifier=ABCDE12345\n",
      "Apple Development",
      "ABCDE12345",
    ],
    [0, "Signature=adhoc\nTeamIdentifier=not set\n", "ad-hoc", null],
    [0, "Authority=Something\nTeamIdentifier=bad id\n", "other", null],
    [1, "code object is not signed at all\n", "unsigned", null],
  ] as const)("%#", (code, out, kind, team) => {
    const i = parseCodesignInfo(code, out);
    expect(signatureKindOf(i)).toBe(kind);
    expect(i.teamId).toBe(team);
  });
});
