/**
 * 1件ずつの確認支援（D-109 の無料。plan §B.5。案 mock-ai-detail-v1 の「成果」の CI・変更・テストの行。D-116 で枠を作った）:
 * - CI: PR の checks（gh）。通過 / 失敗（名前）/ 実行中
 * - 変更: +追加 −削除 · ファイル数（worktree は未コミットを含む）、コミット数、未コミット
 * - テスト: プロジェクトの設定のコマンドをボタンで実行（無料は自動で走らせない。D-110 (10)）。失敗したら出力の最後を畳んで出す
 * - 作業場所: Turnlane が作った worktree。残っていれば削除（未コミット・未マージを捨てるので確認してから）
 */

import { useQuery } from "@tanstack/react-query";
import type { WorkCheckView } from "@turnlane/core/web";
import { Check, ChevronRight, Loader, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ConfirmDialog } from "../components/ui.tsx";
import { keys } from "../data/invalidate.ts";
import { cleanupWorktree, runLaunchTest } from "../data/mutations.ts";
import { useI18n } from "../i18n/index.tsx";
import { api, unwrap } from "../lib/api.ts";
import { toast } from "../lib/store.ts";

export function useCheck(ref: { workItemId?: string; launchId?: string } | null) {
  const k = ref?.launchId ?? ref?.workItemId ?? "";
  return useQuery({
    queryKey: keys.aiCheck(k),
    queryFn: () =>
      unwrap<WorkCheckView>(
        api.api.ai.check.$get({
          query: ref?.launchId ? { launchId: ref.launchId } : { workItemId: ref?.workItemId },
        }),
      ),
    enabled: k !== "",
    staleTime: 10_000,
    // テストの実行中は終わるまで見に行く（SSE の work_item でも無効化される）
    refetchInterval: (q) => (q.state.data?.test.state === "running" ? 3000 : false),
  });
}

/** 行があるか（無ければ成果の節に何も足さない） */
export function hasCheckRows(c: WorkCheckView | undefined): boolean {
  return (
    !!c && (c.ci !== null || c.diff !== null || c.test.command !== null || c.worktree !== null)
  );
}

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex min-h-6 items-center gap-2 text-body" data-testid={testId}>
      <span className="w-14 shrink-0 text-fg2 text-meta">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
    </div>
  );
}

const ok = <Check size={14} strokeWidth={2} className="shrink-0 text-turn" aria-hidden="true" />;
const ng = <X size={14} strokeWidth={2} className="shrink-0 text-error" aria-hidden="true" />;
const wait = (
  <Loader size={14} strokeWidth={1.5} className="dl-spin shrink-0 text-fg3" aria-hidden="true" />
);

const LINK =
  "shrink-0 cursor-pointer border-0 bg-transparent p-0 text-fg2 text-meta underline decoration-dotted underline-offset-[3px] hover:text-fg";

export function CheckRows({ c }: { c: WorkCheckView }) {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState(false);
  const [open, setOpen] = useState(false);
  const d = c.diff;
  const lid = c.launchId;
  return (
    <div className="flex flex-col gap-1" data-testid="ai-checks">
      {c.ci ? (
        <Row label={t("check.ci")} testId="check-ci">
          {c.ci.state === "pass"
            ? ok
            : c.ci.state === "fail"
              ? ng
              : c.ci.state === "pending"
                ? wait
                : null}
          <span className="truncate">
            {c.ci.state === "fail"
              ? t("check.ci.fail", { names: c.ci.failing.slice(0, 3).join(", ") })
              : t(`check.ci.${c.ci.state}`)}
          </span>
        </Row>
      ) : null}
      {d ? (
        <Row label={t("check.diff")} testId="check-diff">
          {d.files === 0 && (d.uncommitted ?? 0) === 0 ? (
            <span className="text-fg2">{t("check.diff.none")}</span>
          ) : (
            <span className="min-w-0 truncate">
              <span className="font-mono text-fg2">+{d.additions}</span>{" "}
              <span className="font-mono text-fg2">−{d.deletions}</span>
              {" · "}
              {t("check.diff.files", { count: d.files })}
              {d.commits > 0 ? <> · {t("check.diff.commits", { count: d.commits })}</> : null}
              {(d.uncommitted ?? 0) > 0 ? (
                <> · {t("check.diff.uncommitted", { count: d.uncommitted ?? 0 })}</>
              ) : null}
            </span>
          )}
        </Row>
      ) : c.pr && c.pr.additions !== null ? (
        <Row label={t("check.diff")} testId="check-diff">
          <span className="min-w-0 truncate">
            <span className="font-mono text-fg2">+{c.pr.additions}</span>{" "}
            <span className="font-mono text-fg2">−{c.pr.deletions ?? 0}</span>
            {" · "}
            {t("check.diff.files", { count: c.pr.files ?? 0 })}
          </span>
        </Row>
      ) : null}
      {c.test.command && lid ? (
        <Row label={t("check.test")} testId="check-test">
          {c.test.state === "passed"
            ? ok
            : c.test.state === "failed"
              ? ng
              : c.test.state === "running"
                ? wait
                : null}
          <span className="min-w-0 truncate" title={c.test.command}>
            {c.test.state === "passed"
              ? t("check.test.passed")
              : c.test.state === "failed"
                ? c.test.exitCode !== null
                  ? t("check.test.failed", { code: c.test.exitCode })
                  : t("check.test.failedNoCode")
                : c.test.state === "running"
                  ? t("check.test.running")
                  : t("check.test.idle")}
          </span>
          {c.test.state !== "running" ? (
            <button
              type="button"
              className={`ml-auto ${LINK}`}
              onClick={() => void runLaunchTest(lid)}
              data-testid="check-test-run"
            >
              {c.test.state === "idle" ? t("check.test.run") : t("check.test.again")}
            </button>
          ) : null}
        </Row>
      ) : null}
      {c.test.state === "failed" && c.test.tail.length > 0 ? (
        <div className="pl-16">
          <button
            type="button"
            className="flex items-center gap-1 text-fg2 text-meta hover:text-fg"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            <ChevronRight
              size={12}
              strokeWidth={1.5}
              className={open ? "rotate-90" : ""}
              aria-hidden="true"
            />
            {c.test.command}
          </button>
          {open ? (
            <pre className="mt-1 max-h-48 overflow-auto rounded-control bg-sunken p-2 font-mono text-[11px] text-fg2 leading-[15px]">
              {c.test.tail.join("\n")}
            </pre>
          ) : null}
        </div>
      ) : null}
      {c.worktree && lid ? (
        <Row label={t("check.worktree")} testId="check-worktree">
          <span className="min-w-0 truncate font-mono text-fg2 text-meta" title={c.worktree.path}>
            {c.worktree.path.split("/").slice(-2).join("/")}
          </span>
          {c.worktree.exists ? (
            <button
              type="button"
              className={`ml-auto ${LINK}`}
              onClick={() => setConfirm(true)}
              data-testid="check-worktree-remove"
            >
              {t("check.worktree.remove")}
            </button>
          ) : (
            <span className="ml-auto shrink-0 text-fg3 text-meta">
              {t("check.worktree.removed")}
            </span>
          )}
        </Row>
      ) : null}
      {confirm && lid ? (
        <ConfirmDialog
          title={t("check.worktree.confirmTitle")}
          body={t("check.worktree.confirmBody", { count: d?.uncommitted ?? 0 })}
          confirm={t("check.worktree.confirm")}
          cancel={t("action.cancel")}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            // 取り込み済みで clean なら確認なしと同じ。そうでなければ確認したので強制で消す
            void cleanupWorktree(lid, true).then((r) => {
              if (r && !r.removed) toast(t("check.worktree.notRemoved"));
            });
          }}
        />
      ) : null}
    </div>
  );
}
