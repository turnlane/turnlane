/** build.ts --ext（ADR 0015）: extension.json の読み込みと、組み込む一覧のモジュール */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  daemonListSource,
  extArgs,
  readExtManifest,
  readExtManifests,
  webListSource,
} from "../scripts/ext-manifest.ts";

const FIXTURE = resolve(import.meta.dir, "ext-fixture");

describe("拡張の組み込み", () => {
  test("指定なし（公開のビルド）: デーモンの一覧は空、Web は空の実装のまま", () => {
    expect(daemonListSource([])).toContain(
      "export const extensions: DaemonExtensionFactory[] = [];",
    );
    expect(webListSource([])).toBeNull();
  });

  test("テスト用の拡張: 両方の入口を絶対パスで import する", () => {
    const m = readExtManifest(FIXTURE);
    expect(m.id).toBe("test");
    expect(m.daemon).toBe(resolve(import.meta.dir, "../apps/daemon/test/ext-fixture/daemon.ts"));
    const d = daemonListSource([m]);
    expect(d).toContain(`import ext0 from ${JSON.stringify(m.daemon)};`);
    expect(d).toContain("= [ext0];");
    expect(webListSource([m])).toContain(`import ext0 from ${JSON.stringify(m.web)};`);
  });

  test("--ext を繰り返せる。id の重複・壊れた extension.json は失敗", () => {
    expect(extArgs(["--skip-web", "--ext", "a", "--out", "o", "--ext", "b"])).toEqual(["a", "b"]);
    expect(() => readExtManifests([FIXTURE, FIXTURE])).toThrow(/duplicate/);
    const dir = mkdtempSync(join(tmpdir(), "turnlane-extm-"));
    try {
      expect(() => readExtManifest(dir)).toThrow(/extension.json/);
      writeFileSync(join(dir, "extension.json"), JSON.stringify({ id: "x1", daemon: "/abs.ts" }));
      expect(() => readExtManifest(dir)).toThrow(/relative/);
      writeFileSync(join(dir, "extension.json"), JSON.stringify({ id: "Bad" }));
      expect(() => readExtManifest(dir)).toThrow(/invalid id/);
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "d.ts"), "export default () => ({});\n");
      writeFileSync(join(dir, "extension.json"), JSON.stringify({ id: "x1", daemon: "src/d.ts" }));
      expect(readExtManifest(dir)).toMatchObject({ id: "x1", web: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
