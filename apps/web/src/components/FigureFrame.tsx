/**
 * AI が書いた図の枠（図つきの問い。ADR 0022）。`<iframe sandbox>`（allow-scripts も allow-same-origin も無し）に、
 * CSP の meta を先頭に入れた文書（lib/figure.ts の figureSrcdoc）を srcdoc で入れる。
 *
 * - page（説明の頁）: 枠の幅で流れて中でスクロールする
 * - canvas（案の図）: 図の大きさ（figureCanvas）の文書を描き、枠ごと transform で置き場所に収める（縦横比を保ち、真ん中に）。
 *   置き場所の大きさは ResizeObserver で測る（枠の中は測れないので、測るのは親の箱だけ）。枠はマウスを受けない
 *   （押すのは包んだボタン。枠の中にフォーカスが入るとキーが画面に届かない）
 *
 * 読み上げの名前は aria-label（title 属性は付けない。WKWebView では枠の title がずれた位置にツールチップとして出た）
 */
import { type CSSProperties, useLayoutEffect, useMemo, useRef, useState } from "react";
import { figureCanvas, figureSrcdoc, fitCanvas } from "../lib/figure.ts";

export {
  FIGURE_CANVAS,
  FIGURE_CSP,
  type FigureCanvas,
  type FigureTheme,
  figureCanvas,
  figureSrcdoc,
  fitCanvas,
  sanitizeFigure,
} from "../lib/figure.ts";

/** 図の枠（sandbox・CSP 入り）。title は読み上げ用 */
export function FigureFrame({
  html,
  title,
  className,
  testId,
  focusable = true,
  mode = "page",
}: {
  html: string;
  title: string;
  /** page は枠そのもの、canvas は置き場所の箱の class */
  className?: string;
  testId?: string;
  /** false なら Tab で枠に入らない（押せる部品で包んだ案の図・広げた画面。枠の中に入るとキーが画面に届かない） */
  focusable?: boolean;
  /** page: 説明の頁（流れてスクロール）。canvas: 案の図（図の大きさで描いて置き場所に収める） */
  mode?: "page" | "canvas";
}) {
  if (mode === "canvas")
    return <CanvasFrame html={html} title={title} className={className} testId={testId} />;
  return (
    // biome-ignore lint/a11y/useIframeTitle: 名前は aria-label で付ける（title は WKWebView でずれたツールチップになる）
    <iframe
      sandbox=""
      srcDoc={figureSrcdoc(html)}
      aria-label={title}
      referrerPolicy="no-referrer"
      loading="lazy"
      tabIndex={focusable ? undefined : -1}
      className={className}
      data-testid={testId}
    />
  );
}

function CanvasFrame({
  html,
  title,
  className,
  testId,
}: {
  html: string;
  title: string;
  className?: string | undefined;
  testId?: string | undefined;
}) {
  const canvas = useMemo(() => figureCanvas(html), [html]);
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<ReturnType<typeof fitCanvas>>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () =>
      setFit(fitCanvas({ width: el.clientWidth, height: el.clientHeight }, canvas));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvas]);
  const style: CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    width: canvas.width,
    height: canvas.height,
    border: 0,
    transformOrigin: "0 0",
    transform: fit ? `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})` : undefined,
    visibility: fit ? "visible" : "hidden",
    pointerEvents: "none",
  };
  return (
    <div
      ref={box}
      className={`relative overflow-hidden ${className ?? ""}`}
      data-testid={testId ? `${testId}-box` : undefined}
    >
      {/* biome-ignore lint/a11y/useIframeTitle: 名前は aria-label で付ける（title は WKWebView でずれたツールチップになる） */}
      <iframe
        sandbox=""
        srcDoc={figureSrcdoc(html, undefined, { canvas })}
        aria-label={title}
        referrerPolicy="no-referrer"
        loading="lazy"
        tabIndex={-1}
        style={style}
        data-testid={testId}
        data-canvas={`${canvas.width}x${canvas.height}`}
        data-scale={fit ? fit.scale.toFixed(3) : undefined}
      />
    </div>
  );
}
