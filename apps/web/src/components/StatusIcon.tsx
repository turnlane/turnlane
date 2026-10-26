/**
 * 状態アイコン5種（塗りはこれだけ。他は lucide のアウトライン。ux-mvp 4.1、design-system）。
 * 色だけに頼らず形でも区別する: error = 三角に !、needs_input = 丸に一時停止（明滅）、running = 開いた弧（回転）、
 * your_turn = 丸に右矢印、done = チェック。塗りの丸に地の色の記号（確定デザインの部品シート）。
 * 推定（hooks なし）でも形と色は変えない（D-114。点線の輪と `~` をやめた）。推定はスクリーンリーダーのラベルとホバーで伝える。
 * 回転と明滅は prefers-reduced-motion で止める（styles.css）。
 */
import type { WorkItemStatus } from "@turnlane/core/web";
import { useT } from "../i18n/index.tsx";

const COLOR: Record<WorkItemStatus, string> = {
  error: "text-error",
  needs_input: "text-needs",
  running: "text-running",
  your_turn: "text-turn",
  done: "text-done",
};

export function StatusIcon({
  status,
  estimated = false,
  size = 14,
  title = true,
}: {
  status: WorkItemStatus;
  estimated?: boolean;
  size?: number;
  /** false ならスクリーンリーダー用のラベルを付けない（隣に文字ラベルがあるとき） */
  title?: boolean;
}) {
  const t = useT();
  const label = `${t(`status.${status}`)}${estimated ? ` (${t("status.estimated")})` : ""}`;
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center ${COLOR[status]}`}
      style={{ width: size, height: size }}
      {...(title ? { role: "img", "aria-label": label, title: label } : { "aria-hidden": true })}
      data-status={status}
      data-estimated={estimated ? "1" : undefined}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        className={
          status === "running" ? "dl-spin" : status === "needs_input" ? "dl-pulse" : undefined
        }
        aria-hidden="true"
      >
        <Shape status={status} />
      </svg>
    </span>
  );
}

function Shape({ status }: { status: WorkItemStatus }) {
  const r = 7;
  switch (status) {
    case "error":
      return (
        <>
          <path d="M8 1.6 15 14.2H1z" fill="currentColor" />
          <path d="M8 6v4" stroke="var(--dl-bg)" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="12.1" r="0.9" fill="var(--dl-bg)" />
        </>
      );
    case "needs_input":
      return (
        <>
          <circle cx="8" cy="8" r={r} fill="currentColor" />
          <rect x="5.6" y="5" width="1.6" height="6" rx="0.5" fill="var(--dl-bg)" />
          <rect x="8.8" y="5" width="1.6" height="6" rx="0.5" fill="var(--dl-bg)" />
        </>
      );
    case "running":
      return (
        <path
          d="M8 2a6 6 0 1 1-6 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      );
    case "your_turn":
      return (
        <>
          <circle cx="8" cy="8" r={r} fill="currentColor" />
          <path
            d="M5 8h5.2M8 5.4 10.6 8 8 10.6"
            fill="none"
            stroke="var(--dl-bg)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case "done":
      return (
        <path
          d="M3.2 8.4 6.5 11.6 12.8 4.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
  }
}
