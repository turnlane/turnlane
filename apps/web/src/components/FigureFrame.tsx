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
}: {
  html: string;
  title: string;
  className?: string;
  testId?: string;
}) {
  return (
    <iframe
      sandbox=""
      srcDoc={figureSrcdoc(html)}
      title={title}
      referrerPolicy="no-referrer"
      loading="lazy"
      className={className}
      data-testid={testId}
    />
  );
}
