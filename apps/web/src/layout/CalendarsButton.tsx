/**
 * 上部バーの「カレンダー ▾」（Issue #5。ux-mvp 4.13）: 見ている画面の上でカレンダーを一時的に表示しない・戻す。
 * 3日ボード・週表示・デイビューで共通。一覧はアカウントごとの見出し、色の点、名前、右にチェック（並びは設定 › カレンダーと
 * 同じ）。「無視する」のカレンダーは出さない。非表示が 1 つ以上あればボタンを `カレンダー · 2 件非表示` にする。
 * キーは足さない。ポップオーバーの中は ↑ ↓ で移り、Space で切り替え、Esc で閉じる
 */
import { useNavigate } from "@tanstack/react-router";
import { CalendarDays, ChevronDown } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Popover } from "../components/ui.tsx";
import { setCalendarHidden, useHiddenCalendars } from "../data/calendar-visibility.ts";
import { useCalendars } from "../data/queries.ts";
import { useI18n } from "../i18n/index.tsx";
import { calColor } from "../lib/cal-color.ts";

interface Row {
  id: string;
  name: string;
  account: string | null;
  color: string | null;
  colorKey: Parameters<typeof calColor>[1];
}

/** アカウントごとにまとめる（最初に出た順。中の並びはそのまま） */
export function groupByAccount<T extends { account: string | null }>(
  xs: readonly T[],
): { account: string | null; items: T[] }[] {
  const out: { account: string | null; items: T[] }[] = [];
  for (const x of xs) {
    const g = out.find((o) => o.account === x.account);
    if (g) g.items.push(x);
    else out.push({ account: x.account, items: [x] });
  }
  return out;
}

export function CalendarsButton({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const list = useCalendars((cs) =>
    cs
      .filter((c) => c.role === "source")
      .map(
        (c): Row => ({
          id: c.id,
          name: c.name,
          account: c.account,
          color: c.color,
          colorKey: c.colorKey,
        }),
      ),
  ).data;
  const hidden = useHiddenCalendars();
  const box = useRef<HTMLDivElement>(null);
  // 開いたら最初のカレンダーに（↑ ↓ と Space がすぐ効く）
  useEffect(() => {
    if (anchor) box.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [anchor]);
  if (!list || list.length === 0) return null;
  const n = list.filter((c) => hidden.has(c.id)).length;
  const label = n > 0 ? t("top.calendarsHidden", { count: n }) : t("top.calendars");
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    e.stopPropagation();
    const xs = [...(box.current?.querySelectorAll<HTMLInputElement>("input") ?? [])];
    const i = xs.indexOf(document.activeElement as HTMLInputElement);
    const j = e.key === "ArrowDown" ? Math.min(xs.length - 1, i + 1) : Math.max(0, i - 1);
    xs[j]?.focus();
  };
  return (
    <>
      <button
        type="button"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        title={compact ? label : undefined}
        aria-label={label}
        aria-expanded={anchor !== null}
        className={`flex h-8 shrink-0 items-center gap-1 rounded-card px-2 text-body hover:bg-sunken ${n > 0 ? "text-fg" : "text-fg2"}`}
        data-testid="calendars-button"
        data-hidden={n}
      >
        {compact ? <CalendarDays size={16} strokeWidth={1.5} aria-hidden="true" /> : label}
        <ChevronDown size={14} strokeWidth={1.5} className="text-fg2" aria-hidden="true" />
      </button>
      {anchor ? (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="w-64">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: ↑ ↓ で一覧の中を移る */}
          <div
            ref={box}
            onKeyDown={onKey}
            className="flex max-h-[60vh] flex-col overflow-y-auto"
            data-testid="calendars-popover"
          >
            {groupByAccount(list).map((g) => (
              <div key={g.account ?? ""} className="flex flex-col">
                {g.account ? (
                  <div className="truncate px-2 pt-1.5 pb-0.5 text-fg3 text-meta">{g.account}</div>
                ) : null}
                {g.items.map((c) => (
                  <label
                    key={c.id}
                    className="flex h-8 cursor-default items-center gap-2 rounded-control px-2 text-body hover:bg-sunken"
                    data-testid="calendars-item"
                    data-calendar-id={c.id}
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: calColor(c.color, c.colorKey) }}
                      aria-hidden="true"
                    />
                    <span
                      className={`min-w-0 flex-1 truncate ${hidden.has(c.id) ? "text-fg3" : ""}`}
                    >
                      {c.name}
                    </span>
                    <input
                      type="checkbox"
                      checked={!hidden.has(c.id)}
                      onChange={(e) => void setCalendarHidden(c.id, !e.target.checked)}
                      style={{ accentColor: "var(--dl-text)" }}
                      aria-label={c.name}
                      data-testid="calendars-check"
                    />
                  </label>
                ))}
              </div>
            ))}
            <div className="my-1 border-line border-t" />
            <button
              type="button"
              onClick={() => {
                setAnchor(null);
                void nav({ to: "/settings", hash: "calendar" });
              }}
              className="flex h-8 items-center rounded-control px-2 text-left text-body text-fg2 hover:bg-sunken hover:text-fg"
              data-testid="calendars-settings"
            >
              {t("top.calendarsSettings")}
            </button>
          </div>
        </Popover>
      ) : null}
    </>
  );
}
