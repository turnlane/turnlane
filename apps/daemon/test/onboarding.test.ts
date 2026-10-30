import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import {
  FakeClock,
  migrate,
  migrations,
  ONBOARDING_KEY,
  openDatabase,
  resolvePaths,
  type TurnlanePaths,
} from "@turnlane/core";
import type {
  CalendarConnectAttempt,
  CalendarConnectResponse,
  DetectedSourceView,
  DetectResponse,
  HooksInstallResponse,
  HooksInstallTarget,
  ImportProgress,
  McpInstallResponse,
  OnboardingBoard,
  OnboardingSummary,
  OnboardingView,
  QueueItem,
} from "@turnlane/core/api";
import { CalendarConnectError } from "../src/calendar/connect.ts";
import { FakeCalendarProvider } from "../src/calendar/provider.ts";
import type { SourceView } from "../src/http/ai-routes.ts";
import type { SseMessage } from "../src/http/sse.ts";
import { FakeGit } from "../src/ingest/git.ts";
import { type RunningDaemon, startDaemon } from "../src/main.ts";
import { NotifyRunner } from "../src/notify/runner.ts";
import { installCodexCase } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const DAY = 86_400_000;
let home: string;
let daemon: RunningDaemon | null = null;

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  rmSync(home, { recursive: true, force: true });
});

/** k 日前（k=0..n-1）に1本ずつセッションを書き、ファイルの更新時刻を最後の出来事に合わせる */
function writeSessions(root: string, now: number, n: number): void {
  for (let k = 0; k < n; k++) {
    const end = now - k * DAY - 2 * 3_600_000;
    const w = claudeTranscript(root, {
      sid: `00000000-0000-4000-8000-${String(k).padStart(12, "0")}`,
      cwd: `/w/app${k}`,
      branch: `feat/${k}`,
    });
    w.human(end - 20 * 60_000);
    w.assistantEnd(end, "Done. Should I also update the docs?");
    utimesSync(w.path, new Date(end), new Date(end));
  }
}

async function api<T>(d: RunningDaemon, method: string, path: string, body?: unknown) {
  const res = await fetch(`${d.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${d.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: (await res.json()) as T };
}

async function start(paths: TurnlanePaths, clock: FakeClock, git = new FakeGit()) {
  daemon = await startDaemon({
    paths,
    logger: nullLogger,
    port: 0,
    clock,
    ingest: { git, noWatch: true },
    calendar: false,
    summary: false,
  });
  return daemon;
}

function count(paths: TurnlanePaths, sql: string): number {
  const db = openDatabase(paths.dbPath, { readonly: true });
  try {
    return db.query<{ n: number }, []>(sql).get()?.n ?? 0;
  } finally {
    db.close();
  }
}

describe("同意のゲート（onboarding.md 5.1・5.2、M6-18）", () => {
  test("新しい DB は同意の前に検出だけをし、同意で取り込みを始める。外した元は読まない", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-onb-"));
    const now = Date.now();
    writeSessions(join(home, ".claude"), now, 3);
    installCodexCase(home, "desktop-guardian-aborted");
    const paths = resolvePaths({ HOME: home }, home);
    const d = await start(paths, new FakeClock(now));
    await Bun.sleep(50);
    const v = await api<OnboardingView>(d, "GET", "/api/onboarding");
    expect(v.data).toMatchObject({ state: "pending", consented: false, consentedAt: null });
    // 検出（ai_source の登録）だけ。セッション・カーソル・hooks の状態は読まない
    expect(count(paths, "SELECT count(*) AS n FROM ai_source")).toBe(4);
    expect(count(paths, "SELECT count(*) AS n FROM ingest_cursor")).toBe(0);
    expect(count(paths, "SELECT count(*) AS n FROM ai_session")).toBe(0);
    await d.supervisor?.reconcile();
    await d.supervisor?.reingest();
    expect(count(paths, "SELECT count(*) AS n FROM ingest_cursor")).toBe(0);
    expect(d.onboarding.muted()).toBe(true);

    const det = await api<DetectResponse>(d, "GET", "/api/onboarding/detect");
    expect(det.data.sources.map((s) => s.tool).sort()).toEqual(["claude_code", "codex"]);
    const claude = det.data.sources.find((s) => s.tool === "claude_code") as DetectedSourceView;
    expect(claude).toMatchObject({
      label: "default",
      sessions7d: 3,
      readable: true,
    });
    expect(claude.lastActivityAt).toBeGreaterThan(now - DAY);
    expect(det.data.claudeDesktop.present).toBe(false);
    // 検出の後も読んでいない
    expect(count(paths, "SELECT count(*) AS n FROM ingest_cursor")).toBe(0);

    // 同意の前は MCP の登録（他ツールの設定ファイル）も読まない（D-145）
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { turnlane: { command: "/nonexistent/turnlane", args: ["mcp"] } },
      }),
    );
    const pre = await api<{ sources: SourceView[] }>(d, "GET", "/api/sources");
    expect(pre.data.sources.map((s) => s.mcpState)).toEqual([
      "unknown",
      "unknown",
      "unknown",
      "unknown",
    ]);

    // 段は同意なしに sources を done にできない
    expect(
      (await api(d, "PUT", "/api/onboarding/step", { step: "sources", status: "done" })).status,
    ).toBe(409);
    expect(
      (await api(d, "POST", "/api/onboarding/consent", { enabledSourceIds: ["nope"] })).status,
    ).toBe(400);

    const c = await api<OnboardingView>(d, "POST", "/api/onboarding/consent", {
      enabledSourceIds: [claude.id],
    });
    expect(c.data).toMatchObject({ state: "consented", consented: true, step: "import" });
    for (let i = 0; i < 200 && !d.supervisor?.backfillDone; i++) await Bun.sleep(10);
    expect(count(paths, "SELECT count(*) AS n FROM ai_session WHERE tool = 'claude_code'")).toBe(3);
    expect(count(paths, "SELECT count(*) AS n FROM ai_session WHERE tool = 'codex'")).toBe(0);
    expect(
      count(paths, "SELECT count(*) AS n FROM ai_source WHERE tool = 'codex' AND enabled = 0"),
    ).toBe(1);
    // 同意の後は取り込み元ごとに MCP の登録の状態を出す（~/.claude は ~/.claude.json。指す先が無ければ outdated）
    const after = await api<{ sources: SourceView[] }>(d, "GET", "/api/sources");
    expect(after.data.sources.find((s) => s.tool === "claude_code")?.mcpState).toBe("outdated");
    expect(after.data.sources.find((s) => s.tool === "codex")?.mcpState).toBe("none");
    // 流れが済むまで通知は止めたまま
    expect(d.onboarding.muted()).toBe(true);
    for (const step of ["import", "calendar", "hooks", "mcp", "hours", "notifications", "start"])
      await api(d, "PUT", "/api/onboarding/step", { step, status: "done" });
    const done = await api<OnboardingView>(d, "GET", "/api/onboarding");
    expect(done.data.state).toBe("done");
    expect(d.onboarding.muted()).toBe(false);
    // 再起動しても同意は残る（設定に保存）
    const restart = await api<OnboardingView>(d, "POST", "/api/onboarding/restart");
    expect(restart.data).toMatchObject({ state: "consented", step: "sources", consented: true });
  });

  test("取り込むのは直近7日だけ（D-181）。それより前のファイルは同意の後も、後の走査でも読まない", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-onb-"));
    // 今は金曜の昼。セッションは毎日 10:00 に終わる（今日から10日前まで）
    const now = new Date(2026, 9, 2, 12, 0).getTime();
    writeSessions(join(home, ".claude"), now, 11);
    const paths = resolvePaths({ HOME: home }, home);
    const d = await start(paths, new FakeClock(now));
    const det = await api<DetectResponse>(d, "GET", "/api/onboarding/detect");
    const claude = det.data.sources.find((s) => s.tool === "claude_code") as DetectedSourceView;
    // 件数は取り込む範囲と同じ（今日と6日前までの7日）
    expect(claude.sessions7d).toBe(7);
    expect("sessions30d" in claude).toBe(false);
    const c = await api<OnboardingView>(d, "POST", "/api/onboarding/consent", {
      enabledSourceIds: [claude.id],
    });
    expect(c.data.importSince).toBe(new Date(2026, 8, 26, 4, 0).getTime());
    for (let i = 0; i < 200 && !d.supervisor?.backfillDone; i++) await Bun.sleep(10);
    expect(count(paths, "SELECT count(*) AS n FROM ai_session")).toBe(7);
    await d.supervisor?.reconcile();
    await d.supervisor?.whenIdle();
    expect(count(paths, "SELECT count(*) AS n FROM ai_session")).toBe(7);
    expect(count(paths, "SELECT count(*) AS n FROM ingest_cursor")).toBe(7);
  });

  test("取り込みのカーソルがある DB（既存の利用者）は、同意済み・済み（done）として始める", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-onb-"));
    const now = Date.now();
    writeSessions(join(home, ".claude"), now, 1);
    const paths = resolvePaths({ HOME: home }, home);
    mkdirSync(paths.dataDir, { recursive: true });
    const db = openDatabase(paths.dbPath);
    migrate(db, migrations);
    db.run(
      "INSERT INTO ai_source (id, tool, root_path, profile_label, created_at, updated_at) VALUES ('s1', 'codex', '/x/.codex', 'default', 1, 1)",
    );
    db.run(
      "INSERT INTO ingest_cursor (source_id, stream_key, kind, parser_id, parser_version, updated_at) VALUES ('s1', 'a', 'jsonl', 'p', 1, 4242), ('s1', 'b', 'jsonl', 'p', 1, 5000)",
    );
    db.close();
    const d = await start(paths, new FakeClock(now));
    expect(d.onboarding.state()).toMatchObject({ state: "done", consentedAt: 4242 });
    for (let i = 0; i < 200 && !d.supervisor?.backfillDone; i++) await Bun.sleep(10);
    expect(count(paths, "SELECT count(*) AS n FROM ai_session WHERE tool = 'claude_code'")).toBe(1);
    // まとめての取り込み（カーソルの無い新しい取り込み元）が終われば通知を止めない
    expect(d.supervisor?.bulkImporting).toBe(false);
    expect(d.onboarding.muted()).toBe(false);
    const raw = openDatabase(paths.dbPath, { readonly: true });
    const row = raw
      .query<{ value_json: string; sync_scope: string }, [string]>(
        "SELECT value_json, sync_scope FROM setting WHERE key = ?",
      )
      .get(ONBOARDING_KEY);
    raw.close();
    expect(row?.sync_scope).toBe("local_only");
    expect(JSON.parse(row?.value_json ?? "{}").state).toBe("done");
  });
});

describe("検出の API と Choose a folder…（M6-19）", () => {
  test("projects/ のある設定ディレクトリを手で足すと取り込み元になる。だめなパスは 400", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-onb-"));
    const now = Date.now();
    const custom = join(home, "elsewhere", "my-claude");
    writeSessions(custom, now, 2);
    const paths = resolvePaths({ HOME: home }, home);
    const d = await start(paths, new FakeClock(now));
    expect((await api<DetectResponse>(d, "GET", "/api/onboarding/detect")).data.sources).toEqual(
      [],
    );
    for (const path of ["relative/dir", `${home}/../x`, join(home, "nothing")]) {
      expect((await api(d, "POST", "/api/onboarding/sources", { path })).status).toBe(400);
    }
    const r = await api<DetectedSourceView>(d, "POST", "/api/onboarding/sources", { path: custom });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      tool: "claude_code",
      label: "my-claude",
      rootPath: custom,
      manual: true,
      sessions7d: 2,
    });
    const det = await api<DetectResponse>(d, "GET", "/api/onboarding/detect");
    expect(det.data.sources.map((s) => s.rootPath)).toEqual([custom]);
    // 同じものをもう一度足しても1つ
    await api(d, "POST", "/api/onboarding/sources", { path: `${custom}/` });
    expect(
      (await api<DetectResponse>(d, "GET", "/api/onboarding/detect")).data.sources,
    ).toHaveLength(1);
    // 同意の前なので読んでいない
    expect(count(paths, "SELECT count(*) AS n FROM ai_session")).toBe(0);
  });
});

describe("新しい日からの取り込みと進捗（M6-20）", () => {
  test("日は新しい順に完了し（済んだ日は戻らない）、7日分の後に要約の数字が揃う", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-onb-"));
    // 実際の日付・時刻に依存しないよう時計を固定する（ローカルの正午。日の境目と
    // セッションの時刻が同じ日に収まる）
    const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
    // 9日分（7日の窓の外も含む）
    writeSessions(join(home, ".claude"), now, 9);
    const paths = resolvePaths({ HOME: home }, home);
    const d = await start(paths, new FakeClock(now));
    const snaps: ImportProgress[] = [];
    // SSE（import_progress）を記録する
    const res = await fetch(`${d.url}/api/events`, {
      headers: { authorization: `Bearer ${d.token}` },
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let buf = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
        let i = buf.indexOf("\n\n");
        while (i >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.includes("event: import_progress")) {
            const line = block.split("\n").find((l) => l.startsWith("data: ")) ?? "";
            snaps.push(JSON.parse(line.slice(6)) as ImportProgress);
          }
          i = buf.indexOf("\n\n");
        }
      }
    })();
    const before = await api<ImportProgress>(d, "GET", "/api/onboarding/progress");
    expect(before.data.days).toHaveLength(7);
    expect(before.data.days.every((x) => x.state === "pending")).toBe(true);
    expect(before.data.doneAt).toBeNull();
    const det = await api<DetectResponse>(d, "GET", "/api/onboarding/detect");
    await api(d, "POST", "/api/onboarding/consent", {
      enabledSourceIds: det.data.sources.map((s) => s.id),
    });
    for (let i = 0; i < 300 && !d.supervisor?.backfillDone; i++) await Bun.sleep(10);
    await Bun.sleep(400); // SSE の束ね（250ms）
    await reader.cancel();
    await pump.catch(() => {});
    const after = await api<ImportProgress>(d, "GET", "/api/onboarding/progress");
    expect(after.data.days.every((x) => x.state === "done")).toBe(true);
    expect(after.data.doneAt).not.toBeNull();
    expect(after.data.sources).toEqual([
      { id: det.data.sources[0]?.id as string, state: "done", skipped: 0 },
    ]);
    // どのスナップショットでも、済んだ日は新しい日からの連続（今日 → 昨日 → …）
    expect(snaps.length).toBeGreaterThan(1);
    for (const s of snaps) {
      const st = s.days.map((x) => x.state);
      const firstNotDone = st.findIndex((x) => x !== "done");
      if (firstNotDone >= 0) expect(st.slice(firstNotDone).includes("done")).toBe(false);
    }
    // 途中の状態（一部の日だけ済んだ）が見えている
    expect(snaps.some((s) => s.days.some((x) => x.state === "done") && s.doneAt === null)).toBe(
      true,
    );
    const sum = await api<OnboardingSummary>(d, "GET", "/api/onboarding/summary?days=7");
    expect(sum.data).toMatchObject({ days: 7, cards: 7, complete: true });
    expect(sum.data.aiMs).toBeGreaterThan(0);
    expect(sum.data.waits).toBe(7);
    expect((await api(d, "GET", "/api/onboarding/summary?days=0")).status).toBe(400);
    // O3 の列: 新しい日が先頭で、ラベルの数と要約の件数が同じ（review §5 の 18）
    const board = await api<OnboardingBoard>(d, "GET", "/api/onboarding/board?days=7");
    expect(board.data.days).toHaveLength(7);
    expect(board.data.days[0]?.date).toBe(board.data.to);
    expect(board.data.days.reduce((n, x) => n + x.items.length, 0)).toBe(sum.data.cards);
    expect(board.data.days.reduce((n, x) => n + x.aiMs, 0)).toBe(sum.data.aiMs);
    const first = board.data.days.find((x) => x.items.length > 0)?.items[0];
    expect(first?.startAt).toBeLessThanOrEqual(first?.endAt ?? 0);
  });
});

describe("O4〜O5a の API（M6-23・M6-24）: hooks・MCP のインストールとカレンダーの接続", () => {
  test("同意した取り込み元の設定ディレクトリごとに hooks を入れる（dryRun は書かない）。Codex は承認待ち", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-onb-"));
    const now = Date.now();
    writeSessions(join(home, ".claude"), now, 1);
    writeSessions(join(home, ".claude-acme"), now, 1);
    installCodexCase(home, "desktop-guardian-aborted");
    // Claude の設定には他ツールの項目が入っている（触らない）
    writeFileSync(join(home, ".claude", "settings.json"), '{\n  "theme": "dark"\n}\n');
    const paths = resolvePaths({ HOME: home }, home);
    const d = await start(paths, new FakeClock(now));
    // 同意の前は 409
    expect((await api(d, "POST", "/api/onboarding/hooks", { dryRun: true })).status).toBe(409);
    const det = await api<DetectResponse>(d, "GET", "/api/onboarding/detect");
    // acme は外して同意する → 対象は既定の Claude と Codex だけ
    const ids = det.data.sources.filter((s) => s.label !== "acme").map((s) => s.id);
    await api(d, "POST", "/api/onboarding/consent", { enabledSourceIds: ids });
    const dry = await api<HooksInstallResponse>(d, "POST", "/api/onboarding/hooks", {
      dryRun: true,
    });
    expect(dry.status).toBe(200);
    expect(dry.data.dryRun).toBe(true);
    expect(dry.data.targets.map((t) => t.tool).sort()).toEqual(["claude_code", "codex"]);
    const claude = dry.data.targets.find((t) => t.tool === "claude_code") as HooksInstallTarget;
    expect(claude.added.length).toBeGreaterThan(0);
    expect(claude.changed).toBe(true);
    expect(claude.error).toBeNull();
    // dryRun は書かない
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(
      '{\n  "theme": "dark"\n}\n',
    );
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);

    const r = await api<HooksInstallResponse>(d, "POST", "/api/onboarding/hooks", {});
    expect(r.data.failed).toBe(0);
    const c2 = r.data.targets.find((t) => t.tool === "claude_code") as HooksInstallTarget;
    expect(c2.backup).toMatch(/settings\.json\.bak-turnlane-/);
    const written = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(written.theme).toBe("dark");
    expect(Object.keys(written.hooks).length).toBe(c2.added.length);
    const codex = r.data.targets.find((t) => t.tool === "codex") as HooksInstallTarget;
    expect(codex.needsApproval).toBe(true);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(true);
    // 2回目は変更なし（冪等）。Codex はまだ承認が無いので承認待ちのまま
    const again = await api<HooksInstallResponse>(d, "POST", "/api/onboarding/hooks", {});
    expect(again.data.targets.every((t) => !t.changed && t.unchanged.length > 0)).toBe(true);
    expect(again.data.targets.find((t) => t.tool === "codex")?.needsApproval).toBe(true);
    // 段は進めない（画面が Continue で進める）
    expect((await api<OnboardingView>(d, "GET", "/api/onboarding")).data.step).toBe("import");
    // 取り込みの検出で hooks_state が installed / pending_trust になる
    await d.supervisor?.whenIdle();
    await d.supervisor?.reconcile();
    const src = await api<{ sources: SourceView[] }>(d, "GET", "/api/sources");
    expect(src.data.sources.find((s) => s.tool === "codex")?.hooksState).toBe("pending_trust");
    expect(src.data.sources.find((s) => s.rootPath === join(home, ".claude"))?.hooksState).toBe(
      "installed",
    );
    // 外した acme には何も書いていない
    expect(existsSync(join(home, ".claude-acme", "settings.json"))).toBe(false);
  });

  test("壊れた settings.json は読めないと返し、ほかの対象は進める", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-onb-"));
    const now = Date.now();
    writeSessions(join(home, ".claude"), now, 1);
    installCodexCase(home, "desktop-guardian-aborted");
    writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
    const paths = resolvePaths({ HOME: home }, home);
    const d = await start(paths, new FakeClock(now));
    const det = await api<DetectResponse>(d, "GET", "/api/onboarding/detect");
    await api(d, "POST", "/api/onboarding/consent", {
      enabledSourceIds: det.data.sources.map((s) => s.id),
    });
    const r = await api<HooksInstallResponse>(d, "POST", "/api/onboarding/hooks", {});
    expect(r.data.failed).toBe(1);
    expect(r.data.targets.find((t) => t.tool === "claude_code")?.error).toBe("unreadable");
    expect(r.data.targets.find((t) => t.tool === "codex")?.changed).toBe(true);
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe("{ not json");
  });

  test("MCP は同意した取り込み元にだけ turnlane の項目を足す（D-145）。登録済みなら変更なし", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-onb-"));
    const now = Date.now();
    writeSessions(join(home, ".claude"), now, 1);
    installCodexCase(home, "desktop-guardian-aborted");
    const paths = resolvePaths({ HOME: home }, home);
    const d = await start(paths, new FakeClock(now));
    expect((await api(d, "POST", "/api/onboarding/mcp", {})).status).toBe(409);
    const det = await api<DetectResponse>(d, "GET", "/api/onboarding/detect");
    await api(d, "POST", "/api/onboarding/consent", {
      enabledSourceIds: det.data.sources.map((s) => s.id),
    });
    const dry = await api<McpInstallResponse>(d, "POST", "/api/onboarding/mcp", { dryRun: true });
    expect(dry.data.targets.map((t) => t.action).sort()).toEqual(["added", "added"]);
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    const r = await api<McpInstallResponse>(d, "POST", "/api/onboarding/mcp", {});
    expect(r.data.failed).toBe(0);
    expect(r.data.targets.every((t) => t.changed && t.action === "added")).toBe(true);
    const cfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(cfg.mcpServers.turnlane.command).toBe(r.data.cli);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain(
      "[mcp_servers.turnlane]",
    );
    const again = await api<McpInstallResponse>(d, "POST", "/api/onboarding/mcp", {});
    expect(again.data.targets.every((t) => t.action === "none" && !t.changed)).toBe(true);
    expect((await api<OnboardingView>(d, "GET", "/api/onboarding")).data.step).toBe("import");
  });

  test("カレンダーの接続は渡した手段を起動し、無ければ unavailable。設定の画面も同じ", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-onb-"));
    const paths = resolvePaths({ HOME: home }, home);
    const d0 = await start(paths, new FakeClock(Date.now()));
    const none = await api<CalendarConnectResponse>(d0, "POST", "/api/onboarding/calendar/connect");
    expect(none.data).toEqual({ started: false, reason: "unavailable" });
    expect(
      (await api(d0, "POST", "/api/onboarding/open-settings", { pane: "calendars" })).status,
    ).toBe(409);
    await d0.stop();
    daemon = null;

    const calls: string[] = [];
    const provider = new FakeCalendarProvider({ connected: false, authorization: "notDetermined" });
    daemon = await startDaemon({
      paths,
      logger: nullLogger,
      port: 0,
      ingest: false,
      summary: false,
      calendar: {
        provider,
        connect: async () => {
          calls.push("connect");
          provider.setConnected(true);
          provider.setAuthorization("fullAccess");
        },
      },
      openSettings: async (pane) => {
        calls.push(`open:${pane}`);
        return true;
      },
    });
    const d = daemon;
    const r = await api<CalendarConnectResponse>(d, "POST", "/api/onboarding/calendar/connect");
    expect(r.data).toMatchObject({ started: true, reason: null, attempt: { id: 1 } });
    for (let i = 0; i < 100 && !provider.connected(); i++) await Bun.sleep(10);
    expect(calls).toEqual(["connect"]);
    const st = await api<{ connected: boolean; authorization: string | null }>(
      d,
      "GET",
      "/api/calendar/status",
    );
    expect(st.data.connected).toBe(true);
    const o = await api<{ opened: boolean }>(d, "POST", "/api/onboarding/open-settings", {
      pane: "notifications",
    });
    expect(o.data.opened).toBe(true);
    expect(calls).toEqual(["connect", "open:notifications"]);
    expect((await api(d, "POST", "/api/onboarding/open-settings", { pane: "nope" })).status).toBe(
      400,
    );
    await d.stop();
    daemon = null;

    // すぐ失敗する手段（ヘルパを置けないなど）は failed。時間のかかるもの（OS のダイアログ）は待たずに started
    daemon = await startDaemon({
      paths,
      logger: nullLogger,
      port: 0,
      ingest: false,
      summary: false,
      calendar: {
        provider: new FakeCalendarProvider({ connected: false }),
        connect: async () => {
          throw new Error("install failed");
        },
      },
    });
    const bad = await api<CalendarConnectResponse>(
      daemon,
      "POST",
      "/api/onboarding/calendar/connect",
    );
    expect(bad.data).toMatchObject({
      started: false,
      reason: "failed",
      attempt: { id: 1, state: "failed", detail: "install failed" },
    });
    await daemon.stop();
    daemon = null;

    // 時間のかかる失敗（authorize が 1 で終わった。Neo の不具合 2026-10-21）: started の後、GET で失敗の理由を読める
    let finish: (e?: Error) => void = () => {};
    daemon = await startDaemon({
      paths,
      logger: nullLogger,
      port: 0,
      ingest: false,
      summary: false,
      calendar: {
        provider: new FakeCalendarProvider({ connected: true, authorization: "notDetermined" }),
        connect: () =>
          new Promise<void>((res, rej) => {
            finish = (e) => (e ? rej(e) : res());
          }),
      },
    });
    const none0 = await api<{ attempt: CalendarConnectAttempt | null }>(
      daemon,
      "GET",
      "/api/onboarding/calendar/connect",
    );
    expect(none0.data.attempt).toBeNull();
    const slow = await api<CalendarConnectResponse>(
      daemon,
      "POST",
      "/api/onboarding/calendar/connect",
    );
    expect(slow.data).toMatchObject({ started: true, attempt: { state: "running" } });
    finish(new CalendarConnectError("authorize", 1, "macOS did not show the dialog."));
    await Bun.sleep(10);
    const after = await api<{ attempt: CalendarConnectAttempt | null }>(
      daemon,
      "GET",
      "/api/onboarding/calendar/connect",
    );
    expect(after.data.attempt).toMatchObject({
      id: 1,
      state: "failed",
      code: 1,
      detail: "macOS did not show the dialog.",
    });
    expect(after.data.attempt?.finishedAt).not.toBeNull();
  });
});

describe("通知の停止（M6-18）", () => {
  test("muted の間は判定だけ回し、明けた後に過去のものを通知しない。prime も同じ", () => {
    const st = { muted: true, now: 1_000_000, items: [] as QueueItem[] };
    const sent: SseMessage["data"][] = [];
    const runner = new NotifyRunner({
      queue: () => ({ items: st.items }),
      locale: () => "en",
      now: () => st.now,
      publish: (_t, data) => sent.push(data),
      subscribe: () => () => {},
      muted: () => st.muted,
    });
    const item = (id: string): QueueItem => ({
      workItemId: id,
      title: id,
      status: "needs_input",
      reason: null,
      estimated: false,
      repoRoot: null,
      branch: null,
      prRef: null,
      sources: [],
      waitingSince: 0,
      waitStartedAway: false,
      followUps: [
        {
          id: `f-${id}`,
          kind: "approve",
          status: "open",
          title: { t: "text", text: id },
          triggerAt: 0,
          snoozeUntil: null,
          engagedAt: null,
          expiresAt: null,
          taskId: null,
          taskDate: null,
          task: null,
        },
      ],
    });
    runner.run();
    st.items = [item("old")];
    st.now += 1000;
    expect(runner.run()).toEqual([]);
    st.muted = false;
    st.now += 1000;
    expect(runner.run()).toEqual([]);
    // prime: 取り込んだ直後のものを見たことにする
    st.items = [item("old"), item("backfilled")];
    runner.prime();
    st.now += 1000;
    expect(runner.run()).toEqual([]);
    st.items = [item("old"), item("backfilled"), item("new")];
    st.now += 1000;
    expect(runner.run().map((n) => n.title)).toEqual(["new"]);
    expect(sent).toHaveLength(1);
  });
});
