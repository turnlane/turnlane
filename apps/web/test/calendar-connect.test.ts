/**
 * カレンダーの接続の段階（O4・設定 › カレンダー）。2026-10-21 の Neo: authorize が 1 で終わっても画面が待ち続けた
 */
import { describe, expect, test } from "bun:test";
import type { CalendarConnectAttempt } from "@turnlane/core/web";
import {
  CALENDAR_DIALOG_WAIT_MS,
  CALENDAR_WAIT_MS,
  nextCalendarPhase,
  type PhaseInput,
} from "../src/onboarding/calendar-connect.ts";

const T0 = 1_000_000;
const status = (o: Partial<PhaseInput["status"]> = {}): PhaseInput["status"] => ({
  connected: true,
  authorization: "notDetermined",
  lastSyncedAt: null,
  calendars: { total: 0 },
  ...o,
});
const attempt = (o: Partial<CalendarConnectAttempt> = {}): CalendarConnectAttempt => ({
  id: 1,
  state: "running",
  startedAt: T0,
  finishedAt: null,
  code: null,
  detail: null,
  ...o,
});
const input = (o: Partial<PhaseInput> = {}): PhaseInput => ({
  phase: "waiting",
  status: status(),
  attempt: attempt(),
  attemptId: 1,
  startedAt: T0,
  now: T0 + 1000,
  ...o,
});

describe("nextCalendarPhase", () => {
  const detail = "macOS did not show the calendar access dialog; access is still not decided";
  const cases: [string, PhaseInput, ReturnType<typeof nextCalendarPhase>][] = [
    ["待っている間は変えない", input(), null],
    [
      "接続が 1 で終わった → 失敗（stderr の要約）",
      input({ attempt: attempt({ state: "failed", code: 1, detail }) }),
      { phase: "failed", failure: { kind: "detail", detail } },
    ],
    [
      "前の接続の失敗は見ない",
      input({ attempt: attempt({ id: 1, state: "failed", detail }), attemptId: 2 }),
      null,
    ],
    [
      "接続の結果が分からないまま 30 秒たっても未決定 → 失敗（応答なし）",
      input({ attempt: null, now: T0 + CALENDAR_WAIT_MS + 1 }),
      { phase: "failed", failure: { kind: "timeout" } },
    ],
    [
      "authorize が動いている（ダイアログが出ている）間は 30 秒では打ち切らない",
      input({ now: T0 + CALENDAR_WAIT_MS + 1 }),
      null,
    ],
    [
      "authorize が動いたまま 120 秒 → 失敗（応答なし）",
      input({ now: T0 + CALENDAR_DIALOG_WAIT_MS + 1 }),
      { phase: "failed", failure: { kind: "timeout" } },
    ],
    [
      "Neo: 許可の後、常駐のヘルパを起こし直してつながっていない数秒は待つ（押してから 30 秒を過ぎていても）",
      input({
        attempt: attempt({ state: "ok", code: 0 }),
        status: status({ connected: false, authorization: null }),
        settledAt: T0 + 40_000,
        now: T0 + 45_000,
      }),
      null,
    ],
    [
      "接続が 0 で終わってから 30 秒つながらない → 失敗（ヘルパ）",
      input({
        attempt: attempt({ state: "ok", code: 0 }),
        status: status({ connected: false, authorization: null }),
        settledAt: T0 + 40_000,
        now: T0 + 40_000 + CALENDAR_WAIT_MS + 1,
      }),
      { phase: "failed", failure: { kind: "helper" } },
    ],
    [
      "30 秒たってもヘルパがつながらない → 失敗（ヘルパ）",
      input({
        attempt: null,
        status: status({ connected: false, authorization: null }),
        now: T0 + CALENDAR_WAIT_MS + 1,
      }),
      { phase: "failed", failure: { kind: "helper" } },
    ],
    [
      "接続が 0 で終わってもフルアクセスの同期を待つ",
      input({
        attempt: attempt({ state: "ok", code: 0 }),
        status: status({ authorization: "fullAccess" }),
      }),
      null,
    ],
    [
      "許可されて同期が済んだ → 許可済み",
      input({
        status: status({ authorization: "fullAccess", lastSyncedAt: T0, calendars: { total: 3 } }),
      }),
      { phase: "granted", failure: null },
    ],
    [
      "失敗の表示の後でも、許可されたら進む",
      input({
        phase: "failed",
        status: status({ authorization: "fullAccess", lastSyncedAt: T0, calendars: { total: 0 } }),
      }),
      { phase: "none", failure: null },
    ],
    [
      "拒否（authorize は 1 で終わるが、失敗ではなく拒否の案内）",
      input({
        status: status({ authorization: "denied" }),
        attempt: attempt({ state: "failed", code: 1, detail: "Calendar access is off." }),
      }),
      { phase: "denied", failure: null },
    ],
    ["失敗の表示のまま（未決定）は変えない", input({ phase: "failed", now: T0 + 60_000 }), null],
    ["unavailable は変えない", input({ phase: "unavailable" }), null],
  ];
  for (const [name, x, want] of cases)
    test(name, () => {
      expect(nextCalendarPhase(x)).toEqual(want);
    });
});
