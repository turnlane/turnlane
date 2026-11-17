/**
 * turnlane hook --tool claude_code --answer（ADR 0023）: すぐ終わる条件、Claude Code に出す形、取り下げ、親が居なくなった・
 * シグナル。前半は偽のデーモン（fetch の差し替え）、後半は本物のプロセスと手元の偽のデーモン（Bun.serve）
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookWaitOpenResponse, HookWaitResult } from "@turnlane/core/api";
import { type AnswerHookDeps, answerHook, decisionFor } from "../src/hook/answer.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const ASK_INPUT = {
  questions: [
    {
      question: "Pick a color",
      header: "Color",
      multiSelect: false,
      options: [{ label: "Red" }, { label: "Blue" }],
    },
    {
      question: "Pick toppings",
      header: "Toppings",
      multiSelect: true,
      options: [{ label: "Cheese" }, { label: "Ham" }, { label: "Olive" }],
    },
  ],
};
const permissionInput = (tool = "Bash", extra: Record<string, unknown> = {}) => ({
  hook_event_name: "PermissionRequest",
  session_id: SID,
  transcript_path: "/x/y.jsonl",
  cwd: "/w",
  permission_mode: "default",
  tool_name: tool,
  tool_input:
    tool === "AskUserQuestion" ? ASK_INPUT : { command: "SENTINEL_CMD_7f1a", description: "d" },
  ...extra,
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** 偽のデーモン: 開く応答と、結果の応答の列 */
function fakeDeps(o: {
  open?: HookWaitOpenResponse | "down" | 500;
  results?: (HookWaitResult | 404 | "error")[];
  env?: Record<string, string | undefined>;
  token?: string | null;
  parent?: () => boolean;
}) {
  const calls: Call[] = [];
  const results = [...(o.results ?? [])];
  let signal: (() => void) | null = null;
  let t = 0;
  const deps: AnswerHookDeps = {
    env: { HOME: "/home/x", TURNLANE_DATA_DIR: "/data", ...(o.env ?? {}) },
    ppid: 4242,
    fetch: async (url, init) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (url.endsWith("/api/hook-waits")) {
        if (o.open === "down") throw new Error("ECONNREFUSED");
        if (o.open === 500) return new Response("{}", { status: 500 });
        return Response.json(o.open ?? { wait: true, id: "w-1" });
      }
      if (url.includes("/cancel")) return Response.json({ state: "cancelled" });
      const r = results.shift() ?? { state: "open" };
      if (r === "error") throw new Error("ECONNRESET");
      if (r === 404) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json(r);
    },
    readFile: (p) => {
      if (o.token === null) throw new Error("ENOENT");
      expect(p).toBe("/data/token");
      return `${o.token ?? "tok"}\n`;
    },
    parentAlive: o.parent ?? (() => true),
    sleep: async () => {
      t += 1_000;
    },
    now: () => t,
    onSignal: (f) => {
      signal = f;
    },
  };
  return { deps, calls, fire: () => signal?.() };
}

describe("すぐ終わる（何も出さない）", () => {
  test.each([
    ["PermissionRequest でない", { hook_event_name: "Stop", session_id: SID }, {}],
    [
      "委任の子（T3CODE_THREAD_ID）",
      permissionInput(),
      { env: { T3CODE_THREAD_ID: "thread:delegated-task:x" } },
    ],
    [
      "プログラム経由（CLAUDE_CODE_ENTRYPOINT が sdk-*）",
      permissionInput(),
      { env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" } },
    ],
    ["デーモンに届かない", permissionInput(), { open: "down" as const }],
    ["デーモンがエラー", permissionInput(), { open: 500 as const }],
    ["トークンが無い", permissionInput(), { token: null }],
    [
      "待たない（設定がオフ）",
      permissionInput(),
      { open: { wait: false, reason: "off" } as const },
    ],
    [
      "待たない（プログラム経由）",
      permissionInput(),
      { open: { wait: false, reason: "program" } as const },
    ],
    ["session_id が無い", { ...permissionInput(), session_id: undefined }, {}],
  ] as const)("%s", async (_n, input, o) => {
    const f = fakeDeps(o);
    expect(await answerHook(input, f.deps)).toBeNull();
    // 結果を待ちに行かない
    expect(f.calls.filter((c) => c.url.includes("/result"))).toEqual([]);
  });

  test("デーモンに送るのは識別子・ツールの名前・モード・entrypoint だけ（ツールの入力は送らない）", async () => {
    const f = fakeDeps({
      results: [{ state: "withdrawn" }],
      env: { CLAUDE_CODE_ENTRYPOINT: "cli" },
    });
    await answerHook(permissionInput("Bash", { agent_id: "abc123" }), f.deps);
    expect(f.calls[0]).toEqual({
      url: "http://127.0.0.1:7317/api/hook-waits",
      method: "POST",
      body: {
        session: SID,
        tool: "Bash",
        agentId: "abc123",
        permissionMode: "default",
        entrypoint: "cli",
      },
    });
    expect(JSON.stringify(f.calls)).not.toContain("SENTINEL_CMD_7f1a");
  });

  test("TURNLANE_PORT で届け先を変える", async () => {
    const f = fakeDeps({ results: [{ state: "withdrawn" }], env: { TURNLANE_PORT: "7400" } });
    await answerHook(permissionInput(), f.deps);
    expect(f.calls[0]?.url).toBe("http://127.0.0.1:7400/api/hook-waits");
  });
});

describe("Claude Code に出す形", () => {
  test("許可: この 1 回だけ allow（updatedInput も今後の許可も付けない）", async () => {
    const f = fakeDeps({ results: [{ state: "open" }, { state: "allow" }] });
    const out = await answerHook(permissionInput(), f.deps);
    expect(JSON.parse(out ?? "")).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
  });

  test("AskUserQuestion: 問いの文 → 選んだ名前（複数選択はカンマと空白でつなぐ）。updatedInput は元の questions に answers を足したもの", async () => {
    const f = fakeDeps({
      results: [{ state: "answer", count: 2, answers: [{ options: [1] }, { options: [0, 2] }] }],
    });
    const out = JSON.parse((await answerHook(permissionInput("AskUserQuestion"), f.deps)) ?? "");
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: {
            ...ASK_INPUT,
            answers: { "Pick a color": "Blue", "Pick toppings": "Cheese, Olive" },
          },
        },
      },
    });
  });

  test("AskUserQuestion: 自由な文はそのまま", () => {
    const out = decisionFor(permissionInput("AskUserQuestion"), {
      state: "answer",
      count: 2,
      answers: [{ text: "Purple" }, { options: [1] }],
    });
    expect(JSON.parse(out ?? "").hookSpecificOutput.decision.updatedInput.answers).toEqual({
      "Pick a color": "Purple",
      "Pick toppings": "Ham",
    });
  });

  test.each([
    ["allow を AskUserQuestion に出さない", "AskUserQuestion", { state: "allow" }],
    ["答えを許可に出さない", "Bash", { state: "answer", count: 1, answers: [{ options: [0] }] }],
    [
      "問いの数が違う",
      "AskUserQuestion",
      { state: "answer", count: 1, answers: [{ options: [0] }] },
    ],
    [
      "範囲外の番号",
      "AskUserQuestion",
      { state: "answer", count: 2, answers: [{ options: [5] }, { options: [0] }] },
    ],
    [
      "単一選択に 2 つ",
      "AskUserQuestion",
      { state: "answer", count: 2, answers: [{ options: [0, 1] }, { options: [0] }] },
    ],
    ["withdrawn", "Bash", { state: "withdrawn" }],
  ] as const)("出さない: %s", (_n, tool, r) => {
    expect(decisionFor(permissionInput(tool), r as HookWaitResult)).toBeNull();
  });
});

describe("待つ間の終わり方", () => {
  test("取り下げ（withdrawn）・知らない待ち（404）は何も出さずに終わる", async () => {
    for (const r of [{ state: "withdrawn" } as const, 404 as const]) {
      const f = fakeDeps({ results: [{ state: "open" }, r] });
      expect(await answerHook(permissionInput(), f.deps)).toBeNull();
      expect(f.calls.some((c) => c.url.includes("/cancel"))).toBe(false);
    }
  });

  test("デーモンに 60 秒届かなければ終わる（偽の時計）。その間は聞き直す", async () => {
    const f = fakeDeps({ results: Array.from({ length: 100 }, () => "error" as const) });
    expect(await answerHook(permissionInput(), f.deps)).toBeNull();
    const polls = f.calls.filter((c) => c.url.includes("/result")).length;
    expect(polls).toBeGreaterThan(50);
    expect(polls).toBeLessThan(70);
  });

  test("親（Claude Code）が居なくなったら取り消して何も出さずに終わる", async () => {
    let alive = 3;
    const f = fakeDeps({
      results: Array.from({ length: 10 }, () => ({ state: "open" }) as const),
      parent: () => alive-- > 0,
    });
    expect(await answerHook(permissionInput(), f.deps)).toBeNull();
    expect(f.calls.at(-1)?.url).toBe("http://127.0.0.1:7317/api/hook-waits/w-1/cancel");
  });

  test("シグナルを受けたら取り消して何も出さずに終わる（答えが来ていても出さない）", async () => {
    const f = fakeDeps({ results: [{ state: "open" }, { state: "allow" }] });
    const origFetch = f.deps.fetch;
    let n = 0;
    f.deps.fetch = async (url, init) => {
      if (url.includes("/result") && ++n === 1) f.fire();
      return origFetch(url, init);
    };
    expect(await answerHook(permissionInput(), f.deps)).toBeNull();
    expect(f.calls.some((c) => c.url.endsWith("/w-1/cancel"))).toBe(true);
  });
});

describe("本物のプロセス（main.ts hook --tool claude_code --answer）", () => {
  const MAIN = join(import.meta.dir, "../src/main.ts");
  let dir = "";
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(() => {
    server?.stop(true);
    server = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  /** 偽のデーモン（手元の空いたポート）。結果は答えを出すか、ずっと open */
  function daemon(result: HookWaitResult | "hold") {
    dir = mkdtempSync(join(tmpdir(), "hook-answer-"));
    writeFileSync(join(dir, "token"), "tok\n");
    const seen: string[] = [];
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        seen.push(`${req.method} ${u.pathname}`);
        if (req.headers.get("authorization") !== "Bearer tok")
          return Response.json({}, { status: 401 });
        if (u.pathname === "/api/hook-waits") return Response.json({ wait: true, id: "w-9" });
        if (u.pathname.endsWith("/cancel")) return Response.json({ state: "cancelled" });
        if (result === "hold") {
          await Bun.sleep(300);
          return Response.json({ state: "open" });
        }
        return Response.json(result);
      },
    });
    return { seen, env: { TURNLANE_DATA_DIR: dir, TURNLANE_PORT: String(server.port) } };
  }

  const spawn = (env: Record<string, string>, input: unknown) => {
    const p = Bun.spawn([process.execPath, MAIN, "hook", "--tool", "claude_code", "--answer"], {
      env: { PATH: process.env.PATH ?? "", HOME: dir || "/nonexistent", ...env },
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    return p;
  };

  test("デーモンに届かなければすぐ終わる（何も出さない。exit 0）", async () => {
    dir = mkdtempSync(join(tmpdir(), "hook-answer-"));
    writeFileSync(join(dir, "token"), "tok\n");
    const t0 = performance.now();
    // 誰も聞いていないポート
    const p = spawn({ TURNLANE_DATA_DIR: dir, TURNLANE_PORT: "9" }, permissionInput());
    expect(await p.exited).toBe(0);
    expect(await new Response(p.stdout).text()).toBe("");
    expect(performance.now() - t0).toBeLessThan(3_000);
  });

  test("答えが来たら allow を出して終わる。spool には書かない", async () => {
    const d = daemon({ state: "allow" });
    const p = spawn(d.env, permissionInput());
    expect(await p.exited).toBe(0);
    expect(JSON.parse(await new Response(p.stdout).text())).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
    expect(d.seen).toEqual(["POST /api/hook-waits", "GET /api/hook-waits/w-9/result"]);
    expect(await Bun.file(join(dir, "spool")).exists()).toBe(false);
  });

  test("SIGTERM（人が端末で拒否した・Claude Code が終わった）で取り消して終わる", async () => {
    const d = daemon("hold");
    const p = spawn(d.env, permissionInput());
    for (let i = 0; i < 50 && !d.seen.some((s) => s.includes("/result")); i++) await Bun.sleep(50);
    p.kill("SIGTERM");
    expect(await p.exited).toBe(0);
    expect(await new Response(p.stdout).text()).toBe("");
    expect(d.seen).toContain("POST /api/hook-waits/w-9/cancel");
  });

  test("親が居なくなったら（SIGKILL で消えた）自分で気づいて終わる。孤児を残さない", async () => {
    const d = daemon("hold");
    // 親の役のプロセス: hook を子として起こし、その pid を出して待つ
    const parentScript = join(dir, "parent.ts");
    writeFileSync(
      parentScript,
      `const c = Bun.spawn([process.execPath, ${JSON.stringify(MAIN)}, "hook", "--tool", "claude_code", "--answer"], { stdin: new Blob([${JSON.stringify(JSON.stringify(permissionInput()))}]), stdout: "ignore", stderr: "ignore" });
console.log(c.pid);
await Bun.sleep(60_000);
`,
    );
    const parent = Bun.spawn([process.execPath, parentScript], {
      env: { PATH: process.env.PATH ?? "", HOME: dir, ...d.env },
      stdout: "pipe",
    });
    const reader = parent.stdout.getReader();
    const { value } = await reader.read();
    const child = Number(new TextDecoder().decode(value).trim());
    expect(child).toBeGreaterThan(1);
    for (let i = 0; i < 50 && !d.seen.some((s) => s.includes("/result")); i++) await Bun.sleep(50);
    parent.kill("SIGKILL");
    await parent.exited;
    let gone = false;
    for (let i = 0; i < 60 && !gone; i++) {
      await Bun.sleep(100);
      try {
        process.kill(child, 0);
      } catch {
        gone = true;
      }
    }
    expect(gone).toBe(true);
    expect(d.seen).toContain("POST /api/hook-waits/w-9/cancel");
  });
});
