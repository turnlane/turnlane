/**
 * タスクから開く（D-059。ux-mvp 4.11）: `o` の「他の開き方」メニュー、行のホバーのアイコン、開き方の文言。
 * 選べる開き方と実際に開くアプリの名前はデーモンが返す（GET /api/open/options）。開くのも デーモン（openTask）。
 */
import { defaultOpenAction, type FollowUpKind, type OpenOption } from "@turnlane/core/web";
import {
  Copy,
  ExternalLink,
  Folder,
  GitCompare,
  SquareArrowOutUpRight,
  SquareTerminal,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { createReplyTask, openTask } from "../data/mutations.ts";
import { type MessageKey, useI18n } from "../i18n/index.tsx";
import { eventIs, keyHint } from "../keys/keymap.ts";
import { api, unwrap } from "../lib/api.ts";
import { isImeKey } from "../lib/ime.ts";
import { MenuItem, Popover } from "./ui.tsx";

export type OpenRef = { followUpId: string } | { workItemId: string };

/** 開き方の文言（`Open in Zed`、`Resume in Ghostty`、動いているセッションは `Go to the running session`） */
export function useOpenLabel(): (o: OpenOption) => string {
  const { t } = useI18n();
  return (o) => {
    if (o.action === "session" && o.app === null) return t("open.action.sessionLive");
    return t(`open.action.${o.action}` as MessageKey, { app: o.app ?? "" });
  };
}

const ICONS = {
  pr: ExternalLink,
  pr_files: ExternalLink,
  diff: GitCompare,
  editor: Folder,
  finder: Folder,
  terminal: SquareTerminal,
  session: SquareTerminal,
  codex_app: SquareArrowOutUpRight,
  copy_resume: Copy,
  report_url: ExternalLink,
} as const;

/** 開き方のアイコン（AI の詳細パネルの「他の開き方」） */
export function openActionIcon(action: OpenOption["action"]) {
  return ICONS[action];
}

/** ホバーのツールバーの「開いて対応」のアイコン */
export const OPEN_ICON = SquareArrowOutUpRight;

/** 既定の開き先のアイコン（ターミナル・GitHub・エディタ。メニューバーの行の右） */
export function openIconFor(kind: FollowUpKind) {
  return ICONS[defaultOpenAction(kind)];
}

/** 行のホバーで右端に出す、既定の開き先のアイコン（クリックで ⏎ と同じ） */
export function OpenHoverButton({ kind, onOpen }: { kind: FollowUpKind; onOpen: () => void }) {
  const { t } = useI18n();
  const action = defaultOpenAction(kind);
  const Icon = ICONS[action];
  const label = t("keys.open");
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid="open-hover"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className="hidden shrink-0 text-fg3 hover:text-fg group-hover:inline-flex"
    >
      <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

function OpenWithMenu({
  anchor,
  target,
  onClose,
  onPicked,
}: {
  anchor: HTMLElement | null;
  target: OpenRef;
  onClose: () => void;
  onPicked?: (() => void) | undefined;
}) {
  const label = useOpenLabel();
  const { t } = useI18n();
  const [opts, setOpts] = useState<OpenOption[] | null>(null);
  useEffect(() => {
    let alive = true;
    void unwrap<{ options: OpenOption[] }>(api.api.open.options.$get({ query: target })).then(
      (r) => alive && setOpts(r.options),
      () => alive && setOpts([]),
    );
    return () => {
      alive = false;
    };
  }, [target]);
  const pick = useCallback(
    (o: OpenOption) => {
      void openTask({ ...target, action: o.action });
      onClose();
      onPicked?.();
    },
    [target, onClose, onPicked],
  );
  // AI カードでは末尾に「返答タスクを作る（y）」（D-066 (2)）
  const replyTarget = "workItemId" in target ? target.workItemId : null;
  const reply = useCallback(() => {
    if (replyTarget) void createReplyTask(replyTarget);
    onClose();
  }, [replyTarget, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isImeKey(e)) return;
      if (replyTarget && eventIs("replyTask", e)) {
        e.preventDefault();
        e.stopPropagation();
        reply();
        return;
      }
      const i = Number(e.key) - 1;
      const o = opts?.[i];
      if (Number.isInteger(i) && o) {
        e.preventDefault();
        e.stopPropagation();
        pick(o);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [opts, pick, replyTarget, reply]);
  return (
    <Popover anchor={anchor} onClose={onClose} className="w-64">
      {opts === null ? null : opts.length === 0 ? (
        <div className="px-2 py-1 text-body text-fg3">{t("common.none")}</div>
      ) : (
        opts.map((o, i) => (
          <MenuItem key={o.action} hint={String(i + 1)} onSelect={() => pick(o)}>
            {label(o)}
          </MenuItem>
        ))
      )}
      {replyTarget && opts !== null ? (
        <MenuItem hint={keyHint("replyTask")} onSelect={reply}>
          {t("ai.replyTask")}
        </MenuItem>
      ) : null}
    </Popover>
  );
}

/** `o` のメニュー。show(anchor, target) で開く。menu を画面のどこかに置く */
export function useOpenWith(onPicked?: () => void): {
  menu: ReactNode;
  show: (anchor: HTMLElement | null, target: OpenRef) => void;
} {
  const [st, setSt] = useState<{ anchor: HTMLElement | null; target: OpenRef } | null>(null);
  const close = useCallback(() => setSt(null), []);
  return {
    menu: st ? (
      <OpenWithMenu anchor={st.anchor} target={st.target} onClose={close} onPicked={onPicked} />
    ) : null,
    show: (anchor, target) => setSt({ anchor, target }),
  };
}
