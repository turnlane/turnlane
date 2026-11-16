/**
 * MCP の ask_user（ADR 0022）: 形と上限、図のファイルの読み方、並行の処理（待っている間もほかの呼び出しに答える）、
 * 進捗の通知、取り消し、デーモンの再起動。合成の問いだけ（一時 HOME。オーナーのデーモン・データには触れない）
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { nullLogger } from "@turnlane/collectors";
import {
  ASK_FILE_MAX,
  FakeClock,
  readToken,
  resolvePaths,
  type TurnlanePaths,
} from "@turnlane/core";
import { FakeGit } from "../../daemon/src/ingest/git.ts";
import { type RunningDaemon, startDaemon } from "../../daemon/src/main.ts";
import { type McpContext, serveMcp, TOOLS } from "../src/commands/mcp.ts";
import { readFigure, runAskUser } from "../src/commands/mcp-ask.ts";

let home: string;
let daemon: RunningDaemon | null = null;
const servers: { stop: (force?: boolean) => void }[] = [];

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  for (const s of servers.splice(0)) s.stop(true);
  if (home) rmSync(home, { recursive: true, force: true });
});

function tmpHome(): string {
  home = mkdtempSync(join(tmpdir(), "turnlane-mcp-ask-"));
  return home;
}

async function startTestDaemon(): Promise<TurnlanePaths> {
  const h = tmpHome();
  const paths = resolvePaths({ HOME: h }, h);
  daemon = await startDaemon({
    paths,
    logger: nullLogger,
    port: 0,
    clock: new FakeClock(Date.UTC(2026, 10, 16, 1, 0)),
    ingest: { git: new FakeGit(), noWatch: true },
    calendar: false,
    summary: false,
    // 取り込みに同意済み（自分のカード = 報告の作業を取り込む）
    onboarding: { assumeDone: true },
  });
  return { ...paths, port: daemon.port };
}

const args = (dir: string) => ({
  question: "Where should the save button go?",
  context: "The settings form has 14 fields.",
  options: [
    { label: "Bottom", description: "always reachable", recommended: true, figure_path: "a.svg" },
    { label: "Top right", description: "as it is now", figure_path: join(dir, "missing.html") },
  ],
  explain_path: "explain.html",
});

/** stdio の代わりのパイプで MCP サーバを動かす */
function pipeServer(ctx: McpContext) {
  const input = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  const served = serveMcp(
    input,
    (l) => {
      lines.push(JSON.parse(l) as Record<string, unknown>);
      for (const w of waiters.splice(0)) w();
    },
    { ctx },
  );
  const send = (m: Record<string, unknown>) =>
    input.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const until = async (pred: (x: Record<string, unknown>) => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = lines.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(lines)}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  return { input, lines, send, until, served };
}

const bearer = (paths: TurnlanePaths) => ({
  authorization: `Bearer ${readToken(paths.tokenPath)}`,
  "content-type": "application/json",
});

describe("ツールの形", () => {
  test("tools/list に ask_user（問い・案 2〜4・図のパス・説明のパス）", () => {
    const t = TOOLS.find((x) => x.name === "ask_user");
    expect(t).toBeDefined();
    const s = t?.inputSchema as {
      required: string[];
      properties: {
        options: { minItems: number; maxItems: number; items: { required: string[] } };
      };
    };
    expect(s.required).toEqual(["question", "options"]);
    expect([s.properties.options.minItems, s.properties.options.maxItems]).toEqual([2, 4]);
    expect(s.properties.options.items.required).toEqual(["label", "description"]);
    expect(Object.keys(s.properties)).toEqual(["question", "context", "options", "explain_path"]);
    expect(t?.description).toContain("--tl-text");
    expect(t?.description).toContain("terminal");
  });

  test("図のファイル: 相対パスは作業ディレクトリから。無い・ディレクトリ・200 KB 超・UTF-8 でないものは理由だけ", () => {
    const dir = tmpHome();
    writeFileSync(join(dir, "a.svg"), "<svg><rect/></svg>");
    writeFileSync(join(dir, "big.html"), "x".repeat(ASK_FILE_MAX + 1));
    writeFileSync(join(dir, "edge.html"), "x".repeat(ASK_FILE_MAX));
    writeFileSync(join(dir, "bin.html"), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    mkdirSync(join(dir, "sub"));
    expect(readFigure("a.svg", dir)).toEqual({ html: "<svg><rect/></svg>" });
    expect(readFigure(join(dir, "missing.html"), "/")).toEqual({ error: "unreadable" });
    expect(readFigure("sub", dir)).toEqual({ error: "unreadable" });
    expect(readFigure("big.html", dir)).toEqual({ error: "too_large" });
    expect("html" in readFigure("edge.html", dir)).toBe(true);
    expect(readFigure("bin.html", dir)).toEqual({ error: "unreadable" });
  });
});

describe("ask → 選ぶ → 返す → 結果（本物のデーモン）", () => {
  test("待っている間もほかの呼び出しに答え、返した答えがツールの結果になる", async () => {
    const paths = await startTestDaemon();
    const dir = join(home, "proj");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.svg"), "<svg><circle r='4'/></svg>");
    writeFileSync(join(dir, "explain.html"), "<h1>why now</h1>");
    const s = pipeServer({ paths, client: "unknown", cwd: dir, pid: null });
    s.send({ id: 1, method: "initialize", params: { clientInfo: { name: "claude-code" } } });
    await s.until((x) => x.id === 1);
    s.send({
      id: 2,
      method: "tools/call",
      params: { name: "ask_user", arguments: args(dir), _meta: { progressToken: "p2" } },
    });
    // 問いがデーモンに開くまで待つ
    let askId = "";
    for (let i = 0; i < 100 && !askId; i++) {
      const q = (await (
        await fetch(`http://127.0.0.1:${paths.port}/api/queue`, { headers: bearer(paths) })
      ).json()) as { items: { followUps: { askUser?: string }[] }[] };
      askId = q.items.flatMap((x) => x.followUps).find((f) => f.askUser)?.askUser ?? "";
      if (!askId) await Bun.sleep(30);
    }
    expect(askId).not.toBe("");
    // 待っている間に ping が返る（1 件ずつの処理で止まらない）
    s.send({ id: 3, method: "ping" });
    expect(await s.until((x) => x.id === 3)).toMatchObject({ result: {} });
    expect(s.lines.some((x) => x.id === 2)).toBe(false);
    // 画面で中身を読む: 図はこのプロセスが読んだもの。読めない図は理由だけ
    const view = (await (
      await fetch(`http://127.0.0.1:${paths.port}/api/asks/${askId}`, { headers: bearer(paths) })
    ).json()) as { options: { figure?: unknown }[]; explain?: unknown };
    expect(view.options[0]?.figure).toEqual({ html: "<svg><circle r='4'/></svg>" });
    expect(view.options[1]?.figure).toEqual({ error: "unreadable" });
    expect(view.explain).toEqual({ html: "<h1>why now</h1>" });
    const a = await fetch(`http://127.0.0.1:${paths.port}/api/asks/${askId}/answer`, {
      method: "POST",
      headers: bearer(paths),
      body: JSON.stringify({ choice: "Top right", note: "keep it simple" }),
    });
    expect(a.status).toBe(200);
    const out = (await s.until((x) => x.id === 2)) as {
      result: { structuredContent: unknown; content: { text: string }[]; isError?: boolean };
    };
    expect(out.result.isError).toBeUndefined();
    expect(out.result.structuredContent).toEqual({ choice: "Top right", note: "keep it simple" });
    expect(JSON.parse(out.result.content[0]?.text ?? "{}")).toEqual({
      choice: "Top right",
      note: "keep it simple",
    });
    s.input.end();
    await s.served;
  });

  test("notifications/cancelled で取り消すと応答は書かず、Turnlane の問いも閉じる", async () => {
    const paths = await startTestDaemon();
    const s = pipeServer({ paths, client: "unknown", cwd: home, pid: null });
    s.send({
      id: "c1",
      method: "tools/call",
      params: {
        name: "ask_user",
        arguments: {
          question: "A or B?",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
      },
    });
    let askId = "";
    for (let i = 0; i < 100 && !askId; i++) {
      const q = (await (
        await fetch(`http://127.0.0.1:${paths.port}/api/queue`, { headers: bearer(paths) })
      ).json()) as { items: { followUps: { askUser?: string }[] }[] };
      askId = q.items.flatMap((x) => x.followUps).find((f) => f.askUser)?.askUser ?? "";
      if (!askId) await Bun.sleep(30);
    }
    s.send({ method: "notifications/cancelled", params: { requestId: "c1", reason: "user" } });
    let state = "open";
    for (let i = 0; i < 100 && state === "open"; i++) {
      state = (
        (await (
          await fetch(`http://127.0.0.1:${paths.port}/api/asks/${askId}`, {
            headers: bearer(paths),
          })
        ).json()) as { state: string }
      ).state;
      if (state === "open") await Bun.sleep(30);
    }
    expect(state).toBe("cancelled");
    s.send({ id: "after", method: "ping" });
    await s.until((x) => x.id === "after");
    expect(s.lines.some((x) => x.id === "c1")).toBe(false);
    s.input.end();
    await s.served;
  });

  test("入力が閉じたら（AI が終わった）待っている問いを取り消してから終える", async () => {
    const paths = await startTestDaemon();
    const s = pipeServer({ paths, client: "unknown", cwd: home, pid: null });
    s.send({
      id: 9,
      method: "tools/call",
      params: {
        name: "ask_user",
        arguments: {
          question: "A or B?",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
      },
    });
    await Bun.sleep(300);
    s.input.end();
    await s.served;
    const q = (await (
      await fetch(`http://127.0.0.1:${paths.port}/api/queue`, { headers: bearer(paths) })
    ).json()) as { items: unknown[] };
    expect(q.items).toEqual([]);
  });
});

describe("偽のデーモン（再起動・進捗・届かない）", () => {
  function fake(handler: (req: Request) => Response | Promise<Response>) {
    const h = tmpHome();
    const paths = resolvePaths({ HOME: h }, h);
    mkdirSync(join(paths.tokenPath, ".."), { recursive: true });
    writeFileSync(paths.tokenPath, "a".repeat(64));
    const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    servers.push(srv);
    return { ...paths, port: srv.port as number };
  }
  const simple = {
    question: "A or B?",
    options: [
      { label: "A", description: "a" },
      { label: "B", description: "b" },
    ],
  };
  const call = (p: (m: string) => void = () => {}) => ({
    signal: new AbortController().signal,
    progress: p,
  });

  test("デーモンが再起動して問いが消えた（404）→ 端末で聞き直すように言うエラー", async () => {
    const paths = fake((req) =>
      req.method === "POST"
        ? Response.json({ id: "x", workItemId: null, ownCard: true }, { status: 201 })
        : Response.json({ error: "ask_not_found" }, { status: 404 }),
    );
    await expect(
      runAskUser(simple, { paths, client: "c", cwd: "/", pid: null }, call()),
    ).rejects.toThrow(/restarted.*terminal/);
  });

  test("待っている間は進捗を送る。dismissed は { dismissed: true }", async () => {
    let polls = 0;
    const paths = fake(async (req) => {
      if (req.method === "POST")
        return Response.json({ id: "x", workItemId: null, ownCard: true }, { status: 201 });
      polls++;
      await Bun.sleep(20);
      return Response.json(polls < 4 ? { state: "open" } : { state: "dismissed" });
    });
    const progress: string[] = [];
    const r = await runAskUser(
      simple,
      { paths, client: "c", cwd: "/", pid: null },
      call((m) => progress.push(m)),
      { progressMs: 10 },
    );
    expect(r).toEqual({ dismissed: true });
    expect(progress.length).toBeGreaterThan(0);
  });

  test("上限を超えた問いはデーモンの項目の名前でエラー（書き直せるように上限も言う）", async () => {
    const paths = fake(() =>
      Response.json({ error: "invalid_input", field: "question" }, { status: 400 }),
    );
    await expect(
      runAskUser(simple, { paths, client: "c", cwd: "/", pid: null }, call()),
    ).rejects.toThrow(/invalid_input: question \(question <= 120/);
  });

  test("デーモンに届かない（止まっている）→ 端末で聞き直すように言うエラー", async () => {
    const h = tmpHome();
    const paths = { ...resolvePaths({ HOME: h }, h), port: 1 };
    mkdirSync(join(paths.tokenPath, ".."), { recursive: true });
    writeFileSync(paths.tokenPath, "a".repeat(64));
    await expect(
      runAskUser(simple, { paths, client: "c", cwd: "/", pid: null }, call()),
    ).rejects.toThrow(/not running.*terminal/);
  });

  test("待っている途中で届かなくなり、戻らなければ再接続の上限でエラー", async () => {
    // 問いを開いた直後にデーモンが止まる
    const paths = fake((req) => {
      if (req.method === "POST") {
        setTimeout(() => servers[0]?.stop(true), 0);
        return Response.json({ id: "x", workItemId: null, ownCard: true }, { status: 201 });
      }
      return Response.json({ state: "open" });
    });
    let now = 0;
    await expect(
      runAskUser(simple, { paths, client: "c", cwd: "/", pid: null }, call(), {
        retryMs: 1,
        reconnectMs: 50,
        now: () => (now += 10),
      }),
    ).rejects.toThrow(/not reachable/);
  });
});
