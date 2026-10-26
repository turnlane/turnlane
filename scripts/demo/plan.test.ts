import { describe, expect, test } from "bun:test";
import {
  CUTS_3,
  CUTS_12,
  cropOf,
  FRAMES,
  FREEZE_AT,
  FULL_END,
  SCENE12_END,
  SUBTITLES,
  subtitlesWithin,
} from "./plan.ts";

describe("demo video plan (M6-30)", () => {
  test("cuts cover 0 to the freeze without gaps", () => {
    const cuts = [...CUTS_12, ...CUTS_3];
    expect(cuts[0]?.from).toBe(0);
    for (const [i, c] of cuts.entries()) {
      expect(c.to).toBeGreaterThan(c.from);
      if (i > 0) expect(c.from).toBe(cuts[i - 1]?.to as number);
    }
    expect(CUTS_12.at(-1)?.to).toBe(SCENE12_END);
    expect(CUTS_3.at(-1)?.to).toBe(FREEZE_AT);
  });

  test("subtitles cover the whole video without gaps", () => {
    expect(SUBTITLES[0]?.from).toBe(0);
    for (const [i, s] of SUBTITLES.entries())
      if (i > 0) expect(s.from).toBe(SUBTITLES[i - 1]?.to as number);
    expect(SUBTITLES.at(-1)?.to).toBe(FULL_END);
  });

  test("frames are 16:10 and stay on the 1440×900 stage", () => {
    for (const [x, y, w, h] of Object.values(FRAMES)) {
      expect(w / h).toBeCloseTo(1.6, 5);
      expect(x + w).toBeLessThanOrEqual(1440);
      expect(y + h).toBeLessThanOrEqual(900);
    }
    expect(cropOf("F2")).toBe("1536:960:784:244");
  });

  test("the repository URL is only in the English closing line (D-259)", () => {
    const last = SUBTITLES.at(-1);
    expect(last?.text.en).toContain("github.com/turnlane/turnlane");
    expect(SUBTITLES.some((s) => s.text.ja.includes("github.com"))).toBe(false);
  });

  test("subtitlesWithin cuts at the end of scenes (1)(2)", () => {
    const s = subtitlesWithin(SCENE12_END);
    expect(s).toHaveLength(5);
    expect(s.at(-1)?.to).toBe(SCENE12_END);
  });
});
