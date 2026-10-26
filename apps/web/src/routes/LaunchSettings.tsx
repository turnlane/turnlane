/**
 * 設定 > AI の「AI に頼む」（D-107・D-110 (4)。plan §B.3・§B.4）: worktree の置き場所（設定 ai.worktree_dir）と依頼の型。
 * 組み込みの4つは変えられない（一覧に出すだけ）。足した型は名前・本文・読み取りのみを変えられる。
 * Claude のアカウント（D-122）: 取り込みで見つけた設定ディレクトリの名前の変更と「起動の選択肢から外す」（ai.claude_accounts）。
 * プロジェクトごとの worktree の既定・コピーするファイル・テストのコマンド・Claude のアカウントの既定は「プロジェクト」の節
 * （ProjectLaunchFields）
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiTemplateView, ClaudeAccountView, ProjectView } from "@turnlane/core/web";
import { useEffect, useState } from "react";
import { MenuSelect } from "../components/MenuSelect.tsx";
import { Button } from "../components/ui.tsx";
import { useT } from "../i18n/index.tsx";
import { finishDefaults } from "../launch/finish.ts";
import { api, unwrap } from "../lib/api.ts";
import { blurOnEnter } from "../lib/ime.ts";

type AccountConf = Record<string, { name?: string; hidden?: boolean }>;
type ProjectAccounts = Record<string, string>;

function useConfig() {
  return useQuery({
    queryKey: ["settings", "config"],
    queryFn: () =>
      unwrap<{ values: Record<string, unknown> }>(api.api.config.$get()).then((r) => r.values),
  });
}

export function useClaudeAccounts() {
  return useQuery({
    queryKey: ["settings", "claudeAccounts"],
    queryFn: () => unwrap<ClaudeAccountView[]>(api.api.ai["claude-accounts"].$get()),
  });
}

const putConfig = (key: string, value: unknown) =>
  unwrap(api.api.config[":key"].$put({ param: { key }, json: { value } }));

const INPUT =
  "h-7 min-w-0 rounded-card border border-line bg-bg px-2 text-body outline-none placeholder:text-fg3 focus:border-accent";

export function LaunchSection() {
  const t = useT();
  const qc = useQueryClient();
  const [err, setErr] = useState(false);
  const config = useConfig();
  const accounts = useClaudeAccounts();
  const templates = useQuery({
    queryKey: ["settings", "aiTemplates"],
    queryFn: () => unwrap<AiTemplateView[]>(api.api.ai.templates.$get()),
  });
  const dir =
    typeof config.data?.["ai.worktree_dir"] === "string" ? config.data["ai.worktree_dir"] : "";
  const [v, setV] = useState(dir);
  useEffect(() => setV(dir), [dir]);
  const [adding, setAdding] = useState(false);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["settings"] });
    void qc.invalidateQueries({ queryKey: ["aiLaunchOptions"] });
  };
  const run = (job: Promise<unknown>) => {
    setErr(false);
    job.catch(() => setErr(true)).finally(done);
  };
  return (
    <section className="flex flex-col gap-3" data-testid="settings-launch" data-setting="launch">
      <div>
        <h2 className="text-section">{t("settings.launch")}</h2>
        <p className={`text-meta ${err ? "text-error" : "text-fg3"}`}>
          {err ? t("settings.saveFailed") : t("settings.launch.hint")}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-body">{t("settings.launch.worktreeDir")}</h3>
        <p className="text-meta text-fg3">{t("settings.launch.worktreeDir.hint")}</p>
        <input
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => {
            const x = v.trim().replace(/\/+$/, "");
            if (x === dir) return;
            run(
              unwrap(
                api.api.config[":key"].$put({
                  param: { key: "ai.worktree_dir" },
                  json: { value: x || null },
                }),
              ),
            );
          }}
          onKeyDown={blurOnEnter}
          placeholder={"~/src"}
          aria-label={t("settings.launch.worktreeDir")}
          className={`${INPUT} w-full font-mono`}
          data-testid="settings-worktree-dir"
        />
      </div>
      <FinishDefaults values={config.data} onSave={(key, value) => run(putConfig(key, value))} />
      {(accounts.data?.length ?? 0) >= 1 ? (
        <AccountsEditor
          accounts={accounts.data ?? []}
          conf={(config.data?.["ai.claude_accounts"] as AccountConf | undefined) ?? {}}
          onSave={(next) => run(putConfig("ai.claude_accounts", next))}
        />
      ) : null}
      <div className="flex flex-col gap-1.5">
        <h3 className="text-body">{t("settings.launch.templates")}</h3>
        {(templates.data ?? []).map((x) =>
          x.builtin ? (
            <div
              key={x.id}
              className="flex items-center gap-2 rounded-card border border-line px-3 py-1.5 text-body"
            >
              <span className="min-w-0 flex-1 truncate">{x.name}</span>
              <span className="shrink-0 text-fg3 text-meta">
                {t("settings.launch.templates.builtin")}
              </span>
            </div>
          ) : (
            <TemplateEditor
              key={x.id}
              value={x}
              onSave={(json) =>
                run(unwrap(api.api.ai.templates[":id"].$patch({ param: { id: x.id }, json })))
              }
              onDelete={() =>
                run(unwrap(api.api.ai.templates[":id"].$delete({ param: { id: x.id } })))
              }
            />
          ),
        )}
        {adding ? (
          <TemplateEditor
            value={null}
            onSave={(json) => {
              setAdding(false);
              run(unwrap(api.api.ai.templates.$post({ json })));
            }}
            onDelete={() => setAdding(false)}
          />
        ) : (
          <div>
            <Button size="sm" onClick={() => setAdding(true)} data-testid="settings-template-add">
              {t("settings.launch.templates.add")}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

/** Claude のアカウント（D-122）: 1行に1つ。名前（空ならディレクトリ名から）と「起動の選択肢から外す」 */
function AccountsEditor({
  accounts,
  conf,
  onSave,
}: {
  accounts: ClaudeAccountView[];
  conf: AccountConf;
  onSave: (next: AccountConf) => void;
}) {
  const t = useT();
  const save = (path: string, p: { name?: string | null; hidden?: boolean }) => {
    const cur = { ...(conf[path] ?? {}) };
    if (p.name !== undefined) {
      if (p.name) cur.name = p.name;
      else delete cur.name;
    }
    if (p.hidden !== undefined) {
      if (p.hidden) cur.hidden = true;
      else delete cur.hidden;
    }
    const next: AccountConf = { ...conf };
    if (Object.keys(cur).length > 0) next[path] = cur;
    else delete next[path];
    onSave(next);
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid="settings-claude-accounts">
      <div>
        <h3 className="text-body">{t("settings.launch.accounts")}</h3>
        <p className="text-meta text-fg3">{t("settings.launch.accounts.hint")}</p>
      </div>
      {accounts.map((a) => (
        <AccountRow
          key={a.path}
          a={a}
          onName={(name) => save(a.path, { name })}
          onHidden={(hidden) => save(a.path, { hidden })}
        />
      ))}
    </div>
  );
}

function AccountRow({
  a,
  onName,
  onHidden,
}: {
  a: ClaudeAccountView;
  onName: (name: string | null) => void;
  onHidden: (hidden: boolean) => void;
}) {
  const t = useT();
  const [v, setV] = useState(a.customName ?? "");
  useEffect(() => setV(a.customName ?? ""), [a.customName]);
  return (
    <div
      className={`flex items-center gap-3 rounded-card border border-line px-3 py-1.5 ${a.hidden ? "opacity-70" : ""}`}
      data-testid="settings-claude-account"
      data-path={a.path}
    >
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const x = v.trim().slice(0, 40);
          if (x !== (a.customName ?? "")) onName(x || null);
        }}
        onKeyDown={blurOnEnter}
        placeholder={a.dirName ?? t("launch.accountDefault")}
        aria-label={t("settings.launch.accounts.name")}
        maxLength={40}
        className={`${INPUT} w-36`}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-fg3 text-meta" title={a.path}>
        {a.displayPath}
      </span>
      <label className="flex shrink-0 items-center gap-1.5 text-fg2 text-meta">
        <input type="checkbox" checked={a.hidden} onChange={(e) => onHidden(e.target.checked)} />
        {t("settings.launch.accounts.hide")}
      </label>
    </div>
  );
}

interface TemplateJson {
  name: string;
  body: string;
  tool: "claude_code" | "codex" | null;
  readOnly: boolean;
  worktree: boolean | null;
}

function TemplateEditor({
  value,
  onSave,
  onDelete,
}: {
  value: AiTemplateView | null;
  onSave: (v: TemplateJson) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(value?.name ?? "");
  const [body, setBody] = useState(value?.body ?? "{title}\n\n{notes}");
  const [ro, setRo] = useState(value?.readOnly ?? false);
  const dirty = !value || name !== value.name || body !== value.body || ro !== value.readOnly;
  return (
    <div className="flex flex-col gap-1.5 rounded-card border border-line px-3 py-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("settings.launch.templates.name")}
        aria-label={t("settings.launch.templates.name")}
        maxLength={80}
        className={`${INPUT} w-full`}
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        aria-label={t("settings.launch.templates.body")}
        placeholder={t("settings.launch.templates.body")}
        className="min-w-0 resize-y rounded-card border border-line bg-bg px-2 py-1.5 font-mono text-meta outline-none focus:border-accent"
      />
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-meta text-fg2">
          <input type="checkbox" checked={ro} onChange={(e) => setRo(e.target.checked)} />
          {t("settings.launch.templates.readOnly")}
        </label>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onDelete}>
          {t("settings.launch.templates.delete")}
        </Button>
        <Button
          size="sm"
          disabled={!dirty || !name.trim() || !body.trim()}
          onClick={() =>
            onSave({
              name: name.trim(),
              body: body.trim(),
              tool: value?.tool ?? null,
              readOnly: ro,
              worktree: ro ? false : (value?.worktree ?? null),
            })
          }
        >
          {t("settings.launch.templates.save")}
        </Button>
      </div>
    </div>
  );
}

/** プロジェクトの行の「AI に頼む」の設定（テストのコマンド・worktree の既定・コピーするファイル） */
/**
 * 完了したとき（完了のシートの初期値。launch/finish.ts）: AI を終了してタブを閉じる・worktree を消す。どちらも既定オン。
 * 取り込まれていない worktree の強制はここに置かない（毎回シートで選ぶ）
 */
function FinishDefaults({
  values,
  onSave,
}: {
  values: Record<string, unknown> | undefined;
  onSave: (key: string, value: boolean) => void;
}) {
  const t = useT();
  const d = finishDefaults(values);
  const item = (key: string, on: boolean, label: string, testId: string) => (
    <label className="flex cursor-pointer items-center gap-2 text-body">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onSave(key, e.target.checked)}
        data-testid={testId}
      />
      <span>{label}</span>
    </label>
  );
  return (
    <div className="flex flex-col gap-1" data-setting="launch-finish" data-testid="settings-finish">
      <h3 className="text-body">{t("settings.launch.finish")}</h3>
      <p className="text-meta text-fg3">{t("settings.launch.finish.hint")}</p>
      {item(
        "launch.finish_close_terminal",
        d.closeTerminal,
        t("settings.launch.finish.closeTerminal"),
        "settings-finish-close",
      )}
      {item(
        "launch.finish_remove_worktree",
        d.removeWorktree,
        t("settings.launch.finish.removeWorktree"),
        "settings-finish-worktree",
      )}
    </div>
  );
}

export function ProjectLaunchFields({
  p,
  patch,
}: {
  p: ProjectView;
  patch: (json: Record<string, unknown>) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const config = useConfig();
  const accounts = useClaudeAccounts();
  const [cmd, setCmd] = useState(p.testCommand ?? "");
  const [globs, setGlobs] = useState(p.worktreeCopyGlobs.join("\n"));
  useEffect(() => setCmd(p.testCommand ?? ""), [p.testCommand]);
  useEffect(() => setGlobs(p.worktreeCopyGlobs.join("\n")), [p.worktreeCopyGlobs]);
  if (p.repoPaths.length === 0) return null;
  const visible = (accounts.data ?? []).filter((a) => !a.hidden);
  const byProject = (config.data?.["ai.claude_account_by_project"] as ProjectAccounts) ?? {};
  const setAccount = (path: string) => {
    const next: ProjectAccounts = { ...byProject };
    if (path) next[p.id] = path;
    else delete next[p.id];
    void putConfig("ai.claude_account_by_project", next).finally(() => {
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["aiLaunchOptions"] });
    });
  };
  return (
    <div className="flex flex-col gap-1.5 pl-5" data-kind="project-launch">
      {visible.length >= 2 ? (
        <div className="flex items-center gap-2 text-meta text-fg2">
          <span className="w-40 shrink-0">{t("settings.projects.claudeAccount")}</span>
          <MenuSelect
            size="sm"
            className="w-48"
            label={t("settings.projects.claudeAccount")}
            testId="settings-project-account"
            value={
              visible.some((a) => a.path === byProject[p.id]) ? (byProject[p.id] as string) : ""
            }
            onChange={setAccount}
            options={[
              { value: "", label: t("settings.projects.claudeAccount.last") },
              ...visible.map((a, i) => ({
                value: a.path,
                label: a.customName ?? a.dirName ?? t("launch.accountDefault"),
                sep: i === 0,
              })),
            ]}
          />
        </div>
      ) : null}
      <label className="flex items-center gap-2 text-meta text-fg2">
        <span className="w-40 shrink-0">{t("settings.projects.testCommand")}</span>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onBlur={() => {
            if (cmd.trim() !== (p.testCommand ?? "")) patch({ testCommand: cmd.trim() || null });
          }}
          onKeyDown={blurOnEnter}
          placeholder={"bun test"}
          title={t("settings.projects.testCommand.hint")}
          className={`${INPUT} h-6 flex-1 font-mono text-meta`}
        />
      </label>
      <label className="flex items-center gap-2 text-meta text-fg2">
        <input
          type="checkbox"
          checked={p.worktreeDefault !== false}
          onChange={(e) => patch({ worktreeDefault: e.target.checked ? null : false })}
        />
        {t("settings.projects.worktree")}
      </label>
      <label className="flex items-start gap-2 text-meta text-fg2">
        <span className="mt-1 w-40 shrink-0">{t("settings.projects.copyGlobs")}</span>
        <textarea
          value={globs}
          rows={Math.min(4, Math.max(1, globs.split("\n").length))}
          onChange={(e) => setGlobs(e.target.value)}
          onBlur={() => {
            const xs = globs
              .split("\n")
              .map((x) => x.trim())
              .filter(Boolean);
            if (xs.join("\n") !== p.worktreeCopyGlobs.join("\n")) patch({ worktreeCopyGlobs: xs });
          }}
          placeholder={".env"}
          title={t("settings.projects.copyGlobs.hint")}
          className="min-w-0 flex-1 resize-none rounded-card border border-line bg-bg px-2 py-1 font-mono text-meta outline-none focus:border-accent"
        />
      </label>
    </div>
  );
}
