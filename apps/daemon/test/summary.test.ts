/**
 * 日報の AI 要約（M4-6）のテスト。実際の claude / codex は呼ばず、偽の CLI（シェルスクリプト）で確かめる:
 * 成功・タイムアウト・終了コード非0・空出力・巨大出力・見つからない、起動フラグの確認、stdin に日報以外が入らないこと、
 * 要約の作業ディレクトリが取り込みから除外されること、API（生成・失敗・編集・Markdown の先頭の Summary）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSummaryInput, putSetting } from "@turnlane/core";
import type { DailyReportResponse, DailySummaryView } from "@turnlane/core/api";
import { createApp } from "../src/http/app.ts";
import { cwdAllowed, dirExcludeGlobs } from "../src/ingest/enrich.ts";
import { createPlanner } from "../src/planner/index.ts";
import {
  detectCli,
  findCli,
  flagsFromHelp,
  readStructured,
  runSummaryCli,
  summaryArgs,
} from "../src/summary/cli.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const CLAUDE_HELP = `Usage: claude [options]
  -p, --print                           Print response and exit
  --output-format <format>              Output format (only works with --print)
  --tools <tools...>                    Specify the list of available tools
  --no-session-persistence              Disable session persistence
`;
const CODEX_HELP = `Usage: codex exec [OPTIONS] [PROMPT]
  -s, --sandbox <SANDBOX_MODE>
  -C, --cd <DIR>
      --skip-git-repo-check
      --ephemeral
  -o, --output-last-message <FILE>
`;

let dir: string;
let env: AiEnv | null = null;
afterEach(async () => {
  await env?.cleanup();
  env = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  dir = mkdtempSync(join(tmpdir(), "turnlane-summary-"));
  return dir;
}

/** 偽の CLI。--help には help を返し、それ以外は stdin を capture に書いて body を実行する */
function fakeCli(at: string, name: string, help: string, body: string, capture?: string): string {
  mkdirSync(at, { recursive: true });
  const p = join(at, name);
  writeFileSync(
    p,
    `#!/bin/bash
for a in "$@"; do if [ "$a" = "--help" ]; then cat <<'HELP'
${help}HELP
exit 0; fi; done
${capture ? `cat > '${capture}'` : "cat > /dev/null"}
printf '%s\\n' "$*" > '${at}/${name}.args'
pwd > '${at}/${name}.cwd'
${body}
`,
  );
  chmodSync(p, 0o755);
  return p;
}

describe("CLI の検出と起動フラグ", () => {
  test("--help にあるフラグだけを付ける", () => {
    expect(flagsFromHelp("claude_code", CLAUDE_HELP)).toEqual({
      flags: ["--output-format", "--tools", "--no-session-persistence"],
      missingFlags: [],
    });
    const old = CLAUDE_HELP.replace(/.*no-session-persistence.*\n/, "");
    expect(flagsFromHelp("claude_code", old).missingFlags).toEqual(["--no-session-persistence"]);
    expect(flagsFromHelp("codex", CODEX_HELP).missingFlags).toEqual([]);
    expect(flagsFromHelp("codex", null).flags).toEqual([]);
  });

  test("引数（Claude はシェルを通さない配列、Codex は -C と -o と stdin の -）", () => {
    expect(
      summaryArgs("claude_code", flagsFromHelp("claude_code", CLAUDE_HELP).flags, "/w", null),
    ).toEqual(["-p", "--output-format", "text", "--tools", "", "--no-session-persistence"]);
    expect(
      summaryArgs("codex", flagsFromHelp("codex", CODEX_HELP).flags, "/w", "/tmp/o.txt"),
    ).toEqual([
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-C",
      "/w",
      "-o",
      "/tmp/o.txt",
      "-",
    ]);
    // 古い版（フラグが無い）
    expect(summaryArgs("claude_code", [], "/w", null)).toEqual(["-p"]);
  });

  test("設定の bin → 既知の場所の順に探し、無ければ null（ログインシェルは使わない設定）", async () => {
    const d = tmp();
    const known = join(d, "bin");
    const bin = fakeCli(known, "claude", CLAUDE_HELP, "echo ok");
    expect(
      await findCli("claude_code", null, { home: d, shell: null, knownDirs: [known] }),
    ).toEqual({ bin, foundBy: "known" });
    const other = fakeCli(join(d, "other"), "claude", CLAUDE_HELP, "echo ok");
    expect(
      await findCli("claude_code", other, { home: d, shell: null, knownDirs: [known] }),
    ).toEqual({ bin: other, foundBy: "setting" });
    expect(await findCli("codex", null, { home: d, shell: null, knownDirs: [known] })).toBeNull();
    const det = await detectCli("claude_code", null, { home: d, shell: null, knownDirs: [known] });
    expect(det.flags).toEqual(["--output-format", "--tools", "--no-session-persistence"]);
  });

  test("ログインシェルの command -v で見つける", async () => {
    const d = tmp();
    const bin = fakeCli(join(d, "nvm"), "codex", CODEX_HELP, "echo ok");
    const shell = join(d, "fake-shell");
    writeFileSync(shell, `#!/bin/bash\necho "${bin}"\n`);
    chmodSync(shell, 0o755);
    expect(await findCli("codex", null, { home: d, shell, knownDirs: [] })).toEqual({
      bin,
      foundBy: "shell",
    });
  });
});

describe("子プロセスの実行", () => {
  const input = buildSummaryInput("## Fri 10/2\n\nTime: You 1h", "en");
  const claudeFlags = flagsFromHelp("claude_code", CLAUDE_HELP).flags;

  test("成功: 出力の前後の空白と先頭の見出しを外す。cwd は作業ディレクトリ、stdin は日報だけ", async () => {
    const d = tmp();
    const work = join(d, "summarize");
    mkdirSync(work);
    const cap = join(d, "stdin.txt");
    const bin = fakeCli(
      join(d, "bin"),
      "claude",
      CLAUDE_HELP,
      "printf '## Summary\\n\\nA calm day.\\n\\n'",
      cap,
    );
    const r = await runSummaryCli({
      tool: "claude_code",
      bin,
      flags: claudeFlags,
      workDir: work,
      input,
      timeoutMs: 5000,
    });
    expect(r).toEqual({ ok: true, text: "A calm day." });
    expect(readFileSync(cap, "utf8")).toBe(input);
    expect(readFileSync(join(d, "bin", "claude.cwd"), "utf8").trim()).toEndWith("/summarize");
    expect(readFileSync(join(d, "bin", "claude.args"), "utf8").trim()).toBe(
      "-p --output-format text --tools  --no-session-persistence",
    );
  });

  test("Codex は -o のファイルから読む", async () => {
    const d = tmp();
    const bin = fakeCli(
      join(d, "bin"),
      "codex",
      CODEX_HELP,
      // -o の次の引数に書く。stdout には進捗（使わない）
      `out=""; prev=""; for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done
echo "progress..."; printf 'From the file.' > "$out"`,
    );
    const r = await runSummaryCli({
      tool: "codex",
      bin,
      flags: flagsFromHelp("codex", CODEX_HELP).flags,
      workDir: d,
      input,
      timeoutMs: 5000,
    });
    expect(r).toEqual({ ok: true, text: "From the file." });
  });

  test("応答の形（schema）: 対応する版だけ Claude は --output-format json --json-schema、Codex は --output-schema のファイル", async () => {
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    const CLAUDE_NEW = `${CLAUDE_HELP}  --json-schema <schema>                JSON Schema for structured output\n`;
    const CODEX_NEW = `${CODEX_HELP}      --output-schema <FILE>\n`;
    // あれば付けるフラグは missingFlags に入れない（日報の要約は今までどおり）
    expect(flagsFromHelp("claude_code", CLAUDE_HELP).missingFlags).toEqual([]);
    expect(flagsFromHelp("claude_code", CLAUDE_NEW).flags).toContain("--json-schema");
    const d = tmp();
    const claude = fakeCli(
      join(d, "bin"),
      "claude",
      CLAUDE_NEW,
      `printf '%s' '{"type":"result","is_error":false,"result":"","structured_output":{"summary":"Tests added."}}'`,
    );
    const r = await runSummaryCli({
      tool: "claude_code",
      bin: claude,
      flags: flagsFromHelp("claude_code", CLAUDE_NEW).flags,
      workDir: d,
      input: "diff",
      timeoutMs: 5000,
      schema,
    });
    expect(r).toEqual({
      ok: true,
      text: '{"summary":"Tests added."}',
      json: { summary: "Tests added." },
    });
    expect(readFileSync(join(d, "bin", "claude.args"), "utf8").trim()).toBe(
      `-p --output-format json --json-schema ${JSON.stringify(schema)} --tools  --no-session-persistence`,
    );
    // 古い版（--json-schema が無い）は文で返し、json は無い
    const old = fakeCli(join(d, "old"), "claude", CLAUDE_HELP, "printf 'Plain text.'");
    expect(
      await runSummaryCli({
        tool: "claude_code",
        bin: old,
        flags: claudeFlags,
        workDir: d,
        input: "diff",
        timeoutMs: 5000,
        schema,
      }),
    ).toEqual({ ok: true, text: "Plain text." });
    // Codex: --output-schema のファイルに schema を書き、-o の最後の応答を JSON として読む
    const codex = fakeCli(
      join(d, "cx"),
      "codex",
      CODEX_NEW,
      `out=""; sc=""; prev=""; for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; if [ "$prev" = "--output-schema" ]; then sc="$a"; fi; prev="$a"; done
cp "$sc" '${join(d, "cx", "schema.copy")}'; printf '{"summary":"Docs split."}' > "$out"`,
    );
    const c = await runSummaryCli({
      tool: "codex",
      bin: codex,
      flags: flagsFromHelp("codex", CODEX_NEW).flags,
      workDir: d,
      input: "diff",
      timeoutMs: 5000,
      schema,
    });
    expect(c).toMatchObject({ ok: true, json: { summary: "Docs split." } });
    expect(JSON.parse(readFileSync(join(d, "cx", "schema.copy"), "utf8"))).toEqual(schema);
  });

  test("構造化の出力の読み取り: structured_output → result の文の JSON（囲みも外す）→ 読めなければ empty、is_error は exit", () => {
    expect(readStructured("claude_code", '{"result":"```json\\n{\\"a\\":1}\\n```"}')).toEqual({
      ok: true,
      text: '```json\n{"a":1}\n```',
      json: { a: 1 },
    });
    expect(readStructured("claude_code", '{"is_error":true,"result":"x"}')).toEqual({
      ok: false,
      failure: { kind: "exit", code: null },
    });
    expect(readStructured("claude_code", "not json")).toEqual({
      ok: false,
      failure: { kind: "empty" },
    });
    expect(readStructured("codex", '{"summary":"x"}')).toMatchObject({
      ok: true,
      json: { summary: "x" },
    });
  });

  test("失敗: タイムアウト（SIGTERM を無視しても SIGKILL）・終了コード非0・空・長すぎ・巨大・無い", async () => {
    const d = tmp();
    const b = join(d, "bin");
    const run = (bin: string, timeoutMs = 5000) =>
      runSummaryCli({
        tool: "claude_code",
        bin,
        flags: claudeFlags,
        workDir: d,
        input,
        timeoutMs,
        killGraceMs: 200,
      });
    const slow = fakeCli(b, "slow", CLAUDE_HELP, "trap '' TERM; sleep 10; echo late");
    const t0 = Date.now();
    expect(await run(slow, 300)).toEqual({ ok: false, failure: { kind: "timed_out" } });
    expect(Date.now() - t0).toBeLessThan(5000);
    // 子プロセス（sleep）が stdout を握ったまま残っても、時間どおりに終わる（グループごと止める）
    const t1 = Date.now();
    expect(await run(fakeCli(b, "orphan", CLAUDE_HELP, "sleep 20 & sleep 20"), 300)).toEqual({
      ok: false,
      failure: { kind: "timed_out" },
    });
    expect(Date.now() - t1).toBeLessThan(3000);
    expect(await run(fakeCli(b, "fail", CLAUDE_HELP, "echo partial; exit 3"))).toEqual({
      ok: false,
      failure: { kind: "exit", code: 3, signal: null },
    });
    expect(await run(fakeCli(b, "empty", CLAUDE_HELP, "echo '   '"))).toEqual({
      ok: false,
      failure: { kind: "empty" },
    });
    expect(
      await run(fakeCli(b, "long", CLAUDE_HELP, "head -c 2100 /dev/zero | tr '\\\\0' 'a'")),
    ).toEqual({ ok: false, failure: { kind: "too_long" } });
    // 1MB の出力でも詰まらずに終わる（16KB だけ読む）
    expect(
      await run(fakeCli(b, "huge", CLAUDE_HELP, "head -c 1048576 /dev/zero | tr '\\\\0' 'a'")),
    ).toEqual({ ok: false, failure: { kind: "too_long" } });
    expect(await run(join(b, "missing"))).toEqual({ ok: false, failure: { kind: "not_found" } });
  });

  test("取り消すと何も返さない（exit・canceled）", async () => {
    const d = tmp();
    const bin = fakeCli(join(d, "bin"), "claude", CLAUDE_HELP, "sleep 5; echo late");
    const ac = new AbortController();
    const p = runSummaryCli({
      tool: "claude_code",
      bin,
      flags: claudeFlags,
      workDir: d,
      input,
      timeoutMs: 10_000,
      killGraceMs: 200,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.ok).toBe(false);
  });
});

describe("要約の作業ディレクトリは取り込まない", () => {
  test("除外の glob（空白を含むパス、配下も）", () => {
    const work = "/Users/x/Library/Application Support/turnlane/summarize";
    const rules = { include: [], exclude: dirExcludeGlobs(work) };
    expect(cwdAllowed(work, rules)).toBe(false);
    expect(cwdAllowed(`${work}/sub`, rules)).toBe(false);
    expect(cwdAllowed("/Users/x/Library/Application Support/turnlane/summarize2", rules)).toBe(
      true,
    );
    expect(cwdAllowed("/w/app", rules)).toBe(true);
  });

  test("作業ディレクトリで動いた Claude のセッションは AI の作業にならない", async () => {
    const T = Date.UTC(2026, 9, 2, 0, 0);
    const home = mkdtempSync(join(tmpdir(), "turnlane-sumx-"));
    const work = join(home, "data", "summarize");
    env = makeAiEnv({ now: T, excludeDirs: [work] });
    const a = claudeTranscript(join(env.home, ".claude"), {
      sid: "33333333-0000-4000-8000-000000000001",
      cwd: work,
      branch: "",
    });
    a.human(T);
    a.assistantEnd(T + 60_000, "A calm day.", { durationMs: 60_000 });
    const b = claudeTranscript(join(env.home, ".claude"), {
      sid: "33333333-0000-4000-8000-000000000002",
      cwd: "/w/app",
      branch: "main",
    });
    b.human(T);
    b.assistantEnd(T + 60_000, "Done.", { durationMs: 60_000 });
    env.clock.set(T + 5 * 60_000);
    await env.sync();
    const cwds = env.sqlite
      .query<{ cwd: string }, []>("SELECT DISTINCT cwd FROM ai_turn")
      .all()
      .map((r) => r.cwd);
    expect(cwds).toEqual(["/w/app"]);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("API（POST / PUT /api/daily-notes/:date/summary、日報の Summary）", () => {
  const TOKEN = "d".repeat(64);
  const HOST = "127.0.0.1:7317";
  const T0 = Date.UTC(2026, 9, 2, 0, 0);
  const FRI = "2026-10-02";

  function setup(body: string) {
    const e = makeAiEnv({ now: T0 });
    env = e;
    const d = tmp();
    const cap = join(d, "stdin.txt");
    const bin = fakeCli(join(d, "bin"), "claude", CLAUDE_HELP, body, cap);
    const planner = createPlanner({
      sqlite: env.sqlite,
      mutate: env.mutate,
      clock: env.clock,
      hub: env.hub,
      ai: env.ai,
      summary: {
        workDir: join(env.dataDir, "summarize"),
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        detect: { home: env.home, shell: null, knownDirs: [join(d, "bin")] },
        killGraceMs: 200,
      },
    });
    const app = createApp({
      token: TOKEN,
      port: 7317,
      hub: env.hub,
      health: () => ({}) as never,
      admin: { backup: () => ({ date: "", path: "" }) },
      ai: () => env?.ai.deps,
      planner: () => planner,
      recordUserOp: env.ai.recordUserOp,
    });
    const call = async <T>(method: string, path: string, json?: unknown) => {
      const r = await app.request(`http://${HOST}${path}`, {
        method,
        headers: {
          host: HOST,
          authorization: `Bearer ${TOKEN}`,
          "x-turnlane-client": "cli",
          ...(json !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      });
      const text = await r.text();
      let v: unknown = text;
      try {
        v = JSON.parse(text);
      } catch {}
      return { status: r.status, body: v as T };
    };
    const enable = (extra: Record<string, unknown> = {}) =>
      putSetting(e.mutate, "report.ai_summary", {
        enabled: true,
        tool: "claude_code",
        ...extra,
      });
    return { call, planner, cap, bin, enable };
  }

  test("オフなら 409、オンなら生成して保存し、日報の Markdown の先頭に Summary を付ける", async () => {
    const { call, planner, cap, bin, enable } = setup(
      "echo 'Quiet Friday: the login fix shipped.'",
    );
    expect((await call("POST", `/api/daily-notes/${FRI}/summary`, {})).status).toBe(409);
    const off = await call<DailyReportResponse>("GET", `/api/reports/daily/${FRI}?lang=en`);
    expect(off.body.summary).toMatchObject({ enabled: false, md: null, job: null });

    enable();
    const started = await call<DailySummaryView>("POST", `/api/daily-notes/${FRI}/summary`, {
      lang: "en",
    });
    expect(started.status).toBe(200);
    expect(started.body.job?.state).toBe("running");
    await planner.summary?.whenIdle();
    const r = await call<DailyReportResponse>("GET", `/api/reports/daily/${FRI}?lang=en`);
    expect(r.body.summary).toMatchObject({
      md: "Quiet Friday: the login fix shipped.",
      tool: "claude_code",
      job: null,
    });
    expect(r.body.markdown.startsWith("## Fri")).toBe(true);
    expect(
      r.body.exportMarkdown.startsWith(
        "## Summary\nQuiet Friday: the login fix shipped.\n\n(summary by claude)\n\n## Fri",
      ),
    ).toBe(true);
    const md = await call<string>("GET", `/api/reports/daily/${FRI}?format=md&lang=ja`);
    expect(md.body.startsWith("## 要約\nQuiet Friday")).toBe(true);
    expect(md.body).toContain("（claude による要約）");
    // stdin は固定のプロンプトと日報の Markdown だけ
    const stdin = readFileSync(cap, "utf8");
    expect(stdin).toBe(buildSummaryInput(r.body.markdown, "en"));
    // 見つけた bin を設定に保存した
    const s = env?.sqlite
      .query<{ value_json: string }, []>(
        "SELECT value_json FROM setting WHERE key = 'report.ai_summary'",
      )
      .get();
    expect(JSON.parse(s?.value_json ?? "{}").bin).toBe(bin);
    // 手で直す・消す
    const put = await call<DailySummaryView>("PUT", `/api/daily-notes/${FRI}/summary`, {
      summary: "Edited by me.",
    });
    expect(put.body).toMatchObject({ md: "Edited by me.", tool: "claude_code" });
    const cleared = await call<DailySummaryView>("PUT", `/api/daily-notes/${FRI}/summary`, {
      summary: "  ",
    });
    expect(cleared.body).toMatchObject({ md: null, tool: null });
  });

  test("失敗は要約なしで、理由を job に1件だけ持つ", async () => {
    const { call, planner, enable } = setup("exit 1");
    enable();
    await call("POST", `/api/daily-notes/${FRI}/summary`, { lang: "en" });
    await planner.summary?.whenIdle();
    const s = await call<DailyReportResponse>("GET", `/api/reports/daily/${FRI}?lang=en`);
    expect(s.body.summary.md).toBeNull();
    expect(s.body.summary.job).toMatchObject({
      state: "failed",
      tool: "claude_code",
      failure: { kind: "exit", code: 1 },
    });
    // 要約が無ければ Markdown に Summary は付かない
    expect(s.body.exportMarkdown).not.toContain("Summary");
  });

  test("CLI が見つからない（PATH にも既知の場所にも無い）", async () => {
    const { call, planner, enable } = setup("echo x");
    enable({ tool: "codex" });
    await call("POST", `/api/daily-notes/${FRI}/summary`, {});
    await planner.summary?.whenIdle();
    const s = await call<DailyReportResponse>("GET", `/api/reports/daily/${FRI}`);
    expect(s.body.summary.job).toMatchObject({ state: "failed", failure: { kind: "not_found" } });
  });

  test("作り直すと実行中のものは取り消され、手での編集は後から届いた要約に上書きされない", async () => {
    const { call, planner, enable } = setup("sleep 1; echo 'Late summary.'");
    enable();
    await call("POST", `/api/daily-notes/${FRI}/summary`, {});
    await call("PUT", `/api/daily-notes/${FRI}/summary`, { summary: "Mine." });
    await Bun.sleep(1300);
    await planner.summary?.whenIdle();
    const r = await call<DailyReportResponse>("GET", `/api/reports/daily/${FRI}`);
    expect(r.body.summary.md).toBe("Mine.");
    expect(r.body.summary.job).toBeNull();
  });

  test("未来の日は 400", async () => {
    const { call, enable } = setup("echo x");
    enable();
    expect((await call("POST", "/api/daily-notes/2026-10-09/summary", {})).status).toBe(400);
  });
});
