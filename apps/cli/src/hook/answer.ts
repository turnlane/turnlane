/**
 * turnlane hook --tool claude_code --answer（ADR 0023。m2-api 42 章）: Claude Code の PermissionRequest の hook として動き、
 * 人が Turnlane で「許可する」・AskUserQuestion の選択肢を押したら、その答えを Claude Code に返す。
 *
 * - Claude Code はこの hook と並んで本体の確認（端末のダイアログ・Agent SDK のアプリの確認）を出し、先に答えた方が勝つ。
 *   この hook は何も出さずに終わる限り、本体の確認を遅らせも変えもしない
 * - すぐ終わる（何も出さない）とき: PermissionRequest でない、委任の子・プログラム経由（sdk-*）のセッション、デーモンに
 *   届かない・トークンが無い、デーモンが待たないと答えた（設定「Turnlane から答える」がオフ・プログラム経由など）
 * - 待つ間: デーモンに long-poll で答えを聞く。取り下げられた（別の形で待ちが閉じた）・待ちを知らない（デーモンの再起動）・
 *   親（Claude Code）が居なくなった・シグナルを受けた・デーモンに 60 秒届かないときは、何も出さずに終わる
 * - デーモンに送るのは session_id・agent_id・ツールの名前・権限のモード・環境の印（entrypoint・委任の子か）だけ。ツールの
 *   入力（コマンド・問いの文）は送らない（ADR 0005）。答えは選択肢の番号で受け取り、自分の入力から名前に直す
 * - 出すのは「この 1 回だけ許可」（behavior: allow）と、AskUserQuestion の答え（updatedInput に answers を足したもの）だけ。
 *   拒否・今後も許可は出さない（ADR 0019 の Decision 2）
 *
 * import は node:fs・同じディレクトリ・@turnlane/collectors/hook-allowlist だけ（biome.json）。fetch は Bun の組み込み
 */
import { readFileSync } from "node:fs";
import { delegatedThreadOf } from "@turnlane/collectors/hook-allowlist";

/** 1 回の long-poll の長さ（デーモンの上限と同じ） */
export const POLL_MS = 25_000;
/** デーモンに届かない間に聞き直す長さ */
export const RECONNECT_MS = 60_000;
/** 待ちを開く・取り消す呼び出しの上限 */
const OPEN_TIMEOUT_MS = 1_500;
const CANCEL_TIMEOUT_MS = 300;
/** 親が居るかを確かめる間隔 */
export const PARENT_CHECK_MS = 1_000;
const DEFAULT_PORT = 7317;

type Rec = Record<string, unknown>;

/** デーモンの応答（core の HookWaitOpenResponse・HookWaitResult と同じ形。hook は core を import しない） */
type OpenResponse = { wait: true; id: string } | { wait: false; reason: string };
type Choice = { options: number[] } | { text: string };
type WaitResult =
  | { state: "open" }
  | { state: "allow" }
  | { state: "answer"; count: number; answers: Choice[] }
  | { state: "withdrawn" };

export interface AnswerHookDeps {
  env: Record<string, string | undefined>;
  /** 起動したときの親（Claude Code） */
  ppid: number;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  readFile: (path: string) => string;
  /** 親がまだ居るか */
  parentAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** シグナル（SIGTERM・SIGINT・SIGHUP）を受けたら呼ぶ関数を登録する */
  onSignal: (f: () => void) => void;
}

const isObj = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** 起動の印だけで待たないと決まるか（デーモンに聞く前。プログラム経由・委任の子） */
export function skipByEnv(env: Record<string, string | undefined>): boolean {
  if (delegatedThreadOf(env.T3CODE_THREAD_ID)) return true;
  return (env.CLAUDE_CODE_ENTRYPOINT ?? "").startsWith("sdk-");
}

export function daemonOf(env: Record<string, string | undefined>): {
  base: string;
  tokenPath: string;
} | null {
  const port = env.TURNLANE_PORT ? Number(env.TURNLANE_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const data = env.TURNLANE_DATA_DIR
    ? env.TURNLANE_DATA_DIR.replace(/\/+$/, "")
    : `${env.HOME ?? ""}/Library/Application Support/turnlane`;
  return { base: `http://127.0.0.1:${port}/api/hook-waits`, tokenPath: `${data}/token` };
}

/** 待ちを開く本文（許可したキーだけ） */
export function openBody(input: Rec, env: Record<string, string | undefined>): Rec | null {
  const session = str(input.session_id);
  const tool = str(input.tool_name);
  if (!session || !tool) return null;
  const agentId = str(input.agent_id);
  const mode = str(input.permission_mode);
  const entry = str(env.CLAUDE_CODE_ENTRYPOINT);
  return {
    session,
    tool,
    ...(agentId ? { agentId } : {}),
    ...(mode && mode.length <= 64 ? { permissionMode: mode } : {}),
    ...(entry && entry.length <= 64 ? { entrypoint: entry } : {}),
  };
}

const ALLOW = { behavior: "allow" } as const;

const out = (decision: Rec): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });

/**
 * デーモンの答えを Claude Code に出す形にする。自分の入力と合わない（ツールの種類・問いの数・番号の範囲・単一選択に
 * 複数・同じ問いの文が 2 つ）ときは null（何も出さない）
 */
export function decisionFor(input: Rec, r: WaitResult): string | null {
  const tool = str(input.tool_name);
  if (r.state === "allow") return tool && tool !== "AskUserQuestion" ? out(ALLOW) : null;
  if (r.state !== "answer" || tool !== "AskUserQuestion") return null;
  const ti = input.tool_input;
  if (!isObj(ti) || !Array.isArray(ti.questions)) return null;
  const qs = ti.questions;
  if (qs.length !== r.count || r.answers.length !== qs.length) return null;
  const answers: Record<string, string> = {};
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    const a = r.answers[i];
    if (!isObj(q) || !a) return null;
    const text = str(q.question);
    if (!text || text in answers) return null;
    if ("text" in a) {
      if (typeof a.text !== "string" || !a.text.trim()) return null;
      answers[text] = a.text;
      continue;
    }
    const opts = Array.isArray(q.options) ? q.options : [];
    if (!Array.isArray(a.options) || a.options.length === 0) return null;
    if (q.multiSelect !== true && a.options.length !== 1) return null;
    const labels: string[] = [];
    for (const n of a.options) {
      const o = Number.isInteger(n) ? opts[n] : undefined;
      const l = isObj(o) ? str(o.label) : undefined;
      if (!l) return null;
      labels.push(l);
    }
    // 複数選択はカンマと空白でつなぐ（Claude Code 2.1.326 で確かめた形）
    answers[text] = labels.join(", ");
  }
  return out({ ...ALLOW, updatedInput: { ...ti, answers } });
}

/**
 * hook の本体。Claude Code に出す文字列（無ければ null = 何も出さない）を返す。どんな失敗でも null
 */
export async function answerHook(input: unknown, d: AnswerHookDeps): Promise<string | null> {
  if (!isObj(input) || input.hook_event_name !== "PermissionRequest") return null;
  if (skipByEnv(d.env)) return null;
  const body = openBody(input, d.env);
  const where = daemonOf(d.env);
  if (!body || !where) return null;
  let token: string;
  try {
    token = d.readFile(where.tokenPath).trim();
  } catch {
    return null;
  }
  if (!token) return null;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  let id: string;
  try {
    const res = await d.fetch(where.base, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const r = (await res.json()) as OpenResponse;
    if (!r.wait || typeof r.id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(r.id)) return null;
    id = r.id;
  } catch {
    return null;
  }

  // ここから待つ。シグナル・親が居なくなったら、取り消して何も出さずに終わる
  let stopped = false;
  const ctrl = { current: null as AbortController | null };
  const stop = () => {
    stopped = true;
    ctrl.current?.abort();
  };
  d.onSignal(stop);
  const cancel = async () => {
    try {
      await d.fetch(`${where.base}/${id}/cancel`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
      });
    } catch {}
  };
  const watch = setInterval(() => {
    if (!d.parentAlive(d.ppid)) stop();
  }, PARENT_CHECK_MS);
  try {
    let failingSince: number | null = null;
    while (!stopped) {
      if (!d.parentAlive(d.ppid)) {
        stopped = true;
        break;
      }
      ctrl.current = new AbortController();
      let r: WaitResult | "gone" | "error";
      try {
        const res = await d.fetch(`${where.base}/${id}/result?wait=${POLL_MS}`, {
          method: "GET",
          headers,
          signal: ctrl.current.signal,
        });
        r = res.status === 404 ? "gone" : res.ok ? ((await res.json()) as WaitResult) : "error";
      } catch {
        r = "error";
      }
      if (stopped) break;
      if (r === "gone") return null;
      if (r === "error") {
        const now = d.now();
        failingSince ??= now;
        if (now - failingSince > RECONNECT_MS) return null;
        await d.sleep(1_000);
        continue;
      }
      failingSince = null;
      if (r.state === "open") continue;
      if (r.state === "withdrawn") return null;
      return decisionFor(input, r);
    }
    await cancel();
    return null;
  } finally {
    clearInterval(watch);
  }
}

/** 親が居るか: 親が変わっていない（launchd に引き取られていない）かつ、そのプロセスがまだある */
export function parentAlive(pid: number): boolean {
  if (process.ppid !== pid || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runAnswerHook(): Promise<never> {
  let text: string | null = null;
  try {
    const input = JSON.parse(await Bun.stdin.text());
    text = await answerHook(input, {
      env: process.env,
      ppid: process.ppid,
      fetch: (url, init) => fetch(url, init),
      readFile: (p) => readFileSync(p, "utf8"),
      parentAlive,
      sleep: (ms) => Bun.sleep(ms),
      now: () => Date.now(),
      onSignal: (f) => {
        for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, f);
      },
    });
  } catch {
    text = null;
  }
  if (text) process.stdout.write(text);
  process.exit(0);
}
