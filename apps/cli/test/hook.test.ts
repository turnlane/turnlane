import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinAdapters } from "@turnlane/collectors";
import {
  configRoot,
  extract,
  MAX_LINE_BYTES,
  spoolDir,
  spoolFileName,
  toLine,
} from "../src/hook/run.ts";

const SENTINEL = "SENTINEL_BODY_6f1c";

describe("extract（許可リスト）", () => {
  test("許可リストのキーだけを残し、本文系のキーは捨てる", () => {
    const rec = extract(
      {
        hook_event_name: "Stop",
        session_id: "s1",
        cwd: "/fixture/repo-a",
        prompt: SENTINEL,
        last_assistant_message: SENTINEL,
        tool_input: { command: SENTINEL },
        message: SENTINEL,
        notification_type: "permission_prompt",
      },
      "claude_code",
      1000,
      "/fixture/home/.claude",
    );
    expect(rec).toEqual({
      v: 1,
      tool: "claude_code",
      received_at: 1000,
      config_root: "/fixture/home/.claude",
      hook_event_name: "Stop",
      session_id: "s1",
      cwd: "/fixture/repo-a",
      notification_type: "permission_prompt",
    });
    expect(JSON.stringify(rec)).not.toContain(SENTINEL);
  });

  test("StopFailure のエラーの種類は公式の項目名 error で残す。error_details・last_assistant_message は捨てる", () => {
    // 公式の入力例（hooks の StopFailure の節）と同じ項目名
    const rec = extract(
      {
        session_id: "s1",
        transcript_path: "/fixture/home/.claude/projects/-fixture-repo-a/s1.jsonl",
        cwd: "/fixture/repo-a",
        hook_event_name: "StopFailure",
        error: "rate_limit",
        error_details: SENTINEL,
        last_assistant_message: SENTINEL,
      },
      "claude_code",
      1000,
    );
    expect(rec).toMatchObject({ hook_event_name: "StopFailure", error: "rate_limit" });
    expect(rec).not.toHaveProperty("error_details");
    expect(rec).not.toHaveProperty("last_assistant_message");
    expect(JSON.stringify(rec)).not.toContain(SENTINEL);
    // 古い形（error_type）もそのまま残す
    expect(
      extract({ hook_event_name: "StopFailure", error_type: "overloaded" }, "claude_code", 0),
    ).toMatchObject({ error_type: "overloaded" });
  });

  test("quota_auto_resume_disabled の定型文（24 時間より先に明ける）は quota_horizon の真偽だけを残し、message は捨てる", () => {
    const base = {
      hook_event_name: "Notification",
      session_id: "s1",
      notification_type: "quota_auto_resume_disabled",
    };
    const horizon = extract(
      {
        ...base,
        message:
          "Automatic continue stopped \u2014 the usage limit now resets more than 24 hours out; the task will not resume on its own",
      },
      "claude_code",
      0,
    );
    expect(horizon).toMatchObject({
      notification_type: "quota_auto_resume_disabled",
      quota_horizon: true,
    });
    expect(horizon).not.toHaveProperty("message");
    // 設定で切ったときの文は当たらない
    const off = extract(
      {
        ...base,
        message: "Automatic continue was turned off \u2014 the task will not resume on its own",
      },
      "claude_code",
      0,
    );
    expect(off).not.toHaveProperty("quota_horizon");
    expect(off).not.toHaveProperty("message");
    // 別の通知・Codex は見ない。文の中身（番兵）は spool に入らない
    const other = extract(
      { ...base, notification_type: "idle_prompt", message: `more than 24 hours out ${SENTINEL}` },
      "claude_code",
      0,
    );
    expect(other).not.toHaveProperty("quota_horizon");
    expect(JSON.stringify(other)).not.toContain(SENTINEL);
    expect(
      extract({ ...base, message: "resets more than 24 hours out" }, "codex", 0),
    ).not.toHaveProperty("quota_horizon");
  });

  test("error は識別子の形の値だけ残す（文の入った error は捨てる）", () => {
    const rec = extract(
      { hook_event_name: "StopFailure", session_id: "s1", error: `API Error: ${SENTINEL}` },
      "claude_code",
      0,
    );
    expect(rec).not.toHaveProperty("error");
    expect(JSON.stringify(rec)).not.toContain(SENTINEL);
  });

  test("許可キーでもオブジェクトや長すぎる文字列は捨てる", () => {
    const rec = extract({ hook_event_name: { x: 1 }, cwd: "a".repeat(2000) }, "codex", 0);
    expect(rec).toEqual({ v: 1, tool: "codex", received_at: 0 });
  });

  test("Codex のプロジェクト外の作業フォルダは日付までに切り落とす（D-135）", () => {
    const home = "/fixture/home";
    const rec = extract(
      {
        hook_event_name: "Stop",
        session_id: "s1",
        cwd: `${home}/Documents/Codex/2026-10-08/plan-the-trip-${SENTINEL}`,
      },
      "codex",
      0,
      undefined,
      home,
    );
    expect(rec?.cwd).toBe(`${home}/Documents/Codex/2026-10-08`);
    expect(JSON.stringify(rec)).not.toContain(SENTINEL);
    // ほかのフォルダはそのまま
    expect(
      extract({ hook_event_name: "Stop", cwd: "/fixture/repo-a" }, "codex", 0, undefined, home)
        ?.cwd,
    ).toBe("/fixture/repo-a");
  });

  test("Claude Code の transcript_path の、Codex の作業フォルダを符号化した1段を日付までに切り落とす（D-136）", () => {
    const home = "/fixture/home";
    const enc = `-fixture-home-Documents-Codex-2026-10-08`;
    const rec = extract(
      {
        hook_event_name: "Stop",
        session_id: "s1",
        cwd: `${home}/Documents/Codex/2026-10-08/plan-the-trip-${SENTINEL}`,
        transcript_path: `${home}/.claude/projects/${enc}-plan-the-trip-${SENTINEL}/s1.jsonl`,
      },
      "claude_code",
      0,
      undefined,
      home,
    );
    expect(rec?.transcript_path).toBe(`${home}/.claude/projects/${enc}/s1.jsonl`);
    expect(JSON.stringify(rec)).not.toContain(SENTINEL);
    // ほかのプロジェクトはそのまま
    expect(
      extract(
        {
          hook_event_name: "Stop",
          transcript_path: `${home}/.claude/projects/-fixture-repo-a/s1.jsonl`,
        },
        "claude_code",
        0,
        undefined,
        home,
      )?.transcript_path,
    ).toBe(`${home}/.claude/projects/-fixture-repo-a/s1.jsonl`);
  });

  test("オブジェクトでない入力は null", () => {
    expect(extract([1], "claude_code", 0)).toBeNull();
    expect(extract("x", "claude_code", 0)).toBeNull();
  });
});

describe("toLine", () => {
  test("4KB を超えるときは落としてよいキーから落とし、truncated を付ける", () => {
    const rec = {
      v: 1,
      tool: "claude_code",
      received_at: 0,
      hook_event_name: "Stop",
      cwd: "c".repeat(1000),
      transcript_path: "t".repeat(1000),
      reason: "r".repeat(1000),
      source: "s".repeat(1000),
      session_id: "x".repeat(1000),
    };
    const line = toLine({ ...rec });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    const o = JSON.parse(line);
    expect(o.truncated).toBe(true);
    expect(o.transcript_path).toBeUndefined();
    expect(o.session_id).toBe(rec.session_id);
    expect(line.endsWith("\n")).toBe(true);
  });
});

describe("term（Orca の端末のハンドル。D-238）", () => {
  test("形の合う ORCA_TERMINAL_HANDLE だけを term に残す", () => {
    const h = "term_0a1b2c3d-4e5f-6789-abcd-ef0123456789";
    expect(extract({ hook_event_name: "Stop" }, "claude_code", 0, undefined, undefined, h)).toEqual(
      { v: 1, tool: "claude_code", received_at: 0, term: h, hook_event_name: "Stop" },
    );
    for (const bad of ["", "term_", "abc", `term_${SENTINEL} x`, "term_../../etc"])
      expect(extract({}, "codex", 0, undefined, undefined, bad)).toEqual({
        v: 1,
        tool: "codex",
        received_at: 0,
      });
  });
});

describe("config_root（S5）", () => {
  test("CLAUDE_CONFIG_DIR / CODEX_HOME があればその値、無ければ既定のディレクトリ", () => {
    expect(configRoot("claude_code", { HOME: "/h" })).toBe("/h/.claude");
    expect(configRoot("claude_code", { HOME: "/h", CLAUDE_CONFIG_DIR: "/h/.claude-acme/" })).toBe(
      "/h/.claude-acme",
    );
    expect(configRoot("codex", { HOME: "/h" })).toBe("/h/.codex");
    expect(configRoot("codex", { HOME: "/h", CODEX_HOME: "/x/codex" })).toBe("/x/codex");
  });
});

describe("spool の場所と名前", () => {
  test("TURNLANE_DATA_DIR があればその下、無ければ HOME の Application Support", () => {
    expect(spoolDir({ TURNLANE_DATA_DIR: "/d" })).toBe("/d/spool");
    expect(spoolDir({ HOME: "/h" })).toBe("/h/Library/Application Support/turnlane/spool");
  });
  test("ファイル名はローカル日付", () => {
    // preload で TZ=Asia/Tokyo。UTC 2026-10-01 15:30 は東京 10/2 00:30
    expect(spoolFileName(new Date(Date.UTC(2026, 9, 1, 15, 30)))).toBe("hooks-20261002.jsonl");
  });
});

describe("turnlane hook（プロセスとして実行）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "turnlane-hook-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const runHook = (stdin: string, args = ["--tool", "claude_code", "--managed-by", "turnlane"]) =>
    Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/main.ts"), "hook", ...args], {
      env: { HOME: dir, TURNLANE_DATA_DIR: dir, PATH: process.env.PATH ?? "" },
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });

  test("spool に1行追記して exit 0。ファイルは 600、ディレクトリは 700", () => {
    const p = runHook(JSON.stringify({ hook_event_name: "Stop", prompt: SENTINEL }));
    expect(p.exitCode).toBe(0);
    const files = readdirSync(join(dir, "spool"));
    expect(files).toHaveLength(1);
    const path = join(dir, "spool", files[0] as string);
    const text = readFileSync(path, "utf8");
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(text)).toMatchObject({ tool: "claude_code", config_root: `${dir}/.claude` });
    expect(text).not.toContain(SENTINEL);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "spool")).mode & 0o777).toBe(0o700);
  });

  test("Orca の端末の中なら term にハンドルを残す（D-238）", () => {
    const h = "term_0a1b2c3d-4e5f-6789-abcd-ef0123456789";
    const p = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "../src/main.ts"), "hook", "--tool", "claude_code"],
      {
        env: {
          HOME: dir,
          TURNLANE_DATA_DIR: dir,
          PATH: process.env.PATH ?? "",
          ORCA_TERMINAL_HANDLE: h,
        },
        stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "Stop" })),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(p.exitCode).toBe(0);
    const files = readdirSync(join(dir, "spool"));
    const text = readFileSync(join(dir, "spool", files[0] as string), "utf8");
    expect(JSON.parse(text)).toMatchObject({ term: h });
  });

  test("壊れた JSON・不明な --tool・--tool なしでも exit 0 で何も書かない", () => {
    expect(runHook("{not json").exitCode).toBe(0);
    expect(runHook("{}", ["--tool", "other"]).exitCode).toBe(0);
    // ADR 0009: 短い別名（claude）は受け付けない
    expect(runHook("{}", ["--tool", "claude"]).exitCode).toBe(0);
    expect(runHook("{}", []).exitCode).toBe(0);
    expect(() => readdirSync(join(dir, "spool"))).toThrow();
  });
});

describe("configRoot と取り込み元のルート（利用枠のアカウント）", () => {
  test("hook の config_root と Claude Code の取り込み元のルートのパスが同じ文字列になる（.claude.json の利用枠と結び付く）", async () => {
    const claudeCode = builtinAdapters.find((a) => a.tool === "claude_code");
    if (!claudeCode) throw new Error("no claude_code adapter");
    const home = mkdtempSync(join(tmpdir(), "turnlane-home-"));
    try {
      for (const [dir, vars] of [
        [join(home, ".claude"), {}],
        [join(home, ".claude-alt"), { CLAUDE_CONFIG_DIR: `${join(home, ".claude-alt")}/` }],
      ] as const) {
        mkdirSync(join(dir, "projects"), { recursive: true });
        const roots = await claudeCode.detect({ home, vars });
        const hookRoot = configRoot("claude_code", { HOME: home, ...vars });
        expect(hookRoot).toBe(dir);
        expect(roots.map((r) => r.rootPath)).toContain(hookRoot);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
