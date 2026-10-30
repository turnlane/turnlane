// hooks の spool に残すキー（ADR 0009、phase0-plan 3.1.1・3.6.1）。turnlane hook が直接 import する。
// このファイルは import を1つも持たない定数と小さな純粋関数だけのモジュール（biome.json で import を禁止している）。
// これ以外のキー（prompt、last_assistant_message、tool_input、message など本文を含みうるもの）は
// hook の中で捨てる（ADR 0005）。spool の行には、ここのキーのほかに turnlane hook が付ける
// v・tool・received_at・config_root（環境変数から取る設定ディレクトリ。S5）・term（環境変数から取る Orca の端末の
// ハンドル。D-238）が入る。

/** hooks を持つアダプタの ToolId */
export const HOOK_TOOL_IDS = ["claude_code", "codex"] as const;
export type HookToolId = (typeof HOOK_TOOL_IDS)[number];

export interface HookAllowlistEntry {
  /** インストールするイベント（phase0-plan 3.6.1） */
  readonly events: readonly string[];
  /** spool に残すキー（残す順）。1行が 4KB を超えるときは droppable を後ろから落とす */
  readonly keys: readonly string[];
  /** 4KB を超えたら落としてよいキー（この順に落とす） */
  readonly droppable: readonly string[];
}

const COMMON_KEYS = [
  "hook_event_name",
  "session_id",
  // サブエージェントの中で出た hook（Claude Code。session_id は親のもの）。agent_id は不透明な ID、agent_type は種類の名前
  "agent_id",
  "agent_type",
  // 権限のモード（default / plan / acceptEdits / auto / dontAsk / bypassPermissions。種類だけ）
  "permission_mode",
  "turn_id",
  "prompt_id",
  "notification_type",
  "tool_name",
  // StopFailure のエラーの種類（rate_limit / overloaded / server_error など）。Claude Code の公式の入力の項目名は error。
  // error_type は古い spool の行のために残す（後方互換）。error_details・last_assistant_message は本文になりうるので残さない
  "error",
  "error_type",
  "source",
  "reason",
  "cwd",
  "transcript_path",
] as const;

const COMMON_DROPPABLE = ["transcript_path", "cwd", "reason", "source"] as const;

export const HOOK_ALLOWLIST: Readonly<Record<HookToolId, HookAllowlistEntry>> = {
  claude_code: {
    events: [
      "SessionStart",
      "UserPromptSubmit",
      "PermissionRequest",
      "Notification",
      "Stop",
      "StopFailure",
      "SessionEnd",
    ],
    keys: COMMON_KEYS,
    droppable: COMMON_DROPPABLE,
  },
  codex: {
    events: ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop", "SessionEnd"],
    keys: COMMON_KEYS,
    droppable: COMMON_DROPPABLE,
  },
};

/**
 * 値の形を決めたキー（この形に合わない値は spool に残さない）。error は StopFailure ではエラーの種類の識別子だが、
 * 同じ名前の項目に文（エラーの文言）を入れるイベントもありうるので、識別子の形のものだけを残す（ADR 0005）
 */
export const HOOK_KEY_PATTERNS: Readonly<Record<string, RegExp>> = {
  error: /^[a-z][a-z0-9_]{0,63}$/,
  error_type: /^[a-z][a-z0-9_]{0,63}$/,
};

/** 値がキーの形に合うか（形を決めていないキーは常に true） */
export function hookValueAllowed(key: string, value: string): boolean {
  const re = HOOK_KEY_PATTERNS[key];
  return re === undefined || re.test(value);
}

/** spool の行に turnlane hook が付けるキー（許可リストのキーではない） */
export const HOOK_SPOOL_META_KEYS = [
  "v",
  "tool",
  "received_at",
  "config_root",
  "term",
  "truncated",
  "quota_horizon",
  // Codex の hook のハンドラの親（codex のプロセス）の pid（Issue #10）。turnlane hook が process.ppid から付ける
  "ppid",
] as const;

/**
 * Claude Code の利用枠の自動再開を止めた通知（Notification の notification_type が quota_auto_resume_disabled）のうち、
 * 枠が明けるのが 24 時間より先なので止めた（週の上限など）もの。message は spool に残さず（許可リストに入れない）、
 * hook の中でこの定型文に当たるかを見て、真偽値だけを spool の quota_horizon に残す（ADR 0005 の「その場で判定し、
 * 真偽値だけを残す」）。設定で自動再開を切ったときの文（"Automatic continue was turned off …"）は当たらない
 */
export const QUOTA_HORIZON_RE = /\bmore than 24 hours out\b/i;

export function quotaHorizonOf(src: Readonly<Record<string, unknown>>): boolean {
  return (
    src.hook_event_name === "Notification" &&
    src.notification_type === "quota_auto_resume_disabled" &&
    typeof src.message === "string" &&
    src.message.length <= 4096 &&
    QUOTA_HORIZON_RE.test(src.message)
  );
}

/**
 * Orca の端末のハンドル（環境変数 ORCA_TERMINAL_HANDLE。D-238）の形。spool の term に残すのはこの形のものだけ
 * （Orca が端末ごとに渡す不透明な ID。Turnlane から答えるときの届け先を決める）
 */
export const TERM_HANDLE_RE = /^term_[0-9A-Za-z-]{8,64}$/;

/** spool の行の形式の版 */
export const HOOK_SPOOL_VERSION = 1;

/**
 * Codex のプロジェクトに属さない会話の作業フォルダ（D-135）。Codex は会話ごとに `~/Documents/Codex/<日付>/<名前>` を
 * 作り、`<名前>` を最初の依頼の文から作る（会話の中身の派生物）。取り込み・spool に残す前に `~/Documents/Codex/<日付>`
 * まで切り落とす（日付の形でなければ `~/Documents/Codex` まで）。題名を保存しない設定でも同じ。
 * 下のフォルダでなければそのまま返す。turnlane hook も使うので、このモジュールに置く（import を持たない）
 */
export const CODEX_SCRATCH_DIR = "Documents/Codex";

const DATE_SEGMENT = /^\d{4}-\d{2}-\d{2}$/;

export function trimCodexScratchCwd(cwd: string, home: string): string {
  const h = home.replace(/\/+$/, "");
  if (!h) return cwd;
  const base = `${h}/${CODEX_SCRATCH_DIR}`;
  if (!cwd.startsWith(`${base}/`)) return cwd;
  const seg = cwd.slice(base.length + 1).split("/")[0] ?? "";
  return DATE_SEGMENT.test(seg) ? `${base}/${seg}` : base;
}

/**
 * Claude Code のトランスクリプトの置き場所 `projects/<符号化した cwd>/…` の、符号化した cwd の1段（D-136 の残り）。
 * Claude Code は cwd の英数字以外を `-` にしてディレクトリ名にするので、Codex の作業フォルダで動かすと
 * `-Users-<名前>-Documents-Codex-<日付>-<最初の依頼から作った名前>` になる。DB（ingest_cursor.stream_key・
 * ai_session.file_path）と spool に残す前に、`-Documents-Codex-<日付>` まで（日付が無ければ `-Documents-Codex` まで）
 * 切り落とす。符号化した名前からは `/Documents/Codex/x` と `/Documents/Codex-x` を区別できないので、ホームによらず
 * 最初の `-Documents-Codex-` から後を落とす（落としすぎる向きに倒す）。ほかの名前はそのまま返す
 */
const CLAUDE_CODEX_DIR = `-${CODEX_SCRATCH_DIR.replace(/[^A-Za-z0-9]/g, "-")}`;
const CLAUDE_DATE_HEAD = /^-(\d{4}-\d{2}-\d{2})(?=-|$)/;

export function trimClaudeProjectDir(dir: string): string {
  const i = dir.indexOf(`${CLAUDE_CODEX_DIR}-`);
  if (i < 0) return dir;
  const base = dir.slice(0, i + CLAUDE_CODEX_DIR.length);
  const date = CLAUDE_DATE_HEAD.exec(dir.slice(base.length))?.[1];
  return date ? `${base}-${date}` : base;
}

/**
 * パスの中の `projects/<符号化した cwd>/` の1段を trimClaudeProjectDir で切り落とす（ストリームのキー
 * `projects/<…>/<sid>.jsonl`、hooks の transcript_path の絶対パスのどちらにも使う）。当たらなければそのまま返す
 */
export function trimClaudeProjectPath(p: string): string {
  // ルートのパスに projects/ が含まれていてもよいように、最後の projects/<…>/ を見る
  const m = /^(.*\/|)projects\/([^/]+)(\/.*)?$/.exec(p);
  if (!m) return p;
  const dir = m[2] as string;
  const t = trimClaudeProjectDir(dir);
  return t === dir ? p : `${m[1]}projects/${t}${m[3] ?? ""}`;
}
