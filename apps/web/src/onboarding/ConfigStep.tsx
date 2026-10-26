/**
 * O5 hooks と O5a AI tools（MCP）（任意。onboarding.md 4.5・4.5a、M6-24、D-145）。画像は無く、O2 の取り込み元の行と同じ
 * 並びの行で組む。2つの段は「設定ディレクトリごとに Turnlane の項目だけを足す」点が同じなので、1つの部品に kind で分ける。
 * - 開いたら dryRun で差分を取り、行に「adds 7 entries to settings.json」のように出す。「Show changes ▸」で書く内容
 * - 主ボタンで書く（POST /api/onboarding/hooks・/mcp）。行の左に ● installed / ◐ waiting for approval / ⚠ と理由。
 *   Codex は /hooks での承認を待たずに進める。失敗があれば Retry（Not now の代わり）と、そのまま Continue
 * - 対象が無ければ（O2 で取り込み元が 0 件）画面を出さずに飛ばす
 */
import type { HooksInstallResponse, McpInstallResponse, OnboardingView } from "@turnlane/core/web";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { MessageKey } from "../i18n/en.ts";
import { useI18n } from "../i18n/index.tsx";
import { installHooks, installMcp, useDetect } from "./data.ts";
import {
  ButtonPair,
  Disclosure,
  OnboardingLayout,
  Spinner,
  TargetRow,
  withEnter,
} from "./parts.tsx";
import { type Act, type FailAct, type StartMark, tildePath } from "./steps.ts";

export type ConfigKind = "hooks" | "mcp";

type HooksTarget = HooksInstallResponse["targets"][number];
type McpTarget = McpInstallResponse["targets"][number];
type Target = HooksTarget | McpTarget;
type Result = HooksInstallResponse | McpInstallResponse;

const TOOL_NAME: Record<string, MessageKey> = {
  claude_code: "sources.tool.claude_code",
  codex: "sources.tool.codex",
};

function baseName(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function isHooks(t: Target): t is HooksTarget {
  return "added" in t;
}

export function ConfigStep({
  kind,
  view,
  onBack,
  onDone,
  onSkip,
  onNone,
}: {
  kind: ConfigKind;
  view: OnboardingView;
  onBack: () => void;
  /** 書いた後の Continue（失敗があれば failed） */
  onDone: FailAct;
  onSkip: Act;
  /** 対象が無い（画面を出さずに飛ばす） */
  onNone: Act;
}) {
  const { t } = useI18n();
  const det = useDetect();
  const [plan, setPlan] = useState<Result | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"install" | "skip" | "continue" | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const skippedNone = useRef(false);
  const run = kind === "hooks" ? installHooks : installMcp;

  // 差分（書かない）。開いたときに一度だけ（kind ごと）
  const onNoneRef = useRef(onNone);
  onNoneRef.current = onNone;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 開いたときに一度だけ差分を取る（run は kind から決まる）
  useEffect(() => {
    let alive = true;
    run(true)
      .then((p) => {
        if (!alive) return;
        setPlan(p);
        if (p.targets.length === 0 && !skippedNone.current) {
          skippedNone.current = true;
          void onNoneRef.current();
        }
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [kind]);

  const install = async () => {
    if (busy || !plan) return;
    setBusy("install");
    try {
      setResult(await run(false));
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  };
  const act = async (k: "skip" | "continue", f: Act) => {
    if (busy) return;
    setBusy(k);
    try {
      await f();
    } finally {
      setBusy(null);
    }
  };

  const shown = result ?? plan;
  const failed = (result?.failed ?? 0) > 0;
  const done = result !== null;
  const home = det.data?.home ?? "";
  const info = new Map((det.data?.sources ?? []).map((s) => [s.id, s]));
  const hasCodex = (shown?.targets ?? []).some((x) => x.tool === "codex");
  const codexPending =
    done &&
    (result?.targets ?? []).some((x) => isHooks(x) && x.tool === "codex" && x.needsApproval);

  const K = kind === "hooks" ? "onb.hooks" : "onb.mcp";
  const primaryLabel = kind === "hooks" ? t("onb.hooks.install") : t("onb.mcp.register");
  const busyLabel = kind === "hooks" ? t("onb.hooks.installing") : t("onb.mcp.registering");
  const primaryIndex = busy === "install" ? 1 : done ? 2 : 0;
  const doPrimary = () => {
    if (done) void act("continue", () => onDone(failed));
    else void install();
  };
  const doSecondary = () => {
    if (done && failed) void install();
    else void act("skip", onSkip);
  };
  const note = error
    ? t("common.error")
    : done
      ? failed
        ? t(`${K}.failedNote` as MessageKey)
        : kind === "hooks"
          ? codexPending
            ? t("onb.hooks.doneNote")
            : t("onb.hooks.doneNoteClaude")
          : t("onb.mcp.doneNote")
      : t(`${K}.notNowNote` as MessageKey);

  /** 行の右の文言と印 */
  const describe = (
    x: Target,
  ): { right: ReactNode; mark: StartMark | undefined; state: string } => {
    const file = baseName(x.file);
    if (x.error)
      return {
        right: t(`${K}.error.${x.error}` as MessageKey),
        mark: done ? "problem" : undefined,
        state: "error",
      };
    if (isHooks(x)) {
      if (done) {
        if (x.needsApproval)
          return { right: t("onb.hooks.waitingApproval"), mark: "waiting", state: "pending" };
        if (x.disabled.length > 0)
          return {
            right: t("onb.hooks.disabled", { reason: x.disabled.join(", ") }),
            mark: "problem",
            state: "disabled",
          };
        return { right: t("onb.hooks.installed"), mark: "done", state: "installed" };
      }
      if (x.added.length > 0)
        return {
          right: t("onb.hooks.adds", { count: x.added.length, file }),
          mark: undefined,
          state: "plan",
        };
      if (x.updated.length > 0)
        return {
          right: t("onb.hooks.updates", { count: x.updated.length, file }),
          mark: undefined,
          state: "plan",
        };
      return { right: t("onb.hooks.already"), mark: "done", state: "installed" };
    }
    if (done) return { right: t("onb.mcp.registered"), mark: "done", state: "installed" };
    if (x.action === "added")
      return { right: t("onb.mcp.adds", { file }), mark: undefined, state: "plan" };
    if (x.action === "updated")
      return { right: t("onb.mcp.updates", { file }), mark: undefined, state: "plan" };
    return { right: t("onb.mcp.already"), mark: "done", state: "installed" };
  };

  /** 「変更を見る」: 書く内容（ファイル・イベント名かエントリ・退避の名前）。中身の他の部分は出さない */
  const changes = (x: Target): string[] => {
    const lines: string[] = [];
    const cli = tildePath(shown?.cli ?? "", home);
    if (isHooks(x)) {
      const events = [...x.added, ...x.updated];
      if (events.length > 0) lines.push(t("onb.hooks.events", { list: events.join(", ") }));
      lines.push(
        t("onb.hooks.command", {
          command: `'${cli}' hook --tool ${x.tool} --managed-by turnlane`,
        }),
      );
    } else if (x.tool === "codex") {
      lines.push("[mcp_servers.turnlane]", `command = "${cli}"`, 'args = ["mcp"]');
    } else {
      lines.push(
        `"mcpServers": { "turnlane": { "type": "stdio", "command": "${cli}", "args": ["mcp"] } }`,
      );
    }
    if (x.backup) lines.push(t("onb.hooks.backup", { path: tildePath(x.backup, home) }));
    return lines;
  };

  return (
    <OnboardingLayout
      view={view}
      back={onBack}
      note={plan ? note : null}
      foot={[
        { key: "⏎", label: done ? t("onb.continue") : primaryLabel },
        ...(done && !failed
          ? []
          : [{ key: "Esc", label: done ? t("onb.retry") : t("onb.notNow") }]),
        { key: "⌘[", label: t("onb.back") },
      ]}
      keys={{ enter: doPrimary, escape: () => (done && !failed ? undefined : doSecondary()) }}
      buttons={
        <ButtonPair
          secondary={
            done && !failed
              ? undefined
              : {
                  labels: [t("onb.notNow"), t("onb.retry")],
                  active: done && failed ? 1 : 0,
                  onClick: doSecondary,
                  disabled: busy !== null,
                  testId: "onb-not-now",
                }
          }
          primary={{
            labels: [
              withEnter(primaryLabel),
              <>
                <Spinner />
                {busyLabel}
              </>,
              withEnter(t("onb.continue")),
            ],
            active: primaryIndex,
            onClick: doPrimary,
            disabled: busy !== null || !plan || error,
            testId: `onb-${kind}-primary`,
          }}
        />
      }
    >
      <h1 className="font-semibold text-fg text-title">
        {t(`${K}.title` as MessageKey)}{" "}
        <span className="font-normal text-fg3">{t("onb.optional")}</span>
      </h1>
      <p className="mt-1.5 text-body text-fg2">{t(`${K}.subtitle` as MessageKey)}</p>

      <div className="mt-6 flex flex-col" data-part="targets">
        {shown
          ? shown.targets.map((x) => {
              const s = info.get(x.sourceId);
              const d = describe(x);
              const label =
                s?.label === "default"
                  ? x.tool === "claude_code"
                    ? t("onb.sources.default")
                    : null
                  : (s?.label ?? null);
              return (
                <TargetRow
                  key={x.sourceId}
                  name={t(TOOL_NAME[x.tool] ?? "sources.tool.claude_code")}
                  label={label}
                  path={tildePath(x.file, home)}
                  right={d.right}
                  mark={d.mark}
                  testId={x.sourceId}
                  state={d.state}
                />
              );
            })
          : [0, 1].map((i) => (
              <div key={i} className="flex h-11 items-center gap-3 px-4" data-skeleton="">
                <span className="size-4 rounded-chip" />
                <span className="h-3 w-40 rounded-full bg-sunken" />
                <span className="ml-auto h-3 w-56 rounded-full bg-sunken" />
              </div>
            ))}
      </div>
      {kind === "hooks" && hasCodex ? (
        <p className="mt-2 pl-4 text-body text-fg3">{t("onb.hooks.codexApprove")}</p>
      ) : null}

      <div className="mt-6 flex flex-col gap-2 text-body text-fg2">
        <p>{t(`${K}.onlyOwn` as MessageKey)}</p>
        {shown ? (
          <Disclosure
            open={open}
            onToggle={() => setOpen(!open)}
            showLabel={t("onb.hooks.showChanges")}
            hideLabel={t("onb.hooks.hideChanges")}
            testId="onb-show-changes"
          >
            <div
              className="mt-2 flex flex-col gap-3 rounded-pop border border-line bg-raised px-4 py-3"
              data-part="changes"
            >
              {shown.targets.map((x) => (
                <div key={x.sourceId} className="flex flex-col gap-0.5">
                  <div className="font-mono text-fg text-meta">{tildePath(x.file, home)}</div>
                  {changes(x).map((l) => (
                    <div key={l} className="break-all font-mono text-fg2 text-meta">
                      {l}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </Disclosure>
        ) : null}
      </div>
    </OnboardingLayout>
  );
}
