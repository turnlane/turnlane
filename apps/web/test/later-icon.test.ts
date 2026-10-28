/**
 * 後でにした自分の番（スヌーズ・明日へ・時間に置いた開始の前）の状態アイコン: 丸に時計（控えめな色）。明ければ矢印に戻る
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { QueueFollowUp, QueueItem } from "@turnlane/core/web";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LaterRow } from "../src/components/LaterRow.tsx";
import { StatusIcon } from "../src/components/StatusIcon.tsx";
import { I18nProvider } from "../src/i18n/index.tsx";
import { deferredTurn } from "../src/lib/later-text.ts";

const TZ = "Asia/Tokyo";
const TODAY = "2026-10-28";
const NOW = Date.UTC(2026, 9, 28, 3, 0);

const wrap = (el: ReactNode) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(I18nProvider, { locale: "ja" } as Parameters<typeof I18nProvider>[0], el),
    ),
  );
const icon = (p: Parameters<typeof StatusIcon>[0]) => wrap(createElement(StatusIcon, p));

const fu = (p: Partial<QueueFollowUp> = {}): QueueFollowUp => ({
  id: "f1",
  kind: "reply",
  status: "snoozed",
  title: { t: "text", text: "x" },
  triggerAt: 0,
  snoozeUntil: Date.UTC(2026, 9, 28, 6, 0),
  engagedAt: null,
  expiresAt: null,
  taskId: "task",
  taskDate: TODAY,
  task: null,
  ...p,
});
const item = (f: QueueFollowUp): QueueItem => ({
  workItemId: "wi",
  title: "Fixture work",
  status: "your_turn",
  reason: "question",
  estimated: false,
  repoRoot: "/fixture/repo-a",
  branch: "feat/x",
  prRef: null,
  sources: [],
  waitingSince: 0,
  waitStartedAway: false,
  followUps: [f],
});

describe("StatusIcon の later", () => {
  test("自分の番 · 後で は丸に時計（控えめな色・ラベル）。無ければ矢印", () => {
    const later = icon({ status: "your_turn", later: true });
    const arrow = icon({ status: "your_turn" });
    expect(later).toContain('data-later="1"');
    expect(later).toContain("text-fg3");
    expect(later).toContain('d="M8 4.6V8l2.4 1.6"');
    expect(later).not.toContain('d="M5 8h5.2M8 5.4 10.6 8 8 10.6"');
    expect(later).toContain('aria-label="自分の番 · 後で"');
    expect(arrow).toContain('d="M5 8h5.2M8 5.4 10.6 8 8 10.6"');
    expect(arrow).toContain("text-turn");
    expect(arrow).not.toContain("data-later");
  });

  test("ほかの状態は later でも変えない（完了の ✓ など）", () => {
    expect(icon({ status: "done", later: true })).toBe(icon({ status: "done" }));
    expect(icon({ status: "needs_input", later: true })).toBe(icon({ status: "needs_input" }));
  });

  test("後でが明けて open に戻れば（deferredTurn が false）矢印", () => {
    const snoozed = item(fu());
    const woke = item(fu({ status: "open", snoozeUntil: null }));
    expect(deferredTurn(snoozed)).toBe(true);
    expect(deferredTurn(woke)).toBe(false);
    expect(icon({ status: "your_turn", later: deferredTurn(woke) })).toBe(
      icon({ status: "your_turn" }),
    );
  });
});

describe("出す場所", () => {
  test("自分の番の画面の「後で」の行: 丸に時計", () => {
    const out = wrap(createElement(LaterRow, { item: item(fu()), now: NOW, tz: TZ, today: TODAY }));
    expect(out).toContain('data-later="1"');
  });

  test("AI の詳細パネルの見出しと AI のレーンの最後のブロックも同じ判定を渡す", () => {
    const src = (p: string) => readFileSync(join(import.meta.dir, "../src", p), "utf8");
    expect(src("panel/AiPanel.tsx")).toContain("later={later !== null}");
    expect(src("board/AiLane.tsx")).toContain("later={b.last && laters.has(b.item.id)}");
  });
});
