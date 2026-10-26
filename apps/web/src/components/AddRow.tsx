/**
 * 「＋ タスクを追加」の入力行（Inbox の先頭、週ボードの Inbox トレイ。D-062 の段階 B (1)）。ふだんは枠の無い1行（ボードの
 * 「＋ 追加」と同じ扱い）で、フォーカスで入力欄の面と枠が付き、例の文がプレースホルダーになる（Inbox のレビュー v1）。
 * 自然言語パーサ（ux-mvp 5章）を通し、⏎ で追加して入力を空にする（続けて入れられる）。日付が無ければ Inbox、
 * 日付を書けばその日へ入る。誤爆しそうな候補は ⇥ で確定する。Esc でフォーカスを外す。
 */
import { parseTask } from "@turnlane/core/web";
import { Plus } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ParsedChips, tentativeExtra } from "../board/editors.tsx";
import { createTask } from "../data/mutations.ts";
import { useI18n } from "../i18n/index.tsx";
import { isImeKey } from "../lib/ime.ts";

export function AddRow({ today, compact = false }: { today: string; compact?: boolean }) {
  const { t } = useI18n();
  const [v, setV] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => (v.trim() ? parseTask(v, { today }) : null), [v, today]);
  const submit = () => {
    const raw = v.trim();
    if (!raw) return;
    const extra = tentativeExtra(parsed, accepted);
    void createTask({
      raw,
      date: extra.date ?? null,
      ...(extra.estimateMin !== undefined ? { estimateMin: extra.estimateMin } : {}),
    });
    setV("");
    setAccepted(false);
  };
  return (
    <div className="flex flex-col gap-1" data-testid="add-row">
      <label
        className={`flex cursor-text items-center rounded-card ${
          compact ? "h-7 gap-2 px-2" : "h-9 gap-2.5 px-3"
        } ${
          focused || v
            ? "bg-raised shadow-[0_0_0_1px_var(--dl-border)]"
            : "text-fg2 hover:bg-sunken hover:text-fg"
        }`}
      >
        <Plus
          size={compact ? 14 : 16}
          strokeWidth={1.5}
          className="shrink-0 text-fg3"
          aria-hidden="true"
        />
        <input
          ref={input}
          value={v}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setV(e.target.value);
            setAccepted(false);
          }}
          onKeyDown={(e) => {
            if (isImeKey(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Tab" && parsed && parsed.tentative.length > 0) {
              e.preventDefault();
              setAccepted(true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setV("");
              input.current?.blur();
            }
          }}
          aria-label={t("inbox.add")}
          placeholder={compact || !focused ? t("inbox.addShort") : t("inbox.addPlaceholder")}
          // 枠は行（label）が持つ。全体の :focus-visible の枠（層の外の CSS）を入力欄に重ねない
          style={{ outline: "none" }}
          className={`min-w-0 flex-1 bg-transparent text-body ${
            focused ? "placeholder:text-fg3" : "placeholder:text-fg2"
          }`}
        />
      </label>
      {parsed ? <ParsedChips parsed={parsed} fallbackDate={null} accepted={accepted} /> : null}
    </div>
  );
}
