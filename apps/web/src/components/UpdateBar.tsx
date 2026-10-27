/**
 * 更新の知らせ（onboarding.md 2.5 の更新確認の行、M6-17。自動更新は ADR 0008 の追記 4）。画面上部（どの画面でも）に 1 行。
 * 文言は自動更新の段階（core の updatePhase）で分ける:
 * - 手動（update.download がオフ・自動の対象外）: `Turnlane 0.7.2 is available`。Homebrew 版は `brew upgrade --cask turnlane`
 *   をコピーするボタン、zip の版は最新リリースのページを開くボタン。開発時の配置（dev）では出さない
 * - 取得・検証の途中: `Turnlane 0.7.2 is available · Downloading…`（ボタンなし）
 * - 入れる用意ができた: `Turnlane 0.7.2 is ready` と `Restart to update`（押すとデーモンが入れ替え、アプリが開き直す）
 * - 検証に落ちた・入れられなかった: `… · Could not verify the download` と手動の案内
 * × で閉じると、その版は次のデーモンの起動まで出さない（デーモンのプロセスの中だけ覚える）。鮮度は SSE update
 */
import type { UpdateStatus } from "@turnlane/core/web";
import { updatePhase } from "@turnlane/core/web";
import { CircleArrowUp, X } from "lucide-react";
import { useState } from "react";
import { dismissUpdate, installUpdate } from "../data/mutations.ts";
import { useUpdateStatus } from "../data/queries.ts";
import { useT } from "../i18n/index.tsx";
import { toast } from "../lib/store.ts";
import { Button } from "./ui.tsx";

/** 文言に添える段階（手動の案内のときは無し） */
export type UpdateNote = "downloading" | "installing" | "failed_verify" | "failed_install";

export type UpdateNotice =
  | { version: string; action: "copy"; command: string; note?: UpdateNote }
  | { version: string; action: "open"; url: string; note?: UpdateNote }
  | { version: string; action: "install" }
  | { version: string; action: "none"; note: UpdateNote };

/** 手動の案内（Homebrew はコマンド、zip はリリースのページ）。dev・案内先が無ければ null */
function manual(
  s: UpdateStatus,
  version: string,
):
  | { version: string; action: "copy"; command: string }
  | { version: string; action: "open"; url: string }
  | null {
  if (s.channel === "homebrew" && s.upgradeCommand)
    return { version, action: "copy", command: s.upgradeCommand };
  if (s.channel === "download" && s.releasesUrl)
    return { version, action: "open", url: s.releasesUrl };
  return null;
}

/** 出す知らせ（純粋関数）。新しい版が無い・dev・閉じた版なら null */
export function updateNotice(s: UpdateStatus | null | undefined): UpdateNotice | null {
  if (!s) return null;
  const phase = updatePhase(s);
  if (!phase) return null;
  const version = phase.version;
  if (s.dismissed === version) return null;
  switch (phase.kind) {
    case "manual":
      return manual(s, version);
    case "downloading":
      return { version, action: "none", note: "downloading" };
    case "ready":
      return { version, action: "install" };
    case "installing":
      return { version, action: "none", note: "installing" };
    case "failed": {
      const note: UpdateNote = phase.reason === "install" ? "failed_install" : "failed_verify";
      const m = manual(s, version);
      return m ? { ...m, note } : { version, action: "none", note };
    }
  }
}

const NOTE_TEXT = {
  downloading: "update.downloading",
  installing: "update.restarting",
  failed_verify: "update.failedVerify",
  failed_install: "update.failedInstall",
} as const;

/** 表示（状態を読まない。テストから描く） */
export function UpdateBarView({
  notice,
  onCopy,
  onDismiss,
  onInstall,
  installing = false,
}: {
  notice: UpdateNotice | null;
  onCopy: (command: string) => void;
  onDismiss: (version: string) => void;
  onInstall?: () => void;
  /** Restart to update を押した後（返事を待つ間） */
  installing?: boolean;
}) {
  const t = useT();
  if (!notice) return null;
  const note = "note" in notice ? notice.note : undefined;
  const text = note
    ? t(NOTE_TEXT[note], { version: notice.version })
    : notice.action === "install"
      ? t("update.ready", { version: notice.version })
      : t("update.available", { version: notice.version });
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-3 border-line border-b px-4 text-body"
      data-testid="update-bar"
      data-action={notice.action}
      {...(note ? { "data-note": note } : {})}
      role="status"
    >
      <CircleArrowUp size={14} strokeWidth={1.5} className="shrink-0 text-fg2" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate" data-testid="update-text">
        {text}
      </span>
      {notice.action === "copy" ? (
        <Button size="sm" onClick={() => onCopy(notice.command)} data-testid="update-copy">
          {t("update.copy", { command: notice.command })}
        </Button>
      ) : notice.action === "open" ? (
        <a
          href={notice.url}
          target="_blank"
          rel="noreferrer"
          data-testid="update-open"
          className="inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-card border border-line bg-raised px-2 font-medium text-fg text-meta hover:border-fg3"
        >
          {t("update.open")}
        </a>
      ) : notice.action === "install" ? (
        <Button
          size="sm"
          onClick={() => onInstall?.()}
          disabled={installing}
          data-testid="update-install"
        >
          {t("update.restart")}
        </Button>
      ) : null}
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
  const [installing, setInstalling] = useState(false);
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
  const install = () => {
    setInstalling(true);
    // 入れ終わるとデーモンが新しい版で起き直し、アプリは自分で開き直す（SSE update の installed）
    installUpdate().then(
      (ok) => {
        if (!ok) toast(t("update.installFailed"));
        setInstalling(false);
      },
      () => setInstalling(false),
    );
  };
  return (
    <UpdateBarView
      notice={updateNotice(q.data)}
      onCopy={copy}
      onDismiss={(v) => void dismissUpdate(v)}
      onInstall={install}
      installing={installing}
    />
  );
}
