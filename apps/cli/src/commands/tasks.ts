/**
 * turnlane add / today / ls / done / edit / rm（phase0-plan 3.6、M2-10）。デーモンの API を呼ぶだけ。
 * 一覧の ID は「その一覧の中で一意になる最短の接頭辞（最低8文字）」を出す（UUIDv7 は先頭が時刻なので、
 * 近い時刻に作ったタスクは先頭8文字が同じになる）。ID を受けるコマンドは接頭辞でもよく、曖昧なら候補を出してエラー。
 * turnlane add はデーモンが止まっていれば spool/cli-YYYYMMDD.jsonl に書き、デーモンが起動時に取り込む。
 * clientId（UUIDv7）を付けて送るので、spool 経由で再送しても重複しない。外部の識別子（--source / --external-id）は
 * MCP の add_task と同じ冪等規則（両方指定か両方省略）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { addDays, taskDisplayTitle } from "@turnlane/core";
import type {
  BoardResponse,
  InboxResponse,
  ProjectView,
  QueueResponse,
  TaskView,
  TaskWriteResponse,
} from "@turnlane/core/api";
import { formatTaskTitle } from "@turnlane/core/web";
import { callApi, daemonHealth, fetchHealth } from "../client.ts";
import type { CliEnv } from "../env.ts";
import { lang, notRunning, tr } from "../lang.ts";

/** 端末に出す題名（自動生成タスクは CLI の言語で組み立てる。D-046） */
export function titleOf(t: TaskView): string {
  return t.title.t === "text" ? t.title.text : formatTaskTitle(t.title.key, t.title.params, lang());
}

function uuidv7(): string {
  return Bun.randomUUIDv7();
}

export interface AddOptions {
  text: string;
  date?: string | undefined;
  est?: string | undefined;
  project?: string | undefined;
  note?: string | undefined;
  source?: string | undefined;
  externalId?: string | undefined;
  url?: string | undefined;
  json: boolean;
}

/** spool に書く1行（デーモンが起動時に取り込む。clientId で冪等） */
export interface CliSpoolLine {
  v: 1;
  kind: "add_task";
  at: number;
  body: Record<string, unknown>;
}

export async function addCommand(env: CliEnv, o: AddOptions): Promise<number> {
  if (!o.text.trim()) {
    env.err(
      `${tr("Usage", "使い方")}: turnlane add <text...> [--date YYYY-MM-DD] [--est 30] [--project p] [--note n]`,
    );
    return 2;
  }
  if ((o.source === undefined) !== (o.externalId === undefined)) {
    env.err(
      tr(
        "Give both --source and --external-id, or neither",
        "--source と --external-id は両方指定するか、両方省略してください",
      ),
    );
    return 2;
  }
  const est = o.est !== undefined ? Number(o.est) : undefined;
  if (est !== undefined && !(Number.isInteger(est) && est >= 0)) {
    env.err(
      tr(
        "--est is in minutes (a whole number, 0 or more)",
        "--est は分（0 以上の整数）で指定してください",
      ),
    );
    return 2;
  }
  const raw = [o.text, o.project ? `#${o.project}` : ""].filter(Boolean).join(" ");
  const body: Record<string, unknown> = {
    raw,
    clientId: uuidv7(),
    source: "cli",
    ...(o.date ? { date: o.date } : {}),
    ...(est !== undefined ? { estimateMin: est } : {}),
    ...(o.note ? { notes: o.note } : {}),
    ...(o.source && o.externalId
      ? { external: { source: o.source, id: o.externalId, ...(o.url ? { url: o.url } : {}) } }
      : {}),
  };
  if (!(await fetchHealth(env.paths))) {
    // デーモンが止まっている: spool に書いておき、起動時に取り込む
    const now = Date.now();
    const d = new Date(now);
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    mkdirSync(env.paths.spoolDir, { recursive: true, mode: 0o700 });
    const line: CliSpoolLine = { v: 1, kind: "add_task", at: now, body };
    appendFileSync(join(env.paths.spoolDir, `cli-${ymd}.jsonl`), `${JSON.stringify(line)}\n`);
    if (o.json) env.out(JSON.stringify({ queued: true, created: null }));
    else
      env.out(
        tr(
          "Turnlane isn't running, so the task was saved for later (it is added when Turnlane starts)",
          "Turnlane が止まっているので一時保存しました（起動すると追加されます）",
        ),
      );
    return 0;
  }
  const r = await callApi<TaskWriteResponse | { error: string }>(
    env.paths,
    "POST",
    "/api/tasks",
    body,
  );
  if (!r.ok || !("rev" in r.data)) {
    env.err(
      tr(
        `Could not add the task (HTTP ${r.status}${"error" in r.data ? ` ${r.data.error}` : ""})`,
        `追加できませんでした（HTTP ${r.status}${"error" in r.data ? ` ${r.data.error}` : ""}）`,
      ),
    );
    return 1;
  }
  const w = r.data;
  if (o.json) {
    env.out(
      JSON.stringify({ task: w.task, created: w.created ?? false, skipped: w.skipped ?? null }),
    );
    return 0;
  }
  if (w.skipped === "deleted")
    env.out(
      tr("Not added: this item was deleted before", "削除済みの項目なので追加しませんでした"),
    );
  else if (w.task) {
    // turnlane done などで使える長さの ID を出す（ID を受けるコマンドが探す範囲の中で一意な接頭辞）
    const near = await candidates(env).catch(() => [] as TaskView[]);
    const ids = shortIds([w.task.id, ...near.map((t) => t.id)]);
    env.out(
      `${w.created ? tr("Added", "追加") : tr("Already exists", "既にあります")}: ${titleOf(w.task)}  ${w.task.scheduledDate ?? "Inbox"}  ${ids.get(w.task.id)}`,
    );
  }
  return 0;
}

/** ID の接頭辞の最小の長さ */
export const MIN_ID_PREFIX = 8;

/**
 * 各 ID について、与えた ID の中で一意になる最短の接頭辞（最低 min 文字）。区切りの `-` で終わるときは1文字足す。
 * 同じ ID が複数あっても1つとして扱う
 */
export function shortIds(ids: readonly string[], min = MIN_ID_PREFIX): Map<string, string> {
  const uniq = [...new Set(ids)];
  const out = new Map<string, string>();
  for (const id of uniq) {
    let n = Math.min(min, id.length);
    for (const other of uniq) {
      if (other === id) continue;
      let common = 0;
      while (common < id.length && id[common] === other[common]) common++;
      n = Math.max(n, Math.min(common + 1, id.length));
    }
    if (id[n - 1] === "-" && n < id.length) n++;
    out.set(id, id.slice(0, n));
  }
  return out;
}

const bare = (s: string) => s.replaceAll("-", "").toLowerCase();

/** ID を受けるコマンドが接頭辞を探す範囲: 今日の前後7日のタスクと Inbox */
async function candidates(env: CliEnv): Promise<TaskView[]> {
  const today = await todayDate(env);
  if (!today) return [];
  const b = await board(env, addDays(today, -7), addDays(today, 7));
  const inbox = await callApi<InboxResponse>(env.paths, "GET", "/api/inbox");
  const all = [...(b.data.days ?? []).flatMap((d) => d.tasks), ...(inbox.data.tasks ?? [])];
  return [...new Map(all.map((t) => [t.id, t])).values()];
}

/**
 * 完全な ID か、今日の前後7日と Inbox の中で一意な先頭部分（`-` の有無は問わない）を ID に直す。
 * 見つからない・曖昧なときは理由（曖昧なら候補の一覧）を出して null
 */
export async function resolveTaskId(
  env: CliEnv,
  arg: string,
): Promise<{ id: string; task: TaskView | null } | null> {
  const all = await candidates(env);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg)) {
    const id = arg.toLowerCase();
    return { id, task: all.find((t) => t.id === id) ?? null };
  }
  const want = bare(arg);
  const hits = want ? all.filter((t) => bare(t.id).startsWith(want)) : [];
  if (hits.length === 1) {
    const t = hits[0] as TaskView;
    return { id: t.id, task: t };
  }
  if (hits.length === 0) {
    env.err(
      tr(
        `Not found: ${arg} (searched 7 days around today and the Inbox; a full ID works outside that range)`,
        `見つかりません: ${arg}（今日の前後7日と Inbox を探しました。完全な ID なら範囲外でも使えます）`,
      ),
    );
    return null;
  }
  const ids = shortIds(hits.map((t) => t.id));
  env.err(
    tr(
      `More than one task matches: ${arg} (give a longer ID)`,
      `複数に一致します: ${arg}（もっと長く指定してください）`,
    ),
  );
  for (const t of hits.slice(0, 10))
    env.err(`  ${ids.get(t.id)}  ${titleOf(t)}  ${t.scheduledDate ?? "Inbox"}`);
  if (hits.length > 10)
    env.err(tr(`  and ${hits.length - 10} more`, `  ほか ${hits.length - 10} 件`));
  return null;
}

async function board(env: CliEnv, from: string, to: string) {
  return callApi<BoardResponse>(env.paths, "GET", `/api/board?from=${from}&to=${to}`);
}

function taskLine(t: TaskView, ids: Map<string, string>): string {
  const done = t.status === "done" ? "x" : " ";
  const est = t.estimateMin !== null ? `  ${t.estimateMin}m` : "";
  return `[${done}] ${ids.get(t.id) ?? t.id}  ${titleOf(t)}${est}`;
}

/** 一覧の行（ID はその一覧の中で一意な最短の接頭辞。桁をそろえる） */
function taskLines(tasks: readonly TaskView[]): string[] {
  const ids = shortIds(tasks.map((t) => t.id));
  const w = Math.max(0, ...[...ids.values()].map((x) => x.length));
  for (const [k, v] of ids) ids.set(k, v.padEnd(w));
  return tasks.map((t) => taskLine(t, ids));
}

async function todayDate(env: CliEnv): Promise<string | null> {
  const r = await callApi<InboxResponse>(env.paths, "GET", "/api/inbox");
  return r.ok ? r.data.today : null;
}

/** turnlane today [--json] */
export async function todayCommand(env: CliEnv, o: { json: boolean }): Promise<number> {
  if (!(await daemonHealth(env))) {
    env.err(notRunning(false));
    return 1;
  }
  const today = await todayDate(env);
  if (!today) return 1;
  // 取り込みが止まっていればキューは取れない（自分の番 0 として扱う）
  const q = await callApi<QueueResponse>(env.paths, "GET", "/api/queue");
  const b = await board(env, today, today);
  const day = b.data.days?.[0];
  if (!b.ok || !day) {
    env.err(tr(`Request failed (HTTP ${b.status})`, `取得に失敗しました（HTTP ${b.status}）`));
    return 1;
  }
  const yourTurn = (q.ok ? q.data.items : []).filter((x) =>
    x.followUps.some((f) => f.status === "open"),
  );
  if (o.json) {
    env.out(
      JSON.stringify({
        date: today,
        events: day.events.map((e) => ({ title: e.title, start: e.start, end: e.end })),
        tasks: day.tasks,
        yourTurn: yourTurn.length,
        totals: day.totals,
      }),
    );
    return 0;
  }
  const tz = b.data.tz;
  const hm = (ms: number) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(
      ms,
    );
  env.out(`${today}`);
  for (const e of day.events) env.out(`  ${hm(e.start)}-${hm(e.end)}  ${e.title ?? ""}`);
  for (const line of taskLines(day.tasks)) env.out(`  ${line}`);
  env.out(`${tr("Your turn", "自分の番")}: ${yourTurn.length}`);
  for (const x of yourTurn) {
    const f = x.followUps.find((y) => y.status === "open");
    if (f?.task) env.out(`  - ${taskDisplayTitle(f.task, lang())}`);
  }
  return 0;
}

/** turnlane ls [--date YYYY-MM-DD | --inbox] [--json] */
export async function lsCommand(
  env: CliEnv,
  o: { date?: string | undefined; inbox: boolean; json: boolean },
): Promise<number> {
  if (!(await daemonHealth(env))) {
    env.err(notRunning(false));
    return 1;
  }
  let tasks: TaskView[];
  if (o.inbox) {
    const r = await callApi<InboxResponse>(env.paths, "GET", "/api/inbox");
    tasks = r.data.tasks;
  } else {
    const date = o.date ?? (await todayDate(env));
    if (!date) return 1;
    const r = await board(env, date, date);
    if (!r.ok) {
      env.err(tr(`Request failed (HTTP ${r.status})`, `取得に失敗しました（HTTP ${r.status}）`));
      return r.status === 400 ? 2 : 1;
    }
    tasks = r.data.days[0]?.tasks ?? [];
  }
  if (o.json) env.out(JSON.stringify({ tasks }));
  else for (const line of taskLines(tasks)) env.out(line);
  return 0;
}

/** 接頭辞の ID を直し、デーモンが動いていることを確かめる（ID を受けるコマンドの共通部分） */
async function taskArg(
  env: CliEnv,
  idArg: string | undefined,
  usage: string,
): Promise<{ id: string; task: TaskView | null } | number> {
  if (!idArg) {
    env.err(`${tr("Usage", "使い方")}: ${usage}`);
    return 2;
  }
  if (!(await daemonHealth(env))) {
    env.err(notRunning(false));
    return 1;
  }
  return (await resolveTaskId(env, idArg)) ?? 1;
}

/** turnlane done <id>（完全な ID か、今日の前後7日と Inbox の中で一意な先頭部分） */
export async function doneCommand(env: CliEnv, idArg: string | undefined): Promise<number> {
  const r0 = await taskArg(env, idArg, "turnlane done <id>");
  if (typeof r0 === "number") return r0;
  const r = await callApi<TaskWriteResponse>(env.paths, "POST", `/api/tasks/${r0.id}/complete`);
  if (!r.ok || !r.data.task) {
    env.err(
      tr(
        `Could not complete the task (HTTP ${r.status})`,
        `完了にできませんでした（HTTP ${r.status}）`,
      ),
    );
    return 1;
  }
  env.out(`${tr("Done", "完了")}: ${titleOf(r.data.task)}`);
  return 0;
}

export const editUsage = () =>
  tr(
    "turnlane edit <id> [--title <title>] [--date YYYY-MM-DD | --inbox] [--est <min> | --no-est] [--project <name> | --no-project]",
    "turnlane edit <id> [--title <題名>] [--date YYYY-MM-DD | --inbox] [--est <分> | --no-est] [--project <名前> | --no-project]",
  );

export interface EditOptions {
  title?: string | undefined;
  date?: string | undefined;
  inbox: boolean;
  est?: string | undefined;
  noEst: boolean;
  project?: string | undefined;
  noProject: boolean;
  json: boolean;
}

/** プロジェクトの名前を ID に直す。無ければ作る（turnlane add の #project と同じ） */
async function projectIdByName(env: CliEnv, name: string): Promise<string | null> {
  const r = await callApi<{ projects: ProjectView[] }>(env.paths, "GET", "/api/projects?all=1");
  const hit = (r.data?.projects ?? []).find((p) => p.name === name);
  if (hit) return hit.id;
  const c = await callApi<{ project: ProjectView }>(env.paths, "POST", "/api/projects", { name });
  return c.ok ? c.data.project.id : null;
}

/** turnlane edit <id> …（題名・日付 / Inbox・見積・プロジェクトを変える。詳細パネルの編集と同じ API） */
export async function editCommand(
  env: CliEnv,
  idArg: string | undefined,
  o: EditOptions,
): Promise<number> {
  const usage = () => {
    env.err(`${tr("Usage", "使い方")}: ${editUsage()}`);
    return 2;
  };
  if (!idArg) return usage();
  if (o.date !== undefined && o.inbox) {
    env.err(
      tr("--date and --inbox can't be used together", "--date と --inbox は同時に指定できません"),
    );
    return 2;
  }
  if (o.est !== undefined && o.noEst) {
    env.err(
      tr("--est and --no-est can't be used together", "--est と --no-est は同時に指定できません"),
    );
    return 2;
  }
  if (o.project !== undefined && o.noProject) {
    env.err(
      tr(
        "--project and --no-project can't be used together",
        "--project と --no-project は同時に指定できません",
      ),
    );
    return 2;
  }
  if (o.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) {
    env.err(tr("--date must be YYYY-MM-DD", "--date は YYYY-MM-DD で指定してください"));
    return 2;
  }
  if (o.title !== undefined && !o.title.trim()) {
    env.err(tr("--title is empty", "--title が空です"));
    return 2;
  }
  const est = o.est !== undefined ? Number(o.est) : undefined;
  if (est !== undefined && !(o.est?.trim() && Number.isInteger(est) && est >= 0 && est <= 1440)) {
    env.err(
      tr(
        "--est is in minutes (a whole number from 0 to 1440)",
        "--est は分（0〜1440 の整数）で指定してください",
      ),
    );
    return 2;
  }
  if (o.project !== undefined && !o.project.trim()) {
    env.err(
      tr(
        "--project is empty (use --no-project to remove it)",
        "--project が空です（外すときは --no-project）",
      ),
    );
    return 2;
  }
  const changes =
    o.title !== undefined ||
    o.date !== undefined ||
    o.inbox ||
    est !== undefined ||
    o.noEst ||
    o.project !== undefined ||
    o.noProject;
  if (!changes) {
    env.err(tr("Give at least one thing to change", "変える項目を1つ以上指定してください"));
    return usage();
  }
  const r0 = await taskArg(env, idArg, editUsage());
  if (typeof r0 === "number") return r0;
  const patch: Record<string, unknown> = {};
  if (o.title !== undefined) patch.title = o.title.trim();
  if (est !== undefined) patch.estimateMin = est;
  if (o.noEst) patch.estimateMin = null;
  if (o.noProject) patch.projectId = null;
  if (o.project !== undefined) {
    const pid = await projectIdByName(env, o.project.trim());
    if (!pid) {
      env.err(
        tr(
          `Could not set up the project: ${o.project}`,
          `プロジェクトを用意できませんでした: ${o.project}`,
        ),
      );
      return 1;
    }
    patch.projectId = pid;
  }
  let task: TaskView | null = r0.task;
  if (Object.keys(patch).length > 0) {
    const r = await callApi<TaskWriteResponse>(env.paths, "PATCH", `/api/tasks/${r0.id}`, patch);
    if (!r.ok || !r.data.task) {
      env.err(
        tr(
          `Could not change the task (HTTP ${r.status})`,
          `変更できませんでした（HTTP ${r.status}）`,
        ),
      );
      return r.status === 400 ? 2 : 1;
    }
    task = r.data.task;
  }
  if (o.date !== undefined || o.inbox) {
    const r = await callApi<TaskWriteResponse>(env.paths, "POST", `/api/tasks/${r0.id}/move`, {
      date: o.inbox ? null : o.date,
    });
    if (!r.ok || !r.data.task) {
      env.err(
        tr(
          `Could not change the date (HTTP ${r.status})`,
          `日付を変えられませんでした（HTTP ${r.status}）`,
        ),
      );
      return r.status === 400 ? 2 : 1;
    }
    task = r.data.task;
  }
  if (!task) return 1;
  if (o.json) env.out(JSON.stringify({ task }));
  else {
    const est2 = task.estimateMin !== null ? `  ${task.estimateMin}m` : "";
    const proj = o.noProject
      ? tr("  no project", "  プロジェクトなし")
      : o.project
        ? `  #${o.project.trim()}`
        : "";
    env.out(
      `${tr("Updated", "更新")}: ${titleOf(task)}  ${task.scheduledDate ?? "Inbox"}${est2}${proj}`,
    );
  }
  return 0;
}

/** turnlane rm <id>（論理削除。外部の識別子の付いたタスクは、削除後に同じ識別子で送られても作り直さない） */
export async function rmCommand(env: CliEnv, idArg: string | undefined): Promise<number> {
  const r0 = await taskArg(env, idArg, "turnlane rm <id>");
  if (typeof r0 === "number") return r0;
  const r = await callApi<TaskWriteResponse>(env.paths, "DELETE", `/api/tasks/${r0.id}`);
  if (!r.ok) {
    env.err(
      tr(
        `Could not delete the task (HTTP ${r.status})`,
        `削除できませんでした（HTTP ${r.status}）`,
      ),
    );
    return 1;
  }
  env.out(`${tr("Deleted", "削除")}: ${r0.task ? titleOf(r0.task) : r0.id}`);
  return 0;
}
