/** 集中モード（D-097。m2-api 25章）の API の形 */

import type { NativeMenuText } from "../desktop/menu-text.ts";
import type { EpochMs } from "./common.ts";

/** GET /api/focus */
export interface FocusView {
  active: {
    since: EpochMs;
    until: EpochMs;
    source: "meeting" | "manual";
    title: string | null;
    /** `集中モード中 · 16:00 まで`（デーモンで組み立てる） */
    label: string;
  } | null;
  /** 開いている問い（会議の開始の N 分前〜開始） */
  prompt: {
    key: string;
    title: string | null;
    start: EpochMs;
    end: EpochMs;
    /** `15:00 デザインレビュー · 集中モードにしますか？` */
    label: string;
  } | null;
  /** desktop = デスクトップアプリの通知のボタンで聞く / band = 画面上部の帯で聞く */
  channel: "desktop" | "band";
  /** 「次の予定の終わりまで」の終わり（無ければ null） */
  nextEventEnd: EpochMs | null;
  /**
   * 今の集中の間に止めた通知（カードの数。集中していなければ 0）。画面上部とポップオーバーの帯の右端
   * `止めた通知 3`（ux-mvp 4.15）。HTTP の層（focus-routes）で足す。古いデーモンには無い
   */
  held?: number;
  /** 「この予定の間は集中する」を設定した予定（calendar_event.id。D-130。古いデーモンには無い） */
  reserved?: { eventId: string; start: EpochMs; end: EpochMs }[];
}

export type FocusStartInput = { minutes: 30 | 60 } | { until: "event_end" };

/** GET /api/queue/summary に足すもの（メニューバー。文言はデーモンで解決する） */
export interface FocusSummaryExtras {
  focus: { label: string } | null;
  focusMenu: { title: string; m30: string; h1: string; event: string; end: string };
  /** 「次の予定の終わりまで」を選べる */
  focusEventAvailable: boolean;
  /** ネイティブのメニュー（メニューバーの右クリックとアプリのメニュー）の文言。古いデーモンには無い */
  nativeMenu?: NativeMenuText;
}
