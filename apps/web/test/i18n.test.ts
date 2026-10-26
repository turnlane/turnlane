/**
 * i18n の検査（M2-12、M2-20）: 日本語の辞書に欠けが無い、JSX に直書きした文字列が無い。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { en } from "../src/i18n/en.ts";
import { translate } from "../src/i18n/index.tsx";
import { ja } from "../src/i18n/ja.ts";

const SRC = join(import.meta.dir, "../src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

describe("i18n", () => {
  test("日本語の辞書は英語のキーと同じ（欠けも余りも無い。M2-20）", () => {
    const enKeys = Object.keys(en);
    const extra = Object.keys(ja).filter((k) => !enKeys.includes(k));
    expect(extra).toEqual([]);
    const missing = enKeys.filter((k) => !(k in ja));
    expect(missing).toEqual([]);
  });

  test("複数形と差し込み、欠けたキーは英語", () => {
    expect(translate("en", "board.moreRows", { count: 3 })).toBe("+3 more");
    expect(translate("en", "queue.closed.expired", { count: 1 })).toBe("1 expired");
    expect(translate("ja", "board.moreRows", { count: 3 })).toBe("ほか 3 件");
    expect(translate("ja", "sources.tool.codex")).toBe("Codex");
  });

  test("JSX に直書きした文字列が無い（辞書を通す）", () => {
    // 許す: 記号・数字・空白、mono の ASCII 記号（~ · ↺ など）、開発用の部品一覧
    const allowed = /^[\s\d·~↺+\-–:/#()?!.,|…⇥⌘KZ⏎⇧]*$/;
    const bad: string[] = [];
    for (const f of files(SRC)) {
      if (f.endsWith("DevComponents.tsx")) continue;
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      // >テキスト< の形（式 {..} や タグの中ではないもの）
      for (const m of src.matchAll(/>([^<>{}]+)</g)) {
        const text = (m[1] ?? "").trim();
        if (!text || allowed.test(text)) continue;
        // ジェネリクス・比較式・式の断片の誤検出を除く
        if (/[=;()&?]|^[A-Za-z_]\w*(\.\w+)+$/.test(text)) continue;
        if (/^[a-z_]\w*$/.test(text) && !f.endsWith("health.tsx")) continue;
        bad.push(`${f.slice(SRC.length + 1)}: ${text}`);
      }
      for (const m of src.matchAll(
        /\b(title|placeholder|aria-label|alt)="([^"]*[A-Za-z぀-ヿ一-龯][^"]*)"/g,
      ))
        bad.push(`${f.slice(SRC.length + 1)}: ${m[1]}="${m[2]}"`);
    }
    expect(bad).toEqual([]);
  });
});
