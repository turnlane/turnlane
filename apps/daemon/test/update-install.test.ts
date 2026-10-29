/**
 * 更新の置き換え（ADR 0008 の追記 4）: 一時ディレクトリで成功・rename の失敗（前のものを戻す）・書けない・前の回の残り
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultReplaceOps, type ReplaceOps } from "../src/install/bundle.ts";
import { installUpdate } from "../src/update/install.ts";

let root: string;
let apps: string;
let dst: string;
let src: string;

function app(dir: string, version: string): string {
  mkdirSync(join(dir, "Contents"), { recursive: true });
  writeFileSync(join(dir, "Contents", "Info.plist"), `<string>${version}</string>\n`);
  return dir;
}
const version = (p: string) => readFileSync(join(p, "Contents", "Info.plist"), "utf8").trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turnlane-install-"));
  apps = join(root, "Applications");
  dst = app(join(apps, "Turnlane.app"), "0.7.1");
  src = app(join(root, "updates", "0.7.2", "app", "Turnlane.app"), "0.7.2");
});
afterEach(() => {
  chmodSync(apps, 0o755);
  rmSync(root, { recursive: true, force: true });
});

describe("置き換え", () => {
  test("成功: 新しいものが本名に入る。前の版（.Turnlane.app.old）は残す（古い版のプロセスが終わる途中）。元の展開済みは残す", async () => {
    expect(await installUpdate(src, dst)).toBeNull();
    expect(version(dst)).toBe("<string>0.7.2</string>");
    expect(readdirSync(apps).sort()).toEqual([".Turnlane.app.old", "Turnlane.app"]);
    expect(version(join(apps, ".Turnlane.app.old"))).toBe("<string>0.7.1</string>");
    expect(existsSync(src)).toBe(true);
  });

  test("前の回に残した .Turnlane.app.old は次の入れ替えの最初に片付ける", async () => {
    expect(await installUpdate(src, dst)).toBeNull();
    expect(await installUpdate(src, dst)).toBeNull();
    expect(readdirSync(apps).sort()).toEqual([".Turnlane.app.old", "Turnlane.app"]);
    expect(version(join(apps, ".Turnlane.app.old"))).toBe("<string>0.7.2</string>");
  });

  test("配置先が無ければ置くだけ", async () => {
    rmSync(dst, { recursive: true });
    expect(await installUpdate(src, dst)).toBeNull();
    expect(version(dst)).toBe("<string>0.7.2</string>");
  });

  test("新を本名にする rename が失敗したら前のものを戻す（本名の .app を残す）", async () => {
    const ops: ReplaceOps = {
      ...defaultReplaceOps,
      rename: (a, b) => {
        if (a.endsWith(".Turnlane.app.new")) throw Object.assign(new Error("x"), { code: "EIO" });
        renameSync(a, b);
      },
    };
    expect(await installUpdate(src, dst, ops)).toBe("io");
    expect(version(dst)).toBe("<string>0.7.1</string>");
    expect(readdirSync(apps)).toEqual(["Turnlane.app"]);
  });

  test("今のものを old にする rename が失敗したら何も変えない", async () => {
    const ops: ReplaceOps = {
      ...defaultReplaceOps,
      rename: (a) => {
        if (a === dst) throw Object.assign(new Error("x"), { code: "EPERM" });
      },
    };
    expect(await installUpdate(src, dst, ops)).toBe("not_writable");
    expect(version(dst)).toBe("<string>0.7.1</string>");
    expect(readdirSync(apps)).toEqual(["Turnlane.app"]);
  });

  test("写しが失敗したら何も変えない", async () => {
    const ops: ReplaceOps = { ...defaultReplaceOps, copy: async () => false };
    expect(await installUpdate(src, dst, ops)).toBe("io");
    expect(version(dst)).toBe("<string>0.7.1</string>");
    expect(readdirSync(apps)).toEqual(["Turnlane.app"]);
  });

  test("配置先のフォルダに書けなければ not_writable（何も変えない）", async () => {
    chmodSync(apps, 0o555);
    expect(await installUpdate(src, dst)).toBe("not_writable");
    expect(version(dst)).toBe("<string>0.7.1</string>");
  });

  test("展開済みのものが無ければ io", async () => {
    rmSync(src, { recursive: true });
    expect(await installUpdate(src, dst)).toBe("io");
    expect(version(dst)).toBe("<string>0.7.1</string>");
  });

  test("前の回の残り: 本名が無く old だけあれば戻してから入れ替える。.new の残りは消す", async () => {
    renameSync(dst, join(apps, ".Turnlane.app.old"));
    mkdirSync(join(apps, ".Turnlane.app.new"));
    const ops: ReplaceOps = { ...defaultReplaceOps, copy: async () => false };
    expect(await installUpdate(src, dst, ops)).toBe("io");
    expect(version(dst)).toBe("<string>0.7.1</string>");
    expect(readdirSync(apps)).toEqual(["Turnlane.app"]);
    expect(await installUpdate(src, dst)).toBeNull();
    expect(version(dst)).toBe("<string>0.7.2</string>");
  });
});
