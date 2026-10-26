/**
 * Claude Code の settings.json と Codex の hooks.json に共通する `hooks` 構造の編集（phase0-plan 3.6.1、S5）。
 *
 *   { "hooks": { "<Event>": [ { "matcher"?: string, "hooks": [ { "type": "command", "command": ... } ] } ] } }
 *
 * 識別: `type == "command"` かつ command が語として `--managed-by turnlane` を含むハンドラを Turnlane のものとみなす。
 * 未知キーは足さない（Claude は現状許容するが保証がなく、Codex はトップレベルの未知キーで hooks.json 全体を読み捨てる）。
 * 置き方: Turnlane のハンドラはイベントごとに「自分専用のマッチャーグループ」1つに入れ、配列の末尾に足す。
 * 既存のグループの中には入れない。Codex は信頼承認の鍵が `<path>:<event>:<group>:<handler>` の位置なので、
 * 先頭や途中に入れると他ツールの承認が外れる。
 * daemon（hooks_state の点検）と turnlane hooks（インストーラ）が使う。ファイルは読み書きしない（json-file.ts が行う）。
 */

export const MARKER = "--managed-by turnlane";
const MARKER_RE = /(^|\s)--managed-by\s+turnlane(\s|$)/;

export interface Handler {
  type: "command";
  command: string;
  timeout?: number;
  async?: boolean;
}

export interface Plan {
  events: readonly string[];
  handler: (event: string) => Handler;
}

type Obj = Record<string, unknown>;
type Group = { matcher?: unknown; hooks?: unknown[] } & Obj;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function isTurnlaneHandler(h: unknown): boolean {
  return (
    isObj(h) && h.type === "command" && typeof h.command === "string" && MARKER_RE.test(h.command)
  );
}

function isTurnlaneGroup(g: unknown): boolean {
  return (
    isObj(g) &&
    Array.isArray(g.hooks) &&
    g.hooks.length > 0 &&
    g.hooks.every((h) => isTurnlaneHandler(h))
  );
}

function sameHandler(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface InstallReport {
  added: string[];
  /** コマンドやオプションが変わった（Codex では再承認が要る） */
  updated: string[];
  /** 対象外になったイベントから外した */
  removed: string[];
  unchanged: string[];
}

function hooksOf(settings: Obj): Obj {
  if (settings.hooks === undefined) settings.hooks = {};
  if (!isObj(settings.hooks))
    throw new Error("hooks がオブジェクトではありません。手で直してから実行してください");
  return settings.hooks;
}

/** 他のグループに混ぜ込まれた Turnlane のハンドラを外す */
function stripMixed(groups: unknown[]): void {
  for (const g of groups) {
    if (isObj(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isTurnlaneHandler(h))) {
      g.hooks = g.hooks.filter((h) => !isTurnlaneHandler(h));
    }
  }
}

/** Turnlane のハンドラを外す。外して空になったイベント配列も消す。何か外したら true */
function removeFromEvent(hooks: Obj, event: string): boolean {
  const arr = hooks[event];
  if (!Array.isArray(arr)) return false;
  const before = JSON.stringify(arr);
  const kept = arr.filter((g) => !isTurnlaneGroup(g));
  stripMixed(kept);
  if (JSON.stringify(kept) === before) return false;
  if (kept.length === 0) delete hooks[event];
  else hooks[event] = kept;
  return true;
}

/** 冪等。同じ plan で2回呼んでも2回目は何も変えない */
export function install(settings: unknown, plan: Plan): { next: Obj; report: InstallReport } {
  if (!isObj(settings)) throw new Error("設定ファイルのトップレベルがオブジェクトではありません");
  const next = structuredClone(settings);
  const report: InstallReport = { added: [], updated: [], removed: [], unchanged: [] };
  const hooks = hooksOf(next);
  for (const event of plan.events) {
    const want = plan.handler(event);
    const arr: unknown[] = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const ours = arr.map((g, i) => [g, i] as const).filter(([g]) => isTurnlaneGroup(g));
    if (ours.length === 0) {
      stripMixed(arr);
      arr.push({ hooks: [want] });
      report.added.push(event);
    } else {
      const [first, firstIdx] = ours[0] as readonly [Group, number];
      const firstHooks = first.hooks as unknown[];
      if (firstHooks.length === 1 && sameHandler(firstHooks[0], want) && ours.length === 1) {
        report.unchanged.push(event);
      } else {
        // 位置を保ったまま置き換える（Codex の承認の鍵を他ツールについて動かさない）
        arr[firstIdx] = {
          ...(first.matcher !== undefined ? { matcher: first.matcher } : {}),
          hooks: [want],
        };
        for (const [, i] of ours.slice(1).reverse()) arr.splice(i, 1);
        report.updated.push(event);
      }
    }
    hooks[event] = arr;
  }
  for (const event of Object.keys(hooks)) {
    if (plan.events.includes(event)) continue;
    if (removeFromEvent(hooks, event)) report.removed.push(event);
  }
  return { next, report };
}

export function uninstall(settings: unknown): { next: Obj; removed: string[] } {
  if (!isObj(settings)) throw new Error("設定ファイルのトップレベルがオブジェクトではありません");
  const next = structuredClone(settings);
  const removed: string[] = [];
  if (!isObj(next.hooks)) return { next, removed };
  const hooks = next.hooks;
  for (const event of Object.keys(hooks)) if (removeFromEvent(hooks, event)) removed.push(event);
  if (removed.length > 0 && Object.keys(hooks).length === 0) delete next.hooks;
  return { next, removed };
}

export type InstallState = "none" | "installed" | "partial" | "outdated";

export function status(
  settings: unknown,
  plan: Plan,
): { state: InstallState; missing: string[]; outdated: string[] } {
  const hooks = isObj(settings) && isObj(settings.hooks) ? settings.hooks : {};
  const missing: string[] = [];
  const outdated: string[] = [];
  let found = 0;
  for (const event of plan.events) {
    const arr: unknown[] = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const ours = arr.filter((g) => isTurnlaneGroup(g)) as Group[];
    if (ours.length === 0) missing.push(event);
    else {
      found++;
      const h = ours[0]?.hooks ?? [];
      if (!(ours.length === 1 && h.length === 1 && sameHandler(h[0], plan.handler(event))))
        outdated.push(event);
    }
  }
  const state: InstallState =
    found === 0
      ? "none"
      : missing.length > 0
        ? "partial"
        : outdated.length > 0
          ? "outdated"
          : "installed";
  return { state, missing, outdated };
}

/**
 * Turnlane より後ろにある他ツールのグループ（D-030）。Codex の承認は位置で決まるので、Turnlane を外すと
 * これらの承認が外れる（modified）。Turnlane は承認状態を書き換えず、再承認を案内する。
 * 返り値: イベント → 後ろのグループのコマンドの先頭（名前の目安）
 */
export function groupsAfterTurnlane(settings: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const hooks = isObj(settings) && isObj(settings.hooks) ? settings.hooks : {};
  for (const [event, arr] of Object.entries(hooks)) {
    if (!Array.isArray(arr)) continue;
    const idx = arr.findIndex((g) => isTurnlaneGroup(g));
    if (idx < 0) continue;
    const names: string[] = [];
    for (const g of arr.slice(idx + 1)) {
      if (isTurnlaneGroup(g) || !isObj(g) || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        if (isObj(h) && typeof h.command === "string")
          names.push(h.command.trim().split(/\s+/)[0] ?? "");
      }
    }
    if (names.length > 0) out[event] = names;
  }
  return out;
}

/** シェルに渡す command 文字列。パスは単一引用符で囲む */
export function hookCommand(cliPath: string, tool: string): string {
  const q = `'${cliPath.replaceAll("'", `'\\''`)}'`;
  return `${q} hook --tool ${tool} ${MARKER}`;
}
