/**
 * compile 済みの turnlaned / turnlane のスモークテスト（M0 の完了条件のうち自動で確かめられるもの）。
 *
 *   bun scripts/smoke.ts [--out out]
 *
 * 一時 HOME と空いているポートで動かし、実データの場所・launchd には触れない。
 */
import {
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
import { join, resolve } from "node:path";
import { DEFAULT_DAY_BOUNDARY, systemTimeZone, toLocalDate } from "../packages/core/src/index.ts";

const ROOT = resolve(import.meta.dir, "..");
const outIdx = process.argv.indexOf("--out");
const OUT = resolve(outIdx >= 0 ? (process.argv[outIdx + 1] ?? "out") : join(ROOT, "out"));
const TURNLANED = join(OUT, "turnlaned");
const CLI = join(OUT, "turnlane");

const home = mkdtempSync(join(tmpdir(), "turnlane-smoke-"));
const port = 20000 + Math.floor(Math.random() * 20000);
// 更新確認（M6-12）の偽の確認先（GitHub Releases の latest.json の代わり。外には接続しない）
const feedSeen: Record<string, string>[] = [];
const feed = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    feedSeen.push(Object.fromEntries(req.headers));
    return Response.json({
      version: "999.0.0",
      url: "https://github.com/example/turnlane/releases",
    });
  },
});
// TURNLANE_NO_LAUNCHD=1: launchd の gui ドメインは HOME と無関係に共有なので、本物の LaunchAgent に触れない
const env = {
  HOME: home,
  TURNLANE_PORT: String(port),
  TURNLANE_NO_LAUNCHD: "1",
  // CLI の文言は英語で確かめる（LANG や設定に左右されない）
  TURNLANE_LANG: "en",
  TURNLANE_UPDATE_FEED_URL: `http://127.0.0.1:${feed.port}/releases/latest/download/latest.json`,
  PATH: process.env.PATH ?? "",
};
const dataDir = join(home, "Library", "Application Support", "turnlane");
const logPath = join(home, "Library", "Logs", "turnlane", "turnlaned.log");
const base = `http://127.0.0.1:${port}`;

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

async function waitHealthy(token: () => string | null, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = token();
    if (t) {
      try {
        const r = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${t}` } });
        if (r.ok) return true;
      } catch {}
    }
    await Bun.sleep(100);
  }
  return false;
}

const readToken = () => {
  const p = join(dataDir, "token");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
};

async function startDaemon() {
  const proc = Bun.spawn([TURNLANED], { env, cwd: tmpdir(), stdout: "ignore", stderr: "pipe" });
  const healthy = await waitHealthy(readToken);
  return { proc, healthy };
}

async function stop(proc: ReturnType<typeof Bun.spawn>) {
  proc.kill("SIGTERM");
  await proc.exited;
}

function logEvents(): { event: string; [k: string]: unknown }[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

try {
  check("binaries exist", existsSync(TURNLANED) && existsSync(CLI));
  const v = Bun.spawnSync([CLI, "--version"], { env });
  check("turnlane --version", v.exitCode === 0 && v.stdout.toString().startsWith("turnlane "));
  // CLI の言語: 英語が正、TURNLANE_LANG=ja（設定・LANG が ja のときと同じ）なら日本語
  const helpEn = Bun.spawnSync([CLI, "--help"], { env }).stdout.toString();
  const helpJa = Bun.spawnSync([CLI, "--help"], {
    env: { ...env, TURNLANE_LANG: "ja" },
  }).stdout.toString();
  check(
    "turnlane --help is English by default and Japanese when the language is ja",
    helpEn.includes("Usage:") && helpJa.includes("使い方:"),
  );

  // M1: 匿名化フィクスチャを一時 HOME の ~/.claude と ~/.codex に置く（実データには触れない）
  const FX = join(ROOT, "packages/collectors/test/fixtures");
  for (const c of readdirSync(join(FX, "claude_code/2.1.x"))) {
    cpSync(join(FX, "claude_code/2.1.x", c, "projects"), join(home, ".claude/projects"), {
      recursive: true,
    });
  }
  cpSync(join(FX, "codex/0.147.x/desktop-guardian-aborted"), join(home, ".codex"), {
    recursive: true,
  });
  // hooks を入れる一時の設定ディレクトリ（CLAUDE_CONFIG_DIR 相当）
  const hooksDir = join(home, ".claude-hooks");
  const sid = "22222222-0000-4000-8000-000000000001";
  mkdirSync(join(hooksDir, "projects", "-smoke"), { recursive: true });

  // 1回目の起動: マイグレーションを適用
  const a = await startDaemon();
  check("turnlaned starts and /api/health responds", a.healthy);
  const token = readToken() ?? "";
  const h = (await (
    await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { db: { userVersion: number; schemaVersion: number } };
  check(
    "schema is up to date",
    h.db.userVersion === h.db.schemaVersion,
    `${h.db.userVersion}/${h.db.schemaVersion}`,
  );
  const index = await fetch(`${base}/`);
  const html = await index.text();
  check("embedded web UI is served", index.ok && html.includes('<div id="root">'));
  const js = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  const jsRes = js ? await fetch(`${base}${js}`) : null;
  check("embedded JS asset is served", jsRes?.ok === true, js ?? "no script tag");
  // turnlane daemon status / turnlane open（launchd には登録しない。status の launchctl print は読み取りのみ）
  const st = Bun.spawnSync([CLI, "daemon", "status"], { env });
  check(
    "turnlane daemon status reports running",
    st.exitCode === 0 && st.stdout.toString().includes("turnlaned: running"),
    st.stdout.toString().split("\n")[0],
  );
  const op = Bun.spawnSync([CLI, "open", "--print"], { env });
  const url = op.stdout.toString().trim();
  check("turnlane open --print prints the auth URL", op.exitCode === 0 && url.includes("/auth?t="));
  // ブラウザの動き: /auth でクッキーを受け取り、/ の画面が /api/health をクッキーで取る
  const authRes = await fetch(url, { redirect: "manual" });
  const cookie = (authRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const page = await fetch(`${base}${authRes.headers.get("location") ?? "/"}`, {
    headers: { cookie },
  });
  const viaCookie = await fetch(`${base}/api/health`, { headers: { cookie } });
  check(
    "browser flow: cookie → health screen → /api/health",
    page.ok && (await page.text()).includes('<div id="root">') && viaCookie.ok,
  );
  // その日のバックアップ（M0 完了条件）と turnlane backup / turnlane export
  const today = toLocalDate(Date.now(), systemTimeZone(), DEFAULT_DAY_BOUNDARY);
  const todayFile = `turnlane-${today.replaceAll("-", "")}.db`;
  const backupsDir = join(dataDir, "backups");
  check(
    "today's backup exists after start",
    existsSync(join(backupsDir, todayFile)),
    `backups/${todayFile}`,
  );
  const bk = Bun.spawnSync([CLI, "backup"], { env });
  check("turnlane backup (via daemon)", bk.exitCode === 0, bk.stdout.toString().trim());
  const exportFile = join(home, "export.jsonl");
  const ex = Bun.spawnSync([CLI, "export", "--json", "--out", exportFile], { env });
  const header = existsSync(exportFile)
    ? JSON.parse(readFileSync(exportFile, "utf8").split("\n")[0] ?? "{}")
    : {};
  check(
    "turnlane export --json writes JSON Lines with a header",
    ex.exitCode === 0 && header.format === "turnlane-export",
  );
  // M1: 取り込み → turnlane ai / turnlane queue / turnlane sources
  const api = async <T>(path: string): Promise<T> =>
    (await (
      await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as T;
  // M6-18: 新しい DB は同意の前に読まない → turnlane onboarding consent で始める
  await Bun.sleep(300);
  const pre = Bun.spawnSync([CLI, "ai", "--days", "62", "--json"], { env });
  const preItems =
    pre.exitCode === 0
      ? (JSON.parse(pre.stdout.toString()) as { days: { items: unknown[] }[] }).days.reduce(
          (n, d) => n + d.items.length,
          0,
        )
      : -1;
  const obSt = Bun.spawnSync([CLI, "onboarding", "status"], { env }).stdout.toString();
  check(
    "M6-18: before consent nothing is ingested (onboarding pending)",
    preItems === 0 && obSt.includes("waiting for consent"),
    `${preItems} items`,
  );
  const det = Bun.spawnSync([CLI, "onboarding", "detect", "--json"], { env });
  const detSources =
    det.exitCode === 0
      ? (JSON.parse(det.stdout.toString()) as { sources: { tool: string; sessions7d: number }[] })
          .sources
      : [];
  check(
    "M6-19: turnlane onboarding detect lists claude_code and codex with counts",
    detSources.some((x) => x.tool === "claude_code" && x.sessions7d > 0) &&
      detSources.some((x) => x.tool === "codex"),
  );
  const consent = Bun.spawnSync([CLI, "onboarding", "consent"], { env });
  check("M6-18: turnlane onboarding consent", consent.exitCode === 0);
  let ingested = false;
  for (let i = 0; i < 100 && !ingested; i++) {
    ingested = (await api<{ backfillDone: boolean }>("/api/sources")).backfillDone;
    if (!ingested) await Bun.sleep(100);
  }
  await Bun.sleep(1500); // derive runner のデバウンス（1秒）
  const aiOut = Bun.spawnSync([CLI, "ai", "--days", "62", "--json"], { env });
  const days =
    aiOut.exitCode === 0
      ? (JSON.parse(aiOut.stdout.toString()) as { days: { items: unknown[] }[] }).days
      : [];
  check(
    "M1: turnlane ai --days 62 shows work items from the fixtures",
    days.reduce((n, d) => n + d.items.length, 0) > 3,
    `${days.reduce((n, d) => n + d.items.length, 0)} items`,
  );
  check("M1: turnlane queue", Bun.spawnSync([CLI, "queue"], { env }).exitCode === 0);
  const src = Bun.spawnSync([CLI, "sources"], { env }).stdout.toString();
  check(
    "M1: turnlane sources lists claude_code / codex / hook_spool",
    ["claude_code", "codex", "hook_spool"].every((t) => src.includes(t)),
  );
  // M1: hooks（一時の設定ディレクトリに入れ、疑似イベントで即時に反映されることを確かめる）
  const hooksInst = Bun.spawnSync(
    [CLI, "hooks", "install", "--claude-dir", hooksDir, "--bin", CLI],
    {
      env,
    },
  );
  const settings = existsSync(join(hooksDir, "settings.json"))
    ? readFileSync(join(hooksDir, "settings.json"), "utf8")
    : "";
  check(
    "M1: turnlane hooks install writes the turnlane handlers",
    hooksInst.exitCode === 0 && settings.includes("--managed-by turnlane"),
  );
  const t0 = Date.now();
  writeFileSync(
    join(hooksDir, "projects", "-smoke", `${sid}.jsonl`),
    `${JSON.stringify({ type: "user", sessionId: sid, uuid: "u1", promptId: "p1", timestamp: new Date(t0).toISOString(), isSidechain: false, cwd: "/tmp", gitBranch: "main", version: "2.1.287", entrypoint: "cli", origin: { kind: "human" }, promptSource: "typed", message: { role: "user", content: "(prompt)" } })}\n`,
  );
  const hookEnv = { ...env, CLAUDE_CONFIG_DIR: hooksDir };
  const fire = (name: string) =>
    Bun.spawnSync([CLI, "hook", "--tool", "claude_code", "--managed-by", "turnlane"], {
      env: hookEnv,
      stdin: new TextEncoder().encode(
        JSON.stringify({
          hook_event_name: name,
          session_id: sid,
          cwd: "/tmp",
          prompt: "SENTINEL_BODY_smoke",
        }),
      ),
    });
  fire("UserPromptSubmit");
  await Bun.sleep(300);
  const t1 = Date.now();
  fire("PermissionRequest");
  let seenMs = -1;
  while (Date.now() - t1 < 5000) {
    const q = await api<{ items: { status: string; followUps: { kind: string }[] }[] }>(
      "/api/queue",
    );
    if (
      q.items.some(
        (x) => x.status === "needs_input" && x.followUps.some((f) => f.kind === "approve"),
      )
    ) {
      seenMs = Date.now() - t1;
      break;
    }
    await Bun.sleep(100);
  }
  check(
    "M1: hooks reach turnlane queue within 3 seconds (PermissionRequest → approve)",
    seenMs >= 0 && seenMs <= 3000,
    `${seenMs}ms`,
  );
  const hooksUn = Bun.spawnSync(
    [CLI, "hooks", "uninstall", "--claude-dir", hooksDir, "--bin", CLI],
    {
      env,
    },
  );
  check(
    "M1: turnlane hooks uninstall",
    hooksUn.exitCode === 0 &&
      !readFileSync(join(hooksDir, "settings.json"), "utf8").includes("turnlane"),
  );
  // D-145: MCP の登録（一時の設定ディレクトリの .claude.json と一時 HOME の ~/.codex/config.toml。単一バイナリの TOML の読み書き）
  const mcpArgs = ["--claude-dir", hooksDir, "--codex", "--bin", CLI];
  const mcpInst = Bun.spawnSync([CLI, "mcp", "install", ...mcpArgs], { env });
  const mcpSt = Bun.spawnSync([CLI, "mcp", "status", "--json", ...mcpArgs], { env });
  let mcpStates: string[] = [];
  try {
    mcpStates = (
      JSON.parse(mcpSt.stdout.toString()) as { targets: { state: string }[] }
    ).targets.map((t) => t.state);
  } catch {}
  check(
    "D-145: turnlane mcp install registers turnlane in Claude Code and Codex",
    mcpInst.exitCode === 0 &&
      mcpStates.join(",") === "installed,installed" &&
      readFileSync(join(hooksDir, ".claude.json"), "utf8").includes('"turnlane"') &&
      readFileSync(join(home, ".codex", "config.toml"), "utf8").includes("[mcp_servers.turnlane]"),
    mcpInst.stderr.toString(),
  );
  const mcpUn = Bun.spawnSync([CLI, "mcp", "uninstall", ...mcpArgs], { env });
  check(
    "D-145: turnlane mcp uninstall",
    mcpUn.exitCode === 0 &&
      !readFileSync(join(home, ".codex", "config.toml"), "utf8").includes("turnlane"),
  );
  const unauth = await fetch(`${base}/api/health`);
  check("/api requires auth", unauth.status === 401);
  const auth = await fetch(`${base}/auth?t=${token}`, { redirect: "manual" });
  check("/auth issues cookie", (auth.headers.get("set-cookie") ?? "").includes("HttpOnly"));
  // M2: ボード系 API、turnlane add / ls（外部の識別子で冪等）、turnlane mcp
  const tomorrow = toLocalDate(Date.now() + 86_400_000, systemTimeZone(), DEFAULT_DAY_BOUNDARY);
  const boardRes = await fetch(`${base}/api/board?from=${today}&to=${tomorrow}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const boardBody = (await boardRes.json()) as { days?: unknown[] };
  check("M2: /api/board returns day columns", boardRes.ok && boardBody.days?.length === 2);
  const add = Bun.spawnSync([CLI, "add", "Smoke", "task", "--date", tomorrow, "--est", "15"], {
    env,
  });
  const ls = Bun.spawnSync([CLI, "ls", "--date", tomorrow], { env });
  check(
    "M2: turnlane add → turnlane ls",
    add.exitCode === 0 && ls.stdout.toString().includes("Smoke task"),
    ls.stdout.toString().trim(),
  );
  for (let i = 0; i < 2; i++)
    Bun.spawnSync([CLI, "add", "External", "--source", "github", "--external-id", "smoke-1"], {
      env,
    });
  const inbox = Bun.spawnSync([CLI, "ls", "--inbox", "--json"], { env });
  const inboxTasks = (JSON.parse(inbox.stdout.toString() || "{}") as { tasks?: unknown[] }).tasks;
  check(
    "M2: turnlane add with --source / --external-id twice makes one task",
    inboxTasks?.length === 1,
  );
  const mcp = Bun.spawn([CLI, "mcp"], { env, stdin: "pipe", stdout: "pipe" });
  mcp.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "smoke" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
  );
  mcp.stdin.end();
  const mcpOut = await new Response(mcp.stdout).text();
  check("M2: turnlane mcp answers initialize and tools/list", mcpOut.includes('"add_task"'));
  // M3: ヘルパ未接続でもカレンダーの状態・設定が使える（EventKit・ヘルパには触れない）
  const calSt = Bun.spawnSync([CLI, "calendar", "status"], { env });
  check(
    "M3: turnlane calendar status without the helper says not connected",
    calSt.exitCode === 0 && calSt.stdout.toString().includes("Helper: not connected"),
  );
  const ek = await fetch(`${base}/internal/ek`, {
    headers: { upgrade: "websocket", connection: "Upgrade" },
  });
  check("M3: /internal/ek requires the token", ek.status === 401);
  const cfgSet = Bun.spawnSync([CLI, "config", "set", "workdays.weekdays", "[1,2,3,4,5,6]"], {
    env,
  });
  const cfgGet = Bun.spawnSync([CLI, "config", "get", "workdays.weekdays"], { env });
  const cfgBad = Bun.spawnSync([CLI, "config", "set", "workdays.weekdays", "[]"], { env });
  check(
    "M3: turnlane config set / get / validation",
    cfgSet.exitCode === 0 &&
      cfgGet.stdout.toString().trim() === "[1,2,3,4,5,6]" &&
      cfgBad.exitCode === 1,
  );
  // D-059: 開くアプリの設定と、任意のパスを受け付けないこと（何も起動しない）
  const editorSet = Bun.spawnSync([CLI, "config", "set", "open.editor", "cursor"], { env });
  const openApps = await api<{ editor?: { selected: string } }>("/api/open/apps");
  const openBad = await fetch(`${base}/api/open`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ path: "/etc" }),
  });
  check(
    "D-059: turnlane config set open.editor, /api/open/apps, /api/open rejects a raw path",
    editorSet.exitCode === 0 && openApps.editor?.selected === "cursor" && openBad.status === 400,
  );

  await stop(a.proc);

  // 2回目の起動: 再適用しない（S4 の C5）
  const b = await startDaemon();
  check("turnlaned restarts", b.healthy);
  await stop(b.proc);
  const migrated = logEvents().filter((e) => e.event === "db.migrated").length;
  const started = logEvents().filter((e) => e.event === "daemon.started").length;
  check("migrations applied exactly once over two starts", migrated === 1 && started === 2);

  const stStopped = Bun.spawnSync([CLI, "daemon", "status"], { env });
  check("turnlane daemon status exits 3 when stopped", stStopped.exitCode === 3);

  // self-install --dry-run / --no-load（一時 HOME。launchd には登録しない）
  const dry = Bun.spawnSync([CLI, "self-install", "--dry-run"], { env });
  check(
    "turnlane self-install --dry-run writes nothing",
    dry.exitCode === 0 && !existsSync(join(home, ".local", "bin", "turnlane")),
  );
  const inst = Bun.spawnSync([CLI, "self-install", "--no-load"], { env });
  const installed = join(home, ".local", "bin", "turnlane");
  const plist = join(home, "Library", "LaunchAgents", "dev.turnlane.daemon.plist");
  check(
    "turnlane self-install --no-load copies binaries and writes the plist",
    inst.exitCode === 0 && existsSync(installed) && existsSync(plist),
    inst.stderr.toString().trim(),
  );
  const lint = Bun.spawnSync(["/usr/bin/plutil", "-lint", plist]);
  check("generated plist passes plutil -lint", lint.exitCode === 0);
  const un = Bun.spawnSync([installed, "uninstall"], { env });
  check(
    "turnlane uninstall removes binaries and plist",
    un.exitCode === 0 && !existsSync(installed) && !existsSync(plist),
  );

  // M1: DB の監査（本文の混入なし）
  const doc = Bun.spawnSync([CLI, "doctor"], { env });
  check(
    "M1: turnlane doctor audit finds no long text values",
    doc.exitCode === 0,
    doc.stdout.toString().split("\n")[1] ?? "",
  );
  const spoolText = readdirSync(join(dataDir, "spool"))
    .map((f) => readFileSync(join(dataDir, "spool", f), "utf8"))
    .join("");
  check("M1: hook bodies never reach the spool", !spoolText.includes("SENTINEL_BODY"));

  // M6-6: 共有用の診断にホームのパスが出ない
  const red = Bun.spawnSync([CLI, "doctor", "--redact"], { env });
  const redText = red.stdout.toString();
  check(
    "M6-6: turnlane doctor --redact hides the home path",
    red.exitCode === 0 && redText.startsWith("Turnlane diagnostics") && !redText.includes(home),
  );

  // M6-12: 更新確認（偽の確認先）。オフなら接続しない。オンなら GET だけ（User-Agent turnlane/<版>、Cookie なし）
  const c = await startDaemon();
  check("turnlaned restarts for the update check", c.healthy);
  const tok = readToken() ?? "";
  const upd = (method: string) =>
    fetch(`${base}/api/update${method === "POST" ? "/check" : ""}`, {
      method,
      headers: { authorization: `Bearer ${tok}` },
    });
  Bun.spawnSync([CLI, "config", "set", "update.check", "false"], { env });
  const off = await upd("POST");
  check("M6-12: update.check=false → no request", off.status === 409 && feedSeen.length === 0);
  Bun.spawnSync([CLI, "config", "set", "update.check", "true"], { env });
  const on = await upd("POST");
  const onBody = (await on.json()) as { available?: boolean };
  const h0 = feedSeen[0] ?? {};
  check(
    "M6-12: update check sends one GET with only a turnlane User-Agent",
    on.ok &&
      onBody.available === true &&
      feedSeen.length === 1 &&
      /^turnlane\/\S+$/.test(h0["user-agent"] ?? "") &&
      h0.cookie === undefined,
  );
  const docU = Bun.spawnSync([CLI, "doctor"], { env }).stdout.toString();
  check("M6-12: turnlane doctor shows the available version", docU.includes("999.0.0"));
  await stop(c.proc);

  // 実データの場所に書いていない（一時 HOME の下だけ）
  check("data stays under the temporary HOME", readdirSync(dataDir).includes("turnlane.db"));
} finally {
  feed.stop(true);
  rmSync(home, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke: all checks passed");
