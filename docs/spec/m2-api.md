# M2 の UI 向け API とクライアントのデータ層

M2（ボード UI）で画面が読む API、更新の配信（SSE）、タスク操作、クライアントのデータ層、時間軸の配置計算の置き場所、表示文字列の組み立て（i18n）を決める。phase0-plan 3.4 の API 一覧と 4.4 の M2 タスクを、確定デザイン（[docs/design/](../design/README.md)）と M1 の実装（`apps/daemon/src/http/ai-routes.ts`、`apps/daemon/src/derive/views.ts`）に合わせて具体化したもの。3.4 と食い違う点はこの文書を正とする（2026-10-03）。

2026-10-04 更新: 9.4 の残る判断への PO の回答（D-049）を反映した（needs_input は必ずタスクにする、稼働日でない未来日は Free を出さない、Planned に今日の完了済みを含める）。

2026-10-03 更新: 先にマージされた M1 の Idle 修正（main `05a9b88`。D-045・D-046、マイグレーション `0003_d045_idle_titles.sql`）に合わせ、PO の回答（D-047・D-048）を反映した。列名・パラメータ名は実装を正とする（`task.title_key` / `title_params`、パラメータ `title` / `repo` / `branch` / `pr` / `prTitle`、待ちの集計外 `no_task`）。

## 0. 結論

1. **画面ごとの集約エンドポイントを作る**: 週ボードは `GET /api/board?from&to`、デイビューは `GET /api/day/:date`。どちらも同じ「1日分」の型 `DayColumn` を返し、デイビューはそれを詳細にした `DayDetail` を返す。**YOUR TURN だけは集約に入れず `GET /api/queue` を共有する**（帯・キュー画面・シャットダウン・朝の計画・サイドバーの件数・タブタイトル・通知が同じ1つのキャッシュを読む）。Inbox は `GET /api/inbox`、AI 詳細は `GET /api/work-items/:id`。
2. **`/api/work-items` は CLI（`turnlane ai`）用に残し、UI は使わない**。ただし AI 項目の要約の型（`AiItemSummary`）は `/api/work-items` と `/api/board` で共通にし、`packages/core/src/api/` に移す。
3. **SSE は「何が・どの日付で変わったか」だけを送り、クライアントは該当キャッシュを再取得する**（差分は送らない）。M1 の runner は状態が変わったときしか `work_item` を送らないので、ターンの追加・待ち区間の変化でも送るように直す。進行中の区間（稼働中のターン、開いている待ち）の伸びはクライアントが現在時刻まで描き足し、イベントを送らない。
4. **クライアントは TanStack Query**。キーは画面の読み取り単位（`["board", from, to]`、`["day", date]`、`["queue"]` …）。SSE のイベントを日付の重なりで `invalidateQueries` に変換する。操作は楽観的更新 → 失敗で巻き戻し → 確定後に再取得。
5. **時間軸の配置計算（重なりの列割り当て、最小高さ、`+N`）はクライアント**で、純粋関数 `packages/core/src/layout/lanes.ts` に置く。サーバーは時刻（epoch ms）だけを返し、ピクセルを知らない。容量（Free / Planned）の計算は `packages/core/src/plan/capacity.ts` に置き、サーバーが集計値を返しつつ、DnD 中はクライアントが同じ関数で再計算する。
6. **サーバーは表示文字列を返さない**。自動生成タスクの題名は `{ key, params }`（D-046。M1 で実装済みの `task.title_key` / `title_params`。`params` は読み取り時に AI 項目の現在の値で組み立てる。D-047 (3)）、状態・理由・閉じ方・待ちの区分は列挙値、時間は ms、時刻は epoch ms で返し、文言はクライアントの辞書で組み立てる。返すそのままの文字列はユーザーや外部が書いたもの（タスク名、予定名、AI 項目のタイトル、リポジトリ・ブランチ名）だけ。
7. **YOUR TURN に出すのは open なタスクがあるカードだけ**（D-048 (4)）。`/api/queue` がこの規則で絞り、帯・キュー・件数・通知・儀式はすべてそれを読む。タスクのない your_turn のカードは72時間で done にする（phase0-plan 3.3）。**needs_input は必ずタスク（許可待ちは approve、AskUserQuestion は reply）を作る**ので、hooks の有無によらず YOUR TURN と通知に出る（D-049 (1)）。
8. **見積**: M2 は +0.5日（16.5 → 17。D-047 (5) で了承）。常用開始前（A）+0.25: M2-2 は SSE の送り方の修正 +0.25、`/api/day` を M2-19 へ移して -0.25、題名の読み取り時の解決と D-048 (4) +0.25（D-046 の保存形式は M1 で実装済みなので外した。D-047 (2)）。常用中（B）+0.25: M2-19 が `/api/day` を受け取る。詳細は 8 章。

## 1. 画面ごとに必要なデータ

| 画面 | 必要なデータ | 読む API |
|---|---|---|
| 週ボード | 日ごと: 時間軸の範囲（日付区切りと DST を反映した開始・終了）、勤務時間（実績 / 修正 / いつもの）、終日予定、時刻付き予定、その日のタスク（Unscheduled と時間に置いたもの）、時間ブロック、完了タスクの実績区間、ヘッダの集計（今日・未来: Free / Events / Planned / Idle / Expired、過去: done/total / AI / Idle）、過去日の AI 稼働リボン（稼働区間の和集合）。今日だけ: AI 項目（稼働区間、待ち区間を2区分、自分の応答区間とその接続先）、前日以前からの未完了 AI の持ち越し。YOUR TURN 帯 | `/api/board`、`/api/queue` |
| デイビュー | 週ボードの1日分に加えて: AI 項目ごとのターン（ポップオーバー用のツール呼び出し数・編集ファイル数・トークン）、待ち区間の3区分と集計外の理由（`off_hours` / `event` / `snoozed` / `no_task` / `scheduled`）、AI 項目ごとの `AI · You · Idle`、自分の応答区間と待ち区間の接続、Closed today（replied / resolved · commit / not needed / expired）、空き枠、リポジトリ別の放置、日の集計（AI / You / Meetings / Idle / Expired） | `/api/day/:date`、`/api/queue` |
| 朝の計画 | Step 1: 前回の閉店以降に判断が要るもの（自分の番・エラー）と、完了だけのものの件数とタイトル。Step 2: 持ち越されたタスク。Step 3: 今日の `DayColumn`、容量、移動候補 | `/api/rituals/morning?date`（M4）、`/api/board`（今日1日分）、`/api/queue` |
| シャットダウン | Step 1: 未処理の自分の番（= queue）、今日自動で閉じた件数。Step 2: 勤務時間、日報（構造化データと Markdown）、積み上げ棒の値 | `/api/queue`、`/api/rituals/shutdown?date&lang`（M4） |
| 要対応キュー | 未処理の自分の番の全件（open なタスクがあるカードだけ。D-048 (4)）、平均応答時間 | `/api/queue` |
| Inbox | 日付なしのタスク、経由（`CLI` / `MCP via <client>` / 外部ソース）、作成日時 | `/api/inbox` |
| AI 詳細パネル | カードの要約、ターン一覧、成果物、時間内訳（AI / You / Idle、猶予と集計外の内訳、依頼から完了までの壁時計の時間）、フォローアップ、再開導線の有無 | `/api/work-items/:id` |
| ⌘K | コマンド（クライアントのキー定義）、検索結果（タスク、AI 項目のタイトル・リポジトリ・ブランチ・PR 番号） | `/api/search?q`（M2-15） |
| 共通の枠 | サイドバーの件数（Your turn・Inbox）、Sources の健全性、上部の状態ごとの件数、`today` | `/api/queue`、`/api/inbox`、`/api/health`、`/api/sources` |

## 2. エンドポイントの構成

### 2.1 方式の比較

| 案 | 内容 | 画面を開いたときの往復 | 整合（同じ時点のデータか） | SSE との対応 | 実装量 | 評価 |
|---|---|---|---|---|---|---|
| A. 細粒度の API を組み合わせる | `/api/tasks?from&to`、`/api/events?from&to`、`/api/work-items`、`/api/waits?date`、`/api/queue` などをクライアントで結合 | 週ボードで5〜6本 | 別々の時点のデータが混ざる（タスクは新しく待ち区間は古い、など）。結合の規則（Unscheduled から自分の番のタスクを除く、応答区間と待ちの接続）をクライアントが持つ | イベント種別とキーが1対1で分かりやすい | サーバーは薄いが、クライアントの結合・テストが重い | 不採用 |
| **B. 画面ごとの集約 + 自分の番だけ共有（推奨）** | `/api/board`・`/api/day/:date` が1日分の型をまとめて返す。YOUR TURN は `/api/queue` を共有 | 週ボードで2本（board と queue） | 1回の読み取りトランザクションで1日分がそろう。結合の規則はサーバーの1か所（テストは `app.request`） | イベントの `dates` と日付範囲の重なりで無効化する（3章） | サーバーの組み立て関数（views）が増えるが、M1 の `aiDays` / `queue` を拡張する形 | **採用** |
| C. 1本の「全部入り」スナップショット | `/api/state?from&to` に queue・inbox・sources まで入れる | 1本 | 最も良い | どのイベントでも全部を取り直す。queue だけ変わっても7日分を組み直す | 小さいが、デイビュー・儀式で形が肥大化する | 不採用 |

**B を推奨する理由**: (1) 週ボードの1日分は予定・タスク・時間ブロック・実績・AI 区間・待ち区間・勤務時間・容量が互いに参照し合う（応答区間 ↔ 待ち区間、自分の番のタスクを Unscheduled から外す、容量は予定と時間ブロックの差し引き）ので、結合をサーバーの1か所で行い、同じ読み取りトランザクションで返す方が描画の食い違いが起きない。(2) YOUR TURN は日付に関係なく7か所以上で使うため、集約に埋めると同じデータが複数のキャッシュに入り、片方だけ古くなる（キューで完了したのに帯に残る）。1つのキー `["queue"]` に集めると楽観的更新も1か所で済む。(3) ローカルの SQLite で数百行規模なので、7日分を毎回組み直しても数 ms で、差分配信を作る理由が無い。

`/api/work-items` との役割分担（M1 実装者の指摘への回答）:
- `/api/work-items?date&days` は `turnlane ai` と MCP `get_ai_work` 用に残す。UI は使わない。
- AI 項目の要約は `AiItemSummary`（`/api/work-items` の `AiItem` をそのまま移したもの）を共通の型にし、`/api/board` の AI レーンの項目はそれに区間を足した `AiLaneItem` にする。
- `/api/queue` は UI もそのまま使う。応答の形は 2.4 の `QueueItem` に揃える（M1 の形にフィールドを足すだけで、既存のフィールドは変えない）。

### 2.2 エンドポイント一覧（M2 で UI が使うもの）

読み取り:

| メソッド | パス | 返す型 | タスク |
|---|---|---|---|
| GET | `/api/board?from=YYYY-MM-DD&to=YYYY-MM-DD` | `BoardResponse` | M2-2 |
| GET | `/api/board?around=YYYY-MM-DD` | `BoardResponse`（前の稼働日・その日・次の稼働日の3日。20章） | D-074 |
| GET | `/api/day/:date` | `DayResponse` | M2-19 |
| GET | `/api/queue` | `QueueResponse`（M1 の形を拡張） | M1 済み / M2-2 で拡張 |
| GET | `/api/inbox` | `InboxResponse` | M2-2 |
| GET | `/api/work-items/:id` | `WorkItemDetail`（M1 の形を型付け、時間内訳を追加） | M2-5 |
| GET | `/api/free-slots?date&minMinutes` | `{ slots: Interval[] }` | M2-18 |
| GET | `/api/search?q&limit` | `SearchResponse` | M2-15 |

- `from` / `to` は両端を含む日付（週ボードの列の暦日。D-054 で表示は暦日になった。同じ日付の論理日の集計を返す）。`to - from` は 0〜30日（31日分まで）。範囲外は 400。phase0-plan 3.4 の `days=7` 形式は使わない（週ボードは表示日数がウィンドウ幅で変わり、昨日起点で数えるため、両端の方が素直）。
- `/api/day/:date` は過去・今日・未来のどれでも返す。未来日は AI と待ちが空になる。

タスクと時間ブロックの操作（3.4 の一覧を具体化。すべて `mutate()` 経由で書き、応答は更新後の行の View）:

| 操作 | API | 楽観的更新 | 備考 |
|---|---|---|---|
| 作成（`c`） | `POST /api/tasks` `{title?, raw?, date?, estimateMin?, projectId?, notes?, clientId?}` | する（`clientId` を仮 ID に使う） | `clientId` は UUIDv7。サーバーはそれを ID に採用する（再送で二重作成しない） |
| タイトル等の変更（`r`） | `PATCH /api/tasks/:id` `{title?, notes?, estimateMin?, priority?, projectId?, isHighlight?}` | する | 自動生成タスクの題名を変えたら `title_key` / `title_params` を NULL にし、`title` に書いた文字列を入れる（`TitleSpec` は `text` になる。D-046） |
| 完了 / 未完了（`Space`） | `POST /api/tasks/:id/complete` / `uncomplete` | する | 自分の番のタスクは対応するフォローアップの `complete` に委ねる（同じ結果になる）。`complete` の応答の `closedFollowUps` は一緒に閉じた自分の番。`uncomplete` の本文は省略可で、完了の取り消し（知らせの「元に戻す」と ⌘Z。D-139 (3)）は `{status: "todo" \| "doing", reopenFollowUps: closedFollowUps}` を送り、前の状態に戻して自分の番を開き直す（日付と並びは完了で変わらない） |
| 開始（ワンタップ実績） | `POST /api/tasks/:id/start` | する | |
| 日付の移動・並べ替え（`m`、`>` / `<`、`t`、DnD） | `POST /api/tasks/:id/move` `{date: string \| null, beforeId?, afterId?, carry?: boolean}` | する | `carry: true` のときだけ `rollover_count` を加算（朝の Step 2 の `t`、シャットダウンの自動持ち越し）。手での移動は加算しない |
| 持ち越し（シャットダウン） | `POST /api/rituals/shutdown/complete` の中でまとめて行う（M4-2） | しない | 個別の API は作らない |
| やめる（朝の Step 2 の Drop） | `PATCH /api/tasks/:id` `{status: "canceled"}` | する | |
| 削除 / 取り消し（⌘Z） | `DELETE /api/tasks/:id` / `POST /api/tasks/:id/restore` | する | |
| 時間に置く（DnD、`p`） | `POST /api/time-blocks` `{taskId?, title?, startAt, endAt, clientId?}` | する | Turnlane の中だけ（カレンダーには書かない。D-093） |
| 時間ブロックの移動・伸縮・解除 | `PATCH /api/time-blocks/:id` `{startAt?, endAt?}` / `DELETE /api/time-blocks/:id` | する | 解除してもタスクは残る |
| 勤務時間の修正 | `PUT /api/work-hours/:date`（M1 済み） | する | |

自分の番（フォローアップ）の操作は M1 の API をそのまま使う:

| 操作 | API | 楽観的更新 |
|---|---|---|
| `⏎` 開く・対応 / `o` 他の開き方 | `POST /api/open {followUpId, action?}`（13章。対応中の印もサーバーが付ける）。`o` のメニューは `GET /api/open/options?followUpId=` | する（行に「対応中」の印） |
| `s` スヌーズ（30分 / 1時間 / 明日朝 / 時刻を指定…） | `POST /api/follow-ups/:id/snooze {until}`（時刻を指定…は web が読んだ時刻を epoch ms の `until` で送る。過去は 400） | する（帯・キューから消す） |
| `e` 対応不要 | `POST /api/follow-ups/:id/dismiss`、複数は `POST /api/follow-ups/bulk-dismiss {ids}` | する |
| `Space` 完了 | `POST /api/follow-ups/:id/complete` | する（取り消し線で残す） |
| 完了の取り消し（知らせの「元に戻す」・⌘Z。D-139 (3)） | `POST /api/follow-ups/:id/reopen`（手での完了だけを open に戻す。スヌーズ中に完了したもので、その時刻がまだ来ていなければ同じ時刻までのスヌーズに戻す。一緒に閉じたタスク（頼んだタスク以外）は未完了に戻し、完了で足した応答の実績 `followup_estimate` を消す。open / snoozed ならそのまま、それ以外は 409） | しない（応答の後に再取得） |
| `y` 返答タスクを作る（AI カード。D-066 (2)） | `POST /api/work-items/:id/reply-task`（応答 `{rev, followUp, created, taskId}`。open / snoozed の reply か、開いているタスクが結び付いていれば作らずそのタスクを返す。phase0-plan 3.3） | しない（応答の後に再取得） |
| `m` 明日（シャットダウン・朝、YOUR TURN 帯・キュー） | `POST /api/follow-ups/:id/defer`（タスクを次の稼働日へ移し、その日の計画上の勤務開始までスヌーズ。D-052 (1)・D-064。11章） | する（帯・キューから消す） |
| 今やる（自分の番の画面の「後で」の行。スヌーズ解除） | `POST /api/follow-ups/:id/wake`（スヌーズを外して open に戻す。`m` で次の稼働日へ移したタスクは今日へ戻す。時間に置いた開始の前なら、開始の来ていない時間ブロックを消し、置いてから今までをスヌーズの区間として `snoozes_json` に残す（放置に数え直さない）。応答は defer と同じ形で `snoozeUntil: null`。32章） | する（後でから帯へ戻す） |
| 対応不要（「後で」のリセット前の上限待ちの行） | `POST /api/work-items/:id/dismiss-limit`（明けた後の「再開できる」を対応不要で閉じた形で先に作る。上限待ちでなければ 409。32章） | する（後でから消す） |

- 「明日朝」の時刻はクライアントが決めずにサーバーに任せる: `snooze` は `{until}` に加えて `{preset: "30m" | "1h" | "tomorrow_morning"}` も受け、`tomorrow_morning` は「次の稼働日（稼働曜日と祝日カレンダー。M3-6 の `nextWorkday`）の、計画上の勤務開始（設定 `work_hours.planned`。学習した「いつもの開始」は使わない。D-064）」とする。
- 書き込み系の応答は、変えた行の View と `rev`（4.1）を返す。

### 2.3 応答の型（`packages/core/src/api/`）

置き場所: `packages/core/src/api/{common,board,day,queue,tasks,work-items,events}.ts`。入力は Zod スキーマ（`@hono/zod-validator` で検証。M1 の手書きの検証はここで置き換える）、出力は TypeScript の型で、daemon の組み立て関数が `satisfies` で合わせる。web は `hc<AppType>` で推論された型を使い、部品の props には core の型を使う。

```ts
// common.ts
export type EpochMs = number;
export type LocalDate = string; // YYYY-MM-DD（日付区切りを反映した論理日付）
export type Interval = { start: EpochMs; end: EpochMs };

export type WorkItemStatus = "running" | "needs_input" | "your_turn" | "done" | "error";
export type FollowUpKind = "approve" | "reply" | "review_pr" | "resume_error" | "check_changes" | "merge_pr";
export type SourceTool = "claude_code" | "codex" | "claude_desktop";

/** すべての読み取り応答に付ける */
export interface ReadMeta {
  /** 今の論理日（日付区切りを適用。儀式・集計の「今日」） */
  today: LocalDate;
  /** 今の暦日（表示の「今日」。D-054） */
  displayToday: LocalDate;
  now: EpochMs;
  /** 単調増加の版。SSE の rev と比べて古い応答を捨てるのに使う（4.1） */
  rev: number;
}

/**
 * 表示文字列を持たない題名（D-046）。6.1。key と params は M1 の task.title_key / title_params
 * （packages/core/src/i18n/task-title.ts の TaskTitleKey / TaskTitleParams）。
 * params は読み取り時に AI 項目の現在の値で上書きしたもの（D-047 (3)）
 */
export type TitleSpec =
  | { t: "text"; text: string }
  | { t: "auto"; key: TaskTitleKey; params: TaskTitleParams };
// TaskTitleKey = "followup.reply" | "followup.approve" | "followup.review_pr" | "followup.resume_error" | "followup.check_changes" | "followup.merge_pr"
// TaskTitleParams = { title: string | null; repo: string | null; branch: string | null; pr: number | null; prTitle: string | null }
```

```ts
// board.ts（WorkHours は D-105 で消した。26章）
export interface CalendarEventView {
  id: string;
  title: string | null;
  start: EpochMs;
  end: EpochMs;
  allDay: boolean;
  /** 終日予定は日付で持つ（終わりを含まない） */
  startDate: LocalDate | null;
  endDate: LocalDate | null;
  calendarColor: string | null;
  busy: boolean;
}

export interface TaskView {
  id: string;
  title: TitleSpec;
  status: "todo" | "doing" | "done" | "canceled" | "someday";
  scheduledDate: LocalDate | null;
  laneOrder: string;
  estimateMin: number | null;
  projectId: string | null;
  rolloverCount: number;
  isHighlight: boolean;
  completedAt: EpochMs | null;
  autoCompleted: boolean;
  /** 経由の印。外部取り込みは externalSource、MCP は client 名 */
  origin: { source: "manual" | "cli" | "mcp" | "ai" | "calendar"; client: string | null; externalSource: string | null; externalUrl: string | null };
  /** 自分の番のタスクなら、そのフォローアップ（帯に出ている間は Unscheduled に出さない） */
  followUpId: string | null;
  createdAt: EpochMs;
  /** メモがある（Inbox の行のメモの印。本文は GET /api/tasks/:id だけが返す） */
  hasNotes?: boolean;
}

export interface TimeBlockView {
  id: string;
  taskId: string | null;
  title: string | null;
  start: EpochMs;
  end: EpochMs;
  // writebackState は D-093 で外した（時間ブロックはカレンダーに書かない）
}

/** 実績（自分の時間）。完了タスクを時間軸に置く位置と、AI への応答区間 */
export interface TimeEntryView {
  id: string;
  taskId: string;
  start: EpochMs;
  end: EpochMs | null; // null = 計測中（クライアントが now まで描く）
  source: "tap" | "followup_estimate" | "timeblock_assumed";
  /** AI への応答なら、どの AI 項目のどの待ちに答えたか（コネクタ用） */
  respondsTo: { workItemId: string; waitKey: string | null } | null;
}

export interface AiItemSummary {
  id: string;
  title: string | null;
  titleSource: string | null;
  status: WorkItemStatus;
  reason: string | null;
  estimated: boolean;
  /** ソースバッジ。profile は複数アカウントのときだけ UI が付ける */
  sources: { tool: SourceTool; profile: string | null }[];
  repoRoot: string | null;
  branch: string | null;
  prRef: string | null;
  aiMs: number;
  youMs: number;
  idleMs: number;
  turns: number;
  carriedFrom: LocalDate | null;
}

export interface AiRun extends Interval {
  turnId: string;
  /**
   * true = 稼働中（end は応答時点の now。クライアントが現在時刻まで描き足す）。トランスクリプトに終わりが無くても、
   * StopFailure・idle_prompt の後に活動の無いターンは、その hook の時刻で終わったもの（false。ai-session-ingestion 4.3 の
   * 「hooks が補う終わり」）
   */
  open: boolean;
}

/** 週ボードの待ちは2区分（D-028）。デイビューは WaitSegmentDetail（day.ts） */
export interface WaitSegmentBrief extends Interval {
  waitKey: string;
  idle: boolean;
  open: boolean;
  /** 線の色。フォローアップの種類から決める（approve → needs_input、resume_error → error、ほか your_turn。上限待ちと明けた後の再開は needs_input） */
  tone: "needs_input" | "your_turn" | "error";
  followUpId: string | null;
}

export interface AiLaneItem extends AiItemSummary {
  runs: AiRun[];
  waits: WaitSegmentBrief[];
  /** 上限待ち（利用枠で止まった。status は done・reason は rate_limit）。untilKnown が false なら until は停止から 5 時間。無ければ省く */
  limit?: { since: EpochMs; until: EpochMs; untilKnown: boolean };
}

export interface DayTotals {
  // 今日・未来（定義は 9.1。D-047 (1)。過去日は 0）
  freeMs: number;
  eventsMs: number;
  /** 見積なしのタスクは30分として足した値 */
  plannedMs: number;
  /** 見積なしで30分とみなしたタスクの件数。1以上なら UI は `Planned ~2h10m` と `~` を付ける */
  plannedUnestimated: number;
  // 過去
  doneCount: number;
  taskCount: number;
  // 共通
  aiMs: number;
  idleMs: number;
  expired: number;
}

export interface DayColumn {
  date: LocalDate;
  /** 表示の区分（暦日。D-054）。今日の列（帯・AI レーン・現在線）を決める */
  phase: "past" | "today" | "future";
  /** 集計の区分（同じ日付の論理日）。ヘッダの集計の種類と計画の窓に使う */
  logicalPhase: "past" | "today" | "future";
  /** 時間軸の範囲（暦日の 0:00〜翌 0:00。DST の日は23 / 25時間。D-054） */
  axis: Interval;
  /** 同じ日付の論理日の範囲（日付区切り〜翌日の日付区切り）。axis.start〜logical.start のブロックは前日に計上 */
  logical: Interval;
  /** 稼働日か（M3-6 まで null） */
  workday: boolean | null;
  /** その日の計画の目安（D-062・D-106）。稼働日でなければ null */
  plannedHours: Interval | null;
  allDayEvents: CalendarEventView[];
  events: CalendarEventView[];
  /** その日のタスク（自分の番として帯に出ているものを除く）。時間に置いたかは timeBlocks で判断 */
  tasks: TaskView[];
  /** 前日の日付のタスクのうち、時間ブロックか実績がこの列の時間軸にかかるもの（0:00 をまたぐブロックを両日に描く。D-054） */
  crossTasks: TaskView[];
  timeBlocks: TimeBlockView[];
  timeEntries: TimeEntryView[];
  totals: DayTotals;
  /** 過去日のリボン（稼働区間の和集合）。今日・未来は空 */
  aiRibbon: Interval[];
  /** 今日だけ。他の日は null */
  aiLane: AiLaneItem[] | null;
}

export interface BoardResponse extends ReadMeta {
  days: DayColumn[]; // 古い日付から
  /** 暦の日付が変わったのに閉店していない論理日（= 今の論理日。0:00〜日付区切りの間だけ）。無ければ null（D-054） */
  openDay: LocalDate | null;
}
```

```ts
// day.ts
export interface WaitSegmentDetail extends Interval {
  waitKey: string;
  /**
   * grace は待ちの始まりからではなく、放置に数えうる時間に入ってからの最初の15分（D-058。phase0-plan 3.3.1）。
   * 夜に始まった待ちは「away → Mac を使い始めた時点から grace → idle」、会議中に始まった待ちは「event → 会議の終わりから grace」
   * の順に並ぶ。grace が会議で2つに分かれることもある（合計15分）
   */
  kind: "grace" | "idle" | "excluded" | "expired";
  excludedBy: "closed" | "away" | "event" | "snoozed" | "no_task" | "scheduled" | null;
  open: boolean;
  tone: "needs_input" | "your_turn" | "error";
  followUpId: string | null;
  endReason: "human_input" | "engaged" | "status_left" | "resolved" | "dismissed" | "expired" | "superseded" | null;
  /** 集計外の理由になった予定（ホバーで予定名は出さない。事実のみ） */
  eventId: string | null;
}

export interface AiRunDetail extends AiRun {
  toolCalls: number;
  editedFiles: number;
  inputTokens: number | null;
  outputTokens: number | null;
  endedWith: "end_turn" | "question" | "permission" | "error" | "aborted" | null;
}

export interface AiLaneItemDetail extends AiItemSummary {
  runs: AiRunDetail[];
  waits: WaitSegmentDetail[];
}

export type ClosedKind = "replied" | "resolved" | "not_needed" | "expired";

export interface ClosedTodayItem {
  followUpId: string;
  workItemId: string;
  title: TitleSpec;
  kind: ClosedKind;
  /** resolved の兆候（commit / new_session / pr_merged）。表示は「resolved · commit」 */
  signal: "commit" | "new_session" | "pr_merged" | null;
  closedAt: EpochMs;
}

export interface DayDetail extends Omit<DayColumn, "aiLane"> {
  aiLane: AiLaneItemDetail[];
  totals: DayTotals & { youMs: number; meetingsMs: number };
  closedToday: ClosedTodayItem[];
  freeSlots: Interval[];
  idleByRepo: { repoRoot: string | null; ms: number }[];
}

export interface DayResponse extends ReadMeta {
  day: DayDetail;
}
```

```ts
// queue.ts（M1 の QueueItem にフィールドを足す。既存のフィールドは変えない）
export interface QueueItem {
  workItemId: string;
  title: string | null;
  status: WorkItemStatus;
  reason: string | null;
  estimated: boolean;
  repoRoot: string | null;
  branch: string | null;
  prRef: string | null;              // 追加
  sources: { tool: SourceTool; profile: string | null }[]; // 追加
  waitingSince: EpochMs;
  /** 待ちの始まりが不在の間（在席区間の外。D-105）なら true。UI は長さでなく `since 22:51` と出す */
  waitStartedAway: boolean;          // D-105 で waitStartedOffHours から改名
  followUps: {
    id: string;
    kind: FollowUpKind;
    status: "open" | "snoozed" | "scheduled";
    /** status が scheduled（時間に置いた開始の前）のとき、帯に戻る時刻（時間ブロックの開始）。32章 */
    scheduledAt?: EpochMs;
    title: TitleSpec;                // 追加（タスクの題名。読み取り時に解決。6.1）
    triggerAt: EpochMs;
    snoozeUntil: EpochMs | null;
    engagedAt: EpochMs | null;
    expiresAt: EpochMs | null;
    taskId: string | null;
    /** 上限待ちが明けた後の再開（「再開できる」。kind は resume_error、artifact_ref が `:limit`、期限なし（再開するか対応不要まで残り、日をまたいでも残る。expiresAt は null））。MCP の list_your_turn は resume_limit と出す */
    limit?: boolean;
    /** M1 の形（CLI 用。保存値のまま）。UI は title を使う */
    task: { title: string; titleKey: string | null; titleParams: string | null } | null;
  }[];
}

export interface QueueResponse extends ReadMeta {
  /**
   * needs_input → error → your_turn、同じ状態内は待ちの長い順。
   * YOUR TURN のタスク（reply / review_pr / approve / resume_error。open / snoozed）が1件以上あるカードだけ（D-048 (4)）。
   * 状態が needs_input / error / your_turn でもタスクが無いカードは入れない。check_changes はタスクに数えない
   */
  items: QueueItem[];
  /** リセット前の上限待ち（自分の番の画面の「後で」だけ。item.limitWait 付き、followUps は空。32章） */
  limitWaits?: QueueItem[];
  /** 今日の閉じた件数（シャットダウン Step 1 の下、帯の閉じた行） */
  closedToday: Record<ClosedKind, number>;
  /**
   * 直近7日の平均応答時間（キュー画面）。1件の長さは壁時計ではなく、応答までの猶予と放置の区間の和
   * （勤務時間外・会議中・スヌーズ中などを除く。Idle と同じ物差し。D-057、phase0-plan 3.3.1 の集計値）
   */
  avgResponseMs: number | null;
}
```

```ts
// tasks.ts
export interface InboxResponse extends ReadMeta {
  tasks: TaskView[]; // 作成の新しい順。7日以上は UI が `8日前` を出す（createdAt から判断）。メモがあれば TaskView.hasNotes
}

// work-items.ts（M1 の detail を型付けし、時間内訳を足す）
export interface WorkItemDetail extends ReadMeta {
  workItem: AiItemSummary & { groupKey: string; manualDoneAt: EpochMs | null; firstActivityAt: EpochMs; lastActivityAt: EpochMs };
  turns: AiRunDetail[];
  artifacts: { kind: string; ref: string; url: string | null; title: string | null; state: string | null }[];
  followUps: { id: string; kind: FollowUpKind; status: string; triggerAt: EpochMs; closedAt: EpochMs | null; closeReason: string | null }[];
  waits: WaitSegmentDetail[];
  breakdown: {
    aiMs: number; youMs: number; idleMs: number; graceMs: number;
    excludedMs: Record<"closed" | "away" | "event" | "snoozed" | "no_task" | "scheduled", number>;
    /** 依頼から完了（または現在）までの壁時計の時間 */
    wallMs: number;
  };
  open: { resume: boolean; pr: string | null; folder: boolean };
  // D-116（AI の詳細パネル）: 種類だけ。コマンドの中身・エラーの本文は持たない（ADR 0005）
  permissionKind: "command" | "file" | "web" | "mcp" | "other" | null; // ブロック中の PermissionRequest の tool_name を丸めたもの
  errorKind: "rate_limit" | "overloaded" | "server_error" | "authentication" | "billing" | "other" | null; // StopFailure の hook の error（古い記録は error_type）。上限待ち（reason rate_limit）は種類の無い停止を quota_auto_resume_* の通知から推定したものも rate_limit
  graceMs: number; // 設定 wait.grace_min
}
// artifacts[] には reviewDecision（"approved" | "changes_requested" | "review_required" | null）と stateChangedAt（merged / closed の時刻）も入る（D-116）
```

### 2.4 組み立ての規則（サーバー）

- **1つの読み取りトランザクション**で1レスポンスを組み立てる（`db.transaction(() => …)()` の中で全クエリ）。
- **自分の番のタスクの扱い**: `follow_up.status IN ('open','snoozed')` に紐づくタスクは `DayColumn.tasks` に入れない（帯 = queue に出るため。D-025）。閉じた後のタスクは通常のタスクとして `tasks` に入り、`timeEntries` の `followup_estimate` の位置で時間軸に描かれる（`Check DnD ← AI 8m`）。対応不要・期限切れで `canceled` になったタスクは返さない。
- **時間軸に置く位置**: 時間ブロックがあればその位置（計画 = 枠線）。完了タスクで実績（`timeEntries`）があれば実績の位置（塗り）。どちらも無ければ Unscheduled。判定はクライアント（`lanes.ts` の入力を作る関数）で、サーバーは素材を返すだけ。
- **応答区間の接続先**（`TimeEntryView.respondsTo`）: `task_time_entry.task_id` → `follow_up.task_id` → `ai_wait_segment.follow_up_id` のうち、その応答の開始に最も近い終点を持つ待ち区間の `wait_key`。無ければ `waitKey: null`（AI 項目までだけ線を引く）。
- **AI 項目の `youMs`**: その AI 項目に紐づくフォローアップのタスクの実績の合計（その日の分）。日の `youMs`（デイビューの `You 3h10m`）は全タスクの実績の和集合（壁時計）。
- **`meetingsMs`**: 論理日の中の busy な時刻付き予定（終日を除く）の和集合（D-105 で勤務時間で切るのをやめた）。**`eventsMs`**（週ボードの `Events`）は勤務時間に関係なく busy な時刻付き予定の和集合。
- **容量（`freeMs` / `plannedMs` / `plannedUnestimated`）**: `packages/core/src/plan/capacity.ts` の純粋関数で計算する。定義は 9.1（D-047 (1)）。
- **YOUR TURN の絞り込み**（D-048 (4)）: `queue()` は、YOUR TURN のタスク（reply / review_pr / approve / resume_error のフォローアップで `open` / `snoozed`）が1件以上あるカードだけを返す。M1 の `queue()` は状態が needs_input / error / your_turn のカードをすべて入れていた（タスクのない your_turn が溜まり続けた）ので、状態による追加をやめ、フォローアップのあるカードだけにする。`turnlane queue` も同じ関数なので同じ結果になる。スヌーズ中のタスクしか無いカードは応答に入るが、UI はスヌーズが明けるまで帯・キュー・件数・通知に出さない（2.2 の `s`）。needs_input のカードは runner が必ずタスクを作る（D-049 (1)。phase0-plan 3.3）ので、この絞り込みで消えない。
- **時間に置いた自分の番のタスク**（D-051）: 返答・PR レビュー・許可待ち・再開のタスクに時間ブロックがあるとき、ブロックを作った時刻から開始までの待ちは集計外 `scheduled` になり、Idle に入らない（phase0-plan 3.3.1、シナリオ W38〜W41）。開始を過ぎれば放置に数える。`ai_wait_segment.excluded_by` に `scheduled` を足すマイグレーション `0004_d051_scheduled_wait.sql` が要る（区間はキャッシュなので行は写さずに作り直す）。開始の前は帯・件数・通知に出さず、自分の番の画面の「後で」に出す（`followUps[].status: "scheduled"`。32章。2026-10-26 に「帯・キューの扱いは変えない」を置き換えた）。時間ブロックのある自分の番のタスクは、ブロックの日付の `DayColumn.tasks` にも入れ（`followUpId` 付き）、時間軸にブロックとして描く（19章。2026-10-05 r4）。
- **タスクのない your_turn の72時間**（D-048 (4)）: `deriveStatus` で done（`reason: "no_task_expired"`）にする。規則は phase0-plan 3.3。M2-2 で実装し、シナリオ W33〜W35（phase0-plan 5.5）で確かめる。
- **自動生成タスクの題名**: どの応答でも `TitleSpec` を読み取り時に解決して返す（6.1）。
- **今日の AI レーン**: 今日の列（暦日）の時間軸にターンがかかる AI 項目と、未完了で今日へ持ち越した項目（M1 の `aiDays` と同じ規則）。持ち越した項目は今日の `runs` が空で、開いている待ち区間だけを持つ。項目の `aiMs` / `idleMs` / `turns` / `carriedFrom` は今の論理日（`today`）の値。
- **時間軸の範囲**（D-054）: `axis` は暦日の 0:00〜翌 0:00、`logical` は `dayStartMs(date)`〜`dayStartMs(date + 1)`。予定・時間ブロック・実績・AI の実行と待ちは時間軸にかかるものを返す（0:00 をまたぐものは両日に入る）。区間は範囲で切らずに返し、切り取りはクライアントで行う。
- **集計は論理日**（D-054）: `totals`、`workday`、容量（Free / Planned）、Events、Idle、Expired、AI は同じ日付の論理日の値。`totals` の算出に使う予定は論理日の範囲にかかるもの。
- **進行中の区間**: 稼働中のターンと開いている待ちは、`end = now`（応答時点）と `open: true` で返す。

## 3. 更新の配信（SSE）

### 3.1 方針

- **イベントは「無効化の合図」で、データは載せない**。載せるのは種類・影響した日付・ID・`rev` だけ（M0 の方針「メタデータだけ」を守る）。差分を送らないのは、(1) 集約の組み立て規則をクライアントに二重に持たないため、(2) 再取得がローカルで数 ms のため、(3) 取りこぼし（スリープ復帰・再接続）の復旧が「全部無効化」で済むため。
- **イベントの束ね**: 同じ種類のイベントは 250ms 束ねて1回にする（`dates` と `ids` は和集合）。取り込みのバックフィル中は runner の1回の実行で1回だけ送る。
- **進行中の伸びは送らない**: 稼働中のターンや開いた待ちの「終わりが伸びる」だけの変化ではイベントを送らない。クライアントが30秒ごとに `now` を進めて描き足す（`open: true` の区間の `end` を `max(end, now)` にする）。区間の行が増えた・消えた・区分が変わった（猶予 → 放置 など）・状態が変わったときだけ送る。

### 3.2 イベントの種類

| type | 送るとき | data |
|---|---|---|
| `hello` | 接続直後 | `{ bootId, rev, today }` |
| `task` | タスク・時間ブロック・実績の作成・変更・削除（API・MCP・CLI・runner のどれから書いても） | `{ rev, dates, ids, inbox: boolean }` |
| `work_item` | runner の1回の実行で、ターンの追加・更新、状態の変化、待ち区間の追加・削除・区分の変化、タイトルの変化があった | `{ rev, dates, ids }` |
| `follow_up` | フォローアップの作成・クローズ・スヌーズ・engage | `{ rev, ids, workItemIds }` |
| `calendar` | 予定の同期で変化があった | `{ rev, dates }` |
| `work_hours` | 勤務時間の自動検出・修正で値が変わった（新設） | `{ rev, dates }` |
| `source` | 取り込み元の健全性・設定の変化 | `{ rev }` |
| `day_boundary` | 日付区切りを越えた、または暦の日付が変わった（D-054） | `{ rev, today, displayToday }` |
| `backup` | バックアップ完了（UI は使わない） | `{ date }` |

M1 からの変更:
- runner の `publish` を「状態が変わったときだけ」から上の条件へ広げる（`apps/daemon/src/derive/runner.ts` の最後の3行。待ち区間は書き直し前後の `(wait_key, kind, excluded_by, start_at, is_open)` の集合を日付ごとに比べて、変わった日付を `dates` に入れる）。
- `work_hours` を新設する（今は勤務時間の変化を知らせる手段が無く、`Started 8:42 (auto)` が更新されない）。
- `rev` はデーモンのプロセス内で単調増加する整数（DB への書き込みのたびに +1。`mutate()` のフックで数える）。`bootId` はデーモン起動ごとの乱数。

### 3.3 再接続

- `EventSource` が切れて再接続したとき、`hello.bootId` が前回と違えば（デーモン再起動）、または前回の `rev` と `hello.rev` の差が受け取ったイベントの数と合わなければ、**全キャッシュを無効化する**。同じなら何もしない。
- スリープ復帰（`visibilitychange` で visible に戻った、または30秒以上イベントもハートビートも来ない）でも同じ判定をする。
- `day_boundary` を受けたら、`today` を更新し、全キャッシュを無効化する（週ボードの範囲も「昨日起点」で付け替わる）。

## 4. クライアントのデータ層

### 4.1 選定

| 案 | キャッシュと再取得 | 楽観的更新 | SSE との連携 | 依存 | 評価 |
|---|---|---|---|---|---|
| **A. TanStack Query v5（推奨・M2-1 で採用済み）** | キー単位のキャッシュ、`staleTime`、重複リクエストの束ね | `onMutate` / `setQueryData` / 巻き戻しの定型がある | `invalidateQueries({ predicate })` で日付の重なりを判定できる | 1つ（TanStack Router と同じ系統） | 採用 |
| B. SWR | 似ている | 書き方が手作り寄り | `mutate(key)` のキー照合が文字列ベースで、日付範囲の重なりを書きにくい | 1つ | 不採用 |
| C. 自前のストア（Zustand + fetch） | 自分で書く | 自分で書く | 自由 | 1つ | 再接続・重複・巻き戻しを全部書くことになる。不採用 |

設定: `staleTime: Infinity`（鮮度は SSE が保証する。ポーリングしない）、`refetchOnWindowFocus: false`（スリープ復帰は 3.3 で扱う）、`retry: 1`、`gcTime: 5分`。

### 4.2 キャッシュキー

| キー | API | 主な利用 |
|---|---|---|
| `["board", from, to]` | `/api/board` | 週ボード、朝の Step 3（`from = to = today`） |
| `["day", date]` | `/api/day/:date` | デイビュー |
| `["queue"]` | `/api/queue` | YOUR TURN 帯、キュー、儀式、サイドバー件数、タブタイトル、通知 |
| `["inbox"]` | `/api/inbox` | Inbox、サイドバー件数 |
| `["workItem", id]` | `/api/work-items/:id` | AI 詳細パネル |
| `["ritual", "morning" \| "shutdown", date]` | `/api/rituals/*` | 儀式（M4） |
| `["search", q]` | `/api/search` | ⌘K（`staleTime: 0`、無効化しない） |
| `["sources"]` / `["health"]` / `["settings"]` | 各 API | 枠・設定 |

### 4.3 イベント → 無効化

`dates` と範囲の重なりの判定は `overlaps(key, dates)`（`board` は `from - 1 ≤ d ≤ to`、`day` は `d = date` か `d = date - 1`、`ritual` は一致）。`dates` は論理日で、暦日の時間軸の 0:00〜日付区切りには前日の論理日のものを描くので、`board` と `day` は1日前まで含める（D-054。23章）。

| イベント | 無効化するキー |
|---|---|
| `task` | `board` / `day`（`dates` と重なるもの）、`inbox: true` なら `inbox`、`ritual`（同じ日付） |
| `work_item` | `board` / `day`（`dates` と重なるもの）、`workItem`（`ids` に含まれるもの）、`queue` |
| `follow_up` | `queue`、今日を含む `board`、今日の `day`、`workItem`（`workItemIds`）、`ritual` |
| `calendar` | `board` / `day`（`dates` と重なるもの） |
| `work_hours` | `board` / `day`（`dates` と重なるもの）、`ritual`（同じ日付） |
| `source` | `sources`、`health` |
| `day_boundary` | すべて |

- 応答の `rev` が、そのキーに対して最後に受けたイベントの `rev` より小さいときは、その応答を捨ててもう一度取る（イベントと読み取りが行き違ったときに古いデータで上書きしないため）。実装は `queryFn` の中で比べるだけ。
- 自分の操作が起こしたイベントも同じように無効化する（発信元で除外しない）。楽観的更新の結果とサーバーの結果は同じなので、再取得で表示は変わらない。

### 4.4 楽観的更新

- 定型（`apps/web/src/data/mutations.ts` に1か所）: `onMutate` で影響するキーの取得を `cancelQueries` → 直前の値を退避 → `setQueryData` で書き換え → `onError` で戻してトースト（「Couldn't save. Restored.」）→ `onSettled` で影響するキーを無効化。
- 影響するキーは操作ごとに表で持つ（例: タスクの日付移動 = 移動前と移動後の日付を含む `board` / `day`、`date: null` への移動は `inbox` も）。
- 書き換えは core の純粋関数で行う（`applyTaskMove(board, …)` など。`packages/core/src/api/optimistic.ts`）。並べ替えの `laneOrder` はクライアントで `orderKeyBetween` を計算して仮に置き、サーバーの結果で確定する。
- 自分の番の操作（snooze / dismiss / complete）は `["queue"]` から該当の行を消す（complete は閉じた行として残す）。今日の `board` は再取得に任せる（帯は queue を読むので即座に反映される）。
- 作成は `clientId`（UUIDv7）を仮 ID にして、そのままサーバーの ID になる（置き換えが要らない）。
- 楽観的更新をしないもの: シャットダウン・朝の計画の完了（まとめて書くので結果を待つ）、マージ、再取り込み。

## 5. 時間軸の配置計算

| 案 | 内容 | 評価 |
|---|---|---|
| A. サーバーで列と位置まで計算する | 応答に `column` / `top` / `height` を入れる | 不採用。最小高さ（AI 20px / 自分 16px）はピクセル単位で、1時間の高さ（ズーム）と幅で結果が変わる。DnD 中の仮配置もサーバー往復になる |
| **B. クライアントで計算する（推奨・M2-13 の計画どおり）** | サーバーは時刻だけ返す。`packages/core/src/layout/lanes.ts` の純粋関数で列と位置を決める | 採用 |
| C. サーバーで列だけ、クライアントで高さ | 列割り当てだけサーバー | 不採用。最小高さを守ると重なりの判定自体が変わる（W1: 8:50–8:58 と 8:58–9:06 は時刻上は重ならないが、16px の最小高さでは重なる）ので、列と高さは同時に決める必要がある |

`lanes.ts` の仕様:

```ts
export interface LaneInput { id: string; start: EpochMs; end: EpochMs; minPx: number }
export interface LaneOptions { axisStart: EpochMs; pxPerMs: number; maxColumns: number /* AI 3、自分は Infinity */ }
export interface Placed { id: string; top: number; height: number; column: number; columns: number }
export function placeLanes(items: LaneInput[], o: LaneOptions): { placed: Placed[]; overflow: { top: number; height: number; hidden: string[] }[] };
```

- 表示上の終わり `visEnd = max(end, start + minPx / pxPerMs)` で重なりを判定する（W1）。開始位置は実時刻のまま（D2）。
- 重なりのまとまり（連結成分）ごとに、開始順に空いている最も左の列へ入れる。まとまりの列数で幅を割る。
- `maxColumns` を超えたまとまりは、超えた分を `overflow` にまとめて `+N` を出す（AI 3列）。
- 待ち区間は AI 項目の列にぶら下げる（デイビュー: 実行ブロックの下端から引く）ので、`placeLanes` の対象は AI の実行ブロックだけ。待ちの線は同じ列に描く。
- 週ボードの今日の AI レーンは、`placeLanes` の前に `packages/core/src/layout/ai-lane.ts` でターン（`aiLane[].runs`）をひと続きの作業にまとめる（D-061、ux-mvp 4.4 / W7）。デイビューの AI レーンも同じ `spansOf` でまとめる（D-065。まとめ表示 `layoutAiLane` は週ボードだけ）。サーバーの応答はターンごとのまま変えない（デイビューでブロックを開いたときの内訳と、詳細パネルのターン一覧に使うため）。
  ```ts
  // 同じ AI 項目のターンを、前の終わりから次の始まりまでが gapMs（30分）未満ならつなぐ。aiMs はターンの長さの和（開いているターンは now まで）
  export function spansOf(runs: AiRunLike[], o: { gapMs: number; now: EpochMs }): AiSpan[];
  // 5分未満の完了ブロック（collapsible）が表示上の下端から gapPx 未満で続くとき、2件以上を1つのまとめ（✓ N runs · 3m）にし、残りと一緒に列に分ける（3列、超えたら overflow）
  export function layoutAiLane(blocks: AiLaneBlockInput[], o: AiLaneOptions): { placed: AiLaneBox[]; overflow: Overflow[] };
  ```
- 範囲外のヒント（`↑ 1 AI run at night`）は、スクロール位置と `aiLane[].runs` からクライアントで数える。
- 表駆動の単体テスト（W1 の3ブロック、D2 の2列、AI 4並列 → 3列 + `+1`、日付区切りをまたぐ区間、DST の日）。

## 6. i18n: サーバーが返す値

### 6.1 自動生成タスクの題名（D-046、D-047 (3)、D-048 (3)）

保存形式（M1 の Idle 修正で実装済み。マイグレーション `0003_d045_idle_titles.sql`、`packages/core/src/i18n/task-title.ts`。phase0-plan 3.3）:
- `task.title_key`: `NULL` = ユーザーが書いた題名。自動生成なら `followup.reply` / `followup.approve` / `followup.review_pr` / `followup.resume_error` / `followup.check_changes` / `followup.merge_pr`。
- `task.title_params`: JSON。`{"title": "...", "repo": "turnlane", "branch": "feat/x", "pr": 142, "prTitle": "..."}`。作成時点の値で、無いものは null。
- 自動生成タスクの `task.title` は `''`。CLI（`turnlane queue`）・MCP・エクスポートは core の `taskDisplayTitle(row, locale)` を通して英語で組み立てる。
- 0003 より前に作った自動生成タスクは `title_key` が NULL で、英語の文字列が `title` に残っている。そのまま表示し、埋め直さない（期限切れと D-048 (4) で、残っているものはほぼ閉じる）。
- ユーザーが題名を変えたら（`PATCH title`）`title_key` / `title_params` を NULL にし、`title` に書いた文字列を入れる。

**読み取り時の解決（M2-2）**: `title_params` は作成時点の値なので、API が返す `TitleSpec.params` は読み取り時に AI 項目の現在の値で上書きする（D-047 (3)・D-048 (3)）。AI 項目の名前を直したり、PR のタイトルが変わったりしたら、タスクの題名もついてくる。

| params | 読み取り時の値 | 取れないとき |
|---|---|---|
| `title` | AI 項目の `title_user ?? title_auto` | 保存値 |
| `repo` / `branch` | AI 項目の `repo_root` の最後の要素 / `branch` | 保存値 |
| `pr` | 保存値（PR 番号は変わらない） | — |
| `prTitle` | 同じ AI 項目の `ai_artifact(kind='pr')` のうち番号が `pr` のものの `title` | 保存値 |

- 参照のたどり方: `task.id` → `follow_up.task_id`（M1 の一意インデックス `follow_up_task_uq`）→ `follow_up.work_item_id` → `work_item`。統合されたカードは `merged_into_id` をたどる（runner と同じく10段まで）。予備として `task.source_ref = 'follow_up:<id>'` からもたどれる。
- **スキーマの変更は要らない**（マイグレーション 0004 は使わない）。参照は M1 の `follow_up.task_id` で足り、`title_params` に `workItemId` を足す必要もない。将来の同期（Phase 1）で `follow_up` と `work_item`（どちらも `local_only`）が無い端末では、保存値で組み立てる。そのときに参照が必要になっても、`title_params`（JSON）にキーを足せば済み、列の追加は要らない。
- 解決は1か所の関数にまとめる（`apps/daemon/src/derive/views.ts` の `resolveTaskTitles(db, taskIds)`。1回のクエリで `follow_up`・`work_item`・`ai_artifact` を結合する）。`/api/board`・`/api/queue`・`/api/inbox`・`/api/day`・`/api/search`・`turnlane queue`・日報（M4-3）が同じ関数を通す。
- 日報は確定時（`Close the day`）の題名で `report_md` に残す。後から AI 項目の名前を直しても、確定済みの日報は変えない。

辞書: M1 の `packages/core/src/i18n/task-title.ts`（英語・日本語）を正とする。M2-12 で web の i18n 基盤ができたら、キー（`followup.*`）はそのままで web から同じ関数（`formatTaskTitle(key, params, locale)`）を呼ぶ。日報（M4-3）とブラウザ通知（M2-8）も同じ関数で組み立てる。日報はサーバーで作るので、題名の辞書は core に置いたままにする（画面の文言の辞書は web に置く）。

| title_key | 英語 | 日本語 |
|---|---|---|
| `followup.reply` | `Reply: {subject}` | `返答: {subject}` |
| `followup.approve` | `Approve: {subject}` | `許可: {subject}` |
| `followup.review_pr` | `Review PR #{pr}: {prTitle ?? subject}` | `PR #{pr} をレビュー: {prTitle ?? subject}` |
| `followup.resume_error` | `Resume: {subject}` | `再開: {subject}` |
| `followup.check_changes` | `Check changes: {subject}` | `変更を確認: {subject}` |
| `followup.merge_pr` | `Merge PR #{pr}: {prTitle ?? subject}` | `PR #{pr} をマージ: {prTitle ?? subject}` |

`{subject}` は `title`、無ければ `{repo}#{branch}`（片方だけならその値）、それも無ければ `AI work` / `AI の作業`。`pr` が無ければ `#?`。

### 6.2 その他の値

| 値 | サーバーが返すもの | クライアントの表示 |
|---|---|---|
| 状態 | `WorkItemStatus` | 状態アイコンと辞書のラベル |
| 状態の理由 | `reason`（列挙の文字列） | 辞書（未知の値はそのまま mono で） |
| 待ちの区分 | `kind` / `excludedBy` | `idle 11m`、`off hours`、`in meeting`、`no task`、`snoozed`、`scheduled`、ホバーの `Working hours · no event` / `Counts toward Idle` |
| 閉じ方 | `ClosedKind` と `signal` | `replied` / `resolved · commit` / `not needed` / `expired` |
| 時間 | ms | 共通の整形関数（`1h12m`、`<1m`。ASCII、ロケールに依らない） |
| 時刻 | epoch ms | `HH:mm`（ASCII）。日付と曜日は `Intl.DateTimeFormat` |
| 待ちの表示 | `waitingSince`、`waitStartedAway`、`expiresAt` | `7m` / `since 22:51` / `expires in 18h` |
| 持ち越し | `rolloverCount`（数え方は 9.2） | `↺ yesterday` / `↺ 3` |
| 経由 | `origin` | `CLI` / `MCP via <client>` / 外部ソースの chip |
| ソースバッジ | `sources[].tool` / `profile` | `CC` / `CX` / `CD`、同じツールの有効なソースが2つ以上のときだけ `CC·main` |
| エラー | `{ error: "<code>" }`（`not_found`、`conflict` など） | 辞書。メッセージ文はサーバーで作らない |

## 7. phase0-plan の M2 タスクとの対応

| タスク | この文書の範囲 |
|---|---|
| M2-1 | 4.1 の設定、SSE クライアント（3.3 の再接続判定、4.3 の無効化表） |
| M2-2 | `/api/board`、`/api/queue` の拡張と絞り込み（D-048 (4)）、`/api/inbox`、タスクと時間ブロックの CRUD・`move`・`restore`、`packages/core/src/api/` の型と Zod、題名の読み取り時の解決（6.1。D-046 の保存形式と runner の書き込みは M1 で実装済み）、タスクのない your_turn の72時間（`deriveStatus`。phase0-plan 3.3、シナリオ W33〜W35）、SSE の送り方の修正（3.2）、`plan/capacity.ts`（9.1）、`app.request` の API テスト。**`/api/day/:date` は M2-19 へ移す**（デイビューは常用中 B のため） |
| M2-13 | `layout/lanes.ts`（5章） |
| M2-3 / M2-14 | `DayColumn` / `AiLaneItem` の描画 |
| M2-6 | `QueueItem` の描画と自分の番の操作、楽観的更新 |
| M2-4 / M2-7 | タスク操作 API と楽観的更新（4.4） |
| M2-5 | `WorkItemDetail` の `breakdown` と `open` |
| M2-8 | `["queue"]` の変化から通知（新しく出た `followUps[].id` を前回と比べる） |
| M2-15 | `/api/search` |
| M2-16 | `aiRibbon`、範囲外のヒント、`TimeEntryView.respondsTo` によるホバーの接続線 |
| M2-17 | 楽観的な日付移動、DnD 中の容量の再計算（`capacity.ts`） |
| M2-18 | 時間ブロックの CRUD、`/api/free-slots` |
| M2-19 | `/api/day/:date`（`DayDetail`、待ちの3区分、接続、Closed today、空き枠） |
| M4-1 / M4-2 / M4-7 | `/api/rituals/*` は M4 で作る。Step 3 の左側は `["board", today, today]` を使う |

## 8. 見積への影響

D-047 (5) で +0.5日を了承した。D-046 の保存形式は M1 の Idle 修正で実装済みなので M2-2 から外し（D-047 (2)）、題名の読み取り時の解決と D-048 (4) を M2-2 に入れた。phase0-plan 4.4・4.9 に反映済み。

| タスク | 前 | 後 | 段階 | 内訳 |
|---|---|---|---|---|
| M2-2 | 1.25 | 1.5 | A | SSE の送り方の修正（待ち区間の比較、`work_hours`、`rev`、束ね）+0.25、`/api/day` を M2-19 へ移して -0.25、題名の読み取り時の解決（D-047 (3)）と YOUR TURN の絞り込み・タスクのない your_turn の72時間（D-048 (4)。`deriveStatus`、`queue()`、シナリオ W33〜W35）+0.25。D-046 の保存形式（当初案の +0.25）は M1 で実装済みのため 0 |
| M2-19 | 1.5 | 1.75 | B | `/api/day/:date` を M2-2 から受け取る（待ちの3区分、接続、Closed today、空き枠） |
| M2 計 | 16.5 | 17 | A 11.75 / B 5.25 | |

- 常用開始の最小範囲は 17.25 → 17.5人日。Phase0 の合計は 48.5 → 49人日。
- 容量の定義の確定（9.1）は `capacity.ts` の範囲内で、見積は変えない（見積なしを30分とみなす分岐と件数を返すだけ）。
- M1 の見積（11.5）は変えていない。Idle 修正（D-045・D-046）は完了済みの M1 への追加として扱った（D-042）。
- `/api/day` を B に移すことで、常用開始前にデイビュー用の待ちの3区分・接続・Closed today を組み立てなくてよくなる。週ボード（A）は2区分で足りる（D-028）。

## 9. 確定した定義と残る判断

### 9.1 容量（Free / Planned）（D-047 (1)。D-062 で勤務の窓を計画上の勤務時間に変更。確定）

置き場所: `packages/core/src/plan/capacity.ts`（純粋関数。サーバーが `DayTotals` に入れて返し、DnD 中はクライアントが同じ関数で再計算する）。勤務の窓（`workWindow`）は週ボードの背景（勤務時間外の灰色。D-063）と共通。

```ts
export interface CapacityInput {
  phase: "past" | "today" | "future";
  now: EpochMs;
  /** その日の実績の開始（今日は修正値 → 自動の値の順）。操作がまだ無ければ null */
  workStart: EpochMs | null;
  /** 今日の終了を修正していればその値。無ければ null（下の規則で決める） */
  workEndEdited: EpochMs | null;
  /** その日の計画上の勤務時間（phase0-plan 3.3.1、D-062）。稼働日でない日は null */
  planned: Interval | null;
  /** 稼働日か（null = 判定できない。稼働日として扱う）。未来の稼働日でない日は Free を 0 にする（D-049 (2)） */
  workday: boolean | null;
  /** busy な予定（phase0-plan 3.3.1 と同じ定義。終日の busy を含む。自分の時間ブロックは含まない） */
  busy: Interval[];
  /** 対象のタスクの見積（下記） */
  estimates: (number | null)[];
}
export interface Capacity { freeMs: number; plannedMs: number; plannedUnestimated: number }
export function capacity(i: CapacityInput): Capacity; // past は 0 を返し、UI は出さない
```

| 値 | 定義 |
|---|---|
| 計画上の勤務時間 | 設定 `work_hours.planned`（曜日ごと。既定 10:00〜19:00）。稼働日（稼働曜日かつ祝日でない）だけ。学習した「いつもの勤務時間」は使わない（D-062。学習値は設定画面の提案に出すだけ） |
| 勤務の窓（今日） | 開始 = 実績の開始（修正があれば修正値）。まだ操作が無ければ計画の開始。終了 = 修正があれば修正値。無ければ、作業を始めていれば「計画の終了」と現在時刻の遅い方（計画の終了を過ぎても続けていれば今まで）、始めていなければ計画の終了。稼働日でない今日は、始めていれば開始〜現在時刻、始めていなければ窓なし |
| 勤務の窓（未来） | 計画上の勤務時間。稼働日でない日（土日・祝日。M3-6 の判定）は窓なし（Free 0 で、ヘッダに出さない。D-049 (2)）。休みの日を計画の置き場に見せないため |
| 過去 | 出さない（ヘッダは `6/8 done · AI 3h40m · Idle 25m`）。背景の窓は実績の勤務時間 |
| Free | 勤務の窓の長さ −（busy な予定の和集合と窓の重なり）を **15分単位に切り捨てる**（D-062）。0 未満にしない。時間ブロックは引かない（計画は Planned 側で数える） |
| Planned | 対象のタスクの `estimate_min` の和。見積の無いタスクは 30分とみなす |
| `plannedUnestimated` | 見積が無く 30分とみなした件数。1以上なら UI は `Planned ~2h10m` と `~` を付けて推定であることを示す |
| 対象のタスク | `scheduled_date` がその日で、`status IN ('todo', 'doing', 'done')`。フォローアップから作った自分の番のタスク（`source_ref LIKE 'follow_up:%'`）は数えない（置いたタスクではなく、YOUR TURN 帯に出るもの）。今日の完了済みも数える（Free が今日の経過分を含むので範囲を揃える。D-049 (3) で確定） |

- 超過の警告（朝の計画 Step 3 の `Over by 1h30m.`）は `plannedMs > freeMs` で出す。週ボードのヘッダは超過しても色を付けない（C3）。
- 見積なしを 0 にしないのは、0 にすると朝の超過の警告が出ず計画が甘くなるため（D-047 の理由）。
- `DayColumn` に `plannedHours: Interval | null`（その日の計画上の勤務時間。稼働日でなければ null）を足した。`WorkHours.source` の `"usual"` は `"planned"` に変えた（未来の日と、まだ操作の無い今日は計画上の勤務時間を返す。稼働日でなければ `workHours` は null）。
- 設定: `work_hours.planned`（`turnlane config get|set`。値は `{"mon":{"start":"10:00","end":"19:00"}, …, "sun":…}`。書いていない曜日は既定値。終了は開始より後で 24:00 まで）。変えたら SSE `work_hours`（窓の日付）と `settings` を送る。
- 時間軸の背景（D-063、D-078）: 勤務の窓の外を off-hours の塗り＋斜線にする（D-080。D-078 は斜線だけ）。今日は上の「勤務の窓（今日）」（今より後でも計画の終了までは白）、過去は実績、未来は計画上の勤務時間。夜の続き（D-054）は従来どおり斜線なし。斜線の上のホバーで `Outside working hours · not counted as idle`（日本語 `勤務時間外 · 放置に数えません`）。

### 9.2 持ち越し回数（D-047 (4)。確定）

- `task.rollover_count` を +1 するのは2つだけ: シャットダウンの自動持ち越し（`POST /api/rituals/shutdown/complete` の中。D-040）、朝の計画 Step 2 の `Today t`（`POST /api/tasks/:id/move {date: today, carry: true}`）。
- 数えないもの: 手での日付の移動すべて（`m`、`>` / `<`、ボードの `t`、DnD、Step 2 の `Pick a day m`、Inbox からの移動）。`move` は `carry` を省略すると加算しない。
- 表示は `↺ yesterday`（1回）、`↺ N`（2回以上）。ux-mvp 4.4。

### 9.3 回答済みの判断事項（旧 9 章）

| 旧 | 内容 | 回答 |
|---|---|---|
| 1 | 容量（Free / Planned）の定義 | 9.1（D-047 (1)） |
| 2 | D-046 をどこで入れるか | M1 の Idle 修正で実装済み（マイグレーション 0003）。M2-2 の見積から外す（D-047 (2)） |
| 3 | 題名の `subject` を追従させるか | 読み取り時に AI 項目の現在のタイトルで組み立てる（D-047 (3)・D-048 (3)）。6.1。パラメータ名は実装の `title` |
| 4 | 手での日付移動で `rollover_count` を数えない | 確定（D-047 (4)）。9.2 |

### 9.4 残る判断への回答（D-049。2026-10-03）

| # | 内容 | 回答 |
|---|---|---|
| 1 | タスクの無い needs_input のカードを YOUR TURN に出すか | **needs_input は必ずタスクを作って YOUR TURN に出す**（D-049 (1)）。許可待ちは approve（hooks なしでプロセスが idle の場合も）、AskUserQuestion は reply（`artifact_ref = <turn_id>:ask`）を、hooks の有無によらず待ちの開始ですぐ作る。AI が自分を待っている瞬間を見せるのがプロダクトの芯で、帯にも通知にも出ないのは不可。規則は phase0-plan 3.3・3.3.1、シナリオ W36・W37。72時間より古く resume_error を作らなかった error は、従来どおりタスクが無いので出さない |
| 2 | 稼働日でない未来日の Free | 出さない（0）。9.1（D-049 (2)） |
| 3 | Planned に今日の完了済みタスクを含める | 含める。9.1（D-049 (3)） |

残る判断は無い。

## 10. 実装で足したもの（M2 段階 A。2026-10-04）

M2-2 の実装で、上の型と一覧に次を足した（どれも既存のフィールドは変えていない）。

| 対象 | 足したもの | 理由 |
|---|---|---|
| `ReadMeta` | `tz`（IANA 名）、`dayBoundary`（0 時からの分） | クライアントが時刻 `13:20` と論理日付をサーバーと同じ規則で描くため |
| `QueueResponse` | `closedRows`（今日閉じた自分の番の行。題名・閉じ方・兆候） | YOUR TURN 帯の「返答済みは取り消し線、解決済みは `~ resolved`」で閉じた行を残すため（件数の `closedToday` だけでは描けない） |
| `TaskView` | `workItemId`（自分の番のタスクの元の AI 項目）、`deletedAt` | 閉じた自分の番を時間軸に置くときの `← AI` 表示、⌘Z の取り消し |
| `POST /api/tasks` | `source`（`manual` / `cli` / `mcp`）、`client`、`cwd`、`placeFirst`、`priority` | MCP の `source_ref = mcp:<client>:<cwd>`（phase0-plan 3.5）、CLI の印、`c` で先頭に置く |
| `GET` / `PUT /api/settings/ui` | `{ theme: system / light / dark, language: system / en / ja }`（`setting` の `ui.theme` / `ui.language`） | テーマ（M2-11）と言語（M2-12）の保存。設定画面の本体（M2-9）は段階 B |
| SSE | `settings`（画面の設定が変わった）、`ping`（15秒ごと。コメント行の代わり） | 別タブの設定の反映。ハートビートを EventSource で受けられるようにし、スリープ復帰の判定（3.3）に使う |
| `rev` | イベントを送るたびに +1（プロセス内）。書き込み系の応答の `rev` は書いた時点の値（イベントは 250ms 束ねた後に送る） | 3.2 の「DB への書き込みのたびに +1」を、取りこぼしの判定（3.3）に必要な「送ったイベントの数」に揃えた |
| `ReadMeta` | `displayToday`（暦日）。D-054 | 表示（週ボードの「今日」の列）を暦日、集計と儀式を論理日で区切るため |
| `DayColumn` | `logicalPhase`、`logical`、`nightWork`、`crossTasks`。`axis` を暦日の 0:00〜翌 0:00 に変えた。D-054 | 同上。0:00 をまたぐブロックを両日に描き、夜の続きを勤務時間として描く |
| `BoardResponse` | `openDay`。D-054 | 0:00 を過ぎて前の日が未閉店のときの案内 `Sun 10/4 is still open · Close the day` |
| `GET /api/projects` | `{ projects: { id, name, color }[] }` | サイドバーの Projects。プロジェクトは `#name` でタスクを作ると無ければ作られる |
| `POST /api/tasks` | `projectName`（無ければ作る） | MCP の `add_task` の `project` |
| SSE の `task` | `addedBy`（MCP から作ったときのクライアント名か外部ソース名） | UI のトースト「<client> added a task. [Undo]」（ux-mvp 5章） |
| `POST /api/work-items/:id/open`（13章の `POST /api/open` で置き換えて廃止） | `{ target, command, url, path }`。resume は `cd <cwd> && [CLAUDE_CONFIG_DIR=… / CODEX_HOME=…] claude --resume <id>`（Codex は `codex resume <id>`）を返し UI がコピー、pr / folder はデーモンが `open` を実行 | phase0-plan 3.4 の具体化 |
| `turnlane add` の spool | デーモン停止中は `spool/cli-YYYYMMDD.jsonl` に `{v, kind: "add_task", at, body}` を書き、デーモンが起動時と1分ごとに取り込んで消す（`clientId` と外部の識別子で冪等） | phase0-plan 3.6 |
| 週ボードの `workday` | 稼働曜日（`workdays.weekdays`、既定 月〜金）かつ祝日カレンダーの終日予定の日でない。M2 では土日を除く平日だけで、M3 の A で稼働曜日の設定と祝日を足した | D-049 (2) を M3-6 より前から効かせる。D-040 |
| `GET /api/health` の `calendarHelper` | `{ connected, authorization, version, lastSyncedAt }`。UI はサイドバーの Sources に Calendar の行を出す（未接続は「Calendar off」、権限なしは「Calendar: no access」）。接続・切断・権限の変化は SSE `source` で知らせる（`health` を無効化） | M3 の A。ヘルパが未接続でも他の機能は動くことを画面で示す |

## 11. M4 段階 A で足したもの（2026-10-04）

> **廃止（D-192。2026-10-14）**: 儀式の API（`GET /api/rituals/shutdown`・`GET /api/rituals/morning`・`POST /api/rituals/morning/complete`・`POST /api/rituals/shutdown/complete`・`POST /api/rituals/shutdown/reopen`）と、閉じる概念の値（`QueueResponse.dayClosedAt`・`notifyPausedUntil`、`BoardResponse` / `DayResponse` の `openDay`・`todayClosedAt`、`DailyReport.afterClose`、`UsageStats.afterClose`、設定 `notifyNeedsInputAfterClose`・`morningPrompt`）を消した。残るのは `GET /api/reports/daily/:date`（記録。確定の後に移した持ち越しを足して返す）、`PUT /api/daily-notes/:date`（メモ）、`/api/daily-notes/:date/summary`、`POST /api/follow-ups/:id/defer`、`POST /api/usage`、`GET /api/stats`（利用日は「アプリを開いた日」）。持ち越しは `POST /api/days/:date/carry { older? }`（その日に残っている自分のタスクを今日の未定へ。時間ブロックは外し `rollover_count` +1。`older` でそれより前の日付（14日）の残りも。応答 `{ rev, to, moved: { taskId, from, blocks }[] }`。移した事実は `usage_event(kind='carry', ref='<元の日>:<移した日>:<task id>')`）と `POST /api/days/carry/undo { moved }`（元の日付・元のブロック・持ち越し回数に戻す）。`DayColumn.carry?: { count, older }`（今日より前の列。`older` は範囲の最初の過去の列だけ）。`QueueResponse.handled7d`（直近 7 日に処理した自分の番。返答・解決・対応不要。期限切れは含まない。閉じた日で数える。ux-mvp 4.6）。以下は履歴として残す。

| 対象 | 足したもの | 理由 |
|---|---|---|
| `GET /api/rituals/shutdown?date&lang` | `ShutdownResponse`（`report: DailyReport`、Note を除く本文の `markdown`、確定済みの `savedMarkdown`、`closedAt`） | シャットダウンの Step 2。日報は事実の構造で返し、文言は `core/report/daily.ts` が言語ごとに組み立てる（6章の方針） |
| `POST /api/rituals/shutdown/complete` | `{date?, note?, markdown?, lang?}`。未完了タスクを次の稼働日へ（`rollover_count` 加算）、`daily_note.report_md` / `memo_md` / `shutdown_done_at` を書く。`usage_event(kind='ritual_shutdown', ref=<date>)` | M4-2。帯に出ている自分の番のタスクは持ち越さない（帯で扱う）。既に閉じた日に呼ぶと「日報の更新」（D-069）: 持ち越し・`shutdown_done_at`・`usage_event` はそのままで、`report_md` と `memo_md` だけを書き直す。`markdown` を省いたら保存済みの本文（Note を除く）を使う |
| `GET /api/reports/daily/:date?lang&format=md` | 確定済みならその Markdown、未確定なら今の事実から組み立てたもの。`:date` に `today` を使える | 日報の画面、`turnlane report`、MCP `get_daily_report` |
| `PUT /api/daily-notes/:date` | `{note: string \| null}`（Note の1行） | Step 2 の Note |
| `POST /api/usage` / `GET /api/stats?days` | `{kind: "ui_open"}` / `UsageStats` | M5-1（`turnlane stats`） |
| `QueueResponse` | `dayClosedAt`（今日を閉じた時刻） | 閉店モードの表示 |
| `QueueFollowUp` | `taskDate`（タスクの日付） | Step 1 の `m` で次の稼働日へ移した行を「→ Mon 10/5」と出す |
| 日付区切り | 前の日を閉じていなければ、その時点の日報を `report_md` に確定する（持ち越しはしない。`shutdown_done_at` は書かない） | M4-4。期限切れが後から Idle を変えても日報は変わらない（3.3.1） |
| `ShutdownResponse` | `nextWorkday`（次の稼働日。稼働曜日と祝日カレンダー）。`ReportCarryLine` に `skippedHolidays`（飛ばした祝日の日付と名前） | M3 の A（M3-6）との結合。Step 1 の `m` の行き先と、日報の Carried over の理由（`→ Tue 10/13 (Mon 10/12 is a holiday: …)`。phase0-plan 4.5） |
| `POST /api/follow-ups/:id/defer` | 応答 `{rev, followUpId, taskDate, snoozeUntil}`。タスクの日付を次の稼働日（祝日を除く。ShutdownResponse の `nextWorkday` と同じ）へ（手での移動なので `rollover_count` は加算しない）、フォローアップを次の稼働日の計画上の勤務開始（D-064）までスヌーズ（`snoozes_json` に区間を残す）。タスクの無いフォローアップはスヌーズだけ | D-052 (1)。シャットダウン Step 1・YOUR TURN 帯・キューの `m`。2.2 の `m` 明日を置き換えた。Step 1 はスヌーズ中でも `taskDate` が今日より後の行を「→ Mon 10/5」で残す |
| `QueueResponse` | `notifyPausedUntil`（閉店モードが明ける時刻。閉店モードでなければ null） | D-052 (2)。最後に閉じた日の次の稼働日の計画上の勤務開始（D-064）。それより前に後の日付の操作（`work_day_auto.first_op_at`）があればその時刻。UI はこの時刻まで通知をすべて止める |
| `GET` / `PUT /api/settings/ui` | `notifyNeedsInputAfterClose`（`setting` の `notify.needs_input_after_close`、既定 false） | D-052 (2)。オンなら閉店モード中も needs_input だけ即時通知する。設定画面の Notifications |
| `ReportAiResult`（`kind: "status"`） | `waitingFor: "answer" \| "approval" \| null`（needs_input のときだけ。カードの `status_reason` が `ask_user_question` なら answer、それ以外は approval） | D-052 (3)。`waiting for your answer` / `waiting for approval` の書き分け |
| AI の時間（`work_item_daily.ai_ms` の代わり） | 日報・`/api/work-items`・週ボードの AI カード・AI 詳細パネルの `aiMs` は、終わったターンの `duration_ms` の和に、終わっていないターンの始まりから「カードが running なら now、needs_input なら開いている待ちの始まり、それ以外は最後の活動」までを足す（core の `derive.turnAiMs`）。StopFailure・idle_prompt の後に活動の無い終わっていないターンは、その hook の時刻で終わったものとして数える（ai-session-ingestion 4.3 の「hooks が補う終わり」） | D-052 (4)。`work_item_daily` は `duration_ms` の和なので、実行中・待ち中のカードが 0m になっていた |

## 12. デスクトップアプリで足したもの（2026-10-05。[desktop-shell.md](desktop-shell.md)）

| 種類 | 内容 |
|---|---|
| SSE | `/api/events?client=desktop&lang=<macOS の優先言語>` でデスクトップアプリを数える。増減したら `follow_up`（空）を送り、web にキューを取り直させる |
| SSE のイベント | `notify { notices: NoticeMessage[] }`（デーモンの NotifyRunner が判定。題名・本文・開く画面・音の有無まで決めて送る）、`desktop_open { path }`。どちらも束ねずにすぐ送る。web は無視する |
| `GET /api/queue` | `desktopNotifier: boolean` を足した。true の間、web はブラウザ通知を出さない |
| `GET /api/queue/summary` | `{ count, needsInput, error, yourTurn, rev }`（メニューバーの件数。`visibleQueue` で数える） |
| `GET /api/away` | `{ digest: AwayDigest \| null }`（離れていた間のまとめ。ux-mvp 4.17。`no-store`） |
| `POST /api/away/dismiss` | `{ key }` → `{ ok }`（同じ離席のまとめをもう出さない。設定 `away.dismissed` に戻った時刻だけを持つ） |
| `POST /api/desktop/open` | `{ path }` → アプリがつながっていれば `desktop_open` を送り `{ delivered: true }` |
| `POST /api/desktop/status`・`GET /api/desktop/status` | アプリが通知の許可・ホットキーの登録・版を知らせる。通知の許可は `unknown` / `granted` / `denied` / `not_determined` / `unsupported`（D-080）。変化したら SSE の `desktop_status`。GET は `{ connected, app }` |
| `POST /api/desktop/notifications` | `{ action: "request" \| "open_settings" }` → アプリがつながっていれば `desktop_notifications` を送り `{ delivered: true }`（設定画面の「許可を求める」「システム設定を開く」。D-080、desktop-shell.md 3.3） |
| `POST /api/tasks` | `source: "desktop"`（クイック入力）。DB は `manual` + `source_ref = desktop:quick_add`、読み取りの `origin.source` は `desktop` |
| 設定 | `desktop.quick_add_shortcut`（`turnlane config`。既定 `Alt+Shift+Space`）。設定画面ではキーボードの節（D-077。21章） |

通知の判定（`planNotifications`・`filterPaused`・`visibleQueue`）と文言は `packages/core/src/notify/plan.ts` に移し、web とデーモンが同じものを使う。

## 13. タスクから開く（D-059。2026-10-05。[ux-mvp.md](ux-mvp.md) 4.11）

開く処理はデーモンが行う。クライアント（web・デスクトップアプリの通知）は **ID と開き方の種類だけ**を送り、開く先（リポジトリのフォルダ、PR の URL、resume コマンド）はサーバーがタスク／カードから解決する。任意のパス・URL・コマンドは受け付けない。

| メソッド | パス | 入力 | 応答 |
|---|---|---|---|
| GET | `/api/open/options` | `?followUpId=` か `?workItemId=`（どちらか1つ） | `OpenOptions` |
| POST | `/api/open` | `{ followUpId?: string; workItemId?: string; action?: OpenAction }`（ID はどちらか1つ。`action` を省くと既定の開き先） | `OpenResult` |
| GET | `/api/open/apps` | — | `OpenAppsResponse`（設定画面の選択肢） |

```ts
// packages/core/src/api/open.ts
type OpenAction = "pr" | "pr_files" | "diff" | "editor" | "finder" | "terminal" | "session" | "codex_app" | "copy_resume";
type OpenAppKind = "editor" | "terminal" | "diff";
interface OpenOption { action: OpenAction; app: string | null } // app は実際に開くアプリの表示名（フォールバック後）
interface OpenOptions { default: OpenAction | null; options: OpenOption[] } // options[0] が既定。開けるものだけ
type OpenOutcome =
  | "opened"         // アプリ・ブラウザで開いた
  | "focused"        // 動いているセッションのアプリを前面に出した
  | "typed"          // ターミナルを開き resume コマンドを入力済みにした（実行はしない）
  | "opened_copied"  // ターミナルを開き、コマンドはクリップボードへ
  | "copied";        // コピーだけ
interface OpenResult { action: OpenAction; outcome: OpenOutcome; app: string | null; command: string | null; engaged: boolean; fallback?: { reason: "automation_denied" | "automation_timeout" | "no_terminal"; app: string | null } | null }
interface OpenAppsResponse {
  editor: OpenAppChoice; terminal: OpenAppChoice; diff: OpenAppChoice;
}
interface OpenAppChoice {
  selected: string;                  // 設定の値（turnlane config の open.editor など。既定 zed / ghostty / github_desktop）
  effective: string | null;          // 実際に使うアプリ（未インストールならフォールバック先。差分ツールが無ければ null = エディタ）
  installed: { id: string; name: string }[];
}
```

規則:

- 既定の開き先: review_pr・merge_pr → `pr`、check_changes → `diff`、reply・approve・resume_error → `session`。`workItemId` だけのとき（AI 詳細パネル）は、open なフォローアップがあればその既定、無ければ PR があれば `pr`、セッションがあれば `session`、どれも無ければ `finder`
- `o` のメニュー（`options`）: review_pr → pr, pr_files, editor / check_changes → diff, editor, finder, terminal / reply・approve・resume_error → session, editor, copy_resume / `workItemId` だけ → 開けるもの全部（session, codex_app, pr, pr_files, diff, editor, finder, terminal, copy_resume の順で既定を先頭へ）
- `followUpId` で開いたら、そのフォローアップに対応中の印（`engaged_at`）を付ける（`POST /api/follow-ups/:id/engage` と同じ。open なときだけ）
- 開く先の解決（サーバー）: フォルダ = カードの `repo_root`、無ければ最後のセッションの cwd。差分ツール（`diff`）だけは、カードのセッションを起動した依頼（27章）の worktree が残っていればそちらを開く（2026-10-14。`repo_root` は元のリポジトリで、依頼のブランチを取り出していないため）。絶対パスで、制御文字を含まず、実在するディレクトリだけ。PR = カードの PR の成果物の URL（無ければ `owner/repo#n` から組み立てる）。`https://github.com/<owner>/<repo>/pull/<n>` の形だけを許す（それ以外のホスト・スキームは 409 `unavailable`）。resume コマンド = 最後のセッション（サブエージェントを除く）から組み立てる。セッション ID は `[A-Za-z0-9_-]` だけ
- 実行: `/usr/bin/open`・`/usr/bin/osascript`・`/bin/ps`・`/usr/bin/pbcopy` を引数の配列で起動する（シェルを通さない）。AppleScript の値は `argv` で渡す。`osascript` は5秒で打ち切る（オートメーションの許可の確認ダイアログで待たされるため）
- 誤り: 404 `not_found`（ID が無い）、409 `unavailable`（その開き方が使えない）、409 `open_failed`（起動に失敗）、400 `invalid_input`（ID が無い・両方ある・`action` が不明）
- 設定: `open.editor`（`zed` / `cursor` / `vscode` / `sublime`）、`open.terminal`（`ghostty` / `warp` / `iterm` / `terminal` / `orca`。`orca` は D-122）、`open.diff`（`github_desktop` / `fork` / `tower`）。`turnlane config` と `PUT /api/config/:key` で変える。アプリの検出は `/Applications`・`~/Applications`・`/System/Applications`（`Utilities` を含む）にある `.app` を見る
- Orca（D-122。2026-10-08）: AppleScript を持たないので、アプリに同梱の CLI を `ELECTRON_RUN_AS_NODE=1 <Orca.app>/Contents/MacOS/Orca <Orca.app>/Contents/Resources/app.asar.unpacked/out/cli/index.js` で直接起動する（`/usr/local/bin/orca` には依存しない）。session は `orca open --json` → `orca terminal create --worktree path:<フォルダ> --command "cd <cwd> && <resume>" --focus --json`（Orca の CLI は入力済みで止められないので実行まで進む）。terminal は同じくコマンドなし。`--worktree path:` は Orca に登録したリポジトリの worktree のルートだけを指せる（登録していなければ selector_not_found）ので、失敗したら `orca repo add --path <フォルダ> --json` してから作り直す。それも失敗したら `open -a <Orca.app>`（フォルダは渡さない）とコピー
- Codex で開く（`codex_app`。D-135。2026-10-09）: Codex のセッション（アプリ・CLI とも）で、Codex のアプリが入っているときだけ出す。アプリは `/Applications` などの `Codex.app` か `ChatGPT.app` で、bundle ID が `com.openai.codex` のもの（今の版は `ChatGPT.app` の名前で入る。`plutil -extract CFBundleIdentifier` で確かめる）。`open codex://threads/<セッション ID>`（rollout のセッション ID がスレッド ID）。この URL は公式の文書が無いので、起動に失敗したら resume コマンドのコピー（`copied`）に落とす。Codex のアプリで始めた会話（entrypoint `Codex Desktop`）は session（「Codex で再開」）が同じ所を開くので、`codex_app` を重ねて出さない
- 通知: 即時の通知（needs_input / error）の `path` は `/queue?item=<workItemId>&open=<followUpId>`。デスクトップアプリはクリックで `POST /api/open { followUpId }` を呼び、失敗したら従来どおり main で `path` を開く（desktop-shell.md 3.3）。ブラウザ通知のクリックも同じ
- 廃止: `POST /api/work-items/:id/open`（10章）。`WorkItemDetail.open` は残す

## 14. 週ボードの DnD で足したもの（段階 B (1)。2026-10-05。D-062、[ux-mvp.md](ux-mvp.md) 7章）

API は増やしていない。DnD は 2.2 の `move` と時間ブロックの CRUD を組み合わせる（クライアントの `apps/web/src/data/mutations.ts`。計算は `packages/core/src/plan/dnd.ts`、書き換えは `api/optimistic.ts`）。

| 操作 | 呼ぶ API（順に） | 楽観的更新 | ⌘Z |
|---|---|---|---|
| 日付の移動・並べ替え | `POST /api/tasks/:id/move {date, beforeId?, afterId?}`。並びのキーはクライアントが `orderKeyBetween` で仮に置く | `moveTaskInBoard` | 元の日付・前後へ `move` |
| 時間に置く（Unscheduled・Inbox から） | 日付が違えば `move {date}` → `POST /api/time-blocks {taskId, startAt, endAt, clientId}` | `placeTaskInBoard` | ブロックを消し、元の日付・前後へ `move` |
| ブロックの移動（同じ日・別の日） | 日付が違えば `move {date}` → `PATCH /api/time-blocks/:id {startAt, endAt}` | `placeTaskInBoard` | 元の日付と時刻へ |
| 伸縮 | `PATCH /api/time-blocks/:id {endAt}` | `patchBlockInBoard` | 元の時刻へ |
| ブロックを外す（`⌫`・Unscheduled へ落とす） | `DELETE /api/time-blocks/:id`（→ 日付・並びが変われば `move`） | `removeBlockFromBoard` | 同じ時刻で新しい ID のブロックを作る（削除した ID は再利用しない） |
| 範囲選択から新規 | `POST /api/tasks {raw, date, clientId}` → `POST /api/time-blocks` | 作成と同じ | タスクを削除 |
| 時間に置いたタスクのキー操作の移動（`m` / `>` / `<` / `t`） | `move` → `PATCH /api/time-blocks/:id`（壁時計の同じ時刻のまま日をずらす。`shiftByDays`）。Inbox へは `DELETE` | 同上 | — |

- タスクの日付とブロックの日付を揃える: ブロックはタスクの日付の列に描く（2.4）ので、別の日の時間軸へ落とすときは先に `move` する
- 時間ブロックは M3-3 まで `writebackState: "pending"` のまま（書き戻さない）
- 2つの API を続けて呼ぶ操作は、1つの楽観的更新の中で順に呼び、最後に影響するキーを無効化する。途中で失敗したら直前の値に戻してトーストを出す（途中まで書けた分は再取得で見える）
- ドラッグ中のヘッダは、移す元の日の Planned から引き、落とす先の日に足した値を出す（`plannedWith`。Free は時間ブロックを引かないので変わらない。9.1）

## 15. デイビューで足したもの（段階 B (3)。2026-10-05。M2-19、[ux-mvp.md](ux-mvp.md) 4.5）

`GET /api/day/:date`（`DayResponse`。`packages/core/src/api/day.ts`）を実装した。2.3 の型からの変更:

| 対象 | 変更 | 理由 |
|---|---|---|
| `DayDetail` | `Omit<DayColumn, "aiLane">` ではなく `DayColumn` をそのまま拡張する（`aiLane: AiLaneItemDetail[]`）。AI 項目は週ボードの `AiLaneItem` の上位互換で、待ちは `DayWaitSegment`（`WaitSegmentBrief` に `kind` / `excludedBy` / `endReason` を足したもの） | 週ボードと同じ部品（時間軸・DnD・楽観的更新の純粋関数）にデイビューの1日分をそのまま渡せる |
| `WaitSegmentDetail.eventId` | 入れない | 待ち区間（`ai_wait_segment`）に予定の ID を持っていない。ホバーは予定名を出さない（事実のみ）ので不要 |
| `closedToday` | `ClosedTodayRow[]`（`/api/queue` の `closedRows` と同じ型。その論理日に閉じたもの） | 帯の閉じた行と同じ部品で描く |
| `freeSlots` | 勤務の窓（9.1 の Free と同じ）− busy な予定 − 時間ブロック。15分単位（始まりは切り上げ・終わりは切り捨て）、15分未満は出さない、今日は今より後だけ（core の `plan/capacity.ts` `freeSlots`） | 時間軸へのドラッグ先の案内。過ぎた枠は置けないので出さない |
| `totals.youMs` / `meetingsMs` | 2.4 の定義どおり（自分 = 全タスクの実績の和集合、会議 = 勤務時間内の busy な予定の和集合。論理日） | |
| `DayResponse.openDay` | `BoardResponse` と同じ | 0:00〜日付区切りの未閉店の案内 |
| AI レーン | 過去日も返す（今日以外は持ち越しを入れない）。項目の `aiMs` / `idleMs` / `youMs` はその日の論理日の値（今日は今の論理日）。ターンにはツール呼び出し数・編集ファイル数・トークン・止まり方（`AiRunDetail`）を付ける | デイビューは過去日を振り返る画面。週ボードの AI レーンは今日だけのまま |

クライアント:
- キャッシュキーは `["day", date]`（4.2）。タスク・時間ブロックの楽観的更新は、デイビューの応答を1日分の週ボードとして書き換える（`data/mutations.ts` の `setBoard`）
- 時間軸の縮尺はデイビューが 1時間 60px（週ボードは 44px）。DnD の部品は時間軸の要素の `data-px-per-ms` で縮尺を読む
- 配置は `apps/web/src/day/layout.ts`（ひと続きの作業のブロック（D-065。core の `spansOf`）、3列＋`+N`、待ちの線を項目の列にブロックの下端から、ラベル（集計外のラベルが短さやブロックとの重なりで隠れる場合は `labelHoverOnly`）、自分レーンの最小 16px と横並び、コネクタの終点）。表駆動テストは `apps/web/test/day-layout.test.ts`

## 16. 朝の計画で足したもの（段階 B (4)。2026-10-05。M4-1・M4-7、[ux-mvp.md](ux-mvp.md) 8章、D-062）

> **廃止（D-192。2026-10-14）**: `GET /api/rituals/morning`・`POST /api/rituals/morning/complete`・`MorningResponse`・拡張の `morning.claim` を消した。持ち越しは 11 章の `POST /api/days/:date/carry`。以下は履歴。

`GET /api/rituals/morning?date=`（省略時は今日の論理日。未来日は 400）

```ts
interface MorningResponse extends ReadMeta {
  date: LocalDate;
  /** 対象の範囲の始まり（ux-mvp 8章）。72時間より前には遡らない */
  since: EpochMs;
  sinceKind: "closed" | "work_end" | "day_start";
  /** since 以降に AI が動いた項目の事実（Step 1 の行の2行目 `AI 41m · ran 22:10–22:51`） */
  overnight: MorningOvernightFacts[];
  /** since 以降に完了した AI 項目（`Done overnight 3 — …`）。完了の順 */
  doneOvernight: MorningDoneLine[];
  /** Step 2 の持ち越し（ux-mvp 8章の対象）。今日のものが先、過去の日付のものは日付の新しい順 */
  carried: TaskView[];
  /** 次の稼働日（Step 1 の `m`） */
  nextWorkday: LocalDate;
  /** その日の朝の計画を終えた時刻（Start the day）。未完了は null */
  doneAt: EpochMs | null;
}
interface MorningOvernightFacts {
  workItemId: string;
  /** since 以降のターンの AI 時間の和（稼働中・待ち中のターンは日報と同じく turnAiMs で数える） */
  aiMs: number;
  /** since 以降の最初のターンの始まりと、最後のターンの終わり（稼働中は null） */
  ranFrom: EpochMs;
  ranTo: EpochMs | null;
  /** 最後のターンの止まり方（`ended with a question 23:05` / `failed 07:00`） */
  endedWith: "end_turn" | "question" | "permission" | "error" | "aborted" | null;
}
interface MorningDoneLine {
  workItemId: string;
  /** AI 項目の題名（無ければブランチ） */
  title: string | null;
  repo: string | null;
  /** PR があればその番号と状態（`Dependency update (PR #138 merged)`） */
  pr: { number: number; state: "open" | "draft" | "merged" | "closed" | "unknown" } | null;
  doneAt: EpochMs;
}
```

- Step 1 の判断する行は `/api/queue` の項目のうち `waitingSince >= since` のもの（キューと同じキャッシュを読み、操作は帯と同じ API）。`overnight` は行の事実を足すためだけに使う
- 完了は `work_item.status = 'done'` で `status_changed_at >= since`、かつ since 以降にターンが動いた（または PR がマージされた）もの（統合・非表示・削除したものは除く。昼の作業が時間の経過で done に落ちただけのものは入れない）
- `POST /api/rituals/morning/complete {date?}` → `{rev, date, doneAt}`。`daily_note.morning_done_at` を記録し、`usage_event` に `ritual_morning` を残す（14日カウント。M5-1 の `turnlane stats` が読む）。2回目以降は最初の時刻のまま
- キャッシュキーは `["ritual", "morning", date]`（4.2）。Step 3 の左は `["board", today, today]`（週ボードの今日の列と同じ部品）、右の `Planned / Free` はその列の `totals`（9.1。Free は D-062 の計画上の勤務時間から出す）
- 移動候補は core の純粋関数 `plan/suggest-moves.ts` の `suggestMoves`（M4-7）。候補の行き先を決めるため、明日から14日分の `/api/board` を読み（キー `["board", from, to]`）、各日の `freeMs − plannedMs` を空きとする。対象は今日の未着手（todo）で時間ブロックの無いタスク。`*`（ハイライト）の無いものを先に、並びの下から、超過分（`plannedMs − freeMs`）が収まるまで選ぶ。見積の無いタスクは30分（9.1）。行き先は空きが足りる最初の稼働日（稼働日でない日・Free の無い日は飛ばす）。足りる日が無ければ最初の稼働日
- 入口の帯の設定は `PUT /api/settings/ui {morningPrompt: boolean}`（既定 true。`setting` の `ui.morning_prompt`、端末ごと）

## 17. ⌘K の検索（段階 B (5)。2026-10-05。M2-15、[ux-mvp.md](ux-mvp.md) 6.1）

`GET /api/search?q=&limit=`（`q` は1〜200文字、`limit` は1〜20で既定5。種類ごとの上限）

```ts
interface SearchResponse extends ReadMeta {
  q: string;
  tasks: SearchTask[];
  aiItems: SearchAiItem[];
  events: SearchEvent[];
}
interface SearchTask {
  /** 週ボードと同じ TaskView（題名は 6.1 の TitleSpec） */
  task: TaskView;
}
interface SearchAiItem {
  id: string;
  title: string | null;
  status: WorkItemStatus;
  estimated: boolean;
  sources: SourceBadge[];
  /** リポジトリ名（repo_root の末尾） */
  repo: string | null;
  branch: string | null;
  /** PR 番号（work_item.pr_ref と、その AI 項目の ai_artifact の PR。新しい順） */
  prs: number[];
  lastActivityAt: EpochMs;
  /** 最後に動いた暦日（表示用。D-054） */
  date: LocalDate;
}
interface SearchEvent {
  id: string;
  title: string | null;
  start: EpochMs;
  end: EpochMs;
  allDay: boolean;
  /** 始まりの暦日（終日予定は start_date） */
  date: LocalDate;
}
```

- 一致: `q` を空白で区切った語をすべて含むもの（大文字小文字を区別しない部分一致。AND）。語の先頭の `#` は外す（`#142` でも `142` でも PR 番号に一致する）
- タスク: 削除・やめた（canceled）ものを除く。見るのは題名だけ（`notes_md` は見ない）。自動生成の題名（6.1）は解決した `params` の `title`・`repo`・`branch`・`PR #<pr>`・`prTitle` を見る。並びは未完了を先に、その中で日付が今日に近い順（Inbox は最後）、完了は新しい順
- AI 項目: 削除・統合・非表示のものを除く。見るのは題名（`title_user` → `title_auto`）、リポジトリ名、ブランチ、`PR #<n>`（`pr` と `#` を付けた形で引ける）だけ。セッションの本文・プロンプト・ツールの入力は読まない（ADR 0005）。並びは最後に動いた順
- 予定: 取り込み元のカレンダー（`role = 'source'`。週ボードと同じ）のものだけ。キャンセル済みと自分の時間ブロックの書き戻し（`is_own_timeblock`）は除く。見るのは題名だけ（場所・メモは見ない）。並びは今に近い順（未来と過去を区別しない）
- 日付・画面・コマンドはクライアントで組み立てる（キーの定義 M2-7 と自然言語パーサ）。サーバーは返さない
- キャッシュキーは `["search", q]`（4.2。`staleTime: 0`、無効化しない）。入力から 120ms 待って問い合わせ、前の結果を出したまま置き換える
- 時間に置く（`p`）の候補はクライアントで作る: `["day", date]` の `freeSlots` から、見積（無ければ30分）が入る枠の先頭（今日は今より後を15分単位に切り上げ）を最大9件（core の `plan/place-candidates.ts`）。置くのは既存の `POST /tasks/:id/move` と `POST /api/time-blocks`（2.2）

## 18. タスクと予定の詳細パネル（D-070。2026-10-05。[ux-mvp.md](ux-mvp.md) 4.12）

| API | 中身 | 備考 |
|---|---|---|
| `GET /api/tasks/:id` | `TaskDetailResponse`: `ReadMeta` ＋ `task`（`TaskView`）、`notes`（`task.notes_md`）、`blocks`（削除していない時間ブロック、開始の早い順）、`projectName` | 削除済みは 404。メモは `PATCH /api/tasks/:id {notes}` で書く（既存） |
| `GET /api/calendar-events/:id` | `CalendarEventDetail`: 題名、時刻、終日の日付、tz、カレンダー名・アカウント・色、場所、会議の URL、`busy`（`derive.isBusyEvent`。空き時間と放置と同じ判定）、`status`、`ownTimeBlock`（書き戻した予定なら `{ blockId, taskId }`）。D-093 で `calendarId`・`editable`・`readOnlyReason`・`createdByTurnlane` を足した（24章） | 無ければ 404 |
| `POST /api/calendar-events/:id/open` | Calendar.app でその予定を出す（`osascript` で `show`。カレンダー名と UID = `calendar_event.external_id` で探す。5秒で打ち切り）→ だめなら `open -a Calendar`。`{ outcome: "shown" \| "opened" \| "failed" }` | 開く処理はデーモン経由（13章と同じく引数の配列で起動し、シェルを通さない）。予定とカレンダー名以外の入力は受けない |

- SSE: `task`（`ids` にタスクの ID。時間ブロックの変化も `ids` にタスクの ID が入る）で `["task", id]` を、`calendar` で `["calendarEvent", id]` を取り直す
- `calendar_event.own_timeblock_id`（0005）: 同期で `url = dayline://timeblock/<id>` の予定に入れる。M3-3 の書き戻しと共用

## 19. DnD の残りと週ボードの仕上げで足したもの（2026-10-05 r4。M2-16〜M2-18、M2-9。[ux-mvp.md](ux-mvp.md) 4.4・7章）

| API | 中身 | 備考 |
|---|---|---|
| `POST /api/follow-ups/:id/defer` | 本文 `{ date? }` を足した。`date` は今日より後の日。省けば従来どおり次の稼働日（`m`。D-052 (1)） | 自分の番の行を未来の日付カラムへ落とす。その日へ移し、その日の計画上の勤務開始までスヌーズする |
| `POST /api/work-items/:id/check-task` | `{ title, date, startAt, endAt, clientId? }` → `TaskWriteResponse`（201）。題名はクライアントが UI の言語で作る（`Check: <題名>` / `確認: <題名>`）。`task.source = 'ai'`、`source_ref = 'work_item:<id>'`、プロジェクトはリポジトリの対応（`project.repo_paths_json`）から。同じトランザクションで時間ブロックも作る | AI カードを自分レーンへ落とす。`TaskView.workItemId` は `source_ref` からも引く（タスクの詳細パネルから元の AI 項目へ行ける） |
| `POST /api/work-items/:id/merge` | `{ intoId }`（phase0-plan 3.4）。`:id` のカードを `intoId` へ統合する: `:id` に `merged_into_id = intoId` と `deleted_at` を入れ（runner は以後そのキーのターン・PR を `intoId` に付ける。3.2 の 7）、`:id` のフォローアップ（閉じたものも）と待ち区間の履歴を `intoId` へ付け替え（重複の鍵 `dedupe_key` も統合先のものに書き換え、統合先に同じ鍵があれば統合元の open なものは superseded で閉じる）、runner を起こす | 同じカード・統合済み・削除済みは 409 `cannot_merge`。題名・非表示・手動完了は `intoId` のものを残す。Phase 0 では元に戻す API は作らない |
| `GET /api/projects` | `{ projects: { id, name, color, repoPaths }[] }`（`repoPaths` を足した。アーカイブ済みは `?all=1` のときだけ、`archivedAt` 付き） | |
| `POST /api/projects` | `{ name, color?, repoPaths? }` → 201 `{ project }`。名前が重なれば 409 `name_taken` | 設定画面のプロジェクトとリポジトリの対応（M2-9） |
| `PATCH /api/projects/:id` | `{ name?, color?, repoPaths?, archived? }` → `{ project }` | |
| `GET /api/projects/repos` | `{ repos: { path, lastActivityAt }[] }`: AI 項目のリポジトリ（`work_item.repo_root`）を最後に動いた順 | 設定画面で選ぶ候補 |

- リポジトリの対応の使い道（Phase 0）: 新しく作る自分の番のタスク（runner）と AI カードからの確認タスクに、`repo_root` に最も長く前方一致する `repo_paths` のプロジェクトを付ける（`core/plan/project-for-repo.ts`）。既にあるタスクは変えない。AI 項目そのもの（`work_item.project_id`）には付けない
- `DayColumn.tasks` には、帯に出ている自分の番のタスクのうち、その日の時間軸にかかる時間ブロックがあるものも入れる（`followUpId` が付く）。容量（Planned）には数えない（従来どおり自分の番のタスクは数えない）

## 20. 3日ボードで足したもの（D-074。2026-10-05。[ux-mvp.md](ux-mvp.md) 4.4.0・4.5）

| API | 中身 | 備考 |
|---|---|---|
| `GET /api/board?around=YYYY-MM-DD` | `BoardResponse`。`days` は [左の日, `around`, 次の稼働日] の3つ（日付の昇順）。左の日は前の稼働日と、`around` より前で `work_day_auto` に行がある直近の日（実際に作業した日。D-076）のうち新しい方。稼働日はデーモンの稼働日の規則（稼働曜日と祝日カレンダー。M3-6、core の `date/workdays.ts`）で決め、`around` 自体は稼働日でなくてもよい。稼働曜日が空のときは前日・翌日 | `from` / `to` と同時には指定しない（両方あれば 400 `bad_range`）。中身は `from = 前の稼働日`、`to = 次の稼働日` の `buildBoard` から3日だけを残したもの（間の休日も一度組み立てる。休日は高々数日なので許容） |

- 前の稼働日は core の `prevWorkday`（`nextWorkday` と対。祝日の窓の外は祝日なしとして扱う）
- 左の日は core の `boardPrevDay(around, rule, lastWorked)`（D-076。2026-10-05）。`lastWorked` は `SELECT date FROM work_day_auto WHERE date < around ORDER BY date DESC LIMIT 1`（朝の計画の `sinceOf` と同じ問い合わせ）。`work_day_auto` は勤務時間の操作（AI への人間入力・`user_op`・手動のタスク完了）だけから作るので、AI の定期実行だけの日は入らない。日付は論理日（日付区切り）
- クライアントの `[` / `]` は応答の `days[0]` / `days[2]` へ移る（左の列が作業した休日ならその日が次の基準日になり、その左はまた同じ規則で決まる）
- クライアントのキャッシュキーは `["board", around - 10, around + 10, "around"]`。無効化の判定（4.3 の `overlaps`）は from / to の形のまま使えるよう、前後の稼働日が入りうる幅（祝日の連休を含めて ±10 日）を from / to に置く。楽観的更新は既存どおり `days` の日付で当てる
- 今日の稼働リボン: `DayColumn.aiRibbon` は従来どおり過去日だけ。AI レーンを出さない今日の列（週表示・3日ボードの端の今日）のリボンは、クライアントが `aiLane` の実行（`runs`。稼働中は now まで）の和集合から作る（`apps/web/src/board/ribbon.ts`）
- 自分の番への対応（4.5）の判定はクライアント: 時間軸に置いた完了タスクのうち `followUpId` があり、時間ブロックが無いもの（実績だけで置いたもの）。印の位置は実績の開始、長さは実績の長さ（`apps/web/src/board/day-split.ts` の `placementsOf` が `replies` に分ける）

## 21. キーの割り当て（D-077。2026-10-05。[ux-mvp.md](ux-mvp.md) 6章・6.2）

| API | 中身 | 備考 |
|---|---|---|
| `GET` / `PUT /api/settings/ui` | `keybindings: Record<string, string[]>` を足した（キーマップの id → キーの表記。既定と同じものは入れない。空配列は「キーなし」）。PUT は丸ごと置き換え | `setting` の `ui.keybindings`（`local_only`。端末ごと、同期しない）。読むときに書式が壊れていれば `{}` |
| `GET` / `PUT /api/config/ui.keybindings` | 同じ値（`turnlane config` と、デスクトップアプリが表示メニューのキーを読むため） | `CONFIG_SCHEMAS` の `ui.keybindings`（core の `KEYBINDINGS_SCHEMA`） |
| SSE | 保存で `settings` を送る（既存）。web は `["settings"]` を取り直してキーマップに読み込む。デスクトップアプリは `settings` でホットキーと表示メニューのキーを合わせ直す | |

- 書式（`KEYBINDINGS_SCHEMA`）: id は `^[A-Za-z][A-Za-z0-9]{0,39}$`、キーは1打鍵か空白区切りの2打鍵（各32文字まで）、1つの id に4つまで、id は200個まで。id の一覧と既定値は web（`apps/web/src/keys/keymap.ts`）が持ち、デーモンは書式だけを検証する（知らない id は web が無視する）
- キーの表記: `j`・`shift+j`・`mod+k`（⌘。⌃ も同じ）・`alt+…`（名前のあるキーのとき）・`>`（記号は shift を含めた文字）・`space`・`enter`・`backspace`・`arrowup`、2打鍵は `g b`
- 衝突の検出は web（`findConflicts`）。デーモンは衝突を見ない
- デスクトップアプリの表示メニュー: `viewThree` / `viewWeek` / `viewDay` の最初の `mod+` 付きの1打鍵を Tauri のアクセラレータ（`CmdOrCtrl+Shift+K` など。文字・数字・`enter`・`backspace`・`space`・矢印・`\` のみ）に変えて `set_accelerator`。上書きが無ければ既定の `⌘1`〜`⌘3`、変換できるキーが無ければアクセラレータなし（web の keydown が受ける）

## 22. 閉店を勤務の終わりにする（D-079。2026-10-05。phase0-plan 3.3.1、[ux-mvp.md](ux-mvp.md) 8章）

> **廃止（D-192。2026-10-14）**: 閉じる概念ごと消した（`shutdown/reopen`、閉じていた区間 `closed`、`todayClosedAt`、`afterClose`）。古い `ai_wait_segment.excluded_by = 'closed'` の行は読めるが新しくは作らない。以下は履歴。

| API | 中身 | 備考 |
|---|---|---|
| `POST /api/rituals/shutdown/reopen` | `{date?}`（省略時は今日の論理日）→ `{rev, date, reopenedAt}`。`daily_note.shutdown_done_at` を NULL に戻し、`usage_event(kind='ritual_reopen', ref=<date>)` を残す。SSE は `task`（日付）と `follow_up`（閉店モードのキャッシュ） | 今日の論理日だけ（過去の日は 400 `not_today`、未来は 400 `future_date`）。閉じていなければ 409 `not_closed`。`user_op` に数えない |
| `POST /api/rituals/shutdown/complete` | 再開した日（`shutdown_done_at` が NULL で `ritual_reopen` がある日）に呼ぶと「閉じ直し」: 持ち越しはせず、`report_md` / `memo_md` を書き直し（`markdown` を省いたら今の事実から組み立てた本文）、`shutdown_done_at` を今にし、`usage_event(kind='ritual_shutdown')` を残す。応答の `carried` は空。日報（`report.carried` と Markdown の Carried over）には最初の閉店で実際に移したタスクだけを出す（最初の閉店で、移したタスクごとに `usage_event(kind='ritual_carry', ref='<日付>:<task id>')` を残す。再開中の `GET /api/rituals/shutdown` も同じ） | 既に閉じた日の「日報の更新」（D-069）は従来どおり。`user_op` に数えない |
| `BoardResponse.todayClosedAt` / `DayResponse.todayClosedAt` | 今日の論理日の `shutdown_done_at`（閉じていなければ null） | 今日の列の `Closed · Reopen`。0:00〜日付区切りの間は前の暦日の論理日（`openDay` と同じ日）を見る |
| `DailyReport.afterClose` | `{ops, firstAt, lastAt} \| null`。閉じていた区間（閉店〜再開、最後の閉店〜論理日の終わり）の操作（3.3.1 の3種）の件数と時刻 | 日報の Markdown には出さない（仮置き） |
| `UsageStats.afterClose` | `{days, ops}`。期間内で閉店後の操作があった日数と操作の件数 | `turnlane stats` に1行出す |

- 勤務時間（`WorkHours` / `ReportWorkHours`）の終了は、閉じた日（閉店時刻がその論理日の内側）なら閉店時刻（修正値が優先）。`source` / `endEdited` は従来どおり（閉店で固定した終わりは `actual`・`endEdited=false`）
- 待ち区間の区分は core の `classifyWait` に渡す勤務時間に閉じていた区間（`off`）を足して求める（`off_hours`）

## 23. 深夜のデイビュー（2026-10-06。D-054、[ux-mvp.md](ux-mvp.md) 4.5）

不具合: 0:00 を過ぎて日付区切りの前（論理日は前日）に AI が動いても、暦日の今日のデイビューが更新されなかった。`/api/day/:date` は暦日の時間軸（0:00〜24:00）にかかる実行・待ち・予定・時間ブロック・実績を返していたが、クライアントの無効化（4.3）が `["day", date]` を `dates`（論理日）との一致だけで判定していたため、論理日が前日の `work_item` / `task` / `calendar` / `work_hours` で今日のデイビューを取り直さなかった（3日ボードは `from - 1` まで含めていたので出ていた）。

| 対象 | 変更 | 理由 |
|---|---|---|
| 4.3 の `overlaps` | `day` は `d = date` か `d = date - 1` で無効化する | 0:00〜日付区切りの区間は前日の論理日のイベントで届く |
| `DayDetail.summary` | `{ date, phase, workHours }` を足した。上部の集計（`totals`）、`closedToday`、`idleByRepo` は `summary.date` の論理日の値。ふだんは同じ日付。**暦日の今日を 0:00〜日付区切りに開いたとき（`phase = "today"`、`logicalPhase = "future"`）だけ今の論理日（前日）**。`summary.workHours` は上部の `Work 10:00 – now (auto)` 用で、描画の勤務の窓は従来どおり `DayColumn.workHours` / `nightWork` | 深夜に今日のデイビューを開くと、同じ日付の論理日（まだ始まっていない）の集計は空になる。3日ボードの今日の列の AI 項目が今の論理日の値を出すのと揃える（仮置き） |

- 描画の素材は従来どおり暦日の時間軸にかかるもの（0:00 をまたぐものは両日に入り、切り取りはクライアントの `clip`）。前の暦日のデイビューは 24:00 で切るので、0:00 以降の区間は軸の外に出ない
- `summary.date` が日付と違うとき、上部の集計の左に `Totals for Mon 10/5`（日本語 `月 10/5 の集計`）を出す（仮置き）
- `turnlane ai --date` は従来どおり論理日（`ai_turn.local_date`）で数える。日報・集計の CLI なので暦日に変えない

## 24. 予定の作成・編集と、時間ブロックの予定の削除（D-093。2026-10-07。ADR 0012、[ux-mvp.md](ux-mvp.md) 4.12・4.13・7章、phase0-plan 4.5 の「D-093 の方式」）

| API | 中身 | 備考 |
|---|---|---|
| `POST /api/calendar-events` | `{ title, start, end, calendarId? }`（epoch ms。題名は 1〜500 文字。`calendarId` は `calendar.id`、2026-10-23 に足した）→ `{ event: CalendarEventDetail \| null }`（カレンダーがまだ同期されていなければ null。次の同期で出る） | `calendarId` を省けば Calendar.app のデフォルトカレンダーへ、あればそのカレンダーへ作る（ヘルパの `createEvent`。`url = turnlane://event/<uuid>`）。指定したカレンダーが無い 404 `calendar_not_found`・読み取り専用 400 `not_writable`・無視している 400 `calendar_ignored`（PATCH の `calendarId` も同じ）。409 `helper_not_connected` / `helper_outdated` / `no_default_calendar` / `not_writable` / `save_failed` |
| `PATCH /api/calendar-events/:id` | `{ title?, start?, end?, calendarId?, ifMatch? }`（`calendarId` は `calendar.id`。書き込めるカレンダーだけ）→ `CalendarEventDetail`。`ifMatch: { start, end, title?, calendarId? }` は ⌘Z の逆の書き込みの前提（D-096）: キャッシュの行と、ヘルパから読み直した予定（`fetchEvents` をその時刻の範囲で）の両方がこの状態のときだけ書く。違えば・見つからなければ書かずに 409 `changed` | 編集できる予定だけ（409 `not_editable`）。`calendar_event.id` は変わらない（カレンダーを移しても） |
| `DELETE /api/calendar-events/:id` | → `{ ok: true }` | 編集できる予定だけ |
| `GET /api/calendar/timeblock-events` | → `TimeblockEventsSummary`: `{ count, from, to, calendars: [{ name, account, count }] }`（`from` / `to` は最初の開始・最後の終わり。0件なら null） | M3-3 で書いた時間ブロックの予定（`dayline://timeblock/`）。今日の365日前〜365日後、全カレンダー。409 `helper_not_connected` / `helper_outdated` |
| `POST /api/calendar/timeblock-events/cleanup` | `{ expected }` → `{ deleted, failed }` | 数え直した件数が `expected` と違えば 409 `changed`（消さない）。ヘルパの `deleteTimeblockEvent` で1件ずつ消し、同期を起こす |

- `CalendarEventView`（週ボード・デイビュー）に `editable: boolean` を足した。ドラッグ・伸縮の可否に使う
- `CalendarEventDetail` に `calendarId`（`calendar.id`）、`editable`、`readOnlyReason`（`"attendees" | "calendar" | "recurring" | "all_day" | "helper" | null`）、`createdByTurnlane`（`turnlane://event/` の予定）を足した
- `CalendarStatusView.writeback` を `events` に置き換えた: `{ calendar: { id, name, account, color } | null, defaultCalendar: "ok" | "none" | "not_writable" | "unknown", helperOutdated }`（予定の書き先 = Calendar.app のデフォルトカレンダー）
- 外した API: `PUT /api/calendar/writeback`、`GET /api/calendar/sources`、`POST /api/calendar/turnlane`。`PATCH /api/calendars/:id` の役割は `source` / `ignored` だけ
- 楽観的更新（4.4）: 作成は仮の ID の予定を `["board", …]` / `["day", …]` の日の `events` に足し、移動・伸縮・題名・カレンダーの変更は書き換え、削除は取り除く。失敗したら戻して `Couldn't save. Restored.` とコードに応じた一文をトーストに出す。終わったら board / day と `["calendarEvent", id]` を無効化する。移動・伸縮・題名・カレンダーの変更は ⌘Z の対象（D-096）: 変える前の値（時刻・題名は週ボードのキャッシュ、カレンダーは詳細のキャッシュ）へ、変えた後の値を `ifMatch` に付けて書き戻す。409 `changed` は「元に戻しませんでした」のトースト。作成・削除は対象にしない（削除は確認のダイアログ）
- SSE: 予定を書いたら `calendar`（影響する論理日付）を送る。Calendar.app 側の変更は従来の同期で `calendar` が届く

## 25. 会議前に聞く集中モード（D-097。2026-10-07。[ux-mvp.md](ux-mvp.md) 4.15、[desktop-shell.md](desktop-shell.md) 3.5）

集中モード中は自分の番・許可待ちの通知を止め、終わったら止めた分をまとめて1回知らせる。会議（下の「対象の予定」）の開始の N 分前に「集中モードにしますか？」と聞く。判定・時刻・文言はすべてデーモン（`apps/daemon/src/focus/`、純粋な部分は `packages/core/src/focus/`）。

**対象の予定**（`focus.isFocusTarget`）: busy な予定（`derive.isBusyEvent`。取り消し・辞退・free・時間ブロックの予定・表示しないカレンダーを除く）のうち終日でないもので、設定 `focus.target` が
- `meetings`（既定）: 参加者がいる（`has_attendees = 1`）か、会議リンクがある（`has_meeting_link = 1`）
- `busy`: 予定ありのすべて

会議リンク（`has_meeting_link`。0008 で足した列。1 / 0、NULL = まだ分からない）: 予定の URL・場所・メモに会議サービスの URL（`meet.google.com`、`zoom.us` / `*.zoom.us` / `zoomgov.com`、`teams.microsoft.com` / `teams.live.com`、`*.webex.com`、`whereby.com`、`meet.jit.si`、`chime.aws`、`bluejeans.com`、`gotomeeting.com` / `meet.goto.com`、`around.co`、`facetime.apple.com`。一覧は `packages/core/src/focus/meeting-link.ts` の `MEETING_HOSTS` とヘルパの `meetingHosts` で同じにする。テストで照合）があるか。判定はヘルパ 0.5.0（`fetchEvents` の `hasMeetingLink`。メモの本文はヘルパの外に出さず、真偽値だけ返す）。0.5.0 より前のヘルパではデーモンが URL・場所だけで判定する（メモは見ない）。

**聞く時刻と答え**（`focus.planPrompt`。1分より細かく回す: 30秒ごとと、`calendar` / `settings` / 集中の操作の後）:
- 対象の予定のうち、今が `[開始 − N 分, 開始)` にあり、まだ聞いていないもの（予定の ID と開始で覚える。`focus.state` に保存し、再起動しても聞き直さない）の、開始が最も早いものを聞く。N は設定 `focus.lead_min`（既定5、1〜30）
- 聞かない: 設定 `focus.prompt` がオフ、閉店モード中（`notifyPausedUntil`）、集中中でその予定の終わりまで続く、既に開始した（デーモンが開始後に気づいた予定は聞かない）
- 答え `focus`（集中する）: 今から予定の終わりまで集中（集中中なら終わりを予定の終わりまで延ばす）。`skip`（しない）: 何もしない
- 答えないまま開始の時刻になったら閉じる。設定 `focus.auto`（自動で集中。既定オフ）がオンなら、そのとき予定の終わりまで集中する
- 閉じた問いは、予定が続く間（終わりまで）「閉じた問い」（`focus.state.closed`）として覚え、遅れて届いた答え（通知のボタン。押した人の意図を捨てない）を受ける: `focus` は今から予定の終わりまで集中、`skip` は何もしない（どちらも 200）。予定が終わった・消えた・開始が変わった・予約した・その終わりまで集中している・次の問いを開いたら忘れる（以後は 409 `stale`）。閉じた問いは `FocusView.prompt` には出さない（帯・ポップオーバーには出ない。通知だけ残す）
- 予定が消えた・対象でなくなった・開始が変わったら、問いを閉じる

**問いの出し方**: デスクトップアプリがつながっていて通知が許可されている（`desktopNotifier` かつ `desktop status` の `notifications = granted`）なら、SSE `notify` の通知（`kind: "focus_prompt"`、`id: "focus-prompt"`、題名 `15:00 デザインレビュー · 集中モードにしますか？` / `15:00 Design review · Focus during this meeting?`、ボタン `actions: [{ id: "focus", title: "集中する" }, { id: "skip", title: "しない" }]`、`path: "/board?focus=<key>"`）。それ以外（アプリが無い・通知が拒否・未決定）は `channel: "band"` にし、web が画面上部の帯で同じ問いを出す。メニューバーのポップオーバー（`/tray`）には常に出す。

**集中中の通知**（NotifyRunner。`planNotifications` → `filterPaused`（閉店モード）→ `filterFocus` の順）:
- 集中中は即時（needs_input / error）もまとめ（your_turn）も出さず、カード（`workItemId` と状態）を「止めた分」に入れる。設定 `focus.allow_needs_input`（集中中も許可待ちは通知する。既定オフ）がオンなら needs_input の即時だけ通す
- 閉店モードで止めたものは止めた分に入れない（閉店モードの規則どおり、後から出さない）
- 集中が終わったとき、NotifyRunner のまとめ待ち（15分のまとめを待つ your_turn。`pending`）のカードも止めた分に加え、通常のまとめから外す（`takePending`。集中が15分より短いと、集中中に増えた your_turn はまとめの時刻が来ておらず止めた分に入らないため。二重に出さない）
- 集中が終わったら（終わりの時刻・手動の終了・予定の終わり・予約の取り消し）、必ず1回だけ通知する（2026-10-19。終わり方で形を変えない）。`id: "focus-summary"`、`kind: "focus_summary"`（`focus.focusSummary`）
  - 止めた分のうち今も自分の番に出ているカード（`visibleQueue`。状態は今のもの）があれば: 題名 `会議中に自分の番が 3 件（許可待ち 1）` / `3 waiting on you from your meeting (1 approval)`（手動の集中は `集中モード中に自分の番が 3 件` / `3 waiting on you from focus`。許可待ちが0件なら括弧を省く。2件以上は英語 `(2 approvals)`）。本文は1行に1件で各カードの件名（`followUpSubject`。D-227 の件名の順。`notify.content` が `minimal` なら `repo · branch`）を3件まで、超えた分は `ほか 2 件` / `and 2 more`。`status` は needs_input を含めば `needs_input`、無ければ `your_turn`。`path: "/queue"`、needs_input を含めば音を鳴らす
  - 無ければ: 題名 `集中モードを終了しました` / `Focus ended`、本文 `14:58 まで · 止めた通知はありません` / `Until 14:58 · No muted notifications`（時刻は実際に終えた時刻。終わりの時刻を過ぎてから判定で気づいたときは終わりの時刻）。予定由来（会議・この予定の間は集中する）で題名があれば `「定例」の間 · 止めた通知はありません` / `During Team sync · No muted notifications`。`status: "focus"`、`path: "/board"`、音なし
  - 設定 `focus.notify_end`（集中の終わりを知らせる、既定オン）がオフなら、止めた分が無いときは出さない（あるときは上のとおり出す）
  - 閉店モードは D-192 で廃止したので、閉店モード中の扱いは無い
- ブラウザ通知（アプリが無いとき）も同じ: web は `QueueResponse.focus` を見て集中中は出さず、終わりの通知は SSE `notify` の `focus-summary`（件数の形も 0 件の形も）を受けて出す（`desktopNotifier` のときとアプリの中では出さない）。帯には出さない（集中中の帯は終わると消える）

**手動**: `POST /api/focus/start { minutes: 30 | 60 }` または `{ until: "event_end" }`（今の予定（busy・終日でない・今と重なる）の終わり、無ければ今日のこれからの最初の予定の終わり。無ければ 409 `no_event`）。集中中に始めたら終わりを置き換える。上限は12時間。`POST /api/focus/end` で終える（まとめの通知はここで出す）。

**放置の集計**: 変えない。会議中はもともと集計外（busy な予定と重なる時間。phase0-plan 3.3.1）。手動の集中は集計外にしない（仮置き）。

**この予定の間は集中する**（D-130。`focus.reserveEvent` / `focus.cancelReservation`）: `POST /api/focus/events/:id`（`calendar_event.id`）で予約する。終日・終わった予定は 409 `ended`、無い予定は 404 `not_found`。開始の時刻（30秒ごとの判定）に集中を始め（会議なら `source: "meeting"`、それ以外は `"manual"`。`eventId` に予定）、予定の終わりで終える。予定の開始・終わりの変更を追い、予定が消えた・終わったら予約を外す。進行中の予定なら今から始める。予約した予定は問いを出さない（開いていれば閉じる）。途中で終えたら、その予定の間は始め直さない（`started`）。閉店モード中でも始める（自分で決めたことなので）。`DELETE /api/focus/events/:id` で取り消す（その予定の集中の最中なら終え、まとめの通知を出す）。予定の集中（会議・予約）は、どちらも予定の終わりを追う

| API | 中身 | 備考 |
|---|---|---|
| `GET /api/focus` | `FocusView`: `{ active: { since, until, source: "meeting" \| "manual", title: string \| null, label } \| null, prompt: { key, title, start, end, label } \| null, channel: "desktop" \| "band", nextEventEnd: EpochMs \| null, reserved: { eventId, start, end }[], held: number }`（`reserved` は D-130 の予約。`held` は今の集中の間に止めた通知のカードの数で、集中していなければ 0。帯の `止めた通知 3`。HTTP の層で足し、POST の応答も同じ形）。`label` はデーモンで組み立てた表示（`集中 · 16:00まで` / `Focus · until 16:00`、問いは上の題名） | `nextEventEnd` は「次の予定の終わりまで」の終わり（無ければ null。メニューの項目を無効にする） |
| `POST /api/focus/start` | 上の手動 → `FocusView` | 400 `invalid_input` / 409 `no_event` |
| `POST /api/focus/end` | → `FocusView` | 集中していなければそのまま |
| `POST /api/focus/prompt` | `{ key, answer: "focus" \| "skip" }` → `FocusView` | 開いている問いか、閉じた問い（上。予定が続く間）の key。どちらでもなければ 409 `stale`（何もしない）。届いた答えと結果はログ `focus.answered`（`answer`、`late`）/ `focus.answer_stale`（`prompt_open`、`closed_open`）に残す。集中の API の他の 4xx は `focus.rejected`（`path`、`status`、`error`） |
| `POST /api/focus/events/:id` | 予定の間の集中の予約（D-130） → `FocusView` | 404 `not_found` / 409 `ended` |
| `DELETE /api/focus/events/:id` | 予約の取り消し → `FocusView` | 予約が無くても 200 |
| `GET /api/queue/summary` | 従来の件数に `focus: { label } \| null` と `focusMenu: { title, m30, h1, event, end }`（メニューバーの文言。ロケールはデーモンで解決） | Rust は文言を作らない |
| `GET /api/queue` | `QueueResponse.focus: { until, allowNeedsInput } \| null` | web のブラウザ通知の抑止 |
| `GET` / `PUT /api/settings/ui` | `focusPrompt`（`focus.prompt`、既定 true）、`focusTarget`（`focus.target`、`"meetings" \| "busy"`）、`focusLeadMin`（`focus.lead_min`、1〜30、既定5）、`focusAuto`（`focus.auto`、既定 false）、`focusAllowNeedsInput`（`focus.allow_needs_input`、既定 false）、`focusNotifyEnd`（`focus.notify_end`、既定 true。2026-10-19） | 端末ごと（`local_only`） |

- SSE: 集中の状態・問い・閉じた問いが変わったら `focus`（`{ active: boolean, prompt: boolean, late: boolean }`。`late` は閉じた問いがまだ答えを受ける間 true）。web は `["focus"]` と `["queue"]` を無効化し、Rust は件数（メニューバー）を取り直し、`prompt: false` かつ `late: false` なら出した問いの通知を取り下げる（`late: true` の間は残し、ボタンで遅れて答えられる）
- 状態は `setting` の `focus.state`（`local_only`。`{ active, prompt, closed, reserved: [{ eventId, start, end, title, meeting, started }], asked: [{ key, end }], held: [{ workItemId, status }] }`）に置き、再起動しても続ける。`asked` は予定の終わりから1日で消す。`reserved` は D-130 で、`closed` は閉じた問いで足した（古い保存値には無く、空 / null として読む。マイグレーションは要らない）
- `GET /api/health` の `calendarHelper.problem`（D-130）: `"no_access"`（つながっていて権限がフルアクセスでない）/ `"not_connected"`（一度つながったことがあり、2分以上つながっていない）/ `"sync_failing"`（同期の失敗が15分続く）/ null。web のサイドバーの「カレンダーの予定を取れていません」

## 26. 勤務時間の撤去と在席（D-105・D-106・D-110。2026-10-08。ADR 0013、phase0-plan 3.3.1）

勤務時間の概念をなくし、放置を在席（Mac を使っていた時間）で数える。この章より前の勤務時間・`off_hours`・夜の続き・いつもの勤務時間・`PUT /api/work-hours/:date`・SSE `work_hours` の記述は、この章で置き換える。

| 対象 | 変更 | 理由・使い方 |
|---|---|---|
| `DayColumn` | `workHours` と `nightWork` を消した。`plannedHours`（計画の目安）は残す | 時間軸の背景は一様（勤務時間のパネル・時間外の地をやめた）。開いたときのスクロール位置と AI レーンの持ち越しの位置は `plannedHours.start`（今日は今との早い方） |
| `BoardResponse` / `DayResponse` | `usual`（いつもの勤務時間）を消した | 学習した勤務時間はもう持たない |
| `DaySummaryScope` | `workHours` を消した（`{ date, phase }`） | デイビュー上部の「Work 10:00 – now (auto) · Edit」を消した |
| `DailyReport` | `workHours` を消した。`afterClose` は閉じていた区間（閉店〜翌朝 Mac を使い始めるまで）の操作 | 日報・シャットダウンの「Worked … · Edit」を消した |
| `DayTotals.freeMs` / `DayDetail.freeSlots` / MCP `get_free_slots` | 窓は計画の目安（今日は「計画の目安 ∩ [今, 終わり]」。過ぎていれば 0）。core の `planWindow`（`workWindow` から改名） | D-106 |
| `meetingsMs` | 論理日の中の busy な時刻付き予定の和集合（勤務時間で切らない） | |
| `WaitSegmentDetail.excludedBy`・`breakdown.excludedMs` | `off_hours` を `closed`（一日を閉じていた）と `away`（不在）に分けた | 0009 で過去の `off_hours` は `away` に読み替えた |
| `QueueItem` | `waitStartedOffHours` → `waitStartedAway`（待ちの始まりが在席区間の外） | 文言は「待ちは不在の間」 |
| `QueueResponse.notifyPausedUntil` | 閉店モードの間は今より後の時刻（明けの見込み: 次の論理日の始まり、過ぎていれば少し先）。最後に閉じた日の次の論理日の始まりより後で最初に在席したら null | D-110 (1)。明ける時刻は前もって分からないので、判定のたびに見直す |
| `MorningResponse.sinceKind` | `work_end` → `last_seen`（今日の始まりより前の最後の在席） | |
| `PUT /api/work-hours/:date` | 消した | 勤務時間の修正は無い |
| SSE `work_hours` | `plan_guide` に改名（計画の目安の設定を変えたとき。`{ rev, dates }`）。在席・閉店の変化は待ち区間の変化として `work_item` で届く | |
| 設定 | `presence.tail_min`（2〜15、既定 5）を足した。`work_hours.gap`・`work_hours.usual_days`・`work_hours.fallback` を消した。`work_hours.planned` はキーのまま「計画の目安」 | `idle.presence_since` はデーモンが入れる（`turnlane config` の対象外） |
| 3日ボードの左の列（D-076） | `work_day_auto` ではなく、本人の操作（AI への人間入力・`user_op`・手動のタスク完了）があった最後の論理日 | |


## 27. タスクから AI に頼む（D-107・D-109・D-110。2026-10-08。ADR 0014、[ux-mvp.md](ux-mvp.md) 4.16）

型は `packages/core/src/api/launch.ts`。デーモンの `LaunchService`（`apps/daemon/src/launch/`）。

| API | 内容 |
|---|---|
| `GET /api/ai/launch-options?taskId=` | 依頼のポップオーバーの選択肢と既定（`AiLaunchOptions`）。taskId が無ければプロジェクトなし。リポジトリはタスクのプロジェクト → 全プロジェクト → 前回 → 最近 AI が作業したもの（実在するものだけ、20件まで）。ツールは入っているものだけ（ログインシェルの PATH と既知の場所、5分キャッシュ）。既定のツール・型は設定 `ai.last_launch`（前回の選択。端末ごと） |
| `POST /api/ai/launches` | `{ taskId, repo, tool, templateId?, worktree, instruction?, claudeAccount? }` → `AiLaunchResult`。worktree を作り、`ai_launch` を作り、端末で `turnlane ai run <起動 ID>` を実行させる。`outcome`: opened（端末で実行した）/ opened_copied（端末を開いてコピー）/ copied。失敗は 409（`tool_missing`・`not_git`・`worktree_failed`・`repo_missing`・`task_closed`・`account_missing`（選択肢に無いアカウント。D-122））・404（タスク）・400（リポジトリが絶対パスでない） |
| `POST /api/ai/launches/:id/claim` | `turnlane ai run` が1回だけ（作ってから2分以内）受け取る `{ cwd, argv, env, unsetEnv? }`（`unsetEnv` は子の環境から消す変数。D-122）。Bearer だけ（クッキーは 403）。2回目・期限切れは 409 `expired`。受け取ると `started` |
| `POST /api/ai/launches/:id/fail` | `{ reason: "cli_missing" }`（turnlane ai run がツールを見つけられなかった）。Bearer だけ |
| `POST /api/ai/launches/:id/exit` | `{ code, afterMs }`（turnlane ai run が、起動した claude / codex の終了コードと、始めてから終わるまでの ms を知らせる。本文は送らない）。Bearer だけ。`ai_launch` の `exit_code`・`exit_after_ms`・`exited_at` に入れ、ログ `launch.exited`。紐づいた後も記録する。30 秒より前に 0 以外で終わったら、turnlane ai run は端末に「N 秒で終わりました（終了コード X）」を1行出す（タブはシェルに戻るので上のエラーを読める） |
| `GET /api/ai/launches/:id/candidates` / `POST …/link { sessionId }` | 紐づかなかった依頼の候補（同じツールの、依頼の前後30分に始まった紐づいていないセッション、10件）と、選んで紐づける |
| `POST /api/ai/launches/:id/test` | プロジェクトのテストのコマンドを worktree（無ければリポジトリ）で実行する（すぐ `{ state: "running" }` を返す。10分で止める）。終わったら SSE `work_item` / `task` |
| `POST /api/ai/launches/:id/cleanup` | `{ force }` → `WorktreeCleanupResult`。force なしは clean かつ取り込み済みのときだけ消す（`reason`: dirty / unmerged）。force は確認の後 |
| `GET /api/ai/finish-plan?taskIds=` | 完了のシート（ux-mvp 4.16）を出すか: カンマ区切りのタスク（50 件まで）のうち、起動が生きている依頼（`started` / `linked` で、worktree が残っているか `turnlane ai run` が動いている）→ `LaunchFinishPlan { launches: LaunchFinishItem[] }`。`aiRunning`、`worktree: { path, branch, state }`（state: clean = 取り込み済みで未コミットなし / unmerged / dirty）。空ならシートを出さない |
| `POST /api/ai/launches/:id/finish` | `{ closeTerminal, removeWorktree, force }` → `LaunchFinishResult { terminal, reason, app, worktree }`。closeTerminal: AI を終了してタブを閉じる（下）。removeWorktree: `cleanup(force)`（force は未マージ・未コミットの worktree をシートで消すと選んだときだけ）。順番はタブ → worktree。どちらが失敗しても止めない（タスクの完了は画面が続けて呼ぶ）。`terminal`: closed / not_closable（送る口の無い端末。何もしない）/ ai_still_running（終了の指示を送ったが 20 秒で終わらなかった。タブは閉じない）/ failed、閉じなかったら null。`reason`: not_found（端末が見つからない・その起動の端末と確かめられない）/ ai_waiting（許可・選択のダイアログで待っている。送らない）/ send_failed / unsupported / not_exited。ログ `launch.finished`（結果と理由のコードだけ） |
| `GET /api/ai/check?workItemId=` / `?launchId=` | 確認支援（`WorkCheckView`）: 差分の量（`git diff --numstat` を merge-base から。worktree は作業ツリーまで）・未コミットの件数・テスト（コマンドがあり依頼のときだけ。状態はメモリ、DB は成否と時刻）・CI（`gh pr view --json statusCheckRollup,additions,deletions,changedFiles,url`。1分キャッシュ）・worktree。15秒キャッシュ。頼んでいない AI 項目でも差分と CI は出す |
| `GET/POST /api/ai/templates`、`PATCH/DELETE /api/ai/templates/:id` | 依頼の型。組み込み（`builtin:implement` など4つ。名前と本文は画面の言語）は変えられない（409 `builtin`） |
| `TaskView.ai` | 頼んだタスクの最後の依頼（`TaskAiView`: 状態 starting / running / needs_input / your_turn / done_check / error / unlinked / failed、AI 項目、開いている自分の番、リポジトリ・ブランチ・worktree、unlinked の理由 `unlinkedReason`、AI の CLI の終わり `exit`）。頼んだタスクの `followUpId` は開いている自分の番だけ、`workItemId` は紐づいた AI 項目 |
| `ProjectView` / `PATCH /api/projects/:id` | `worktreeDefault`（null = 使う）・`worktreeCopyGlobs`（相対の glob、20個まで）・`testCommand` を足した |
| 設定 | `ai.worktree_dir`（絶対パスか null。null はリポジトリの親）、`launch.finish_close_terminal`・`launch.finish_remove_worktree`（完了のシートの初期値。無ければオン） |
| `GET /api/ai/claude-accounts` | Claude のアカウント（D-122）の一覧（`ClaudeAccountView[]`: 設定ディレクトリ・ディレクトリ名からの名前・設定した名前・外したか）。取り込みが見つけた `claude_code` の取り込み元（取り込みを止めたものを除く）。設定 > AI で使う |
| 設定（D-122） | `ai.claude_accounts`（設定ディレクトリ → `{ name?, hidden? }`。名前の変更と起動の選択肢から外す）、`ai.claude_account_by_project`（プロジェクトの ID → 設定ディレクトリ。プロジェクトの既定）。どちらも端末ごとの設定（パスは端末に固有なので project の列にしない。マイグレーションなし） |

**タブを閉じる（finish の closeTerminal。`apps/daemon/src/launch/finish.ts`）**: 送る口は Turnlane から答える（31章、`answer/deliver.ts`）と同じで、送る文は固定の `/exit`（Claude Code）・`/quit`（Codex CLI。`/exit` と同じ）・`exit` だけ。

1. 居場所: `pgrep -f "ai run <起動 ID>$"` で `turnlane ai run` を探し（tmux のクライアントは除く。1 つに決まらなければ送らない）、`ps` と「開く」の `locateLive` で tty・tmux のペイン・端末のアプリを調べ、親のプロセス（タブのシェル）を覚える。受け取り（claim）のときにも調べてメモリに持つ（AI が先に終わっていても、そのタブのシェルに `exit` を送れる。デーモンを再起動すると忘れる）
2. AI がまだ動いていれば（`turnlane ai run` がその tty にいる）、許可・選択の待ち（`openWaitFor` が permission / ask）でないことを確かめて終了の指示を送る
3. `turnlane ai run` がその tty から居なくなるまで最長 20 秒待つ（終わりの知らせ `exit` を送ってから自分も終わる）。過ぎたら ai_still_running
4. タブのシェルがまだ同じ tty にいれば `exit` を送る。Orca は `orca terminal close --terminal <ハンドル> --tab --json`（ハンドルは hooks が記録したもの、無ければ worktree が cwd を含む端末が 1 つだけのとき）。Turnlane が包んだ tmux のセッション（親が tmux のサーバ）はペインが無くなったことだけ確かめる

- 判定: 紐づいたセッションの AI 項目の自分の番は、新しいタスクを作らず頼んだタスクに付ける（`follow_up.task_id` は一意でなくなった。0010）。自分の番が閉じても（自動・手動・対応不要）頼んだタスクは閉じない。頼んだタスクを完了にすると開いている自分の番をすべて済ませる。事実に `launch: { at, closedAt }` を足し、依頼より後に質問・許可・エラーなしで終わったターンからも待ちを数え、頼んだタスクが開いている間を「タスクが出ていた区間」にする（core `derive/time.ts`）。頼んだ AI の項目の題名はタスクの題名（`title_source = session_name`）
- Claude のアカウント（D-122。2026-10-08）: `AiLaunchOptions.claudeAccounts`（外したものを除く。`name` は設定の名前 → ディレクトリ名から。`~/.claude` は null で、画面は「既定」）と `defaultClaudeAccount`（選んだリポジトリのプロジェクトの既定 → タスクのプロジェクトの既定 → `ai.last_launch.claudeAccount` → 先頭）、`LaunchRepoOption.claudeAccount`（そのリポジトリのプロジェクトの既定）。Claude Code で頼むと、`claudeAccount`（省略は既定）の設定ディレクトリが `~/.claude` 以外なら受け取りの `env` に `CLAUDE_CONFIG_DIR` を足す。`~/.claude` で、選択肢が2つ以上なら `unsetEnv: ["CLAUDE_CONFIG_DIR"]`（端末のシェルの値を消して既定に戻す）。選択肢が1つ（`~/.claude` だけ）なら環境に触れない。端末に入力するコマンドは変えない。ログインしているかは判定しない（認証のファイルを開かない）。Codex（`CODEX_HOME`）は対象外
- 紐づけ: 10秒ごと（`tick`）。Claude Code は `ai_session.external_id = session_uuid`、Codex は cwd と受け取りの時刻（10秒前〜3分後）。受け取られないまま2分で failed（`not_claimed`。ログ `launch.failed`）、受け取りから5分見つからなければ unlinked。終わったと知らされてから1分見つからなければ、5分を待たずに unlinked。unlinked にしたときに理由を `ai_launch.unlinked_reason` と `TaskAiView.unlinkedReason` に入れ、ログ `launch.unlinked`（reason・終了コード・時間）に出す: `exited`（AI の CLI がセッションを作らずに終わった。`TaskAiView.exit` に終了コードと時間）/ `untrusted`（Claude Code がそのフォルダを信頼していない。対話モードの claude は「このフォルダを信頼しますか」で止まり、答えるまでセッションを作らない）/ `no_session`（動いているがセッションが来ない）

## 28. 拡張点（ADR 0015。2026-10-08）

本体は「拡張」をビルドのときに組み込める（`scripts/build.ts --ext <dir>`、dir に `extension.json`）。拡張を指定しないビルド（公開のソースからのビルド・CI）では一覧が空で、下のどれも増えない。拡張の中身はこのリポジトリに書かない。拡張点の確かめはテスト用の拡張（`test/ext-fixture/`、`apps/daemon/test/ext.test.ts`・`apps/web/test/ext.test.ts`・E2E の `ext` / `ext-none`）で行う。

| 拡張点 | 本体の扱い |
|---|---|
| 設定のキー | `ext.<id>.<名前>`。`GET /api/config`・`GET|PUT /api/config/:key`（turnlane config）で本体のキーと同じに扱い、拡張が渡した zod で検証する |
| マイグレーション | テーブル名は `ext_<id>_`。本体の `__migrations`・`user_version` とは別に `__ext_migrations(ext, id, seq, applied_at)` で管理する。本体のテーブルを作り替える文は受け付けない（起動しない）。拡張を組み込んだビルドで使った DB を拡張なしで開いても動く |
| ルート | `/api/ext/<id>/*`。認証・no-store・操作の記録は本体の `/api` と同じ。型付きクライアント（`AppType`）には入らない |
| 版 | `EXT_API_VERSION` は 2（2026-10-14。D-192 で `morningSteps` / `shutdownSteps` / `useStepFoot` / `nextStep` / `morning.claim` を消し、`todayNotices` と `ExtTaskOrigin.primary` を足した互換を壊す変更。ADR 0017） |
| start / stop | デーモンの起動の最後と停止の最初 |
| 部品（ExtDeps） | DB（拡張のテーブルだけ書く）・時計・設定・SSE・タスク（add_task と同じ。変える・消す・完了の取り消し・時間ブロック）・自分の番の一覧・起動（ADR 0014。`trigger` を指定できる。捨てる）・在席・カレンダー（busy・空き枠・予定の事実）・通知の保留・確認支援（差分の中身）・AI の1回の実行（日報の要約と同じ起動。応答の形・アカウント）・スリープさせない（`caffeinate -i -w <pid>`。ディスプレイは止めない）・電源とふたの状態・Claude の利用枠 |
| 予定の事実 `calendar.events(from, to)` | busy な時刻付きの予定（終日・取り消し・自分の時間ブロックを除く）を開始の順に `{ id, start, end, meeting }`。`meeting` は集中モードの対象（参加者か会議リンク。`isFocusTarget` の meetings）と同じ。題名・場所・参加者は渡さない |
| フォルダの信頼 `launcher.folderTrust({ repo, tool?, claudeAccount?, taskId? })` | `trusted` / `untrusted` / `unknown`。そのアカウントの Claude Code の設定のファイル（設定ディレクトリの `.config.json` があればそれ、無ければ `$CLAUDE_CONFIG_DIR/.claude.json`、既定のアカウントは `~/.claude.json`）の `projects[<パス>].hasTrustDialogAccepted` だけを読む（ほかの値は読まない・持たない）。見るパスは Claude Code と同じ: git のリポジトリなら元のリポジトリのルート（worktree は元のリポジトリの信頼を引き継ぐ）と、フォルダからリポジトリのルートまでの親（リポジトリの外の親の信頼は効かない）。git でなければ `/` までの親。`claudeAccount` を省くと起動と同じ既定。Codex・読めないときは `unknown` |
| 信頼のために開く `launcher.openForTrust({ repo, claudeAccount? })` | いつもの端末でそのフォルダの `claude` を開く（前面に出す。アカウントは起動と同じく `CLAUDE_CONFIG_DIR` を付ける・消す）。信頼は人が端末で選ぶ。本体は設定のファイルに書かない。開けなければコマンドをコピーする。`{ outcome: "opened" \| "opened_copied" \| "copied", app, command }` |
| 人のいないときの起動 `launcher.launch(input, trigger, { unattended: true })` | 画面がロック中（`ioreg -n Root -d1 -a` の `CGSSessionScreenIsLocked`）なら何も作らずに `{ outcome: "locked", reason: "screen_locked" }`（ロック中に開けると確かめた Orca は待たずに起動する。S8）。いまの端末でロック中に待つかは `launcher.waitsWhileLocked()`（起動の部品が無いときは true）。Orca は `--focus` を付けない。端末を開けなければコピーに落とさず、作った worktree・ブランチ・起動の行を片付けて `{ outcome: "locked", reason: "not_opened" }`。呼び出し側はロックが外れてから同じ呼び出しをやり直す。端末ごとのロック中の振る舞いは `docs/spikes/s8-launch-while-locked.md` |
| タスクと時間ブロック `tasks.update`・`tasks.remove`・`tasks.blocks`・`timeBlocks.*`（2026-10-13） | `tasks.update(id, { title?, notes?, estimateMin?, date? })` は画面の編集・日付の移動と同じ（渡したものだけ変える。`date: null` は Inbox）。`tasks.remove(id)` は画面の削除と同じ（時間ブロックは残り、タスクと一緒に表示から消える）。`tasks.blocks(id)` はそのタスクの時間ブロック（開始の順）。`timeBlocks.create({ taskId, startAt, endAt })`・`update(id, { startAt?, endAt? })`・`remove(id)` は画面で時間に置く・動かす・外すのと同じ（カレンダーには書かない。D-093）。無い・消したタスクとブロックは null か何もしない（例外にしない。create の無いタスクだけ例外）。拡張が作るタスクの `external.source` は `ext.<id>` か `ext.<id>.<名前>` にする（下の Web の出どころ） |
| 稼働日 `calendar.isWorkday(date)`（2026-10-13） | 設定の稼働曜日かつ祝日のカレンダーの祝日でない（3日ボードの列・持ち越しと同じ）。`calendar.freeSlots(date)` は計画の目安の窓から busy な予定と時間ブロックを引いた区間（デイビューの空き枠と同じ。15分単位、今日は今より後、稼働日でなければ空）で、空きに置くときはこれの先頭から長さの入るものを選ぶ |
| 電源とふたの状態 `power.state()` | `Promise<{ ac: boolean \| null, lidClosed: boolean \| null }>`。`pmset -g batt` の `Now drawing from 'AC Power'`/`'Battery Power'` と `ioreg -r -k AppleClamshellState -d 1` の `AppleClamshellState` を読むだけ（root 不要。読めない値・ふたの無い Mac は null）。変化の購読は無い（必要なときに呼ぶ）。`power.keepAwake` を保持していても、ふたを閉じる（外部ディスプレイなし）とスリープは止められない |
| Claude の利用枠 `limits.claude(account?)` | `{ fiveHour?, sevenDay?, at } \| null`（各枠は `{ usedPercentage, resetsAt }`、時刻は ms）。`account` は設定ディレクトリの絶対パス（省略は `~/.claude`）。値は本体が起動した Claude Code のセッションの statusLine から届いたものだけ（下の「利用枠の受け口」）。届いていない（Pro・Max の契約でない・セッションの最初の応答の前・本体が起動したセッションが無い）か、どの枠もリセットの時刻を過ぎていれば null。拡張は null のとき自分で予備の扱いをする |
| 頼んだ AI のエラーの種類 `TaskAiView.errorKind?` | `state` が `error` のとき、StopFailure の hook の `error`（公式の項目名。古い spool の行は `error_type`）の種類（AI 詳細パネルの `errorKind` と同じ値）。利用枠で止まったものは `state` が `limit`（上限待ち。2026-10-23 に足した値）で `errorKind` は `rate_limit`。ほかは null。`tasks.get(id).ai` と board 等の応答の `ai` に付く |
| タスクの完了の取り消し `tasks.reopen(id, { followUps? })`（2026-10-14） | 画面の完了の「元に戻す」（⌘Z。D-139 (3)）と同じ。未完了（todo）に戻し、`followUps`（完了で一緒に閉じた自分の番の id）を開き直す。閉じた自分の番は完了の前に `queue()` の項目の `followUps` から取っておく。完了していないタスクは何も変えずに返す。無い・消したタスクは null |
| 依頼の差分の中身 `review.diff(launchId, { maxFiles?, maxBytes? })`（2026-10-14） | `WorkDiffView \| null`: `{ base, files: { path, additions, deletions }[], totalFiles, additions, deletions, untracked, excerpt, truncated }`。範囲は `review.check` の差分と同じ（base との分岐点から、worktree があれば作業ツリーまで・無ければブランチの先端まで。origin の無いリポジトリの base `HEAD` は元のリポジトリで解いたコミット）。`files` はバイナリの行数が null で、追加・削除の多い順に `maxFiles`（既定 30・最大 200）まで。`untracked` は worktree のまだ git に入れていないファイルの名前だけ（中身は読まない）。`excerpt` は `git diff --unified=2` をファイルごとに分け、ファイルごと（`maxBytes` の 1/4）と全体（`maxBytes`。既定 12000・最大 64000 バイト）の上限まで、行の途中で切らずに入れたもの（バイナリは入れない）。切ったら `truncated`。git の読み取りだけ。git でない・base と同じ・片付けた後は null |
| 依頼を捨てる `launcher.discard(launchId)`（2026-10-14） | AI 詳細パネルで確認の後に「worktree を消す」を押したのと同じ（`POST /api/ai/launches/:id/cleanup { force: true }`）: `git worktree remove --force` と `git branch -D`（手元のブランチだけ）。未コミットの変更・取り込まれていないコミットも消える。タスク・PR・リモートのブランチには触らない。確認は呼び出し側の画面が出す。結果は `WorktreeCleanupResult`（worktree の無い依頼は `removed: false`・`missing`） |
| AI の1回の実行 `ai.runOneShot({ tool, input, timeoutMs?, schema?, claudeAccount? })`（`schema`・`claudeAccount` は 2026-10-14） | 日報の要約と同じ起動（ツールなし・セッションを保存しない・要約の作業ディレクトリ）。`schema`（JSON Schema）は、CLI の `--help` に構造化の出力のフラグがある版だけ渡す: Claude は `--output-format json --json-schema <JSON>`（結果の包みの `structured_output`、無ければ `result` の文を JSON として読む）、Codex は一時ファイルに書いて `--output-schema <ファイル>`（`-o` の最後の応答を JSON として読む）。結果は `{ ok: true, text, json }`。読めなければ `empty` の失敗。フラグの無い版では渡さずに `{ ok: true, text }`（json なし。日報の要約と同じ検査）。このフラグは要約の「無い起動フラグ」（`missingFlags`）には数えない。`claudeAccount`（設定ディレクトリの絶対パス）は Claude だけ: `~/.claude` 以外なら `CLAUDE_CONFIG_DIR` を付け、`~/.claude` ならデーモンの環境の `CLAUDE_CONFIG_DIR` を消す（起動と同じ）。省略すると今までどおり |
| ~~朝の計画の「夜のあいだ」から外す `morning.claim(fn)`~~ | 廃止（D-192。朝の計画ごと無くなった） |
| 確認のダイアログ `ConfirmDialog`（`@turnlane/ext-host`。`destructive`・`note` は 2026-10-14） | `{ title, body, note?, confirm, cancel, destructive?, onConfirm, onCancel }`。⏎ で確定、Esc でやめる。`destructive`（取り消せない操作）は幅 480px、確定のボタンを赤い字（面は塗らない）にし、やめるのボタンに Esc を付ける。`note` は本文の下のもう1段落 |
| SSE | `ext`（`{ exts: [id] }`）。web は `["ext", id, ...]` のキャッシュを取り直す |
| health | `extensions`: 組み込んだ拡張の id（公開のビルドでは `[]`） |
| Web | 経路（`/ext/<id>`。上部バーの題名を付けられる）・設定の節（「データ」の前）・今日の列の先頭行の知らせ（`todayNotices`）・サイドバーの行・ポップオーバーの行・タスクの右クリックの項目（1件・未完了）・タスクの詳細パネルの節（AI の節の後）・パレットのコマンド・辞書（`ext.<id>.`）・AI に頼むの入力の行（依頼を引き受けたら今すぐの起動をしない。`layout: "rows"` なら本体はラベルの行を作らず、拡張が `@turnlane/ext-host` の `LaunchRow` で行を並べる。null を返せば何も出ない）・時間軸の印 |
| 時間軸の印 `timelineMarks(range)` | React のフック（列ごとに、その列の時間軸の範囲で呼ぶ）。`{ id, at, end?, title, detail?, taskId? }` を返す。本体が 3日ボードの今日の列（AI レーンがある列）とデイビューの AI レーンに描く: 6px の中を塗らない実線の枠（待ちの線の点線・完了した AI の灰の線と形で分ける）と時計のアイコン、題名と時刻（mono）、2行目に `detail`。列はその高さの AI の線（ラベルの高さを含む）より右。押すと `taskId` のタスクの詳細パネル |
| ~~一日を閉じるの手順 `shutdownSteps`・朝の計画の手順 `morningSteps`・`useStepFoot`・`nextStep`~~ | 廃止（D-192。2026-10-14。`EXT_API_VERSION` 2）。行き場は `todayNotices`・サイドバーの行・`ExtTaskOrigin.primary`・拡張の画面 |
| 今日の列の先頭行の知らせ `todayNotices`（2026-10-14） | `{ id, component }`。3日ボードの今日の列の上部の先頭（自分の番の帯の上）と、デイビューの右の一覧の先頭に出す 1 行（複数の拡張があれば登録順）。部品は `@turnlane/ext-host` の `TodayNotice`（`{ text, tone?: neutral \| needs \| error \| running, icon?, to, testId? }`。28px の 1 行。左に 16px のアイコン、文（13px・500）、右端に →。`needs` は琥珀 8% の面、`error` はアイコンだけ赤、`running` はアイコンだけ青。全体が 1 つのボタンで押すと `to`。折り返さず末尾を省略。`j` / `k` の対象にしない）を返すか null |
| 出どころの主ボタン `ExtTaskOrigin.primary`（2026-10-14） | `taskOrigins[].primary?: ExtMessageKey`。あれば、その出どころのタスク（未完了）の詳細パネルの主ボタンの文言になり、押すと `to` へ移る（⏎ も同じ。`taskPrimaryOf` の `extOrigin`。自分の番の次、`openAi` の前）。「AI に頼む」は従来の位置（主ボタンでないときの 2 つ目）に下がる。完了したタスクでは出ない |
| キー `useKeys(handlers)`（`@turnlane/ext-host`） | 拡張の画面（`/ext/<id>/…`。枠の中・枠なしのどちらも）で、本体のキーの基盤に処理を登録する（アンマウントで外れる）。受けられるのはキーマップの id のうち `ExtKeyId` だけ: `next`・`prev`（j・↓ / k・↑）、`open`（⏎）、`select`（x）、`reorderUp`・`reorderDown`（⌘↑ / ⌘↓）、`remove`（⌫）、`escape`（Esc。`nextStep` は D-192 で消えた）。枠の中の画面では、部品が受けなければ本体がパレット・ヘルプ・詳細パネルを閉じる。Esc は入力欄の中でも届く。キーは利用者の割り当て（設定 > キーボード）に従う。後から登録した処理が先に呼ばれ、false を返すと次へ回る。1文字のキーと ⌫ は入力欄にフォーカスがあるときは届かない。`reorderUp`・`reorderDown`・`remove` は拡張の画面だけが使う定義で、拡張を組み込まないビルドではキーマップに無い（`?` の一覧・⌘K・キーボードの設定・衝突の検出は今までどおり）。`remove` の ⌫ は本体の「時間軸から外す」（`unblock`）と同じキーで、本体の処理が受けなかったときに拡張へ回る |
| 上部バーの題名 `routes[].title`・`titleAside` | 枠の中の拡張の画面（`chrome` が `shell`）で、上部バーの左に題名（Inbox・自分の番の画面と同じ字。`ext.<id>.` の文言）と、その右に `titleAside` の部品（件数・札など）。`title` が無ければ今までどおり何も出さない。枠なしの画面には上部バーが無い |
| 画面の移動 `navigate(path)`（`@turnlane/ext-host`） | 本体の画面（`/board`・`/day`・`/inbox`・`/ext/<id>/…` など）へ移る。`?panel=<workItemId>` を付けると AI 詳細パネルも開く（デスクトップアプリが通知のクリックで呼ぶ `__turnlaneOpen` と同じ処理）。メニューバーのポップオーバー・クイック入力のウインドウからは main のウインドウを出して開く |
| AI 詳細パネル `openAiPanel(workItemId)` | 枠の中の画面ならその場で AI 詳細パネルを開く。枠なしの画面からは週ボードへ移って開く |
| タスクの詳細パネル `openTaskPanel(taskId)`（2026-10-14） | `openAiPanel` と同じ開き方で、タスクの詳細パネルを開く（枠の中ならその場で、枠なしの画面からは週ボードへ移って開く） |
| 本体の開き方 `openAi(workItemId, action?)` | 13章の `POST /api/open { workItemId, action? }` と同じ（AI 詳細パネルの「開く」・タスクの頼んだ AI の「開く」）。`action` を省くと本体の既定、`"session"` は設定の端末で resume を入力済みにする（開けなければコマンドをコピー）。結果は本体がトーストで知らせる。開けたら true |
| アイコン `StatusIcon`・`Icon`（`@turnlane/ext-host`） | `StatusIcon`（`{ status, estimated?, size?, title? }`）は本体の状態アイコン5種（形・色・回転・明滅は本体と同じ）。`Icon`（`{ name, size?, className?, label? }`。既定 16px）は本体の線のアイコン（Lucide、1.5 の線、色は文字の色）から名前で選ぶ: `check`・`chevron-down`・`chevron-right`・`circle-pause`・`clock`・`corner-down-right`・`external-link`・`git-branch`・`grip-vertical`・`info`・`list-checks`・`minus`・`moon`・`panel-right`・`plug`・`plus`・`search`・`square-terminal`・`triangle-alert`・`x`。拡張は lucide-react を直接 import しない |
| ⌘K の選択中の項目 | タスクの右クリックの項目（`taskMenuItems`）は、画面で1件・未完了のタスクを選んでいるとき ⌘K の「選択中」の節にも出る（`when` も同じ）。押すと、その時に選んでいるタスクで `run(task, anchor)` を呼ぶ（最近から選んだときも今の選択。選択が合わなければ本体の「選んでいる項目がありません」） |
| 拡張が作ったタスクの出どころ `taskOrigins`（2026-10-13） | `{ source, label, to? }[]`。`source` はデーモンの `tasks.create` の `external.source`（`ext.<id>` か `ext.<id>.<名前>`）。Inbox の行・カードの2行目・詳細パネルの「経由」に `label`（`ext.<id>.` の文言）を出す。`to` があれば詳細パネルの「経由」の右に移動のボタン（`navigate` と同じ）。拡張を組み込まないビルドでは `ext.` の出どころは何も出さない（経由は「手入力」）。検査で source・label の接頭辞が合わない拡張は組み込まない |
| ポップオーバーの分割ボタン `LaunchSegmented`（`@turnlane/ext-host`、2026-10-13） | `{ value, options: { v, label }[], onChange, label, testId? }`。AI に頼むの「使う AI」と同じ部品（沈んだ面の上で、選んでいるものだけ浮いた面と枠の影。`aria-pressed`）。ポップオーバーの中ではこれを使う。`Segmented` は設定の画面の地（背景）の上の部品で、ポップオーバーの面の上では選んでいる印が見えない |
| サイドバーの行 `sidebarItems` | `{ id, component }`。サイドバーの下、取り込み・カレンダーの知らせ（D-118・D-130）の上に、部品が返した1行。部品は `@turnlane/ext-host` の `SidebarNotice`（`{ text, detail?, tone?, icon?, count?, mark?, to }`。本体の知らせの行と同じ作りで、文は切らずに折り返す。押すと `to`。今いる画面なら本体の項目と同じ面と枠。畳んだサイドバーではアイコン、ホバーで開いたときと同じ文（と detail）。右上の点は「見るものがある」ときだけ: `mark` の指定に従い、省くと `count`（文に入れた件数。ここでは描かない）が 1 以上か `tone` が neutral 以外のとき。何も無い neutral の行には点を付けない）を返すか null |
| ポップオーバーの行 `trayItems` | `{ id, component }`。メニューバーのポップオーバー（`/tray`）の下の操作の先頭（集中の行の上）に1行。部品は `@turnlane/ext-host` の `TrayRow`（`{ text, meta?, tone?, icon?, to }`。本体の行と同じ高さ・字。押すと main のウインドウで `to` を開く）を返すか null。メニューバーのアイコンと件数は本体のまま |

`tone` は `neutral | running | needs | error | done`（状態アイコンの色）、`icon` は `list | moon | clock | alert | pause`（本体のアイコンから選ぶ。`pause` は一時停止の丸）。

### 28.1 利用枠の受け口（statusLine。2026-10-11）

- 本体が起動する Claude Code（タスクから AI に頼む・拡張の `launcher.launch`）にだけ、`--settings '{"statusLine":{"type":"command","command":"<turnlane> statusline"}}'` を渡す。利用者の `settings.json` は書き換えない。利用者の statusLine の `padding`・`refreshInterval`・`hideVimModeIndicator` は引き継ぐ。Codex・利用者が自分で起動したセッションには何もしない
- `turnlane statusline`（使い方には出さない）は statusLine の入力（stdin の JSON）から `rate_limits.five_hour` / `seven_day` の `used_percentage` と `resets_at`（Unix 秒 → ms）だけを取り出し、`POST /api/limits/claude`（Bearer。`{ account, fiveHour?, sevenDay? }`、`account` は `CLAUDE_CONFIG_DIR`、無ければ `~/.claude`）に送る。300ms で打ち切り、デーモンが動いていなければ送らない。会話・費用・モデル・パスは送らない（ADR 0005）。本人の「操作」には数えない（`x-turnlane-client: statusline`）
- 同時に、`--settings` が無ければ効いていた利用者の statusLine（プロジェクトの `.claude/settings.local.json` → `.claude/settings.json` → `<設定ディレクトリ>/settings.json` の最初のもの。組織の管理の設定はコマンドラインより強く、そのときは受け口が呼ばれない）に同じ入力を渡し、出力と終了コードをそのまま返す。無ければ何も出さない。Claude Code が次の更新で受け口を止めたら（SIGTERM）、利用者のコマンドも止める。入れ子（利用者の statusLine が受け口自身）は1段で止める
- デーモンはアカウントごとの最新の値をメモリと `claude_limit` に持つ（届いた枠だけで置き換え。読むときにリセットの時刻を過ぎた枠を落とす）
- 2 つ目の入り口: 利用者が自分で起動した Claude Code でも値が取れるよう、取り込みの live probe が設定ディレクトリの `.claude.json` の利用枠のキャッシュ（`cachedUsageUtilization`。使用率と明ける時刻と取得時刻だけ。ai-session-ingestion 1.1 の「利用枠のキャッシュ」）を読む。`claude_limit.at` を「値の時刻」（受け口は受けた時刻、キャッシュは取得時刻）とし、キャッシュは `at` より新しく取得したものだけを記録する（受け口から届いた新しい値を古いキャッシュで上書きしない）。記録したら判定をやり直す（受け口からの値は 60 秒ごとの判定で反映）
- `rate_limits` は claude.ai の Pro・Max の契約で、セッションの最初の応答の後にだけ届く（公式ドキュメント）。確かめは `docs/spikes/s9-claude-usage-limits.md`

版は `EXT_API_VERSION`（`@turnlane/core`）。合わない拡張は組み込まない。足すときは上げず、変える・消すときに上げる（ADR 0017）。本体は「拡張が使えるか」を判定しない。

## 29. カレンダーの色（D-125。2026-10-08。[ux-mvp.md](ux-mvp.md) 4.13、phase0-plan 2.3 の calendar）

- DB: `calendar.color_key`（0011。パレットのキー。NULL ならカレンダーアプリの色 `color`）。calendar は端末内だけ（同期しない）。同期（`CalendarSync`）は `color` だけを書き、`color_key` には触れない。カレンダーアプリ・Google 側の色は書き換えない（ヘルパに送らない）
- パレットのキー: `red` `orange` `yellow` `lime` `green` `sky` `blue` `lavender` `purple` `pink` `brown` `gray`（`packages/core/src/calendar/colors.ts` の `CALENDAR_COLOR_KEYS`。消さずに足す）。値はテーマごとに web のトークン `--dl-cal-<key>`（`apps/web/src/styles.css`。docs/design/README.md の R52）。API はキーだけを返し、web が `calColor(color, key)` でテーマのトークンに解く
- `PATCH /api/calendars/:id` の本文に `colorKey?: CalendarColorKey | null`（`role` と一緒でも、どちらか一方でもよい。どちらも無い・知らないキーは 400 `invalid_input`、無いカレンダーは 404 `calendar_not_found`）。応答は `{ calendar: CalendarView }`
- 足した値: `CalendarView.colorKey`、`CalendarEventView.calendarColorKey`・`calendarId`、`CalendarEventDetail.calendarColorKey`、`EventsStatus.calendar.colorKey`（作成のポップオーバーの上端）。`calendarColor` はカレンダーアプリの色のまま
- SSE: 役割・色を変えたら `calendar { dates: 窓の全日付, calendars: true }`。web は `calendars: true` のときだけカレンダーの一覧（`["settings", "calendars"]`・`["settings", "calendar-status"]`・`["calendars", …]`）も取り直す。束ねても `calendars` は残る（`inbox` と同じ OR）
- 楽観的更新: 選ぶとそのカレンダーの予定（3日ボード・週・デイビューのキャッシュの `events`・`allDayEvents`）の `calendarColorKey` を先に変え、失敗したら戻してトースト。⌘Z の対象にしない


## 30. 詳細パネルの幅（2026-10-13。[ux-mvp.md](ux-mvp.md) 4.12.1）

| API | 中身 | 備考 |
|---|---|---|
| `GET` / `PUT /api/settings/ui` | `panelWidth: number \| null` を足した（右の詳細パネルの幅、px。null は既定の 380px）。PUT で `null` を送ると既定に戻す | `setting` の `ui.panel_width`（`local_only`。この Mac に1つ、同期しない）。320〜1600 の整数か null（core の `PANEL_WIDTH_SCHEMA`）。外れたら 400 `invalid_input`、読むときに壊れていれば null |
| `GET` / `PUT /api/config/ui.panel_width` | 同じ値（`turnlane config`） | `CONFIG_SCHEMAS` の `ui.panel_width` |
| SSE | 保存で `settings` を送る（既存）。web は `["settings"]` を取り直す（開いている別の窓・デスクトップアプリも同じ幅になる） | |

- 画面の幅から決まる最大（パネルの左に 640px を残す。既定より狭くはしない）は web が当てる（core の `clampPanelWidth`）。デーモンは書式だけを検証する

## 31. Turnlane から答える（D-238。2026-10-20。ADR 0019、[ux-mvp.md](ux-mvp.md) 4.18、[desktop-shell.md](desktop-shell.md) 4.4）

自分の番の待ち（問い・許可・エラー）への答えを、そのセッションの端末のタブ（ペイン）に文字として届ける。確認が取れたら Turnlane に留まり、取れなければタブを前に出す（D-241）。実装は `apps/daemon/src/answer/`（`deliver.ts` は届け先の決め方と送り方の純粋な関数、`wait.ts` は待ちの読み取り）、純粋な文の整え方は `packages/core/src/answer.ts`。

**待ちの対象の決め方**（D-240）: 答える対象は待ちそのもの。開いているフォローアップ（approve → resume_error → reply。open を先に）があればそれ、無ければセッションの待ち（needs_input の許可待ち = `permission`・AskUserQuestion = `ask`、your_turn で理由に問いを含むセッションの最後のターン = `question`）。判定は core の `derive.sessionWaitOf`（runner が判定のたびに作り、メモリに持つ）と `derive.openWaitOf`。猶予（`reply.delay_minutes`）は見ないので、在席中の問いは返答タスクができる前（猶予の間）から答えられる。猶予の間の問い（返答タスクの無いセッションの待ちの `question`。そのターンに返答タスクが閉じたものも含めて 1 つも無いもの）は `GET /api/queue` の `grace`（`QueueItem[]`。`followUps: []`、`grace: { until }` = ターンの終わり + 猶予、待ちの始まりの古い順）に出し、`items`・`/api/queue/summary`・通知・MCP・拡張には入れない。web は `items` の後ろに薄い行として足す（core の `turnRows`。D-245）。返答タスクの行・通知・放置の数え方は猶予の後のまま。`GET /api/queue` の item の `wait` と `GET /api/work-items/:id` の `openWait`（`{ kind, turnId, followUpId }`。フォローアップの無い待ちは `followUpId: null`）に同じ判定を付け、web の「答える」・`a`・右クリックはこれがあるときだけ出す。wait・answer・送る直前の確かめも同じ判定を使う。PR の確認・マージには付かない。

**AskUserQuestion の許可待ち**（2026-10-20）: Claude Code は AskUserQuestion のダイアログにも `PermissionRequest`（`tool_name: AskUserQuestion`）を出し、フォローアップは approve になる。待ちのターンの最後の PermissionRequest のツール名が AskUserQuestion なら、待ちの種類は `permission` ではなく `ask` にする（queue・詳細・wait・answer・glance で同じ。「許可する」= `1` は出さない。送ると最初の選択肢を選んでしまう）。また Claude Code（2.1.3xx で確認）はダイアログの間、その tool_use を記録に書かないことがある。記録にその tool_use が無いときは中身を `unreadable` とし、送る前・送った後の確かめでは「閉じた」とせず DB の状態だけで判断する（送った後は確かめられないので `confirmed: false` でタブを前に出す）。tmux はデーモンから呼ぶとき必ず `-u` を付ける（LaunchAgent の環境には LANG が無く、tmux は UTF-8 でないクライアントへの `-F` の出力のタブを `_` に置き換えるので、ペインを見つけられない）。

### 31.1 `GET /api/work-items/:id/wait`

`Cache-Control: no-store`。AI 項目が無ければ 404。

```ts
interface WaitResponse {
  workItemId: string;
  followUpId: string | null;
  kind: "question" | "ask" | "permission" | "error" | "none";
  question?: { text: string; truncated: boolean; masked: boolean }; // 全文。2,000 字で切る（truncated）。伏せ字済み
  options?: { n: number; label: string }[];   // 番号付きの選択肢（AskUserQuestion の選択肢、問いの文の最後の `1. …` の並び）
  permission?: GlancePermission;               // glance と同じ（伏せ字済み）
  canAllow: boolean;                           // 許可待ちで「許可する」を出す（Claude Code だけ）
  error?: ErrorKind;
  unavailable?: GlanceUnavailable;             // 読めなかった理由（off = 設定「行に中身を出す」がオフ）
  delivery: {
    deliverable: boolean;
    via: "tmux" | "iterm" | "terminal" | "ghostty" | "orca" | null;
    terminal: string | null;                   // 端末のアプリの表示名
    landing: string | null;                    // `Orca · タブ` / `iTerm2 · タブ` / `ターミナル · タブ` / `Ghostty · タブ` / `Ghostty · main:1.0`
    multiline: boolean;                        // 改行をそのまま送れる（tmux の Claude Code だけ）
    reason?: "not_live" | "unsupported" | "not_found" | "off";
  };
  readAt: EpochMs;
}
```

- 問いの全文は表示の瞬間に記録から読む。保存しない（ADR 0005 の追記 2・ADR 0019）。Codex は読まない（`unavailable: "unsupported"`。答えは送れる）
- 届け先は「開く」と同じ居場所（desktop-shell.md 4.4）から決める。動いていないセッションは `not_live`

### 31.2 `POST /api/work-items/:id/answer`

入力は `{ text }`（1〜4,000 字）か `{ allow: true }`（許可待ちだけ）のどちらか。ほかのキーは 400。

1. 設定 `turn.answer` がオフなら `409 answer_off`
2. 待ちがまだ開いているかを確かめる: 対象がフォローアップならそれが open / snoozed、フォローアップの無い待ちなら今のセッションの待ちが同じターン・同じ種類で（D-240）、記録の末尾で問い・エラーは最後の人の指示より後に AI の発言がある、許可待ち・回答待ちは結果の無い tool_use が残っている。閉じていれば `409 wait_closed`（送らない）
3. 届け先を決めて送る。送れなければ `409 undeliverable`、送る起動が失敗・Orca が受理しなければ `409 send_failed`
   - tmux: `send-keys -t <ペイン> -l -- <文>` と `send-keys -t <ペイン> Enter`（末尾の `;` は `-H 3b`）
   - iTerm2: AppleScript で tty の一致するセッションに `write text`（末尾の改行 = Enter）
   - Terminal（ターミナル.app。D-243、ADR 0019 の Decision 8）: AppleScript で tty の一致するタブに `do script <文> in <タブ>`（文と Return をそのタブに入れる。動いているプログラムの入力に入る）。見つからなければ失敗（`send_failed`）。届け先が決まらない（tty が無い）ときは `not_found`
   - Ghostty（1.3 以降。D-244、ADR 0019 の Decision 9）: 「開く」と同じ目印（tty に OSC 7 で一時的なフォルダを書き、`working directory` がそれの端末）で端末を選び、AppleScript の `input text <文> to <端末>` の後に `send key "enter" to <端末>`。目印は送った後（失敗しても）元の cwd に戻す。目印の端末が 1 つに決まらない（0 個・複数）・AppleScript が応答しないときは送らずに `409 undeliverable`（応答しなければしばらく `unsupported` として扱う）。打ち切り・オートメーションの拒否は `send_failed`。届け先が決まらない（tty・cwd が無い）ときは `not_found`、AppleScript を切っている（`macos-applescript = false`）・1.3 より古いと分かれば `unsupported`（版は Info.plist、設定は `ghostty +show-config` の `macos-applescript` の行だけを見る。Apple Event は送らない）
   - Orca: `orca terminal send --terminal=<h> --text=<文> --enter --wait-submit 5 --json`。`accepted`（受理）と `stages` の `turn_started`（送信の観測）を分けて読む
   - 許可する: `1` と Enter を別々に（今後も許可の `2` は送らない）
   - 文は制御文字を除き、改行を送れない届け先では 1 行に畳む（改行を空白に）
4. 送った後 3 秒以内に記録が進んだか（待ちが閉じたか）を見る。Orca が送信を観測したときも確かめたとする
5. 4 で確かめられなかったときだけ、「開く」と同じ経路（`POST /api/open` の session）でタブを前に出す（対応中の印も付く。フォローアップの無い待ちはカードで開き、印は付かない）。確かめられたら前に出さない（`focus: null`。Turnlane の知らせが後ろに回らないように。web は知らせに「開く」を付ける。D-241）

```ts
interface AnswerResult {
  delivered: true;
  confirmed: boolean;
  via: "tmux" | "iterm" | "terminal" | "ghostty" | "orca";
  app: string;
  landing: string;              // 行に出す短い届け先（`Orca · タブ`）
  focus: OpenLanding | null;    // タブを前に出した着地（confirmed のときは前に出さないので null）
  message: string;              // `送りました · Orca · タブ` / `送りましたが進んだか確認できません · …`（デーモンの言語）
  folded: boolean;              // 1 行に畳んだ
}
```

- 答えの文は保存しない。ログは `answer.sent`（`chars`・`via`・`allow`・`confirmed`・`folded`）と、Ghostty に送れなかったときの `answer.undelivered`（`via`・`reason`）だけ

## 32. 自分の番の画面の「後で」（2026-10-23。[ux-mvp.md](ux-mvp.md) 4.6）

自分の番の画面の一覧の下に、いま対応しなくてよいが戻ってくるもの（スヌーズ中・明日へ・時間に置いた開始の前・リセット前の上限待ち）を「後で」の節として出す。帯・メニューバーの件数・通知・放置・MCP には入れない（今までどおり `items` の open なものだけを見る）。

- **スヌーズ中・明日へ**: 今までどおり `items` に `followUps[].status: "snoozed"` と `snoozeUntil`・`taskDate` で入っている（open なフォローアップの無いカード）。明日へは `taskDate` が今日より後のもの
- **時間に置いた自分の番**（2026-10-26）: `items` のフォローアップのうち DB の状態が open で、タスクの時間ブロック（消していないもの）を作った時刻から開始までの間にあるもの（待ちの集計外 `scheduled` と同じ区間。重なる区間はつなげる。core の `derive.scheduledUntil`）は、読み取りの時刻で `status: "scheduled"` と `scheduledAt`（帯に戻る時刻 = 区間の終わり）にして返す。DB は open のまま。`visibleQueue`（帯・件数・通知・MCP）は open だけを見るので外れる。開始が来たら open に戻る。デーモンの通知の判定（NotifyRunner）は開始の時刻に判定を回し、scheduled から外れたフォローアップの id で SSE の `follow_up` を流す（画面・メニューバーが取り直す。通知は新しく開いたフォローアップとして 1 回）。スヌーズ中のものはスヌーズのまま（scheduled にしない）
- **リセット前の上限待ち**: `GET /api/queue` に `limitWaits?: QueueItem[]` を足す。カードが `done`・理由 `rate_limit` で上限待ちがまだ明けていないもの（`derive.limitWaitOf`）。`followUps: []`、`limitWait: { since, until, untilKnown }`（`untilKnown` が false なら until は停止から 5 時間の目安）、明ける早い順。open / snoozed のフォローアップのあるカードと、その停止の「再開できる」（`<turn>:limit`）を利用者が対応不要で閉じたカード（`dismissed`。`POST /api/work-items/:id/dismiss-limit` が先に作る行も同じ）は入れない。自動で閉じた行（`auto:*`。明ける時刻が伸びて閉じた `auto:limit_extended`、旧版の `auto:next_turn_ok`）は除く理由にしない。until を過ぎると `limitWaits` から外れ、「再開できる」が `items` の普通の行になる
- web は core の `laterRows(items, limitWaits)` で後での行を作り（普通の行と同じカードは除く。戻る早い順）、`laterKind`（`snoozed` / `tomorrow` / `scheduled` / `limit`）と `laterBackAt`（スヌーズの終わり・`scheduledAt`・明ける時刻）で右端の時刻を出す。並びは種類を混ぜて戻る早い順
- 操作: 今やる = `POST /api/follow-ups/:id/wake`（スヌーズ中・明日へ・時間に置いた。時間に置いたものは開始の来ていない時間ブロックを消す）、開く = `POST /api/open`（フォローアップがあれば followUpId、上限待ちは workItemId）、対応不要 = `POST /api/follow-ups/:id/dismiss`（スヌーズ中・明日へ）/ `POST /api/work-items/:id/dismiss-limit`（上限待ち）
- 「再開できる」（`followUps[].limit: true`）は期限なし。`expiresAt` は null で、再開する（そのセッションの次のターン・Stop など）か対応不要まで残る

## 33. AI の画面（2026-10-23。[ux-mvp.md](ux-mvp.md) 4.19）

いま生きている AI 項目の全部を 1 画面に並べるための読み取りを 1 本足す。取り込みは足さない。帯・メニューバーの件数・通知・放置・MCP・CLI は変えない。

### 33.1 `GET /api/ai/live`

`{ items: LiveItem[] } & ReadMeta`（型は `packages/core/src/api/live.ts`）。次のどれかに当たる AI 項目（隠した項目・統合された項目は除く。最後の動きの新しい順）:

| 条件 | 判定 |
|---|---|
| running | `work_item.status` が running（ターンが開いている・サブエージェントだけが動いている） |
| プロセスが生きている（Claude Code） | その項目のセッション（最後のターンの項目に付ける。サブエージェント・ノイズは除く）のどれかが `ai_session.live_status` busy / idle で、`live_checked_at` が 2 分以内（「開く」と同じ新しさ。`sessions/<pid>.json` を 5 秒ごとに見る） |
| プロセスの有無が分からない（Codex・Claude Desktop） | 最後に動いたセッションの取り込み元に探索が無く、最後の動きから 6 時間以内（`process: "unknown"`。画面は推定の印を付ける） |
| 片付けが残っている | セッションに紐づいた依頼（`ai_launch` の started / linked）で、worktree が残っているか `turnlane ai run` がまだ動いている（完了のシートの `finish-plan` と同じ判定。同じ項目に複数あれば新しい依頼） |

```ts
interface LiveItem {
  id; title; titleSource; status; reason; estimated; sources; repoRoot; scratch?; branch; prRef;  // AiItemSummary と同じ値
  userTitled?: boolean;
  lastActivityAt: EpochMs;
  runStartedAt: EpochMs | null;      // running のとき、今のひと続きの作業の始まり（間が 30 分未満のターンをつなぐ）
  process: "alive" | "gone" | "unknown";
  liveSessions: number;              // プロセスが生きているセッションの数（2 以上で「2 セッション」）
  subagentsRunning: number;          // 今も動いているサブエージェント（終わっておらず最後の活動から 5 分以内）
  launch: {                          // 片付けが残っている依頼（無ければ null）
    launchId; taskId; taskDone: boolean; aiRunning: boolean;
    worktree: { path; branch; state: "clean" | "unmerged" | "dirty" } | null;
  } | null;
  wait?: OpenWaitBrief;              // 答える対象の待ち（queue の item と同じ判定）
}
```

- 自分の番・後で（`GET /api/queue` の `items`・`grace`・`limitWaits`）にある項目も、上の条件に当たれば返す。1 か所への振り分けは画面が core の `liveSections(queue, items, now)` で行う（自分の番 > 後で > 動いている > 止まっている > 片付け > プロセスが残っている。最後の動きが 24 時間より前でプロセスが残っているだけの項目は `stale` に入れ、止まっているには入れない。利用上限で止まった項目（done · rate_limit）は stale に入れない）
- 項目が done · rate_limit で上限待ちが明けていなければ `limitWait?: { since, until, untilKnown }` を添える。画面は札を「完了」にせず `利用上限 · 03:00 まで`（見込みなら `利用上限 · 見込み 03:00`、明ける時刻が無ければ `利用上限`）にする（core の `stoppedKind` が `limit`）
- 片付けの判定は `pgrep` と git を使うので、`/api/ai/check` と同じく 15 秒覚える（片付け・起動の状態が変われば捨てる）
- SSE の種類は足さない。web は `work_item`・`follow_up`・`task` で `["aiLive"]` を無効化し、30 秒ごとにも取り直す（片付けの覚え・6 時間の境目）
- 片付けの節の操作は既存の `GET /api/ai/finish-plan?taskIds=` と `POST /api/ai/launches/:id/finish`（片付けだけのシート。タスクの完了は呼ばない）。タスクが未完了なら今までの完了のシート

## 34. 最後の返答（Issue #8。2026-10-28。ADR 0019 の Decision 10）

AI の詳細パネルの「最後の返答」の節のために、読み取りを 1 本足す。取り込み・DB・SSE・MCP・通知・ボードの行・自分の番の帯は変えない。実装は `apps/daemon/src/glance/last-reply.ts`（読むだけ。ロガーを受け取らない）、記録からの取り出しは collectors の `claudeLastReply` / `codexLastReply`、伏せ字と切り詰めは core の `lastReplyOf`。

### 34.1 `GET /api/work-items/:id/last-reply`

`Cache-Control: no-store`。AI 項目が無ければ 404。

```ts
interface LastReplyResponse {
  workItemId: string;
  state: "ok" | "none" | "gone" | "unreadable" | "off";
  text?: string;       // AI の最後の発言（state が ok のときだけ）。伏せ字の後に 2,000 字で切る
  truncated?: boolean; // 切った（画面は「続きは端末で」と「開く」）
  masked?: boolean;    // 伏せ字を入れた
  readAt: EpochMs;
}
```

- 読むのは AI 項目の最後のターンのセッション（`sessionOf`）の記録の末尾（1 MB）。Claude Code はトランスクリプト（`findClaudeTranscript`）、Codex は rollout（DB の `file_path`。無ければ `archived_sessions/` の同じ名前。取り込み元のルートの外は読まない）
- `none`: 記録はあるが、そのターンに AI の発言がまだ無い（AI 項目にセッションが無いときも）。`gone`: 記録が無い・消えている。`unreadable`: 読めない。`off`: 設定「行に中身を出す」（`turn.show_detail`）がオフ（記録を読まない）
- **「最後」の境界**: パーサと同じターン（Claude Code は `origin.kind` が human / task-notification の user レコードで始まり、Codex は `task_started` と人の入力の `UserMessage`）の中で、最後のツール呼び出しより後の文のまとまりを「最後の返答」とする。Claude Code は assistant レコードの `text` ブロック（`thinking`・`tool_use` を除く）を集め、`tool_use` と `tool_result` で区切る。1 つのメッセージの text が別々のレコードに分かれていても、ツール呼び出しを挟まなければ同じまとまりとして改行 2 つでつなぐ。動作中で最後がツール呼び出し（結果待ち）なら、その前のまとまり。Codex は `item_completed` の `AgentMessage` の文を集めて `CommandExecution`・`FileChange`・`McpToolCall` などで区切る（無ければ `response_item` の assistant の message、それも無ければ `task_complete` の `last_agent_message`。同じ発言が複数の形で書かれるので形を混ぜない）。ターンに文がまだ無ければ `none`（前のターンの文は出さない）。自分の番の問いは、この規則で問いの文になる
- web はパネルを開いている間だけ取りに行き（キャッシュは閉じたら捨てる。`gcTime: 0`）、項目の状態・最後の活動が変わったら読み直す。「答える」の節が問いの全文を出している間（許可待ち以外）は節を出さない（同じ文を 2 回出さない）。文は小さな Markdown の描画器で出す（HTML は解釈しない、リンクは http(s) だけ、画像は読み込まない。「答える」の問いの全文も同じ）
