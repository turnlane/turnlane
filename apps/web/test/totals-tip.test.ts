/**
 * 見出しの集計のホバー（R79）: 期限切れは期限切れになった件の件名と閉じた時刻を閉じた順に 1 件 1 行（3 件まで、超えた分は
 * 「ほか N 件」）。放置はリポジトリ別の放置を長い順に。1 行目は定義
 */
import { describe, expect, test } from "bun:test";
import type { ClosedTodayRow } from "@turnlane/core/web";
import { expiredTipLines, idleTipLines, tipLines, totalsTip } from "../src/board/totals-tip.ts";
import { closedFallback } from "../src/components/TurnRow.tsx";
import { translate } from "../src/i18n/index.tsx";

const TZ = "Asia/Tokyo";
/** 2026-10-02 の JST の時刻 */
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return Date.UTC(2026, 9, 2, h - 9, m);
};
const row = (o: Partial<ClosedTodayRow>): ClosedTodayRow => ({
  followUpId: "f",
  workItemId: "w",
  title: { t: "text", text: "x" },
  kind: "expired",
  via: null,
  signal: null,
  closedAt: at("09:00"),
  repoRoot: null,
  branch: null,
  ...o,
});
const auto = (title: string): ClosedTodayRow["title"] => ({
  t: "auto",
  key: "followup.reply",
  params: { title, repo: "turnlane", branch: "chore/x", pr: null, prTitle: null },
});
const more = (locale: "ja" | "en") => (count: number) =>
  translate(locale, "totals.tipMore", { count });

describe("期限切れのホバーの内訳", () => {
  test("期限切れだけを閉じた順に 件名 · 時刻。件名は閉じた行の既定の件名（前置きの「返答:」を付けない）", () => {
    const rows = [
      row({ kind: "replied", title: auto("Dependency update"), closedAt: at("08:50") }),
      row({ title: auto("設定のキー名の変更"), closedAt: at("13:20") }),
      row({ kind: "not_needed", title: auto("Check log output"), closedAt: at("12:05") }),
      row({ title: auto("古いブランチの整理"), closedAt: at("09:00") }),
    ];
    expect(
      expiredTipLines(rows, { subject: (r) => closedFallback(r, "ja"), tz: TZ, more: more("ja") }),
    ).toEqual(["古いブランチの整理 · 9:00", "設定のキー名の変更 · 13:20"]);
  });

  test("3 件まで。超えた分は「ほか N 件」/ and N more", () => {
    const rows = ["09:00", "10:00", "11:00", "12:00", "13:00"].map((h, i) =>
      row({ followUpId: `f${i}`, title: { t: "text", text: `item ${i}` }, closedAt: at(h) }),
    );
    const o = { subject: (r: Pick<ClosedTodayRow, "title">) => closedFallback(r, "en"), tz: TZ };
    expect(expiredTipLines(rows, { ...o, more: more("ja") })).toEqual([
      "item 0 · 9:00",
      "item 1 · 10:00",
      "item 2 · 11:00",
      "ほか 2 件",
    ]);
    expect(expiredTipLines(rows, { ...o, more: more("en") }).at(-1)).toBe("and 2 more");
    expect(expiredTipLines(rows.slice(0, 3), { ...o, more: more("en") })).toHaveLength(3);
  });

  test("長い件名は 40 文字で … に切り、改行・連続の空白は 1 つに", () => {
    const long = "あ".repeat(60);
    const [line] = expiredTipLines([row({ title: { t: "text", text: `${long}\n  続き` } })], {
      subject: (r) => closedFallback(r, "ja"),
      tz: TZ,
      more: more("ja"),
    });
    expect(line).toBe(`${"あ".repeat(39)}… · 9:00`);
  });

  test("閉じた行が無ければ内訳は空（定義だけ）", () => {
    const lines = expiredTipLines([], { subject: () => "", tz: TZ, more: more("ja") });
    expect(lines).toEqual([]);
    expect(totalsTip("72時間で期限切れになった自分の番の件数", lines)).toBe(
      "72時間で期限切れになった自分の番の件数",
    );
  });
});

describe("放置のホバーの内訳", () => {
  test("リポジトリ別の放置を長い順に。0 は出さない。3 件を超えたら「ほか N 件」", () => {
    const name = (x: { repoRoot: string | null; scratch?: boolean }) =>
      x.repoRoot
        ? (x.repoRoot.split("/").at(-1) ?? "")
        : x.scratch
          ? "壁打ち"
          : "（リポジトリなし）";
    const lines = idleTipLines(
      [
        { repoRoot: "/w/turnlane", ms: 13 * 60_000 },
        { repoRoot: "/w/api-gateway", ms: 22 * 60_000 },
        { repoRoot: null, scratch: true, ms: 5 * 60_000 },
        { repoRoot: null, ms: 2 * 60_000 },
        { repoRoot: "/w/blog", ms: 0 },
      ],
      { name, more: more("ja") },
    );
    expect(lines).toEqual(["api-gateway 22m", "turnlane 13m", "壁打ち 5m", "ほか 1 件"]);
  });
});

describe("ホバーの文", () => {
  test("定義の下に内訳を改行で", () => {
    expect(totalsTip("def", ["a", "b"])).toBe("def\na\nb");
    expect(tipLines([1, 2], String, (n) => `+${n}`, 1)).toEqual(["1", "+1"]);
  });
});
