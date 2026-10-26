/**
 * 番兵（プライバシー）テスト（phase0-plan 5.3、M1-12、ADR 0005）。
 * フィクスチャの本文系フィールドに番兵を埋めた版を、hooks の spool も含めて全アダプタで取り込み、判定まで動かした後に
 * (1) SQLite ファイル（-wal を含む）のバイト列、(2) デーモンのログ、(3) `turnlane export --json` の出力、のどれにも
 * 番兵が含まれないことを確かめる。
 * 表示の瞬間に読む中身（glance。D-207、ADR 0005 の追記 2）は、わざと番兵を HTTP の応答に出す。その後でも
 * (1)〜(3)、spool、SSE で流れたもの、MCP の各ツールの出力、日報の Markdown に番兵が無いことを確かめる。
 *
 * 限定した保存（ADR 0018、D-218）: 設定「待ちの中身を保存する」がオフなら上のとおり。オン（既定）なら、番兵が出てよいのは
 * 決めた列（自分の指示の 1 行目・待ちの中身・確定した日報）と、それを書き出すもの（エクスポートの同じ表、MCP の日報）だけ。
 * ログ・SSE・spool・AI 要約の子プロセスの stdin（Mac の外に出るもの）には出ない。AI の発言の本文は保存しない
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMessage, TOOLS } from "../apps/cli/src/commands/mcp.ts";
import { extract, toLine } from "../apps/cli/src/hook/run.ts";
import { FakeGit } from "../apps/daemon/src/ingest/git.ts";
import { FileLogger } from "../apps/daemon/src/log.ts";
import { type RunningDaemon, startDaemon } from "../apps/daemon/src/main.ts";
import { claudeTranscript } from "../apps/daemon/test/helpers/transcript.ts";
import { SENTINEL_PREFIX, sentinelizeTree } from "../packages/collectors/src/testing/index.ts";
import { exportJsonl, openDatabase, putSetting, resolvePaths } from "../packages/core/src/index.ts";

const FIXTURES = join(import.meta.dir, "../packages/collectors/test/fixtures");

let home: string;
let daemon: RunningDaemon | null = null;
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  rmSync(home, { recursive: true, force: true });
});

function bytesContain(path: string, needle: string): boolean {
  if (!existsSync(path)) return false;
  const buf = readFileSync(path);
  return buf.includes(Buffer.from(needle)) || buf.includes(Buffer.from(needle, "utf16le"));
}

/** 番兵が出てよい列（ADR 0018 の限定した保存）。確定した日報はその日の指示・待ちの中身を含みうる */
const STORED_COLUMNS = new Set([
  "ai_instruction.text",
  "wait_detail.text",
  "wait_detail.label",
  "wait_detail.command",
  "wait_detail.options_json",
  "daily_note.report_md",
]);
const STORED_TABLES = new Set(["ai_instruction", "wait_detail", "daily_note"]);

/** DB の TEXT の列のうち、needle を含む値のある列（表.列） */
function columnsContaining(dbPath: string, needle: string): Set<string> {
  const db = openDatabase(dbPath, { readonly: true });
  try {
    const out = new Set<string>();
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((r) => r.name);
    for (const t of tables) {
      for (const c of db.query<{ name: string }, []>(`PRAGMA table_info(${t})`).all()) {
        const n =
          db
            .query<{ n: number }, [string]>(
              `SELECT count(*) AS n FROM "${t}" WHERE CAST("${c.name}" AS TEXT) LIKE ?`,
            )
            .get(`%${needle}%`)?.n ?? 0;
        if (n > 0) out.add(`${t}.${c.name}`);
      }
    }
    return out;
  } finally {
    db.close();
  }
}

describe("番兵テスト（5.3）", () => {
  test("本文系フィールドの番兵が DB（WAL を含む）・ログ・エクスポートに出ない（待ちの中身を保存しない設定）", async () => {
    await sentinelRun(false);
  });
  test("待ちの中身を保存する（既定。ADR 0018）: 番兵は決めた列だけに入り、ログ・SSE・spool・AI 要約には出ない", async () => {
    await sentinelRun(true);
  });
});

async function sentinelRun(store: boolean) {
  {
    home = mkdtempSync(join(tmpdir(), "turnlane-sentinel-"));
    const sentinel = `${SENTINEL_PREFIX}${crypto.randomUUID()}`;
    // Claude（全ケース）と Codex（全ケース）を一時 HOME に置き、本文系に番兵を入れる
    for (const c of readdirSync(join(FIXTURES, "claude_code/2.1.x"))) {
      cpSync(join(FIXTURES, "claude_code/2.1.x", c, "projects"), join(home, ".claude/projects"), {
        recursive: true,
      });
    }
    for (const c of readdirSync(join(FIXTURES, "codex/0.147.x"))) {
      cpSync(join(FIXTURES, "codex/0.147.x", c), join(home, ".codex"), { recursive: true });
    }
    const injected =
      sentinelizeTree(join(home, ".claude"), sentinel) +
      sentinelizeTree(join(home, ".codex"), sentinel);
    expect(injected).toBeGreaterThan(50);
    // hooks: turnlane hook の抽出を通した行（本文は hook 側で捨てる）
    const paths = resolvePaths({ HOME: home }, home);
    mkdirSync(paths.spoolDir, { recursive: true });
    const hookInput = {
      hook_event_name: "Stop",
      session_id: "s1",
      cwd: "/fixture/repo-a",
      prompt: sentinel,
      last_assistant_message: sentinel,
      tool_input: { command: sentinel },
      message: sentinel,
    };
    const rec = extract(hookInput, "claude_code", Date.UTC(2026, 8, 2), join(home, ".claude"));
    writeFileSync(
      join(paths.spoolDir, "hooks-20260902.jsonl"),
      toLine(rec as Record<string, unknown>),
    );
    // 今まさに待っている件（glance が読む）: 本文・コマンド・説明・問い・選択肢に番兵（D-207）。でたらめな文字列は
    // 伏せ字になるので、glance の番兵は語だけにする（接頭辞は同じなので、漏れは SENTINEL_PREFIX の検査で見つかる）
    const mark = `${SENTINEL_PREFIX}glance`;
    const now = Date.now();
    const live = (sid: string, branch: string) =>
      claudeTranscript(join(home, ".claude"), { sid, cwd: "/fixture/repo-a", branch });
    const p = live("77777777-0000-4000-8000-000000000001", "fix/glance-permission");
    p.human(now - 10 * 60_000, { text: `${mark} fix the refresh flow` });
    p.toolUse(now - 5 * 60_000, "Bash", {
      command: `git push origin ${mark}`,
      description: `${mark} push`,
    });
    const hookLine = (sid: string, name: string, at: number, extra: Record<string, unknown> = {}) =>
      toLine(
        extract(
          { hook_event_name: name, session_id: sid, cwd: "/fixture/repo-a", ...extra },
          "claude_code",
          at,
          join(home, ".claude"),
        ) as Record<string, unknown>,
      );
    writeFileSync(
      join(
        paths.spoolDir,
        `hooks-${new Date(now).toISOString().slice(0, 10).replaceAll("-", "")}.jsonl`,
      ),
      hookLine("77777777-0000-4000-8000-000000000001", "PermissionRequest", now - 5 * 60_000, {
        tool_name: "Bash",
        tool_input: { command: mark },
      }),
      { flag: "a" },
    );
    const q = live("77777777-0000-4000-8000-000000000002", "fix/glance-question");
    q.human(now - 40 * 60_000, { text: `${mark} tidy the deploy steps` });
    q.ask(now - 30 * 60_000, [{ question: `${mark} where?`, options: [`${mark} a`, "b"] }]);

    const logger = new FileLogger({ path: paths.logPath, minLevel: "debug" });
    const git = new FakeGit();
    for (const r of ["/fixture/repo-a", "/fixture/repo-b", "/fixture/repo-c", "/fixture/repo-d"])
      git.repos.set(r, r);
    // 日報の AI 要約（M4-6）: 偽の claude が stdin を書き出す。日報以外（会話本文）が入らないことを確かめる
    const fakeBin = join(home, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });
    const captured = join(home, "summary-stdin.txt");
    writeFileSync(
      join(fakeBin, "claude"),
      `#!/bin/bash\nfor a in "$@"; do [ "$a" = "--help" ] && exit 0; done\ncat > '${captured}'\necho 'A day.'\n`,
    );
    chmodSync(join(fakeBin, "claude"), 0o755);
    daemon = await startDaemon({
      paths,
      logger,
      port: 0,
      ingest: { git, noWatch: true },
      summary: { detect: { shell: null, knownDirs: [fakeBin] } },
    });
    putSetting(daemon.mutateCtx, "turn.store_detail", store);
    const ai = daemon.ai;
    if (!ai) throw new Error("ingest is not running");
    // 同意の前（onboarding.md 5.2）は検出だけで、セッションを読まない
    await Bun.sleep(100);
    const before = openDatabase(paths.dbPath, { readonly: true });
    expect(before.query<{ n: number }, []>("SELECT count(*) AS n FROM ai_turn").get()?.n).toBe(0);
    before.close();
    // 検出（ファイルの数と更新時刻だけ）→ 同意で取り込みを始める
    const found = await daemon.onboarding.detect();
    await daemon.onboarding.consent(found.sources.map((s) => s.id));
    for (let i = 0; i < 100 && !ai.supervisor.backfillDone; i++) await Bun.sleep(20);
    await ai.supervisor.whenIdle();
    ai.runner.runOnce();
    const turns = openDatabase(paths.dbPath, { readonly: true });
    const n = turns.query<{ n: number }, []>("SELECT count(*) AS n FROM ai_turn").get()?.n ?? 0;
    turns.close();
    expect(n).toBeGreaterThan(20);

    // SSE（以降に流れたものをすべて集める）
    const auth = { authorization: `Bearer ${daemon.token}`, "x-turnlane-client": "cli" };
    const sseAbort = new AbortController();
    let sse = "";
    const sseDone = fetch(`${daemon.url}/api/events`, { headers: auth, signal: sseAbort.signal })
      .then(async (r) => {
        const reader = r.body?.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const c = await reader?.read();
          if (!c || c.done) break;
          sse += dec.decode(c.value);
        }
      })
      .catch(() => {});
    // glance: わざと番兵を応答に出す（表示の瞬間に読む中身。D-207）
    const ids = (() => {
      const d = openDatabase(paths.dbPath, { readonly: true });
      const r = d.query<{ id: string }, []>("SELECT id FROM work_item").all();
      d.close();
      return r.map((x) => x.id);
    })();
    let glanced = "";
    for (const id of ids) {
      const r = await fetch(`${daemon.url}/api/work-items/${id}/glance`, { headers: auth });
      expect(r.headers.get("cache-control")).toBe("no-store");
      glanced += await r.text();
    }
    expect(glanced).toContain(mark);
    expect(glanced).toContain('"kind":"permission"');
    expect(glanced).toContain('"kind":"ask"');
    // Turnlane から答える（D-238）の待ちの中身: 問いの全文も表示の瞬間に読むだけ（no-store。後の検査で DB・ログに出ない）
    let waited = "";
    for (const id of ids) {
      const r = await fetch(`${daemon.url}/api/work-items/${id}/wait`, { headers: auth });
      expect(r.headers.get("cache-control")).toBe("no-store");
      waited += await r.text();
    }
    expect(waited).toContain('"kind":"permission"');
    // 判定・取り込みをもう一度回す（glance の後でも DB に何も書かれない）
    await ai.supervisor.scanAll();
    await ai.supervisor.whenIdle();
    ai.runner.runOnce();
    // MCP の各ツール（読み取り）の出力
    const mcpCtx = {
      paths: { ...paths, port: daemon.port },
      client: "test",
      cwd: "/fixture/repo-a",
    };
    let mcpOut = "";
    for (const t of TOOLS.filter((x) => x.name.startsWith("get_") || x.name.startsWith("list_"))) {
      const r = await handleMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: t.name, arguments: {} } },
        { ctx: mcpCtx },
      );
      mcpOut += JSON.stringify(r);
    }
    // 待っている件は list_your_turn に出る（題名・状態だけ）。日報（get_daily_report）も今日の分
    expect(mcpOut).toContain("fix/glance-permission");
    if (!store) expect(mcpOut).not.toContain(SENTINEL_PREFIX);
    else {
      // 保存した中身を出してよいのは日報（get_daily_report）だけ
      for (const t of TOOLS.filter(
        (x) =>
          (x.name.startsWith("get_") || x.name.startsWith("list_")) &&
          x.name !== "get_daily_report",
      )) {
        const r = await handleMessage(
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: t.name, arguments: {} } },
          { ctx: mcpCtx },
        );
        expect(`${t.name} ${JSON.stringify(r)}`).not.toContain(SENTINEL_PREFIX);
      }
    }

    // (1) DB と WAL
    if (!store) {
      expect(bytesContain(paths.dbPath, sentinel)).toBe(false);
      expect(bytesContain(`${paths.dbPath}-wal`, sentinel)).toBe(false);
      expect(bytesContain(`${paths.dbPath}-wal`, SENTINEL_PREFIX)).toBe(false);
    } else {
      // 番兵は決めた列だけ。指示の 1 行目と待ちの中身は実際に保存されている
      const cols = columnsContaining(paths.dbPath, SENTINEL_PREFIX);
      expect([...cols].filter((c) => !STORED_COLUMNS.has(c))).toEqual([]);
      expect(cols.has("ai_instruction.text")).toBe(true);
      expect(cols.has("wait_detail.command") || cols.has("wait_detail.label")).toBe(true);
      expect(cols.has("wait_detail.text")).toBe(true);
    }
    // (2) ログ
    expect(bytesContain(paths.logPath, SENTINEL_PREFIX)).toBe(false);
    // (3) エクスポート
    const db = openDatabase(paths.dbPath, { readonly: true });
    let exported = "";
    exportJsonl(
      db,
      (s) => {
        exported += s;
      },
      { appVersion: "test", exportedAt: 0 },
    );
    db.close();
    expect(exported.length).toBeGreaterThan(1000);
    if (!store) expect(exported).not.toContain(SENTINEL_PREFIX);
    else
      for (const line of exported.split("\n").filter((l) => l.includes(SENTINEL_PREFIX)))
        expect(STORED_TABLES.has((JSON.parse(line) as { table?: string }).table ?? "")).toBe(true);
    // spool にも残っていない（turnlane hook の抽出）
    expect(bytesContain(join(paths.spoolDir, "hooks-20260902.jsonl"), sentinel)).toBe(false);
    // (4) 日報の AI 要約の子プロセスの stdin（ADR 0005 の追記）
    putSetting(daemon.mutateCtx, "report.ai_summary", { enabled: true, tool: "claude_code" });
    const day = "2026-09-02";
    const res = await fetch(`${daemon.url}/api/daily-notes/${day}/summary`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
        "x-turnlane-client": "cli",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    for (let i = 0; i < 100 && !existsSync(captured); i++) await Bun.sleep(20);
    await Bun.sleep(100);
    const stdin = readFileSync(captured, "utf8");
    expect(stdin).toContain("<daily-report>");
    expect(stdin).not.toContain(SENTINEL_PREFIX);
    // (5) SSE で流れたもの（通知の notify も含む）
    await Bun.sleep(200);
    sseAbort.abort();
    await sseDone;
    expect(sse.length).toBeGreaterThan(0);
    expect(sse).not.toContain(SENTINEL_PREFIX);
    // ログ（glance の後も）
    expect(bytesContain(paths.logPath, SENTINEL_PREFIX)).toBe(false);
    if (!store) {
      expect(bytesContain(paths.dbPath, SENTINEL_PREFIX)).toBe(false);
      expect(bytesContain(`${paths.dbPath}-wal`, SENTINEL_PREFIX)).toBe(false);
    } else {
      const cols = columnsContaining(paths.dbPath, SENTINEL_PREFIX);
      expect([...cols].filter((c) => !STORED_COLUMNS.has(c))).toEqual([]);
    }
  }
}
