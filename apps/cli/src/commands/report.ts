/**
 * turnlane report [date] [--copy] [--lang en|ja]（M4-3）と turnlane stats [--days 14] [--json]（M5-1）。デーモンの API を呼ぶだけ。
 */
import { baseUrl, isLocalDate, readToken } from "@turnlane/core";
import type { UsageStats } from "@turnlane/core/api";
import { callApi, daemonHealth } from "../client.ts";
import type { CliEnv } from "../env.ts";
import { notRunning, tr } from "../lang.ts";
import { dur } from "./ai.ts";

async function requireDaemon(env: CliEnv): Promise<boolean> {
  if (await daemonHealth(env)) return true;
  env.err(notRunning());
  return false;
}

/** pbcopy に渡す（テストでは差し替える） */
export type Copier = (text: string) => Promise<boolean>;

const pbcopy: Copier = async (text) => {
  try {
    const p = Bun.spawn(["/usr/bin/pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    p.stdin.write(text);
    await p.stdin.end();
    return (await p.exited) === 0;
  } catch {
    return false;
  }
};

/** turnlane report [date]（日付区切りで確定済みならその記録、未確定なら今の事実から組み立てたもの） */
export async function reportCommand(
  env: CliEnv,
  o: { date?: string | undefined; copy: boolean; lang?: string | undefined; copier?: Copier },
): Promise<number> {
  if (o.date !== undefined && o.date !== "today" && !isLocalDate(o.date)) {
    env.err(tr("Date must be YYYY-MM-DD", "日付は YYYY-MM-DD"));
    return 2;
  }
  if (o.lang !== undefined && o.lang !== "en" && o.lang !== "ja") {
    env.err(tr("--lang must be en or ja", "--lang は en か ja"));
    return 2;
  }
  if (!(await requireDaemon(env))) return 1;
  const q = new URLSearchParams({ format: "md", ...(o.lang ? { lang: o.lang } : {}) });
  // GET なので本人の操作には数えない
  const res = await fetch(
    `${baseUrl(env.paths.port)}/api/reports/daily/${o.date ?? "today"}?${q}`,
    {
      headers: { authorization: `Bearer ${readToken(env.paths.tokenPath)}` },
    },
  );
  if (!res.ok) {
    env.err(tr(`Request failed (HTTP ${res.status})`, `取得に失敗しました（HTTP ${res.status}）`));
    return 1;
  }
  const md = await res.text();
  env.out(md.replace(/\n$/, ""));
  if (o.copy) {
    if (await (o.copier ?? pbcopy)(md))
      env.err(tr("Copied to the clipboard.", "クリップボードにコピーしました。"));
    else {
      env.err(tr("Could not copy to the clipboard.", "クリップボードにコピーできませんでした。"));
      return 1;
    }
  }
  return 0;
}

/** turnlane stats [--days 14] [--json]（14日カウント、自分の番の処理数、平均応答） */
export async function statsCommand(
  env: CliEnv,
  o: { days?: string | undefined; json: boolean },
): Promise<number> {
  const days = o.days ? Number(o.days) : 14;
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    env.err(tr("--days must be 1-90", "--days は 1〜90"));
    return 2;
  }
  if (!(await requireDaemon(env))) return 1;
  const res = await callApi<UsageStats>(env.paths, "GET", `/api/stats?days=${days}`);
  if (!res.ok) {
    env.err(tr(`Request failed (HTTP ${res.status})`, `取得に失敗しました（HTTP ${res.status}）`));
    return 1;
  }
  const s = res.data;
  if (o.json) {
    env.out(JSON.stringify(s));
    return 0;
  }
  env.out(
    tr(
      `Days used (opened the app): ${s.countedDays} / ${days}, streak ${s.streak}`,
      `利用日（アプリを開いた日）: ${s.countedDays} / ${days} 日、連続 ${s.streak} 日`,
    ),
  );
  env.out("");
  env.out(tr("Date        App Done", "日付        UI  処理"));
  for (const d of s.days) {
    const mark = (b: boolean) => (b ? "o " : "- ");
    env.out(`${d.date}${d.date === s.today ? "*" : " "} ${mark(d.opened)}  ${d.processed}`);
  }
  env.out("");
  const f = s.followUps;
  env.out(
    tr(
      `Your turn handled: ${f.processed} (${f.perWeek} per week; replied ${f.replied} · resolved ${f.resolved} · not needed ${f.notNeeded}), expired ${f.expired}`,
      `自分の番の処理: ${f.processed} 件（週あたり ${f.perWeek} 件。返答 ${f.replied} · 解決 ${f.resolved} · 対応不要 ${f.notNeeded}）、期限切れ ${f.expired} 件`,
    ),
  );
  const avg = s.avgResponseMs === null ? "-" : dur(s.avgResponseMs);
  env.out(tr(`Average response time: ${avg}`, `平均応答時間: ${avg}`));
  return 0;
}
