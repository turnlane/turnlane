// CLI の文言の言語（文言の見直し 問い 1）。英語を正とし、設定の言語（ui.language）か LANG が ja のときだけ日本語にする。
// `turnlane hook` の起動時間を保つため、このモジュールは静的に重いものを import しない（DB は resolveLang の中で読む）。
import { existsSync } from "node:fs";

export type CliLang = "en" | "ja";

let current: CliLang = "en";

export function setLang(l: CliLang): void {
  current = l;
}

export function lang(): CliLang {
  return current;
}

/** 今の言語の文言を返す（英語、日本語の順に渡す） */
export function tr(en: string, ja: string): string {
  return current === "ja" ? ja : en;
}

/**
 * 環境変数だけで決める（turnlane hook の速い経路）。
 * TURNLANE_LANG=en|ja があればそれを優先する（スクリーンショットや確認用の上書き）。
 * 無ければ LC_ALL・LC_MESSAGES・LANG の順に見て、ja で始まれば日本語
 */
export function langFromVars(vars: Record<string, string | undefined>): CliLang {
  const o = vars.TURNLANE_LANG;
  if (o === "en" || o === "ja") return o;
  const l = vars.LC_ALL || vars.LC_MESSAGES || vars.LANG || "";
  return l.toLowerCase().startsWith("ja") ? "ja" : "en";
}

/**
 * 言語を決める。TURNLANE_LANG > 設定 ui.language（en / ja のとき）> LC_ALL・LC_MESSAGES・LANG。
 * 設定は DB を読み取り専用で開いて読む（無い・読めないときは環境変数へ）
 */
export function resolveLang(vars: Record<string, string | undefined>, dbPath?: string): CliLang {
  const o = vars.TURNLANE_LANG;
  if (o === "en" || o === "ja") return o;
  if (dbPath && existsSync(dbPath)) {
    try {
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .query<{ value_json: string }, []>(
            "SELECT value_json FROM setting WHERE key = 'ui.language'",
          )
          .get();
        const v = row ? (JSON.parse(row.value_json) as unknown) : undefined;
        if (v === "en" || v === "ja") return v;
      } finally {
        db.close();
      }
    } catch {}
  }
  return langFromVars(vars);
}

/** バックグラウンド（turnlaned）が動いていないときの文（K10）。install を付けると未登録のときの案内も出す */
export function notRunning(install = true): string {
  return install
    ? tr(
        "Turnlane's background service (turnlaned) isn't running. Start it with turnlane daemon start (run turnlane self-install first if it isn't set up).",
        "Turnlane のバックグラウンド（turnlaned）が動いていません。turnlane daemon start（未登録なら turnlane self-install）を実行してください。",
      )
    : tr(
        "Turnlane's background service (turnlaned) isn't running. Start it with turnlane daemon start.",
        "Turnlane のバックグラウンド（turnlaned）が動いていません。turnlane daemon start を実行してください。",
      );
}
