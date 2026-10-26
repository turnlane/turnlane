/**
 * 完了のシート（AI に頼むで起動した作業の片付け。launch/finish.ts）: 2 つのチェック（AI を終了してタブを閉じる・worktree を
 * 消す）と、「完了」（選んだ片付けをしてから完了）・「片付けずに完了」。Esc で取り消し（完了にしない）、⏎ で「完了」。
 * 取り込まれていない worktree は、その行の下に赤字で「ブランチの変更が消えます（<ブランチ>）」。
 * 片付けだけのシート（mode: cleanup。AI の画面）はボタンが「やめる」（Esc と同じ）と「片付ける」（⏎）
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Button, Kbd } from "../components/ui.tsx";
import { useT } from "../i18n/index.tsx";
import { isImeKey } from "../lib/ime.ts";
import {
  type FinishChoice,
  type FinishSheetState,
  getFinishSheet,
  planWorktrees,
  riskyBranches,
  subscribeFinishSheet,
} from "./finish.ts";

export function FinishSheet() {
  const s = useSyncExternalStore(subscribeFinishSheet, getFinishSheet, getFinishSheet);
  if (!s) return null;
  return createPortal(<FinishSheetView state={s} onDecide={s.resolve} />, document.body);
}

/** シートの中身（状態は外から。テストとスクリーンショットでも使う） */
export function FinishSheetView({
  state,
  onDecide,
}: {
  state: FinishSheetState;
  onDecide: (
    d: { kind: "cancel" } | { kind: "skip" } | { kind: "finish"; choice: FinishChoice },
  ) => void;
}) {
  const t = useT();
  const [choice, setChoice] = useState<FinishChoice>(state.defaults);
  useEffect(() => setChoice(state.defaults), [state]);
  const cleanup = state.mode === "cleanup";
  const hasWorktree = planWorktrees(state.plan).length > 0;
  const risky = riskyBranches(state.plan);
  const finish = () =>
    onDecide({
      kind: "finish",
      choice: { ...choice, removeWorktree: hasWorktree && choice.removeWorktree },
    });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isImeKey(e)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDecide({ kind: "cancel" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        finish();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  const row = (
    key: keyof FinishChoice,
    label: string,
    testId: string,
    note: string | null = null,
  ) => (
    <div className="flex flex-col gap-0.5">
      <label className="flex cursor-pointer items-center gap-2 text-body">
        <input
          type="checkbox"
          checked={choice[key]}
          onChange={(e) => setChoice((c) => ({ ...c, [key]: e.target.checked }))}
          data-testid={testId}
        />
        <span>{label}</span>
      </label>
      {note ? (
        <p className="pl-6 text-error text-meta" data-testid="finish-risky">
          {note}
        </p>
      ) : null}
    </div>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div
        role="alertdialog"
        aria-label={t(cleanup ? "finish.cleanup.title" : "finish.title")}
        className="w-[440px] max-w-[calc(100vw-32px)] rounded-pop border border-line bg-raised p-4 shadow-pop"
        data-testid="finish-sheet"
        data-mode={cleanup ? "cleanup" : "complete"}
      >
        <h2 className="font-semibold text-body">
          {t(cleanup ? "finish.cleanup.title" : "finish.title")}
        </h2>
        <p className="mt-1 text-fg2 text-meta">
          {t(cleanup ? "finish.cleanup.body" : "finish.body")}
        </p>
        <div className="mt-3 flex flex-col gap-2">
          {row("closeTerminal", t("finish.closeTerminal"), "finish-close-terminal")}
          {hasWorktree
            ? row(
                "removeWorktree",
                t("finish.removeWorktree"),
                "finish-remove-worktree",
                risky.length > 0 ? t("finish.risky", { branch: risky.join("、") }) : null,
              )
            : null}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          {cleanup ? (
            <Button
              variant="ghost"
              onClick={() => onDecide({ kind: "cancel" })}
              data-testid="finish-cancel"
            >
              {t("finish.cleanup.cancel")}
            </Button>
          ) : (
            <Button
              variant="ghost"
              onClick={() => onDecide({ kind: "skip" })}
              data-testid="finish-skip"
            >
              {t("finish.skip")}
            </Button>
          )}
          <Button variant="primary" onClick={finish} data-testid="finish-confirm">
            {t(cleanup ? "finish.cleanup.confirm" : "finish.confirm")}
            <Kbd className="border-onaccent/30 text-onaccent">⏎</Kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}
