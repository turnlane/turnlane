/**
 * E2E の土台（D-092）: dev-board（ダミーデータ・偽の時計・偽のカレンダー）を一時 HOME で起動し、
 * Playwright の WebKit（WKWebView と同じエンジン。既定）か Chromium（`--engine chromium`）で画面を操作する。
 * 実データ・launchd・実カレンダー・ネットワークには触れない（dev-board と同じ）。
 */
import { type Browser, type BrowserType, chromium, type Page, webkit } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;

export type Engine = "chromium" | "webkit";
export const ENGINES: Record<Engine, BrowserType> = { chromium, webkit };

/** 起動した dev-board */
export interface Board {
  /** ログイン用の URL（/auth?t=...&next=...） */
  url: string;
  base: string;
  /** /api を Bearer で呼ぶ（戻り値は JSON） */
  api: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  stop: () => Promise<void>;
}

/** 空いているポート */
function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

/** dev-board を起動する（args は dev-board の引数。apps/web/dist が要る: `bun run e2e` が先にビルドする） */
export async function startBoard(
  args: string[] = [],
  script = "scripts/dev-board.ts",
): Promise<Board> {
  const port = freePort();
  const proc = Bun.spawn(["bun", script, "--port", String(port), ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let out = "";
  const deadline = Date.now() + 60_000;
  let url: string | null = null;
  while (!url) {
    if (Date.now() > deadline) throw new Error(`dev-board did not start:\n${out}`);
    const { value, done } = await reader.read();
    if (done) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`dev-board exited:\n${out}\n${err}`);
    }
    out += dec.decode(value);
    url = /^(http:\/\/127\.0\.0\.1:\d+\/auth\?t=\S+)$/m.exec(out)?.[1] ?? null;
  }
  // 残りの出力は読み捨てる（パイプが詰まらないように）
  void (async () => {
    while (!(await reader.read()).done);
  })().catch(() => {});
  void new Response(proc.stderr).text().catch(() => {});
  const u = new URL(url);
  const token = u.searchParams.get("t") ?? "";
  const base = u.origin;
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
    return (await r.json()) as T;
  };
  return {
    url,
    base,
    api,
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

/** 1つの確認項目 */
export interface Result {
  suite: string;
  engine: Engine;
  name: string;
  ok: boolean;
  note?: string | undefined;
}

/** スイートの実行時の文脈 */
export interface Ctx {
  engine: Engine;
  page: Page;
  board: Board;
  check: (name: string, ok: boolean, note?: string) => void;
}

/** E2E のスイート（エンジンごとに新しい dev-board で走らせる） */
export interface Suite {
  name: string;
  /** dev-board の引数 */
  args: string[];
  /** dev-board の代わりに起動するスクリプト（オンボーディングは scripts/dev-onboarding.ts） */
  script?: string;
  run: (ctx: Ctx) => Promise<void>;
}

/**
 * WebKit がページの移動で打ち切った自分のデーモンへの fetch・EventSource を pageerror に出したもの。
 * 画面の誤りではない（fetch は TanStack Query が受けていて、EventSource の打ち切りは画面から握れない）。
 * WebKit は "Fetch API cannot load http://127.0.0.1:…/api/… due to access control checks." を出し、
 * Playwright の側で name "Fetch API cannot load http" と message "/127.0.0.1:…/api/… due to …" に割れる
 * （"//" の片方が消える）。スタックは無いか、同じ文の後に呼び出し元が並ぶ。
 * 行き先が自分のデーモンの /api 以外のものや、ほかの例外（TypeError など）は数える
 */
const ABORT_RE =
  /^(?:Fetch API|EventSource) cannot load https?:\/*([^/\s]+)(\/\S*) due to access control checks\.$/;

export function isNavigationAbort(e: Error, base: string): boolean {
  const m = ABORT_RE.exec(`${e.name}:${e.message.trimStart()}`);
  if (m?.[1] !== new URL(base).host || !(m[2] ?? "").startsWith("/api/")) return false;
  const head = e.stack?.split("\n")[0] ?? "";
  return head === "" || ABORT_RE.test(head);
}

/** スイートを1つのエンジンで走らせる。例外は失敗の1項目にする */
export async function runSuite(suite: Suite, engine: Engine): Promise<Result[]> {
  const results: Result[] = [];
  const board = await startBoard(suite.args, suite.script);
  let browser: Browser | null = null;
  try {
    browser = await ENGINES[engine].launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      if (!isNavigationAbort(e, board.base)) errors.push(`${e.name}: ${e.message}`);
    });
    const check = (name: string, ok: boolean, note?: string) =>
      results.push({ suite: suite.name, engine, name, ok, note });
    try {
      await suite.run({ engine, page, board, check });
    } catch (e) {
      check("run", false, String(e).slice(0, 500));
    }
    check("no page errors", errors.length === 0, errors.slice(0, 3).join(" / "));
  } finally {
    await browser?.close();
    await board.stop();
  }
  return results;
}
