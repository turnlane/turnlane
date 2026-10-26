/**
 * アプリの土台（M2-1）: TanStack Query、SSE → invalidate、テーマ（D-027）と言語（D-023）、ルーター。
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createContext, useContext } from "react";
import { queryClient } from "./data/client.ts";
import { useApplyTheme, useLocale, usePrefs } from "./data/prefs.tsx";
import { type ConnState, useLiveUpdates } from "./data/sse.ts";
import { useUiOpen } from "./data/usage.ts";
import { setLocale } from "./i18n/current.ts";
import { I18nProvider } from "./i18n/index.tsx";
import { setKeyOverrides } from "./keys/keymap.ts";
import { router } from "./router.tsx";

const ConnCtx = createContext<ConnState>("connecting");
export const useConn = () => useContext(ConnCtx);

function Inner() {
  const prefs = usePrefs();
  useApplyTheme(prefs.theme);
  const locale = useLocale(prefs.language);
  setLocale(locale);
  // キーの割り当て（D-077）。描き直しは useKeymapVersion を読む部品だけ
  setKeyOverrides(prefs.keybindings);
  const conn = useLiveUpdates();
  useUiOpen();
  return (
    <ConnCtx.Provider value={conn}>
      <I18nProvider locale={locale}>
        <RouterProvider router={router} />
      </I18nProvider>
    </ConnCtx.Provider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Inner />
    </QueryClientProvider>
  );
}
