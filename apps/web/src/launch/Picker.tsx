/**
 * ポップオーバーの中で使う選択（確定画像の作成のポップオーバー「AI に頼む」の リポジトリ ▾）と、スイッチ。
 * ネイティブの select・checkbox は使わない（アプリの部品にそろえる）。選択肢の一覧はポップオーバーの中に重ねて出す
 * （別のポータルに出すと、外側のクリックとしてポップオーバーごと閉じるため）
 */
import { Check, ChevronDown } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";

export interface PickerOption {
  value: string;
  /** ボタンと一覧の1行 */
  label: ReactNode;
  /** 一覧で右に添える（「（プロジェクトの既定）」など） */
  note?: string | undefined;
  /** 左の点（プロジェクトの色） */
  dot?: string | null | undefined;
  title?: string | undefined;
  /** 一覧のまとまりの見出し（予定の書き先のアカウント名など。前の行と違うときに出す） */
  group?: string | null | undefined;
}

export function Picker({
  value,
  options,
  onChange,
  label,
  testId,
  up = false,
  className = "w-full",
}: {
  value: string | null;
  options: PickerOption[];
  onChange: (v: string) => void;
  /** スクリーンリーダー用の名前（行のラベル） */
  label: string;
  testId?: string;
  /** 一覧をボタンの上に開く（ポップオーバーの下端に置くとき） */
  up?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // キーで開いたら選んでいる行へ（↑↓ で移る）
  useEffect(() => {
    if (!open) return;
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    if (document.activeElement === ref.current?.querySelector("button"))
      (rows.find((r) => r.getAttribute("aria-selected") === "true") ?? rows[0])?.focus();
  }, [open]);
  const onListKey = (e: React.KeyboardEvent) => {
    // ⏎・Space はその行を選ぶ（画面のキー（⏎ で詳細を開くなど）に渡さない）
    const row = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]');
    if ((e.key === "Enter" || e.key === " ") && row?.dataset.value !== undefined) {
      e.preventDefault();
      e.stopPropagation();
      onChange(row.dataset.value);
      setOpen(false);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
    rows[next]?.focus();
  };
  const cur = options.find((o) => o.value === value) ?? null;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const dot = (c: string | null | undefined) =>
    c !== undefined ? (
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: c ?? "var(--dl-text-3)" }}
        aria-hidden="true"
      />
    ) : null;
  return (
    <div ref={ref} className={`relative min-w-0 ${className}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={cur?.title}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          // ⏎・Space で開く（画面のキーに渡さない）
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-control border border-line bg-raised px-2.5 text-left text-body text-fg hover:border-fg3"
        data-testid={testId}
      >
        {dot(cur?.dot)}
        <span className="min-w-0 truncate">{cur?.label}</span>
        {cur?.note ? (
          <span className="shrink-0 truncate text-fg3 text-meta">{cur.note}</span>
        ) : null}
        <ChevronDown
          size={16}
          strokeWidth={1.5}
          className="ml-auto shrink-0 text-fg2"
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div
          ref={list}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onListKey}
          className={`absolute ${up ? "bottom-[calc(100%+4px)] w-max min-w-56 max-w-80" : "top-[calc(100%+4px)] right-0"} left-0 z-10 max-h-60 overflow-y-auto rounded-card border border-line bg-raised p-1 shadow-pop`}
        >
          {options.map((o, i) => (
            <Fragment key={o.value}>
              {o.group && o.group !== options[i - 1]?.group ? (
                <div
                  role="presentation"
                  className="px-2 pt-1.5 pb-0.5 font-medium text-fg3 text-micro"
                  data-group={o.group}
                >
                  {o.group}
                </div>
              ) : null}
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                title={o.title}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-control px-2 text-left text-body text-fg hover:bg-sunken"
                data-value={o.value}
              >
                {dot(o.dot)}
                <span className="min-w-0 truncate">{o.label}</span>
                {o.note ? <span className="shrink-0 text-fg3 text-meta">{o.note}</span> : null}
                {o.value === value ? (
                  <Check
                    size={14}
                    strokeWidth={1.5}
                    className="ml-auto shrink-0 text-fg2"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * ポップオーバーの中の分割ボタン（作成のポップオーバー「AI に頼む」の 使う AI）。沈んだ面の上で、選んでいるものだけ
 * 浮いた面・枠の影にする（ポップオーバーの面と同じ色の地では、設定の画面の Segmented の印が見えないため）
 */
export function LaunchSegmented<V extends string>({
  value,
  options,
  onChange,
  label,
  testId,
}: {
  value: V | null;
  options: { v: V; label: ReactNode }[];
  onChange: (v: V) => void;
  /** スクリーンリーダー用の名前（行のラベル） */
  label: string;
  testId?: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: 分割ボタンのまとまり（fieldset の枠の既定の見た目を避ける）
    <div
      role="group"
      aria-label={label}
      className="flex gap-0.5 rounded-card bg-sunken p-0.5"
      data-testid={testId}
    >
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          aria-pressed={value === o.v}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange(o.v)}
          className={`flex h-7 items-center whitespace-nowrap rounded-control px-3 text-body ${value === o.v ? "bg-raised text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_var(--dl-border)]" : "text-fg2 hover:text-fg"}`}
          data-value={o.v}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** スイッチ（作成のポップオーバーの「AI に頼む」と同じ見た目） */
export function Switch({
  on,
  onChange,
  label,
  disabled = false,
  testId,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onChange(!on)}
      className="shrink-0 disabled:opacity-40"
      data-testid={testId}
    >
      <SwitchTrack on={on} />
    </button>
  );
}

export function SwitchTrack({ on }: { on: boolean }) {
  return (
    <span
      className={`relative block h-[18px] w-8 rounded-full transition-colors ${on ? "bg-accent" : "bg-line"}`}
      aria-hidden="true"
    >
      <span
        className={`absolute top-0.5 size-[14px] rounded-full bg-raised shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-[left] ${on ? "left-[16px]" : "left-0.5"}`}
      />
    </span>
  );
}
