/**
 * 伸び続ける大きな transcript（合成。本文はダミー）: 追記の取り込みがファイルの大きさに比例しないこと、変わっていない
 * ファイルは読まないこと、1 ファイルの処理が遅いときに ingest.slow（取り込み元の種類・大きさ・時間だけ）を残すこと。
 * 実機の 300 MB は CI では重いので、大小 2 つのファイルの比で見る（TURNLANE_LARGE_MB で大きくできる）
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, type TestEnv } from "./helpers/env.ts";

let env: TestEnv;
afterEach(async () => {
  await env?.cleanup();
});

const PAD = "x".repeat(1700);
const T0 = Date.UTC(2026, 9, 30, 0, 0);

/** 1 行 2 KB 程度の合成の行（40 行ごとに人の指示） */
function line(sid: string, i: number): string {
  const at = new Date(T0 + i * 10).toISOString();
  const common = `"timestamp":"${at}","sessionId":"${sid}","uuid":"u${i}","isSidechain":false,"cwd":"/w/app","gitBranch":"main","version":"2.1.300","entrypoint":"cli"`;
  const k = i % 40;
  if (k === 0)
    return `{"type":"user",${common},"promptId":"p${i}","origin":{"kind":"human"},"promptSource":"typed","message":{"role":"user","content":"(prompt)"}}\n`;
  if (k % 2 === 1)
    return `{"type":"assistant",${common},"message":{"id":"m${i}","model":"claude-x","stop_reason":"tool_use","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"tool_use","id":"t${i}","name":"Read","input":{"p":"${PAD}"}}]}}\n`;
  return `{"type":"user",${common},"promptId":"p${i - k}","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t${i - 1}","content":"${PAD}"}]}}\n`;
}

function write(path: string, sid: string, bytes: number): number {
  const fd = openSync(path, "w");
  let n = 0;
  let size = 0;
  let chunk = "";
  while (size < bytes) {
    const l = line(sid, n++);
    chunk += l;
    size += l.length;
    if (chunk.length > 1 << 22) {
      writeSync(fd, chunk);
      chunk = "";
    }
  }
  writeSync(fd, chunk);
  closeSync(fd);
  return n;
}

const MB = 1024 * 1024;

describe("大きな transcript の追記（ingest.slow）", () => {
  test("追記 4 KB の取り込みはファイルの大きさに比例しない。変わっていなければ読まない", async () => {
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    const push = (event: string, fields?: unknown) =>
      logs.push({ event, fields: (fields ?? {}) as Record<string, unknown> });
    env = makeEnv({ logger: { debug: push, info: push, warn: push, error: push } });
    const dir = join(env.home, ".claude/projects/-w-app");
    mkdirSync(join(dir, "big", "subagents"), { recursive: true });
    const big = join(dir, "00000000-0000-4000-8000-0000000000b1.jsonl");
    const small = join(dir, "00000000-0000-4000-8000-0000000000s1.jsonl");
    const largeMb = Number(process.env.TURNLANE_LARGE_MB ?? 24);
    const nBig = write(big, "00000000-0000-4000-8000-0000000000b1", largeMb * MB);
    const nSmall = write(small, "00000000-0000-4000-8000-0000000000s1", MB / 4);
    await env.supervisor.start();
    await env.supervisor.whenIdle();

    // 変わっていない: 列挙して比べるだけ（読まない）
    const cursorAt = () =>
      env.sqlite
        .query<{ k: string; u: number }, []>(
          "SELECT stream_key AS k, updated_at AS u FROM ingest_cursor ORDER BY stream_key",
        )
        .all();
    const before = cursorAt();
    expect(await env.supervisor.scanAll()).toBe(0);
    await env.supervisor.whenIdle();
    expect(cursorAt()).toEqual(before);

    // 追記 4 KB ずつ（大きいファイルと小さいファイル）を何度か測り、速いほうで比べる
    const time = async (path: string, sid: string, from: number) => {
      let best = Number.POSITIVE_INFINITY;
      for (let r = 0; r < 3; r++) {
        appendFileSync(path, line(sid, from + r * 2) + line(sid, from + r * 2 + 1));
        const a = performance.now();
        expect(await env.supervisor.scanAll()).toBe(1);
        await env.supervisor.whenIdle();
        best = Math.min(best, performance.now() - a);
      }
      return best;
    };
    const bigMs = await time(big, "00000000-0000-4000-8000-0000000000b1", nBig);
    const smallMs = await time(small, "00000000-0000-4000-8000-0000000000s1", nSmall);
    // 大きさが 100 倍でも、追記の処理はほぼ同じ（全体を読み直していれば数百 ms になる）
    expect(bigMs).toBeLessThan(Math.max(50, smallMs * 3));
    const cur = env.sqlite
      .query<{ o: number; s: number }, [string]>(
        "SELECT byte_offset AS o, size AS s FROM ingest_cursor WHERE stream_key LIKE ?",
      )
      .get("%0000000000b1.jsonl");
    expect(cur?.o).toBe(cur?.s);
    expect(logs.filter((l) => l.event === "ingest.slow")).toEqual([]);
  }, 120_000);

  test("1 ファイルの処理が閾値を超えたら ingest.slow を 1 行（パス・キーは出さない）", async () => {
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    const push = (event: string, fields?: unknown) =>
      logs.push({ event, fields: (fields ?? {}) as Record<string, unknown> });
    env = makeEnv({ logger: { debug: push, info: push, warn: push, error: push }, slowMs: 0 });
    const dir = join(env.home, ".claude/projects/-w-app");
    mkdirSync(dir, { recursive: true });
    write(
      join(dir, "00000000-0000-4000-8000-0000000000c1.jsonl"),
      "00000000-0000-4000-8000-0000000000c1",
      64 * 1024,
    );
    await env.supervisor.start();
    await env.supervisor.whenIdle();
    const slow = logs.filter((l) => l.event === "ingest.slow");
    expect(slow.length).toBeGreaterThan(0);
    const f = slow[0]?.fields ?? {};
    expect(f).toMatchObject({ tool: "claude_code", from_start: true });
    expect(Object.keys(f).sort()).toEqual(
      ["apply_ms", "bytes", "events", "from_start", "ms", "read_ms", "size", "tool"].sort(),
    );
    expect(JSON.stringify(slow)).not.toContain(env.home);
    expect(JSON.stringify(slow)).not.toContain("0000000000c1");
  });
});
