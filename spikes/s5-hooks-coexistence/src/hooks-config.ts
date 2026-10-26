/**
 * Claude Code の settings.json と Codex の hooks.json に共通する `hooks` 構造の編集。
 *
 *   { "hooks": { "<Event>": [ { "matcher"?: string, "hooks": [ { "type": "command", "command": ... } ] } ] } }
 *
 * 識別: `type == "command"` かつ command に ` --managed-by dayline` を含むハンドラを dayline のものとみなす。
 * 未知キー（識別用のフラグ）は足さない（S5: Claude は現状許容するが保証がなく、Codex は
 * トップレベルの未知キーで hooks.json 全体を読み捨てる）。
 *
 * 置き方: dayline のハンドラはイベントごとに「自分専用のマッチャーグループ」1つに入れ、配列の末尾に足す。
 * 既存のグループの中には入れない。Codex は信頼承認の鍵が `<path>:<event>:<group>:<handler>` の位置なので、
 * 先頭や途中に入れると他ツールの承認が外れる（S5 実験 2）。
 */

export const MARKER = "--managed-by dayline";

// biome-ignore lint/suspicious/noExplicitAny: JSON
type Json = any;

export interface Handler {
  type: "command";
  command: string;
  timeout?: number;
  async?: boolean;
}

export interface Plan {
  events: readonly string[]; // 入れるイベント
  handler: (event: string) => Handler; // イベントごとのハンドラ
}

export function isDaylineHandler(h: Json): boolean {
  return (
    typeof h === "object" &&
    h !== null &&
    h.type === "command" &&
    typeof h.command === "string" &&
    /(^|\s)--managed-by\s+dayline(\s|$)/.test(h.command)
  );
}

function isDaylineGroup(g: Json): boolean {
  return (
    Array.isArray(g?.hooks) && g.hooks.length > 0 && g.hooks.every((h: Json) => isDaylineHandler(h))
  );
}

function sameHandler(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface InstallReport {
  added: string[];
  updated: string[]; // コマンドやオプションが変わった（Codex では再承認が要る）
  removed: string[]; // 対象外になったイベントから外した
  unchanged: string[];
}

/** 冪等。同じ plan で2回呼んでも2回目は何も変えない */
export function install(settings: Json, plan: Plan): { next: Json; report: InstallReport } {
  const next = structuredClone(settings);
  const report: InstallReport = { added: [], updated: [], removed: [], unchanged: [] };
  if (next.hooks === undefined) next.hooks = {};
  if (typeof next.hooks !== "object" || next.hooks === null || Array.isArray(next.hooks)) {
    throw new Error("hooks がオブジェクトではない。手で直してから実行する");
  }
  for (const event of plan.events) {
    const want = plan.handler(event);
    const arr: Json[] = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const ours = arr.map((g, i) => [g, i] as const).filter(([g]) => isDaylineGroup(g));
    if (ours.length === 0) {
      // 他のグループに混ざった dayline のハンドラ（手で編集された場合）は外す
      stripMixed(arr);
      arr.push({ hooks: [want] });
      report.added.push(event);
    } else {
      const [first, firstIdx] = ours[0] as readonly [Json, number];
      if (first.hooks.length === 1 && sameHandler(first.hooks[0], want) && ours.length === 1) {
        report.unchanged.push(event);
      } else {
        // 位置を保ったまま置き換える（Codex の承認の鍵を他ツールについて動かさない）
        arr[firstIdx] = { ...(first.matcher !== undefined ? { matcher: first.matcher } : {}), hooks: [want] };
        for (const [, i] of ours.slice(1).reverse()) arr.splice(i, 1);
        report.updated.push(event);
      }
    }
    next.hooks[event] = arr;
  }
  // 対象外になったイベントに残っている dayline のエントリを外す
  for (const event of Object.keys(next.hooks)) {
    if (plan.events.includes(event)) continue;
    if (removeFromEvent(next.hooks, event)) report.removed.push(event);
  }
  return { next, report };
}

export function uninstall(settings: Json): { next: Json; removed: string[] } {
  const next = structuredClone(settings);
  const removed: string[] = [];
  if (typeof next.hooks !== "object" || next.hooks === null) return { next, removed };
  for (const event of Object.keys(next.hooks)) {
    if (removeFromEvent(next.hooks, event)) removed.push(event);
  }
  if (removed.length > 0 && Object.keys(next.hooks).length === 0) delete next.hooks;
  return { next, removed };
}

/** dayline のハンドラを外す。外して空になったグループ・イベント配列も消す。何か外したら true */
function removeFromEvent(hooks: Json, event: string): boolean {
  const arr = hooks[event];
  if (!Array.isArray(arr)) return false;
  const before = JSON.stringify(arr);
  const kept = arr.filter((g: Json) => !isDaylineGroup(g));
  stripMixed(kept);
  if (JSON.stringify(kept) === before) return false;
  if (kept.length === 0) delete hooks[event];
  else hooks[event] = kept;
  return true;
}

function stripMixed(groups: Json[]): void {
  for (const g of groups) {
    if (Array.isArray(g?.hooks) && g.hooks.some((h: Json) => isDaylineHandler(h))) {
      g.hooks = g.hooks.filter((h: Json) => !isDaylineHandler(h));
    }
  }
}

export type InstallState = "none" | "installed" | "partial" | "outdated";

export function status(settings: Json, plan: Plan): { state: InstallState; missing: string[]; outdated: string[] } {
  const missing: string[] = [];
  const outdated: string[] = [];
  let found = 0;
  for (const event of plan.events) {
    const arr: Json[] = Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event] : [];
    const ours = arr.filter((g) => isDaylineGroup(g));
    if (ours.length === 0) missing.push(event);
    else {
      found++;
      if (!(ours.length === 1 && ours[0].hooks.length === 1 && sameHandler(ours[0].hooks[0], plan.handler(event)))) {
        outdated.push(event);
      }
    }
  }
  const state: InstallState =
    found === 0 ? "none" : missing.length > 0 ? "partial" : outdated.length > 0 ? "outdated" : "installed";
  return { state, missing, outdated };
}

/** シェルに渡す command 文字列。パスは単一引用符で囲む */
export function hookCommand(dlPath: string, tool: string): string {
  const q = `'${dlPath.replaceAll("'", `'\\''`)}'`;
  return `${q} hook --tool ${tool} ${MARKER}`;
}
