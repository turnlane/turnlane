/**
 * D-086: 予定の面をカレンダー色に戻す（D-082 のグレーの面は、ライトで勤務時間外の地と同じ色に見えた）。
 * styles.css のトークンを読み、代表的なカレンダー色ごとに予定の面（時間軸の地の色にカレンダー色を混ぜた不透明の面）を計算して、
 * 文字のコントラスト比、地・AI カードの面との色差（CIE76 ΔE）を確かめる。D-105 で地を一様にし、時間外の枠線だけの予定はやめた。
 * 値と比の表は docs/design/README.md の D-086、design-system.md の Color tokens。
 * D-125: Turnlane の中で選ぶカレンダーの色のパレット（`--dl-cal-<key>`。テーマごとの値）も同じ検査に入れる（R52）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CALENDAR_COLOR_KEYS } from "@turnlane/core/web";

const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");

function tokens(theme: "dark" | "light"): Map<string, string> {
  const start = css.indexOf(`:root[data-theme="${theme}"]`);
  const body = css.slice(start, css.indexOf("}", start));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--dl-[\w-]+):\s*([^;]+);/g))
    out.set(m[1] as string, (m[2] as string).trim());
  return out;
}

/** var(--x) を同じテーマの値に解く */
function get(t: Map<string, string>, k: string): string {
  const v = t.get(k);
  if (!v) throw new Error(`${k} が無い`);
  const ref = /^var\((--dl-[\w-]+)\)$/.exec(v);
  return ref ? get(t, ref[1] as string) : v;
}
const pct = (v: string) => Number.parseFloat(v) / 100;

const rgb = (hex: string) => {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
};
const hexOf = (c: readonly number[]) =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
/** color-mix(in srgb, a p, b) */
const mix = (a: string, p: number, b: string) => {
  const [x, y] = [rgb(a), rgb(b)];
  return hexOf(x.map((v, i) => v * p + (y[i] as number) * (1 - p)));
};
const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(lin) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
const lab = (hex: string) => {
  const [r, g, b] = rgb(hex).map(lin) as [number, number, number];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const X = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const Y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const Z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)] as const;
};
const dE = (a: string, b: string) => {
  const [x, y] = [lab(a), lab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

/** 代表的なカレンダー色（macOS カレンダー・Google カレンダーの既定色、dev-board のダミーの色） */
const CALENDAR_COLORS = {
  "blue (macOS)": "#1badf8",
  "blue (Google)": "#4285f4",
  "blue (dev-board)": "#6b8cc7",
  "teal (dev-board)": "#4fb3a9",
  "teal (Google Peacock)": "#039be5",
  "green (macOS)": "#63da38",
  "green (Google Basil)": "#0b8043",
  "red (macOS)": "#ff2968",
  "red (dev-board)": "#e5484d",
  "purple (macOS)": "#cc73e1",
  "purple (dev-board)": "#9b7cf0",
  "gray (macOS)": "#8e8e93",
  "graphite (Google)": "#616161",
} as const;
const GRAYS = new Set(["gray (macOS)", "graphite (Google)"]);

const themes = [
  ["light", tokens("light")],
  ["dark", tokens("dark")],
] as const;

const rule = (sel: string) => {
  const i = css.indexOf(`${sel} {`);
  return css.slice(i, css.indexOf("}", i));
};

describe("予定の面のトークン（D-086 → D-103: 塗りだけ）", () => {
  test("両テーマとも 30%（ホバー 36%）。文字は時刻も text-primary（確定デザインの event-surface）", () => {
    for (const [, t] of themes) {
      expect([t.get("--dl-ev-tint"), t.get("--dl-ev-tint-hover")]).toEqual(["30%", "36%"]);
      expect(t.get("--dl-ev-meta")).toBe("var(--dl-text-1)");
    }
    expect(css).not.toMatch(/--dl-ev:\s/);
  });

  test("面は地の色に混ぜた不透明の色。左の線・枠線は無い（縦の線は AI の作業だけ。D-103）", () => {
    const ev = rule(".dl-ev");
    expect(ev).toContain("color-mix(in srgb, var(--ev) var(--dl-ev-tint), var(--dl-lane))");
    expect(ev).not.toContain("box-shadow");
    expect(ev).not.toContain("border");
    expect(rule(".dl-ev:hover")).toContain("var(--dl-ev-tint-hover), var(--dl-lane)");
  });

  test("時間外の枠線だけの予定は無い（D-105）", () => {
    expect(css).not.toContain(".dl-ev-out");
  });
});

for (const [name, t] of themes) {
  const work = get(t, "--dl-lane");
  const ai = get(t, "--dl-ai");
  const [t1, meta] = ["--dl-text-1", "--dl-ev-meta"].map((k) => get(t, k)) as [string, string];
  describe(`${name}: 代表的なカレンダー色の予定の面`, () => {
    for (const [cal, c] of Object.entries(CALENDAR_COLORS)) {
      const face = mix(c, pct(get(t, "--dl-ev-tint")), work);
      const hover = mix(c, pct(get(t, "--dl-ev-tint-hover")), work);
      test(`${cal}: 題名・時刻・終日の行（text-primary）は 4.5:1 以上（ホバーも）`, () => {
        for (const f of [face, hover]) {
          expect(ratio(t1, f)).toBeGreaterThanOrEqual(4.5);
          expect(ratio(meta, f)).toBeGreaterThanOrEqual(4.5);
        }
      });
      if (!GRAYS.has(cal))
        test(`${cal}: 面は地（ΔE 6 以上）・AI カードの面（ΔE 4 以上）と見分けられる`, () => {
          expect(dE(face, work)).toBeGreaterThanOrEqual(6);
          expect(dE(face, ai)).toBeGreaterThanOrEqual(4);
        });
    }
  });
}

describe("カレンダーの色のパレット（D-125。R52）", () => {
  test("12色のキーそれぞれに、両テーマの値（#rrggbb）がある", () => {
    expect(CALENDAR_COLOR_KEYS.length).toBe(12);
    for (const [, t] of themes)
      for (const k of CALENDAR_COLOR_KEYS) expect(t.get(`--dl-cal-${k}`)).toMatch(/^#[0-9a-f]{6}$/);
  });

  for (const [name, t] of themes) {
    const work = get(t, "--dl-lane");
    const ai = get(t, "--dl-ai");
    const t1 = get(t, "--dl-text-1");
    const faces = CALENDAR_COLOR_KEYS.map(
      (k) => [k, mix(get(t, `--dl-cal-${k}`), pct(get(t, "--dl-ev-tint")), work)] as const,
    );
    for (const [k, face] of faces) {
      const c = get(t, `--dl-cal-${k}`);
      const hover = mix(c, pct(get(t, "--dl-ev-tint-hover")), work);
      test(`${name} ${k}: 題名・時刻（text-primary）は面とホバーの面で 4.5:1 以上`, () => {
        expect(ratio(t1, face)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t1, hover)).toBeGreaterThanOrEqual(4.5);
      });
      if (k !== "gray")
        test(`${name} ${k}: 面は地（ΔE 6 以上）・AI カードの面（ΔE 4 以上）と見分けられる`, () => {
          expect(dE(face, work)).toBeGreaterThanOrEqual(6);
          expect(dE(face, ai)).toBeGreaterThanOrEqual(4);
        });
    }
    test(`${name}: パレットの面どうしは見分けられる（どの2色も ΔE 5 以上）`, () => {
      for (let i = 0; i < faces.length; i++)
        for (let j = i + 1; j < faces.length; j++) {
          const [a, fa] = faces[i] as (typeof faces)[number];
          const [b, fb] = faces[j] as (typeof faces)[number];
          expect({ pair: `${a}/${b}`, ok: dE(fa, fb) >= 5 }).toEqual({
            pair: `${a}/${b}`,
            ok: true,
          });
        }
    });
  }
});

describe("集中モード中の帯（ux-mvp 4.15、README R18）", () => {
  for (const theme of ["dark", "light"] as const) {
    const tk = tokens(theme);
    const face = get(tk, "--dl-focus-surface");
    test(`${theme}: 藍の面の上で文字が読める（primary・secondary 4.5:1、区切りの tertiary 3:1）、線とアイコンは 3:1`, () => {
      expect(ratio(get(tk, "--dl-text-1"), face)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(get(tk, "--dl-text-2"), face)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(get(tk, "--dl-text-3"), face)).toBeGreaterThanOrEqual(3);
      expect(ratio(get(tk, "--dl-focus"), face)).toBeGreaterThanOrEqual(3);
    });
    test(`${theme}: 面はふだんの地・沈んだ面と見分けられる（ΔE 6 以上）`, () => {
      expect(dE(face, get(tk, "--dl-bg"))).toBeGreaterThanOrEqual(6);
      expect(dE(face, get(tk, "--dl-sunken"))).toBeGreaterThanOrEqual(6);
      expect(dE(face, get(tk, "--dl-raised"))).toBeGreaterThanOrEqual(6);
    });
  }
});
