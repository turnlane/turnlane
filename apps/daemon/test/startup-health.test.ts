/**
 * 起動時の読み直しの間も health が速く返る（取り込み・判定がイベントループを塞がない）。
 * パーサの版が上がった直後（カーソルの parser_version が古い）に起動すると、全ストリームを先頭から読み直し、そのたびに
 * 判定が走る。デーモンを別のプロセスで起動し、読み直しが終わるまで health を叩いて、遅れた応答が無いことを確かめる。
 * 共有の CI runner では、塞いでいなくても揺れで 1〜2 件だけ遅い応答が出ることがある。塞ぐバグなら遅い応答が何十件も
 * 続くので、上限を超える応答は MAX_SLOW 件まで許し、そのかわりどの応答も HARD_LIMIT_MS を超えないことを求める
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinAdapters, nullLogger } from "@turnlane/collectors";
import { resolvePaths } from "@turnlane/core";
import { startDaemon } from "../src/main.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const FILES = 24;
const TURNS_PER_FILE = 300;
/** health の応答の上限（ms） */
const LIMIT_MS = 100;
/** LIMIT_MS を超えてよい応答の件数（共有 runner の揺れの分） */
const MAX_SLOW = 2;
/** どの応答も超えてはならない上限（ms） */
const HARD_LIMIT_MS = 1000;

let home: string;
let child: ReturnType<typeof Bun.spawn> | null = null;

afterEach(async () => {
  child?.kill("SIGTERM");
  await child?.exited;
  child = null;
  rmSync(home, { recursive: true, force: true });
});

/** 合成のトランスクリプト（本文は合成値）を FILES 個。cwd は存在しないパス（git を呼ばない） */
function writeTranscripts(root: string): void {
  let at = Date.now() - 3 * 86_400_000;
  const w = claudeTranscript(root, {
    sid: "s-0",
    cwd: "/nonexistent/turnlane-test/r0",
    branch: "b0",
  });
  for (let i = 0; i < TURNS_PER_FILE; i++) {
    at += 1000;
    w.human(at);
    const id = w.toolUse(at + 100, "Bash", { command: "echo" });
    w.toolResult(at + 200, id);
    w.assistantEnd(at + 500, "done", { edits: 1 });
  }
  const text = readFileSync(w.path, "utf8");
  for (let f = 1; f < FILES; f++) {
    writeFileSync(
      w.path.replace("s-0.jsonl", `s-${f}.jsonl`),
      text
        .replaceAll('"s-0"', `"s-${f}"`)
        .replaceAll('"u-', `"u${f}-`)
        .replaceAll('"p-', `"p${f}-`)
        .replaceAll('"m-', `"m${f}-`)
        .replaceAll('"tu-', `"tu${f}-`),
    );
  }
}

describe("起動時の読み直し（パーサの版が上がった後）", () => {
  test(`読み直しの間も health が ${LIMIT_MS} ms 以内に返る`, async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-startup-"));
    writeTranscripts(join(home, ".claude"));
    const paths = resolvePaths({ HOME: home }, home);
    const opts = {
      paths,
      logger: nullLogger,
      port: 0,
      onboarding: { assumeDone: true },
      ingest: { noWatch: true },
      calendar: false as const,
      summary: false as const,
    };
    // 1 回目: 全部を取り込む
    const first = await startDaemon(opts);
    while (!first.supervisor?.backfillDone) await Bun.sleep(20);
    await first.stop();
    const version = builtinAdapters.find((a) => a.tool === "claude_code")?.parserVersion ?? 0;
    const db = new Database(paths.dbPath);
    const stale = () =>
      db
        .query<{ n: number }, [number]>(
          "SELECT count(*) AS n FROM ingest_cursor c JOIN ai_source s ON s.id = c.source_id WHERE s.tool = 'claude_code' AND c.parser_version < ?",
        )
        .get(version)?.n ?? 0;
    const turns = db.query<{ n: number }, []>("SELECT count(*) AS n FROM ai_turn").get()?.n;
    expect(turns).toBe(FILES * TURNS_PER_FILE);
    // パーサの版が上がった状態にする（次の起動で全ストリームを読み直す）
    db.run(
      "UPDATE ingest_cursor SET parser_version = ? WHERE source_id IN (SELECT id FROM ai_source WHERE tool = 'claude_code')",
      [version - 1],
    );
    expect(stale()).toBe(FILES);

    // 2 回目: 別のプロセスで起動し、読み直しが終わって判定が落ち着くまで health を叩く
    child = Bun.spawn(["bun", join(import.meta.dir, "helpers/serve-daemon.ts"), home], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    let buf = "";
    while (!buf.includes("\n")) {
      const r = await reader.read();
      if (r.done) break;
      buf += new TextDecoder().decode(r.value);
    }
    const { url, token } = JSON.parse(buf.split("\n")[0] as string) as {
      url: string;
      token: string;
    };
    const lat: number[] = [];
    const deadline = Date.now() + 30_000;
    let settledAt: number | null = null;
    while (Date.now() < deadline) {
      const t = performance.now();
      const r = await fetch(`${url}/api/health`, { headers: { authorization: `Bearer ${token}` } });
      lat.push(performance.now() - t);
      expect(r.status).toBe(200);
      // 読み直しが済んでから、もう 1.5 秒（最後の判定の分）
      if (settledAt === null && stale() === 0) settledAt = Date.now();
      if (settledAt !== null && Date.now() - settledAt > 1500) break;
      await Bun.sleep(5);
    }
    db.close();
    expect(settledAt).not.toBeNull();
    // 最初の 1 回は接続の確立を含むので除く
    const slow = lat.slice(1).filter((ms) => ms > LIMIT_MS);
    const ok = slow.length <= MAX_SLOW && slow.every((ms) => ms <= HARD_LIMIT_MS);
    // 落ちたときは期待を slow: [] にして、遅かった応答の値の一覧と総数が差分に出るようにする
    const report = { samples: lat.length, slow: slow.map(Math.round) };
    expect(report).toEqual({ samples: lat.length, slow: ok ? report.slow : [] });
  }, 60_000);
});
