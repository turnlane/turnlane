/**
 * 図つきの問いを広げる（ADR 0022。ux-mvp 4.23）: 広げた画面の遷移・フォーカスを返す先・パネルと共有する下書き・キー・
 * フォーカスの罠・大きな図の枠の sandbox と CSP。問いと図はすべて合成のダミー
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { AskView } from "@turnlane/core/web";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AskOverlayView } from "../src/components/AskOverlay.tsx";
import { AskBody } from "../src/components/AskSection.tsx";
import { FIGURE_CSP } from "../src/components/FigureFrame.tsx";
import type { AskOutcome } from "../src/data/ask.ts";
import { I18nProvider } from "../src/i18n/index.tsx";
import {
  type AskKeyInput,
  type AskOverlayState,
  askKeyAction,
  askOverlayReduce,
  backAskOverlay,
  canSendAsk,
  dropAskDraft,
  focusBack,
  getAskDraft,
  getAskOverlay,
  openAskFigure,
  openAskOverlay,
  resetAskExpandForTest,
  sendAskDraft,
  setAskDraft,
  takeAskFocus,
  toggleAskChoice,
  trapIndex,
} from "../src/lib/ask-expand.ts";

const SVG = '<svg viewBox="0 0 60 40"><rect width="60" height="40"/></svg>';

/** without は落とす欄（閉じた問いは中身を持たない・説明の無い問い） */
function ask(over: Partial<AskView> = {}, without: (keyof AskView)[] = []): AskView {
  const v: AskView = {
    id: "ask-1",
    workItemId: "wi-1",
    state: "open",
    createdAt: 0,
    closedAt: null,
    question: "Where should the button go?",
    context: "A long form.",
    options: [
      { n: 1, label: "Bottom", description: "Pinned.", recommended: true, figure: { html: SVG } },
      { n: 2, label: "Top", description: "As now.", recommended: false },
      {
        n: 3,
        label: "Floating",
        description: "Covers a field.",
        recommended: false,
        figure: { error: "too_large" },
      },
    ],
    explain: { html: "<p>Why</p>" },
    ...over,
  };
  for (const k of without) delete v[k];
  return v;
}

function render(el: ReactElement, locale: "en" | "ja" = "en"): string {
  return renderToStaticMarkup(
    createElement(I18nProvider, { locale } as Parameters<typeof I18nProvider>[0], el),
  );
}

const panel = (v: AskView) =>
  render(createElement(AskBody, { v, workItemId: "wi-1", layout: "panel" }));

const overlay = (v: AskView | undefined, s: Partial<AskOverlayState> = {}) =>
  render(
    createElement(AskOverlayView, {
      s: { askId: "ask-1", workItemId: "wi-1", full: true, figure: null, ...s },
      v,
      isError: false,
      sentAt: null,
      tz: "Asia/Tokyo",
    }),
  );

/** フォーカスを受けたかを数える偽の部品 */
function opener() {
  const el = {
    isConnected: true,
    focused: 0,
    focus() {
      el.focused++;
    },
  };
  return el;
}
const asEl = (o: ReturnType<typeof opener>) => o as unknown as HTMLElement;

function iframes(markup: string): string[] {
  return markup.match(/<iframe[^>]*>/g) ?? [];
}

function srcdocOf(tag: string): string {
  const m = /srcDoc="([^"]*)"|srcdoc="([^"]*)"/.exec(tag);
  return (m?.[1] ?? m?.[2] ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

beforeEach(() => resetAskExpandForTest());

describe("広げた画面の遷移", () => {
  const base = { askId: "a", workItemId: null };
  test("広げる → Esc で閉じる", () => {
    const s = askOverlayReduce(null, { kind: "expand", ...base });
    expect(s).toEqual({ askId: "a", workItemId: null, full: true, figure: null });
    expect(askOverlayReduce(s, { kind: "back" })).toBeNull();
  });
  test("全体から図を開くと Esc で全体に戻る", () => {
    const full = askOverlayReduce(null, { kind: "expand", ...base });
    const fig = askOverlayReduce(full, { kind: "figure", ...base, n: 2 });
    expect(fig).toEqual({ askId: "a", workItemId: null, full: true, figure: 2 });
    expect(askOverlayReduce(fig, { kind: "back" })).toEqual(full);
  });
  test("パネルから図を開くと Esc で閉じる（全体は開かない）", () => {
    const fig = askOverlayReduce(null, { kind: "figure", ...base, n: 1 });
    expect(fig?.full).toBe(false);
    expect(askOverlayReduce(fig, { kind: "back" })).toBeNull();
  });
  test("別の問いの図は全体を引き継がない", () => {
    const full = askOverlayReduce(null, { kind: "expand", ...base });
    expect(
      askOverlayReduce(full, { kind: "figure", askId: "b", workItemId: null, n: 1 })?.full,
    ).toBe(false);
  });
});

describe("開く・閉じる・フォーカスを返す", () => {
  test("広げたボタンへ Esc でフォーカスを返す", () => {
    const btn = opener();
    openAskOverlay("ask-1", "wi-1", asEl(btn));
    expect(getAskOverlay()?.full).toBe(true);
    backAskOverlay();
    expect(getAskOverlay()).toBeNull();
    // 返すのは広げた画面が描き直した後（AskOverlay が takeAskFocus を呼ぶ）
    const el = takeAskFocus();
    expect(el).toBe(asEl(btn));
    expect(focusBack(el)).toBe(true);
    expect(btn.focused).toBe(1);
    expect(takeAskFocus()).toBeNull();
  });
  test("全体 → 図 → Esc は図のボタンへ、もう一度 Esc で広げたボタンへ", () => {
    const btn = opener();
    const zoom = opener();
    openAskOverlay("ask-1", "wi-1", asEl(btn));
    openAskFigure("ask-1", "wi-1", 1, asEl(zoom));
    expect(getAskOverlay()?.figure).toBe(1);
    backAskOverlay();
    expect(getAskOverlay()).toEqual({
      askId: "ask-1",
      workItemId: "wi-1",
      full: true,
      figure: null,
    });
    expect(takeAskFocus()).toBe(asEl(zoom));
    backAskOverlay();
    expect(getAskOverlay()).toBeNull();
    expect(takeAskFocus()).toBe(asEl(btn));
  });
  test("パネルから図を開くと Esc で図のボタンへ", () => {
    const zoom = opener();
    openAskFigure("ask-1", "wi-1", 2, asEl(zoom));
    expect(getAskOverlay()).toEqual({ askId: "ask-1", workItemId: "wi-1", full: false, figure: 2 });
    backAskOverlay();
    expect(getAskOverlay()).toBeNull();
    expect(takeAskFocus()).toBe(asEl(zoom));
  });
  test("画面から消えた部品にはフォーカスを返さない", () => {
    const btn = opener();
    btn.isConnected = false;
    expect(focusBack(asEl(btn))).toBe(false);
    expect(focusBack(null)).toBe(false);
    expect(btn.focused).toBe(0);
  });
  test("返したら閉じて広げたボタンへ。メモは空に、案は残す", async () => {
    const btn = opener();
    openAskOverlay("ask-1", "wi-1", asEl(btn));
    setAskDraft("ask-1", { choice: "Top", note: "keep it small" });
    const calls: unknown[] = [];
    const fake = async (_id: string, _w: string | null, input: unknown): Promise<AskOutcome> => {
      calls.push(input);
      return { ok: true, at: 1 };
    };
    const r = await sendAskDraft("ask-1", "wi-1", fake);
    expect(r).toEqual({ ok: true, at: 1 });
    expect(calls).toEqual([{ choice: "Top", note: "keep it small" }]);
    expect(getAskOverlay()).toBeNull();
    expect(takeAskFocus()).toBe(asEl(btn));
    expect(getAskDraft("ask-1")).toEqual({ choice: "Top", note: "", busy: false });
  });
  test("返せなかったら開いたまま（メモも残す）", async () => {
    openAskOverlay("ask-1", "wi-1", null);
    setAskDraft("ask-1", { note: "x" });
    await sendAskDraft("ask-1", "wi-1", async () => ({ ok: false, code: "failed" }));
    expect(getAskOverlay()?.full).toBe(true);
    expect(getAskDraft("ask-1").note).toBe("x");
  });
  test("案もメモも無ければ返さない。返している途中は 2 度目を送らない", async () => {
    let n = 0;
    const fake = async (): Promise<AskOutcome> => {
      n++;
      return { ok: true, at: 1 };
    };
    expect(await sendAskDraft("ask-1", null, fake)).toBeNull();
    setAskDraft("ask-1", { choice: "Top" });
    const a = sendAskDraft("ask-1", null, fake);
    const b = sendAskDraft("ask-1", null, fake);
    await Promise.all([a, b]);
    expect(n).toBe(1);
  });
});

describe("パネルと共有する下書き", () => {
  test("パネルで選んだ案とメモが広げた画面に出る（逆も同じ）", () => {
    toggleAskChoice("ask-1", "Top");
    setAskDraft("ask-1", { note: "a note from the panel" });
    const p = panel(ask());
    const o = overlay(ask());
    for (const m of [p, o]) {
      expect(m.match(/data-on="1"/g)?.length).toBe(1);
      expect(m).toMatch(/aria-checked="true"[^>]*data-testid="ask-option"[^>]*data-on="1"/);
      expect(m).toContain(">a note from the panel</textarea>");
    }
    // 選んだ案をもう一度押すと外す
    toggleAskChoice("ask-1", "Top");
    expect(getAskDraft("ask-1").choice).toBeNull();
    expect(overlay(ask())).not.toContain('data-on="1"');
  });
  test("閉じた問いの下書きは捨てる", () => {
    setAskDraft("ask-1", { choice: "Top" });
    dropAskDraft("ask-1");
    expect(getAskDraft("ask-1")).toEqual({ choice: null, note: "", busy: false });
  });
  test("返せるか", () => {
    expect(canSendAsk({ choice: null, note: " ", busy: false })).toBe(false);
    expect(canSendAsk({ choice: null, note: "x", busy: false })).toBe(true);
    expect(canSendAsk({ choice: "A", note: "", busy: true })).toBe(false);
  });
});

describe("キー", () => {
  const k = (key: string, o: Partial<AskKeyInput> = {}): AskKeyInput => ({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    inText: false,
    ...o,
  });
  test.each([
    ["panel: f で広げる", k("f"), "panel", { kind: "expand" }],
    ["panel: 入力欄の中の f は文字", k("f", { inText: true }), "panel", null],
    ["panel: ⌘f は広げない", k("f", { metaKey: true }), "panel", null],
    ["panel: ⇧F は広げない", k("F"), "panel", null],
    ["panel: Esc は画面のキー（パネルを閉じる）", k("Escape"), "panel", null],
    ["full: f は何もしない", k("f"), "full", null],
    ["full: 2 で 2 番", k("2"), "full", { kind: "choose", n: 2 }],
    ["full: 案の数より大きい番号は無視", k("4"), "full", null],
    ["full: 入力欄の中の 1 は文字", k("1", { inText: true }), "full", null],
    [
      "full: ⌘⏎ で返す（入力欄の中でも）",
      k("Enter", { metaKey: true, inText: true }),
      "full",
      { kind: "send" },
    ],
    ["full: Esc で戻る（入力欄の中でも）", k("Escape", { inText: true }), "full", { kind: "back" }],
    ["figure: Esc で戻る", k("Escape"), "figure", { kind: "back" }],
    ["figure: 1 は何もしない", k("1"), "figure", null],
    ["figure: ⌘⏎ は何もしない", k("Enter", { metaKey: true }), "figure", null],
  ] as const)("%s", (_name, input, where, out) => {
    expect(askKeyAction(input, where, 3)).toEqual(out);
  });
  test("ヒントの行はキーのとおり（パネルは f、広げた画面は esc）", () => {
    expect(panel(ask())).toContain("1–3 to choose · ⌘⏎ to send · f to expand");
    expect(overlay(ask())).toContain("1–3 to choose · ⌘⏎ to send · esc to close");
    expect(
      render(createElement(AskBody, { v: ask(), workItemId: null, layout: "panel" }), "ja"),
    ).toContain("1–3 で選ぶ · ⌘⏎ で返す · f で広げる");
  });
});

describe("フォーカスの罠", () => {
  test("Tab は最後から最初へ、⇧Tab は最初から最後へ。枠の外なら端から", () => {
    expect(trapIndex(3, 0, false)).toBe(1);
    expect(trapIndex(3, 2, false)).toBe(0);
    expect(trapIndex(3, 0, true)).toBe(2);
    expect(trapIndex(3, -1, false)).toBe(0);
    expect(trapIndex(3, -1, true)).toBe(2);
    expect(trapIndex(0, -1, false)).toBe(-1);
  });
});

describe("広げた画面の見た目", () => {
  test("パネル: 広げるボタン（名前とキー）と、図を大きくするボタン", () => {
    const p = panel(ask());
    expect(p).toMatch(/aria-label="Expand"[^>]*data-testid="ask-expand"/);
    expect(p).toMatch(
      /aria-label="Enlarge the figure for Bottom"[^>]*data-testid="ask-option-zoom"/,
    );
    expect(panel(ask())).not.toContain('role="dialog"');
  });
  test("全体: モーダルの枠、案を横に並べ説明は下、図はすべて sandbox が空で Tab で入らない", () => {
    const o = overlay(ask());
    expect(o).toMatch(/role="dialog"[^>]*aria-modal="true"/);
    expect(o).toContain('data-view="full"');
    expect(o).toContain('data-layout="row"');
    // 問い → 案の列 → 説明 の順、メモと返すボタンはスクロールの外（下に固定）
    const q = o.indexOf('data-testid="ask-question"');
    const row = o.indexOf('data-testid="ask-options"');
    const ex = o.indexOf('data-testid="ask-explain"');
    const scrollEnd = o.indexOf('data-testid="ask-footer"');
    expect(q).toBeLessThan(row);
    expect(row).toBeLessThan(ex);
    expect(ex).toBeLessThan(scrollEnd);
    expect(o.indexOf('data-testid="ask-note"')).toBeGreaterThan(scrollEnd);
    expect(o.indexOf('data-testid="ask-send"')).toBeGreaterThan(scrollEnd);
    // 3 案: 1 列 → 2 列 → 3 列（1 列 280px を下回ると折り返す）
    expect(o).toMatch(
      /grid-cols-1 @\[576px\]:grid-cols-2 @\[872px\]:grid-cols-3[^"]*" data-testid="ask-options"/,
    );
    // 図はカードの上で幅いっぱい、図の縦横比（既定 480×320 の SVG の viewBox 60×40 → 480×320）
    expect(o).toMatch(
      /w-full border-line border-b[^"]*" style="aspect-ratio:480 \/ 320;max-height:60vh"/,
    );
    expect(o).toContain("rounded-pop");
    expect(o).not.toContain('data-testid="ask-expand"');
    const tags = iframes(o);
    expect(tags.length).toBe(2);
    for (const tag of tags) {
      expect(tag).toContain('sandbox=""');
      expect(tag).not.toContain("allow-");
      expect(tag).not.toMatch(/\ssrc="/);
      expect(tag).toContain('tabindex="-1"');
      expect(tag).toContain('referrerPolicy="no-referrer"');
    }
  });
  test("全体: 説明が無くても案は横に並ぶ。図が 1 つも無ければ小さなカードのまま", () => {
    const o = overlay(ask({}, ["explain"]));
    expect(o).toContain('data-layout="row"');
    expect(o).not.toContain('data-testid="ask-explain"');
    const v = ask({}, ["explain"]);
    const plain = overlay({
      ...v,
      options: (v.options ?? []).map(({ figure: _f, ...o }) => o),
    });
    expect(plain).toContain('data-layout="compact"');
    expect(plain).not.toContain('data-testid="ask-option-zoom"');
    expect(plain).toContain('data-testid="ask-footer"');
  });
  test("全体: 案の数ごとの列（2 案は 2 列まで、4 案は 4 列 → 2 列 → 1 列）", () => {
    const v = ask();
    const opts = v.options ?? [];
    const two = overlay({ ...v, options: opts.slice(0, 2) });
    expect(two).toMatch(/grid-cols-1 @\[576px\]:grid-cols-2" data-testid="ask-options"/);
    const four = overlay({
      ...v,
      options: [
        ...opts,
        { n: 4, label: "Inline", description: "Next to each field.", recommended: false },
      ],
    });
    expect(four).toMatch(
      /grid-cols-1 @\[576px\]:grid-cols-2 @\[1168px\]:grid-cols-4" data-testid="ask-options"/,
    );
  });
  test("パネル: 案の図は右に小さく（112×80）、右下に「大きく」の印", () => {
    const p = panel(ask());
    expect(p).toMatch(/h-20 w-28[^"]*"[^>]*data-testid="ask-option-zoom"/);
    expect(p).toContain('data-testid="ask-option-zoom-mark"');
    expect(p).not.toContain('data-testid="ask-footer"');
  });
  test("枠に title 属性を付けない（WKWebView でずれたツールチップになる）。名前は aria-label", () => {
    for (const tag of iframes(overlay(ask()))) {
      expect(tag).not.toMatch(/\stitle="/);
      expect(tag).toMatch(/aria-label="[^"]+"/);
    }
    expect(overlay(ask())).toContain('aria-label="AI&#x27;s explanation"');
  });
  test("全体: 読めない図は 1 行のまま", () => {
    expect(overlay(ask())).toContain("Couldn&#x27;t read the figure");
  });
  test("図 1 枚: その図だけを枠いっぱいに。sandbox は空、CSP は先頭のまま", () => {
    const o = overlay(ask(), { figure: 1, full: false });
    expect(o).toContain('data-view="figure"');
    expect(o).toContain("Figure for Bottom");
    const tags = iframes(o);
    expect(tags.length).toBe(1);
    const tag = tags[0] ?? "";
    expect(tag).toContain('data-testid="ask-figure-frame"');
    expect(tag).toContain('sandbox=""');
    expect(tag).not.toContain("allow-");
    const doc = srcdocOf(tag);
    const csp = doc.indexOf(`<meta http-equiv="Content-Security-Policy" content="${FIGURE_CSP}">`);
    expect(csp).toBeGreaterThan(0);
    expect(csp).toBeLessThan(doc.indexOf("<svg"));
    // 図の大きさ（viewBox 60×40 → 480×320）の文書を描いて枠ごと縮める・広げる
    expect(tag).toContain('data-canvas="480x320"');
    expect(doc).toContain("html,body{width:480px;height:320px;overflow:hidden}");
    expect(doc).toContain("body>svg:first-of-type{display:block;width:100%;height:100%");
  });
  test("図 1 枚（全体から開いた）: 全体は隠して残す（戻るとスクロールとフォーカスがそのまま）", () => {
    const o = overlay(ask(), { figure: 1, full: true });
    expect(o).toMatch(/class="hidden" data-testid="ask-overlay-full"/);
    expect(o).toContain('data-testid="ask-figure-frame"');
    for (const tag of iframes(o)) expect(tag).toContain('sandbox=""');
  });
  test("問いが閉じたら「もう進んでいます」と閉じるボタン（全体でも図でも）", () => {
    for (const s of [{}, { figure: 1 }]) {
      const o = overlay(
        ask({ state: "cancelled", closedAt: 5 }, ["question", "context", "options", "explain"]),
        s,
      );
      expect(o).toContain("It&#x27;s already moved on");
      expect(o).toContain('data-testid="ask-overlay-dismiss"');
      expect(iframes(o).length).toBe(0);
    }
  });
  test("ほかで返された問いは「返しました」", () => {
    const o = overlay(ask({ state: "answered", closedAt: Date.UTC(2026, 0, 1, 1, 25) }));
    expect(o).toContain("Sent at 10:25");
  });
});
