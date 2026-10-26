/**
 * 集中モードの帯（D-097。ux-mvp 4.15、m2-api 25章、design README R18・WD4）。
 * - 集中中（FocusActiveBand）: 藍の面と左の太い線・濃い月のアイコンで、ふだんの見出しと見分ける。
 *   `集中モード · 「定例」の間 · 14:58 まで · 残り 30m`（残りは1分ごとに更新。題名は予定があるときだけ）と、右端に
 *   `止めた通知 1`（0 件なら `自分の番の通知を止めています`）と「終了」（確認なしの 1 クリック）。
 *   画面上部（どの画面でも、サイドバーを畳んでも）とメニューバーのポップオーバーの一番上に同じものを出す
 * - 会議の前の問い: `15:00 デザインレビュー · 集中モードにしますか？` と「集中する」「しない」。main（ブラウザ・アプリの
 *   ウインドウ）では、デスクトップアプリの通知のボタンで聞けないとき（channel = band）だけ出す。ポップオーバーは常に出す
 * 問いの文はデーモンが組み立てる。集中中の帯とボタンの文言は web の辞書（残り時間を画面の時計で数えるため）
 */
import { Moon } from "lucide-react";
import { answerFocus, endFocus } from "../data/mutations.ts";
import { useFocus, useQueue } from "../data/queries.ts";
import { useT } from "../i18n/index.tsx";
import { useNow } from "../lib/clock.ts";
import { type BandSeg, bandPlain, focusBandText } from "./focus-band.ts";
import { Button } from "./ui.tsx";

export function FocusBar({ where }: { where: "shell" | "tray" }) {
  const t = useT();
  const q = useFocus();
  const f = q.data;
  if (!f) return null;
  const prompt = f.prompt && (where === "tray" || f.channel === "band") ? f.prompt : null;
  // ポップオーバーの集中中の帯は一番上に出す（TrayPage が FocusActiveBand を置く）
  const active = where === "tray" ? null : f.active;
  if (!active && !prompt) return null;
  return (
    <div className="flex shrink-0 flex-col" data-testid="focus-bar">
      {prompt ? (
        <div
          className={`flex min-h-8 items-center gap-3 border-line border-b py-1 text-body ${where === "tray" ? "px-3" : "px-4"}`}
          data-testid="focus-prompt"
        >
          <Moon size={14} strokeWidth={1.5} className="shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate" title={prompt.label}>
            {prompt.label}
          </span>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void answerFocus(prompt.key, "focus")}
            data-testid="focus-yes"
          >
            {t("focus.yes")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void answerFocus(prompt.key, "skip")}
            data-testid="focus-no"
          >
            {t("focus.no")}
          </Button>
        </div>
      ) : null}
      {active ? <FocusActiveBand /> : null}
    </div>
  );
}

/**
 * 集中中の帯。compact（ポップオーバー。幅 360px）は 1 行に入らないので 2 段にする: 上の段に `集中モード · 「定例」の間`
 * （題名から縮める）、下の段に `14:58 まで · 残り 30m · 止めた通知 1`（0 件なら件数を省く）。「終了」は右
 */
export function FocusActiveBand({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const f = useFocus().data;
  const tz = useQueue().data?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // 残り時間を分の境目から遅れずに進める
  const now = useNow(10_000);
  const active = f?.active;
  if (!active) return null;
  const b = focusBandText(active, f.held ?? 0, now, tz, t);
  const plain = bandPlain(b);
  const head = b.groups.slice(0, b.groups.some((g) => g.some((x) => x.kind === "title")) ? 2 : 1);
  const tail = b.groups.slice(head.length);
  return (
    <div
      className={`flex min-h-10 shrink-0 items-center gap-3 border-focus border-b border-b-line border-l-4 bg-focussurface py-1.5 text-body text-fg ${compact ? "pr-2 pl-3" : "pr-3 pl-4"}`}
      data-testid={compact ? "tray-focus-active" : "focus-active"}
      role="status"
      aria-label={`${plain} · ${b.right}`}
    >
      <Moon
        size={16}
        strokeWidth={2}
        className="shrink-0 fill-focus text-focus"
        aria-hidden="true"
      />
      {compact ? (
        <span className="flex min-w-0 flex-1 flex-col" title={plain}>
          <Groups groups={head} className="font-medium" />
          <Groups
            groups={b.held ? [...tail, [{ text: b.right, kind: "text" }]] : tail}
            className="text-fg2 text-meta"
            testId="focus-held"
          />
        </span>
      ) : (
        <>
          <Groups groups={b.groups} className="flex-1 font-medium" title={plain} />
          <span
            className={`shrink-0 text-meta ${b.held ? "text-fg" : "hidden text-fg2 sm:inline"}`}
            data-testid="focus-held"
          >
            {b.right}
          </span>
        </>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void endFocus()}
        data-testid={compact ? "tray-focus-end" : "focus-end"}
      >
        {t("focus.end")}
      </Button>
    </div>
  );
}

/** 区切り（·）で並べた 1 行。題名だけが縮み、時刻と残りは mono */
function Groups({
  groups,
  className,
  title,
  testId,
}: {
  groups: BandSeg[][];
  className: string;
  title?: string;
  testId?: string;
}) {
  return (
    <span
      className={`flex min-w-0 items-baseline overflow-hidden ${className}`}
      title={title}
      data-testid={testId}
    >
      {groups.map((g, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: 並びは固定（名前・題名・終わり・残り）
          key={i}
          className={`flex min-w-0 items-baseline ${g.some((s) => s.kind === "title") ? "shrink" : "shrink-0"}`}
        >
          {i > 0 ? <span className="shrink-0 whitespace-pre text-fg3"> · </span> : null}
          {g.map((s, j) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: テンプレートの断片の順
              key={j}
              className={
                s.kind === "mono"
                  ? "shrink-0 whitespace-pre font-mono"
                  : s.kind === "title"
                    ? "min-w-0 truncate"
                    : "shrink-0 whitespace-pre"
              }
            >
              {s.text}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}
