/**
 * 複数選択の一括操作のバー（UX 監査 A14。5.P3）: ⇧ / ⌘ クリック・`x` で選んでいる間、画面の下に
 * `3 件を選択中 · 今日へ · 1日後へ · 完了 · 削除 · ×` を出す。ボタンはキーの処理（keymap の id）を呼ぶ
 */
import { X } from "lucide-react";
import { MENU_ICON } from "../actions/item-actions.tsx";
import { type MessageKey, useI18n } from "../i18n/index.tsx";
import { keyHint } from "../keys/keymap.ts";
import { dispatchKey } from "../keys/use-keys.ts";

/** 選んでいる項目の種類から、出す操作（keymap の id と文言） */
export function bulkActions(
  keys: readonly string[],
): { id: string; label: MessageKey; danger?: boolean }[] {
  const tasks = keys.some((k) => k.startsWith("task:"));
  const turns = keys.some((k) => k.startsWith("turn:"));
  const out: { id: string; label: MessageKey; danger?: boolean }[] = [];
  if (tasks && !turns)
    out.push({ id: "today", label: "menu.today" }, { id: "later", label: "menu.later" });
  if (turns && !tasks)
    out.push({ id: "move", label: "menu.tomorrow" }, { id: "dismiss", label: "menu.dismiss" });
  if (tasks || turns) out.push({ id: "complete", label: "menu.complete" });
  if (tasks) out.push({ id: "delete", label: "menu.delete", danger: true });
  return out;
}

export function BulkBar({ keys, onClear }: { keys: readonly string[]; onClear: () => void }) {
  const { t } = useI18n();
  if (keys.length === 0) return null;
  const acts = bulkActions(keys);
  return (
    <div
      className="fixed bottom-16 left-1/2 z-40 flex h-12 -translate-x-1/2 items-center gap-1 rounded-pop border border-line bg-raised px-2 text-body shadow-pop"
      data-testid="bulk-bar"
      role="toolbar"
    >
      <span className="pr-3 pl-1.5 font-medium text-fg">
        {t("bulk.selected", { count: keys.length })}
      </span>
      {acts.map((a) => {
        const Icon = MENU_ICON[a.id === "move" ? "later" : a.id];
        return (
          <button
            key={a.id}
            type="button"
            data-action={a.id}
            title={keyHint(a.id) ? `${t(a.label)} · ${keyHint(a.id)}` : t(a.label)}
            onClick={() => dispatchKey(a.id)}
            className={`flex h-8 items-center gap-1.5 rounded-control px-2.5 hover:bg-sunken ${a.danger ? "text-error" : "text-fg"}`}
          >
            {Icon ? <Icon size={16} strokeWidth={1.5} aria-hidden="true" /> : null}
            {t(a.label)}
          </button>
        );
      })}
      <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
      <button
        type="button"
        aria-label={t("bulk.clear")}
        title={`${t("bulk.clear")} · Esc`}
        onClick={onClear}
        className="inline-flex size-8 items-center justify-center rounded-control text-fg2 hover:bg-sunken hover:text-fg"
      >
        <X size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  );
}
