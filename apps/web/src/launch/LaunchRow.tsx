/**
 * AI に頼むの入力の1行（左にラベル、右に部品）。本体の行と、拡張の欄（launchFields の layout: "rows"。ADR 0015）で共通
 */
export function LaunchRow({
  label,
  children,
  top = false,
}: {
  label: string;
  children: React.ReactNode;
  /** ラベルを上にそろえる（複数行の欄） */
  top?: boolean;
}) {
  return (
    <div className={`flex min-h-8 gap-3 ${top ? "items-start" : "items-center"}`}>
      <span className={`w-20 shrink-0 text-fg2 text-meta ${top ? "pt-1.5" : ""}`}>{label}</span>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
    </div>
  );
}
