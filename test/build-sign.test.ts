import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPILE_FLAGS,
  codesignIdentifier,
  codesignIdentity,
  ENTITLEMENTS,
  signBinary,
  signCommand,
} from "../scripts/build.ts";

// D-060: TURNLANE_CODESIGN_IDENTITY があれば turnlaned / turnlane を同じ証明書で署名し直す。
// 実際の証明書はキーチェーンの確認が要るのでここでは使わず、コマンドの組み立てと ad-hoc（-）での一連の手順を確かめる。

let dir: string;
let bin: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "turnlane-sign-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    'if (process.argv.includes("--version")) console.log("tiny 0.0.0+test"); else process.exit(3);\n',
  );
  bin = join(dir, "tiny");
  const p = Bun.spawnSync([process.execPath, "build", ...COMPILE_FLAGS, entry, "--outfile", bin], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("codesignIdentity: 未設定・空白だけなら null（今までどおり署名し直さない）", () => {
  expect(codesignIdentity({})).toBeNull();
  expect(codesignIdentity({ TURNLANE_CODESIGN_IDENTITY: "" })).toBeNull();
  expect(codesignIdentity({ TURNLANE_CODESIGN_IDENTITY: "  " })).toBeNull();
  expect(codesignIdentity({ TURNLANE_CODESIGN_IDENTITY: " Apple Development: A (X) " })).toBe(
    "Apple Development: A (X)",
  );
});

test("signCommand: identity 指定時は hardened runtime・JIT の entitlements・固定の識別子で署名する", () => {
  const id = "Apple Development: Someone (ABCDE12345)";
  expect(signCommand("/x/out/turnlaned", "turnlaned", id)).toEqual([
    "codesign",
    "--force",
    "--options",
    "runtime",
    "--timestamp=none",
    "--entitlements",
    ENTITLEMENTS,
    "--identifier",
    "dev.turnlane.turnlaned",
    "-s",
    id,
    "/x/out/turnlaned",
  ]);
  // 名前に空白があっても1つの引数として渡す（シェルを通さない）
  expect(signCommand("/x/out/turnlane", "turnlane", id).filter((a) => a === id)).toHaveLength(1);
  expect(codesignIdentifier("turnlane")).toBe("dev.turnlane.turnlane");
});

test("entitlements は plist として正しく、allow-jit だけを持つ", () => {
  const p = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", ENTITLEMENTS], {
    stdout: "pipe",
  });
  expect(p.exitCode).toBe(0);
  expect(JSON.parse(p.stdout.toString())).toEqual({ "com.apple.security.cs.allow-jit": true });
});

test("signBinary（ad-hoc）: 署名・検証・起動確認が通り、識別子と runtime と entitlements が付く", () => {
  signBinary(bin, "tiny", "-");
  const p = Bun.spawnSync(["codesign", "-d", "--verbose=2", "--entitlements", "-", bin], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const info = `${p.stdout.toString()}${p.stderr.toString()}`;
  expect(info).toContain("Identifier=dev.turnlane.tiny");
  expect(info).toMatch(/flags=0x[0-9a-f]+\([^)]*runtime/);
  expect(info).toContain("com.apple.security.cs.allow-jit");
}, 30_000);

test("signBinary: --version の出力が名前で始まらなければ失敗する", () => {
  expect(() => signBinary(bin, "other", "-")).toThrow(/unexpected/);
}, 30_000);

test("signBinary: 存在しない証明書なら失敗する", () => {
  expect(() => signBinary(bin, "tiny", "turnlane-test-no-such-identity")).toThrow(/codesign/);
}, 30_000);
