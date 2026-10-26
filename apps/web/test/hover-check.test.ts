/**
 * ○（完了のチェック）とホバーのボタンの出し方（D-139 (4)・D-148。オーナーの画像 T4 で改めた）:
 * - ○ はマウスを乗せたとき・選んでいるときだけ。透明にするだけ（場所は取ったまま・支援技術から読める・focus-visible で出る）。
 *   完了の ✓ は常に塗って出す。選んだ行・カードは data-selected を持つ。完了の題名に取り消し線を付けない
 * - 自分の番の行は左の ○ を出さず、ホバーのボタンの先頭に ✓「対応済みにする」（Space）
 * - Inbox は完了にした行をその場に残し（recentDone）、後で「今日閉じた n」へ移す
 * - 時間軸のカード（3日のボード・デイビューの時刻の位置に置いたタスク）は左の ○ を持たない（D-148）。完了は右のホバーの
 *   ボタンの ✓。並びは ✓ →| ⋯。完了済みは ✓ を塗って、押すと未完了に戻す。Inbox・自分の番の行、未定・トレーのカードは ○ のまま
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { translate } from "../src/i18n/index.tsx";
import { LINGER_MS } from "../src/lib/store.ts";

const SRC = join(import.meta.dir, "../src");
const src = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("D-139: ○ はマウスを乗せたとき・選んでいるときだけ", () => {
  const ui = src("components/ui.tsx");
  test("Check の reveal は透明にするだけで、ホバー・選択・フォーカスで出す。完了の ✓ は常に", () => {
    expect(ui).toContain("reveal && !checked");
    for (const c of [
      "opacity-0",
      "group-hover:opacity-100",
      "group-data-[selected]:opacity-100",
      "focus-visible:opacity-100",
    ])
      expect(ui).toContain(c);
    // 隠し方は透明だけ（hidden / display:none / aria-hidden にしない）
    const check = ui.slice(
      ui.indexOf("export function Check("),
      ui.indexOf("export function Popover("),
    );
    expect(check).not.toContain('"hidden"');
    expect(check).not.toContain("aria-hidden={reveal");
    // 完了は塗った ✓（T4）
    expect(check).toContain("border-fg bg-fg text-bg");
  });
  test("タスクのカード（未定・トレー）・Inbox の行は reveal と data-selected（デイビューのブロックは ○ なし。D-148）", () => {
    for (const f of ["components/items.tsx", "components/InboxRow.tsx"]) {
      const s = src(f);
      expect(s).toContain("reveal");
      expect(s).toContain('data-selected={selected ? "" : undefined}');
    }
    expect(src("day/DayView.tsx")).toContain('data-selected={selected ? "" : undefined}');
  });
  test("ホバーのボタンは選んでいる行・カードでも出す", () => {
    expect(src("components/HoverToolbar.tsx")).toContain("group-data-[selected]:flex");
  });
  test("完了の題名に取り消し線を付けない（カード・デイビュー・Inbox・自分の番の閉じた行）", () => {
    for (const f of [
      "components/items.tsx",
      "day/DayView.tsx",
      "components/InboxRow.tsx",
      "components/TurnRow.tsx",
    ])
      expect(src(f)).not.toContain("line-through");
  });
});

describe("D-139: 自分の番の行", () => {
  const row = src("components/TurnRow.tsx");
  test("左に ○ を出さない（ふだんは状態アイコンだけ）。ホバーのボタンは 開く・対応不要・…（D-214 の §4）", () => {
    const body = row.slice(
      row.indexOf("export function TurnRow("),
      row.indexOf("export function WaitText("),
    );
    expect(body).not.toContain("<Check");
    expect(body).toContain('data-selected={selected ? "" : undefined}');
    const bar = row.slice(
      row.indexOf("function TurnToolbar("),
      row.indexOf("export function closedLabel("),
    );
    expect(bar).toContain('id: "open"');
    expect(bar).toContain("dismiss,");
    expect(bar).toContain("onMore=");
    expect(bar).not.toContain('keyId: "complete"');
    // 押す操作の言葉は「完了」と「対応不要」の 2 つ
    expect(translate("ja", "turn.markDone")).toBe("完了");
    expect(translate("en", "turn.markDone")).toBe("Done");
  });
  test("閉じた行は右に何で閉じたかと時刻", () => {
    expect(row).toContain("fmtClock(row.closedAt, tz)");
    expect(translate("ja", "turn.closedVia.approve")).toBe("許可");
    expect(translate("ja", "turn.closedVia.answer")).toBe("回答");
  });
});

describe("D-139: Inbox の完了", () => {
  test("完了にした行は数秒その場に残し（「完了 · 少しして今日閉じたへ」）、その後「今日閉じた n」へ", () => {
    expect(LINGER_MS).toBeGreaterThanOrEqual(2000);
    expect(LINGER_MS).toBeLessThanOrEqual(8000);
    const page = src("routes/InboxPage.tsx");
    expect(page).toContain("s.recentDone");
    expect(page).toContain("<ClosedFold");
    expect(page).toContain("onToggle={() => void setComplete(x, false)}");
    expect(translate("ja", "inbox.doneMoving")).toBe("完了 · まもなく「今日閉じた」へ");
    expect(translate("ja", "board.closedFold", { count: 2 })).toBe("今日閉じた 2");
  });
});

describe("D-139: PO のレビュー（leftovers-a）", () => {
  test("時間軸のカードのホバーのボタンは ✓ →| ⋯（T4・D-148）", () => {
    const s = src("components/items.tsx");
    expect(s).toContain("timeline={positioned}");
    const bar = s.slice(
      s.indexOf("if (timeline)"),
      s.indexOf("  return (\n    <HoverToolbar", s.indexOf("if (timeline)") + 20),
    );
    expect(bar).toContain('id: "complete"');
    expect(bar).toContain('id: "move"');
    expect(bar).toContain("[complete, move]");
    expect(bar).not.toContain('id: "today"');
    expect(bar).not.toContain('id: "askAi"');
  });
  test("自分の番の行はホバーの間ボタンの幅を空ける（理由を隠さない。D-214 の §4）", () => {
    expect(src("components/TurnRow.tsx")).toContain("hover:pr-[86px]");
  });
});

const between = (s: string, a: string, b: string) =>
  s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));

describe("D-148: 時間軸のカード（3日のボード）", () => {
  const items = src("components/items.tsx");
  const card = between(items, "export function TaskCard(", "export function TaskToolbar(");
  test("位置を持つカード（positioned）には ○ を置かず、未定・トレーのカードには置く", () => {
    expect(card).toContain("{positioned ? null : (");
    expect(card).toContain("<Check");
    expect(card).toContain("reveal");
  });
  test("2行目以降の字下げは時間軸のカードでは無し", () => {
    expect(card).toContain('const indent = positioned ? "" : "pl-6"');
    expect(card).not.toContain('"pl-6 ');
    expect(card).not.toContain(' pl-6"');
  });
  test("完了済みのカードでもホバーのボタンを出し、✓ は左の ○ と同じ書き込み（onToggle）", () => {
    expect(card).toContain("actions && (!done || positioned)");
    expect(card).toContain("onComplete: onToggle");
    expect(card).toContain("done={done}");
  });
  test("ホバーのボタンは ✓ →| ⋯、完了済みは塗った ✓ と ⋯", () => {
    const bar = between(items, "export function TaskToolbar(", "export const BAR_COLOR");
    expect(bar).toContain('id: "complete"');
    expect(bar).toContain('keyId: "complete"');
    expect(bar).toContain("filled: done");
    expect(bar).toContain("buttons={done ? [complete] : [complete, move]}");
    expect(bar).toContain('done ? t("menu.uncomplete") : t("menu.complete")');
  });
});

describe("D-148: 時間軸のカード（デイビュー）", () => {
  const day = src("day/DayView.tsx");
  const block = between(day, "function MeBlock(", "// AI レーン");
  test("○ を置かず、2行目も字下げしない", () => {
    expect(block).not.toContain("<Check");
    expect(block).not.toContain("pl-[22px]");
  });
  test("右のホバーのボタン（✓ →| ⋯）で完了・未完了に戻す", () => {
    expect(block).toContain("<TaskToolbar");
    expect(block).toContain("timeline");
    expect(block).toContain("done={done}");
    expect(block).toContain("onComplete={() => void setComplete(task, !done)}");
  });
});

describe("D-148: ホバーのツールバーの塗った印", () => {
  const tb = src("components/HoverToolbar.tsx");
  test("filled のボタンは 16px の塗った丸の中にアイコンを置き、data-filled を持つ", () => {
    expect(tb).toContain("filled?: boolean");
    expect(tb).toContain('data-filled={b.filled ? "" : undefined}');
    expect(tb).toContain("rounded-full bg-fg text-bg");
  });
});

describe("D-148: 変えないもの", () => {
  test("Inbox の行は ○ のまま", () => {
    expect(src("components/InboxRow.tsx")).toContain("reveal");
  });
  test("ツールチップの言葉は既存のキー（ja / en）", () => {
    expect(translate("ja", "menu.complete")).toBe("完了");
    expect(translate("ja", "menu.uncomplete")).toBe("未完了に戻す");
    expect(translate("en", "menu.complete")).toBe("Complete");
    expect(translate("en", "menu.uncomplete")).toBe("Mark as not done");
  });
});
