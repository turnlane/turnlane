/**
 * 動いているセッションがどの端末のどのタブ（ペイン）にいるかを、プロセスから調べる（D-214 (4)。desktop-shell.md 4.4）。
 *
 * 1. セッションのプロセスの tty（`ps -o tty=`。`/dev/ttysNNN`）
 * 2. 祖先をたどり、最初に見つかった `.app`（端末のアプリ）か tmux のサーバ
 * 3. tmux の中なら、`tmux list-panes -a` で tty が一致するペインを探し、そのセッションにつながっているクライアント
 *    （`tmux list-clients`）の tty とプロセスから、クライアントを表示している端末のアプリをたどる
 *
 * 読むのはプロセスの親子・tty・実行ファイルのパスと、tmux のペイン・クライアントの一覧だけ（画面の中身は読まない）。
 * tmux はいつも `-u` を付けて呼ぶ（tmuxBase）。デーモン（LaunchAgent）の環境には LANG が無く、tmux（3.6 で確認）は
 * UTF-8 でないクライアントへの `-F` の出力のタブを `_` に置き換えるので、付けないと一覧を読めず居場所が分からない。
 * どれも引数の配列で起動し、シェルを通さない。調べられなければ null の項目を返し、呼び出し側がアプリを前に出すだけに落とす。
 */
import { basename, isAbsolute } from "node:path";
import { outerApp } from "./system.ts";

/** tty として受け付ける形（擬似端末のスレーブだけ） */
export const TTY = /^\/dev\/ttys\d+$/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を除くための正規表現
const CONTROL = /[\u0000-\u001f\u007f]/g;

export interface TmuxPane {
  /** tmux の実行ファイル（絶対パス） */
  bin: string;
  /** サーバのソケットの指定（`-L <名前>` / `-S <パス>`。既定なら空） */
  socket: string[];
  /** ペインの ID（`%12`）。select-window / select-pane の -t に使う */
  paneId: string;
  /** 表示用（`セッション:ウインドウ.ペイン`） */
  label: string;
  /** ペインを表示させるクライアント（つながっていなければ null） */
  client: { tty: string; pid: number } | null;
  /** そのクライアントが別のセッションを見ている（switch-client が要る） */
  switchClient: boolean;
}

export interface LiveLocation {
  /** セッションのプロセスの tty（tmux の中ならペインの tty） */
  tty: string | null;
  /** 端末のアプリ（`.app` のパス）。tmux の中ならクライアントを表示しているアプリ */
  host: string | null;
  tmux: TmuxPane | null;
}

/** 標準出力を得るための起動（終了コード 0 のときだけ文字列。open/system.ts の capture） */
export type Capture = (argv: readonly string[]) => Promise<string | null>;

/** `ps -o ppid=,tty=,comm=` の1行 */
export function parsePsTtyLine(
  line: string,
): { ppid: number; tty: string | null; comm: string } | null {
  const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
  if (!m) return null;
  const tty = `/dev/${m[2]}`;
  return { ppid: Number(m[1]), tty: TTY.test(tty) ? tty : null, comm: m[3] as string };
}

/** tmux のサーバの引数（`ps -o args=`）から、ソケットの指定（-L / -S）だけを取り出す。コマンドの前の旗だけを見る */
export function tmuxSocketArgs(args: string): string[] {
  const t = args.trim().split(/\s+/).slice(1);
  for (let i = 0; i < t.length; i++) {
    const a = t[i] as string;
    if (!a.startsWith("-")) break;
    if (a === "-L" || a === "-S") {
      const v = t[i + 1];
      return v ? [a, v] : [];
    }
    if (/^-[LS]./.test(a)) return [a.slice(0, 2), a.slice(2)];
    // 値を取る旗（-f ファイル・-T 機能・-c コマンド）は次も飛ばす
    if (a === "-f" || a === "-T" || a === "-c") i++;
  }
  return [];
}

export interface PaneRow {
  tty: string;
  paneId: string;
  session: string;
  window: string;
  pane: string;
}

export const LIST_PANES_FORMAT =
  "#{pane_tty}\t#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}";
export const LIST_CLIENTS_FORMAT =
  "#{client_tty}\t#{client_pid}\t#{client_session}\t#{client_activity}";

export function parsePanes(out: string): PaneRow[] {
  const rows: PaneRow[] = [];
  for (const line of out.split("\n")) {
    const [tty, paneId, session, window, pane] = line.split("\t");
    if (!tty || !paneId || !/^%\d+$/.test(paneId) || session === undefined) continue;
    rows.push({ tty, paneId, session, window: window ?? "", pane: pane ?? "" });
  }
  return rows;
}

export interface ClientRow {
  tty: string;
  pid: number;
  session: string;
  activity: number;
}

export function parseClients(out: string): ClientRow[] {
  const rows: ClientRow[] = [];
  for (const line of out.split("\n")) {
    const [tty, pid, session, activity] = line.split("\t");
    if (!tty || !TTY.test(tty) || !pid || !/^\d+$/.test(pid)) continue;
    rows.push({ tty, pid: Number(pid), session: session ?? "", activity: Number(activity) || 0 });
  }
  return rows;
}

/** ペインを表示させるクライアント: そのセッションを見ている中で最後に使ったもの、無ければ最後に使ったもの（切り替える） */
export function pickClient(
  clients: readonly ClientRow[],
  session: string,
): { client: ClientRow; switchClient: boolean } | null {
  const latest = (xs: readonly ClientRow[]) =>
    xs.reduce<ClientRow | null>((a, b) => (a === null || b.activity > a.activity ? b : a), null);
  const same = latest(clients.filter((c) => c.session === session));
  if (same) return { client: same, switchClient: false };
  const any = latest(clients);
  return any ? { client: any, switchClient: true } : null;
}

/**
 * tmux を呼ぶときの頭（実行ファイル・`-u`・ソケットの指定）。`-u` はクライアントを UTF-8 として扱わせる。
 * 付けないと、LANG の無い環境（LaunchAgent）では一覧の区切りのタブが `_` になり、送る文の UTF-8 も崩れうる
 */
export function tmuxBase(p: Pick<TmuxPane, "bin" | "socket">): string[] {
  return [p.bin, "-u", ...p.socket];
}

const TMUX_FALLBACK = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];

/**
 * pid のセッションの居場所を調べる。capture が無い・ps が読めないときは hostApp だけ（tty なし）に落とす
 */
export async function locateLive(
  pid: number,
  sys: {
    capture?: Capture;
    hostApp(pid: number): string | null;
    exists(path: string): boolean;
  },
): Promise<LiveLocation> {
  const cap = sys.capture?.bind(sys);
  const plain = (): LiveLocation => ({ tty: null, host: sys.hostApp(pid), tmux: null });
  if (!cap) return plain();
  const ps = async (p: number) =>
    parsePsTtyLine((await cap(["/bin/ps", "-o", "ppid=,tty=,comm=", "-p", String(p)])) ?? "");
  const walk = async (
    start: number,
  ): Promise<{
    tty: string | null;
    host: string | null;
    tmux: { pid: number; comm: string } | null;
  } | null> => {
    let cur = start;
    let tty: string | null = null;
    for (let i = 0; i < 32 && Number.isInteger(cur) && cur > 1; i++) {
      const row = await ps(cur);
      if (!row) return i === 0 ? null : { tty, host: null, tmux: null };
      if (i === 0) tty = row.tty;
      const app = outerApp(row.comm);
      if (app) return { tty, host: app, tmux: null };
      if (i > 0 && basename(row.comm) === "tmux")
        return { tty, host: null, tmux: { pid: cur, comm: row.comm } };
      cur = row.ppid;
    }
    return { tty, host: null, tmux: null };
  };
  const w = await walk(pid);
  if (!w) return plain();
  if (!w.tmux || !w.tty) return { tty: w.tty, host: w.host, tmux: null };
  const bin = isAbsolute(w.tmux.comm)
    ? w.tmux.comm
    : (TMUX_FALLBACK.find((p) => sys.exists(p)) ?? null);
  if (!bin) return { tty: w.tty, host: null, tmux: null };
  const socket = tmuxSocketArgs(
    (await cap(["/bin/ps", "-o", "args=", "-p", String(w.tmux.pid)])) ?? "",
  );
  const panes = parsePanes(
    (await cap([...tmuxBase({ bin, socket }), "list-panes", "-a", "-F", LIST_PANES_FORMAT])) ?? "",
  );
  const pane = panes.find((p) => p.tty === w.tty);
  if (!pane) return { tty: w.tty, host: null, tmux: null };
  const picked = pickClient(
    parseClients(
      (await cap([...tmuxBase({ bin, socket }), "list-clients", "-F", LIST_CLIENTS_FORMAT])) ?? "",
    ),
    pane.session,
  );
  const host = picked ? ((await walk(picked.client.pid))?.host ?? null) : null;
  return {
    tty: w.tty,
    host,
    tmux: {
      bin,
      socket,
      paneId: pane.paneId,
      label: `${pane.session}:${pane.window}.${pane.pane}`.replace(CONTROL, " ").slice(0, 80),
      client: picked ? { tty: picked.client.tty, pid: picked.client.pid } : null,
      switchClient: picked?.switchClient ?? false,
    },
  };
}
