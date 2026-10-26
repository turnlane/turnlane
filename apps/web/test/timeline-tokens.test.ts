/**
 * 時間軸の地と AI カードの面のトークン。styles.css のトークンを読んで確かめる:
 * - 時間軸の地（D-105。D-082 の勤務時間のパネルをやめ、地を一様にした）: 地の上の文字のコントラスト比、AI カード・自分のタスクが
 *   地に埋もれないこと、1時間ごとの線の濃さ、目盛りのラベルの濃さ（strongHour / strongRanges。計画の目安）
 * - AI カードの面（D-078。design-system.md の Color tokens、docs/design/README.md の D-078）: 面の上の文字のコントラスト比、
 *   面が running の青と見分けられること、1px の枠線
 * 予定の面は event-surface-tokens.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { strongHour, strongRanges } from "../src/board/TimeGrid.tsx";

const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");

/** テーマのブロック（`:root[data-theme="…"]` から最初の `}` まで）の CSS 変数 */
function tokens(theme: "dark" | "light"): Map<string, string> {
  const start = css.indexOf(`:root[data-theme="${theme}"]`);
  const body = css.slice(start, css.indexOf("}", start));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--dl-[\w-]+):\s*([^;]+);/g))
    out.set(m[1] as string, (m[2] as string).trim());
  return out;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** CIE L*（D65、Y から） */
function lstar(hex: string): number {
  const y = luminance(hex);
  const f = y > 216 / 24389 ? Math.cbrt(y) : ((24389 / 27) * y + 16) / 116;
  return 116 * f - 16;
}

function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const themes = [
  ["light", tokens("light")],
  ["dark", tokens("dark")],
] as const;

const get = (t: Map<string, string>, k: string) => {
  const v = t.get(k);
  if (!v) throw new Error(`${k} が無い`);
  return v;
};
const dL = (a: string, b: string) => Math.abs(lstar(a) - lstar(b));

describe("時間軸の地（D-105）", () => {
  test("勤務時間のパネル・時間外の地のトークンと規則は無い", () => {
    for (const x of ["--dl-off", "--dl-work", ".dl-work", ".dl-ev-out", ".dl-grid-off"])
      expect(css).not.toContain(x);
  });

  test("地の色は D-082 のパネルの色（ライト #FFFFFF、ダーク #16171A）", () => {
    const [l, d] = [themes[0][1], themes[1][1]];
    expect(get(l, "--dl-lane")).toBe("#ffffff");
    expect(get(d, "--dl-lane")).toBe("#16171a");
  });

  for (const [name, t] of themes) {
    test(`${name}: 1時間ごとの線は地との ΔL* 1〜5`, () => {
      const g = dL(get(t, "--dl-lane-grid"), get(t, "--dl-lane"));
      expect(g).toBeGreaterThanOrEqual(1);
      expect(g).toBeLessThanOrEqual(5);
    });

    test(`${name}: 地の上で text-primary / secondary は 4.5:1、tertiary は 3:1 以上`, () => {
      const lane = get(t, "--dl-lane");
      expect(ratio(get(t, "--dl-text-1"), lane)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(get(t, "--dl-text-2"), lane)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(get(t, "--dl-text-3"), lane)).toBeGreaterThanOrEqual(3);
    });

    test(`${name}: 地の上の AI カード・自分のタスクは枠線で埋もれない（枠線と地の ΔL* 10 以上）`, () => {
      const lane = get(t, "--dl-lane");
      expect(dL(get(t, "--dl-ai-line"), lane)).toBeGreaterThanOrEqual(10);
      expect(dL(get(t, "--dl-task-line"), lane)).toBeGreaterThanOrEqual(10);
      expect(dL(get(t, "--dl-task-plan"), lane)).toBeGreaterThanOrEqual(10);
    });

    test(`${name}: AI カード・タスクの面の上でも text-tertiary は 3:1 以上`, () => {
      expect(ratio(get(t, "--dl-text-3"), get(t, "--dl-ai"))).toBeGreaterThanOrEqual(3);
      expect(ratio(get(t, "--dl-text-1"), get(t, "--dl-task"))).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("全時間軸で同じ部品: 地と線を描くのは TimeGrid.tsx だけ", () => {
    const src = join(import.meta.dir, "../src");
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && /\bdl-(grid|ground)\b/.test(readFileSync(p, "utf8")))
          users.push(p.slice(src.length + 1));
      }
    };
    walk(src);
    expect(users).toEqual(["board/TimeGrid.tsx"]);
  });
});

describe("D-105: 目盛りのラベルの濃さ", () => {
  const H = 3_600_000;
  test("計画の目安の時刻（両端を含む）を濃く", () => {
    const strong = [{ start: 10 * H, end: 19 * H }];
    expect([9, 10, 15, 19, 20].map((h) => strongHour(h * H, strong))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  test("列ごとの計画を目盛りの axis に写す（非稼働日は無し）", () => {
    const D = 24 * H;
    const axis = { start: D, end: 2 * D };
    const r = strongRanges(axis, [
      { axis: { start: 0, end: D }, plannedHours: { start: 10 * H, end: 19 * H } },
      {
        axis: { start: 2 * D, end: 3 * D },
        plannedHours: { start: 2 * D + 9 * H, end: 2 * D + 18 * H },
      },
      { axis: { start: 3 * D, end: 4 * D }, plannedHours: null },
    ]);
    expect(r).toEqual([
      { start: D + 10 * H, end: D + 19 * H },
      { start: D + 9 * H, end: D + 18 * H },
    ]);
  });
});

function rule(selector: string): string {
  const i = css.indexOf(`${selector} {`);
  expect(i).toBeGreaterThanOrEqual(0);
  return css.slice(i, css.indexOf("}", css.indexOf(");", i)) + 1);
}

describe("AI カードの面（D-078）", () => {
  for (const theme of ["dark", "light"] as const) {
    const t = tokens(theme);
    const tok = (k: string) => {
      const v = t.get(k);
      if (!v) throw new Error(`${theme}: ${k} が無い`);
      return v;
    };

    test(`${theme}: 面とホバーの上で text-primary / secondary は 4.5:1、tertiary は 3:1 以上`, () => {
      for (const face of [tok("--dl-ai"), tok("--dl-ai-hover")]) {
        expect(ratio(tok("--dl-text-1"), face)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(tok("--dl-text-2"), face)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(tok("--dl-text-3"), face)).toBeGreaterThanOrEqual(3);
      }
    });

    test(`${theme}: 面は旧 sunken と別の色で、枠線は面より背景から遠い`, () => {
      expect(tok("--dl-ai").toLowerCase()).not.toBe(tok("--dl-sunken").toLowerCase());
      expect(ratio(tok("--dl-ai-line"), tok("--dl-bg"))).toBeGreaterThan(
        ratio(tok("--dl-ai"), tok("--dl-bg")),
      );
      expect(ratio(tok("--dl-ai-line-hover"), tok("--dl-bg"))).toBeGreaterThan(
        ratio(tok("--dl-ai-line"), tok("--dl-bg")),
      );
    });

    test(`${theme}: 面は running の青と見間違えない（面と青の比が 3:1 以上）`, () => {
      expect(ratio(tok("--dl-ai"), tok("--dl-running"))).toBeGreaterThanOrEqual(3);
    });
  }

  test("ライトの面はほんのり青い（B が R より大きい）", () => {
    const face = tokens("light").get("--dl-ai") as string;
    const n = Number.parseInt(face.replace("#", ""), 16);
    expect(n & 255).toBeGreaterThan((n >> 16) & 255);
  });

  test("AI カードは 1px の枠線を持ち、ホバーで枠線を濃くする", () => {
    expect(rule(".dl-ai")).toContain("inset 0 0 0 1px var(--dl-ai-line)");
    expect(rule(".dl-ai:hover")).toContain("var(--dl-ai-line-hover)");
  });
});
