/**
 * クイック入力（/quick-add。desktop-shell.md 5章）。デスクトップアプリの ⌥⇧Space（D-056 (2)）で出す小窓（640×168）。
 * - 1行の入力。入力に合わせて NL パーサ（M2-4 と同じ parseTask）のチップを出す
 * - ⏎ で追加（source = desktop）して「Added to Today」などを 0.8 秒出して隠す。⌘⏎ で追加して main で開く
 * - Esc で隠す。入力中の文字は次に開いたときに残す（追加したら消す）
 * - 日付の無いものはパーサの規則どおり Inbox に入る
 */
import { fmtDuration, parseTask } from "@turnlane/core/web";
import { useEffect, useMemo, useRef, useState } from "react";
import { Chip, Kbd } from "../components/ui.tsx";
import { createTask } from "../data/mutations.ts";
import { useQueue } from "../data/queries.ts";
import { useI18n } from "../i18n/index.tsx";
import { desktopHide, desktopOpen } from "../lib/desktop.ts";
import { isImeKey } from "../lib/ime.ts";

export function QuickAddPage() {
  const { t, shortDate } = useI18n();
  const today = useQueue().data?.today ?? "";
  const [v, setV] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onFocus = () => {
      setDone(null);
      input.current?.focus();
      input.current?.select();
    };
    onFocus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  const parsed = useMemo(() => (v.trim() && today ? parseTask(v, { today }) : null), [v, today]);
  const submit = async (openAfter: boolean) => {
    const raw = v.trim();
    if (!raw) return;
    const task = await createTask({ raw, date: null, source: "desktop" });
    if (!task) return;
    setV("");
    const d = task.scheduledDate;
    if (openAfter) {
      desktopOpen(d ? "/board" : "/inbox");
      return;
    }
    setDone(
      d === null
        ? t("quickAdd.addedInbox")
        : d === today
          ? t("quickAdd.addedToday")
          : t("quickAdd.addedOn", { date: shortDate(d) }),
    );
    setTimeout(() => {
      setDone(null);
      desktopHide();
    }, 800);
  };
  return (
    <div className="flex h-screen flex-col gap-2 overflow-hidden border border-line bg-raised px-4 py-3 text-fg">
      <input
        ref={input}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (isImeKey(e)) return;
          if (e.key === "Enter") {
            e.preventDefault();
            void submit(e.metaKey);
          } else if (e.key === "Escape") {
            e.preventDefault();
            desktopHide();
          }
        }}
        placeholder={t("quickAdd.placeholder")}
        className="h-10 w-full bg-transparent text-[18px] outline-none placeholder:text-fg3"
      />
      <div className="flex min-h-6 flex-wrap items-center gap-1">
        {done ? (
          <span className="text-accent text-body">{done}</span>
        ) : parsed ? (
          <>
            <Chip>
              {parsed.date ? `${t("task.chip.date")} ${shortDate(parsed.date)}` : t("task.inbox")}
            </Chip>
            {parsed.time ? (
              <Chip>
                {t("task.chip.time")} {String(parsed.time.hour).padStart(2, "0")}:
                {String(parsed.time.minute).padStart(2, "0")}
              </Chip>
            ) : null}
            {parsed.estimateMin !== null ? (
              <Chip>
                {t("task.chip.estimate")} {fmtDuration(parsed.estimateMin * 60_000)}
              </Chip>
            ) : null}
            {parsed.project ? <Chip>#{parsed.project}</Chip> : null}
            {parsed.priority !== null ? <Chip>!{parsed.priority}</Chip> : null}
            {parsed.someday ? <Chip>{t("task.chip.someday")}</Chip> : null}
          </>
        ) : null}
      </div>
      <div className="mt-auto flex items-center gap-3 text-fg3 text-meta">
        <span>
          <Kbd>⏎</Kbd> {t("quickAdd.add")}
        </span>
        <span>
          <Kbd>⌘⏎</Kbd> {t("quickAdd.addOpen")}
        </span>
        <span>
          <Kbd>esc</Kbd> {t("quickAdd.close")}
        </span>
      </div>
    </div>
  );
}
