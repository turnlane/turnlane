/**
 * `turnlane config get|set <key> [<json>]` で読み書きできる設定（M3-6。phase0-plan 4.5）。
 * 既知のキーだけを受け付け、値を zod で検証する。書き込みは mutate() 層（putSetting）を通す（デーモン側）。
 * 設定画面（M2-9）ができるまで、稼働曜日・祝日カレンダーなどは CLI で変える。
 */
import { z } from "zod";
import { parseDayBoundary } from "./dates.ts";
import { PRESENCE_TAIL_MIN } from "./derive/presence.ts";
import { PANEL_WIDTH_LIMIT, PANEL_WIDTH_MIN } from "./layout/panel-width.ts";
import { OPEN_APP_IDS } from "./open.ts";
import { parsePlannedTime, WEEKDAY_KEYS } from "./plan/planned-hours.ts";

/** 計画の目安の1日（00:00〜24:00、終了は開始より後） */
const plannedSpan = z
  .object({
    start: z.string().refine((s) => parsePlannedTime(s) !== null, "HH:MM (00:00-24:00)"),
    end: z.string().refine((s) => parsePlannedTime(s) !== null, "HH:MM (00:00-24:00)"),
  })
  .strict()
  .refine(
    (v) => (parsePlannedTime(v.end) ?? 0) > (parsePlannedTime(v.start) ?? 0),
    "end must be after start",
  );

const hhmm = z.string().refine((s) => {
  try {
    parseDayBoundary(s);
    return true;
  } catch {
    return false;
  }
}, "HH:MM");

const timeZone = z.string().refine((s) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s });
    return true;
  } catch {
    return false;
  }
}, "IANA time zone");

/** 絶対パス（制御文字・`..` を含まない） */
const absPath = z
  .string()
  .max(1024)
  .refine(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を拒むための正規表現
    (s) => s.startsWith("/") && !s.split("/").includes("..") && !/[\u0000-\u001f\u007f]/.test(s),
    "absolute path",
  );

/**
 * キーの割り当ての上書き（D-077。ux-mvp 6.2）: キーマップの id → キーの表記の配列（web の keymap.ts の書式。
 * `j`・`shift+j`・`mod+k`・2打鍵は空白区切りの `g b`）。既定と同じものは保存しない。空配列は「キーなし」。
 * id の一覧と既定値は web が持つ（デーモンは書式だけを検証する）
 */
export const KEYBINDINGS_SCHEMA = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/, "keymap id"),
    z.array(z.string().regex(/^\S{1,32}( \S{1,32})?$/, "key like j / mod+k / g b")).max(4),
  )
  .refine((r) => Object.keys(r).length <= 200, "too many bindings");

/** 右の詳細パネルの幅（px。null は既定。ux-mvp 4.12.1） */
export const PANEL_WIDTH_SCHEMA = z
  .number()
  .int()
  .min(PANEL_WIDTH_MIN)
  .max(PANEL_WIDTH_LIMIT)
  .nullable();

export const CONFIG_SCHEMAS = {
  tz: timeZone,
  day_boundary: hhmm,
  "wait.grace_min": z.number().int().min(0).max(240),
  "reply.delay_min": z.number().int().min(0).max(240),
  "reply.expire_hours": z
    .number()
    .int()
    .min(1)
    .max(24 * 30),
  "your_turn.non_git_edit_expire_hours": z
    .number()
    .int()
    .min(1)
    .max(24 * 30),
  /**
   * 「Mac を使っていた」とみなす長さ（分。既定5。D-105・D-110 (2)）。最後のキーボード・マウスの操作からこの長さまでを
   * 在席とし、放置に数えうる時間にする
   */
  "presence.tail_min": z.number().int().min(PRESENCE_TAIL_MIN.min).max(PRESENCE_TAIL_MIN.max),
  /** 計画の目安（曜日ごと。D-062・D-106）。書いていない曜日は 10:00〜19:00。稼働日だけに当てはめる。空き時間と「明日朝」に使う */
  "work_hours.planned": z
    .object(Object.fromEntries(WEEKDAY_KEYS.map((k) => [k, plannedSpan.optional()])))
    .strict(),
  "followup.kinds": z
    .object({
      approve: z.boolean(),
      reply: z.boolean(),
      review_pr: z.boolean(),
      resume_error: z.boolean(),
      check_changes: z.boolean(),
    })
    .partial()
    .strict(),
  privacy: z.object({ storeTitles: z.boolean() }).strict(),
  /**
   * 自分の番の行に中身（許可を求めているコマンド・AI の問い・直近の指示の件名）を出す（D-207 (1)。既定オン）。表示する間だけ
   * 手元のセッションの記録から読み、保存も送信もしない（ADR 0005 の追記 2）。オフなら glance は読まない
   */
  "turn.show_detail": z.boolean(),
  /**
   * 待ちの中身を保存する（ADR 0018、D-218。既定オン）: 自分の指示の 1 行目（ターンごと）と、待ちの中身（AI の問いと選択肢・
   * 許可のツールとコマンド・エラーの種類）を伏せ字の後に手元の DB に持つ。外には送らない。オフなら持たず、表示の瞬間に読む
   */
  "turn.store_detail": z.boolean(),
  /**
   * 戻ったときのまとめを出す（D-214 (2)。既定オン）: 在席が 10 分以上切れて戻ったとき、その間の AI の変化（完了・PR・
   * 新しい待ち・エラー）の 1 行をメニューバーと今日の帯に出す。保存するのは閉じた印だけ。通知は出さない
   */
  "turn.away_summary": z.boolean(),
  /**
   * Turnlane から答える（D-238、ADR 0019。既定オン）: 自分の番の待ち（問い・許可）に、文章を書いてその端末のタブ（ペイン）に
   * 文字として届ける「答える」を出す。答えの文は保存しない。オフなら「答える」を出さず、POST /answer も断る
   */
  "turn.answer": z.boolean(),
  /**
   * 送れない端末では tmux で包む（D-238。既定オン）: Turnlane が起動するセッション（AI に頼む・時刻起動）を、送る口の無い端末
   * （Warp など。iTerm2・Terminal・Orca は除く。D-243。Ghostty は 1.3 より古い・AppleScript を切っている・判定できないとき。
   * D-244）のときだけ tmux の新しいセッションの中で起動する。tmux が無ければ今までどおり
   */
  "launch.tmux_wrap": z.boolean(),
  /**
   * 完了したときの片付けの既定（完了のシートの初期値。どちらも既定オン）: AI を終了してタブを閉じる・worktree を消す。
   * 取り込まれていない worktree の強制はここで既定にしない（毎回シートで選ぶ）。シートで変えた値は覚えない
   */
  "launch.finish_close_terminal": z.boolean(),
  "launch.finish_remove_worktree": z.boolean(),
  /**
   * 通知に出す中身（D-207 (4)）: subject = 件名と待ちの種類 · リポジトリ（既定）、minimal = 件名も出さない。AI の問い・
   * コマンドを出す選択肢は作らない（macOS が通知の内容を保存するため）
   */
  "notify.content": z.enum(["subject", "minimal"]),
  /**
   * 更新確認（ADR 0008 の追記 2、M6-12、D-014）。既定オン。false なら GitHub Releases の latest.json を取りに行かない
   * （接続のコードを通らない）
   */
  "update.check": z.boolean(),
  /**
   * 更新の取得と置き換え（ADR 0008 の追記 4、onboarding.md 2.5）。既定オン。新しい版があれば、同じ GitHub Releases の zip を
   * 背景で取得し、Apple の署名・公証と Team ID の一致を確かめて入れる用意をする。false なら確認だけ（手動の案内）
   */
  "update.download": z.boolean(),
  "ui.theme": z.enum(["system", "light", "dark"]),
  "ui.language": z.enum(["system", "en", "ja"]),
  /** 稼働曜日（ISO: 月 = 1 … 日 = 7）。1つ以上 */
  "workdays.weekdays": z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .refine((xs) => new Set(xs).size === xs.length, "duplicate weekday"),
  /** 祝日カレンダー（calendar.id）。null は自動判定、[] は祝日なし */
  "workdays.holiday_calendars": z.array(z.string().min(1)).nullable(),
  /**
   * 表示しないカレンダー（calendar.id。Issue #5）。ボード・デイビューに描かないだけで、忙しい時間・空き枠・会議中・
   * 集中モードの判定は変えない。取り込みも続ける
   */
  "calendar.hidden": z.array(z.string().min(1).max(256)).max(500),
  /** クイック入力のグローバルホットキー（Tauri の書式。既定 Alt+Shift+Space。D-056 (2)、desktop-shell.md 5章） */
  "desktop.quick_add_shortcut": z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/, "accelerator like Alt+Shift+Space"),
  /** キーの割り当ての上書き（D-077。端末ごと）。デスクトップアプリは表示メニューの ⌘1〜⌘3 をここから読む */
  "ui.keybindings": KEYBINDINGS_SCHEMA,
  /**
   * 右の詳細パネルの幅（px。この Mac に1つ、全画面・全種類のパネルで共通。ux-mvp 4.12.1）。null は既定（380px）。
   * 画面の幅に応じた上限は web が当てる（ここは値の書式だけ）
   */
  "ui.panel_width": PANEL_WIDTH_SCHEMA,
  /** タスクから開くアプリ（D-059。ux-mvp 4.11）。未インストールなら次に見つかったものへフォールバック */
  "open.editor": z.enum(OPEN_APP_IDS.editor),
  "open.terminal": z.enum(OPEN_APP_IDS.terminal),
  "open.diff": z.enum(OPEN_APP_IDS.diff),
  /**
   * AI に頼むときの worktree の置き場所（D-107・D-110 (4)）。null は各リポジトリの親（`<親>/<repo>-wt/<branch>`）。
   * 絶対パスを入れると `<そこ>/<repo>-wt/<branch>`
   */
  "ai.worktree_dir": z
    .string()
    .max(1024)
    .refine((s) => s.startsWith("/") && !s.split("/").includes(".."), "absolute path")
    .nullable(),
  /**
   * 壁打ちの印を付けたフォルダ（D-135）。この下で動いた AI のセッションは、プロジェクトに属さない「壁打ち」として出す
   * （git の中でもリポジトリとして扱わない）。ホームより深いフォルダだけ（`/`・ホームそのものは不可）
   */
  "ai.scratch_dirs": z
    .array(
      absPath.refine(
        (s) => s.split("/").filter(Boolean).length >= 3,
        "a folder inside the home folder",
      ),
    )
    .max(20)
    .refine((xs) => new Set(xs).size === xs.length, "duplicate folder"),
  /**
   * AI に頼むときの Claude のアカウント（D-122）: 設定ディレクトリの絶対パス → 表示名（name）と、起動の選択肢から
   * 外すか（hidden）。書いていないものはディレクトリ名から名前を付け、選択肢に出す
   */
  "ai.claude_accounts": z
    .record(
      absPath,
      z
        .object({
          name: z.string().trim().min(1).max(40).optional(),
          hidden: z.boolean().optional(),
        })
        .strict(),
    )
    .refine((r) => Object.keys(r).length <= 50, "too many accounts"),
  /** プロジェクトごとの Claude のアカウントの既定（D-122）: プロジェクトの ID → 設定ディレクトリの絶対パス */
  "ai.claude_account_by_project": z
    .record(z.string().min(1).max(64), absPath)
    .refine((r) => Object.keys(r).length <= 500, "too many projects"),
  /**
   * 日報の AI 要約（M4-6。D-041、ADR 0005 の追記）。既定はオフ。bin は CLI の絶対パス（null は検出）、
   * claude_config_dir は CLAUDE_CONFIG_DIR に入れる設定ディレクトリ（null は検出した最初のもの）
   */
  "report.ai_summary": z
    .object({
      enabled: z.boolean(),
      tool: z.enum(["claude_code", "codex"]),
      bin: z
        .string()
        .refine((s) => s.startsWith("/"), "absolute path")
        .nullable(),
      claude_config_dir: z
        .string()
        .refine((s) => s.startsWith("/"), "absolute path")
        .nullable(),
      timeout_sec: z.number().int().min(10).max(600),
    })
    .partial()
    .strict(),
} as const;

export type ConfigKey = keyof typeof CONFIG_SCHEMAS;

export const CONFIG_KEYS = Object.keys(CONFIG_SCHEMAS) as ConfigKey[];

export function isConfigKey(k: string): k is ConfigKey {
  return Object.hasOwn(CONFIG_SCHEMAS, k);
}

/**
 * 拡張の設定のキー（ADR 0015）: `ext.<拡張の id>.<名前>`。本体の閉じた一覧（CONFIG_SCHEMAS）に、拡張を組み込んだビルドだけ
 * 足す。値の型は拡張が zod で渡す
 */
export type ExtraConfigSchemas = Readonly<Record<string, z.ZodType>>;

export const EXT_CONFIG_KEY_RE = /^ext\.[a-z][a-z0-9]{1,23}\.[a-z][a-z0-9_.]{0,63}$/;

/** 本体と拡張のキーの一覧 */
export function configKeys(extra: ExtraConfigSchemas = {}): string[] {
  return [...CONFIG_KEYS, ...Object.keys(extra)];
}

/** 本体か拡張のキーか */
export function isKnownConfigKey(k: string, extra: ExtraConfigSchemas = {}): boolean {
  return isConfigKey(k) || Object.hasOwn(extra, k);
}

/** 値の検証。失敗なら理由（英語の短い文）。extra は拡張のキー（ADR 0015） */
export function validateConfig(
  key: string,
  value: unknown,
  extra: ExtraConfigSchemas = {},
): { ok: true; value: unknown } | { ok: false; error: string } {
  const schema: z.ZodType | undefined = isConfigKey(key)
    ? CONFIG_SCHEMAS[key]
    : Object.hasOwn(extra, key)
      ? extra[key]
      : undefined;
  if (!schema) return { ok: false, error: "unknown key" };
  const r = schema.safeParse(value);
  if (r.success) {
    // 稼働曜日は並べて保存する
    const v = key === "workdays.weekdays" ? [...(r.data as number[])].sort() : r.data;
    return { ok: true, value: v };
  }
  return { ok: false, error: r.error.issues.map((i) => i.message).join("; ") };
}
