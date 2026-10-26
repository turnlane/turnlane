/**
 * 動いているセッションのタブ（ペイン）を前に出す（D-214 (4)。desktop-shell.md 4.4）: 居場所の調べ方（locate.ts）と
 * 試す順の組み立て（focus.ts）。プロセスと tmux の出力は偽物（FakeOpenSystem.outputs）。
 */
import { describe, expect, test } from "bun:test";
import {
  GHOSTTY_FOCUS_CWD,
  GHOSTTY_FOCUS_MARK,
  hostTerminal,
  ITERM_FOCUS,
  osc7,
  planLiveFocus,
  TERMINAL_FOCUS,
  withTab,
} from "../src/open/focus.ts";
import {
  LIST_CLIENTS_FORMAT,
  LIST_PANES_FORMAT,
  type LiveLocation,
  locateLive,
  parseClients,
  parsePanes,
  parsePsTtyLine,
  pickClient,
  tmuxSocketArgs,
} from "../src/open/locate.ts";
import { FakeOpenSystem } from "./helpers/open-system.ts";

const OPEN = "/usr/bin/open";
const OSA = "/usr/bin/osascript";
const TMUX = "/opt/homebrew/bin/tmux";
const ps = (pid: number) => `/bin/ps -o ppid=,tty=,comm= -p ${pid}`;
const opts = { cwd: "/w/app", marker: "/tmp/turnlane-focus-x", fallback: null };
const argvs = (plan: { steps: { argv: string[] }[] }[]) =>
  plan.map((a) => a.steps.map((s) => s.argv));

describe("プロセスの出力を読む", () => {
  test("ps の1行: tty は擬似端末だけ", () => {
    expect(parsePsTtyLine("  812 ttys004  claude")).toEqual({
      ppid: 812,
      tty: "/dev/ttys004",
      comm: "claude",
    });
    expect(parsePsTtyLine("1 ??  /Applications/Ghostty.app/Contents/MacOS/ghostty")).toEqual({
      ppid: 1,
      tty: null,
      comm: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    });
    expect(parsePsTtyLine("")).toBeNull();
  });

  test("tmux のサーバの引数からソケットの指定だけを取る", () => {
    expect(tmuxSocketArgs("tmux")).toEqual([]);
    expect(tmuxSocketArgs("tmux new -s work")).toEqual([]);
    expect(tmuxSocketArgs("tmux -L dev new -s work")).toEqual(["-L", "dev"]);
    expect(tmuxSocketArgs("/opt/homebrew/bin/tmux -f /x.conf -S /tmp/s new")).toEqual([
      "-S",
      "/tmp/s",
    ]);
    expect(tmuxSocketArgs("tmux -Ldev")).toEqual(["-L", "dev"]);
    // コマンドの後の -L は見ない
    expect(tmuxSocketArgs("tmux new -L x")).toEqual([]);
  });

  test("ペインとクライアントの一覧。クライアントはそのセッションを見ている最後のもの、無ければ切り替える", () => {
    expect(parsePanes("/dev/ttys010\t%3\twork\t2\t1\nbad\n")).toEqual([
      { tty: "/dev/ttys010", paneId: "%3", session: "work", window: "2", pane: "1" },
    ]);
    const clients = parseClients(
      "/dev/ttys001\t500\twork\t100\n/dev/ttys002\t501\twork\t200\n/dev/ttys003\t502\tother\t300\n",
    );
    expect(pickClient(clients, "work")).toEqual({
      client: clients[1] as never,
      switchClient: false,
    });
    expect(pickClient(clients, "none")).toEqual({
      client: clients[2] as never,
      switchClient: true,
    });
    expect(pickClient([], "work")).toBeNull();
  });
});

describe("locateLive", () => {
  test("端末の中: tty と、祖先の .app", async () => {
    const sys = new FakeOpenSystem();
    sys.outputs.set(ps(900), "800 ttys004 claude");
    sys.outputs.set(ps(800), "700 ttys004 -/bin/zsh");
    sys.outputs.set(ps(700), "600 ttys004 /usr/bin/login");
    sys.outputs.set(ps(600), "1 ?? /Applications/iTerm.app/Contents/MacOS/iTerm2");
    expect(await locateLive(900, sys)).toEqual({
      tty: "/dev/ttys004",
      host: "/Applications/iTerm.app",
      tmux: null,
    });
  });

  test("tmux の中: tty の一致するペインと、クライアントを表示している端末", async () => {
    const sys = new FakeOpenSystem();
    sys.outputs.set(ps(900), "800 ttys010 claude");
    sys.outputs.set(ps(800), "700 ttys010 -zsh");
    sys.outputs.set(ps(700), `1 ?? ${TMUX}`);
    sys.outputs.set("/bin/ps -o args= -p 700", "tmux -L dev new -s work");
    sys.outputs.set(
      [TMUX, "-u", "-L", "dev", "list-panes", "-a", "-F", LIST_PANES_FORMAT].join(" "),
      "/dev/ttys009\t%1\twork\t1\t0\n/dev/ttys010\t%3\twork\t2\t1\n",
    );
    sys.outputs.set(
      [TMUX, "-u", "-L", "dev", "list-clients", "-F", LIST_CLIENTS_FORMAT].join(" "),
      "/dev/ttys002\t650\twork\t1700000000\n",
    );
    sys.outputs.set(ps(650), "640 ttys002 tmux");
    sys.outputs.set(ps(640), "630 ttys002 -zsh");
    sys.outputs.set(ps(630), "1 ?? /Applications/Ghostty.app/Contents/MacOS/ghostty");
    expect(await locateLive(900, sys)).toEqual({
      tty: "/dev/ttys010",
      host: "/Applications/Ghostty.app",
      tmux: {
        bin: TMUX,
        socket: ["-L", "dev"],
        paneId: "%3",
        label: "work:2.1",
        client: { tty: "/dev/ttys002", pid: 650 },
        switchClient: false,
      },
    });
  });

  test("LANG の無いデーモンでも読める: tmux を -u で呼ぶ（付けないと一覧のタブが _ になる）。turnlane ai run を挟む鎖", async () => {
    const sys = new FakeOpenSystem();
    sys.outputs.set(ps(900), "800 ttys035 /usr/local/bin/claude");
    sys.outputs.set(ps(800), "700 ttys035 /usr/local/bin/turnlane");
    sys.outputs.set(ps(700), `1 ?? ${TMUX}`);
    sys.outputs.set("/bin/ps -o args= -p 700", `${TMUX} new-session -s turnlane-0a1b2c3d -c /w`);
    const panes = "/dev/ttys035\t%0\tturnlane-0a1b2c3d\t0\t0\n";
    const clients = "/dev/ttys033\t650\tturnlane-0a1b2c3d\t1700000000\n";
    // tmux 3.6 は UTF-8 でないクライアントへの -F の出力のタブを _ に置き換える
    sys.outputs.set(
      [TMUX, "list-panes", "-a", "-F", LIST_PANES_FORMAT].join(" "),
      panes.replaceAll("\t", "_"),
    );
    sys.outputs.set(
      [TMUX, "list-clients", "-F", LIST_CLIENTS_FORMAT].join(" "),
      clients.replaceAll("\t", "_"),
    );
    sys.outputs.set([TMUX, "-u", "list-panes", "-a", "-F", LIST_PANES_FORMAT].join(" "), panes);
    sys.outputs.set([TMUX, "-u", "list-clients", "-F", LIST_CLIENTS_FORMAT].join(" "), clients);
    sys.outputs.set(ps(650), `640 ttys033 ${TMUX}`);
    sys.outputs.set(ps(640), "630 ttys033 -zsh");
    sys.outputs.set(ps(630), "1270 ttys033 /usr/bin/login");
    sys.outputs.set(ps(1270), "1 ?? /Applications/Ghostty.app/Contents/MacOS/ghostty");
    expect(await locateLive(900, sys)).toEqual({
      tty: "/dev/ttys035",
      host: "/Applications/Ghostty.app",
      tmux: {
        bin: TMUX,
        socket: [],
        paneId: "%0",
        label: "turnlane-0a1b2c3d:0.0",
        client: { tty: "/dev/ttys033", pid: 650 },
        switchClient: false,
      },
    });
  });

  test("ps が読めなければ hostApp だけ（tty なし）", async () => {
    const sys = new FakeOpenSystem();
    sys.hosts.set(900, "/Applications/Ghostty.app");
    expect(await locateLive(900, sys)).toEqual({
      tty: null,
      host: "/Applications/Ghostty.app",
      tmux: null,
    });
  });
});

describe("planLiveFocus: tty → tmux のペイン → cwd → アプリ", () => {
  const at = (host: string | null, tty: string | null = "/dev/ttys004"): LiveLocation => ({
    tty,
    host,
    tmux: null,
  });

  test("iTerm2 と Terminal は tty でタブを選び、だめならアプリを前に出す", () => {
    const it = planLiveFocus(at("/Applications/iTerm.app"), opts);
    expect(argvs(it)).toEqual([
      [[OSA, "-e", ITERM_FOCUS, "/dev/ttys004"]],
      [[OPEN, "-a", "/Applications/iTerm.app"]],
    ]);
    expect(it[0]).toMatchObject({ app: "iTerm2", landing: { level: "tab", by: "tty" } });
    expect(it[1]).toMatchObject({ landing: { level: "app", miss: "not_found" } });
    const tm = planLiveFocus(at("/System/Applications/Utilities/Terminal.app"), opts);
    expect(argvs(tm)[0]).toEqual([[OSA, "-e", TERMINAL_FOCUS, "/dev/ttys004"]]);
    // tty が無ければアプリだけ
    expect(argvs(planLiveFocus(at("/Applications/iTerm.app", null), opts))).toEqual([
      [[OPEN, "-a", "/Applications/iTerm.app"]],
    ]);
  });

  test("Ghostty: tty に目印を書いて探し（後で戻す）、だめなら cwd、最後にアプリ", () => {
    const g = planLiveFocus(at("/Applications/Ghostty.app"), opts);
    expect(argvs(g)).toEqual([
      [[OSA, "-e", GHOSTTY_FOCUS_MARK, "/tmp/turnlane-focus-x"]],
      [[OSA, "-e", GHOSTTY_FOCUS_CWD, "/w/app"]],
      [[OPEN, "-a", "/Applications/Ghostty.app"]],
    ]);
    expect(g[0]?.prepare).toEqual([
      { mkdir: "/tmp/turnlane-focus-x" },
      { tty: "/dev/ttys004", write: osc7("/tmp/turnlane-focus-x") },
    ]);
    expect(g[0]?.finally).toEqual([
      { tty: "/dev/ttys004", write: osc7("/w/app") },
      { rmdir: "/tmp/turnlane-focus-x" },
    ]);
    expect(g[1]).toMatchObject({ landing: { level: "tab", by: "cwd" } });
    // tty が無ければ今までどおり cwd → アプリ
    expect(argvs(planLiveFocus(at("/Applications/Ghostty.app", null), opts))).toEqual([
      [[OSA, "-e", GHOSTTY_FOCUS_CWD, "/w/app"]],
      [[OPEN, "-a", "/Applications/Ghostty.app"]],
    ]);
  });

  test("OSC 7 は localhost のファイルの URL（空白などはエスケープ）", () => {
    expect(osc7("/w/my app")).toBe("\u001b]7;file://localhost/w/my%20app\u0007");
  });

  test("tmux の中: ペインを選んでから、クライアントの tty で端末のタブを選ぶ", () => {
    const loc: LiveLocation = {
      tty: "/dev/ttys010",
      host: "/Applications/iTerm.app",
      tmux: {
        bin: TMUX,
        socket: [],
        paneId: "%3",
        label: "work:2.1",
        client: { tty: "/dev/ttys002", pid: 650 },
        switchClient: true,
      },
    };
    const p = planLiveFocus(loc, opts);
    const tmuxSteps = [
      [TMUX, "-u", "switch-client", "-c", "/dev/ttys002", "-t", "%3"],
      [TMUX, "-u", "select-window", "-t", "%3"],
      [TMUX, "-u", "select-pane", "-t", "%3"],
    ];
    expect(argvs(p)).toEqual([
      [...tmuxSteps, [OSA, "-e", ITERM_FOCUS, "/dev/ttys002"]],
      [...tmuxSteps, [OPEN, "-a", "/Applications/iTerm.app"]],
      [[OPEN, "-a", "/Applications/iTerm.app"]],
    ]);
    expect(p[0]?.landing).toMatchObject({ level: "tab", by: "tty", pane: "work:2.1" });
    expect(p[1]?.landing).toMatchObject({ level: "app", pane: "work:2.1", miss: "not_found" });
    // Ghostty で tmux: cwd の一致は使わない（端末の cwd はセッションの cwd と限らない）
    const g = planLiveFocus({ ...loc, host: "/Applications/Ghostty.app" }, opts);
    expect(argvs(g).map((a) => a.at(-1))).toEqual([
      [OSA, "-e", GHOSTTY_FOCUS_MARK, "/tmp/turnlane-focus-x"],
      [OPEN, "-a", "/Applications/Ghostty.app"],
      [OPEN, "-a", "/Applications/Ghostty.app"],
    ]);
    expect(g[0]?.prepare?.[1]).toEqual({
      tty: "/dev/ttys002",
      write: osc7("/tmp/turnlane-focus-x"),
    });
    // 端末のアプリが分からない（クライアントなし）: ペインだけ選び、設定の端末を前に出す
    const none = planLiveFocus(
      { ...loc, host: null, tmux: { ...loc.tmux, client: null, switchClient: false } as never },
      { ...opts, fallback: { path: "/Applications/Ghostty.app", name: "Ghostty" } },
    );
    expect(argvs(none)).toEqual([
      [...tmuxSteps.slice(1), [OPEN, "-a", "/Applications/Ghostty.app"]],
      [[OPEN, "-a", "/Applications/Ghostty.app"]],
    ]);
  });

  test("Orca・Warp などはアプリを前に出すだけ（タブは選べない）", () => {
    const o = planLiveFocus(at("/Applications/Orca.app"), opts);
    expect(argvs(o)).toEqual([[[OPEN, "-a", "/Applications/Orca.app"]]]);
    expect(o[0]).toMatchObject({ app: "Orca", landing: { level: "app", miss: "unsupported" } });
    expect(hostTerminal("/Applications/Warp.app")).toEqual({ kind: "other", name: "Warp" });
  });

  test("AppleScript の返したタブの番号と一致した数", () => {
    const base = { level: "tab", by: "cwd", tab: null, pane: null, miss: null } as const;
    expect(withTab(base, "3\n")).toEqual({ ...base, tab: 3 });
    expect(withTab(base, "2 3")).toEqual({ ...base, tab: 2, miss: "ambiguous", candidates: 3 });
    expect(withTab(base, "2 1")).toEqual({ ...base, tab: 2 });
    expect(withTab(base, "")).toEqual(base);
  });
});
