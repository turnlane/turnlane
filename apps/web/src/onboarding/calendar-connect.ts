/**
 * カレンダーの接続の段階（O4 と 設定 › カレンダー で共通。onboarding.md 4.4・6 章）。
 * - 主ボタンで POST /api/onboarding/calendar/connect を始め、/api/calendar/status と GET /api/onboarding/calendar/connect を
 *   1 秒ごとに読む
 * - 許可・拒否は status から（失敗の表示の後でも、オンになれば進む）
 * - 接続（turnlane calendar authorize）が 0 以外で終わった・30 秒たっても決まらない → failed（理由を出す。2026-10-21 の Neo:
 *   ダイアログが出ずに「macOS の応答を待っています」のまま止まった）
 */

import { useQuery } from "@tanstack/react-query";
import type { CalendarConnectAttempt } from "@turnlane/core/web";
import type { CalendarStatusView } from "@turnlane/daemon";
import { useEffect, useRef, useState } from "react";
import { api, unwrap } from "../lib/api.ts";
import { connectCalendar, useCalendarStatus } from "./data.ts";

export type CalendarPhase =
  | "idle"
  | "waiting"
  | "granted"
  | "denied"
  | "none"
  | "failed"
  | "unavailable";

/** 失敗の理由: detail は turnlane の stderr の要約（英語）。timeout・helper は画面の文言 */
export type CalendarFailure =
  | { kind: "detail"; detail: string }
  | { kind: "timeout" }
  | { kind: "helper" }
  | { kind: "start" };

/**
 * 待ちの上限（過ぎたら失敗の案内を出し、裏では読み続ける）。
 * - 接続の結果が分からない（古いデーモン）: 押してから 30 秒
 * - 接続（turnlane calendar authorize）が動いている: OS のダイアログが出ていて人が読んでいることがあるので押してから 120 秒。
 *   ダイアログが出なければ authorize はすぐ 1 で終わる（failed の理由が先に出る）
 * - 接続が 0 で終わった（デーモンが常駐のヘルパのつながり直しまで確かめた後）: 終わったのを見てから 30 秒
 * 2026-10-21 の Neo: 許可した直後、常駐のヘルパが起こし直されてつながっていない数秒に「押してから 30 秒」を過ぎ、
 * 「カレンダーのヘルパが起動しません」になった
 */
export const CALENDAR_WAIT_MS = 30_000;
export const CALENDAR_DIALOG_WAIT_MS = 120_000;

export interface PhaseInput {
  phase: CalendarPhase;
  status: Pick<CalendarStatusView, "connected" | "authorization" | "lastSyncedAt"> & {
    calendars: { total: number };
  };
  attempt: CalendarConnectAttempt | null;
  /** この画面で始めた接続の id（それより前の接続の結果は見ない） */
  attemptId: number | null;
  /** 待ち始めた時刻（Date.now） */
  startedAt: number;
  /** この画面の接続が running でなくなったのを見た時刻（Date.now）。まだなら null */
  settledAt?: number | null;
  now: number;
}

export interface PhaseOutput {
  phase: CalendarPhase;
  failure: CalendarFailure | null;
}

/** 状態 → 段階（純粋関数。表駆動のテストは apps/web/test/calendar-connect.test.ts） */
export function nextCalendarPhase(x: PhaseInput): PhaseOutput | null {
  const st = x.status;
  if (x.phase === "unavailable") return null;
  if (st.connected && st.authorization === "fullAccess") {
    if (st.lastSyncedAt !== null || st.calendars.total > 0)
      return { phase: st.calendars.total > 0 ? "granted" : "none", failure: null };
    return null;
  }
  if (st.connected && st.authorization !== null && st.authorization !== "notDetermined")
    return { phase: "denied", failure: null };
  if (x.phase !== "waiting") return null;
  const a = x.attempt;
  if (a && x.attemptId !== null && a.id === x.attemptId && a.state === "failed")
    return {
      phase: "failed",
      failure: a.detail ? { kind: "detail", detail: a.detail } : { kind: "timeout" },
    };
  const mine = a !== null && x.attemptId !== null && a.id === x.attemptId;
  const over =
    !mine || x.attemptId === null
      ? x.now - x.startedAt > CALENDAR_WAIT_MS
      : a.state === "running"
        ? x.now - x.startedAt > CALENDAR_DIALOG_WAIT_MS
        : x.now - (x.settledAt ?? x.now) > CALENDAR_WAIT_MS;
  if (over)
    return { phase: "failed", failure: st.connected ? { kind: "timeout" } : { kind: "helper" } };
  return null;
}

/** GET /api/onboarding/calendar/connect（最後に始めた接続の結果） */
export function useCalendarAttempt(pollMs: number | false) {
  return useQuery({
    queryKey: ["onboarding", "calendar-attempt"],
    queryFn: () =>
      unwrap<{ attempt: CalendarConnectAttempt | null }>(
        api.api.onboarding.calendar.connect.$get(),
      ),
    refetchInterval: pollMs,
    enabled: pollMs !== false,
    retry: false,
  });
}

/** 接続の段階と操作（O4・設定 › カレンダー） */
export function useCalendarConnect() {
  const [phase, setPhase] = useState<CalendarPhase>("idle");
  const [failure, setFailure] = useState<CalendarFailure | null>(null);
  const [busy, setBusy] = useState(false);
  // 待ち・拒否・失敗の間は読み続ける（失敗の後に許可されたら進む）
  const polling = phase === "waiting" || phase === "denied" || phase === "failed";
  const status = useCalendarStatus(polling ? 1000 : false);
  const attempt = useCalendarAttempt(phase === "waiting" ? 1000 : false);
  const startedAt = useRef(0);
  const attemptId = useRef<number | null>(null);
  const settledAt = useRef<number | null>(null);
  const [tick, setTick] = useState(0);

  // 待ちの上限を過ぎたことに気づくための 1 秒ごとの再評価（status の取り直しが失敗しても進む）
  useEffect(() => {
    if (phase !== "waiting") return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const st = status.data;
  const at = attempt.data?.attempt ?? null;
  if (at && at.id === attemptId.current && at.state !== "running" && settledAt.current === null)
    settledAt.current = Date.now();
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick は時間の経過で再評価するため
  useEffect(() => {
    if (!st) return;
    const next = nextCalendarPhase({
      phase,
      status: st,
      attempt: at,
      attemptId: attemptId.current,
      startedAt: startedAt.current,
      settledAt: settledAt.current,
      now: Date.now(),
    });
    if (next && (next.phase !== phase || next.failure?.kind !== failure?.kind)) {
      setPhase(next.phase);
      setFailure(next.failure);
    }
  }, [st, at, phase, failure, tick]);

  const start = async () => {
    if (busy || phase === "waiting") return;
    setBusy(true);
    startedAt.current = Date.now();
    attemptId.current = null;
    settledAt.current = null;
    setFailure(null);
    // 押した直後から「待っています」（接続の開始の応答は 1.5 秒かかることがある）
    setPhase("waiting");
    try {
      const r = await connectCalendar();
      attemptId.current = r.attempt?.id ?? null;
      if (!r.started) {
        if (r.reason === "failed") {
          setPhase("failed");
          setFailure(
            r.attempt?.detail ? { kind: "detail", detail: r.attempt.detail } : { kind: "start" },
          );
        } else setPhase("unavailable");
      }
    } catch {
      setPhase("failed");
      setFailure({ kind: "start" });
    } finally {
      setBusy(false);
    }
  };

  return { phase, failure, busy, setBusy, status: st, start };
}
