/**
 * i18n 基盤（phase0-plan 4.4 の案 A: 自前の型付き辞書 + Intl。M2-12）。
 * - 英語の辞書が正。日本語に無いキーは英語で出す
 * - 複数形は Intl.PluralRules、日付と曜日は Intl.DateTimeFormat（UI フォントで描く。C2）
 * - mono のメタ（時間・時刻・リポジトリ・PR・バッジ・キー）は辞書を通さない（@turnlane/core/web の整形関数）
 */
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { ext } from "../ext/registry.ts";
import type { ExtMessageKey } from "../ext/types.ts";
import { en, type MessageKey } from "./en.ts";
import { type Dict, ja, type PluralValue } from "./ja.ts";

export type Locale = "en" | "ja";
export type LanguageSetting = "system" | Locale;

const DICTS: Record<Locale, Dict> = { en: en as Dict, ja };

export function resolveLocale(setting: LanguageSetting, navLang?: string): Locale {
  if (setting !== "system") return setting;
  const l = (
    navLang ?? (typeof navigator !== "undefined" ? navigator.language : "en")
  ).toLowerCase();
  return l.startsWith("ja") ? "ja" : "en";
}

export type Params = Record<string, string | number>;

function interpolate(s: string, params?: Params): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

/** 本体の辞書か拡張の辞書（ADR 0015。`ext.<id>.`）のキー */
export type AnyMessageKey = MessageKey | ExtMessageKey;

function lookup(locale: Locale, key: AnyMessageKey): string | PluralValue | undefined {
  if (key.startsWith("ext.")) return ext.messages[locale][key] ?? ext.messages.en[key];
  return DICTS[locale][key as MessageKey] ?? (en as Dict)[key as MessageKey];
}

/** 辞書を引く（純粋関数。テストと非 React のコードから使う） */
export function translate(locale: Locale, key: AnyMessageKey, params?: Params): string {
  const v = lookup(locale, key);
  if (v === undefined) return key;
  if (typeof v === "string") return interpolate(v, params);
  const count = typeof params?.count === "number" ? params.count : 0;
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  const cat = rules.select(count) as keyof PluralValue;
  return interpolate((v as PluralValue)[cat] ?? (v as PluralValue).other, params);
}

export interface I18n {
  locale: Locale;
  t: (key: AnyMessageKey, params?: Params) => string;
  /** `Thu 10/1`（英語）/ `10/1（木）`（日本語）。日付は UI フォント */
  dayLabel: (date: string) => { weekday: string; date: string };
  /** `Oct` / `10月` */
  monthLabel: (date: string) => string;
  /** `Mon 10/5` のような短い日付（移動先の表示） */
  shortDate: (date: string) => string;
}

function utcDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12));
}

export function makeI18n(locale: Locale): I18n {
  const wd = new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
  const mon = new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const md = (date: string) => {
    const d = utcDate(date);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };
  return {
    locale,
    t: (key, params) => translate(locale, key, params),
    dayLabel: (date) => ({ weekday: wd.format(utcDate(date)), date: md(date) }),
    monthLabel: (date) => mon.format(utcDate(date)),
    shortDate: (date) =>
      locale === "ja"
        ? `${md(date)}（${wd.format(utcDate(date))}）`
        : `${wd.format(utcDate(date))} ${md(date)}`,
  };
}

const Ctx = createContext<I18n>(makeI18n("en"));

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const v = useMemo(() => makeI18n(locale), [locale]);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  return useContext(Ctx);
}

export function useT(): I18n["t"] {
  return useContext(Ctx).t;
}

export type { ExtMessageKey, MessageKey };
