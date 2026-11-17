/**
 * AI が書いた図の枠（図つきの問い。ADR 0022）。`<iframe sandbox>`（allow-scripts も allow-same-origin も無し）に、
 * CSP の meta を先頭に入れた文書（lib/figure.ts の figureSrcdoc）を srcdoc で入れる
 */
import { figureSrcdoc } from "../lib/figure.ts";

export { FIGURE_CSP, type FigureTheme, figureSrcdoc, sanitizeFigure } from "../lib/figure.ts";

/** 図の枠（sandbox・CSP 入り）。title は読み上げ用 */
export function FigureFrame({
  html,
  title,
  className,
  testId,
  focusable = true,
  fit = false,
}: {
  html: string;
  title: string;
  className?: string;
  testId?: string;
  /** false なら Tab で枠に入らない（押せる部品で包んだ案の図・広げた画面。枠の中に入るとキーが画面に届かない） */
  focusable?: boolean;
  /** 図が SVG 1 つなら枠いっぱいに収める（広げた画面の図 1 枚） */
  fit?: boolean;
}) {
  return (
    <iframe
      sandbox=""
      srcDoc={figureSrcdoc(html, undefined, { fit })}
      title={title}
      referrerPolicy="no-referrer"
      loading="lazy"
      tabIndex={focusable ? undefined : -1}
      className={className}
      data-testid={testId}
    />
  );
}
