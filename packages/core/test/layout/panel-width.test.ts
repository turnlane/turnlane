/** 右の詳細パネルの幅（ux-mvp 4.12.1）: 既定・最小・画面の幅から決まる最大 */
import { describe, expect, test } from "bun:test";
import {
  clampPanelWidth,
  PANEL_MAIN_MIN,
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_LIMIT,
  PANEL_WIDTH_MIN,
  panelWidthMax,
} from "../../src/layout/panel-width.ts";

describe("panelWidthMax", () => {
  test("パネルの左に PANEL_MAIN_MIN を残す", () => {
    // 1440 の窓でサイドバー 220 → 行は 1220
    expect(panelWidthMax(1220)).toBe(1220 - PANEL_MAIN_MIN);
    expect(panelWidthMax(1060)).toBe(1060 - PANEL_MAIN_MIN);
  });
  test("狭い窓でも既定の幅より狭くしない（ドラッグしない人の見た目は変えない）", () => {
    expect(panelWidthMax(800)).toBe(PANEL_WIDTH_DEFAULT);
    expect(panelWidthMax(200)).toBe(PANEL_WIDTH_DEFAULT);
  });
  test("広い窓でも保存できる上限まで。測れていなければ上限", () => {
    expect(panelWidthMax(5000)).toBe(PANEL_WIDTH_LIMIT);
    expect(panelWidthMax(null)).toBe(PANEL_WIDTH_LIMIT);
    expect(panelWidthMax(0)).toBe(PANEL_WIDTH_LIMIT);
  });
});

describe("clampPanelWidth", () => {
  test("null・壊れた値は既定", () => {
    expect(clampPanelWidth(null, 1220)).toBe(PANEL_WIDTH_DEFAULT);
    expect(clampPanelWidth(undefined, 1220)).toBe(PANEL_WIDTH_DEFAULT);
    expect(clampPanelWidth(Number.NaN, 1220)).toBe(PANEL_WIDTH_DEFAULT);
  });
  test("最小と最大で止める", () => {
    expect(clampPanelWidth(100, 1220)).toBe(PANEL_WIDTH_MIN);
    expect(clampPanelWidth(500, 1220)).toBe(500);
    expect(clampPanelWidth(900, 1220)).toBe(1220 - PANEL_MAIN_MIN);
  });
  test("窓を狭めると収め、広げれば保存した幅に戻る", () => {
    expect(clampPanelWidth(560, 1060)).toBe(1060 - PANEL_MAIN_MIN);
    expect(clampPanelWidth(560, 1220)).toBe(560);
  });
  test("既定の幅は狭い窓でもそのまま", () => {
    expect(clampPanelWidth(null, 900)).toBe(PANEL_WIDTH_DEFAULT);
  });
});
