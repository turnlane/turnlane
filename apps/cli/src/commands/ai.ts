/**
 * turnlane ai / turnlane queue / turnlane sources / turnlane rederive / turnlane reingest（phase0-plan 3.6、M1-12）。デーモンの API を呼ぶだけ。
 */
import { taskDisplayTitle } from "@turnlane/core";
import type { AiDaysView, QueueItem, SourceView } from "@turnlane/daemon";
import { callApi, daemonHealth } from "../client.ts";
import type { CliEnv } from "../env.ts";
import { lang, notRunning, tr } from "../lang.ts";

export function dur(ms: number): string {
  if (ms < 60_000) return ms > 0 ? "<1m" : "0m";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${m % 60 ? `${m % 60}m` : ""}` : `${Math.floor(h / 24)}d${h % 24}h`;
}

const untitled = () => tr("(untitled)", "（題名なし）");
const scratchLabel = () => tr("(scratch)", "（壁打ち）");
const noRepoLabel = () => tr("(no repo)", "（リポジトリなし）");

async function requireDaemon(env: CliEnv): Promise<boolean> {
  if (await daemonHealth(env)) return true;
  env.err(notRunning());
  return false;
}

const STATUS_LABEL: Record<"en" | "ja", Record<string, string>> = {
  en: {
    needs_input: "BLOCKED",
    error: "ERROR",
    running: "running",
    your_turn: "YOUR TURN",
    done: "done",
    limit: "LIMIT",
  },
  ja: {
    needs_input: "ブロック中",
    error: "エラー",
    running: "実行中",
    your_turn: "自分の番",
    done: "完了",
    limit: "利用上限",
  },
};

const statusLabel = (s: string) => STATUS_LABEL[lang()][s] ?? s;
/** 利用枠の上限待ち（状態は done・理由 rate_limit）は「完了」と出さない */
const itemLabel = (x: { status: string; reason: string | null }) =>
  statusLabel(x.status === "done" && x.reason === "rate_limit" ? "limit" : x.status);

/** turnlane ai [--date YYYY-MM-DD | --days N] [--json] */
export async function aiCommand(
  env: CliEnv,
  o: { date?: string | undefined; days?: string | undefined; json: boolean; tz?: string },
): Promise<number> {
  if (!(await requireDaemon(env))) return 1;
  const days = o.days ? Number(o.days) : 1;
  if (!Number.isInteger(days) || days < 1 || days > 62) {
    env.err(tr("--days must be 1-62", "--days は 1〜62"));
    return 2;
  }
  const q = new URLSearchParams({ ...(o.date ? { date: o.date } : {}), days: String(days) });
  const res = await callApi<AiDaysView>(env.paths, "GET", `/api/work-items?${q}`);
  if (!res.ok) {
    env.err(tr(`Request failed (HTTP ${res.status})`, `取得に失敗しました（HTTP ${res.status}）`));
    return 1;
  }
  const v = res.data;
  if (o.json) {
    env.out(JSON.stringify(v));
    return 0;
  }
  for (const d of v.days) {
    const stats = [
      `AI ${dur(d.aiMs)}`,
      d.idleMs > 0 ? tr(`Idle ${dur(d.idleMs)}`, `放置 ${dur(d.idleMs)}`) : "",
      d.expired > 0 ? tr(`Expired ${d.expired}`, `期限切れ ${d.expired}`) : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const today = d.date === v.today ? tr(" (today)", "（今日）") : "";
    env.out(
      `${d.date}${today}  ${stats}  ${tr(`${d.items.length} items`, `${d.items.length} 件`)}`,
    );
    for (const x of d.items) {
      const where = x.branch
        ? `${x.repoRoot?.split("/").at(-1) ?? ""}#${x.branch}`
        : (x.repoRoot?.split("/").at(-1) ?? (x.scratch ? scratchLabel() : noRepoLabel()));
      const est = x.estimated ? "~" : "";
      const carried = x.carriedFrom ? ` ↺${x.carriedFrom}` : "";
      env.out(
        `  ${est}${itemLabel(x).padEnd(11)} ${x.title ?? untitled()}  [${x.tools.join(",")}] ${where}  AI ${dur(x.aiMs)}${x.idleMs > 0 ? tr(` idle ${dur(x.idleMs)}`, ` 放置 ${dur(x.idleMs)}`) : ""}${x.prRef ? ` ${x.prRef}` : ""}${carried}`,
      );
    }
    if (d.idleByRepo.length > 0) {
      env.out(
        `  ${tr("idle by repo", "リポジトリごとの放置")}: ${d.idleByRepo.map((r) => `${r.repoRoot?.split("/").at(-1) ?? (r.scratch ? scratchLabel() : noRepoLabel())} ${dur(r.ms)}`).join(", ")}`,
      );
    }
  }
  return 0;
}

/** turnlane queue [--json] */
export async function queueCommand(
  env: CliEnv,
  o: { json: boolean; now?: number },
): Promise<number> {
  if (!(await requireDaemon(env))) return 1;
  const res = await callApi<{ items: QueueItem[] }>(env.paths, "GET", "/api/queue");
  if (!res.ok) {
    env.err(tr(`Request failed (HTTP ${res.status})`, `取得に失敗しました（HTTP ${res.status}）`));
    return 1;
  }
  const { items } = res.data;
  if (o.json) {
    env.out(JSON.stringify({ items }));
    return 0;
  }
  if (items.length === 0) {
    env.out(tr("Nothing is your turn", "自分の番はありません"));
    return 0;
  }
  const now = o.now ?? Date.now();
  for (const x of items) {
    const kinds = x.followUps
      .map(
        (f) =>
          `${f.limit ? "resume_limit" : f.kind}${f.status === "snoozed" ? tr("(snoozed)", "（スヌーズ中）") : ""}`,
      )
      .join(",");
    const exp = x.followUps.find(
      (f) => f.expiresAt !== null && f.expiresAt - now < 24 * 3_600_000,
    )?.expiresAt;
    env.out(
      `${statusLabel(x.status).padEnd(11)} ${x.title ?? untitled()}${kinds ? `  [${kinds}]` : ""}  ${tr("waiting", "待ち")} ${dur(now - x.waitingSince)}${exp ? tr(`  expires in ${dur(exp - now)}`, `  あと ${dur(exp - now)} で期限切れ`) : ""}`,
    );
    // タスクの題名は表示時に組み立てる（D-046。CLI の言語で）
    for (const f of x.followUps)
      if (f.task) env.out(`            - ${taskDisplayTitle(f.task, lang())}`);
  }
  return 0;
}

/** turnlane sources [list|rescan|health] [--json] */
export async function sourcesCommand(
  env: CliEnv,
  action: string | undefined,
  o: { json: boolean },
): Promise<number> {
  if (!(await requireDaemon(env))) return 1;
  if (action === "rescan") {
    const r = await callApi(env.paths, "POST", "/api/sources/rescan");
    if (!r.ok) {
      env.err(tr(`Rescan failed (HTTP ${r.status})`, `再検出に失敗しました（HTTP ${r.status}）`));
      return 1;
    }
    env.out(tr("Rescanned", "再検出しました"));
  } else if (action !== undefined && action !== "list" && action !== "health") {
    env.err(`${tr("Usage", "使い方")}: turnlane sources [list|rescan|health] [--json]`);
    return 2;
  }
  const v = (
    await callApi<{ sources: SourceView[]; backfillDone: boolean }>(
      env.paths,
      "GET",
      "/api/sources",
    )
  ).data;
  if (o.json) {
    env.out(JSON.stringify(v));
    return 0;
  }
  for (const s of v.sources) {
    const health = `${s.healthLevel}${s.healthReason ? ` (${s.healthReason})` : ""}`;
    const last = s.lastIngestAt ? new Date(s.lastIngestAt).toISOString() : "-";
    env.out(
      `${s.enabled ? " " : "x"} ${s.tool.padEnd(12)} ${(s.profileLabel ?? "").padEnd(10)} ${s.rootPath}  ${tr("status", "状態")} ${health}  hooks ${s.hooksState}${s.detectedVersion ? `  v${s.detectedVersion}` : ""}  ${tr("last import", "最終取り込み")} ${last}`,
    );
    if (s.excludeGlobs.length > 0)
      env.out(`    ${tr("exclude", "除外")}: ${s.excludeGlobs.join(", ")}`);
  }
  if (!v.backfillDone) {
    const ob = await callApi<{ consented: boolean }>(env.paths, "GET", "/api/onboarding");
    if (ob.ok && !ob.data.consented) {
      env.out(
        tr(
          "Import: waiting for consent (start with turnlane onboarding consent)",
          "取り込み: 同意待ち（turnlane onboarding consent で始めます）",
        ),
      );
      return 0;
    }
  }
  env.out(
    v.backfillDone
      ? tr("First import: done", "初回の取り込み: 完了")
      : tr("First import: running", "初回の取り込み: 実行中"),
  );
  return 0;
}

export async function rederiveCommand(
  env: CliEnv,
  o: { wait: boolean; since?: string | undefined },
): Promise<number> {
  if (!(await requireDaemon(env))) return 1;
  if (o.since && !o.wait) {
    env.err(
      tr(
        "Use --since together with --wait (turnlane rederive --wait --since YYYY-MM-DD)",
        "--since は --wait と一緒に使います（turnlane rederive --wait --since YYYY-MM-DD）",
      ),
    );
    return 2;
  }
  const res = await callApi(
    env.paths,
    "POST",
    "/api/admin/rederive",
    o.since ? { waitSince: o.since } : {},
  );
  if (!res.ok) {
    env.err(
      tr(`Recalculation failed (HTTP ${res.status})`, `再計算に失敗しました（HTTP ${res.status}）`),
    );
    return 1;
  }
  env.out(
    tr(`Recalculated: ${JSON.stringify(res.data)}`, `再計算しました: ${JSON.stringify(res.data)}`),
  );
  return 0;
}

export async function reingestCommand(
  env: CliEnv,
  o: { source?: string | undefined },
): Promise<number> {
  if (!(await requireDaemon(env))) return 1;
  const res = await callApi(
    env.paths,
    "POST",
    "/api/admin/reingest",
    o.source ? { source: o.source } : {},
  );
  if (!res.ok) {
    env.err(
      tr(`Reimport failed (HTTP ${res.status})`, `読み直しに失敗しました（HTTP ${res.status}）`),
    );
    return 1;
  }
  env.out(
    tr(
      "Reading again from the start (nothing is deleted). Check progress with turnlane sources",
      "最初から読み直しています（記録は消しません）。進み具合は turnlane sources で確認できます",
    ),
  );
  return 0;
}
