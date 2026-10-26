/**
 * `?` のショートカット一覧（M2-7、D-077）。キーの定義（keymap.ts）と今の割り当てを読む。⌘K はコマンドパレット（palette/）。
 * 変更は設定の「キーボード」の節（ux-mvp 6.2）。
 */
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Kbd } from "../components/ui.tsx";
import { useQuickAddShortcut } from "../data/queries.ts";
import { type MessageKey, translate, useI18n } from "../i18n/index.tsx";
import { shortcutLabel } from "../lib/desktop.ts";
import { isImeKey } from "../lib/ime.ts";
import { setUi, useUi } from "../lib/store.ts";
import {
  KEYMAP,
  keyLabel,
  SCOPE_ORDER,
  type Scope,
  shownKeys,
  useKeymapVersion,
} from "./keymap.ts";

export const SCOPE_LABEL: Record<Scope, MessageKey> = {
  global: "keys.scope.global",
  board: "keys.scope.board",
  list: "keys.scope.list",
  palette: "keys.scope.palette",
  prompt: "keys.scope.prompt",
  desktop: "keys.scope.desktop",
};

/** 検索の一致: 説明（表示中の言語と英語）とキーの表記 */
export function keyRowMatches(
  q: string,
  label: MessageKey,
  keyText: string,
  t: (k: MessageKey) => string,
): boolean {
  const s = q.trim().toLowerCase();
  if (s === "") return true;
  return `${t(label)} ${translate("en", label)} ${keyText}`.toLowerCase().includes(s);
}

export function KeyHelp() {
  const open = useUi((s) => s.helpOpen);
  const { t } = useI18n();
  const nav = useNavigate();
  useKeymapVersion();
  const quickAdd = useQuickAddShortcut().data ?? null;
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQ("");
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);
  if (!open) return null;
  const labelsOf = (id: string, scope: Scope) =>
    scope === "desktop" ? [shortcutLabel(quickAdd)] : shownKeys(id).map(keyLabel);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 背景のクリックで閉じる
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc はグローバルのキーで閉じる
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 pt-24"
      onClick={() => setUi({ helpOpen: false })}
    >
      <div
        role="dialog"
        aria-label={t("keys.title")}
        className="w-[560px] max-w-[90vw] rounded-pop border border-line bg-raised shadow-pop"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !isImeKey(e)) setUi({ helpOpen: false });
        }}
      >
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("top.search")}
          className="h-10 w-full border-line border-b bg-transparent px-4 text-body outline-none placeholder:text-fg3"
        />
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {SCOPE_ORDER.map((scope) => {
            const defs = KEYMAP.filter(
              (d) =>
                d.scope === scope && keyRowMatches(q, d.label, labelsOf(d.id, scope).join(" "), t),
            );
            if (defs.length === 0) return null;
            return (
              <section key={scope} className="mb-2">
                <h3 className="px-2 py-1 text-meta text-fg3">{t(SCOPE_LABEL[scope])}</h3>
                {defs.map((d) => (
                  <div key={d.id} className="flex h-7 items-center justify-between px-2 text-body">
                    <span>{t(d.label)}</span>
                    <span className="flex gap-1">
                      {labelsOf(d.id, scope).map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
        <div className="flex h-9 items-center justify-end border-line border-t px-4">
          <button
            type="button"
            className="text-meta text-fg2 hover:text-fg"
            onClick={() => {
              setUi({ helpOpen: false });
              void nav({ to: "/settings", hash: "keyboard" });
            }}
          >
            {t("keys.customize")}
          </button>
        </div>
      </div>
    </div>
  );
}
