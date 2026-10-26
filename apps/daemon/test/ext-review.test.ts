/**
 * 拡張点（2026-10-14）: タスクの完了の取り消し（tasks.reopen）、
 * AI の1回の実行のアカウントと応答の形（ai.runOneShot の claudeAccount・schema）、差分の中身と捨てる
 * （review.diff・launcher.discard。起動の部品が無いときは 409）。テスト用の拡張（ext-fixture/daemon.ts）のルートから呼ぶ。
 * 差分と捨てるの中身（本物の git）は launch-api.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { resolvePaths } from "@turnlane/core";
import type { TaskView } from "@turnlane/core/api";
import { type RunningDaemon, startDaemon } from "../src/main.ts";
import fixture, { testState } from "./ext-fixture/daemon.ts";

let home: string;
let daemon: RunningDaemon | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "turnlane-ext-review-"));
});
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  rmSync(home, { recursive: true, force: true });
});

const call = async <T = unknown>(method: string, path: string, body?: unknown) => {
  const d = daemon as RunningDaemon;
  const r = await fetch(`${d.url}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${d.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json()) as T };
};

const CLAUDE_HELP = `Usage: claude [options]
  -p, --print
  --output-format <format>
  --json-schema <schema>
  --tools <tools...>
  --no-session-persistence
`;

/** 偽の claude: --help には help、それ以外は引数と CLAUDE_CONFIG_DIR を書き残して、構造化の結果を返す */
function fakeClaude(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "claude");
  writeFileSync(
    p,
    `#!/bin/bash
for a in "$@"; do if [ "$a" = "--help" ]; then cat <<'HELP'
${CLAUDE_HELP}HELP
exit 0; fi; done
cat > /dev/null
printf '%s' "\${CLAUDE_CONFIG_DIR-<unset>}" > '${dir}/env.txt'
printf '%s\\n' "$*" > '${dir}/args.txt'
printf '%s' '{"type":"result","is_error":false,"result":"","structured_output":{"summary":"Three tests added."}}'
`,
  );
  chmodSync(p, 0o755);
  return p;
}

async function start(o: { summaryBin?: string } = {}) {
  daemon = await startDaemon({
    paths: resolvePaths({ HOME: home }, home),
    logger: nullLogger,
    port: 0,
    ingest: false,
    calendar: false,
    extensions: [fixture],
    summary: { detect: { shell: null, knownDirs: o.summaryBin ? [o.summaryBin] : [] } },
  });
  return daemon;
}

describe("タスクの完了の取り消し（tasks.reopen）", () => {
  test("完了を未完了に戻す。完了していないタスクはそのまま、無いタスクは null", async () => {
    await start();
    const t = await call<{ task: TaskView }>("POST", "/tasks", {
      title: "Review",
      date: "2026-10-02",
    });
    const id = t.body.task.id;
    await call("POST", `/ext/test/tasks/${id}/complete`);
    expect((await call<{ task: TaskView }>("GET", `/tasks/${id}`)).body.task.status).toBe("done");
    const r = await call<{ task: TaskView | null }>("POST", `/ext/test/tasks/${id}/reopen`, {});
    expect(r.body.task?.status).toBe("todo");
    expect((await call<{ task: TaskView }>("GET", `/tasks/${id}`)).body.task.status).toBe("todo");
    // もう一度: 完了していないので何も変えない
    const again = await call<{ task: TaskView | null }>("POST", `/ext/test/tasks/${id}/reopen`, {});
    expect(again.body.task?.status).toBe("todo");
    expect(
      (await call<{ task: TaskView | null }>("POST", "/ext/test/tasks/nope/reopen", {})).body.task,
    ).toBeNull();
  });
});

describe("AI の1回の実行（ai.runOneShot の claudeAccount・schema）", () => {
  test("~/.claude 以外は CLAUDE_CONFIG_DIR を付け、~/.claude なら消す。schema は --json-schema で渡して json に", async () => {
    const bin = join(home, "bin");
    fakeClaude(bin);
    await start({ summaryBin: bin });
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    const other = join(home, ".claude-acme");
    const r = await call<{ ok: boolean; json?: unknown }>("POST", "/ext/test/oneshot", {
      tool: "claude_code",
      account: other,
      schema,
    });
    expect(r.body).toMatchObject({ ok: true, json: { summary: "Three tests added." } });
    expect(readFileSync(join(bin, "env.txt"), "utf8")).toBe(other);
    expect(readFileSync(join(bin, "args.txt"), "utf8")).toContain("--json-schema");
    await call("POST", "/ext/test/oneshot", {
      tool: "claude_code",
      account: join(home, ".claude"),
    });
    expect(readFileSync(join(bin, "env.txt"), "utf8")).toBe("<unset>");
  });
});

describe("差分の中身と捨てる（起動の部品が無いとき）", () => {
  test("review.diff・launcher.discard は 409（launch_unavailable）", async () => {
    await start();
    const id = "0".repeat(32);
    expect(await call("GET", `/ext/test/diff/${id}`)).toEqual({
      status: 409,
      body: { error: "launch_unavailable" },
    });
    expect((await call("POST", `/ext/test/discard/${id}`)).status).toBe(409);
  });
});
