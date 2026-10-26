/** 今の言語（React の外のモジュール（トースト・通知）から辞書を引くため）。App が切り替えのたびに設定する */
import type { Locale } from "./index.tsx";

let current: Locale = "en";

export function getLocale(): Locale {
  return current;
}

export function setLocale(l: Locale): void {
  current = l;
}
