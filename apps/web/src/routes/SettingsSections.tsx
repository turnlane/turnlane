/**
 * 設定画面の残り（M2-9。phase0-plan 4.3、ux-mvp 2章）:
 * - 取り込み元: 検出したもの（設定ディレクトリ＝プロファイルごと。D-017）、オン・オフ、健全性、hooks、除外（glob）、再検出
 * - 日付区切り（集計と儀式の区切り。D-054）
 * - 祝日（稼働日のうち祝日カレンダー。M3-6。「Holidays from」は同じ名前をまとめて件数を添える。D-057 (2)）
 * - カレンダーの役割（表示する / 無視する / 書き戻し先。書き戻し先は M3-3）
 * - AI の待ちと自分の番: フォローアップの種類、猶予、返答タスクの期限、git 管理外の編集の期限（24時間ルール）
 * - プライバシー（AI セッションの題名を保存するか。ADR 0005）
 * - 壁打ちのフォルダ（D-135。ai.scratch_dirs）: この下で動いた AI のセッションをプロジェクトに属さない「壁打ち」として出す
 * - プロジェクトとリポジトリの対応（M2-9。m2-api 19章）: 新しい自分の番のタスクと確認タスクにプロジェクトを付ける
 * - 日報の AI 要約（M4-6。D-041・D-044 (4)）: オン・オフ、使うツール、送る内容と送り先の説明、CLI の検出結果
 * 値の読み書きは /api/sources・/api/calendars・/api/calendar/status・/api/config。CLI（turnlane sources・turnlane calendar・turnlane config）と同じ。
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  groupHolidaySources,
  type ProjectReposResponse,
  type ProjectView,
  type ReportSourcesResponse,
  type SummaryToolsResponse,
} from "@turnlane/core/web";
import type {
  CalendarStatusView,
  CalendarView,
  SourceView,
  TimeblockEventsSummary,
} from "@turnlane/daemon";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CalendarColorButton } from "../components/CalendarColors.tsx";
import { MenuSelect } from "../components/MenuSelect.tsx";
import { ConfirmDialog } from "../components/ui.tsx";
import { keys } from "../data/invalidate.ts";
import { useSources } from "../data/queries.ts";
import { type MessageKey, useI18n, useT } from "../i18n/index.tsx";
import { ApiError, api, unwrap } from "../lib/api.ts";
import { calColor } from "../lib/cal-color.ts";
import { blurOnEnter, isImeKey } from "../lib/ime.ts";
import { CalendarConnectRow } from "./CalendarConnectRow.tsx";
import { ProjectLaunchFields } from "./LaunchSettings.tsx";

export function Segmented<V extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: V;
  options: { v: V; label: string }[];
  onChange: (v: V) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex shrink-0 rounded-card border border-line p-0.5"
    >
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: 分割ボタンの見た目のため button に role を付ける
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onChange(o.v)}
          className={`h-7 whitespace-nowrap rounded-chip px-3 text-body ${value === o.v ? "bg-raised text-fg" : "text-fg2 hover:text-fg"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

async function putConfig(key: string, value: unknown): Promise<void> {
  await unwrap(api.api.config[":key"].$put({ param: { key }, json: { value } }));
}

function SectionHead({ k, hint, err }: { k: MessageKey; hint?: MessageKey; err?: boolean }) {
  const t = useT();
  return (
    <div>
      <h2 className="text-section">{t(k)}</h2>
      {hint ? (
        <p className={`text-meta ${err ? "text-error" : "text-fg3"}`}>
          {err ? t("settings.saveFailed") : t(hint)}
        </p>
      ) : null}
    </div>
  );
}

const DOT: Record<string, string> = {
  L0: "bg-[var(--dl-done)]",
  L1: "bg-[var(--dl-needs)]",
  L2: "bg-[var(--dl-needs)]",
  L3: "bg-[var(--dl-error)]",
};

/** 取り込み元（hooks の spool は内部のものなので出さない）。止めたものも出す（オンに戻せるように） */
export function SourcesSection() {
  const t = useT();
  const qc = useQueryClient();
  const q = useSources();
  const [err, setErr] = useState(false);
  const list = (q.data?.sources ?? []).filter((x) => x.tool !== "hook_spool");
  const patch = async (id: string, json: { enabled?: boolean; excludeGlobs?: string[] }) => {
    setErr(false);
    try {
      // PATCH /api/sources/:id は zod の検証を通さない経路なので、本文は init で渡す
      await unwrap(
        api.api.sources[":id"].$patch(
          { param: { id } },
          {
            init: { body: JSON.stringify(json), headers: { "content-type": "application/json" } },
          },
        ),
      );
    } catch {
      setErr(true);
    }
    void qc.invalidateQueries({ queryKey: keys.sources() });
  };
  const rescan = async () => {
    setErr(false);
    try {
      await unwrap(api.api.sources.rescan.$post());
    } catch {
      setErr(true);
    }
    void qc.invalidateQueries({ queryKey: keys.sources() });
  };
  return (
    <section className="flex flex-col gap-2" data-testid="settings-sources" data-setting="sources">
      <div className="flex items-start justify-between gap-4">
        <SectionHead k="settings.sources" hint="settings.sources.hint" err={err} />
        <button
          type="button"
          className="h-7 shrink-0 rounded-card border border-line px-3 text-body hover:border-fg3"
          onClick={() => void rescan()}
        >
          {t("settings.sources.rescan")}
        </button>
      </div>
      {q.data && list.length === 0 ? (
        <p className="text-body text-fg3">{t("sources.none")}</p>
      ) : null}
      {list.map((s) => (
        <SourceItem
          key={s.id}
          s={s}
          multi={list.filter((x) => x.tool === s.tool).length > 1}
          onPatch={(p) => void patch(s.id, p)}
        />
      ))}
    </section>
  );
}

function SourceItem({
  s,
  multi,
  onPatch,
}: {
  s: SourceView;
  multi: boolean;
  onPatch: (p: { enabled?: boolean; excludeGlobs?: string[] }) => void;
}) {
  const t = useT();
  const toolKey = `sources.tool.${s.tool}` as MessageKey;
  const name = t(toolKey) === toolKey ? s.tool : t(toolKey);
  const health: MessageKey =
    s.healthLevel === "L0"
      ? "settings.sources.health.ok"
      : s.healthLevel === "L3"
        ? "settings.sources.health.down"
        : "settings.sources.health.degraded";
  const hooksKey = `settings.sources.hooks.${s.hooksState}` as MessageKey;
  // MCP の登録（D-145）。Claude Code / Codex 以外・同意の前は出さない
  const mcpKey = `settings.sources.mcp.${s.mcpState}` as MessageKey;
  const mcpText = s.mcpState === "unknown" || t(mcpKey) === mcpKey ? null : t(mcpKey);
  const [ex, setEx] = useState(s.excludeGlobs.join("\n"));
  useEffect(() => setEx(s.excludeGlobs.join("\n")), [s.excludeGlobs]);
  const commit = () => {
    const next = ex
      .split(/[\n,]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (next.join("\n") !== s.excludeGlobs.join("\n")) onPatch({ excludeGlobs: next });
  };
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-card border border-line p-3 ${s.enabled ? "" : "opacity-70"}`}
      data-testid="source-item"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`size-2 shrink-0 rounded-full ${s.enabled ? (DOT[s.healthLevel] ?? DOT.L3) : "bg-fg3"}`}
            aria-hidden="true"
          />
          <span className="truncate font-medium text-body">
            {name}
            {multi && s.profileLabel ? ` · ${s.profileLabel}` : ""}
          </span>
        </div>
        <Segmented
          label={name}
          value={s.enabled ? "on" : "off"}
          options={[
            { v: "on", label: t("settings.sources.import") },
            { v: "off", label: t("settings.sources.skip") },
          ]}
          onChange={(v) => onPatch({ enabled: v === "on" })}
        />
      </div>
      <p className="truncate font-mono text-fg3 text-meta" title={s.rootPath}>
        {s.rootPath}
      </p>
      {s.tool === "report" ? (
        <ReportSources />
      ) : s.enabled ? (
        <p className="text-fg2 text-meta">
          {t(health)}
          {s.healthReason ? ` — ${s.healthReason}` : ""} ·{" "}
          {t(hooksKey) === hooksKey ? s.hooksState : t(hooksKey)}
          {mcpText ? (
            <>
              {" · "}
              <span data-testid="source-mcp" data-state={s.mcpState}>
                {mcpText}
              </span>
            </>
          ) : null}
        </p>
      ) : (
        <p className="text-fg3 text-meta">{t("settings.sources.skipped")}</p>
      )}
      {s.tool === "report" ? null : (
        <label className="flex flex-col gap-1 text-meta text-fg2">
          {t("settings.sources.exclude")}
          <textarea
            value={ex}
            onChange={(e) => setEx(e.target.value)}
            onBlur={commit}
            rows={Math.max(1, Math.min(4, ex.split("\n").length))}
            placeholder={t("settings.sources.excludePlaceholder")}
            className="resize-none rounded-card border border-line bg-bg px-2 py-1 font-mono text-body outline-none placeholder:text-fg3 focus:border-accent"
          />
        </label>
      )}
    </div>
  );
}

/**
 * 報告の取り込み元（ADR 0021）の説明と、報告してきた出どころ（GET /api/ai/reports/sources）。オン/オフは取り込み元の行の
 * 切り替え（全部の出どころをまとめて）
 */
function ReportSources() {
  const t = useT();
  const q = useQuery({
    queryKey: ["reportSources"],
    queryFn: () => unwrap<ReportSourcesResponse>(api.api.ai.reports.sources.$get()),
    retry: false,
  });
  const xs = q.data?.sources ?? [];
  return (
    <div className="flex flex-col gap-0.5 text-meta" data-testid="report-sources">
      <p className="text-fg2">{t("settings.sources.report.hint")}</p>
      {xs.length === 0 ? (
        <p className="text-fg3">{t("settings.sources.report.none")}</p>
      ) : (
        <p className="text-fg2">
          {xs
            .map((x) => t("settings.sources.report.item", { source: x.source, count: x.items }))
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

/** HH:MM の入力。欄を離れたか ⏎ で確定する。読めなければ元に戻す */
function HhmmInput({
  value,
  onCommit,
  label,
}: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
    const h = m ? Number(m[1]) : -1;
    const mm = m ? Number(m[2]) : -1;
    if (!(h >= 0 && h <= 23 && mm >= 0 && mm <= 59)) return setV(value);
    const next = `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    if (next !== value) onCommit(next);
    else setV(value);
  };
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={blurOnEnter}
      aria-label={label}
      inputMode="numeric"
      className="h-7 w-16 shrink-0 rounded-card border border-line bg-bg px-2 text-center font-mono text-body outline-none focus:border-accent"
    />
  );
}

/** 数の入力（時間・分）。欄を離れたか ⏎ で確定する */
export function NumInput({
  value,
  min,
  max,
  onCommit,
  label,
  unit,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
  label: string;
  unit: string;
}) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => {
    const n = Number(v.trim());
    if (!Number.isInteger(n) || n < min || n > max) return setV(String(value));
    if (n !== value) onCommit(n);
  };
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={blurOnEnter}
        aria-label={label}
        inputMode="numeric"
        className="h-7 w-14 rounded-card border border-line bg-bg px-2 text-right font-mono text-body outline-none focus:border-accent"
      />
      <span className="text-body text-fg2">{unit}</span>
    </span>
  );
}

function Row({
  title,
  hint,
  setting,
  children,
}: {
  title: string;
  hint?: string;
  /** 設定の検索で飛ぶ先（settings-index.ts の anchor） */
  setting?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4" data-setting={setting}>
      <div className="min-w-0">
        <h3 className="text-body">{title}</h3>
        {hint ? <p className="text-meta text-fg3">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

const FOLLOW_UP_KINDS = ["approve", "reply", "review_pr", "resume_error", "check_changes"] as const;
type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number];
/** 既定値（packages/core/src/settings.ts の DEFAULT_SETTINGS と同じ） */
const DEFAULT_KINDS: Record<FollowUpKind, boolean> = {
  approve: true,
  reply: true,
  review_pr: true,
  resume_error: true,
  check_changes: false,
};

function useConfigValues() {
  return useQuery({
    queryKey: ["settings", "config"],
    queryFn: () =>
      unwrap<{ values: Record<string, unknown> }>(api.api.config.$get()).then((r) => r.values),
  });
}

/**
 * 日付区切り（集計と儀式の区切り。週ボードの列は暦どおり 0:00。D-054）と、「Mac を使っていた」とみなす長さ
 * （presence.tail_min。D-105・D-110 (2)）
 */
export function DayBoundarySection() {
  const t = useT();
  const qc = useQueryClient();
  const q = useConfigValues();
  const [err, setErr] = useState(false);
  if (!q.data) return null;
  const v = typeof q.data.day_boundary === "string" ? q.data.day_boundary : "04:00";
  const tail = typeof q.data["presence.tail_min"] === "number" ? q.data["presence.tail_min"] : 5;
  const save = (key: string, value: unknown) => {
    setErr(false);
    putConfig(key, value)
      .catch(() => setErr(true))
      .finally(() => void qc.invalidateQueries({ queryKey: ["settings"] }));
  };
  return (
    <>
      <section
        className="flex items-center justify-between gap-4"
        data-testid="settings-day-boundary"
        data-setting="day-boundary"
      >
        <SectionHead k="settings.dayBoundary" hint="settings.dayBoundary.hint" err={err} />
        <HhmmInput
          value={v}
          label={t("settings.dayBoundary")}
          onCommit={(next) => save("day_boundary", next)}
        />
      </section>
      <section
        className="flex items-center justify-between gap-4"
        data-testid="settings-presence-tail"
        data-setting="presence-tail"
      >
        <SectionHead k="settings.presenceTail" hint="settings.presenceTail.hint" />
        <NumInput
          value={tail}
          min={2}
          max={15}
          label={t("settings.presenceTail")}
          unit={t("settings.unit.min")}
          onCommit={(n) => save("presence.tail_min", n)}
        />
      </section>
    </>
  );
}

/** AI の待ちと自分の番（フォローアップの種類・猶予・期限）。題名の保存は StoreTitlesSection（D-083） */
export function FollowUpSection() {
  const t = useT();
  const qc = useQueryClient();
  const q = useConfigValues();
  const [err, setErr] = useState(false);
  if (!q.data) return null;
  const vals = q.data;
  const kinds = {
    ...DEFAULT_KINDS,
    ...((vals["followup.kinds"] as Partial<Record<FollowUpKind, boolean>> | null) ?? {}),
  };
  const num = (k: string, d: number) => (typeof vals[k] === "number" ? (vals[k] as number) : d);
  const save = (key: string, value: unknown) => {
    setErr(false);
    putConfig(key, value)
      .catch(() => setErr(true))
      .finally(() => void qc.invalidateQueries({ queryKey: ["settings"] }));
  };
  const onOff = [
    { v: "on" as const, label: t("settings.on") },
    { v: "off" as const, label: t("settings.off") },
  ];
  return (
    <section className="flex flex-col gap-2" data-testid="settings-follow-ups">
      <div className="flex flex-col gap-2" data-setting="follow-up-kinds">
        <SectionHead k="settings.followUps" hint="settings.followUps.hint" err={err} />
        {FOLLOW_UP_KINDS.map((k) => (
          <Row key={k} title={t(`settings.followUps.kind.${k}`)}>
            <Segmented
              label={t(`settings.followUps.kind.${k}`)}
              value={kinds[k] ? "on" : "off"}
              options={onOff}
              onChange={(v) => save("followup.kinds", { ...kinds, [k]: v === "on" })}
            />
          </Row>
        ))}
      </div>
      <Row
        setting="grace"
        title={t("settings.followUps.grace")}
        hint={t("settings.followUps.grace.hint")}
      >
        <NumInput
          value={num("wait.grace_min", 15)}
          min={0}
          max={240}
          label={t("settings.followUps.grace")}
          unit={t("settings.unit.min")}
          onCommit={(n) => save("wait.grace_min", n)}
        />
      </Row>
      <Row
        setting="reply-expire"
        title={t("settings.followUps.replyExpire")}
        hint={t("settings.followUps.replyExpire.hint")}
      >
        <NumInput
          value={num("reply.expire_hours", 72)}
          min={1}
          max={720}
          label={t("settings.followUps.replyExpire")}
          unit={t("settings.unit.hours")}
          onCommit={(n) => save("reply.expire_hours", n)}
        />
      </Row>
      <Row
        setting="non-git-expire"
        title={t("settings.followUps.nonGitExpire")}
        hint={t("settings.followUps.nonGitExpire.hint")}
      >
        <NumInput
          value={num("your_turn.non_git_edit_expire_hours", 24)}
          min={1}
          max={720}
          label={t("settings.followUps.nonGitExpire")}
          unit={t("settings.unit.hours")}
          onCommit={(n) => save("your_turn.non_git_edit_expire_hours", n)}
        />
      </Row>
    </section>
  );
}

/**
 * 更新（設定 › 一般。ADR 0008 の追記 2・4）: 更新を確かめる（update.check）と、更新を自動でダウンロードする（update.download）。
 * どちらも既定オン。確認がオフのときはダウンロードも行わない
 */
export function UpdateSettingsRows() {
  const t = useT();
  const qc = useQueryClient();
  const q = useConfigValues();
  const [err, setErr] = useState<string | null>(null);
  if (!q.data) return null;
  const save = (key: string, value: unknown) => {
    setErr(null);
    putConfig(key, value)
      .catch(() => setErr(key))
      .finally(() => {
        void qc.invalidateQueries({ queryKey: ["settings"] });
        void qc.invalidateQueries({ queryKey: keys.update() });
      });
  };
  const check = q.data["update.check"] !== false;
  const download = q.data["update.download"] !== false;
  const onOff = [
    { v: "on" as const, label: t("settings.on") },
    { v: "off" as const, label: t("settings.off") },
  ];
  return (
    <>
      <section
        className="flex items-center justify-between gap-4"
        data-testid="settings-update-check"
        data-setting="update-check"
      >
        <SectionHead
          k="settings.update.check"
          hint="settings.update.check.hint"
          err={err === "update.check"}
        />
        <Segmented
          label={t("settings.update.check")}
          value={check ? "on" : "off"}
          options={onOff}
          onChange={(v) => save("update.check", v === "on")}
        />
      </section>
      <section
        className="flex items-center justify-between gap-4"
        data-testid="settings-update-download"
        data-setting="update-download"
      >
        <SectionHead
          k="settings.update.download"
          hint="settings.update.download.hint"
          err={err === "update.download"}
        />
        <Segmented
          label={t("settings.update.download")}
          value={download ? "on" : "off"}
          options={onOff}
          onChange={(v) => save("update.download", v === "on")}
        />
      </section>
    </>
  );
}

/**
 * 行に中身を出すか（turn.show_detail。既定オン。D-207 (1)）と通知に出す中身（notify.content。既定は件名。D-207 (4)）。
 * 「セッションの題名を保存」（保存）とは別の設定（こちらは表示。spec-glance §7）
 */
export function TurnDetailSection({
  part,
}: {
  part: "turn" | "away" | "notify" | "answer" | "tmux";
}) {
  const t = useT();
  const qc = useQueryClient();
  const q = useConfigValues();
  const [err, setErr] = useState(false);
  if (!q.data) return null;
  const save = (key: string, value: unknown) => {
    setErr(false);
    putConfig(key, value)
      .catch(() => setErr(true))
      .finally(() => void qc.invalidateQueries({ queryKey: ["settings"] }));
  };
  if (part === "answer" || part === "tmux") {
    // Turnlane から答える（turn.answer）と、送れない端末では tmux で包む（launch.tmux_wrap）。どちらも既定オン（D-238）
    const key = part === "answer" ? "turn.answer" : "launch.tmux_wrap";
    const k = part === "answer" ? "settings.turn.answer" : "settings.turn.tmuxWrap";
    const on = q.data[key] !== false;
    const body = (
      <>
        <SectionHead
          k={k}
          hint={part === "answer" ? "settings.turn.answer.hint" : "settings.turn.tmuxWrap.hint"}
          err={err}
        />
        <Segmented
          label={t(k)}
          value={on ? "on" : "off"}
          options={[
            { v: "on" as const, label: t("settings.on") },
            { v: "off" as const, label: t("settings.off") },
          ]}
          onChange={(v) => save(key, v === "on")}
        />
      </>
    );
    return part === "answer" ? (
      <section
        className="flex items-center justify-between gap-4"
        data-testid="settings-answer"
        data-setting="turn-answer"
      >
        {body}
      </section>
    ) : (
      <section
        className="flex items-center justify-between gap-4"
        data-testid="settings-tmux-wrap"
        data-setting="launch-tmux-wrap"
      >
        {body}
      </section>
    );
  }
  if (part === "away") {
    // 戻ったときのまとめ（turn.away_summary。既定オン。D-214 (2)）
    const on = q.data["turn.away_summary"] !== false;
    return (
      <section
        className="flex items-center justify-between gap-4"
        data-testid="settings-away-summary"
        data-setting="turn-away-summary"
      >
        <SectionHead
          k="settings.turn.awaySummary"
          hint="settings.turn.awaySummary.hint"
          err={err}
        />
        <Segmented
          label={t("settings.turn.awaySummary")}
          value={on ? "on" : "off"}
          options={[
            { v: "on" as const, label: t("settings.on") },
            { v: "off" as const, label: t("settings.off") },
          ]}
          onChange={(v) => save("turn.away_summary", v === "on")}
        />
      </section>
    );
  }
  if (part === "turn") {
    const on = q.data["turn.show_detail"] !== false;
    return (
      <section
        className="flex items-center justify-between gap-4"
        data-testid="settings-turn-detail"
        data-setting="turn-show-detail"
      >
        <SectionHead k="settings.turn.showDetail" hint="settings.turn.showDetail.hint" err={err} />
        <Segmented
          label={t("settings.turn.showDetail")}
          value={on ? "on" : "off"}
          options={[
            { v: "on" as const, label: t("settings.on") },
            { v: "off" as const, label: t("settings.off") },
          ]}
          onChange={(v) => save("turn.show_detail", v === "on")}
        />
      </section>
    );
  }
  const content = q.data["notify.content"] === "minimal" ? "minimal" : "subject";
  return (
    <section
      className="flex items-center justify-between gap-4"
      data-testid="settings-notify-content"
      data-setting="notify-content"
    >
      <SectionHead k="settings.notify.content" hint="settings.notify.content.hint" err={err} />
      <Segmented
        label={t("settings.notify.content")}
        value={content}
        options={[
          { v: "subject" as const, label: t("settings.notify.content.subject") },
          { v: "minimal" as const, label: t("settings.notify.content.minimal") },
        ]}
        onChange={(v) => save("notify.content", v)}
      />
    </section>
  );
}

/**
 * 待ちの中身を保存するか（turn.store_detail。既定オン。ADR 0018、D-218）と、保存しているものの件数・「待ちの中身を消す」。
 * 保存するのは伏せ字の後の 自分の指示の 1 行目・AI の問いと選択肢・許可のツールとコマンド・エラーの種類だけ。外には送らない
 */
export function StoredDetailSection() {
  const t = useT();
  const qc = useQueryClient();
  const q = useConfigValues();
  const counts = useQuery({
    queryKey: ["settings", "stored-detail"],
    queryFn: () => unwrap<{ instructions: number; waits: number }>(api.api["stored-detail"].$get()),
  });
  const [err, setErr] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (!q.data) return null;
  const on = q.data["turn.store_detail"] !== false;
  const save = (v: boolean) => {
    setErr(false);
    putConfig("turn.store_detail", v)
      .catch(() => setErr(true))
      .finally(() => void qc.invalidateQueries({ queryKey: ["settings"] }));
  };
  const n = counts.data;
  return (
    <section
      className="flex flex-col gap-2"
      data-setting="stored-detail"
      data-testid="settings-stored-detail"
    >
      <div className="flex items-center justify-between gap-4">
        <SectionHead
          k="settings.data.storeDetail"
          hint="settings.data.storeDetail.hint"
          err={err}
        />
        <Segmented
          label={t("settings.data.storeDetail")}
          value={on ? "on" : "off"}
          options={[
            { v: "on" as const, label: t("settings.on") },
            { v: "off" as const, label: t("settings.off") },
          ]}
          onChange={(v) => save(v === "on")}
        />
      </div>
      <div className="flex items-center justify-between gap-4 text-fg2 text-meta">
        <span data-testid="stored-detail-counts">
          {n
            ? t("settings.data.storeDetail.counts", {
                instructions: n.instructions,
                waits: n.waits,
              })
            : ""}
        </span>
        <button
          type="button"
          className="shrink-0 rounded-control px-2 py-1 text-error hover:bg-sunken disabled:text-fg3"
          data-testid="stored-detail-clear"
          disabled={!n || n.instructions + n.waits === 0}
          onClick={() => setConfirm(true)}
        >
          {t("settings.data.storeDetail.clear")}
        </button>
      </div>
      {confirm ? (
        <ConfirmDialog
          title={t("settings.data.storeDetail.clear")}
          body={t("settings.data.storeDetail.clearBody")}
          confirm={t("settings.data.storeDetail.clearConfirm")}
          cancel={t("action.cancel")}
          destructive
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void unwrap(api.api["stored-detail"].$delete())
              .catch(() => setErr(true))
              .finally(() => void qc.invalidateQueries());
          }}
        />
      ) : null}
    </section>
  );
}

/** セッションの題名を保存するか（privacy.storeTitles。設定の節は AI の取り込み。D-083） */
export function StoreTitlesSection() {
  const t = useT();
  const qc = useQueryClient();
  const q = useConfigValues();
  const [err, setErr] = useState(false);
  if (!q.data) return null;
  const storeTitles = (q.data.privacy as { storeTitles?: boolean } | null)?.storeTitles !== false;
  const onOff = [
    { v: "on" as const, label: t("settings.on") },
    { v: "off" as const, label: t("settings.off") },
  ];
  return (
    <section
      className="flex items-center justify-between gap-4"
      data-testid="settings-privacy"
      data-setting="store-titles"
    >
      <SectionHead k="settings.privacy" hint="settings.privacy.hint" err={err} />
      <Segmented
        label={t("settings.privacy")}
        value={storeTitles ? "on" : "off"}
        options={onOff}
        onChange={(v) => {
          setErr(false);
          putConfig("privacy", { storeTitles: v === "on" })
            .catch(() => setErr(true))
            .finally(() => void qc.invalidateQueries({ queryKey: ["settings"] }));
        }}
      />
    </section>
  );
}

/**
 * 壁打ちのフォルダ（ai.scratch_dirs。D-135）。印のフォルダの下で動いた AI のセッションは、プロジェクトに属さない
 * 「壁打ち」として出す（プロジェクトの一覧に出さない）。Codex のプロジェクト外の会話（~/Documents/Codex）は印が無くても
 * 壁打ち。入力は絶対パスか `~/`（デーモンが展開する）
 */
export function ScratchDirsSection() {
  const t = useT();
  const qc = useQueryClient();
  const q = useConfigValues();
  const [err, setErr] = useState(false);
  const [v, setV] = useState("");
  const imeEnter = useRef(false);
  if (!q.data) return null;
  const raw = q.data["ai.scratch_dirs"];
  const dirs = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  const save = (next: string[]) => {
    setErr(false);
    putConfig("ai.scratch_dirs", next)
      .catch(() => setErr(true))
      .finally(() => void qc.invalidateQueries({ queryKey: ["settings"] }));
  };
  return (
    <section
      className="flex flex-col gap-2"
      data-testid="settings-scratch-dirs"
      data-setting="scratch-dirs"
    >
      <SectionHead k="settings.scratchDirs" hint="settings.scratchDirs.hint" err={err} />
      {dirs.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {dirs.map((d) => (
            <span
              key={d}
              title={d}
              data-kind="scratch-dir"
              className="flex h-6 min-w-0 items-center gap-1 rounded-chip border border-line px-1.5 font-mono text-meta text-fg2"
            >
              <span className="min-w-0 truncate">{d}</span>
              <button
                type="button"
                aria-label={t("settings.scratchDirs.remove")}
                className="shrink-0 text-fg3 hover:text-fg"
                onClick={() => save(dirs.filter((x) => x !== d))}
              >
                <X size={11} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (imeEnter.current) {
            imeEnter.current = false;
            return;
          }
          const x = v.trim();
          if (!x || dirs.includes(x)) return;
          save([...dirs, x]);
          setV("");
        }}
      >
        <input
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !isImeKey(e)) return;
            imeEnter.current = true;
            setTimeout(() => {
              imeEnter.current = false;
            }, 0);
          }}
          placeholder={t("settings.scratchDirs.placeholder")}
          aria-label={t("settings.scratchDirs.add")}
          maxLength={1024}
          data-testid="settings-scratch-dir-input"
          className="h-7 min-w-0 flex-1 rounded-card border border-line bg-bg px-2 font-mono text-body outline-none placeholder:text-fg3 focus:border-accent"
        />
        <button
          type="submit"
          className="h-7 shrink-0 whitespace-nowrap rounded-card border border-line px-3 text-body hover:border-fg3"
        >
          {t("settings.scratchDirs.add")}
        </button>
      </form>
    </section>
  );
}

function useCalendars() {
  return useQuery({
    queryKey: ["settings", "calendars"],
    queryFn: async () => {
      const [c, s] = await Promise.all([
        unwrap<{ calendars: CalendarView[] }>(api.api.calendars.$get()),
        unwrap<CalendarStatusView>(api.api.calendar.status.$get()),
      ]);
      return { calendars: c.calendars, status: s };
    },
    retry: false,
  });
}

/** 「日本の祝日（3 アカウント）」の形（D-057 (2)） */
export function holidaySummary(
  cals: readonly { name: string }[],
  t: (k: MessageKey, p?: Record<string, string | number>) => string,
): string {
  return groupHolidaySources(cals)
    .map((g) =>
      g.count > 1 ? t("settings.holidays.accounts", { name: g.name, count: g.count }) : g.name,
    )
    .join(", ");
}

/** 祝日カレンダー（自動 / 選ぶ / なし。M3-6）と Holidays from */
export function HolidaysSection() {
  const { t, shortDate } = useI18n();
  const qc = useQueryClient();
  const q = useCalendars();
  const [err, setErr] = useState(false);
  const [choosing, setChoosing] = useState(false);
  if (!q.data) return null;
  const { calendars, status } = q.data;
  const h = status.holidays;
  const mode = choosing ? "manual" : h.mode;
  const save = (value: string[] | null) => {
    setErr(false);
    putConfig("workdays.holiday_calendars", value)
      .catch(() => setErr(true))
      .finally(() => {
        // 同期のあとで祝日の日付が変わる
        void qc.invalidateQueries({ queryKey: ["settings"] });
        setTimeout(() => void qc.invalidateQueries({ queryKey: ["settings"] }), 1500);
      });
  };
  const chosen = new Set(h.mode === "manual" ? h.calendars.map((c) => c.id) : []);
  const next = h.upcoming[0];
  return (
    <section
      className="flex flex-col gap-2"
      data-testid="settings-holidays"
      data-setting="holidays"
    >
      <div className="flex items-start justify-between gap-4">
        <SectionHead k="settings.holidays" hint="settings.holidays.hint" err={err} />
        <Segmented
          label={t("settings.holidays")}
          value={mode}
          options={[
            { v: "auto", label: t("settings.holidays.auto") },
            { v: "manual", label: t("settings.holidays.manual") },
            { v: "none", label: t("settings.holidays.none") },
          ]}
          onChange={(v) => {
            if (v === "manual") {
              setChoosing(true);
              return;
            }
            setChoosing(false);
            save(v === "auto" ? null : []);
          }}
        />
      </div>
      <p className="text-body" data-testid="holidays-from">
        <span className="text-fg2">{t("settings.holidays.from")} </span>
        {h.calendars.length > 0 ? holidaySummary(h.calendars, t) : t("settings.holidays.noneFound")}
        {next ? (
          <span className="text-fg3">
            {" · "}
            {t("settings.holidays.next", {
              date: shortDate(next.date),
              name: next.name ?? "",
            })}
          </span>
        ) : null}
      </p>
      {mode === "manual" ? (
        <div className="flex flex-col gap-1">
          {calendars.map((c) => (
            <label key={c.id} className="flex h-7 items-center gap-2 text-body">
              <input
                type="checkbox"
                checked={chosen.has(c.id)}
                onChange={() => {
                  const ids = chosen.has(c.id)
                    ? [...chosen].filter((x) => x !== c.id)
                    : [...chosen, c.id];
                  setChoosing(true);
                  save(ids);
                }}
                className="accent-[var(--dl-accent)]"
              />
              <span className="truncate">{c.name}</span>
              {c.account ? <span className="truncate text-fg3 text-meta">{c.account}</span> : null}
            </label>
          ))}
        </div>
      ) : null}
    </section>
  );
}

type Role = "source" | "ignored";

/**
 * カレンダーの役割（表示する / 無視する）と、予定の書き先（Calendar.app のデフォルトカレンダー）・以前の版が書いた
 * 時間ブロックの予定の削除（D-093。ux-mvp 4.13）。ヘルパ未接続なら案内だけ
 */
export function CalendarsSection() {
  const t = useT();
  const qc = useQueryClient();
  const q = useCalendars();
  const [err, setErr] = useState(false);
  // 表示しないカレンダー（Issue #5。calendar.hidden）。描かないだけで、忙しい時間・空き枠の数え方は変えない
  const config = useQuery({
    queryKey: ["settings", "config"],
    queryFn: () =>
      unwrap<{ values: Record<string, unknown> }>(api.api.config.$get()).then((r) => r.values),
    staleTime: 60_000,
  });
  const hiddenRaw = config.data?.["calendar.hidden"];
  const hidden = new Set(
    Array.isArray(hiddenRaw) ? hiddenRaw.filter((x): x is string => typeof x === "string") : [],
  );
  const setHidden = async (id: string, hide: boolean) => {
    setErr(false);
    const next = [...hidden].filter((x) => x !== id);
    if (hide) next.push(id);
    try {
      await unwrap(
        api.api.config[":key"].$put({ param: { key: "calendar.hidden" }, json: { value: next } }),
      );
    } catch {
      setErr(true);
    }
    void qc.invalidateQueries({ queryKey: ["settings"] });
    void qc.invalidateQueries({
      predicate: (x) => x.queryKey[0] === "board" || x.queryKey[0] === "day",
    });
  };
  if (q.isError) return null;
  if (!q.data) return null;
  const { calendars, status } = q.data;
  const setRole = async (id: string, role: Role) => {
    setErr(false);
    try {
      await unwrap(api.api.calendars[":id"].$patch({ param: { id }, json: { role } }));
    } catch {
      setErr(true);
    }
    void qc.invalidateQueries({ queryKey: ["settings"] });
    void qc.invalidateQueries({ predicate: (x) => x.queryKey[0] === "board" });
  };
  const roles: { v: Role; k: MessageKey }[] = [
    { v: "source", k: "settings.calendars.role.source" },
    { v: "ignored", k: "settings.calendars.role.ignored" },
  ];
  return (
    <section
      className="flex flex-col gap-2"
      data-testid="settings-calendars"
      data-setting="calendars"
    >
      <SectionHead k="settings.calendars" hint="settings.calendars.hint" err={err} />
      {!status.connected || status.authorization !== "fullAccess" ? (
        <CalendarConnectRow status={status} />
      ) : null}
      <EventsBox status={status} />
      {calendars.map((c) => (
        <div
          key={c.id}
          className="flex h-8 items-center justify-between gap-4"
          data-testid="settings-calendar-row"
          data-calendar-id={c.id}
        >
          <div className="-ml-1.5 flex min-w-0 items-center gap-1.5">
            <CalendarColorButton calendar={c} />
            <span className="truncate text-body">{c.name}</span>
            {c.account ? <span className="truncate text-fg3 text-meta">{c.account}</span> : null}
            {c.holiday ? (
              <span className="shrink-0 text-fg3 text-meta">{t("settings.calendars.holiday")}</span>
            ) : null}
            {c.isDefault ? (
              <span className="shrink-0 text-fg3 text-meta">{t("settings.calendars.default")}</span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {c.role === "source" ? (
              <label
                className="flex shrink-0 items-center gap-1.5 text-fg2 text-meta"
                title={t("settings.calendars.hide.hint")}
              >
                <input
                  type="checkbox"
                  checked={hidden.has(c.id)}
                  onChange={(e) => void setHidden(c.id, e.target.checked)}
                  data-testid="settings-calendar-hide"
                />
                {t("settings.calendars.hide")}
              </label>
            ) : null}
            <MenuSelect
              label={c.name}
              className="w-48 shrink-0"
              testId="settings-calendar-role"
              value={c.role === "source" ? "source" : "ignored"}
              onChange={(v) => void setRole(c.id, v)}
              options={roles.map((r) => ({ value: r.v, label: t(r.k) }))}
            />
          </div>
        </div>
      ))}
      {status.connected ? <TimeblockCleanup /> : null}
    </section>
  );
}

/**
 * 予定の書き先（D-093。ux-mvp 4.13）: Turnlane で作る予定は Calendar.app のデフォルトカレンダーへ。今のデフォルトと、
 * 無い・書き込めない・ヘルパが古いときの案内
 */
function EventsBox({ status }: { status: CalendarStatusView }) {
  const t = useT();
  const w = status.events;
  if (!w || !status.connected) return null;
  const label = (c: { name: string; account: string | null }) =>
    c.account ? `${c.name} · ${c.account}` : c.name;
  let line: string;
  let warn = false;
  if (w.helperOutdated) {
    line = t("settings.events.outdated");
    warn = true;
  } else if (w.defaultCalendar === "none") {
    line = t("settings.events.defaultNone");
    warn = true;
  } else if (w.defaultCalendar === "not_writable") {
    line = t("settings.events.defaultNotWritable", { name: w.calendar ? label(w.calendar) : "" });
    warn = true;
  } else if (w.calendar) line = t("settings.events.to", { name: label(w.calendar) });
  else line = t("settings.events.unknown");
  return (
    <div
      className="flex flex-col gap-1 rounded-card border border-line px-3 py-2 text-body"
      data-testid="events-box"
      data-setting="events"
    >
      <span className="text-fg2">{t("settings.events.title")}</span>
      <p className={warn ? "text-fg" : "text-fg2"} data-testid="events-where">
        {w.calendar && !warn ? (
          <span
            className="mr-1.5 inline-block size-2 rounded-full align-middle"
            style={{ background: calColor(w.calendar.color, w.calendar.colorKey) }}
            aria-hidden="true"
          />
        ) : null}
        {line}
      </p>
      <p className="text-fg3 text-meta">{t("settings.events.hint")}</p>
    </div>
  );
}

const fmtYmd = (ms: number, locale: "en" | "ja") =>
  new Date(ms).toLocaleDateString(locale === "ja" ? "ja-JP" : "en-US", {
    month: "short",
    day: "numeric",
  });

/**
 * 以前の版がタスクの時間ブロックとして書いた予定（dayline://timeblock/）の件数と期間、確認してからの削除（D-093）。
 * 自動では消さない。件数が確認の後に変わっていたら消さずに数え直す
 */
function TimeblockCleanup() {
  const t = useT();
  const { locale } = useI18n();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["settings", "timeblock-events"],
    queryFn: () => unwrap<TimeblockEventsSummary>(api.api.calendar["timeblock-events"].$get()),
    retry: false,
  });
  const err = q.error instanceof ApiError ? q.error.code : q.error ? "error" : null;
  const s = q.data;
  const run = async () => {
    if (!s) return;
    setConfirm(false);
    setBusy(true);
    setResult(null);
    try {
      const r = await unwrap<{ deleted: number; failed: number }>(
        api.api.calendar["timeblock-events"].cleanup.$post({ json: { expected: s.count } }),
      );
      setResult(
        r.failed > 0
          ? t("settings.timeblocks.partial", { deleted: r.deleted, failed: r.failed })
          : t("settings.timeblocks.done", { count: r.deleted }),
      );
    } catch (e) {
      setResult(
        e instanceof ApiError && e.code === "changed"
          ? t("settings.timeblocks.changed")
          : t("settings.timeblocks.failed"),
      );
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ["settings"] });
    }
  };
  const period =
    s && s.from !== null && s.to !== null
      ? `${fmtYmd(s.from, locale)} – ${fmtYmd(s.to, locale)}`
      : "";
  return (
    <div
      className="mt-2 flex flex-col gap-1 rounded-card border border-line px-3 py-2 text-body"
      data-testid="timeblock-cleanup"
      data-setting="timeblocks"
    >
      <span className="text-fg2">{t("settings.timeblocks.title")}</span>
      <p className="text-fg3 text-meta">{t("settings.timeblocks.hint")}</p>
      {err ? (
        <p className="text-fg3 text-meta">
          {err === "helper_outdated"
            ? t("settings.events.outdated")
            : t("settings.timeblocks.unavailable")}
        </p>
      ) : !s ? (
        <p className="text-fg3 text-meta">{t("common.loading")}</p>
      ) : s.count === 0 ? (
        <p className="text-fg2" data-testid="timeblock-summary">
          {t("settings.timeblocks.none")}
        </p>
      ) : (
        <>
          <p className="text-fg" data-testid="timeblock-summary">
            {t("settings.timeblocks.summary", { count: s.count, period })}
            {s.calendars.length > 0 ? (
              <span className="text-fg3">
                {" · "}
                {s.calendars.map((c) => `${c.name} ${c.count}`).join(", ")}
              </span>
            ) : null}
          </p>
          <button
            type="button"
            className="h-7 self-start rounded-card border border-line px-3 text-error hover:border-fg3 disabled:opacity-50"
            disabled={busy}
            onClick={() => setConfirm(true)}
            data-testid="timeblock-delete"
          >
            {t("settings.timeblocks.delete")}
          </button>
        </>
      )}
      {result ? (
        <p className="text-fg2 text-meta" data-testid="timeblock-result">
          {result}
        </p>
      ) : null}
      {confirm && s ? (
        <ConfirmDialog
          title={t("settings.timeblocks.confirmTitle", { count: s.count })}
          body={t("settings.timeblocks.confirmBody", { count: s.count, period })}
          confirm={t("settings.timeblocks.confirm", { count: s.count })}
          cancel={t("action.cancel")}
          onCancel={() => setConfirm(false)}
          onConfirm={() => void run()}
        />
      ) : null}
    </div>
  );
}

interface AiSummaryConfig {
  enabled?: boolean;
  tool?: "claude_code" | "codex";
  bin?: string | null;
  claude_config_dir?: string | null;
  timeout_sec?: number;
}

const TOOL_LABEL = { claude_code: "Claude Code", codex: "Codex" } as const;
const TOOL_CMD = { claude_code: "claude", codex: "codex" } as const;

/**
 * 日報の AI 要約（M4-6）。既定はオフ。オンにする前に、送る内容（日報の Markdown だけ）と送り先（選んだツールの提供元）を
 * 出して確かめてもらう（D-044 (4)）。オンの間も説明は出したままにする
 */
export function AiSummarySection() {
  const t = useT();
  const qc = useQueryClient();
  const q = useConfigValues();
  const [err, setErr] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const raw = (q.data?.["report.ai_summary"] as AiSummaryConfig | null | undefined) ?? {};
  const enabled = raw.enabled === true;
  const tool = raw.tool ?? "claude_code";
  const show = enabled || confirming;
  const tools = useQuery({
    queryKey: ["settings", "summaryTools"],
    queryFn: () => unwrap<SummaryToolsResponse>(api.api.summary.tools.$get({ query: {} })),
    enabled: show,
  });
  if (!q.data) return null;
  const storeTitles = (q.data.privacy as { storeTitles?: boolean } | null)?.storeTitles !== false;
  const save = (patch: AiSummaryConfig) => {
    setErr(false);
    putConfig("report.ai_summary", { ...raw, ...patch })
      .catch(() => setErr(true))
      .finally(() => void qc.invalidateQueries({ queryKey: ["settings"] }));
  };
  const detected = tools.data?.tools.find((x) => x.tool === tool);
  const dirs = tools.data?.claudeConfigDirs ?? [];
  const cmd = TOOL_CMD[tool];
  const redetect = async () => {
    const r = await unwrap<SummaryToolsResponse>(
      api.api.summary.tools.$get({ query: { refresh: "1" } }),
    );
    qc.setQueryData(["settings", "summaryTools"], r);
  };
  return (
    <section
      className="flex flex-col gap-2"
      data-testid="settings-ai-summary"
      data-setting="ai-summary"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-section">{t("settings.aiSummary")}</h2>
          <p className={`text-meta ${err ? "text-error" : "text-fg3"}`}>
            {err ? t("settings.saveFailed") : t("settings.aiSummary.hint", { tool: cmd })}
          </p>
        </div>
        <Segmented
          label={t("settings.aiSummary")}
          value={enabled || confirming ? "on" : "off"}
          options={[
            { v: "off" as const, label: t("settings.off") },
            { v: "on" as const, label: t("settings.on") },
          ]}
          onChange={(v) => {
            if (v === "off") {
              setConfirming(false);
              if (enabled) save({ enabled: false });
            } else if (!enabled) setConfirming(true);
          }}
        />
      </div>
      {show ? (
        <>
          <Row title={t("settings.aiSummary.tool")}>
            <Segmented
              label={t("settings.aiSummary.tool")}
              value={tool}
              options={(["claude_code", "codex"] as const).map((v) => ({
                v,
                label: TOOL_LABEL[v],
              }))}
              // 別のツールの bin は使えないので外す（次の実行で検出し直して保存する）
              onChange={(v) => v !== tool && save({ tool: v, bin: null })}
            />
          </Row>
          <div
            className="rounded-card border border-line bg-sunken px-3 py-2"
            data-kind="ai-summary-disclosure"
          >
            <h3 className="font-semibold text-body">{t("settings.aiSummary.sends")}</h3>
            <p className="text-meta text-fg2">{t("settings.aiSummary.sends.body")}</p>
            {storeTitles ? null : (
              <p className="text-meta text-fg3">{t("settings.aiSummary.sends.noTitles")}</p>
            )}
            <h3 className="mt-2 font-semibold text-body">{t("settings.aiSummary.to")}</h3>
            <p className="text-meta text-fg2">
              {t(
                tool === "codex"
                  ? "settings.aiSummary.to.codex"
                  : "settings.aiSummary.to.claude_code",
                { tool: cmd },
              )}
            </p>
          </div>
          <div className="flex items-center justify-between gap-4" data-kind="ai-summary-cli">
            <p className="min-w-0 break-all font-mono text-meta text-fg2">
              {tools.isFetching && !detected
                ? t("settings.aiSummary.checking", { tool: cmd })
                : detected?.bin
                  ? t("settings.aiSummary.found", { bin: detected.bin })
                  : detected
                    ? t("settings.aiSummary.notFound", { tool: cmd })
                    : ""}
              {detected?.bin && detected.missingFlags.length > 0 ? (
                <span className="block font-sans text-fg3">
                  {t("settings.aiSummary.missingFlags", {
                    tool: cmd,
                    flags: detected.missingFlags.join(" "),
                  })}
                </span>
              ) : null}
            </p>
            <button
              type="button"
              className="h-7 shrink-0 whitespace-nowrap rounded-card border border-line px-3 text-body hover:border-fg3"
              onClick={() => void redetect()}
            >
              {t("settings.aiSummary.detect")}
            </button>
          </div>
          {tool === "claude_code" && dirs.length > 1 ? (
            <Row title={t("settings.aiSummary.claudeDir")}>
              <Segmented
                label={t("settings.aiSummary.claudeDir")}
                value={raw.claude_config_dir ?? dirs[0] ?? ""}
                options={dirs.map((d) => ({ v: d, label: d.split("/").at(-1) ?? d }))}
                onChange={(v) => save({ claude_config_dir: v })}
              />
            </Row>
          ) : null}
          {enabled ? (
            <Row title={t("settings.aiSummary.timeout")}>
              <NumInput
                value={raw.timeout_sec ?? 90}
                min={10}
                max={600}
                label={t("settings.aiSummary.timeout")}
                unit={t("settings.unit.sec")}
                onCommit={(n) => save({ timeout_sec: n })}
              />
            </Row>
          ) : (
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="h-7 rounded-card px-3 text-body text-fg2 hover:text-fg"
                onClick={() => setConfirming(false)}
              >
                {t("summary.cancel")}
              </button>
              <button
                type="button"
                className="h-7 rounded-card bg-accent px-3 font-medium text-body text-onaccent hover:opacity-90"
                data-kind="ai-summary-confirm"
                onClick={() => {
                  setConfirming(false);
                  save({ enabled: true, tool });
                }}
              >
                {t("settings.aiSummary.confirm")}
              </button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

/** プロジェクトの色の候補（デザインシステムのプロジェクト色に近い無彩でない色） */
const PROJECT_COLORS = ["#4fb3a9", "#d9a441", "#9b7cf0", "#6b8cc7", "#d9707a", "#8a8f98"];

/**
 * プロジェクトとリポジトリの対応（M2-9。m2-api 19章）。リポジトリは AI 項目のリポジトリから選ぶ。
 * 対応を付けると、そのリポジトリで新しくできる自分の番のタスクと、AI カードから作る確認タスクにプロジェクトが付く
 */
export function ProjectsSection() {
  const t = useT();
  const qc = useQueryClient();
  const [err, setErr] = useState(false);
  const [name, setName] = useState("");
  const imeEnter = useRef(false);
  const list = useQuery({
    queryKey: ["settings", "projects"],
    queryFn: () =>
      unwrap<{ projects: ProjectView[] }>(api.api.projects.$get()).then((r) => r.projects),
  });
  const repos = useQuery({
    queryKey: ["settings", "projectRepos"],
    queryFn: () => unwrap<ProjectReposResponse>(api.api.projects.repos.$get()),
  });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["settings"] });
    void qc.invalidateQueries({ queryKey: ["projects"] });
  };
  const run = (job: Promise<unknown>) => {
    setErr(false);
    job.catch(() => setErr(true)).finally(done);
  };
  const patch = (id: string, json: Record<string, unknown>) =>
    run(unwrap(api.api.projects[":id"].$patch({ param: { id }, json })));
  const projects = list.data ?? [];
  const used = new Set(projects.flatMap((p) => p.repoPaths));
  const free = (repos.data?.repos ?? []).filter((r) => !used.has(r.path));
  return (
    <section
      className="flex flex-col gap-2"
      data-testid="settings-projects"
      data-setting="projects"
    >
      <SectionHead k="settings.projects" hint="settings.projects.hint" err={err} />
      {projects.map((p) => (
        <div
          key={p.id}
          className="flex flex-col gap-1.5 rounded-card border border-line px-3 py-2"
          data-kind="project-row"
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={t("settings.projects.color")}
              title={t("settings.projects.color")}
              className="size-3 shrink-0 rounded-full border border-line"
              style={{ background: p.color ?? "var(--dl-text-3)" }}
              onClick={() => {
                const i = PROJECT_COLORS.indexOf(p.color ?? "");
                patch(p.id, { color: PROJECT_COLORS[(i + 1) % PROJECT_COLORS.length] });
              }}
            />
            <ProjectName value={p.name} onCommit={(v) => patch(p.id, { name: v })} />
            <button
              type="button"
              className="ml-auto h-6 shrink-0 whitespace-nowrap rounded-card px-2 text-meta text-fg3 hover:text-fg"
              onClick={() => patch(p.id, { archived: true })}
            >
              {t("settings.projects.archive")}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pl-5">
            {p.repoPaths.map((r) => (
              <span
                key={r}
                title={r}
                className="flex h-6 items-center gap-1 rounded-chip border border-line px-1.5 font-mono text-meta text-fg2"
              >
                {r.split("/").at(-1) || r}
                <button
                  type="button"
                  aria-label={t("settings.projects.removeRepo")}
                  className="text-fg3 hover:text-fg"
                  onClick={() => patch(p.id, { repoPaths: p.repoPaths.filter((x) => x !== r) })}
                >
                  <X size={11} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </span>
            ))}
            {free.length > 0 ? (
              // リポジトリを足す（押すと候補のメニュー。選ぶと足す）
              <MenuSelect
                size="sm"
                className="max-w-64 text-fg2"
                label={t("settings.projects.addRepo")}
                testId="settings-project-add-repo"
                value={null}
                display={<span className="text-fg2">{t("settings.projects.addRepo")}</span>}
                onChange={(v) => patch(p.id, { repoPaths: [...p.repoPaths, v] })}
                options={free.map((r) => ({ value: r.path, label: r.path }))}
              />
            ) : p.repoPaths.length === 0 ? (
              <span className="text-meta text-fg3">{t("settings.projects.noRepos")}</span>
            ) : null}
          </div>
          <ProjectLaunchFields p={p} patch={(json) => patch(p.id, json)} />
        </div>
      ))}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (imeEnter.current) {
            imeEnter.current = false;
            return;
          }
          const v = name.trim();
          if (!v) return;
          run(unwrap(api.api.projects.$post({ json: { name: v } })));
          setName("");
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            // 変換確定の ⏎ で暗黙の送信（form の submit）が起きても追加しない（WebKit は compositionend の後に ⏎ が来る）
            if (e.key !== "Enter" || !isImeKey(e)) return;
            imeEnter.current = true;
            // 暗黙の送信は同じ打鍵の中で起きる。起きなかったときに次のボタンの押下を捨てないよう戻す
            setTimeout(() => {
              imeEnter.current = false;
            }, 0);
          }}
          placeholder={t("settings.projects.new")}
          aria-label={t("settings.projects.new")}
          maxLength={64}
          className="h-7 min-w-0 flex-1 rounded-card border border-line bg-bg px-2 text-body outline-none placeholder:text-fg3 focus:border-accent"
        />
        <button
          type="submit"
          className="h-7 shrink-0 whitespace-nowrap rounded-card border border-line px-3 text-body hover:border-fg3"
        >
          {t("settings.projects.add")}
        </button>
      </form>
    </section>
  );
}

function ProjectName({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const t = useT();
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      value={v}
      maxLength={64}
      aria-label={t("settings.projects.name")}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const x = v.trim();
        if (x && x !== value) onCommit(x);
        else setV(value);
      }}
      onKeyDown={blurOnEnter}
      className="h-6 min-w-0 flex-1 rounded-chip border border-transparent bg-transparent px-1 text-body outline-none hover:border-line focus:border-accent"
    />
  );
}
