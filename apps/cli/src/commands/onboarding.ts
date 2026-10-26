/**
 * turnlane onboarding [status|detect|consent|summary|restart]（onboarding.md 5 章、M6-18〜M6-20）。
 * オンボーディングの画面（M6-21〜）ができるまで、同意と取り込みの開始は CLI からもできるようにする。
 * - status: 段・同意・7日分の進捗
 * - detect: 見つかった取り込み元（ファイルの数と更新時刻だけ。中身は開かない）
 * - consent [--source <id>]...: 同意して取り込みを始める（--source が無ければ見つかったものすべて）
 * - add <path>: 設定ディレクトリを手で足す（Choose a folder…）
 * - mcp [--dry-run]: 「AI から Turnlane を使えるようにする」段（D-145）。同意した（取り込む）Claude Code / Codex の
 *   取り込み元に MCP サーバを登録し、段を済み（失敗があれば failed）にする。hooks の段の次
 * - summary: 直近7日の AI の稼働時間・カード数・待った回数
 * - restart: 最初の段から通し直す（データは消さない）
 */
import type {
  DetectedSourceView,
  DetectResponse,
  ImportProgress,
  OnboardingSummary,
  OnboardingView,
} from "@turnlane/core/api";
import { mcpTargetFor } from "@turnlane/core/mcp";
import type { SourceView } from "@turnlane/daemon";
import { callApi, daemonHealth } from "../client.ts";
import type { CliEnv } from "../env.ts";
import { notRunning, tr } from "../lang.ts";
import { resolveCliPath } from "./hooks.ts";
import { applyToTargets } from "./mcp-config.ts";

function hm(ms: number): string {
  const m = Math.round(ms / 60_000);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function sourceLine(s: DetectedSourceView): string {
  const last = s.lastActivityAt ? new Date(s.lastActivityAt).toISOString().slice(0, 10) : "-";
  const state = s.readable
    ? ""
    : tr(
        `  unreadable (${s.reason ?? "unreadable"})`,
        `  読めません（${s.reason ?? "unreadable"}）`,
      );
  const counts = tr(`7d ${s.sessions7d} · last ${last}`, `7日 ${s.sessions7d} · 最終 ${last}`);
  const manual = s.manual ? tr("  (added by hand)", "  （手で追加）") : "";
  return `${s.enabled ? "[x]" : "[ ]"} ${s.id}  ${s.tool.padEnd(12)} ${s.label.padEnd(10)} ${s.rootPath}  ${counts}${manual}${state}`;
}

export async function onboardingCommand(
  env: CliEnv,
  sub: string | undefined,
  o: { json: boolean; sources: string[]; path?: string | undefined; dryRun?: boolean },
): Promise<number> {
  if (!(await daemonHealth(env))) {
    env.err(notRunning(false));
    return 1;
  }
  const fail = (status: number, data: unknown) => {
    const e = (data as { error?: string } | null)?.error ?? `HTTP ${status}`;
    env.err(`turnlane onboarding: ${e}`);
    return 1;
  };
  switch (sub ?? "status") {
    case "status": {
      const v = await callApi<OnboardingView>(env.paths, "GET", "/api/onboarding");
      const p = await callApi<ImportProgress>(env.paths, "GET", "/api/onboarding/progress");
      if (!v.ok) return fail(v.status, v.data);
      if (o.json) {
        env.out(JSON.stringify({ ...v.data, progress: p.ok ? p.data : null }));
        return 0;
      }
      env.out(
        tr(
          `Setup: ${v.data.state} (step ${v.data.step}). Import: ${v.data.consented ? "consented" : "waiting for consent (start with turnlane onboarding consent)"}`,
          `はじめの設定: ${v.data.state}（段 ${v.data.step}）。取り込み: ${v.data.consented ? "同意済み" : "同意待ち（turnlane onboarding consent で始めます）"}`,
        ),
      );
      if (p.ok && v.data.consented)
        env.out(
          `${tr("Last 7 days", "直近7日")}: ${p.data.days.map((d) => `${d.date.slice(5)} ${d.state === "done" ? "●" : d.state === "importing" ? "◐" : "○"}`).join("  ")}${p.data.doneAt ? tr(" (done)", "（完了）") : ""}`,
        );
      return 0;
    }
    case "detect": {
      const r = await callApi<DetectResponse>(env.paths, "GET", "/api/onboarding/detect");
      if (!r.ok) return fail(r.status, r.data);
      if (o.json) {
        env.out(JSON.stringify(r.data));
        return 0;
      }
      if (r.data.sources.length === 0)
        env.out(
          tr(
            "Found neither Claude Code nor Codex (add a config folder elsewhere with turnlane onboarding add <path>)",
            "Claude Code も Codex も見つかりませんでした（別の場所の設定フォルダは turnlane onboarding add <path>）",
          ),
        );
      for (const s of r.data.sources) env.out(sourceLine(s));
      if (r.data.claudeDesktop.present)
        env.out(
          tr(
            "Claude Desktop: sessions in the Code tab are included in Claude Code (~/.claude) above. Cowork isn't supported",
            "Claude Desktop: Code タブのセッションは上の Claude Code（~/.claude）に含まれます。Cowork は対象外です",
          ),
        );
      return 0;
    }
    case "add": {
      if (!o.path) {
        env.err(
          tr(
            "Usage: turnlane onboarding add <absolute path of the config folder>",
            "使い方: turnlane onboarding add <設定フォルダの絶対パス>",
          ),
        );
        return 2;
      }
      const r = await callApi<DetectedSourceView>(env.paths, "POST", "/api/onboarding/sources", {
        path: o.path,
      });
      if (!r.ok) return fail(r.status, r.data);
      if (o.json) env.out(JSON.stringify(r.data));
      else env.out(sourceLine(r.data));
      return 0;
    }
    case "consent": {
      let ids = o.sources;
      if (ids.length === 0) {
        const d = await callApi<DetectResponse>(env.paths, "GET", "/api/onboarding/detect");
        if (!d.ok) return fail(d.status, d.data);
        ids = d.data.sources.filter((s) => s.readable).map((s) => s.id);
      }
      const r = await callApi<OnboardingView>(env.paths, "POST", "/api/onboarding/consent", {
        enabledSourceIds: ids,
      });
      if (!r.ok) return fail(r.status, r.data);
      if (o.json) env.out(JSON.stringify(r.data));
      else
        env.out(
          tr(
            `Consent saved. Starting the import (${ids.length} sources; check progress with turnlane onboarding status)`,
            `同意しました。取り込みを始めます（${ids.length} 件の取り込み元。進み具合は turnlane onboarding status）`,
          ),
        );
      return 0;
    }
    case "mcp": {
      const v = await callApi<OnboardingView>(env.paths, "GET", "/api/onboarding");
      if (!v.ok) return fail(v.status, v.data);
      if (!v.data.consented) {
        env.err(
          tr(
            "Agree to the import first (turnlane onboarding consent). Turnlane registers the MCP server only for the sources you agreed to",
            "先に取り込みに同意してください（turnlane onboarding consent）。MCP は同意した取り込み元にだけ登録します",
          ),
        );
        return 1;
      }
      const s = await callApi<{ sources: SourceView[] }>(env.paths, "GET", "/api/sources");
      if (!s.ok) return fail(s.status, s.data);
      const targets = s.data.sources
        .filter((x) => x.enabled && (x.tool === "claude_code" || x.tool === "codex"))
        .map((x) => mcpTargetFor(x.tool as "claude_code" | "codex", x.rootPath, env.paths.home));
      if (targets.length === 0) {
        env.out(
          tr(
            "No Claude Code / Codex source is being imported, so there is nothing to register",
            "取り込んでいる Claude Code / Codex がないので、登録するところがありません",
          ),
        );
        return 0;
      }
      const dryRun = o.dryRun === true;
      const r = applyToTargets(env, targets, "install", resolveCliPath(env), { dryRun });
      if (!dryRun) {
        const st = await callApi<OnboardingView>(env.paths, "PUT", "/api/onboarding/step", {
          step: "mcp",
          status: r.failed > 0 ? "failed" : "done",
        });
        if (!st.ok) return fail(st.status, st.data);
      }
      return r.failed > 0 ? 1 : 0;
    }
    case "summary": {
      const r = await callApi<OnboardingSummary>(
        env.paths,
        "GET",
        "/api/onboarding/summary?days=7",
      );
      if (!r.ok) return fail(r.status, r.data);
      if (o.json) {
        env.out(JSON.stringify(r.data));
        return 0;
      }
      env.out(
        r.data.complete
          ? tr(
              `Last 7 days (${r.data.from} to ${r.data.to}): AI time ${hm(r.data.aiMs)}, AI work ${r.data.cards}, times AI waited ${r.data.waits}`,
              `直近7日（${r.data.from}〜${r.data.to}）: AI の時間 ${hm(r.data.aiMs)}、AI の作業 ${r.data.cards} 件、AI が待った回数 ${r.data.waits}`,
            )
          : tr(
              "The import for the last 7 days isn't finished (turnlane onboarding status)",
              "直近7日の取り込みが終わっていません（turnlane onboarding status）",
            ),
      );
      return 0;
    }
    case "restart": {
      const r = await callApi<OnboardingView>(env.paths, "POST", "/api/onboarding/restart");
      if (!r.ok) return fail(r.status, r.data);
      env.out(
        o.json
          ? JSON.stringify(r.data)
          : tr(
              "Starting setup again from the first step (no data is deleted)",
              "最初の段から通し直します（データは消しません）",
            ),
      );
      return 0;
    }
    default:
      env.err(
        `${tr("Usage", "使い方")}: turnlane onboarding [status|detect|consent [--source <id>]...|add <path>|mcp [--dry-run]|summary|restart] [--json]`,
      );
      return 2;
  }
}
