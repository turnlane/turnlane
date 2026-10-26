/**
 * Turnlane から答える（D-238）の純粋な部分: 届け先の決め方、端末ごとの送り方（偽の OS は使わない）、Orca の端末の選び方、
 * 待ちが閉じたかの判定。本文はすべてダミー
 */
import { describe, expect, test } from "bun:test";
import {
  type Delivery,
  GHOSTTY_WRITE,
  type GhosttyContext,
  ghosttyFailure,
  ITERM_WRITE,
  ORCA_WAIT_SUBMIT_S,
  parseOrcaSend,
  planSend,
  resolveDelivery,
  sendPrep,
  sendsNewlines,
  TERMINAL_WRITE,
  tmuxTextSteps,
} from "../src/answer/deliver.ts";
import { waitKindOf, waitStateInTail } from "../src/answer/wait.ts";
import type { FoundApp } from "../src/open/apps.ts";
import { GHOSTTY_FOCUS_MARK, GHOSTTY_MARKED, osc7, planLiveFocus } from "../src/open/focus.ts";
import {
  appleScriptDisabled,
  ghosttyScriptable,
  ghosttyScriptableFrom,
  noteGhosttyUnscriptable,
  parseGhosttyVersion,
} from "../src/open/ghostty.ts";
import type { LiveLocation, TmuxPane } from "../src/open/locate.ts";
import { orcaCli, parseOrcaTerminals, pickOrcaTerminal } from "../src/open/orca.ts";
import { FakeOpenSystem } from "./helpers/open-system.ts";

const PANE: TmuxPane = {
  bin: "/opt/homebrew/bin/tmux",
  socket: ["-L", "work"],
  paneId: "%3",
  label: "main:1.0",
  client: { tty: "/dev/ttys002", pid: 5000 },
  switchClient: false,
};
const ORCA: FoundApp = { id: "orca", name: "Orca", path: "/Applications/Orca.app" };
const H1 = "term_0a1b2c3d-4e5f-6789-abcd-ef0123456789";
const H2 = "term_11111111-2222-3333-4444-555555555555";

const loc = (l: Partial<LiveLocation>): LiveLocation => ({
  tty: null,
  host: null,
  tmux: null,
  ...l,
});

describe("resolveDelivery（届け先）", () => {
  test("tmux の中なら外側の端末に関係なく tmux（Ghostty でも送れる）", () => {
    const d = resolveDelivery(
      loc({ tty: "/dev/ttys007", host: "/Applications/Ghostty.app", tmux: PANE }),
      undefined,
    );
    expect(d).toMatchObject({ ok: true, via: "tmux", app: "Ghostty" });
    // クライアントがつながっていなくても送れる（ペインに送るだけ）
    expect(resolveDelivery(loc({ tty: "/dev/ttys007", tmux: PANE }), undefined)).toMatchObject({
      ok: true,
      via: "tmux",
      app: "tmux",
    });
  });
  test("iTerm2 は tty。tty が無ければ not_found", () => {
    expect(
      resolveDelivery(loc({ tty: "/dev/ttys004", host: "/Applications/iTerm.app" }), undefined),
    ).toEqual({ ok: true, via: "iterm", app: "iTerm2", tty: "/dev/ttys004" });
    expect(resolveDelivery(loc({ host: "/Applications/iTerm.app" }), undefined)).toEqual({
      ok: false,
      app: "iTerm2",
      reason: "not_found",
    });
  });
  test("Orca は選んだ端末が書き込めるときだけ", () => {
    const host = "/Applications/Orca.app";
    expect(
      resolveDelivery(loc({ host }), {
        app: ORCA,
        pick: { handle: H1, by: "handle" },
        writable: true,
      }),
    ).toEqual({ ok: true, via: "orca", app: "Orca", orca: ORCA, handle: H1 });
    expect(
      resolveDelivery(loc({ host }), {
        app: ORCA,
        pick: { handle: H1, by: "cwd" },
        writable: false,
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      resolveDelivery(loc({ host }), {
        app: ORCA,
        pick: { handle: null, miss: "ambiguous", candidates: 2 },
        writable: false,
      }),
    ).toMatchObject({ ok: false, app: "Orca", reason: "not_found" });
  });
  test("Terminal（ターミナル.app）は iTerm2 と同じく tty（D-243）。tty が無い・形が違えば not_found", () => {
    const host = "/System/Applications/Utilities/Terminal.app";
    expect(resolveDelivery(loc({ tty: "/dev/ttys005", host }), undefined)).toEqual({
      ok: true,
      via: "terminal",
      app: "Terminal",
      tty: "/dev/ttys005",
    });
    expect(resolveDelivery(loc({ host }), undefined)).toEqual({
      ok: false,
      app: "Terminal",
      reason: "not_found",
    });
    expect(resolveDelivery(loc({ tty: "/dev/console", host }), undefined)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    // tmux の中なら外側が Terminal でも tmux
    expect(
      resolveDelivery(loc({ tty: "/dev/ttys005", host, tmux: PANE }), undefined),
    ).toMatchObject({ ok: true, via: "tmux", app: "Terminal" });
  });
  test("Ghostty（D-244）: tty と cwd があれば目印で選ぶ端末に。AppleScript が使えないと分かれば unsupported、判定できなければ送ってみる", () => {
    const host = "/Applications/Ghostty.app";
    const gh = (o: Partial<GhosttyContext> = {}): GhosttyContext => ({
      cwd: "/w/app",
      marker: "/tmp/turnlane-focus-abc",
      scriptable: true,
      ...o,
    });
    const ok: Delivery = {
      ok: true,
      via: "ghostty",
      app: "Ghostty",
      tty: "/dev/ttys006",
      cwd: "/w/app",
      marker: "/tmp/turnlane-focus-abc",
    };
    expect(resolveDelivery(loc({ tty: "/dev/ttys006", host }), undefined, gh())).toEqual(ok);
    expect(
      resolveDelivery(loc({ tty: "/dev/ttys006", host }), undefined, gh({ scriptable: null })),
    ).toEqual(ok);
    // AppleScript を切っている・1.3 より古い
    expect(
      resolveDelivery(loc({ tty: "/dev/ttys006", host }), undefined, gh({ scriptable: false })),
    ).toEqual({ ok: false, app: "Ghostty", reason: "unsupported" });
    // tty が無い・形が違う・cwd が無い（目印の後に戻せない）: 選べないので送らない
    for (const [l, g] of [
      [loc({ host }), gh()],
      [loc({ tty: "/dev/console", host }), gh()],
      [loc({ tty: "/dev/ttys006", host }), gh({ cwd: null })],
      [loc({ tty: "/dev/ttys006", host }), undefined],
    ] as const)
      expect(resolveDelivery(l, undefined, g)).toEqual({
        ok: false,
        app: "Ghostty",
        reason: "not_found",
      });
    // tmux の中なら今までどおり tmux（目印は使わない）
    expect(
      resolveDelivery(loc({ tty: "/dev/ttys006", host, tmux: PANE }), undefined, gh()),
    ).toMatchObject({ ok: true, via: "tmux", app: "Ghostty" });
    // 改行は 1 行に畳む
    expect(
      sendsNewlines(
        resolveDelivery(loc({ tty: "/dev/ttys006", host }), undefined, gh()),
        "claude_code",
      ),
    ).toBe(false);
  });
  test("Warp・それ以外は送れない（unsupported）。居場所が無ければ not_live", () => {
    for (const [host, app] of [
      ["/Applications/Warp.app", "Warp"],
      ["/Applications/kitty.app", "kitty"],
    ] as const)
      expect(resolveDelivery(loc({ tty: "/dev/ttys001", host }), undefined)).toEqual({
        ok: false,
        app,
        reason: "unsupported",
      });
    expect(resolveDelivery(null, undefined)).toEqual({ ok: false, app: null, reason: "not_live" });
    expect(resolveDelivery(loc({ tty: "/dev/ttys001" }), undefined)).toMatchObject({
      reason: "not_found",
    });
  });
  test("改行をそのまま送るのは tmux の Claude Code だけ", () => {
    const t = resolveDelivery(loc({ tmux: PANE }), undefined);
    expect(sendsNewlines(t, "claude_code")).toBe(true);
    expect(sendsNewlines(t, "codex")).toBe(false);
    const i = resolveDelivery(
      loc({ tty: "/dev/ttys004", host: "/Applications/iTerm.app" }),
      undefined,
    );
    expect(sendsNewlines(i, "claude_code")).toBe(false);
    const term = resolveDelivery(
      loc({ tty: "/dev/ttys005", host: "/System/Applications/Utilities/Terminal.app" }),
      undefined,
    );
    expect(sendsNewlines(term, "claude_code")).toBe(false);
  });
});

describe("送り方のコマンド", () => {
  const base = ["/opt/homebrew/bin/tmux", "-u", "-L", "work", "send-keys", "-t", "%3"];
  test("tmux: 文字のまま（-l --）、Enter は別に。`-` で始まる文も旗にならない", () => {
    const d = resolveDelivery(loc({ tmux: PANE }), undefined);
    if (!d.ok) throw new Error("not ok");
    expect(planSend(d, { kind: "text", text: "-n で\nいい" }).map((s) => s.argv)).toEqual([
      [...base, "-l", "--", "-n で\nいい"],
      [...base, "Enter"],
    ]);
  });
  test("tmux: 末尾の `;` はコマンドの区切りに読まれるので 16 進で送る", () => {
    expect(tmuxTextSteps(PANE, "a; b;;").map((s) => s.argv)).toEqual([
      [...base, "-l", "--", "a; b"],
      [...base, "-H", "3b", "3b"],
    ]);
    expect(tmuxTextSteps(PANE, ";").map((s) => s.argv)).toEqual([[...base, "-H", "3b"]]);
  });
  test("許可する: 1 と Enter（2 = 今後も許可は送らない）", () => {
    const d = resolveDelivery(loc({ tmux: PANE }), undefined);
    if (!d.ok) throw new Error("not ok");
    expect(planSend(d, { kind: "allow" }).map((s) => s.argv)).toEqual([
      [...base, "-l", "--", "1"],
      [...base, "Enter"],
    ]);
  });
  test("iTerm2: tty の一致するセッションに write text（引数で渡す。スクリプトに文を埋め込まない）", () => {
    const d = resolveDelivery(
      loc({ tty: "/dev/ttys004", host: "/Applications/iTerm.app" }),
      undefined,
    );
    if (!d.ok) throw new Error("not ok");
    expect(planSend(d, { kind: "text", text: 'say "hi" & 1' }).map((s) => s.argv)).toEqual([
      ["/usr/bin/osascript", "-e", ITERM_WRITE, "/dev/ttys004", 'say "hi" & 1'],
    ]);
    expect(ITERM_WRITE).toContain("write text (item 2 of argv)");
  });
  test('Terminal: tty の一致するタブに do script（文は引数で渡す。`;`・`"`・`\\` もそのまま。改行は 1 行に）', () => {
    const d = resolveDelivery(
      loc({ tty: "/dev/ttys005", host: "/System/Applications/Utilities/Terminal.app" }),
      undefined,
    );
    if (!d.ok) throw new Error("not ok");
    const tricky = 'a; b "c" \\d\\" & end tell';
    expect(planSend(d, { kind: "text", text: tricky }).map((s) => s.argv)).toEqual([
      ["/usr/bin/osascript", "-e", TERMINAL_WRITE, "/dev/ttys005", tricky],
    ]);
    // スクリプトは文を含まない（埋め込まない）
    expect(TERMINAL_WRITE).not.toContain('end tell"');
    expect(TERMINAL_WRITE).toContain("do script (item 2 of argv) in t");
    expect(TERMINAL_WRITE).toContain("if tty of t is want then");
    expect(TERMINAL_WRITE).toContain('error "no tab" number 1');
    // 畳み残しの改行は空白に（do script は改行ごとに Return になる）
    expect(planSend(d, { kind: "text", text: "a\nb\r\nc" })[0]?.argv.at(-1)).toBe("a b c");
    // 許可する: 1（do script が Return を付ける）
    expect(planSend(d, { kind: "allow" }).map((s) => s.argv)).toEqual([
      ["/usr/bin/osascript", "-e", TERMINAL_WRITE, "/dev/ttys005", "1"],
    ]);
  });
  test("Ghostty: 目印の端末が 1 つだけのときに input text と send key enter（文・目印は引数で渡す）。目印は「開く」と同じ", () => {
    const d = resolveDelivery(
      loc({ tty: "/dev/ttys006", host: "/Applications/Ghostty.app" }),
      undefined,
      { cwd: "/w/my app", marker: "/tmp/turnlane-focus-abc", scriptable: true },
    );
    if (!d.ok) throw new Error("not ok");
    const tricky = 'a; b "c" \\d\\" & end tell';
    expect(planSend(d, { kind: "text", text: tricky }).map((s) => s.argv)).toEqual([
      ["/usr/bin/osascript", "-e", GHOSTTY_WRITE, "/tmp/turnlane-focus-abc", tricky],
    ]);
    // スクリプトは文を含まない。目印の判定は「開く」の着地と同じ handler（複製しない）
    expect(GHOSTTY_WRITE).not.toContain('end tell"');
    expect(GHOSTTY_WRITE).toContain("input text (item 2 of argv) to term");
    expect(GHOSTTY_WRITE).toContain('send key "enter" to term');
    expect(GHOSTTY_WRITE).toContain('if (count of hits) > 1 then error "ambiguous" number 2');
    expect(GHOSTTY_WRITE.endsWith(GHOSTTY_MARKED)).toBe(true);
    expect(GHOSTTY_FOCUS_MARK.endsWith(GHOSTTY_MARKED)).toBe(true);
    expect(GHOSTTY_MARKED.match(/working directory of term/g)?.length).toBe(1);
    // 畳み残しの改行・タブは空白に、制御文字（貼り付けの外に出る ESC など）は除く
    expect(planSend(d, { kind: "text", text: "a\nb\r\nc\td" })[0]?.argv.at(-1)).toBe("a b c d");
    expect(planSend(d, { kind: "text", text: "x\u001b[201~y\u0007\u009bz" })[0]?.argv.at(-1)).toBe(
      "x[201~yz",
    );
    // 許可する: 1（send key enter で確定）
    expect(planSend(d, { kind: "allow" }).map((s) => s.argv)).toEqual([
      ["/usr/bin/osascript", "-e", GHOSTTY_WRITE, "/tmp/turnlane-focus-abc", "1"],
    ]);
    // 目印: 作って tty に書き、送った後（失敗しても）元の cwd に戻して消す
    expect(sendPrep(d)).toEqual({
      prepare: [
        { mkdir: "/tmp/turnlane-focus-abc" },
        { tty: "/dev/ttys006", write: osc7("/tmp/turnlane-focus-abc") },
      ],
      finally: [
        { tty: "/dev/ttys006", write: osc7("/w/my app") },
        { rmdir: "/tmp/turnlane-focus-abc" },
      ],
    });
    const t = resolveDelivery(loc({ tmux: PANE }), undefined);
    if (!t.ok) throw new Error("not ok");
    expect(sendPrep(t)).toEqual({ prepare: [], finally: [] });
  });
  test("Ghostty に送れなかった理由: 目印の端末が 0 個・複数は not_found、拒否・打ち切りは send_failed、ほかは unsupported", () => {
    expect(ghosttyFailure({ stderr: "0:12: execution error: no terminal (1)\n" })).toBe(
      "not_found",
    );
    expect(ghosttyFailure({ stderr: "0:12: execution error: ambiguous (2)" })).toBe("not_found");
    expect(
      ghosttyFailure({
        stderr: "execution error: Not authorized to send Apple events to Ghostty. (-1743)",
      }),
    ).toBe("send_failed");
    expect(ghosttyFailure({ timedOut: true })).toBe("send_failed");
    expect(
      ghosttyFailure({
        stderr: "execution error: Ghostty got an error: AppleEvent handler failed. (-10000)",
      }),
    ).toBe("unsupported");
    expect(ghosttyFailure({ stderr: "" })).toBe("unsupported");
  });
  test("Orca: --text= の形で文と --enter --wait-submit。許可は 1 と Enter を別々（送信の観測なし）", () => {
    const d = resolveDelivery(loc({ host: "/Applications/Orca.app" }), {
      app: ORCA,
      pick: { handle: H1, by: "handle" },
      writable: true,
    });
    if (!d.ok) throw new Error("not ok");
    const cli = orcaCli(ORCA);
    expect(planSend(d, { kind: "text", text: "--help" }).map((s) => s.argv)).toEqual([
      [
        ...cli,
        "terminal",
        "send",
        `--terminal=${H1}`,
        "--text=--help",
        "--enter",
        "--wait-submit",
        String(ORCA_WAIT_SUBMIT_S),
        "--json",
      ],
    ]);
    expect(planSend(d, { kind: "allow" }).map((s) => s.argv)).toEqual([
      [...cli, "terminal", "send", `--terminal=${H1}`, "--text=1", "--json"],
      [...cli, "terminal", "send", `--terminal=${H1}`, "--enter", "--json"],
    ]);
  });
  test("Orca の送信の結果: 受理と送信の観測を分ける", () => {
    const r = (send: unknown) => JSON.stringify({ id: "x", ok: true, result: { send } });
    expect(
      parseOrcaSend(r({ accepted: true, prompt: { stages: ["input_accepted", "turn_started"] } })),
    ).toEqual({
      accepted: true,
      observed: true,
    });
    expect(parseOrcaSend(r({ accepted: true, prompt: { stages: ["input_accepted"] } }))).toEqual({
      accepted: true,
      observed: false,
    });
    expect(parseOrcaSend(r({ accepted: false, refusedReason: "x" }))).toEqual({
      accepted: false,
      observed: false,
    });
    expect(parseOrcaSend("not json")).toEqual({ accepted: false, observed: false });
  });
});

describe("Orca の端末（list の画面の中身は読まない）", () => {
  const SENTINEL = "SENTINEL_SCREEN_7a2c";
  const list = JSON.stringify({
    ok: true,
    result: {
      terminals: [
        {
          handle: H1,
          worktreePath: "/w/app",
          tabId: "t1",
          title: SENTINEL,
          preview: SENTINEL,
          connected: true,
          writable: true,
        },
        {
          handle: H2,
          worktreePath: "/w/app/packages/ui",
          tabId: "t2",
          title: "x",
          preview: SENTINEL,
          connected: true,
          writable: true,
        },
        { handle: "bad handle", worktreePath: "/w/app", connected: true, writable: true },
      ],
    },
  });
  test("使う値だけを残す（preview・title は捨てる）", () => {
    const rows = parseOrcaTerminals(list);
    expect(rows).toEqual([
      { handle: H1, worktreePath: "/w/app", tabId: "t1", connected: true, writable: true },
      {
        handle: H2,
        worktreePath: "/w/app/packages/ui",
        tabId: "t2",
        connected: true,
        writable: true,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(SENTINEL);
    expect(parseOrcaTerminals("{")).toEqual([]);
    expect(parseOrcaTerminals(null)).toEqual([]);
  });
  test("hooks のハンドルが今もあればそれ。無ければ cwd を含む一番深い worktree が 1 つのとき。複数なら選ばない", () => {
    const rows = parseOrcaTerminals(list);
    expect(pickOrcaTerminal(rows, { handle: H1, cwd: null })).toEqual({ handle: H1, by: "handle" });
    expect(
      pickOrcaTerminal(rows, { handle: "term_gone-0000", cwd: "/w/app/packages/ui/src" }),
    ).toEqual({
      handle: H2,
      by: "cwd",
    });
    expect(pickOrcaTerminal(rows, { handle: null, cwd: "/w/app" })).toEqual({
      handle: H1,
      by: "cwd",
    });
    expect(pickOrcaTerminal(rows, { handle: null, cwd: "/w/other" })).toEqual({
      handle: null,
      miss: "not_found",
    });
    const two = [...rows, { ...rows[0], handle: "term_33333333-0000" } as (typeof rows)[number]];
    expect(pickOrcaTerminal(two, { handle: null, cwd: "/w/app/src" })).toEqual({
      handle: null,
      miss: "ambiguous",
      candidates: 2,
    });
  });
});

describe("待ちが閉じたか（記録の末尾。新しい順）", () => {
  const user = (text: string) => ({
    type: "user",
    origin: { kind: "human" },
    message: { content: text },
  });
  const said = (text: string) => ({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
  const use = (id: string, name: string) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input: {} }] },
  });
  const result = (id: string) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id }] },
  });
  test("問い: 最後が AI の発言なら開いている、人の指示が後にあれば閉じた", () => {
    expect(waitStateInTail([said("どちら？"), user("やって")], "question")).toBe("open");
    expect(waitStateInTail([user("A で"), said("どちら？")], "question")).toBe("closed");
    expect(waitStateInTail([{ type: "system" }, said("?")], "error")).toBe("open");
  });
  test("許可待ち・回答待ち: 結果の無い tool_use が残っていれば開いている、結果があれば閉じた", () => {
    expect(waitStateInTail([use("t1", "Bash")], "permission")).toBe("open");
    expect(waitStateInTail([result("t1"), use("t1", "Bash")], "permission")).toBe("closed");
    expect(waitStateInTail([use("a1", "AskUserQuestion")], "ask")).toBe("open");
    expect(waitStateInTail([result("a1"), use("a1", "AskUserQuestion")], "ask")).toBe("closed");
  });
  test("tool_use が記録にまだ無い（ダイアログの間は書かれないことがある）: 閉じたとは言わない（unknown）", () => {
    // 指示の後に API の要求の行だけが続く（AskUserQuestion のダイアログが出ている間の記録）
    const tail = [{ type: "api-request" }, { type: "attachment" }, user("聞いて")];
    expect(waitStateInTail(tail, "ask")).toBe("unknown");
    expect(waitStateInTail(tail, "permission")).toBe("unknown");
    expect(waitStateInTail([use("a1", "AskUserQuestion")], "permission")).toBe("unknown");
    // 指示より前のターンの tool_use は見ない
    expect(waitStateInTail([user("次"), use("t1", "Bash")], "permission")).toBe("unknown");
  });
  test("フォローアップの種類 → 待ちの種類", () => {
    expect(waitKindOf({ kind: "approve", artifactRef: "x" })).toBe("permission");
    expect(waitKindOf({ kind: "reply", artifactRef: "turn:1:ask" })).toBe("ask");
    expect(waitKindOf({ kind: "reply", artifactRef: "turn:1" })).toBe("question");
    expect(waitKindOf({ kind: "resume_error", artifactRef: "x" })).toBe("error");
    expect(waitKindOf({ kind: "review_pr", artifactRef: "x" })).toBe("none");
    expect(waitKindOf(null)).toBe("none");
  });
});

describe("開く（D-217）の Orca の着地: そのタブに切り替える（D-238）", () => {
  const live = loc({ tty: "/dev/ttys007", host: "/Applications/Orca.app" });
  const base = { cwd: "/w/app", marker: "/tmp/m", fallback: null };
  test("選べた端末に orca terminal switch してから Orca を前に出す。着地は tab", () => {
    const plan = planLiveFocus(live, {
      ...base,
      orca: { app: ORCA, pick: { handle: H1, by: "handle" } },
    });
    expect(plan[0]?.steps.map((s) => s.argv)).toEqual([
      [...orcaCli(ORCA), "terminal", "switch", `--terminal=${H1}`, "--json"],
      ["/usr/bin/open", "-a", "/Applications/Orca.app"],
    ]);
    expect(plan[0]?.landing).toMatchObject({ level: "tab", by: "handle", tab: null });
    // 失敗したらアプリを前に出すだけ（not_found）
    expect(plan.at(-1)?.landing).toMatchObject({ level: "app", miss: "not_found" });
  });
  test("選べなければアプリを前に出すだけ。Orca を調べていなければ unsupported", () => {
    const amb = planLiveFocus(live, {
      ...base,
      orca: { app: ORCA, pick: { handle: null, miss: "ambiguous", candidates: 2 } },
    });
    expect(amb.map((a) => a.landing?.level)).toEqual(["app"]);
    expect(planLiveFocus(live, base)[0]?.landing).toMatchObject({
      level: "app",
      miss: "unsupported",
    });
  });
});

describe("Ghostty の AppleScript が使えるか（D-244。Apple Event は送らない）", () => {
  const APP = "/Applications/Ghostty.app";
  const VERSION = `/usr/bin/plutil -extract CFBundleShortVersionString raw -o - ${APP}/Contents/Info.plist`;
  const CONFIG = `${APP}/Contents/MacOS/ghostty +show-config`;
  test("版と設定の読み方", () => {
    expect(parseGhosttyVersion("1.3.1\n")).toEqual([1, 3]);
    expect(parseGhosttyVersion("1.3.0-dev+abc")).toEqual([1, 3]);
    expect(parseGhosttyVersion("tip")).toBeNull();
    expect(parseGhosttyVersion(null)).toBeNull();
    expect(appleScriptDisabled("font-size = 13\nmacos-applescript = false\n")).toBe(true);
    expect(appleScriptDisabled("macos-applescript = true")).toBe(false);
    expect(appleScriptDisabled("# macos-applescript = false")).toBe(false);
    expect(appleScriptDisabled("")).toBe(false);
    expect(ghosttyScriptableFrom("1.3.1", "")).toBe(true);
    expect(ghosttyScriptableFrom("2.0.0", "")).toBe(true);
    expect(ghosttyScriptableFrom("1.3.1", "macos-applescript = false")).toBe(false);
    expect(ghosttyScriptableFrom("1.2.3", "")).toBe(false);
    expect(ghosttyScriptableFrom("1.2.3", null)).toBe(false);
    expect(ghosttyScriptableFrom("1.3.1", null)).toBeNull();
    expect(ghosttyScriptableFrom(null, "")).toBeNull();
  });
  test("偽の OS: plutil と +show-config を読み、1 分覚える。送ってみて応答しなければ使えないものとして覚える", async () => {
    const sys = new FakeOpenSystem();
    expect(await ghosttyScriptable(sys, APP, 0)).toBeNull();
    sys.outputs.set(VERSION, "1.3.1\n");
    sys.outputs.set(CONFIG, "macos-applescript = false\n");
    // 覚えている間は読み直さない
    expect(await ghosttyScriptable(sys, APP, 30_000)).toBeNull();
    expect(await ghosttyScriptable(sys, APP, 61_000)).toBe(false);
    sys.outputs.set(CONFIG, "");
    expect(await ghosttyScriptable(sys, APP, 200_000)).toBe(true);
    noteGhosttyUnscriptable(sys, APP, 210_000);
    expect(await ghosttyScriptable(sys, APP, 220_000)).toBe(false);
    // 何も起動しない（capture だけ）
    expect(sys.runs).toEqual([]);
  });
});
