/**
 * 更新の知らせ（onboarding.md 2.5 の更新確認の行、M6-17）。画面上部（どの画面でも）に 1 行:
 * `Turnlane 0.7.1 is available`。Homebrew 版は `brew upgrade --cask turnlane` をコピーするボタン、zip の版は最新リリースの
 * ページを開くボタン。開発時の配置（dev）では出さない。× で閉じると、その版は次のデーモンの起動まで出さない
 * （デーモンのプロセスの中だけ覚える）。鮮度は SSE update。ダウンロード・入れ替えはしない（ADR 0008）
 */
import type { UpdateStatus } from "@turnlane/core/web";
import { CircleArrowUp, X } from "lucide-react";
import { dismissUpdate } from "../data/mutations.ts";
import { useUpdateStatus } from "../data/queries.ts";
import { useT } from "../i18n/index.tsx";
import { toast } from "../lib/store.ts";
import { Button } from "./ui.tsx";

export type UpdateNotice =
  | { version: string; action: "copy"; command: string }
  | { version: string; action: "open"; url: string };

/** 出す知らせ（純粋関数）。新しい版が無い・dev・閉じた版なら null */
export function updateNotice(s: UpdateStatus | null | undefined): UpdateNotice | null {
  if (!s?.available || !s.latest) return null;
  const version = s.latest.version;
  if (s.dismissed === version) return null;
  if (s.channel === "homebrew" && s.upgradeCommand)
    return { version, action: "copy", command: s.upgradeCommand };
  if (s.channel === "download" && s.releasesUrl)
    return { version, action: "open", url: s.releasesUrl };
  return null;
}

/** 表示（状態を読まない。テストから描く） */
export function UpdateBarView({
  notice,
  onCopy,
  onDismiss,
}: {
  notice: UpdateNotice | null;
  onCopy: (command: string) => void;
  onDismiss: (version: string) => void;
}) {
  const t = useT();
  if (!notice) return null;
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-3 border-line border-b px-4 text-body"
      data-testid="update-bar"
      data-action={notice.action}
      role="status"
    >
      <CircleArrowUp size={14} strokeWidth={1.5} className="shrink-0 text-fg2" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate" data-testid="update-text">
        {t("update.available", { version: notice.version })}
      </span>
      {notice.action === "copy" ? (
        <Button size="sm" onClick={() => onCopy(notice.command)} data-testid="update-copy">
          {t("update.copy", { command: notice.command })}
        </Button>
      ) : (
        <a
          href={notice.url}
          target="_blank"
          rel="noreferrer"
          data-testid="update-open"
          className="inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-card border border-line bg-raised px-2 font-medium text-fg text-meta hover:border-fg3"
        >
          {t("update.open")}
        </a>
      )}
      <button
        type="button"
        onClick={() => onDismiss(notice.version)}
        aria-label={t("update.dismiss")}
        title={t("update.dismiss")}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-fg3 hover:bg-sunken hover:text-fg"
        data-testid="update-dismiss"
      >
        <X size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  );
}

export function UpdateBar() {
  const t = useT();
  const q = useUpdateStatus();
  const copy = (command: string) => {
    // クリックの中で書き込みを始める（WebKit は操作の外の clipboard.writeText を拒む）
    const p = navigator.clipboard?.writeText(command);
    if (!p) {
      toast(t("update.copyFailed", { command }));
      return;
    }
    p.then(
      () => toast(t("update.copied", { command })),
      () => toast(t("update.copyFailed", { command })),
    );
  };
  return (
    <UpdateBarView
      notice={updateNotice(q.data)}
      onCopy={copy}
      onDismiss={(v) => void dismissUpdate(v)}
    />
  );
}
