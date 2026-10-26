/**
 * 画面の設定（テーマ・言語。M2-11・M2-12）。setting の ui.theme / ui.language に置く（端末ごと。local_only）。
 * キーの割り当ての上書き（ui.keybindings。D-077）、集中モードの設定（focus.*。D-097、m2-api 25章）、右の詳細パネルの幅
 * （ui.panel_width。ux-mvp 4.12.1）もここで返す。閉店モードと朝の計画の案内の設定は D-192 で廃止した
 */
import { type DB, getSetting, KEYBINDINGS_SCHEMA, PANEL_WIDTH_SCHEMA } from "@turnlane/core";
import { DEFAULT_FOCUS_SETTINGS, type FocusSettings } from "@turnlane/core/web";
import type { LanguageSetting, ThemeSetting, UiPrefs } from "../http/planner-routes.ts";

const THEMES: readonly string[] = ["system", "light", "dark"];
const LANGS: readonly string[] = ["system", "en", "ja"];

export function readUiPrefs(db: DB): UiPrefs {
  const get = <V = string>(k: string) => {
    try {
      return getSetting<V>(db, k);
    } catch {
      return undefined;
    }
  };
  const t = get("ui.theme");
  const l = get("ui.language");
  return {
    theme: (t && THEMES.includes(t) ? t : "system") as ThemeSetting,
    language: (l && LANGS.includes(l) ? l : "system") as LanguageSetting,
    keybindings: keybindings(get<unknown>("ui.keybindings")),
    focusPrompt: get<boolean>("focus.prompt") !== false,
    focusTarget: get<string>("focus.target") === "busy" ? "busy" : "meetings",
    focusLeadMin: leadMin(get<unknown>("focus.lead_min")),
    focusAuto: get<boolean>("focus.auto") === true,
    focusAllowNeedsInput: get<boolean>("focus.allow_needs_input") === true,
    focusNotifyEnd: get<boolean>("focus.notify_end") !== false,
    panelWidth: panelWidth(get<unknown>("ui.panel_width")),
  };
}

/** 集中モードの設定（FocusService・NotifyRunner が使う形） */
export function focusSettings(p: UiPrefs): FocusSettings {
  return {
    prompt: p.focusPrompt,
    target: p.focusTarget,
    leadMin: p.focusLeadMin,
    auto: p.focusAuto,
    allowNeedsInput: p.focusAllowNeedsInput,
    notifyEnd: p.focusNotifyEnd,
  };
}

function leadMin(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 30
    ? v
    : DEFAULT_FOCUS_SETTINGS.leadMin;
}

/** 壊れた値は空（既定のまま）にする */
function keybindings(v: unknown): Record<string, string[]> {
  const r = KEYBINDINGS_SCHEMA.safeParse(v ?? {});
  return r.success ? r.data : {};
}

/** 壊れた値は null（既定の幅） */
function panelWidth(v: unknown): number | null {
  const r = PANEL_WIDTH_SCHEMA.safeParse(v ?? null);
  return r.success ? r.data : null;
}
