/**
 * タスクから AI に頼む（D-107。確定デザインの作成のポップオーバー「AI に頼む」と board-CreateTask、レビュー your-turn-v1 の
 * 「実装で直すこと」3・4）。
 * - 行: リポジトリ（プロジェクトの既定）/ エージェント（入っているものだけ。1つなら選ばせない。既定は前回選んだもの）/
 *   アカウント（Claude Code で、設定ディレクトリが2つ以上のときだけ。既定はプロジェクトの設定 → 前回のもの。D-122）/
 *   依頼の型 / 指示（任意。左にラベル。行数に合わせて伸び、ポップオーバーが画面に収まる高さで止まる。つまみで手でも広げられる）/ 作業場所（新しい作業ディレクトリで worktree。既定はプロジェクトの設定）
 * - 本体は「今すぐ」だけ。拡張は「いつ」などの行を launchFields の拡張点で足せる（ADR 0015。ext/registry.ts）
 * - いつものターミナルの新しいタブで開く。端末が無ければコマンドをコピーする
 */

import { useQuery } from "@tanstack/react-query";
import {
  type AiLaunchInput,
  type AiLaunchOptions,
  type AiLaunchTool,
  formatTaskTitle,
  type TaskView,
} from "@turnlane/core/web";
import { useEffect, useRef, useState } from "react";
import { AutoGrowTextarea } from "../components/AutoGrowTextarea.tsx";
import { Button, Popover } from "../components/ui.tsx";
import { launchAi } from "../data/mutations.ts";
import { ext } from "../ext/registry.ts";
import { useI18n } from "../i18n/index.tsx";
import { api, unwrap } from "../lib/api.ts";
import { isImeKey } from "../lib/ime.ts";
import { LaunchRow } from "./LaunchRow.tsx";
import { LaunchSegmented, Picker, Switch } from "./Picker.tsx";

export interface AiChoice {
  repo: string | null;
  tool: AiLaunchTool | null;
  templateId: string;
  instruction: string;
  worktree: boolean;
  /** Claude のアカウント（設定ディレクトリ。選択肢が無ければ null。D-122） */
  claudeAccount: string | null;
  /** 拡張の行の値（ADR 0015。行の key → 値） */
  ext: Record<string, unknown>;
}

/** 依頼の本文に足すアカウント（Claude Code で、選択肢が2つ以上のときだけ送る。1つならデーモンが既定を使う） */
export function accountInput(
  opts: AiLaunchOptions | undefined,
  c: AiChoice,
): { claudeAccount?: string } {
  return c.tool === "claude_code" &&
    c.claudeAccount &&
    (opts?.claudeAccounts.length ?? 0) >= 2 &&
    opts?.claudeAccounts.some((a) => a.path === c.claudeAccount)
    ? { claudeAccount: c.claudeAccount }
    : {};
}

export function useLaunchOptions(taskId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["aiLaunchOptions", taskId ?? ""],
    queryFn: () =>
      unwrap<AiLaunchOptions>(
        api.api.ai["launch-options"].$get({ query: taskId ? { taskId } : {} }),
      ),
    enabled,
    staleTime: 30_000,
  });
}

/** 選択肢が届いたら既定（前回選んだもの・プロジェクトの既定）で埋める */
export function useAiChoice(opts: AiLaunchOptions | undefined) {
  const [c, setC] = useState<AiChoice | null>(null);
  useEffect(() => {
    if (!opts || c) return;
    const repo = opts.repos.find((r) => r.path === opts.defaultRepo) ?? opts.repos[0] ?? null;
    const tpl = opts.templates.find((t) => t.id === opts.defaultTemplateId);
    setC({
      repo: repo?.path ?? null,
      tool: opts.defaultTool,
      templateId: opts.defaultTemplateId,
      instruction: "",
      worktree: (repo?.worktreeDefault ?? false) && tpl?.worktree !== false,
      claudeAccount: opts.defaultClaudeAccount,
      ext: {},
    });
  }, [opts, c]);
  return [c, setC] as const;
}

/**
 * 依頼する。拡張の行（ADR 0015）が引き受けたら（intercept が true）今すぐの起動はしない。公開のビルドでは launchAi と同じ
 */
export async function launchWithExt(input: AiLaunchInput, values: Record<string, unknown>) {
  for (const f of ext.launchFields) {
    if (!f.intercept) continue;
    const { taskId, ...rest } = input;
    const taken = await f.intercept({
      taskId,
      value: values[f.key],
      input: {
        repo: rest.repo,
        tool: rest.tool,
        templateId: rest.templateId ?? "",
        worktree: rest.worktree,
        ...(rest.instruction ? { instruction: rest.instruction } : {}),
        ...(rest.claudeAccount ? { claudeAccount: rest.claudeAccount } : {}),
      },
    });
    if (taken) return null;
  }
  return launchAi(input);
}

export function canLaunch(opts: AiLaunchOptions | undefined, c: AiChoice | null): boolean {
  return !!opts && !!c && c.repo !== null && c.tool !== null && opts.tools.includes(c.tool);
}

const toolKey = (t: AiLaunchTool) => (t === "codex" ? "launch.tool.codex" : "launch.tool.claude");

const Row = LaunchRow;

/** AI に頼むの入力（作成のポップオーバーの下半分と、既存タスクのポップオーバーで共通。確定画像の作成のポップオーバー） */
export function AiFields({
  opts,
  choice,
  onChange,
  onSubmit,
  taskId,
}: {
  opts: AiLaunchOptions | undefined;
  choice: AiChoice | null;
  onChange: (c: AiChoice) => void;
  onSubmit: () => void;
  /** 既存のタスクから頼むとき（拡張の行に渡す） */
  taskId?: string;
}) {
  const { t } = useI18n();
  if (!opts || !choice) return <div className="py-2 text-fg3 text-meta">{t("common.loading")}</div>;
  const repo = opts.repos.find((r) => r.path === choice.repo) ?? null;
  const set = (p: Partial<AiChoice>) => onChange({ ...choice, ...p });
  return (
    <div className="flex flex-col gap-2" data-testid="ai-fields">
      <Row label={t("launch.repo")}>
        {opts.repos.length === 0 ? (
          <span className="text-fg3 text-meta">{t("launch.noRepo")}</span>
        ) : (
          <Picker
            label={t("launch.repo")}
            value={choice.repo}
            testId="ai-repo"
            options={opts.repos.map((r) => ({
              value: r.path,
              label: r.name,
              dot: r.color,
              note: r.projectDefault ? t("launch.projectDefault") : undefined,
              title: r.path,
            }))}
            onChange={(v) => {
              const r = opts.repos.find((x) => x.path === v);
              set({
                repo: v,
                worktree: r?.worktreeDefault ?? false,
                // リポジトリのプロジェクトにアカウントの既定があればそれに合わせる
                ...(r?.claudeAccount ? { claudeAccount: r.claudeAccount } : {}),
              });
            }}
          />
        )}
      </Row>
      <Row label={t("launch.agent")}>
        {opts.tools.length === 0 ? (
          <span className="text-fg3 text-meta">{t("launch.noTool")}</span>
        ) : opts.tools.length === 1 ? (
          <span className="text-body text-fg" data-testid="ai-tool-only">
            {t(toolKey(opts.tools[0] as AiLaunchTool))}
          </span>
        ) : (
          <LaunchSegmented<AiLaunchTool>
            label={t("launch.agent")}
            value={choice.tool}
            options={opts.tools.map((x) => ({ v: x, label: t(toolKey(x)) }))}
            onChange={(x) => set({ tool: x })}
          />
        )}
      </Row>
      {choice.tool === "claude_code" && opts.claudeAccounts.length >= 2 ? (
        <Row label={t("launch.account")}>
          <Picker
            label={t("launch.account")}
            value={choice.claudeAccount}
            testId="ai-account"
            options={opts.claudeAccounts.map((a) => ({
              value: a.path,
              label: a.name ?? t("launch.accountDefault"),
              title: a.path,
            }))}
            onChange={(v) => set({ claudeAccount: v })}
          />
        </Row>
      ) : null}
      <Row label={t("launch.template")}>
        <Picker
          label={t("launch.template")}
          value={choice.templateId}
          testId="ai-template"
          options={opts.templates.map((x) => ({ value: x.id, label: x.name }))}
          onChange={(v) => {
            const tpl = opts.templates.find((x) => x.id === v);
            set({
              templateId: v,
              // 読み取りのみの型は worktree を使わない（変えられる）
              worktree:
                tpl?.worktree === false ? false : (repo?.worktreeDefault ?? choice.worktree),
            });
          }}
        />
      </Row>
      <Row label={t("launch.instruction")} top>
        <AutoGrowTextarea
          minRows={2}
          fitViewport
          value={choice.instruction}
          onChange={(e) => set({ instruction: e.target.value })}
          onKeyDown={(e) => {
            if (isImeKey(e)) return;
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSubmit();
            }
          }}
          aria-label={t("launch.instruction")}
          placeholder={t("launch.instructionPlaceholder")}
          className="min-h-[56px] w-full min-w-0 resize-y rounded-control border border-line bg-bg px-2.5 py-1.5 text-body text-fg placeholder:text-fg3 focus:border-fg3"
          style={{ outline: "none" }}
          data-testid="ai-instruction"
        />
      </Row>
      {ext.launchFields.map((f) => {
        const field = (
          <f.component
            key={f.key}
            taskId={taskId ?? null}
            value={choice.ext[f.key]}
            onChange={(v) => set({ ext: { ...choice.ext, [f.key]: v } })}
          />
        );
        // rows: 部品が LaunchRow で行を並べる（値で行が増える・出さない欄。ADR 0015）
        return f.layout === "rows" ? (
          <div key={f.key} className="contents" data-ext-field={f.key}>
            {field}
          </div>
        ) : (
          <Row key={f.key} label={t(f.label)}>
            <div className="flex min-w-0 flex-1 items-center" data-ext-field={f.key}>
              {field}
            </div>
          </Row>
        );
      })}
      <Row label={t("launch.where")}>
        <span
          className={`flex min-w-0 flex-1 items-center gap-2 text-body ${repo?.git ? "text-fg" : "text-fg3"}`}
          title={repo?.git ? undefined : t("launch.worktreeNotGit")}
        >
          <span className="min-w-0 flex-1 truncate">{t("launch.worktree")}</span>
          <Switch
            on={choice.worktree && (repo?.git ?? false)}
            disabled={!repo?.git}
            onChange={(v) => set({ worktree: v })}
            label={t("launch.worktree")}
            testId="ai-worktree"
          />
        </span>
      </Row>
    </div>
  );
}

/** 脚注（ボタンの行の左。確定画像） */
export function AiFoot({ opts }: { opts: AiLaunchOptions | undefined }) {
  const { t } = useI18n();
  if (!opts) return null;
  return (
    <span
      className="mr-auto min-w-0 truncate text-fg3 text-meta"
      title={opts.terminal ?? undefined}
      data-testid="ai-foot"
    >
      {opts.terminal ? t("launch.foot") : t("launch.footCopy")}
    </span>
  );
}

/** 既存のタスクの「AI に頼む…」（ホバーのボタン・右クリック・詳細パネル） */
export function AskAiPopover({
  task,
  anchor,
  onClose,
}: {
  task: TaskView;
  anchor: HTMLElement | null;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const q = useLaunchOptions(task.id);
  const [choice, setChoice] = useAiChoice(q.data);
  const busy = useRef(false);
  const ok = canLaunch(q.data, choice);
  const submit = () => {
    if (!ok || !choice || busy.current) return;
    busy.current = true;
    void launchWithExt(
      {
        taskId: task.id,
        repo: choice.repo as string,
        tool: choice.tool as AiLaunchTool,
        templateId: choice.templateId,
        worktree: choice.worktree,
        ...(choice.instruction.trim() ? { instruction: choice.instruction.trim() } : {}),
        ...accountInput(q.data, choice),
      },
      choice.ext,
    );
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isImeKey(e)) return;
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        submit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  return (
    <Popover anchor={anchor} onClose={onClose} className="w-[440px] p-4" align="start">
      <div className="mb-3 flex flex-col gap-0.5">
        <span className="font-semibold text-body text-fg">{t("launch.title")}</span>
        <span className="truncate text-fg2 text-meta" data-testid="ai-task-title">
          {task.title.t === "text"
            ? task.title.text
            : formatTaskTitle(task.title.key, task.title.params, locale)}
        </span>
      </div>
      <AiFields
        opts={q.data}
        choice={choice}
        onChange={(c) => setChoice(c)}
        onSubmit={submit}
        taskId={task.id}
      />
      <div className="mt-4 flex items-center justify-end gap-2">
        <AiFoot opts={q.data} />
        <Button variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={onClose}>
          {t("action.cancel")}
        </Button>
        <Button
          variant="primary"
          disabled={!ok}
          onMouseDown={(e) => e.preventDefault()}
          onClick={submit}
          data-testid="ai-launch"
        >
          {t("launch.submit")}
          <span className="font-mono text-micro opacity-70">{"⌘↵"}</span>
        </Button>
      </div>
    </Popover>
  );
}
