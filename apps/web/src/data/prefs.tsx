/**
 * 画面の設定（テーマと言語。M2-11・M2-12）。デーモンの setting（ui.theme / ui.language）に保存し、
 * 起動時のちらつきを避けるため localStorage にも写す（index.html の先頭のスクリプトが読む）。
 * テーマの既定は System（prefers-color-scheme に追従。D-027）、言語の既定は System。
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type LanguageSetting, resolveLocale } from "../i18n/index.tsx";
import { api, unwrap } from "../lib/api.ts";
import { queryClient } from "./client.ts";
import { keys } from "./invalidate.ts";

export type ThemeSetting = "system" | "light" | "dark";
export interface UiPrefs {
  theme: ThemeSetting;
  language: LanguageSetting;
  /** 閉店モード中も許可待ち（needs_input）を通知する（既定オフ。D-052 (2)） */
  /** その日初めて開いたときに「Plan the day」の帯を出す（既定オン。ux-mvp 8章） */
  /** キーの割り当ての上書き（D-077。keymap の id → キー。既定と同じものは入れない。端末ごと） */
  keybindings: Record<string, string[]>;
  /** 集中モード（D-097。m2-api 25章）: 会議の前に聞く・対象の予定・何分前・答えなければ自動で集中・集中中も許可待ちは通知 */
  focusPrompt: boolean;
  focusTarget: "meetings" | "busy";
  focusLeadMin: number;
  focusAuto: boolean;
  focusAllowNeedsInput: boolean;
  /** 集中の終わりを知らせる（focus.notify_end、既定オン） */
  focusNotifyEnd: boolean;
  /** 右の詳細パネルの幅（px。null は既定。この Mac に1つ。ux-mvp 4.12.1） */
  panelWidth: number | null;
}

const LS_KEY = "turnlane.ui";
const DEFAULT: UiPrefs = {
  theme: "system",
  language: "system",
  keybindings: {},
  focusPrompt: true,
  focusTarget: "meetings",
  focusLeadMin: 5,
  focusAuto: false,
  focusAllowNeedsInput: false,
  focusNotifyEnd: true,
  panelWidth: null,
};

function readLocal(): UiPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? "null") as Partial<UiPrefs> | null;
    return { ...DEFAULT, ...(v ?? {}) };
  } catch {
    return DEFAULT;
  }
}

function writeLocal(p: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {}
}

export function usePrefs(): UiPrefs {
  const q = useQuery({
    queryKey: keys.settings(),
    queryFn: () => unwrap<UiPrefs>(api.api.settings.ui.$get()),
    placeholderData: readLocal,
  });
  const v = q.data ?? DEFAULT;
  useEffect(() => {
    if (q.data) writeLocal(q.data);
  }, [q.data]);
  return v;
}

export function useSavePrefs() {
  return useMutation({
    mutationFn: (p: Partial<UiPrefs>) => unwrap<UiPrefs>(api.api.settings.ui.$put({ json: p })),
    onMutate: async (p) => {
      // 前の保存の SSE で走っている取り直しが、古い値で上書きしないように止める
      await queryClient.cancelQueries({ queryKey: keys.settings(), exact: true });
      const prev = queryClient.getQueryData<UiPrefs>(keys.settings()) ?? readLocal();
      const next = { ...prev, ...p };
      queryClient.setQueryData(keys.settings(), next);
      writeLocal(next);
      return { prev };
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(keys.settings(), saved);
      writeLocal(saved);
    },
    onError: (_e, _p, ctx) => {
      if (ctx) queryClient.setQueryData(keys.settings(), ctx.prev);
    },
  });
}

function systemDark(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/** テーマを <html data-theme> に反映する。System は OS の外観の変化に追従する */
export function useApplyTheme(theme: ThemeSetting): "light" | "dark" {
  const [sys, setSys] = useState(systemDark);
  useEffect(() => {
    const m = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSys(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  const resolved = theme === "system" ? (sys ? "dark" : "light") : theme;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);
  return resolved;
}

export function useLocale(language: LanguageSetting) {
  const locale = resolveLocale(language);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return locale;
}
