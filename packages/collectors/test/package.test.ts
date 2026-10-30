import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import template from "../src/adapters/_template/index.ts";
import {
  ADAPTER_API_VERSION,
  builtinAdapters,
  defineAdapter,
  satisfiesRange,
  toolId,
} from "../src/index.ts";

const PKG = join(import.meta.dir, "..");

/** collectors に入れてよい外部依存（MIT と両立し、PR で理由を書いたもの）。Phase0 はゼロ */
const ALLOWED_DEPENDENCIES: readonly string[] = [];

describe("collectors のパッケージ境界（phase0-plan 3.1.1）", () => {
  test("dependencies は許可リストの中だけ", () => {
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      exports: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps.filter((d) => !ALLOWED_DEPENDENCIES.includes(d))).toEqual([]);
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./hook-allowlist", "./testing"]);
  });

  test("hook-allowlist.ts は import を持たない（ADR 0009）", () => {
    const src = readFileSync(join(PKG, "src/hook-allowlist.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import\b/m);
  });

  test("src 配下は child_process・net・http・bun:sqlite を使わない", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(PKG, "src"));
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect({
        f,
        hit: /from "(node:)?(child_process|net|http|https|dgram|bun:sqlite)"|Bun\.spawn|fetch\(/.test(
          src,
        ),
      }).toEqual({ f, hit: false });
    }
  });

  test("同梱アダプタの ToolId は一意で、apiVersion が揃っている", () => {
    const ids: string[] = builtinAdapters.map((a) => a.tool);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["claude_code", "codex", "hook_spool", "report"]);
    for (const a of builtinAdapters) expect(a.apiVersion).toBe(ADAPTER_API_VERSION);
    expect(template.tool as string).toBe("template_tool");
  });

  test("defineAdapter: ToolId の書式と、許可リストの本文系キーを拒否する", () => {
    expect(() => toolId("Claude")).toThrow();
    expect(() => toolId("x")).toThrow();
    expect(toolId("my_tool2") as string).toBe("my_tool2");
    const base = { ...template };
    expect(() =>
      defineAdapter({ ...base, allowlist: { user: ["message.content[].text"] } }),
    ).toThrow(/body key/);
    expect(() => defineAdapter({ ...base, allowlist: { user: ["prompt"] } })).toThrow(/body key/);
    expect(() =>
      defineAdapter({ ...base, allowlist: { user: ["message.content[].type"] } }),
    ).not.toThrow();
  });

  test("satisfiesRange", () => {
    expect(satisfiesRange("2.1.287", ">=2.1.0 <2.2.0")).toBe(true);
    expect(satisfiesRange("2.2.0", ">=2.1.0 <2.2.0")).toBe(false);
    expect(satisfiesRange("0.147.0", ">=0.147.0 <0.160.0")).toBe(true);
    expect(satisfiesRange("0.146.9", ">=0.147.0 <0.160.0")).toBe(false);
    expect(satisfiesRange("whatever", ">=1.0.0")).toBe(true);
    expect(satisfiesRange("1.0.0", "*")).toBe(true);
  });
});
