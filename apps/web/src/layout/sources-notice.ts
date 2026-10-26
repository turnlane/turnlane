/**
 * サイドバーの取り込みの知らせ（D-118）: 取り込みが正常（OK）のときは何も出さない。推定か停止の取り込み元があるときだけ、
 * どの取り込み元か分かる1行の文を出す（1つなら名前、複数なら件数）。停止があれば停止を、無ければ推定を知らせる
 */
import type { HealthReport, SourceView } from "@turnlane/daemon";
import type { I18n, MessageKey } from "../i18n/index.tsx";

type T = I18n["t"];

export type SourceLevel = "ok" | "estimated" | "stopped";

export function levelOf(s: Pick<SourceView, "healthLevel">): SourceLevel {
  if (s.healthLevel === "L3") return "stopped";
  if (s.healthLevel === "L1" || s.healthLevel === "L2") return "estimated";
  return "ok";
}

/** 取り込み元の名前（同じツールのプロファイルが複数あればプロファイル名を付ける） */
export function sourceName(s: SourceView, all: SourceView[], t: T): string {
  const multi = all.filter((x) => x.enabled && x.tool === s.tool).length > 1;
  const toolKey = `sources.tool.${s.tool}` as MessageKey;
  return (
    (t(toolKey) === toolKey ? s.tool : t(toolKey)) +
    (multi && s.profileLabel ? ` · ${s.profileLabel}` : "")
  );
}

/** ホバーの1行（名前: 状態 — 理由） */
export function sourceLine(s: SourceView, all: SourceView[], t: T): string {
  const level = levelOf(s);
  const state =
    level === "stopped"
      ? t("sources.stopped")
      : level === "estimated"
        ? t("sources.estimated")
        : t("sources.ok");
  return `${sourceName(s, all, t)}: ${state}${s.healthReason ? ` — ${s.healthReason}` : ""}`;
}

export interface SourcesNotice {
  level: Exclude<SourceLevel, "ok">;
  /** サイドバーの1行（「Codex の取り込みが止まっています」「2件の取り込みが止まっています」） */
  text: string;
  /** ツールチップ: 状態の説明と、知らせに入った取り込み元ごとの状態 */
  detail: string;
}

/** 知らせの中身。すべて正常（または取り込み元が無い）なら null */
export function sourcesNotice(list: SourceView[], t: T): SourcesNotice | null {
  const stopped = list.filter((x) => levelOf(x) === "stopped");
  const estimated = list.filter((x) => levelOf(x) === "estimated");
  const hit = stopped.length > 0 ? stopped : estimated;
  if (hit.length === 0) return null;
  const level = stopped.length > 0 ? "stopped" : "estimated";
  const one = hit.length === 1 ? (hit[0] as SourceView) : null;
  const text = one
    ? t(level === "stopped" ? "sources.notice.stoppedOne" : "sources.notice.estimatedOne", {
        name: sourceName(one, list, t),
      })
    : t(level === "stopped" ? "sources.notice.stoppedMany" : "sources.notice.estimatedMany", {
        n: hit.length,
      });
  const why = t(level === "stopped" ? "sources.notice.stoppedWhy" : "sources.notice.estimatedWhy");
  const lines = [...stopped, ...estimated].map((x) => sourceLine(x, list, t));
  return { level, text, detail: [why, ...lines].join("\n") };
}

export type CalendarProblem = NonNullable<HealthReport["calendarHelper"]["problem"]>;

export interface CalendarNotice {
  problem: CalendarProblem;
  /** サイドバーの1行（「カレンダーの予定を取れていません」） */
  text: string;
  /** ツールチップ: どうして取れていないか */
  detail: string;
}

/**
 * カレンダーの知らせ（D-130。D-118 の取り込みの知らせに足す）: 権限が無い・ヘルパが未接続・同期が失敗し続けているとき
 * だけ。判定（未接続は2分、失敗は15分たってから・カレンダーを使っていなければ出さない）はデーモン
 */
export function calendarNotice(
  problem: HealthReport["calendarHelper"]["problem"],
  t: T,
): CalendarNotice | null {
  if (!problem) return null;
  return {
    problem,
    text: t("calendar.notice.text"),
    detail: t(`calendar.notice.${problem}` as MessageKey),
  };
}
