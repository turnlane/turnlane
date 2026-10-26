# Phase 0 実装計画

- 作成: 2026-10-02 / 状態: Phase 0 の実装仕様（正）
- 関連: [ai-session-ingestion.md](./ai-session-ingestion.md)、[ux-mvp.md](./ux-mvp.md)、[ADR 一覧](../adr/)
- 名称: プロダクト名 Turnlane、デーモン `turnlaned`、CLI `turnlane`、URL スキーム `turnlane://`、Turnlane から作る予定の書き先は Calendar.app の新規イベントのデフォルトカレンダー（D-072・D-093。タスクの時間ブロックはカレンダーに書かない）、bundle ID / LaunchAgent ラベルの接頭辞 `dev.turnlane.`（ドメイン turnlane.dev に合わせる。D-091。旧名からの変更は ADR 0016）
- CLI 名の選定理由: `turnlane` は2文字で打ちやすく、macOS 標準コマンドと Homebrew の formula / cask に同名が無い（2026-10 時点）
- Phase0 のゴール: **開発者本人が14日連続で使う**
- 配布方針: MIT ライセンスのオープンソース。作者が運用するサーバーを持たない（同期サーバー、アカウント、テレメトリ、Google Calendar API 直結は作らない。[ADR 0008](../adr/0008-mit-no-server-open-source.md)）。公開は Phase0 完了後で、その準備を M6（4.8）に置く
- 想定する開発環境: macOS 14 以降 / Apple Silicon、Bun 1.4 系（ADR 0007）、Swift 6 系、sqlite3、gh（任意）。Claude Code の設定ディレクトリは `CLAUDE_CONFIG_DIR` により複数ありうる（`~/.claude` と `~/.claude-*` など。別アカウント用のものを含め、検出したものは既定ですべて取り込む。ai-session-ingestion 6.1）

---

## 0. 結論（先に読む）

1. **構成**: Bun workspaces のモノレポにする。`apps/daemon`（turnlaned: Bun + Hono + bun:sqlite + Drizzle）、`apps/web`（React SPA。ビルド成果物はデーモンに埋め込んで配信）、`apps/cli`（turnlane: hook受け口、stdio MCP、タスク追加、launchd 管理）、`packages/core`（スキーマ、純粋関数の判定ロジック、日付、自然言語パーサ、日報）、`packages/collectors`（ソースアダプタとフィクスチャ。他の `@turnlane/*` に依存しない、独立パッケージとして切り出せる境界を保つ。3.1.1）、`native/calendar-helper`（Swift 製の EventKit ヘルパ）。ツールは Bun（実行・パッケージ管理・テスト・単一バイナリ化）、Biome（lint/format）、`tsc --noEmit`（型検査）、Vite（UI ビルド）に揃える。
2. **EventKit**: デーモンから直接は触らない。**`TurnlaneCalendarHelper.app`（LSUIElement の小さな Swift アプリ）を独立した LaunchAgent として常駐させ、デーモンへ WebSocket クライアントとして接続する**。カレンダー権限（TCC）はこのアプリの bundle ID に付く。Bun の子プロセスとして起動すると権限の帰属先が bun になってしまうため、この形にする。デスクトップアプリ（Tauri。D-055）を入れても、ヘルパは当面別のまま常駐させる。公開準備（M6）で `Turnlane.app` に同梱し `SMAppService` で登録して、利用者から見えるアプリを1つにする（必須。ヘルパは Swift のまま。ADR 0010 の決定 5、D-056 (5)、desktop-shell.md 9章）。
3. **DB**: SQLite（WAL）を正とする。ユーザーが作るデータ（task, time_block, project, daily_note, setting）には同期用カラム（UUIDv7, `hlc`, `deleted_at`, `device_id`, `sync_scope`）を付け、書き込みは必ず `mutate()` 層を通し、同じトランザクションで `change_log` に記録する。AI 取り込み系テーブルは `local_only` 固定とし、変更ログは書かない（書き込み量が多いため）。ORM は Drizzle（bun-sqlite ドライバ）。マイグレーションは前進のみで、適用前に自動で `VACUUM INTO` バックアップを取る。同期用カラムと `change_log` は残すが、同期サーバーは作らない（ADR 0008）。
4. **取り込みの冪等性**: カーソル（inode + 行境界のバイト位置 + パーサの継続状態）はイベント反映と**同じトランザクション**で保存する。イベントは「累積値」を運び、シンクは「代入（upsert）」だけを行い、加算はしない。この2点で、カーソルを巻き戻しても、ファイルを丸ごと読み直しても、結果が同じになる。
5. **判定ロジックは `packages/core/src/derive/` の純粋関数**（WorkItem のグルーピング、5状態の判定、フォローアップの「あるべき集合」の計算）に置き、デーモン側の runner が「事実の読み込み → 純粋関数 → 差分の書き込み → SSE 通知」を行う。シナリオテストは時計を差し替えて表で書く。
6. **工数見積は約49人日**。人日は「人が実装した場合の相対的な大きさ」で、着手の順序と削り順を決めるために使う。日程の約束ではなく、進捗はマイルストーンの完了で測る（4章の冒頭。D-042）。2026-10-03 の見直し（D-038〜D-041）で、カレンダーの読み取り（M3 の A）と稼働日・祝日の判定を常用開始の前に入れ、日報の AI 要約（M4-6）を Phase0 に入れて +2日。m2-api.md の見直し（D-047）で M2 に +0.5日。常用開始の最小範囲は 17.5人日（M2 の A、M3 の A、M4 の A、M5-1。4.9）。以下はそれ以前の経緯（スパイク3.5日を含む。S4 の結果で M0 に 1.5日、collectors のパッケージ境界の整備で M1 に 0.5日を追加。S2 の結果で M1-5 を 0.25日減らし、S3 の規則の調整で M1-7 に 0.25日を追加。U22 の決定（勤務時間と待ちの区分、返答タスクの閉じ方）で M1-8 に 0.25日、M1-9 に 1日、hooks の許可リストの移設（M1-14）で 0.25日を追加。前回の表記 35.5人日は内訳の和 39.5人日と合っていなかったので直した。確定デザインに合わせた M2〜M4 の見直しで +7日（4.9））。常用（14日カウント）は M2・M3・M4 のうち常用に必要な範囲（4.4・4.5・4.6 の段階 A）と M5-1 が終わった時点（4.9 のフェーズ3の終わり）から始め、デイビュー・時間ブロック・カレンダーへの書き戻し・朝の計画・日報の AI 要約は常用しながら入れる。遅れた場合の削り順も 4.9 に書いた。公開準備（M6、約8.5人日）は Phase0 のゴール達成後に行い、この合計には含めない。
7. **最初に着手するスパイク**: S4（Bun 基盤の確認、半日）を土台として最初に片付け、続けて **S3（実データでのターン分割と状態判定の精度）** と **S1（EventKit ヘルパの TCC が launchd 配下で通るか）** を行う。S3 はコア価値の成否、S1 は構成の成否を決める。S2（Codex SQLite の読み取り）は完了し、Phase0 の Codex 取り込みは rollout JSONL・`session_index.jsonl`・`archived_sessions/` だけにして SQLite は開かないことにした（[S2 レポート](../spikes/s2-codex-sqlite.md)）。
8. **外部からのタスク取り込み**: 外部サービスやスクリプトは、ローカルの MCP `add_task` / `turnlane add` / `POST /api/tasks` に `source`（外部サービスの識別子）と `external_id` を渡してタスクを入れる。`task(external_source, external_id)` の UNIQUE で冪等にし、同じものを何度送っても1件になる。ユーザーが削除したものは作り直さない。Turnlane から外部サービスの API を呼びに行く連携は作らない（ADR 0008）。

---

## 1. リポジトリ構成

### 1.1 モノレポ/ツールチェーンの比較

| 軸 | **Bun workspaces 単独（推奨）** | pnpm workspaces + Bun 実行 | pnpm + Turborepo + Node 22 |
|---|---|---|---|
| 開発速度 | ◎ インストール・テスト・バイナリ化が1コマンド体系 | ○ ツールが2系統になる | △ 設定量が多い。Phase0 規模では過剰 |
| 単一バイナリ配布 | ◎ `bun build --compile`（静的ファイル埋め込み可） | ◎ 同左 | △ Node SEA は手間が多い |
| SQLite | ◎ `bun:sqlite` 内蔵（ネイティブアドオン不要） | ◎ 同左 | ○ better-sqlite3（ネイティブビルドが要る） |
| 将来の Tauri 同居 | ○ Tauri CLI は bun からも使える | ◎ | ◎ |
| ロックイン | ○ 撤退時は Node + better-sqlite3 へ（Drizzle がドライバ差を吸収） | ○ | ◎ |

当初案は pnpm だったが、実行環境を Bun に決めた以上、パッケージ管理とテストも Bun に揃える方が速い。キャッシュ付きのタスクランナーは Phase0 の規模では不要で、ルートの `package.json` の scripts で足りる。

### 1.2 決定事項

| 項目 | 選定 | 補足 |
|---|---|---|
| ランタイム | **Bun 1.4 系**（`.mise.toml` と `package.json#packageManager` で固定。S4 は 1.4.2 で確認。ADR 0007） | `Bun.randomUUIDv7()`、`fs.watch` の recursive、`bun:sqlite` を使う。ファイル監視は `fs.watch` のみで、@parcel/watcher は使わない（S4: compile 後にネイティブモジュールの解決で落ち、`fs.watch` でも欠損 0、遅延も小さい） |
| パッケージ管理 | Bun workspaces（`workspaces: ["apps/*", "packages/*"]`） | 内部パッケージ名は `@turnlane/*` |
| lint / format | **Biome**（1ツールで lint と format） | ESLint + Prettier は使わない。import 整列も Biome |
| 型検査 | `tsc -b`（project references）を `bun run typecheck` で実行 | `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` を有効にする |
| テスト | `bun test`（core / collectors / daemon / cli）。UI は `bun test` + happy-dom で軽く、E2E は Playwright のスモーク1本（M5） | スナップショット（golden）は `toMatchSnapshot` |
| UI ビルド | Vite + React 19 + TanStack Router / Query + dnd-kit + Tailwind v4 + cmdk | 開発中は Vite dev server がデーモンへプロキシする |
| デーモン/CLI ビルド | `bun build --compile --minify --bytecode --format=esm --target=bun-darwin-arm64` で `turnlaned` と `turnlane` を単一バイナリにする（ADR 0007） | web の `dist/` はビルド時に生成するファイル一覧でデーモンバイナリに埋め込む（M0-9）。マイグレーション SQL も埋め込む（M0-8） |
| Swift | SwiftPM（`native/calendar-helper`）＋ `.app` を組み立てるシェルスクリプト | 署名は Apple Development 証明書（無ければ ad-hoc。後述の TCC 注意点あり） |
| CI | GitHub Actions `macos-latest`: biome check / typecheck / bun test / swift build | フィクスチャ回帰テストはここで回す |
| ログ | デーモンは JSON Lines を `~/Library/Logs/turnlane/turnlaned.log`（5MB × 5 世代で回転） | 本文を書かないよう、ログ関数の引数型を「メタデータのみ」に限定する |

### 1.3 ディレクトリツリー

```
turnlane/
├─ package.json                 # workspaces, scripts（dev, build, test, typecheck, lint, fixtures）
├─ bunfig.toml                  # test の preload（時計・TZ 固定）
├─ biome.json
├─ tsconfig.base.json
├─ .mise.toml                   # bun / swift のバージョン固定
├─ .github/workflows/ci.yml
├─ apps/
│  ├─ daemon/                   # turnlaned
│  │  ├─ src/
│  │  │  ├─ main.ts             # 起動: DB open → migrate → collectors → jobs → http
│  │  │  ├─ config.ts           # データディレクトリ、ポート、トークン
│  │  │  ├─ http/
│  │  │  │  ├─ app.ts           # Hono アプリ（AppType を export。web/cli が型を import）
│  │  │  │  ├─ auth.ts          # トークン/クッキー、Host・Origin 検証
│  │  │  │  ├─ sse.ts           # /api/events
│  │  │  │  ├─ routes/          # board, day, tasks, time-blocks, work-items, queue,
│  │  │  │  │                   # calendars, rituals, reports, sources, settings, search
│  │  │  │  └─ internal/ek.ts   # カレンダーヘルパ用 WebSocket
│  │  │  ├─ ingest/
│  │  │  │  ├─ supervisor.ts    # ソース検出、watch 登録、再走査
│  │  │  │  ├─ queue.ts         # ストリーム単位のデバウンスと直列化
│  │  │  │  ├─ sink.ts          # NormalizedEvent → upsert（+ カーソル保存）
│  │  │  │  ├─ enrich.ts        # repo_root / branch 補完（git、キャッシュ）
│  │  │  │  └─ health.ts        # 縮退レベル判定
│  │  │  ├─ derive/runner.ts    # core/derive を呼び、差分を書いて SSE 送出
│  │  │  ├─ followups/actions.ts# 外部を開く（resume コマンド、PR URL、フォルダ）
│  │  │  ├─ calendar/           # ヘルパとのプロトコル、窓同期、予定の作成・編集（D-093）
│  │  │  ├─ github/pr-poller.ts # gh CLI で PR 状態を取得（任意）
│  │  │  ├─ jobs/               # tick（60秒）、日付区切り、バックアップ、保持期間の削除
│  │  │  └─ launchd/            # plist の生成
│  │  ├─ test/
│  │  └─ package.json
│  ├─ web/                      # React SPA
│  │  ├─ src/
│  │  │  ├─ routes/             # board, day, queue, inbox, report, settings
│  │  │  ├─ features/           # week-board, right-rail, day-timeline, ai-card,
│  │  │  │                      # detail-panel, palette, rituals, notifications
│  │  │  ├─ lib/api.ts          # hono/client（hc<AppType>）
│  │  │  └─ lib/live.ts         # SSE → TanStack Query の invalidate
│  │  └─ package.json
│  └─ cli/                      # turnlane
│     ├─ src/
│     │  ├─ main.ts
│     │  ├─ commands/           # daemon, add, today, ai, queue, done, report,
│     │  │                      # hooks, sources, calendar, export, backup, doctor, stats
│     │  ├─ hook/               # turnlane hook（許可リスト抽出 → spool 追記）。import は node:fs と @turnlane/collectors/hook-allowlist だけ（ADR 0009）
│     │  ├─ hooks-install/      # claude settings.json / codex hooks.json の冪等編集
│     │  └─ mcp/server.ts       # stdio MCP（@modelcontextprotocol/sdk）
│     └─ package.json
├─ packages/
│  ├─ core/
│  │  ├─ src/
│  │  │  ├─ db/schema.ts        # Drizzle スキーマ（正）
│  │  │  ├─ db/migrations/      # drizzle-kit 生成 SQL + 手書き SQL（連番）
│  │  │  ├─ db/migrate.ts       # 埋め込み SQL の適用関数（事前バックアップ付き。Drizzle の migrate() は使わない）
│  │  │  ├─ db/mutate.ts        # 同期カラム付与 + change_log 記録
│  │  │  ├─ ids.ts / hlc.ts / clock.ts
│  │  │  ├─ dates.ts            # 日付区切り（既定 04:00）、local_date 変換
│  │  │  ├─ order.ts            # fractional indexing
│  │  │  ├─ derive/
│  │  │  │  ├─ grouping.ts      # ターン → WorkItem キー
│  │  │  │  ├─ status.ts        # 5状態の判定（優先順位つき）
│  │  │  │  ├─ followups.ts     # フォローアップのあるべき集合
│  │  │  │  ├─ presence.ts      # 在席（サンプル → 区間）・一日を閉じていた区間（3.3.1。D-105）
│  │  │  │  └─ time.ts          # AI / 待ち（猶予・放置・集計外・期限切れ）/ 自分 の時間計算（3.3.1）
│  │  │  ├─ hooks/              # hooks 設定ファイルの編集と点検（3.6.1。turnlane hooks と daemon の hooks_state が共用。M1 で apps/cli/src/hooks-install/ から移した）
│  │  │  ├─ settings.ts         # setting の既定値と読み出し
│  │  │  ├─ nlp/quick-add.ts    # 決定的な自然言語パーサ（日本語・英語）
│  │  │  ├─ report/daily.ts     # 日報 Markdown テンプレート
│  │  │  └─ types.ts            # ドメイン型 + Zod スキーマ（API 入出力）
│  │  └─ test/
│  └─ collectors/               # 独立パッケージとして切り出せる境界（3.1.1）。他の @turnlane/* に依存しない
│     ├─ package.json           # exports は "."、"./testing"、"./hook-allowlist"（ADR 0009）。Phase0 は private: true
│     ├─ README.md              # アダプタ作者向け（公開 IF、追加手順。公開時に英語化）
│     ├─ src/
│     │  ├─ index.ts            # 公開 IF の入口（ここから export したものだけが公開 IF）
│     │  ├─ types.ts            # SourceAdapter / NormalizedEvent / ADAPTER_API_VERSION
│     │  ├─ define.ts           # defineAdapter()（ToolId の書式と apiVersion の検査）
│     │  ├─ registry.ts         # 同梱アダプタの一覧（builtinAdapters）
│     │  ├─ allowlist.ts        # 許可リストによる抽出関数（キーの宣言は各アダプタ）
│     │  ├─ hook-allowlist.ts   # hooks の spool に残すキー（ツールごと）。import を持たない定数だけのモジュール。turnlane hook と各アダプタの HookSpec が使う（ADR 0009）
│     │  ├─ closing-question.ts # 締めの決まり文句の質問の判定（日本語・英語の表。本文はその場で捨てる。3.3.1）
│     │  ├─ logger.ts           # MetaOnlyLogger（本文を受け取れない型）
│     │  ├─ io.ts               # アダプタの読み取りの窓口（テストキットの withRootJail が差し替える）
│     │  ├─ reduce.ts           # NormalizedEvent をシンクと同じ規則で畳み込む（テストキット用）
│     │  ├─ readers/jsonl.ts    # 行境界・不完全行・切り詰め・inode 変化の処理
│     │  ├─ testing/            # テストキット（golden / 増分読み込み / 番兵）。"./testing" で公開
│     │  └─ adapters/
│     │     ├─ _template/       # 新しいアダプタの雛形（README の手順と対応）
│     │     ├─ claude-code/     # index, detect, transcript, live, hooks（hook ペイロードの許可リストと正規化）
│     │     ├─ codex/           # index, detect, rollout, session_index, hooks（SQLite は開かない。3.1）
│     │     ├─ claude-desktop/  # local_*.json（Phase0 は任意。M1 の余力枠）
│     │     └─ hook-spool/      # turnlane 固有。turnlane hook が書いた spool JSONL → 各アダプタの hooks.normalize
│     ├─ scripts/anonymize.ts   # 実データ → 匿名化フィクスチャ（5.2）
│     └─ test/
│        ├─ fixtures/<tool>/<toolVersion>/<case>/   # 匿名化済み。ルート配下の構造をそのまま写す
│        └─ __snapshots__/
├─ native/
│  └─ calendar-helper/
│     ├─ Package.swift
│     ├─ Sources/CalendarHelper/   # main.swift, EventStore.swift, Bridge.swift(WebSocket), Protocol.swift
│     ├─ Resources/Info.plist      # LSUIElement, NSCalendarsFullAccessUsageDescription
│     └─ scripts/build-app.sh      # swift build → .app 組み立て → codesign
├─ tools/
│  └─ dev/seed.ts               # 開発用ダミーデータ
└─ docs/
```

### 1.4 実行時の配置

| 物 | 場所 |
|---|---|
| バイナリ | `~/.local/bin/turnlaned`、`~/.local/bin/turnlane`（`turnlane self-install` がコピーする） |
| カレンダーヘルパ | `~/Applications/TurnlaneCalendarHelper.app` |
| データ | `~/Library/Application Support/turnlane/`（ディレクトリは 700、DB は 600） |
| ├ DB | `turnlane.db`（+ `-wal`, `-shm`） |
| ├ 認証トークン | `token`（600。CLI・ヘルパ・ブラウザ認証で共用） |
| ├ spool | `spool/hooks-YYYYMMDD.jsonl`、`spool/cli-YYYYMMDD.jsonl`（デーモン停止中の CLI 追加分） |
| └ バックアップ | `backups/turnlane-YYYYMMDD.db`（14世代） |
| LaunchAgent | `~/Library/LaunchAgents/dev.turnlane.daemon.plist`、`dev.turnlane.calendar-helper.plist`、`dev.turnlane.desktop.plist`（デスクトップアプリ。desktop-shell.md 6章） |
| UI | `http://127.0.0.1:7317/`（ポートは設定可） |

### 1.5 EventKit アクセスの実現方法

| 案 | 仕組み | TCC の帰属 | 変更通知 | 評価 |
|---|---|---|---|---|
| **A. ヘルパ `.app` を独立 LaunchAgent として常駐、デーモンへ WS 接続（推奨）** | Swift の LSUIElement アプリ。起動するとデーモンの `ws://127.0.0.1:7317/internal/ek` へ接続し、JSON-RPC で要求を受けて応答する | ヘルパの bundle ID に付く（launchd 直下で起動するので責任プロセスが自分自身になる） | `EKEventStoreChanged` をそのまま push できる | Swift 側に HTTP サーバを書かなくて済む（`URLSessionWebSocketTask` のクライアントだけ）。デスクトップアプリとは別のまま。M6 で `Turnlane.app` に同梱して1つのアプリにする（ADR 0010、D-056 (5)） |
| B. Swift CLI をデーモンが都度 spawn | `ekhelper list --from --to` が JSON を stdout に出す | **親（bun）に帰属する**可能性が高い。署名のない bun に権限を与えることになり、更新のたびに失われる | 都度ポーリング | 実装は最小だが、TCC で詰まるリスクが高い |
| C. AppleScript / JXA で Calendar.app を操作 | `osascript` | 自動化権限（Calendar.app の起動が必要） | なし | 遅く、繰り返し予定の扱いが弱い。不採用 |
| D. 既存 OSS（icalBuddy 等） | 読み取りのみの CLI | B と同じ | なし | 書き込みができない。不採用 |

**ヘルパの仕様（Phase0）**

- Info.plist: `CFBundleIdentifier=dev.turnlane.calendar-helper`、`LSUIElement=true`、`NSCalendarsFullAccessUsageDescription`（macOS 14 以降の Full Access 文言）。
- 起動: LaunchAgent（`KeepAlive=true`）。初回の許可だけは `open ~/Applications/TurnlaneCalendarHelper.app --args --authorize` で前面に出してダイアログを表示する（`turnlane calendar authorize` がこれを呼ぶ）。
- 認証: 起動時に `token` ファイルを読み、WS 接続時の `Authorization` ヘッダに付ける。
- 再接続: 指数バックオフ（1s → 30s）。デーモンが再起動しても自動で戻る。
- プロトコル（JSON-RPC 2.0、1メッセージ1JSON）:

| method（デーモン → ヘルパ） | params | result |
|---|---|---|
| `status` | — | `{ authorization: "fullAccess"|"denied"|"notDetermined"|"writeOnly", version }` |
| `listCalendars` | — | `[{ id, title, sourceTitle, sourceType, colorHex, allowsModify, type, isDefault }]`（`isDefault` は Calendar.app の新規イベントのデフォルトカレンダー（`defaultCalendarForNewEvents`）。0.3.0 から。D-072） |
| `fetchEvents` | `{ calendarIds, from, to }`（epoch ms） | `[{ calendarId, externalId, eventId, occurrenceStart, title, location, start, end, tz, allDay, startDate, endDate, status, availability, selfResponse, url, conferenceUrl, lastModified, hasAttendees, recurring }]`（`calendarId` はどのカレンダーの予定か、`startDate` / `endDate` は終日予定の Mac のカレンダー上の日付で終わりを含まない。M3-1 の実装で足した。`hasAttendees`（`attendees` が空でない）と `recurring`（`hasRecurrenceRules`）は 0.4.0 から。D-093。`hasMeetingLink`（URL・場所・メモに会議サービスの URL がある。メモの本文は返さない）は 0.5.0 から。D-097） |
| `createEvent` | `{ calendarId?, title, start, end, tz, url: "turnlane://event/<uuid>" }` | 作った予定（`fetchEvents` の1件の形）。`calendarId` を省くと、その時点の Calendar.app のデフォルトカレンダー（D-072 の解決）。無ければ `no_default_calendar`、書き込めなければ `not_writable`。0.4.0、D-093 |
| `updateEvent` | `{ eventId, title?, start?, end?, calendarId? }` | 更新した予定（`fetchEvents` の1件の形）。編集できる予定（下の条件）だけ。満たさなければ `not_editable`、見つからなければ `not_found`、移す先のカレンダーに書き込めなければ `not_writable`。0.4.0 |
| `removeEvent` | `{ eventId }` | `{ deleted: boolean }`（見つからなければ false。編集できる予定だけを消す。満たさなければ `not_editable`）。0.4.0 |
| `listTimeblockEvents` | `{ from, to }`（epoch ms） | `[{ eventId, calendarId, start, end }]`。全カレンダーのうち `url` が `dayline://timeblock/` で始まる予定だけ（`url` の無い予定・他の目印は含めない）。0.4.0 |
| `deleteTimeblockEvent` | `{ eventId }` | `{ deleted: boolean }`。`url` が `dayline://timeblock/` で始まる予定だけを消す（それ以外・`url` の無い予定は `not_timeblock_event`）。0.4.0 |

- 編集できる予定（ヘルパとデーモンの両方で確かめる。D-093）: カレンダーが書き込める（`allowsContentModifications`）、参加者がいない（`attendees` が空）、繰り返しでない、終日でない、`url` が `dayline://timeblock/` で始まらない。満たさない予定の `updateEvent` / `removeEvent` は `not_editable`（`message` は短いコード）
- 0.3.0 までの `upsertEvent` / `deleteEvent` / `listSources` / `createCalendar`（M3-3 の時間ブロックの書き戻し）は 0.4.0 で外した（D-093）

| notification（ヘルパ → デーモン） | 内容 |
|---|---|
| `storeChanged` | `EKEventStoreChanged` を受けた（デーモンは窓を取り直す） |
| `authorizationChanged` | 権限の変化 |

- 権限の確かめ直し（D-130、0.7.0）: 常駐のヘルパは権限を 30 秒ごと・`storeChanged`・`status` の要求のたびに確かめ直し、変われば `EKEventStore` を作り直して `authorizationChanged` を送る。フルアクセスでないあいだは自分の実行ファイルを `--auth-status` で起動して別のプロセスで読み直し（プロセスの中の値は、別のプロセスで許可されても古いまま残ることがある。2026-10-08 の実機）、食い違えば終了コード 75 で終わり、launchd（`KeepAlive`）が起こし直す（起動から 60 秒未満なら起こし直さない）。`turnlane calendar authorize` も、フルアクセスになったら常駐のヘルパを `launchctl kickstart -k` で起こし直し、つながるのを待って同期を1回走らせる

- 目印: EventKit には extendedProperties が無いので `event.url` を使う。Turnlane が作った予定は `turnlane://event/<uuid>`（D-093。取り込み時に `is_own_event=1`）。M3-3 で書いた時間ブロックの予定は `dayline://timeblock/<time_block.id>`（D-093 で書くのをやめた。残っているものは取り込み時に `is_own_timeblock=1` とし、予定レーン・busy に出さない。利用者が確認して削除する）。
- 書き込み先カレンダー: Turnlane から作る予定は **Calendar.app の「新規イベントのデフォルトカレンダー」**へ書く（準備は要らない。D-072・D-093、ADR 0012）。作った後に詳細パネルで書き込める別のカレンダーへ移せる。
- 署名: ad-hoc 署名はビルドのたびに識別子が変わり、TCC の許可が外れることがある。Apple Development 証明書（無料の個人チームで可）で署名する。S1 で確認する。

---

## 2. DB スキーマ

### 2.1 ORM / クエリビルダの比較

| 軸 | **Drizzle ORM（推奨）** | Kysely | 生 SQL（bun:sqlite のみ） |
|---|---|---|---|
| 型安全 | ◎ スキーマから型を生成 | ◎（型は手書きか codegen） | △ 手書き |
| マイグレーション | ◎ drizzle-kit が SQL を生成。手書き SQL も混ぜられる | △ 自前で書く | △ 自前 |
| bun:sqlite 対応 | ◎ 公式ドライバ | ○ 方言アダプタ | ◎ |
| ~~Workers / DO（Phase1 同期サーバ）への再利用~~ | 同期サーバーは作らないため評価軸から外す（ADR 0008） | — | — |
| 複雑クエリ | ○ `sql` テンプレートで逃げられる | ◎ | ◎ |

方針: **Drizzle の TS スキーマ（`packages/core/src/db/schema.ts`）を正**とし、`drizzle-kit generate` が出す SQL をコミットする。ビュー・部分インデックスなど生成器が苦手なものは手書きの SQL マイグレーションで足す。集計系の重いクエリは `sql` テンプレートで生 SQL を書く。

### 2.2 共通方針

- 主キーは全テーブル `id TEXT`（UUIDv7）。例外は `setting(key)`、`ingest_cursor`（複合キー）、`change_log(seq)`。
- 時刻は UTC の epoch ms（INTEGER）。「どの日に計上するか」は `YYYY-MM-DD` の論理日付（日付区切り適用後。既定 04:00）で持つ。画面の列・縦軸・「今日」の列は暦どおり 0:00 で区切る（D-054。ux-mvp 4.4.1）。論理日付を使うのは集計と儀式（待ち区間と放置、日報、シャットダウン、朝の計画、持ち越し、14日カウント、ヘッダの集計値）。
- **同期カラム**（同期対象になりうるテーブル）: `created_at, updated_at, hlc, device_id, deleted_at, sync_scope`。同期サーバーは作らない（ADR 0008）。列と `change_log` は、将来ユーザー自身のストレージ経由で複数端末に対応する場合に備えて残す。Phase0 で同期処理は実装しない。
  - HLC の文字列形式: `<物理時刻ms 13桁ゼロ埋め>:<カウンタ 4桁16進>:<device_id 先頭8文字>`。文字列比較でそのまま大小が決まる。
  - LWW の単位: Phase0 は行単位の `hlc`。`change_log.patch_json` には変更したフィールドだけを入れる（将来フィールド単位 LWW に上げる場合も、ログから再構成できる）。
- **AI 取り込み系**（`ai_*`、`ingest_cursor`、`hook_event`、`calendar_event`）は `local_only` 固定とし、`hlc` と change_log を持たない。`work_item` と `follow_up` は `local_only` を既定としつつ、将来メタデータを opt-in で端末間共有する可能性があるので同期カラムを持たせる（変更ログは `sync_scope='synced'` の行だけ書く）。
- 削除: 同期対象テーブルは論理削除（`deleted_at`）。取り込み系は物理削除してよい（保持期間ジョブ）。
- 接続時の PRAGMA（マイグレーションではなく毎回の open 時）: `journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=5000`、`temp_store=MEMORY`。

### 2.3 DDL（0001_init.sql として使える形）

```sql
-- ============================================================
-- 0001_init.sql  turnlane Phase0 初期スキーマ
-- ============================================================

-- ---------- 端末・設定 ----------
CREATE TABLE device (
  id          TEXT PRIMARY KEY,                       -- UUIDv7
  name        TEXT NOT NULL,
  is_self     INTEGER NOT NULL DEFAULT 0 CHECK (is_self IN (0, 1)),
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX device_self_uq ON device(is_self) WHERE is_self = 1;

CREATE TABLE setting (
  key         TEXT PRIMARY KEY,                       -- 例 'day_boundary', 'followup.kinds'
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  hlc         TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  sync_scope  TEXT NOT NULL DEFAULT 'local_only' CHECK (sync_scope IN ('synced', 'local_only'))
);

-- ---------- プロジェクト ----------
CREATE TABLE project (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  color            TEXT,
  repo_paths_json  TEXT NOT NULL DEFAULT '[]',         -- AI セッションの自動振り分け（repo_root の前方一致）
  archived_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  hlc              TEXT NOT NULL,
  device_id        TEXT NOT NULL,
  deleted_at       INTEGER,
  sync_scope       TEXT NOT NULL DEFAULT 'synced' CHECK (sync_scope IN ('synced', 'local_only')),
  worktree_default INTEGER,                            -- AI に頼むときの worktree の既定（NULL = git のリポジトリなら使う。D-110 (5)。0010）
  worktree_copy_globs_json TEXT NOT NULL DEFAULT '[]', -- worktree にコピーする追跡外のファイル（glob。既定は空。0010）
  test_command     TEXT                                -- 確認支援のテストのコマンド（空なら出さない。D-109。0010）
);
CREATE UNIQUE INDEX project_name_uq ON project(name) WHERE deleted_at IS NULL;

-- ---------- タスク（手入力・CLI・MCP・AI由来の「自分の番」すべて） ----------
CREATE TABLE task (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  notes_md        TEXT,
  status          TEXT NOT NULL DEFAULT 'todo'
                  CHECK (status IN ('todo', 'doing', 'done', 'canceled', 'someday')),
  scheduled_date  TEXT,                                -- 'YYYY-MM-DD'（論理日付）。NULL = Inbox
  lane_order      TEXT NOT NULL,                       -- fractional index（同じ日付内の並び）
  due_date        TEXT,
  estimate_min    INTEGER CHECK (estimate_min IS NULL OR estimate_min >= 0),
  priority        INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  project_id      TEXT REFERENCES project(id),
  source          TEXT NOT NULL CHECK (source IN ('manual', 'cli', 'mcp', 'ai', 'calendar')),  -- 入ってきた経路
  source_ref      TEXT,                                -- mcp: 'mcp:<client>:<cwd>' / ai: 'follow_up:<id>' / calendar: 'event:<id>'
  -- 外部サービス由来のタスクの出所（MCP add_task / turnlane add / POST /api/tasks の source・external_id）。冪等キー
  external_source TEXT CHECK (external_source IS NULL OR
                    (length(external_source) BETWEEN 1 AND 64 AND external_source NOT GLOB '*[^a-z0-9._-]*')),
                                                       -- 呼び出し側が名乗る識別子（例 'github', 'linear', 'my-script'）
  external_id     TEXT CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 256),
  external_url    TEXT,                                -- 外部の該当ページ（任意。詳細パネルのリンク）
  rollover_count  INTEGER NOT NULL DEFAULT 0,
  is_highlight    INTEGER NOT NULL DEFAULT 0 CHECK (is_highlight IN (0, 1)),
  started_at      INTEGER,
  completed_at    INTEGER,
  auto_completed  INTEGER NOT NULL DEFAULT 0 CHECK (auto_completed IN (0, 1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  hlc             TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  deleted_at      INTEGER,
  sync_scope      TEXT NOT NULL DEFAULT 'synced' CHECK (sync_scope IN ('synced', 'local_only')),
  -- 自動生成の題名（D-046）。文字列で保存せず、種類とパラメータを保存して表示時に i18n で組み立てる。
  -- 自動生成のタスク（source='ai'）は title を '' にする。人が題名を付け直したら title に入れて title_key を NULL にする
  title_key       TEXT,                                -- 'followup.reply' / 'followup.approve' / 'followup.review_pr' / 'followup.resume_error' / 'followup.check_changes'。NULL なら title をそのまま出す
  title_params    TEXT,                                -- JSON。{"title": AI のタイトル, "repo": リポジトリ名, "branch": ブランチ, "pr": PR 番号, "prTitle": PR のタイトル}（無いものは null）
  CHECK ((external_source IS NULL) = (external_id IS NULL))
);
-- 論理削除した行も含めて一意にする（ユーザーが消したタスクを同じ external_id で作り直さないため）
CREATE UNIQUE INDEX task_external_uq ON task(external_source, external_id) WHERE external_source IS NOT NULL;
CREATE INDEX task_lane_idx    ON task(scheduled_date, lane_order) WHERE deleted_at IS NULL;
CREATE INDEX task_inbox_idx   ON task(created_at)
  WHERE scheduled_date IS NULL AND deleted_at IS NULL AND status IN ('todo', 'doing');
CREATE INDEX task_project_idx ON task(project_id) WHERE deleted_at IS NULL;
CREATE INDEX task_done_idx    ON task(completed_at) WHERE completed_at IS NOT NULL;

-- 実績時間（ワンタップの開始/完了、自分の番の自動推定）
CREATE TABLE task_time_entry (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES task(id),
  start_at    INTEGER NOT NULL,
  end_at      INTEGER,
  source      TEXT NOT NULL CHECK (source IN ('tap', 'followup_estimate', 'timeblock_assumed')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  hlc         TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  deleted_at  INTEGER,
  sync_scope  TEXT NOT NULL DEFAULT 'synced' CHECK (sync_scope IN ('synced', 'local_only')),
  CHECK (end_at IS NULL OR end_at >= start_at)
);
CREATE INDEX tte_task_idx  ON task_time_entry(task_id) WHERE deleted_at IS NULL;
CREATE INDEX tte_start_idx ON task_time_entry(start_at) WHERE deleted_at IS NULL;

-- ---------- カレンダー ----------
CREATE TABLE calendar (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL DEFAULT 'eventkit' CHECK (provider IN ('eventkit')),  -- Google API 直結はやらない（ADR 0008）
  external_id     TEXT NOT NULL,                       -- EKCalendar.calendarIdentifier
  account_name    TEXT,                                -- EKSource.title（例: Google のアカウント表示名）
  name            TEXT NOT NULL,
  color           TEXT,
  is_writable     INTEGER NOT NULL DEFAULT 0 CHECK (is_writable IN (0, 1)),
  role            TEXT NOT NULL DEFAULT 'source' CHECK (role IN ('source', 'writeback', 'ignored')),  -- writeback は D-093 で使わない（0007 で ignored に）
  last_synced_at  INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  color_key       TEXT                                  -- Turnlane の中だけで選んだ色（D-125。パレットのキー。NULL ならカレンダーアプリの色 color）。カレンダー側は書き換えない（0011）
);
CREATE UNIQUE INDEX calendar_ext_uq       ON calendar(provider, external_id);
CREATE UNIQUE INDEX calendar_writeback_uq ON calendar(role) WHERE role = 'writeback';

CREATE TABLE calendar_event (                          -- キャッシュ（local_only）
  id                TEXT PRIMARY KEY,
  calendar_id       TEXT NOT NULL REFERENCES calendar(id) ON DELETE CASCADE,
  external_id       TEXT NOT NULL,                     -- calendarItemExternalIdentifier（無ければ eventIdentifier）
  occurrence_start  INTEGER NOT NULL,                  -- 繰り返し予定の各回を区別
  title             TEXT,
  location          TEXT,
  start_at          INTEGER NOT NULL,
  end_at            INTEGER NOT NULL,
  tz                TEXT,
  all_day           INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
  start_date        TEXT,                              -- 終日予定用 'YYYY-MM-DD'
  end_date          TEXT,
  status            TEXT CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
  availability      TEXT CHECK (availability IN ('busy', 'free', 'tentative', 'unavailable')),
  self_response     TEXT CHECK (self_response IN ('accepted', 'declined', 'tentative', 'pending', 'unknown')),
  conference_url    TEXT,
  ext_updated_at    INTEGER,
  is_own_timeblock  INTEGER NOT NULL DEFAULT 0 CHECK (is_own_timeblock IN (0, 1)),
  fetched_at        INTEGER NOT NULL,
  own_timeblock_id  TEXT,                              -- 書き戻した予定の time_block.id（url の目印から。外部キーは張らない。M3-3、0005）
  event_id          TEXT,                              -- EKEvent.eventIdentifier（予定の更新・削除に使う。0007、D-093）
  has_attendees     INTEGER,                           -- 1 = 参加者あり。NULL = 分からない（0.4.0 より前のヘルパ）。0007
  recurring         INTEGER,                           -- 1 = 繰り返しの予定の各回。0007
  is_own_event      INTEGER NOT NULL DEFAULT 0,        -- 1 = url が turnlane://event/ の予定（turnlane で作った）。0007
  has_meeting_link  INTEGER                            -- 1 = 会議リンクがある（集中モードの対象。D-097）。NULL = まだ分からない。0008
);
CREATE UNIQUE INDEX cal_event_uq        ON calendar_event(calendar_id, external_id, occurrence_start);
CREATE INDEX        cal_event_range_idx ON calendar_event(start_at, end_at);

-- ---------- 時間ブロック ----------
CREATE TABLE time_block (
  id                     TEXT PRIMARY KEY,
  task_id                TEXT REFERENCES task(id),     -- NULL = タスクなしのブロック（集中時間など）
  title                  TEXT,                         -- NULL ならタスク名
  start_at               INTEGER NOT NULL,
  end_at                 INTEGER NOT NULL,
  tz                     TEXT NOT NULL,
  writeback_provider     TEXT CHECK (writeback_provider IN ('eventkit')),  -- writeback_* と external_* は D-093 で使わない（列は残す）
  writeback_calendar_id  TEXT REFERENCES calendar(id),
  external_event_id      TEXT,                         -- EKEvent.eventIdentifier
  external_updated_at    INTEGER,                      -- 外部側の lastModified（競合検出）
  writeback_state        TEXT NOT NULL DEFAULT 'pending'  -- disabled = 書き戻しを始める前に終わったので書かない（D-073）
                         CHECK (writeback_state IN ('pending', 'synced', 'conflict', 'error', 'disabled')),
  writeback_error        TEXT,
  writeback_attempts     INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  hlc                    TEXT NOT NULL,
  device_id              TEXT NOT NULL,
  deleted_at             INTEGER,                      -- 削除時も pending にし、外部削除後に synced
  sync_scope             TEXT NOT NULL DEFAULT 'synced' CHECK (sync_scope IN ('synced', 'local_only')),
  CHECK (end_at > start_at)
);
CREATE INDEX time_block_range_idx ON time_block(start_at, end_at) WHERE deleted_at IS NULL;
CREATE INDEX time_block_task_idx  ON time_block(task_id);
CREATE INDEX time_block_wb_idx    ON time_block(writeback_state)
  WHERE writeback_state IN ('pending', 'error');

-- ---------- AI 取り込み元 ----------
CREATE TABLE ai_source (
  id                  TEXT PRIMARY KEY,
  tool                TEXT NOT NULL CHECK (length(tool) BETWEEN 2 AND 32 AND tool GLOB '[a-z]*' AND tool NOT GLOB '*[^a-z0-9_]*'),
                                                       -- アダプタの ToolId（3.1）。新しいアダプタでマイグレーションが要らないよう列挙しない
  root_path           TEXT NOT NULL,                   -- 例 ~/.claude（絶対パスで保存。~ は展開する）
  profile_label       TEXT,                            -- 表示用ラベル。既定はディレクトリ名から導出（例 'default'）。ユーザーが変更可
  enabled             INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),  -- 検出したものは名前に関係なく既定で 1。プロファイル単位の除外は 0 にする
  hooks_state         TEXT NOT NULL DEFAULT 'none'
                      CHECK (hooks_state IN ('none', 'installed', 'pending_trust', 'receiving', 'silent')),
  include_globs_json  TEXT NOT NULL DEFAULT '[]',      -- cwd に対する包含パターン
  exclude_globs_json  TEXT NOT NULL DEFAULT '[]',      -- cwd に対する除外パターン（会社リポジトリ等）
  health_level        TEXT NOT NULL DEFAULT 'L0' CHECK (health_level IN ('L0', 'L1', 'L2', 'L3')),
  health_reason       TEXT,
  detected_version    TEXT,                            -- 直近に見たツールのバージョン
  last_ingest_at      INTEGER,
  last_hook_at        INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX ai_source_uq ON ai_source(tool, root_path);

CREATE TABLE ingest_cursor (
  source_id         TEXT NOT NULL REFERENCES ai_source(id) ON DELETE CASCADE,
  stream_key        TEXT NOT NULL,                     -- root からの相対パス（'sqlite:...' は将来用。Phase0 は SQLite を読まない）
  kind              TEXT NOT NULL CHECK (kind IN ('jsonl', 'json_snapshot', 'sqlite')),  -- 'sqlite' は将来用に残す
  dev               INTEGER,
  inode             INTEGER,
  size              INTEGER,
  mtime_ms          INTEGER,
  byte_offset       INTEGER NOT NULL DEFAULT 0,        -- jsonl: 処理済みの行境界
  watermark         TEXT,                              -- sqlite: updated_at_ms 等 / json: 内容ハッシュ
  carry_state_json  TEXT,                              -- パーサの継続状態（開いているターン、未回答の質問 等）
  parser_id         TEXT NOT NULL,
  parser_version    INTEGER NOT NULL,
  records_ok        INTEGER NOT NULL DEFAULT 0,
  records_skipped   INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (source_id, stream_key)
);

-- ---------- WorkItem（AIカード） ----------
CREATE TABLE work_item (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT REFERENCES project(id),
  group_key          TEXT NOT NULL,                    -- 'branch:<repo_root>#<branch>' / 'branch:<repo_root>#<branch>#pr<n>' / 'session:<tool>:<id>' / 'scheduled:<id>'
  repo_root          TEXT,
  branch             TEXT,
  pr_ref             TEXT,                             -- 'owner/repo#123'
  title_auto         TEXT,
  title_source       TEXT CHECK (title_source IN ('pr', 'ai_title', 'thread_name', 'desktop_title', 'branch', 'session_name', 'repo')),
  title_user         TEXT,
  status             TEXT NOT NULL CHECK (status IN ('running', 'needs_input', 'your_turn', 'done', 'error')),
  status_reason      TEXT,                             -- 判定根拠（'hook:permission_request' 等。UI の「推定」表示に使う）
  status_estimated   INTEGER NOT NULL DEFAULT 0 CHECK (status_estimated IN (0, 1)),
  status_changed_at  INTEGER NOT NULL,
  manual_done_at     INTEGER,                          -- ユーザーが「完了にする」。新しいターンが来たら解除
  merged_into_id     TEXT REFERENCES work_item(id),    -- ユーザーによる統合
  hidden_at          INTEGER,
  tools_json         TEXT NOT NULL DEFAULT '[]',       -- ['claude_code','codex']
  first_activity_at  INTEGER NOT NULL,
  last_activity_at   INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  hlc                TEXT NOT NULL,
  device_id          TEXT NOT NULL,
  deleted_at         INTEGER,
  sync_scope         TEXT NOT NULL DEFAULT 'local_only' CHECK (sync_scope IN ('synced', 'local_only')),
  scratch            INTEGER NOT NULL DEFAULT 0        -- 壁打ち（プロジェクトに属さない会話）のカード。runner が作業フォルダから決める（0012、D-135）
);
CREATE UNIQUE INDEX work_item_key_uq     ON work_item(group_key) WHERE deleted_at IS NULL;
CREATE INDEX        work_item_open_idx   ON work_item(status, last_activity_at)
  WHERE deleted_at IS NULL AND status <> 'done';
CREATE INDEX        work_item_recent_idx ON work_item(last_activity_at);

CREATE TABLE work_item_status_log (                    -- 「待ち」時間の計算と朝の「夜間の変化」に使う
  id            TEXT PRIMARY KEY,
  work_item_id  TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('running', 'needs_input', 'your_turn', 'done', 'error')),
  from_at       INTEGER NOT NULL,
  to_at         INTEGER,                               -- NULL = 現在の状態
  reason        TEXT
);
CREATE INDEX wisl_item_idx ON work_item_status_log(work_item_id, from_at);
CREATE INDEX wisl_open_idx ON work_item_status_log(work_item_id) WHERE to_at IS NULL;

-- ---------- AI セッション / ターン / 成果物（local_only） ----------
CREATE TABLE ai_session (
  id                     TEXT PRIMARY KEY,
  source_id              TEXT NOT NULL REFERENCES ai_source(id),
  tool                   TEXT NOT NULL CHECK (length(tool) BETWEEN 2 AND 32 AND tool NOT GLOB '*[^a-z0-9_]*'),  -- ToolId
  external_id            TEXT NOT NULL,                -- sessionId / thread id
  parent_session_id      TEXT REFERENCES ai_session(id),
  is_subagent            INTEGER NOT NULL DEFAULT 0 CHECK (is_subagent IN (0, 1)),
  entrypoint             TEXT,                         -- 'cli' / 'claude-desktop' / 'codex-tui' / 'Codex Desktop'
  client_version         TEXT,
  model                  TEXT,
  cwd                    TEXT,
  repo_root              TEXT,
  title                  TEXT,                         -- ツール生成の要約（プライバシーモードでは NULL）
  title_source           TEXT,
  started_at             INTEGER NOT NULL,
  last_activity_at       INTEGER NOT NULL,
  ended_at               INTEGER,                         -- サブエージェント: トランスクリプトが最後の応答（end_turn）で終わった時刻（後に活動があれば NULL）
  live_status            TEXT CHECK (live_status IN ('busy', 'idle', 'gone')),
  live_pid               INTEGER,
  live_checked_at        INTEGER,
  archived               INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  has_human_input        INTEGER NOT NULL DEFAULT 0 CHECK (has_human_input IN (0, 1)),
  is_noise               INTEGER NOT NULL DEFAULT 0 CHECK (is_noise IN (0, 1)),
  file_path              TEXT,
  transcript_missing_at  INTEGER,                      -- 元ファイルの消失（30日削除）を検知した時刻
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE UNIQUE INDEX ai_session_uq          ON ai_session(tool, external_id);
CREATE INDEX        ai_session_repo_idx    ON ai_session(repo_root);
CREATE INDEX        ai_session_recent_idx  ON ai_session(last_activity_at);
CREATE INDEX        ai_session_parent_idx  ON ai_session(parent_session_id) WHERE parent_session_id IS NOT NULL;

CREATE TABLE ai_turn (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES ai_session(id) ON DELETE CASCADE,
  turn_key            TEXT NOT NULL,                   -- Claude: promptId か人間入力レコードの uuid / Codex: turn_id
  work_item_id        TEXT REFERENCES work_item(id),
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  duration_ms         INTEGER,                         -- turn_duration / task_complete.duration_ms・turn_aborted.duration_ms
  local_date          TEXT NOT NULL,                   -- 開始時刻の論理日付
  status              TEXT NOT NULL CHECK (status IN ('running', 'completed', 'interrupted', 'error')),
  ended_with          TEXT CHECK (ended_with IN ('end_turn', 'question', 'permission', 'error', 'aborted')),
  initiator           TEXT CHECK (initiator IN ('human', 'queued', 'scheduled', 'system')),
  git_branch          TEXT,                            -- ターン終了時点のブランチ（3.3）
  cwd                 TEXT,                            -- ターン終了時点の cwd
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cache_read_tokens   INTEGER,
  tool_counts_json    TEXT,                            -- {"Bash":12,"Edit":5}（ツール名のみ）
  edited_files_count  INTEGER NOT NULL DEFAULT 0,
  pending_question    INTEGER NOT NULL DEFAULT 0 CHECK (pending_question IN (0, 1)),
  closing_question    INTEGER NOT NULL DEFAULT 0 CHECK (closing_question IN (0, 1)),
                                                       -- 締めの決まり文句の質問で終わった（「他に何かありますか？」等。3.3.1）。
                                                       -- アダプタがパース中に判定した真偽値だけを残す。1 なら返答タスクを作らず your_turn の (c) にも数えない
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX ai_turn_uq       ON ai_turn(session_id, turn_key);
CREATE INDEX        ai_turn_wi_idx   ON ai_turn(work_item_id, started_at);
CREATE INDEX        ai_turn_date_idx ON ai_turn(local_date);

CREATE TABLE ai_artifact (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('pr', 'commit', 'file_output')),
  ref               TEXT NOT NULL,                     -- 'owner/repo#123' / sha / 相対パス
  session_id        TEXT REFERENCES ai_session(id),
  turn_id           TEXT REFERENCES ai_turn(id),
  work_item_id      TEXT REFERENCES work_item(id),
  url               TEXT,
  title             TEXT,                              -- PR タイトル（gh から。タイトル候補の最上位）
  state             TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('open', 'draft', 'merged', 'closed', 'unknown')),
  review_decision   TEXT,                              -- 'APPROVED' / 'CHANGES_REQUESTED' / 'REVIEW_REQUIRED'
  my_review_at      INTEGER,                           -- 自分がレビューした時刻（自動クローズ用）
  head_ref          TEXT,                              -- PR の head ブランチ（gh の headRefName）。PR のカードへの帰属に使う（3.3）
  state_changed_at  INTEGER,                           -- merged / closed になった時刻（gh の mergedAt / closedAt）。待ちの終点と解決の兆候に使う（3.3.1）
  first_seen_at     INTEGER NOT NULL,
  state_checked_at  INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX ai_artifact_uq       ON ai_artifact(kind, ref);
CREATE INDEX        ai_artifact_wi_idx   ON ai_artifact(work_item_id);
CREATE INDEX        ai_artifact_open_idx ON ai_artifact(state_checked_at) WHERE kind = 'pr' AND state IN ('open', 'draft', 'unknown');

-- ---------- hooks の生イベント（許可リストのキーのみ。30日保持） ----------
CREATE TABLE hook_event (
  id                   TEXT PRIMARY KEY,
  tool                 TEXT NOT NULL CHECK (length(tool) BETWEEN 2 AND 32 AND tool NOT GLOB '*[^a-z0-9_]*'),  -- hooks を持つアダプタの ToolId
  config_root          TEXT,
  hook_event_name      TEXT NOT NULL,
  session_external_id  TEXT,
  turn_id              TEXT,
  prompt_id            TEXT,
  notification_type    TEXT,
  tool_name            TEXT,
  error_type           TEXT,                           -- StopFailure のエラーの種類（hook の error。古い spool の行は error_type）
  source               TEXT,                           -- SessionStart.source
  reason               TEXT,                           -- SessionEnd.reason
  cwd                  TEXT,
  occurred_at          INTEGER NOT NULL,               -- hook 実行時刻
  spool_file           TEXT NOT NULL,
  spool_offset         INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  term_handle          TEXT,                           -- Orca の端末のハンドル（ORCA_TERMINAL_HANDLE。Turnlane から答える届け先。D-238、0018）
  agent_id             TEXT,                           -- サブエージェントの中で出た hook の agent_id（Claude Code。session_external_id は親。0019）
  agent_type           TEXT,                           -- そのサブエージェントの種類（agent_type。0019）
  permission_mode      TEXT,                           -- 権限のモード（permission_mode。bypassPermissions の許可の hook は待ちにしない。0019）
  quota_horizon        INTEGER                         -- 利用枠の自動再開を止めた通知が「明けるのが 24 時間より先」の定型文だった（1。文は持たない。0020）
);
CREATE UNIQUE INDEX hook_event_spool_uq  ON hook_event(spool_file, spool_offset);   -- 冪等性
CREATE INDEX        hook_event_sess_idx  ON hook_event(session_external_id, occurred_at);
CREATE INDEX        hook_event_time_idx  ON hook_event(occurred_at);

-- ---------- フォローアップ（自分の番） ----------
CREATE TABLE follow_up (
  id               TEXT PRIMARY KEY,
  work_item_id     TEXT NOT NULL REFERENCES work_item(id),
  kind             TEXT NOT NULL CHECK (kind IN ('approve', 'reply', 'review_pr', 'resume_error', 'check_changes', 'merge_pr')),
  artifact_ref     TEXT NOT NULL DEFAULT '',           -- reply/approve/resume_error: トリガーのターン / review_pr: PR ref
  dedupe_key       TEXT NOT NULL,                      -- work_item_id|kind|artifact_ref
  trigger_at       INTEGER NOT NULL,
  trigger_turn_id  TEXT REFERENCES ai_turn(id),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'snoozed', 'done', 'dismissed', 'superseded', 'expired')),
                                                       -- expired: 返答タスクの 72時間の期限切れ（D-020。3.3.1）
  snooze_until     INTEGER,
  snoozes_json     TEXT NOT NULL DEFAULT '[]',         -- スヌーズした区間の履歴 [[開始, 終了], ...]（終了は snooze_until か、それより前に閉じた・⏎ した・再スヌーズした時刻）。待ちの集計外（snoozed）に使う（D-032。3.3.1）
  task_id          TEXT REFERENCES task(id),
  engaged_at       INTEGER,                            -- キューで ⏎（外部を開いた）
  closed_at        INTEGER,
  close_reason     TEXT,                               -- 'auto:human_input' / 'auto:pr_merged' / 'auto:pr_reviewed' / 'auto:next_turn_ok' / 'manual' / 'dismissed' / 'superseded'
                                                       -- / 'auto:resolved:commit' / 'auto:resolved:new_session' / 'auto:resolved:pr_merged'（解決済み（推定））/ 'auto:expired'（3.3.1）
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  hlc              TEXT NOT NULL,
  device_id        TEXT NOT NULL,
  deleted_at       INTEGER,
  sync_scope       TEXT NOT NULL DEFAULT 'local_only' CHECK (sync_scope IN ('synced', 'local_only'))
);
CREATE UNIQUE INDEX follow_up_dedupe_uq ON follow_up(dedupe_key);   -- dismissed も残すので再生成されない
CREATE INDEX        follow_up_task_idx  ON follow_up(task_id) WHERE task_id IS NOT NULL;   -- AI に頼んだタスクには自分の番が何度も付くので一意にしない（D-107。0010）
CREATE INDEX        follow_up_open_idx  ON follow_up(status, trigger_at) WHERE status IN ('open', 'snoozed');
CREATE INDEX        follow_up_wi_idx    ON follow_up(work_item_id);

-- ---------- 日報 / 儀式 ----------
CREATE TABLE daily_note (
  id                 TEXT PRIMARY KEY,
  date               TEXT NOT NULL,                    -- 論理日付
  plan_md            TEXT,
  memo_md            TEXT,                             -- シャットダウン時の一言
  report_md          TEXT,                             -- 閉店時に確定した日報
  highlight_task_id  TEXT REFERENCES task(id),
  planned_min        INTEGER,
  actual_min         INTEGER,
  morning_done_at    INTEGER,
  shutdown_done_at   INTEGER,                          -- 一日を閉じた時刻（翌朝 Mac を使い始めるまで放置に数えない。D-110 (1)）
  ai_summary_md      TEXT,                             -- 日報の AI 要約（M4-6。0006。ユーザーが編集できる）
  ai_summary_tool    TEXT,                             -- 要約を作ったツール（'claude_code' / 'codex'）
  ai_summary_at      INTEGER,                          -- 要約を保存した時刻
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  hlc                TEXT NOT NULL,
  device_id          TEXT NOT NULL,
  deleted_at         INTEGER,
  sync_scope         TEXT NOT NULL DEFAULT 'synced' CHECK (sync_scope IN ('synced', 'local_only'))
);
CREATE UNIQUE INDEX daily_note_date_uq ON daily_note(date) WHERE deleted_at IS NULL;

-- ---------- 在席（端末内だけ。同期しない・mutate() を通さない。D-105、ADR 0013） ----------
CREATE TABLE presence_span (                           -- 入力のあった区間（D-139）。presence.tail_min は読むときに足す（derive.expandPresence）。中身は持たない
  id          TEXT PRIMARY KEY,
  start_at    INTEGER NOT NULL,                        -- 最初の入力の時刻
  end_at      INTEGER NOT NULL,                        -- 最後の入力の時刻（D-139 より前は T を足した時刻。0014 で T を引いた）
  source      TEXT NOT NULL CHECK (source IN ('hid')), -- 取り方（HID の無操作時間）
  updated_at  INTEGER NOT NULL,
  seen_until  INTEGER,                                 -- 最後の入力から途切れずに見ていた最後のサンプルの時刻。在席の終わりはこれを超えない。NULL は上限なし（0014 で上限の分からなかった古い行）
  CHECK (end_at >= start_at)
);
CREATE INDEX presence_span_end_idx ON presence_span(end_at);

-- ---------- AI に頼む（端末内だけ。同期しない・mutate() を通さない。D-107、M5-B） ----------
CREATE TABLE ai_launch (                               -- タスクから AI に頼んだ1回。組み立てたプロンプトは持たない（ADR 0005 の追記）
  id             TEXT PRIMARY KEY,                     -- 起動 ID（ランダム 128bit の16進。端末に渡すのはこれだけ）
  task_id        TEXT NOT NULL REFERENCES task(id),
  tool           TEXT NOT NULL CHECK (tool IN ('claude_code', 'codex')),
  repo_root      TEXT NOT NULL,
  cwd            TEXT NOT NULL,                        -- AI を起動するディレクトリ（worktree か repo_root）
  worktree_path  TEXT,                                 -- turnlane が作った worktree（片付けの対象はこれだけ）
  branch         TEXT,
  base_ref       TEXT,
  template_id    TEXT,                                 -- 依頼の型（'builtin:<key>' か ai_template.id）
  read_only      INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1)),
  trigger        TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'schedule', 'queue', 'issue')),   -- 無料は manual だけ
  session_uuid   TEXT,                                 -- Claude Code に --session-id で渡した ID
  session_id     TEXT REFERENCES ai_session(id),       -- 紐づいたセッション
  status         TEXT NOT NULL CHECK (status IN ('pending', 'started', 'linked', 'unlinked', 'failed')),
  fail_reason    TEXT,
  test_ok        INTEGER CHECK (test_ok IS NULL OR test_ok IN (0, 1)),   -- 確認支援のテストの成否（出力は持たない）
  test_at        INTEGER,
  created_at     INTEGER NOT NULL,
  fetched_at     INTEGER,                              -- turnlane ai run が受け取った時刻（1回だけ）
  linked_at      INTEGER,
  cleaned_at     INTEGER,                              -- worktree を片付けた時刻
  updated_at     INTEGER NOT NULL,
  claude_account TEXT,                                 -- 起動した Claude のアカウント（設定ディレクトリ。既定・Codex は NULL）
  exit_code      INTEGER,                              -- turnlane ai run が知らせた AI の CLI の終了コード
  exit_after_ms  INTEGER,                              -- 始めてから終わるまで（ms）
  exited_at      INTEGER,                              -- 知らせた時刻
  unlinked_reason TEXT                                 -- unlinked の理由（exited / untrusted / no_session。m2-api 27章）
);
CREATE INDEX ai_launch_task_idx    ON ai_launch(task_id, created_at);
CREATE INDEX ai_launch_session_idx ON ai_launch(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX ai_launch_open_idx    ON ai_launch(status) WHERE status IN ('pending', 'started');

CREATE TABLE ai_template (                             -- 利用者が足した依頼の型（組み込みの4つはコードに持つ。plan §B.4）
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,                           -- {title} {notes} {repo} {branch} を差し込む
  tool        TEXT CHECK (tool IS NULL OR tool IN ('claude_code', 'codex')),
  read_only   INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1)),
  worktree    INTEGER CHECK (worktree IS NULL OR worktree IN (0, 1)),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE claude_limit (                            -- Claude の利用枠の最新の値（アカウントごと）。statusLine の受け口が送る rate_limits と .claude.json の利用枠のキャッシュの、使用率とリセットの時刻だけ（at は値の時刻。m2-api 28.1）
  account              TEXT PRIMARY KEY NOT NULL,      -- 設定ディレクトリの絶対パス
  five_hour_pct        REAL,
  five_hour_resets_at  INTEGER,
  seven_day_pct        REAL,
  seven_day_resets_at  INTEGER,
  at                   INTEGER NOT NULL                -- 受け取った時刻
);

-- ---------- 待ちの中身（限定した保存。ADR 0018、D-218。伏せ字の後の文だけ。設定 turn.store_detail がオフなら書かない） ----------

CREATE TABLE ai_instruction (                          -- 自分の指示の 1 行目（ターンごと、120 文字まで。短い返事・スラッシュコマンドだけは持たない）
  turn_id     TEXT PRIMARY KEY NOT NULL REFERENCES ai_turn(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL REFERENCES ai_session(id) ON DELETE CASCADE,
  at          INTEGER NOT NULL,                        -- 指示の時刻（ターンの開始）
  text        TEXT NOT NULL,
  masked      INTEGER NOT NULL DEFAULT 0 CHECK (masked IN (0, 1))
);
CREATE INDEX ai_instruction_session_idx ON ai_instruction(session_id, at);

CREATE TABLE wait_detail (                             -- 自分の番の待ちの中身（フォローアップを作ったときに 1 度読む）
  follow_up_id  TEXT PRIMARY KEY NOT NULL REFERENCES follow_up(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('permission', 'question', 'ask', 'error')),
  text          TEXT,                                  -- AI の問い（2 文まで）/ AskUserQuestion の問い
  options_json  TEXT,                                  -- AskUserQuestion の選択肢（JSON の配列）
  tool          TEXT,                                  -- 許可を求めたツール（MCP はサーバー名）
  label         TEXT,                                  -- Claude の短い説明（Bash の description）
  command       TEXT,                                  -- コマンドの 1 行目・パス・host/path・検索語
  error_kind    TEXT,                                  -- エラーの種類
  masked        INTEGER NOT NULL DEFAULT 0 CHECK (masked IN (0, 1)),
  created_at    INTEGER NOT NULL
);

-- ---------- 待ち（local_only。事実から再計算できるキャッシュ。3.3.1） ----------

CREATE TABLE ai_wait_segment (                         -- AI の待ちを区分ごとに切った区間
  id            TEXT PRIMARY KEY,
  work_item_id  TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
  wait_key      TEXT NOT NULL,                         -- 待ち区間の自然キー: 'turn:<ai_turn.id>' / 'hook:<hook_event.id>' / 'turn:<ai_turn.id>:ask' / 'turn:<ai_turn.id>:error'
  follow_up_id  TEXT REFERENCES follow_up(id),         -- 返答タスク等が付いていれば
  local_date    TEXT NOT NULL,                         -- 区間の論理日付（日付区切りをまたぐ待ちは分ける）
  kind          TEXT NOT NULL CHECK (kind IN ('grace', 'idle', 'excluded', 'expired')),
  excluded_by   TEXT CHECK (excluded_by IN ('closed', 'away', 'event', 'snoozed', 'no_task', 'scheduled')),   -- kind='excluded' のときだけ（closed・away は D-105、snoozed は D-032、no_task は D-045、scheduled は D-051）
  start_at      INTEGER NOT NULL,
  end_at        INTEGER NOT NULL,                      -- 開いている待ちは計算時点の now まで（tick で伸ばす）
  is_open       INTEGER NOT NULL DEFAULT 0 CHECK (is_open IN (0, 1)),
  end_reason    TEXT CHECK (end_reason IN ('human_input', 'engaged', 'status_left', 'resolved', 'dismissed', 'expired', 'superseded')),
                                                       -- 待ち区間全体の終わり方（同じ wait_key の全行に同じ値。開いていれば NULL）
  estimated     INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1)),
  computed_at   INTEGER NOT NULL,
  CHECK (end_at >= start_at),
  CHECK ((kind = 'excluded') = (excluded_by IS NOT NULL))
);
CREATE INDEX ai_wait_seg_date_idx ON ai_wait_segment(local_date, kind);
CREATE INDEX ai_wait_seg_wi_idx   ON ai_wait_segment(work_item_id, start_at);

-- ---------- 自分用の利用計測（Phase0 の14日判定と主要指標） ----------
CREATE TABLE usage_event (
  id    TEXT PRIMARY KEY,
  at    INTEGER NOT NULL,
  kind  TEXT NOT NULL,      -- 'ui_open' / 'morning_done' / 'shutdown_done' / 'followup_closed' / 'task_added' / 'user_op'（本人の「操作」。3.3.1）/ 'ritual_carry'（閉店で移したタスク。ref = '<日付>:<task id>'。D-079）...
  ref   TEXT
);
CREATE INDEX usage_event_idx ON usage_event(kind, at);

-- ---------- 同期用の変更ログ（outbox） ----------
CREATE TABLE change_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl         TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  hlc         TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  patch_json  TEXT NOT NULL,                           -- 変更したフィールドのみ
  created_at  INTEGER NOT NULL,
  pushed_at   INTEGER                                  -- 将来の端末間共有用。同期サーバーは作らない（ADR 0008）。Phase0 では常に NULL
);
CREATE INDEX change_log_unpushed_idx ON change_log(seq) WHERE pushed_at IS NULL;
CREATE INDEX change_log_row_idx      ON change_log(tbl, row_id);

-- ---------- 集計ビュー ----------
CREATE VIEW work_item_daily AS
SELECT
  t.work_item_id,
  t.local_date,
  COUNT(*)                          AS turn_count,
  COALESCE(SUM(t.duration_ms), 0)   AS ai_ms,
  MIN(t.started_at)                 AS first_at,
  MAX(COALESCE(t.ended_at, t.started_at)) AS last_at
FROM ai_turn t
WHERE t.work_item_id IS NOT NULL
GROUP BY t.work_item_id, t.local_date;
```

補足:
- `work_item` の UNIQUE は部分インデックスなので、統合（merge）で消えた行は `deleted_at` を入れ、`merged_into_id` で追えるようにする。
- `task.source` は「どの経路で入ったか」（manual / cli / mcp / ai / calendar）、`task.external_source` / `external_id` は「どの外部サービスのどの項目か」を表し、両者は独立する（例: MCP 経由で外部サービスの項目を入れたら `source='mcp'`、`external_source='github'`）。
- タグ（`tag` / `task_tag`）は Phase0 では作らない。`#blog` はプロジェクトとして扱う。
- 繰り返しタスク（RRULE）は v1。列も追加しない（必要時にマイグレーションで足す）。
- U22 の決定（3.3.1）で足した列とテーブル（`ai_turn.closing_question`、`ai_artifact.state_changed_at`、`follow_up.status` の `'expired'`、`follow_up.snoozes_json`（D-032）、`daily_note.work_start_at` / `work_end_at`、`work_day_auto`、`ai_wait_segment`）は、M0 で適用済みの初期スキーマに対して M1-9 の追加マイグレーションで入れた。D-105 のマイグレーション 0009 で `work_day_auto` と `daily_note.work_start_at` / `work_end_at` を消し、`presence_span` を足した。`follow_up.status` の CHECK の変更はテーブルの作り直しになる（2.5 の 4）。`work_day_auto` と `ai_wait_segment` は `turnlane rederive` で作り直せるキャッシュで、取り込み系と同じく `local_only`・変更ログなし。
- D-045・D-046 で足した列（`task.title_key` / `title_params`、`ai_wait_segment.excluded_by` の `'no_task'`）は追加マイグレーション 0003 で入れる。`ai_wait_segment` はキャッシュなので作り直し（行は捨てて次の derive で作る）、`task` は列の追加（末尾に足す）。

### 2.4 mutate 層（同期カラムと変更ログ）

```ts
// packages/core/src/db/mutate.ts
export interface MutateCtx { db: DB; clock: Clock; hlc: HlcClock; deviceId: string }

export function insertRow<T extends SyncedTable>(ctx: MutateCtx, table: T, values: InsertOf<T>): RowOf<T>;
export function updateRow<T extends SyncedTable>(ctx: MutateCtx, table: T, id: string, patch: Partial<InsertOf<T>>): RowOf<T>;
export function softDelete<T extends SyncedTable>(ctx: MutateCtx, table: T, id: string): void;
// いずれも 1トランザクション内で: id(UUIDv7) / created_at / updated_at / hlc / device_id を付与し、
// sync_scope='synced' の行なら change_log に (tbl, row_id, op, hlc, patch_json) を追記する。

// 外部取り込み用: UNIQUE 制約（task_external_uq）に当たったら挿入せず既存行を返す。
// INSERT ... ON CONFLICT (external_source, external_id) WHERE external_source IS NOT NULL DO NOTHING
// （部分インデックスなので WHERE が要る）→ 既存行の SELECT を同じトランザクションで行い、挿入した場合だけ change_log を書く。
export function insertRowIfAbsent<T extends SyncedTable>(ctx: MutateCtx, table: T, values: InsertOf<T>,
  conflictTarget: readonly (keyof RowOf<T>)[]): { row: RowOf<T>; created: boolean };
```

- ルート・ジョブ・取り込みのどこからでも、同期対象テーブルへの書き込みは `mutate` 経由に限る（Biome の `noRestrictedImports` で、`routes/` などから Drizzle の `insert` を直接呼ぶことを禁止する）。
- HLC は起動時に `change_log` の最大 hlc と現在時刻から復元する。

### 2.5 マイグレーション方針

1. 前進のみ。down は書かない。戻すときはバックアップから復元する。
2. 起動時に未適用のマイグレーションがあれば、適用前に `VACUUM INTO 'backups/pre-migrate-<n>-<ts>.db'` を取り、1トランザクションで適用する。失敗したらデーモンは起動を中止し、`turnlane doctor` に原因を出す。
3. Drizzle の `migrate()`（ディスク上のフォルダを読む）は単一バイナリで使えないため使わない。drizzle-kit で生成した SQL を `with { type: "text" }` でバイナリに埋め込み、自前の適用関数（`packages/core/src/db/migrate.ts`、M0-8）が `--> statement-breakpoint` で分割して適用する。適用履歴は `__migrations` テーブルに加え、`PRAGMA user_version` にも番号を入れる（外部ツールから一目で分かるように）。
4. 列の削除や型変更は「新テーブル作成 → コピー → 入れ替え」の手書き SQL で行う（SQLite の ALTER の制約のため）。
5. **取り込みデータは「作り直せる」と仮定しない。** Claude Code のトランスクリプトは30日で消えるため、`ai_session` / `ai_turn` / `ai_artifact` は唯一の記録になりうる。`turnlane reingest` はカーソルを戻して upsert し直すだけで、既存行は削除しない。一方、`work_item` のグルーピング・状態・`follow_up` は取り込みデータから再計算できる（`turnlane rederive`）。
6. 日次バックアップ（`VACUUM INTO`、14世代）と、`turnlane export --json`（全テーブルを JSON Lines、スキーマ番号付き）を M0 で入れる。

---

## 3. 主要インターフェース

### 3.1 ソースアダプタ IF

```ts
// packages/collectors/src/types.ts
export const ADAPTER_API_VERSION = 1;           // NormalizedEvent / SourceAdapter に互換性のない変更をしたら上げる

// アダプタの識別子。/^[a-z][a-z0-9_]{1,31}$/（DB の CHECK と同じ書式）。同梱: 'claude_code' | 'codex' | 'claude_desktop' | 'hook_spool'
// 列挙型にしないのは、アダプタの追加で core / daemon / DB のマイグレーションを要らなくするため
export type ToolId = string & { readonly __brand: 'ToolId' };

export interface DetectedRoot {
  tool: ToolId;
  rootPath: string;               // 絶対パス
  profileLabel: string;           // ディレクトリ名から導出した表示用ラベル（例 'default'）
  evidence: string[];             // 'has projects/', 'has session_index.jsonl' など（存在確認のみ）
}

export interface StreamSpec {
  key: string;                    // ingest_cursor.stream_key
  kind: 'jsonl' | 'json_snapshot' | 'sqlite';
  path: string;                   // 絶対パス
  priority: 'live' | 'recent' | 'backfill';   // 初回取り込みの順序
}

export interface WatchSpec {
  dir: string;
  recursive: boolean;
  match: (absPath: string) => boolean;
  reconcileEveryMs: number;       // 取りこぼし対策の定期再走査（mtime 比較）
  pollEveryMs?: number;           // 監視に来ない追記（開いたままのファイル）のための軽い走査（mtime だけ）。Codex の sessions/ は 10 秒
}

export interface Cursor {
  dev?: number; inode?: number; size?: number; mtimeMs?: number;
  byteOffset: number;
  watermark?: string;
  carry?: unknown;                // パーサ固有の継続状態（JSON 化できるもの）
  parserVersion: number;
}

export interface ReadContext {
  now: number;
  maxBytes: number;               // 1回で読む上限（初回の巨大ファイル対策。デーモンの既定 512KB）
  privacy: { storeTitles: boolean };
  log: MetaOnlyLogger;            // 本文を受け取れない型のロガー
}

export interface ReadResult {
  events: NormalizedEvent[];
  next: Cursor;
  stats: { records: number; skipped: number; unknownTypes: number; missingRequired: number };
  done: boolean;                  // false なら maxBytes で打ち切ったので続きがある
}

export interface AdapterCapabilities {
  liveStatus: boolean; turns: boolean; tokens: boolean;
  gitBranch: boolean; prLinks: boolean; hooks: boolean;
}

export interface AdapterTiming {
  runningStaleMs: number;         // 最終ターンが未完了でも、この時間更新が無ければ running とみなさない（Claude 5分、Codex 10分）
}

// hooks を持つツールのアダプタだけが実装する。hook-spool アダプタ（正規化）が使う。events / allowlist は
// src/hook-allowlist.ts の定数から作る（turnlane hook はアダプタではなくその定数を直接 import する。ADR 0009）。
// hooks 設定ファイルへのインストールはツールごとの事情が大きいので apps/cli 側に置き、ここには含めない
export interface HookSpec {
  events: readonly string[];                               // 受け取る hook イベント名
  allowlist: Record<string, readonly string[]>;            // イベント名 → spool に残すキー
  normalize(extracted: Record<string, unknown>, at: number): NormalizedEvent | null;
}

export interface SourceAdapter {
  readonly apiVersion: typeof ADAPTER_API_VERSION;
  readonly tool: ToolId;
  readonly displayName: string;                 // UI の表示名（'Claude Code' 等）
  readonly parserId: string;
  readonly parserVersion: number;               // 上げるとカーソルの carry を破棄して読み直す
  readonly testedVersions: string;              // semver 範囲。外れたら UI に注意を出す（縮退はしない）
  readonly capabilities: AdapterCapabilities;
  readonly timing: AdapterTiming;
  readonly allowlist: Record<string, readonly string[]>;  // レコード型 → 読むキー（監査・テストで使う）
  readonly hooks?: HookSpec;

  detect(env: { home: string; vars: Record<string, string | undefined> }): Promise<DetectedRoot[]>;
  watch(root: DetectedRoot): WatchSpec[];
  listStreams(root: DetectedRoot, opts: { sinceMs?: number }): Promise<StreamSpec[]>;
  streamFor(root: DetectedRoot, absPath: string): StreamSpec | null;
  read(stream: StreamSpec, cursor: Cursor | null, ctx: ReadContext): Promise<ReadResult>;
  probeLive?(root: DetectedRoot): Promise<LiveProbe[]>;   // Claude: sessions/<pid>.json + pid 生存確認
}

export interface SessionRef { tool: ToolId; externalId: string }   // hook_spool は自分のセッションを持たず、元ツールの ToolId を入れる

export type EndedWith = 'end_turn' | 'question' | 'permission' | 'error' | 'aborted';

// すべて「累積値」を運ぶ。シンクは代入のみ（加算しない）→ 再読込しても同じ結果
export type NormalizedEvent =
  | { kind: 'session_seen'; ref: SessionRef; at: number; startedAt?: number; cwd?: string; parent?: SessionRef; isSubagent?: boolean;
      entrypoint?: string; clientVersion?: string; model?: string; title?: string; titleSource?: string;
      archived?: boolean; hasHumanInput?: boolean; filePath?: string; noise?: boolean }
  | { kind: 'turn'; ref: SessionRef; turnKey: string; startedAt: number; endedAt?: number; durationMs?: number;
      status: 'running' | 'completed' | 'interrupted' | 'error'; endedWith?: EndedWith;
      initiator?: 'human' | 'queued' | 'scheduled' | 'system'; gitBranch?: string; cwd?: string;
      tokens?: { input: number; output: number; cacheRead?: number };
      toolCounts?: Record<string, number>; editedFiles?: number; pendingQuestion?: boolean;
      closingQuestion?: boolean;    // 締めの決まり文句の質問で終わった（3.3.1）。追加の任意項目なので ADAPTER_API_VERSION は上げない
      lastActivityAt?: number }     // ターン内の最後のレコードの時刻（running の鮮度に使う。M1 で追加した任意項目）
  | { kind: 'artifact'; ref: SessionRef; turnKey?: string; at: number;
      artifact: { kind: 'pr'; repo: string; number: number; url?: string } | { kind: 'commit'; sha: string } }
  | { kind: 'live_status'; ref: SessionRef; at: number; status: 'busy' | 'idle' | 'gone'; pid?: number }
  | { kind: 'hook'; ref: SessionRef; at: number; name: string; notificationType?: string; toolName?: string;
      errorType?: string; turnId?: string; promptId?: string; source?: string; reason?: string; cwd?: string;
      configRoot?: string;          // hook を受けた設定ディレクトリ（turnlane hook が環境変数から取る。S5。M1 で追加した任意項目）
      spool: { file: string; offset: number } };
// session_seen の at は活動の時刻（シンクは started_at = min(startedAt ?? at)、last_activity_at = max で反映する）
```

各アダプタの要点:

| アダプタ | ストリーム | ターンの切り方 | 備考 |
|---|---|---|---|
| claude-code | `projects/**/<sid>.jsonl`（サブエージェントは `<sid>/subagents/agent-*.jsonl`）、`sessions/<pid>.json` | `origin.kind=="human"` の user レコード（`promptId` があればそれ）で開始、`system/turn_duration` か `assistant.stop_reason=="end_turn"` で終了。`origin.kind=="task-notification"` で始まるターンは `initiator='system'`（人間入力ではない）。ターンの `gitBranch` / `cwd` はターン内で最後のレコードの値 | `ai-title` は最新値（実際にはセッション中に変わらない。S3）。`pr-link` は同じ PR が繰り返し再出力されるので（S3: 45 PR に978レコード）、セッション内で `(prRepository, prNumber)` が初めて出たレコードだけを artifact にし、既出の組は carry に持つ。`AskUserQuestion` の tool_use で `pendingQuestion=true`、対応する tool_result で解除。最終 assistant テキストが質問で終わるか、それが締めの決まり文句か（`closing-question.ts`）はパース中にだけ判定し、真偽値のみ残す（本文は保持しない） |
| codex | `sessions/**/rollout-*.jsonl`（ターン・状態・時間）、`session_index.jsonl`（タイトル `thread_name`）、`archived_sessions/*.jsonl`（アーカイブ = このディレクトリへの移動） | `turn_id`（`task_started` / `task_complete` / `turn_aborted`） | **SQLite（`state_5.sqlite` / `thread_history_1.sqlite` / `goals_1.sqlite`）は Phase0 では開かない**（S2。SQLite は JSONL の写しで遅れがあり、普段の状態では読み取り専用で開けない）。サブエージェントは `session_meta.source`、ブランチは `session_meta.git` か enrich の `git rev-parse` で補う。`source.subagent.other=="guardian"` と、人間の入力（`UserMessage`）が1件も無い rollout はノイズ |
| hook-spool | `spool/hooks-*.jsonl` | — | 自アプリが書いた JSONL。形式は自分で管理するので壊れない |
| claude-desktop（任意） | `claude-code-sessions/**/local_*.json` | — | `cliSessionId` で claude-code のセッションに `title` / `prs[]` / `isArchived` を付け足すだけ。Cowork は Phase0 対象外 |

#### 3.1.1 collectors のパッケージ境界（コミュニティのアダプタ PR を受けるため）

方針: アダプタは**プラグインとして実行時に読み込むのではなく、このリポジトリへの PR で同梱する**（ADR 0008）。そのうえで `packages/collectors` は、他の `@turnlane/*` パッケージに依存しない独立パッケージとして、いつでも単体で公開（npm 等）できる境界を保つ。Phase0 は `private: true` のままで公開しない。

**依存方向**

```
apps/daemon ──▶ packages/core ──▶ packages/collectors   （collectors は types のみ core に提供）
apps/cli ─────────────────────────▶ packages/collectors   （hooks のインストーラ等）
apps/cli/src/hook ────────────────▶ @turnlane/collectors/hook-allowlist だけ（import を持たない定数モジュール。ADR 0009）
packages/collectors ──▶ node:fs / node:path のみ（bun:sqlite は将来 SQLite を読む場合に限って許可。Phase0 は使わない）
```

| 規則 | 守り方 |
|---|---|
| collectors は `@turnlane/*`、Drizzle、Hono、zod、DB スキーマを import しない | Biome `noRestrictedImports`（collectors 配下に限定したルール） |
| 外部 npm 依存は原則ゼロ。必要なら PR で理由を書き、MIT と両立するライセンスに限る | `package.json` の `dependencies` を CI で検査（許可リスト外があれば失敗） |
| アダプタは子プロセスを起動しない・ネットワークに出ない・検出したルートの外を読まない。読み取り専用 | レビューのチェックリストと、テストキットの検査（`fs` を差し替えてルート外へのアクセスを失敗させる） |
| git による repo_root / ブランチの補完、プロジェクトへの振り分け、状態判定はアダプタの責務ではない（daemon の enrich と core/derive が行う） | アダプタは `cwd` と、ファイルから分かる `gitBranch` を出すだけ |
| ランタイムは Bun 1.4 系（daemon と揃える。将来 SQLite を読む場合は `bun:sqlite` を使う）。`package.json` の `engines` に書く | — |

**公開 IF**（`src/index.ts` と `src/testing/index.ts` から export するものだけ。それ以外のファイルは内部扱い）

| export | 内容 |
|---|---|
| 型 | `SourceAdapter`、`NormalizedEvent`、`SessionRef`、`EndedWith`、`DetectedRoot`、`StreamSpec`、`WatchSpec`、`Cursor`、`ReadContext`、`ReadResult`、`AdapterCapabilities`、`AdapterTiming`、`HookSpec`、`ToolId`、`MetaOnlyLogger` |
| `ADAPTER_API_VERSION` | 互換性の版。上げたら同梱アダプタをすべて追従させる（同梱なので実行時の版交渉はしない） |
| `defineAdapter(a)` | ToolId の書式・`apiVersion`・許可リストの形を検査して返す。各アダプタの `index.ts` はこれで default export する |
| `builtinAdapters` | 同梱アダプタの配列（`registry.ts`）。daemon の supervisor はこれだけを見る |
| `readJsonlIncremental()` | 3.2 の冪等規則を満たすリーダ。アダプタはファイルを直接読まず、これを使う。SQLite 用のリーダは Phase0 では作らない（必要になったら ai-session-ingestion 1.4 のコピー方式で `openSqliteSnapshot()` を足す） |
| `pickAllowed(record, keys)` | 許可リストのキーだけを取り出す。アダプタは JSON をパースした直後にこれを通す |
| `@turnlane/collectors/hook-allowlist` | hooks の spool に残すキー（`HOOK_ALLOWLIST`。ToolId → `{ events, keys, droppable }`）と `HOOK_TOOL_IDS`。import を1つも持たない定数だけのモジュールで、`turnlane hook` が直接 import する（ADR 0009）。各アダプタの `HookSpec.allowlist` はこの定数から作る。spool の行には許可リストのキーのほか、`turnlane hook` が付ける `v`・`tool`・`received_at`・`config_root`（環境変数から取る設定ディレクトリ。S5）・`term`（環境変数 `ORCA_TERMINAL_HANDLE` の Orca の端末のハンドル。形の合うものだけ。Turnlane から答える届け先。D-238）が入る |
| `@turnlane/collectors/testing` | `runGoldenSuite(adapter, fixturesDir)`、`runIncrementalSuite(...)`（任意のバイト位置で分割して一致を確認）、`runSentinelSuite(...)`（本文系キーに番兵を入れて出力に漏れないことを確認）、`withRootJail(...)`（ルート外アクセスの検出） |

semver: 公開 IF の破壊的変更は `ADAPTER_API_VERSION` を上げ、パッケージのメジャー版も上げる。公開前（0.x）の間はマイナーで上げてよい。

**フィクスチャの置き場**

- `packages/collectors/test/fixtures/<tool>/<toolVersion>/<case>/` に、検出ルート配下の構造をそのまま写す（例: `claude_code/2.1.x/question-end/projects/-fixture-repo-a/<sid>.jsonl`）。`<case>/case.json` に説明・期待する capabilities・対応する Issue を書く。
- 期待値は `packages/collectors/test/__snapshots__/` のスナップショット（`NormalizedEvent[]`）。
- 実データは必ず `packages/collectors/scripts/anonymize.ts` を通す（5.2）。Phase0 は SQLite を読まないので SQLite のフィクスチャは持たない（将来読む場合は列構成だけ写した合成 DB にする）。
- フィクスチャはパッケージ内に閉じる。daemon / core のテストが使う場合も、collectors の公開テストキット経由か相対パスで参照し、別の場所に複製しない。

**アダプタ追加手順**（公開時に CONTRIBUTING.md へ英語で転記する。M6-3）

1. Discussions の Adapters カテゴリか issue の adapter request で、ツール名・ログの場所・形式（本文を含まない構造の説明）を共有する。
2. `src/adapters/_template/` を `src/adapters/<tool>/` にコピーし、ToolId を決める（`^[a-z][a-z0-9_]{1,31}$`、既存と重複しない）。
3. `detect` / `watch` / `listStreams` / `streamFor` / `read` を実装し、`allowlist`・`testedVersions`・`capabilities`・`timing` を宣言する。本文系のキーは許可リストに入れない（ADR 0005）。読み取りは `readJsonlIncremental` を使う。他ツールの SQLite を元ファイルのまま開かない（ai-session-ingestion 1.4）。
4. 手元の実データから `bun run --cwd packages/collectors anonymize -- --tool <tool> <files...>` でフィクスチャを作り、目視で個人情報が無いことを確認する。最低限「通常の1ターン」「ユーザーへの質問で終わる」「途中で書き込み中の末尾行」の3ケース。
5. `test/<tool>.test.ts` で `runGoldenSuite`・`runIncrementalSuite`・`runSentinelSuite` を呼ぶ。
6. `src/registry.ts` の `builtinAdapters` に追加する。DB のマイグレーション・core・daemon の変更は不要（ToolId を列挙していないため）。表示名は `displayName` から出る。
7. hooks を持つツールなら `src/hook-allowlist.ts` に ToolId のエントリを足し、`HookSpec` を実装する（インストーラは `apps/cli/src/hooks-install/` に別 PR で追加。アダプタ単体の PR では不要）。
8. `docs/spec/ai-session-ingestion.md` のソース一覧に1行足す。PR テンプレートのチェックリスト（テスト、匿名化、本文を扱っていない、ルート外を読まない）を埋める。

保守の分担: アダプタは「壊れたら推定表示に縮退する」（3.2・M1-12）ので、作者が使っていないツールのアダプタが壊れても他は止まらない。各アダプタの README に、検証したツールのバージョンと、直せる人（任意）を書く。

### 3.2 取り込みパイプライン

```
FS 変更 (fs.watch recursive) ─┐
定期再走査 (60s, mtime 比較) ─┼─▶ queue: stream_key ごとにデバウンス 500ms・直列実行
起動時 / turnlane sources rescan ─┘        │
                                       ▼
                     adapter.read(stream, cursor, ctx)   ※ 1回 512KB まで。続きは再投入
                                       │ NormalizedEvent[] + next cursor
                                       ▼
                     enrich: cwd → repo_root（git rev-parse --show-toplevel と --git-common-dir。cwd 単位で
                             キャッシュ。worktree は本体リポジトリに寄せる）、Codex の branch 補完、除外判定
                                       │
                                       ▼
          ┌─────────── BEGIN IMMEDIATE ───────────┐
          │ sink: ai_session / ai_turn / ai_artifact / hook_event を自然キーで upsert（代入のみ）│
          │ ingest_cursor を next で更新                                                      │
          └──────────────── COMMIT ───────────────┘
                                       │ 変化したセッション id の集合
                                       ▼
                     derive runner（デバウンス 1s、さらに 60s ごとの tick）
                       1. 影響する WorkItem を再グルーピング（grouping.ts）
                       2. 状態判定（status.ts）→ 変化があれば status_log を閉じて新しい行
                       3. フォローアップの差分（followups.ts）→ follow_up / task を作成・クローズ
                                       │
                                       ▼
                     SSE: work_item / follow_up / task の変更を UI へ
```

冪等性・堅牢性のルール:

| 状況 | 扱い |
|---|---|
| 末尾の不完全行 | 最後の `\n` までだけ処理し、`byte_offset` はそこで止める |
| ファイルが短くなった（`size < byte_offset`）/ 同じ `stream_key` で `(dev, inode)` が変わった（同一パスでの差し替え） | カーソルと carry を捨てて先頭から読み直す。upsert なので重複しない |
| リネーム（別の `stream_key` に同じ `(dev, inode)` の既存カーソルがある） | リネームとみなしてオフセットと carry を引き継ぐ。Claude Code / Codex はローテーションしないので優先度は低く、引き継げなくても冪等な upsert で壊れない |
| 監視先のルートが存在しない（`fs.watch` が `ENOENT`） | デーモンを落とさない。親ディレクトリを見張り、60秒の再走査のたびに張り直しを試みる。health には「未作成」と出す |
| FSEvents のイベント合体（書き込み数千回に数イベント） | イベント1回ごとの書き込みを前提にしない。イベントを受けたらカーソルから末尾まで読む |
| パーサの版を上げた | `parser_version` の不一致を検知し、同じく先頭から読み直す。読み直し（と、そのたびの derive runner）の間も HTTP（health など）を待たせない: 取り込みは 512KB のチャンクごと、derive runner は約 15ms ごとにイベントループへ譲る（目安: 読み直し中も health が 100ms 以内）。runner は譲っている間に DB が他から書き換わったら打ち切って実行し直し（3 回続いたら譲らずに 1 回で終える）、runner の実行中は取り込みが次のチャンクに進まない。待ち区間は前回と同じ行を残し、変わった行だけ書く |
| 1行の JSON が壊れている | スキップして `records_skipped` を加算。必須キーの欠落率が 20% を超えたストリームが3本以上になったら、そのソースを L1 に落とす |
| 未知の `type` | 無視（前方互換）。種類ごとの件数だけを health に出す |
| 元ファイルが消えた（30日削除） | DB の行は残し、`ai_session.transcript_missing_at` を記録する |
| hooks spool | `(spool_file, spool_offset)` の UNIQUE で重複を防ぐ。7日より古い spool ファイルは取り込み済みなら削除 |
| 初回バックフィル | `priority` 順（live → 直近7日 → それ以前）。オンボーディングで同意した利用者は直近7日だけを読み、それ以前のファイルは読まない（D-181、onboarding.md 5.6）。既存の利用者（範囲の制限なし）はそれ以前も低優先度で続ける |

### 3.3 状態判定とフォローアップ生成

置き場所:
- `packages/core/src/derive/grouping.ts`: `groupKeyForTurn(turn, session, prIndex, settings): GroupKey`
- `packages/core/src/derive/status.ts`: `deriveStatus(facts: WorkItemFacts, now: number, settings): { status; reason; estimated }`
- `packages/core/src/derive/followups.ts`: `desiredFollowUps(facts, settings): FollowUpSpec[]`、`reconcile(existing: FollowUp[], desired: FollowUpSpec[], facts): FollowUpDiff`
- `packages/core/src/derive/presence.ts`: `presenceStep(last, sample, prev)`、`expandPresence(rows, tailMs)`、`closedRanges(events, closedAt, resumeAt)`、`firstPresentAt(presence, t)`（3.3.1。D-105・D-110）
- `packages/core/src/derive/time.ts`: `aiTime / selfTime(workItem, dateRange)`、`waitIntervals(facts, now, settings)`（待ち区間の端点を事実から再生）、`classifyWait(interval, { presence, closed, busy, settings }): WaitSegment[]`（猶予・放置・集計外・期限切れ）。待ちの定義は 3.3.1（U22 決定）
- `packages/core/src/i18n/task-title.ts`: 自動生成タスクの題名の組み立て（D-046。英語・日本語の辞書を持つ最小のフォーマッタ。M2-12 の i18n 基盤ができたら辞書をそちらへ移す）
- `apps/daemon/src/derive/runner.ts`: 事実を DB から読む → 純粋関数を呼ぶ → 差分を書く → SSE

グルーピング（ai-session-ingestion.md 4.2 を実装に落としたもの。S3 の結果で調整済み）:
1. ターンの `cwd` とブランチは**ターン終了時点**の値を使う（Claude はターン内で最後のレコードの `gitBranch` / `cwd`）。S3 ではターンの13%でターン内にブランチが変わり、PR の head ブランチと一致したのは終了時点が 9/10、開始時点が 1/10 だった。
2. `cwd` から `repo_root` を求める。`cwd` が今は存在せず（ディレクトリ名の変更など）解決できない場合は、同じセッションで直前に解決できたターンの `repo_root` を引き継ぐ（主に初回バックフィルで起きる。S3 で12ターン）。引き継ぐものが無ければ git 管理外として扱う。git 管理外なら `session:<tool>:<id>`。
3. ブランチが既定ブランチ（main / master / develop、または `git symbolic-ref refs/remotes/origin/HEAD`）なら `session:<tool>:<id>`。このカード（既定ブランチの session カード）の `work_item.repo_root` は、カードのターンのうち最後に解決できたターンの `repo_root` にする（git 管理外のカードだけが null で、UI は「(no repo)」。D-061。以前は session カードの `repo_root` を常に null にしていたため、既定ブランチで作業したリポジトリが「(no repo)」と出ていた）。既定ブランチで終わったターン（pull、マージ後の片付け、次の作業の相談）を前後のブランチのカードへ寄せる規則は入れない（S3 のオーナー確認で、この粒度に誤りは無かった）。
4. それ以外は `branch:<repo_root>#<branch>`。PR はキーではなく属性（`pr_ref`）にする。同じブランチで2本目の PR が出た場合だけ `#pr<n>` を付けて分ける。
5. **PR のカードへの帰属は head ブランチで決める。** `gh` で取った `headRefName`（`ai_artifact.head_ref`）に一致する `branch:<repo_root>#<head_ref>` のカードに付ける。そのカードが無い（そのブランチで終わったターンが無い）場合は、PR を起点にそのカードを作る（`first_activity_at` は PR の `first_seen_at`）。`gh` が無く `head_ref` が取れないときだけ、PR が初めて出たターンのカードに付ける。S3 では、初出ターンのカードに付けるやり方が誤帰属を1件生んだ。
6. サブエージェントのターンは親セッションのターンの WorkItem に入れる（独立カードにしない）。
7. ユーザーの統合（`merged_into_id`）は再グルーピングより優先する。

状態判定（優先順位: error > needs_input > running > your_turn > done。WorkItem 内のセッションのうち最も優先度の高い状態）:

| 状態 | 主シグナル（hooks あり） | 推定シグナル（hooks なし。`estimated=1`） |
|---|---|---|
| error | `StopFailure` hook、最終ターン `status=error`（利用枠の `rate_limit` を除く。下の「上限待ち」）。止まってから 1 時間で状態を閉じる | Codex `turn_aborted`（中断理由がエラーのもの） |
| needs_input | `PermissionRequest` か `Notification(permission_prompt / agent_needs_input)` の後に、ツール実行・`Stop`・`UserPromptSubmit` が無い | `pending_question=1`（AskUserQuestion 未回答）、`sessions/<pid>.json` が idle で最終ターンが未完了 |
| running | `UserPromptSubmit` の後に `Stop` が無い | `live_status=busy` かつ pid 生存 / 最終ターンが未完了で `timing.runningStaleMs` 以内（Claude 5分、Codex 10分）に更新あり |
| your_turn | `Stop` の後に人間入力が無く、(a) open な PR、(b) 最終ターンで編集あり、(c) 質問で終了（締めの決まり文句の質問 `closing_question=1` を除く。3.3.1）、(d) トランスクリプトの終わりがまだ取り込まれていないが `Stop` で終わった（理由 `hook:stop`。中身が分かるまでの推定。返答タスクは (c) と同じくそのターンに作る。ai-session-ingestion 4.3 の「hooks が補う終わり」）、のいずれか。(b) は既定ブランチのカードでは「今も未コミットの変更がある（`git status`）」を条件に加える | 同じ条件をファイルから判定 |
| done | PR が merged/closed、セッションが archived、手動完了、your_turn の条件を満たさずにターンが終了した（待たずに done）、your_turn の期限切れ（git 管理外のカードの (b) はターン終了から24時間、(c) は72時間。どちらも設定可）、**タスクのない your_turn の期限切れ**（下記。72時間。D-048 (4)） | 同左 |

- `manual_done_at` は、それより後に新しいターンが始まったら無効にする。
- **上限待ち（利用枠）**: セッションの最後のターンの `StopFailure` のエラーの種類（hook の `error`。古い記録は `error_type`。`hook_event.error_type` に入れる）が `rate_limit` なら error にせず上限待ちにする。種類が無くても、同じターンの hook の窓に `Notification(quota_auto_resume_*)` があれば利用枠とし、同じセッションの先の上限待ちの `until` より前の停止は、その上限待ちの続き（停止の時刻・`until`・再開のタスクは最初の停止のもの）とする。最後の停止の後の `quota_auto_resume_fired` は止まっていない（Claude Code が続けた。再開のタスクも作らない）、`quota_auto_resume_stale` はいま再開できる（`until` はその時刻。すぐに再開のタスク）、`quota_auto_resume_disabled` は上限待ち（ai-session-ingestion 2.1 の「利用枠の停止」）。停止の時刻は、最後の UserPromptSubmit・fired の後の最初の停止（再試行の StopFailure が続いても `until` を先へ延ばさない）。終わり（`until`）は、そのセッションのアカウント（hook の `config_root` = 設定ディレクトリ。`claude_limit.account` と同じ書き方）の利用枠のうち、停止の時刻を含む枠（5 時間・7 日）のリセットの時刻（使い切った枠があればその遅い方、無ければ早い方）。分からなければ停止から 5 時間（`quota_auto_resume_disabled` が「リセットが 24 時間より先」の定型文だった（`hook_event.quota_horizon`）なら 24 時間）。上限待ちの間のカードは `done`・`reason='rate_limit'`（人がすることはまだ無い。your_turn の (b) にもしない）。`until` を過ぎたら状態は無し（止まっているだけ）にし、再開のタスク（下の resume_error の `:limit`）を出す。判定は `derive.sessionStopOf` / `limitWaitOf`
- **エラーの状態は 1 時間**: rate_limit 以外のエラー（StopFailure・`turn:error`）の状態は止まってから 1 時間で閉じる（レーンの札「エラー Nh」が育ち続けないように）。resume_error のタスクはそのまま残り、72 時間で期限切れ。再開のタスク（resume_error。`:limit` を含む）が open / snoozed の間のカードは `your_turn`（`reason='resume_error'` / `'resume_limit'`）
- **タスクのない your_turn は72時間で done にする（D-048 (4)）**: your_turn の条件（(a)(b)(c) のどれか）を満たしていても、カードに YOUR TURN のタスク（reply / review_pr / approve / resume_error のフォローアップで `status IN ('open', 'snoozed')`）が1件も無い状態が72時間（`reply.expire_hours`）続いたら、`status='done'`・`reason='no_task_expired'` にする。
  - 起点は「your_turn の待ちの始点（3.3.1。最後のターン終了。(a) だけが理由なら最後のターン終了と PR の初出の遅い方）」と「そのカードのフォローアップが最後に閉じた時刻（`closed_at`）」の遅い方。起点から72時間たった時点で done。
  - 対象になる例: 編集ありだけの your_turn（PR なし。既定オフの check_changes はタスクに数えない）、自分のレビューで review_pr が閉じた後も open のままの PR、72時間より古く review_pr を作らなかった PR（初回の取り込み。起点がすでに72時間より前なので、すぐ done になる）、`e`（対応不要）で返答タスクを閉じた後の your_turn。
  - スヌーズ中のタスクは「ある」とみなす（スヌーズは本人の「後でやる」の判断。D-032）。
  - 新しいターン（人間入力・AI のターン）が始まれば通常どおり判定し直す（`manual_done_at` と同じ扱い）。新しいフォローアップが作られれば、それが open の間は your_turn のまま。
  - needs_input と error には適用しない（needs_input は AI が止まっている事実を示すので状態は変えない。error は resume_error の72時間の期限切れで足りる）。needs_input は必ずタスク（approve か reply）を作るので YOUR TURN に出る（D-049 (1)。下のフォローアップの表）。error はタスク（resume_error）が無ければ YOUR TURN には出ない（72時間より古い error。下記）。
  - 待ち区間はこの時刻で終わる（終点 (3)、`end_reason='status_left'`）。タスクが無いので放置にも Expired の件数にも入らない。
  - 判定は `deriveStatus` の純粋関数で行う（入力の `WorkItemFacts.followUps` は M1 で揃っている）。M2-2 で実装する。タスクのない your_turn のカードが YOUR TURN に溜まり続ける問題は、適用後の再判定で解消する。
- **YOUR TURN に出すのは open なタスクがあるカードだけ（D-048 (4)）**: `GET /api/queue`（YOUR TURN 帯、要対応キュー、サイドバーとタブタイトルの件数、通知、儀式の Step 1）と `turnlane queue` は、YOUR TURN のタスク（上と同じ4種、`open` / `snoozed`）が1件以上あるカードだけを返す。帯・キュー・件数・通知に出すのはそのうち `open` のタスクがあるカードで、スヌーズ中のタスクしか無いカードはスヌーズが明けるまで出さない（UI 側。m2-api.md 2.2）。状態が needs_input / error / your_turn でもタスクが無いカードは出さない（AI レーン・詳細パネルでは状態どおりに描く）。D-045 の「見せていないものは数えない」を表示にも揃えたもの。
- 時刻依存の遷移（5分・10分・15分・24時間・72時間）は 60秒ごとの tick で再評価する。
- 「人間入力」は `initiator` が `human` / `queued` のターンだけを指す。task-notification（バックグラウンドのサブエージェント完了など）を起点とするターンは `initiator='system'` とし、AI 時間には数えるが人間入力として扱わない（your_turn と reply を解除しない、待ちの終点にしない）。S3 では Claude のターンの11%（12/107）がこれだった。
- your_turn の条件が無いターン終了を待たずに done にするのは、S3 で AI のターン終了から次の人間入力までの中央値が4分で、条件の無い終了はほぼ確認済みと見てよいため。
- 既定ブランチの未コミット変更: runner が tick ごとに対象カード（既定ブランチの session カードで (b) に当たるもの）の `repo_root` で `git status --porcelain` を実行し（結果は短時間キャッシュ）、事実として純粋関数に渡す。DB には保存しない。git 管理外のカードにはコミットという解除条件が無いので、(b) は24時間で期限切れにする。

フォローアップ（既定値は PO 決定。「変更の確認」はノイズになりやすいので既定オフ）:

| kind | 既定 | トリガ | dedupe の artifact_ref | 自動クローズ | 新規タスクの置き場所 |
|---|---|---|---|---|---|
| approve（許可待ち） | オン | needs_input（許可待ち。hooks の permission、または hooks なしで `sessions/<pid>.json` が idle のまま最終ターンが未完了）。待ちの開始ですぐ作る | トリガのターン | 次のツール実行 / Stop / 人間入力 | 今日の「自分」先頭 |
| reply（返答） | オン | (1) your_turn かつ質問で終了し（締めの決まり文句を除く）、ターン終了から15分間人間入力が無い。(2) needs_input の AskUserQuestion（未回答。hooks の有無によらない）。(2) は待ちの開始ですぐ作る（D-049 (1)）。(3) AI カードで `y`（手動。D-066 (2)。下記） | トリガのターン（(2) は `<turn_id>:ask`、(3) は `<turn_id>:manual`） | 同セッションに人間入力（返答済み）/ 解決の兆候（解決済み（推定））/ 72時間（期限切れ）。手動は `e`（対応不要。D-031）。3.3.1 | 今日の末尾（UI は YOUR TURN 帯） |
| review_pr（PR レビュー） | オン | PR artifact が新規に open（`pr-link` の初出のみ。3.1）。状態を `gh` で確かめる前（unknown）は作らない。`gh` が無く確かめられないものも作る（下記の72時間の規則は同じ） | PR ref | 自分のレビューが付く / merged / closed | 今日の末尾 |
| resume_error（再開） | オン | error（状態が 1 時間で閉じた後も止まったままなら残す） | トリガのターン | 次のターンが成功 / 72時間（期限切れ。reply と同じく件数だけ数える。D-045） | 今日の「自分」先頭 |
| resume_error（再開できる。上限待ちの後） | resume_error と同じ設定 | 上限待ちの `until` を過ぎた（`trigger_at = until`。デーモンが止まっていた間に明けたものも作る。72時間より前のものは作らない規則は同じ） | `<turn_id>:limit` | 人間入力（`auto:human_input`）/ そのセッションの次のターン・Stop など（止まった状態でなくなった）。期限なし（`e` 対応不要まで残る。日をまたいでも残る）。同じ停止の上限待ちの `until` が伸びてまだ明けていなければ `superseded`・`auto:limit_extended` で閉じ（完了と数えない）、明けたら同じ行を開き直す（`trigger_at` を新しい `until` に。旧版の `auto:next_turn_ok` の行も同じ。`dismissed` は開き直さない） | 今日の「自分」先頭 |
| check_changes（変更の確認） | **オフ** | your_turn・編集あり・PR なし | トリガのターン | コミット / PR 作成 / 手動 | 今日の末尾 |
| merge_pr | v1 | approved かつ CI green | PR ref | merged / closed | — |

- **needs_input は必ずタスクにする（D-049 (1)）**: AI が止まって自分を待っている瞬間を YOUR TURN と通知に出すため、許可待ちは approve、AskUserQuestion は reply を、hooks の有無によらず待ちの開始ですぐ作る（hooks なしでも `pending_question` とプロセスの idle から分かる）。AskUserQuestion の reply は、質問に答えてターンが進んだ（`pending_question` が外れた）ときに `done` / `auto:answered` で閉じる（時刻は「最後の活動」と now の早い方）。それ以外の閉じ方（人間入力・解決の兆候・`e`・72時間）は (1) と同じ。
- **手で作る返答タスク（D-066 (2)）**: 質問の判定漏れの手段。`POST /api/work-items/:id/reply-task` で、カードの最後のターン（`started_at` が最大のもの）をトリガにした reply を作る。`artifact_ref` は `<turn_id>:manual`（同じターンで閉じた後に作り直すときは `<turn_id>:manual:<n>`。閉じた行は残るので dedupe_key を使い回せない）、`trigger_at` は作った時刻（72時間の期限はここから数える）、タスクは `source='manual'`・`source_ref='follow_up:<id>'`・題名は自動生成と同じ `followup.reply`、置き場所は今日の末尾。カードに open / snoozed の reply（どの種類でも）が既にあれば何も作らず、それを返す（`created: false`）。カードに開いているタスク（完了・取り消し以外）が既に結び付いているとき（open / snoozed のフォローアップのタスク（review_pr など種類を問わない）か、カードのセッションを起動した頼んだタスク（D-107））も作らず、そのタスクを返す（同じ件が同じ日に2つ並ばないように。応答の `taskId`。UI は「この件はもうタスクになっています」と出してそのタスクの詳細パネルを開く）。ターンが無いカード（PR の head ブランチだけのカードなど）は、トリガのターンなし（`trigger_turn_id` は NULL）・`artifact_ref` は `card:manual`（作り直しは `card:manual:<n>`）で作る。この返答タスクは「返答済み」では閉じず、解決の兆候か72時間で閉じる。
  - 作ったら、そのターンを「質問で終了」とみなす: 返答タスクが閉じるまで your_turn の (c) に数え（理由 `question`）、待ち区間もターン終了から始まる（放置に数えるのはタスクが出てから。D-045 (1)）。同じターンの自動の reply（(1)）は作らない。
  - 閉じ方は (1) と同じ（同じセッションへの人間入力・解決の兆候・`e`・72時間）。your_turn の条件から外れても `auto:status_left` では閉じない。
- reply を15分待ってから生成するのは、S3 で即時生成した27件のうち25件が次の人間入力で自動クローズされ、待ちの76%（93/122）が15分未満だったため。`trigger_at` はターン終了時刻のままにする。質問の your_turn が72時間で done になるのと同時に、reply タスクも「期限切れ」で閉じる（D-020。以前の「reply タスクは自動では閉じない」は廃止）。閉じ方4種の詳細は 3.3.1。
- review_pr の自動クローズ条件のうち「自分のレビューが付く」は、個人開発ではほぼ起きない（自分の PR は自分で承認できない）。実際には merged / closed で閉じる（S3 では10件すべて）。
- dismissed は行を残すので、同じ dedupe_key では再生成しない。新しいターンで再び質問されたら別キーになり、新規に生成する。
- 同じ WorkItem で reply / approve が新しく生成されたら、古い open なものは `superseded` で閉じる（1枚のカードに「返答」が積み上がらないようにする）。
- 自動クローズ時は、タスクを `done`・`auto_completed=1` にし、`task_time_entry(source='followup_estimate')` を追加する。推定は「`engaged_at` があれば `engaged_at` からクローズまで（上限30分）、無ければ定数3分」とする（未確定事項 U7）。
- snooze は `snooze_until` を過ぎたら tick で `open` に戻す。スヌーズした区間は `snoozes_json` に残し、待ちの集計外（`snoozed`）に使う（D-032）。
- **72時間より古い待ちからはタスクを作らない（D-045 (3)）**: どの種類も、`trigger_at`（待ちの開始。reply・resume_error はターン終了、review_pr は PR の初出、approve は許可待ちの hook）が now より72時間（`reply.expire_hours`）以上前なら作らない。初回の取り込み（バックフィル）で過去の待ちが大量にタスクになるのを防ぐ。デーモンが72時間以上止まっていた後も同じ。カードと待ち区間は履歴として残るが、タスクが無いので放置には数えない（3.3.1）。
- **自動生成タスクの題名（D-046）**: 文字列で保存せず、`task.title_key`（種類）と `task.title_params`（作成時点の AI のタイトル、リポジトリ名、ブランチ、PR 番号、PR のタイトル）を保存し、表示時に i18n で組み立てる（`title` は ''）。英語が正（D-023）。CLI の出力は英語。辞書は M2-12 までは `packages/core/src/i18n/task-title.ts` に置く。

| title_key | 英語 | 日本語 |
|---|---|---|
| `followup.reply` | Reply: {title} | 返答: {title} |
| `followup.approve` | Approve: {title} | 許可: {title} |
| `followup.review_pr` | Review PR #{pr}: {prTitle ?? title} | PR #{pr} をレビュー: {prTitle ?? title} |
| `followup.resume_error` | Resume: {title} | 再開: {title} |
| `followup.check_changes` | Check changes: {title} | 変更を確認: {title} |

{title} が無い（タイトルを保存しない設定など）ときは `{repo}#{branch}`、それも無ければ「AI work」/「AI の作業」。

PR 状態の取得（Phase0 の暫定）: GitHub 連携は v1 の範囲だが、review_pr の自動クローズに PR 状態が要るので、**ユーザーの `gh` CLI がログイン済みなら** `gh pr view <n> -R <repo> --json state,reviewDecision,reviews,title,url,headRefName,mergedAt,closedAt` を open な PR に対して5分ごとに実行する（`headRefName` は初回に `ai_artifact.head_ref` へ入れ、カードへの帰属に使う。`mergedAt` / `closedAt` は `ai_artifact.state_changed_at` に入れ、待ちの終点と解決の兆候に使う）。`gh` が無ければ自動クローズは手動完了で代用し、`state_changed_at` は状態の変化を検知した時刻で代用する（推定）。

#### 3.3.1 在席と AI の待ち（U22 の決定。PO 決定 D-019〜D-022・D-105・D-106・D-110。ADR 0013）

方針: 「AI が自分を待っていた時間」を、放置（応答が遅れた時間）とそれ以外に分けて数える。夜間・会議中・ターン終了直後を放置に入れない。これで S3 の「7日合計168時間」のような意味のない値をなくす。指標は事実の合計として出し、点数や評価にはしない。

実データでの検証では、それでも Idle がその日の勤務時間（当時。D-105 で在席に置き換えた）を大きく超えた（並列の待ちの積み上げ、タスクとして見せていない your_turn の無期限の加算、古い履歴のタスク化）。そこで次の3原則を置く（PO 決定 D-045）:

1. YOUR TURN にタスクとして見せている間（reply / review_pr / approve / resume_error のフォローアップが open の間）だけ放置に数える。タスクを生成しない待ち（編集ありだけの your_turn、既定オフの check_changes など）は区間として記録するが、放置に数えない。needs_input は必ずタスクを作る（D-049 (1)）
2. 日別 Idle は「どれか1つでも放置中だった時間」の和集合（壁時計）で数える。在席の時間を超えない。リポジトリ別も repo ごとの和集合。カード単位の値はカード単位で数える
3. 初回取り込み（バックフィル）では、待ちの開始が72時間より古いものからタスクを作らない（3.3）。resume_error も reply と同じく72時間で期限切れにする

**在席（D-105・D-110。ADR 0013）**: 勤務時間（D-018 の自動の勤務時間・手での修正・D-084 の勤務日の切れ目・いつもの勤務時間）はなくした。放置は「AI が待っている時間のうち、自分が Mac を使っていた時間」で数える。

| 項目 | 規則 |
|---|---|
| 取り方 | デーモンが 30 秒ごとに「最後の入力からの経過」を読む（Bun FFI の `CGEventSourceSecondsSinceLastEventType(HIDSystemState, AnyInputEventType)`。使えなければ `ioreg -c IOHIDSystem` の `HIDIdleTime`）。`ioreg -n Root -d1` の `IOConsoleUsers` から自分の uid の画面ロック（`CGSSessionScreenIsLocked`）とコンソール（`kCGSSessionOnConsoleKey`）を読む。権限は要らない。キー・ポインタ・アプリ名は読まない |
| 在席の定義 | 最後の入力から T 分（`presence.tail_min`、既定 5、2〜15）まで。区間の終わりはサンプルの時刻を超えず、次のサンプルで前の入力からの続きを足す。前のサンプルから 2 分以上空いたら（スリープ・停止）その間は不在で、空いた後は前のサンプルより後の入力だけを証拠にする（起動直後は1間隔より前の入力を使わない。ただし前回の最後の区間を 2 分以内まで見ていたなら、その続きとして扱う。D-139）。画面ロック中・別ユーザーに切り替え中は不在。純粋関数は `derive.presenceStep`（サンプル → 保存する区間）と `derive.expandPresence`（保存した区間 → 在席） |
| 保存 | `presence_span`（入力のあった区間: 最初と最後の入力の時刻と、続けて見ていた最後のサンプルの時刻 `seen_until` だけ。端末内だけで同期しない・`mutate()` を通さない）。T は保存のときに足さず、読むとき（放置・不在・朝の再開・日の確定・拡張の在席）に今の設定で足す（D-139）。設定を変えると過去の日も同じ規則で数え直す。入力の間が 2 分（T の下限）以内なら同じ区間を延ばし、それより長ければ新しい区間にする。新しい区間を足した（Mac に戻った）ら判定を走らせる。マイグレーション 0014 は既存の行の終わりから T（今の設定。書いた時点の値は分からない）を引く |
| ~~一日を閉じる（D-079・D-110 (1)）~~ | **D-192 で廃止**（閉じていた区間 `closed`・閉店モード・閉じた後の作業は無くなった。古い `excluded_by = 'closed'` の行は読めるが新しくは作らない）。履歴: Close the day（`daily_note.shutdown_done_at`）から、次の論理日の始まり（日付区切り）より後で最初に在席した時点（日付区切りをまたいで使い続けていれば日付区切り）までを `closed` にし、放置に数えない。閉店モードの通知の停止も同じ時点で解く。まだ在席していなければ終わりなし。再開（`POST /api/rituals/shutdown/reopen`）で閉店を解けばその時点で終わる。閉店〜再開の組（`usage_event` の `ritual_shutdown` / `ritual_reopen`（`ref` = 日付））も `closed`。もう一度 Close the day で閉じ直す（日報は更新扱い。持ち越しはしない。Carried over には最初の閉店で実際に移したタスクだけを出す。移したタスクは閉店時に `usage_event(kind='ritual_carry', ref='<日付>:<task id>')` に残す）。純粋関数は `derive.closedRanges`・`derive.firstPresentAt` |
| 本人の操作 | (1) AI セッションへの人間入力: `ai_turn.started_at`（`initiator IN ('human', 'queued')`）。(2) Turnlane 上の操作: `usage_event(kind='user_op')`（ブラウザと `turnlane` CLI からの状態を変える API 呼び出し。同じ1分の中は1件。MCP・カレンダーヘルパ・`/api/usage`・`ui_open`・Close the day と再開は含めない）。(3) タスクの完了（`auto_completed=0`）。放置の計算には使わない。3日ボードの左の列（作業した日。D-076）と閉じた後の作業に使う |
| 閉じた後の作業（D-079） | 閉じていた区間の本人の操作の件数と最初・最後の時刻。日報の事実（`DailyReport.afterClose`）と `turnlane stats` に記録する。日報の Markdown には出さない（仮置き） |
| 過去の値（D-110 (3)） | 在席の記録を始めた時刻を `idle.presence_since` に入れる（デーモンの起動時に無ければ今）。その論理日より前の待ち区間は、`turnlane rederive --wait --since` を指定しても作り直さない。マイグレーション 0009 は既存の区間を残し `off_hours` を `away` に読み替える。始めた日はその時刻より前が不在になる |
| 計画の目安（D-062・D-106） | 設定 `work_hours.planned`（キーは旧名のまま。曜日ごとの開始・終了。暦日の 0:00 からの時刻で、終了は 24:00 まで。既定は各曜日 10:00〜19:00）。稼働日（稼働曜日かつ祝日でない。M3-6）だけに当てはめる。空き時間（今日は「計画の目安 ∩ [今, 終わり]」、未来の日は計画の目安）、スヌーズの「明日朝」・`m` 明日、開いたときのスクロール位置・AI レーンの持ち越しの位置に使う。放置の計算には使わない。画面に「勤務」の言葉は出さない |

**待ち区間**: WorkItem ごとに、your_turn / needs_input だった期間を**事実の時刻から再生して**求める。`work_item_status_log` の `from_at` / `to_at` は「検知した時刻」で、デーモン停止中や初回バックフィルでは遅れるので使わない。過去にさかのぼる計算も同じ関数で行う。

| 端点 | 求め方 |
|---|---|
| 始点（your_turn） | your_turn の条件（3.3。(c) は締めの決まり文句を除く）を満たしたターンの `ai_turn.ended_at` |
| 始点（needs_input） | hooks あり: `PermissionRequest` / `Notification(permission_prompt, agent_needs_input)` の `hook_event.occurred_at`。AskUserQuestion（許可待ちの hook が無いとき）: 未回答の質問を出したターンの最終更新時刻（推定。`estimated=1`）。hooks なしの許可待ち（プロセスが idle）: 最後の活動の時刻（推定）。どちらも、作ったタスク（reply `<turn_id>:ask` / approve）の `trigger_at` から閉じた時刻までを区間にするので、答えた後も履歴に残る（D-049 (1)） |
| 始点（error） | `status='error'` のターンの `ended_at`（無ければ `started_at`）。D-045 で追加（resume_error のタスクが出ている間を放置に数えるため）。上限待ちのターンは期限なし（`:limit` の再開のタスクが閉じる・次のターン・人間入力まで）で、タスクが出るのは `until` から |
| 終点（最も早いもの） | (1) その WorkItem への人間入力（`initiator IN ('human', 'queued')` の `ai_turn.started_at`）、(2) フォローアップの `engaged_at`（⏎ で外部を開いた。ここからは「自分の応答」）、(3) WorkItem が your_turn を外れる事実（PR の merged / closed の `ai_artifact.state_changed_at`、アーカイブ、`manual_done_at`、タスクのない your_turn の72時間（3.3。D-048 (4)））、(4) 解決の兆候（返答タスクのある待ちだけ。下記）、(5) `e`（対応不要）の時刻、(6) 期限切れ（質問とエラーは72時間、git 管理外の編集は24時間）、(7) error の待ちは同じセッションの次のターンの開始、再開タスクが閉じた時刻、(8) 終わっていなければ now |

**タスクが出ている期間（D-045 (1)）**: 待ち区間に付くタスクは次のとおり。タスクが出ている期間は `[max(trigger_at, created_at), closed_at)`（閉じていなければ now まで）で、複数付くときは和集合をとる。始まりに `created_at` を使うのは、初回の取り込みやデーモンの停止中の待ちから後でタスクを作ったとき、見えていなかった過去に遡って放置に数えないため（起動中は待ちの開始・猶予の終わりの次の tick（60秒以内）で作るので、ほぼ `trigger_at` と同じ）。スヌーズ中（`snoozes_json`）は「出ているがスヌーズ中」として扱う。

| 待ち | 付くタスク |
|---|---|
| your_turn | そのターンを `trigger_turn_id` に持つ reply、カードの review_pr |
| needs_input（hooks） | 待ちの間に `trigger_at` がある approve |
| needs_input（AskUserQuestion） | そのターンの reply（`artifact_ref = <turn_id>:ask`。D-049 (1)） |
| needs_input（hooks なしの許可待ち） | そのターンの approve（hooks の許可待ちの区間に含まれないもの） |
| error | そのターンを `trigger_turn_id` に持つ resume_error |

check_changes は YOUR TURN 帯に出すタスクではないので数えない（既定オフ。オンにしても数えない）。設定でオフにした種類、72時間より古い待ち（タスクを作らない。3.3）も、タスクが無いので放置に数えない。

**区分**（1つの待ち区間を時刻で切り分ける）:

| 区分 | 定義 | 集計 | 描き方（ux-mvp 4.5） |
|---|---|---|---|
| 猶予 `grace` | 放置に数えうる時間（下の放置の条件をすべて満たす時間）に入ってから、合計15分（`wait.grace_min`。D-019、D-058）。始点からではない。1つの待ちにつき1回だけ | 放置に入れない | 細い点線 |
| 放置 `idle` | 猶予を除いて、一日を閉じていた区間の外で、在席していて（Mac を使っていた）、busy な予定と重ならず、タスクが出ていて（スヌーズ中でなく、時間に置いた開始の前でもない）時間 | 日別 Idle に入れる | 太い点線＋「idle 42m」 |
| 集計外 `excluded` | 一日を閉じていた（`closed`。D-110 (1)）か、在席の外（`away`。D-105）か、busy な予定と重なる（`event`）か、タスクが出ていない（`no_task`。D-045）か、タスクがスヌーズ中（`snoozed`。D-032）か、タスクを時間に置いていてその開始の前（`scheduled`。D-051）の時間。重なるときはこの順で先のものを採る | 入れない | 灰色の点線 |
| 期限切れ `expired` | 期限切れで終わった待ちの、猶予以外の全体（D-022） | 時間に入れず件数（Expired）だけ | 灰色の点線 |
| 自分の応答 | 待ちの終点（`engaged_at` か人間入力）までの自分の作業。自分レーンの実績（`task_time_entry`、推定式は U7） | 自分の時間（待ちではない） | 自分レーンの塗り＋AI 区間との点線 |

- 猶予の数え方（PO 決定 D-058）: 待ち区間をまず集計外（理由つき）と放置に分け、時刻順に見て放置の最初の15分を猶予にする。夜に始まった待ちは翌朝 Mac を使い始めた時点から、会議中に始まった待ちは会議の終わりから、スヌーズ中・時間に置いた開始の前に始まった待ちはスヌーズ明け・置いた開始から猶予になる。猶予は合計15分だけで、途中で会議などに入って出ても付け直さない（猶予の途中で入った場合は残りの分だけ続き、使い切った後なら出たところからすぐ放置）。待ちの始まりから数えると、夜や会議中に猶予を消化して、Mac に戻った時点・会議の終わりから即座に放置になってしまうため（デイビューの主役の場面「深夜 2:34 の依頼を朝 8:50 に確認 → Idle 0」と食い違う）。
- タスクがまだ一度も出ていない間（返答タスクは待ちの始まりから15分で作る。下記）は、タスクなし以外の条件（在席・予定と重ならない）を満たせば猶予に使う。在席中に始まった返答待ちは、従来どおり始まりから15分が猶予で、返答タスクが YOUR TURN に出る時刻と放置が始まる時刻が揃う。最後までタスクの無い待ち（W27）も最初の15分が猶予、残りが `no_task`。
- busy な予定: `calendar_event` のうち `status <> 'cancelled'`、`self_response <> 'declined'`、`availability IN ('busy', 'unavailable')`、`is_own_timeblock = 0`、カレンダーの役割が `source`。終日予定も availability が busy なら含める（EventKit の終日予定は既定で free）。自分の時間ブロック（`time_block`）は予定として扱わない。
- 待ちが日付区切りをまたぐときは時刻で論理日付ごとに分ける（D-084 の「前の日の勤務の続き」への寄せはしない）。
- 期限切れは期限が来た時点で確定するので、それまでの日の Idle には放置として出ていて、期限切れの時点で遡って外れる。日報（`daily_note.report_md`）は確定時の値のまま残る。Expired の件数は、返答タスクと再開タスク（resume_error。D-045）が期限切れになった論理日付に数える。git 管理外の編集（24時間）の期限切れも放置から外すが、タスクが無いので件数には数えない。
- スヌーズ中の待ちは放置に数えない（PO 決定 D-032。スヌーズは「後でやる」という本人の判断で、放置ではない）。待ちに付いたフォローアップがスヌーズされていた区間（`follow_up.snoozes_json` の `[開始, 終了]`。終了は `snooze_until`、それより前に閉じた・⏎ した・再びスヌーズした場合はその時刻）を集計外（`snoozed`）にする。待ち区間そのものは続く（終点は変わらない）。スヌーズが明けた後は通常どおり区分する。
- 時間に置いたタスクは、置いた時刻（ブロックの開始）まで放置に数えない（PO 決定 D-051。スヌーズ D-032 と同じ扱い）。待ちに付いたフォローアップのタスクに時間ブロック（`time_block`。`deleted_at IS NULL`）があるとき、ブロックを作った時刻（`created_at`）から開始（`start_at`）までを集計外（`scheduled`）にする。開始を過ぎても手を付けなければ（待ちが続けば）、そこから通常どおり区分する（在席していれば放置）。「今日」にしただけで時刻の無いもの（`scheduled_date` だけ）は従来どおり数える。待ち区間そのものは続く（終点は変わらない）。作る前に遡っては外さない。ブロックの履歴は持たないので、ブロックを移せば新しい開始まで、消せば集計外が無くなり、次の再計算で放置に戻る（区間はキャッシュ。3.3.1 の計算）。
- open な PR の待ち（your_turn の (a)）は期限切れにならず、merged / closed まで在席の間は放置として数え続ける（マージされない PR のレビュー待ちも期限なく数える。D-032）。ただし review_pr のタスクが出ている間だけ（D-045。自分のレビューで閉じた後や、72時間より古く作らなかった PR は数えない）。

**返答タスクの閉じ方（D-020・D-021）**

| 閉じ方 | 条件 | follow_up | タスク | 待ちの終点 |
|---|---|---|---|---|
| 返答済み | 同じセッションに人間入力 | `done` / `auto:human_input` | `done`、`auto_completed=1` | 人間入力（`engaged_at` があればその時刻） |
| 解決済み（推定） | トリガより後に、同じ `repo_root`・ブランチで次のどれか: コミット、別セッションの開始（トリガより後に始まったセッションの人間入力。前から並行して開いていたセッションへの入力は数えない）、その head ブランチの PR の merged。コミットと別セッションは、問いを出したセッションのプロセスが生きている（`live_status` が `busy` / `idle`）間は使わない（`gone` か取れない（null）ときだけ） | `done` / `auto:resolved:commit` / `auto:resolved:new_session` / `auto:resolved:pr_merged` | `done`、`auto_completed=1`（UI は「~ resolved」） | 兆候の時刻 |
| 対応不要 | `e`（1キー。D-031）、またはシャットダウンでの一括処理 | `dismissed` | `canceled` | 操作の時刻 |
| 期限切れ | トリガのターン終了から72時間（`reply.expire_hours`） | `expired` / `auto:expired` | `canceled`、`auto_completed=1` | 72時間後。ただし放置に入れない |

- 「質問で終了」の判定（D-066 (1)）: 最終 assistant メッセージの最後の段落のどこかに `?` / `？`、または答え・判断を求める言い回し（「回答を待っています」「教えてください」「決めてください」「選んでください」「どうしますか」「よいですか」「確認させてください」、let me know / which do you prefer / should I / please confirm 等）がある。作業の依頼（「〜してください」）は含めない。詳細は ai-session-ingestion 4.3。
- 締めの決まり文句の質問（「他に何かありますか？」「必要であれば〜してください」「他に何かあれば」「Anything else?」「Let me know if you need anything」など）では返答タスクを作らず、your_turn の (c) にも数えない。最後の段落で判定に当たった文がすべて締めの決まり文句なら締めとする。判定はアダプタがパース中にローカルで行い（`packages/collectors/src/closing-question.ts` の日本語・英語の表）、`ai_turn.ended_with='question'` と `ai_turn.closing_question` に真偽値だけを残す。本文は保存しない（ADR 0005）。判定を変えたらアダプタの `parserVersion` を上げ、起動時の読み直しで残っているトランスクリプトに反映する（3.1。D-066 で claude-code・codex を 2 にした）。
- 返答タスクは、質問で終わった your_turn でターン終了から15分間人間入力が無いときに作る（既決。D-058 でも変えない）。在席中に始まった待ちでは猶予と同じ15分なので、返答タスクが YOUR TURN 帯に出るのと放置が始まるのは同じ時刻になる（猶予の間も行は末尾に薄く `猶予 · あと 12m` で出す。タスク・件数・通知・放置には入れない。D-245）。夜や会議中に始まった待ちでは、タスクはその15分で出て、猶予は Mac を使い始めた時点・会議の終わりから始まる。
- 解決の兆候を見るのは返答タスクだけ。コミットは runner が tick ごとに、open な返答タスクがある `repo_root` で `git log -1 --format=%ct <branch>` を実行して調べる（committer 時刻がトリガより後なら兆候。結果は短時間キャッシュし、DB には保存しない。AI のコミットは `ai_artifact(kind='commit')` からも分かる）。別セッションの開始は、トリガのセッション以外で `started_at` がトリガより後の `ai_session` で、同じ `repo_root`・ブランチの人間入力ターンが始まったこと。既定ブランチの session カードも、同じ `repo_root`・既定ブランチで判定する。
- 未処理の返答タスクは、夕方のシャットダウン（M4-2）で一括して対応不要・明日へ・そのまま、を選べる。

**集計値**

| 値 | 定義 | 出す場所 |
|---|---|---|
| 日別 Idle | その論理日付の `ai_wait_segment(kind='idle')` の和集合の長さ（壁時計。複数の待ちが同時に放置中でも1回だけ数える。D-045 (2)）。区間は在席の間に限るので、その日に Mac を使っていた時間を超えない | 週ボードのヘッダ、日報、`turnlane stats` |
| 日別 Expired | その論理日付に `expired` になった返答タスク・再開タスクの件数 | 今日のヘッダ（D-025）、過去日のヘッダ、日報 |
| リポジトリ別の放置 | idle を WorkItem の `repo_root` ごとに和集合（git 管理外は「(no repo)」）。repo をまたいで同時に放置していれば両方に数えるので、内訳の合計は日別 Idle を超えうる | デイビュー、日報 |
| AI カードの「待ち」 | そのカードのその日の idle（カード内の和集合） | AI カード、詳細パネル（詳細パネルは猶予・集計外も内訳で出す） |
| 平均応答時間 | YOUR TURN のタスク（reply / review_pr / approve / resume_error）のうち、人が答えたもの（`done` で `close_reason` が `auto:human_input` / `auto:answered` / `manual` / `auto:next_turn_ok`、または `engaged_at` がある）の平均。1件の長さは壁時計ではなく、窓 `[trigger_at, min(engaged_at ?? closed_at, closed_at)]` のうち、その待ちの猶予と放置の区間（`ai_wait_segment` の `grace` / `idle`。結び付いた `follow_up_id` の区間、無ければ同じカードの区間）の和集合の長さ（D-057。Idle と同じ物差し）。閉じた後・不在・会議中・スヌーズ中・時間に置いた開始の前・タスクなし・期限切れは入れない。窓と重なる待ち区間が無いものは平均に入れない。純粋関数は `derive.countedResponseMs` | 要対応キュー（直近7日）、`turnlane stats`（直近 N 日。閉じた論理日付で数える）。日報には入れない |

- 計算: `packages/core/src/derive/time.ts` の純粋関数が、事実（`ai_turn`、`hook_event`、`follow_up`、`ai_artifact`、`calendar_event`、在席（`presence_span`）、一日を閉じていた区間、設定、now）から区間を返す。runner は影響を受けた WorkItem と日付の行を `wait_key` ごとに作り直して `ai_wait_segment` に書く（代入）。開いている待ちは60秒の tick で伸ばす。再計算のきっかけは、ターン・hook・フォローアップの変化、カレンダーの同期、閉店・再開、Mac に戻った（在席の新しい区間）、`presence.tail_min` の変更（区間は入力のあった区間で持つので、作り直す範囲の日は新しい T で数え直す。D-139）、tick。
- カレンダーのキャッシュは窓（7日前〜21日後。M3-2）から外れた予定を削除する。窓より古い日の待ち区間は、予定が消えると変わってしまうので自動では作り直さない（確定扱い）。`turnlane rederive --wait --since <date>` で明示したときだけ作り直す（在席の記録を始めた日より前は作り直さない。D-110 (3)）。
- 設定（`setting`）: `wait.grace_min`（既定15）、`reply.expire_hours`（既定72）、`presence.tail_min`（「使っていた」とみなす長さ、分。既定5、2〜15。D-110 (2)）、`idle.presence_since`（在席の記録を始めた時刻。デーモンが入れる）、`work_hours.planned`（計画の目安。D-106）。`work_hours.gap`・`work_hours.usual_days`・`work_hours.fallback` は D-105 でなくした（DB に残っていても読まない）。

### 3.4 HTTP API（`http://127.0.0.1:7317`）

セキュリティ:
- `127.0.0.1` のみにバインドする。`Host` ヘッダが `127.0.0.1:<port>` か `localhost:<port>` 以外なら 421（DNS rebinding 対策）。
- ブラウザ: `turnlane open` が `GET /auth?t=<token>` を開き、`HttpOnly; SameSite=Strict` のクッキーを発行してリダイレクトする。状態を変えるリクエストは `Origin` が自分自身であることも検証する。
- CLI / MCP / ヘルパ: `Authorization: Bearer <token>`。
- 入出力は `packages/core/src/types.ts` の Zod スキーマで検証する（`@hono/zod-validator`）。web と cli は `hc<AppType>` で型付きクライアントを得る。

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/auth?t=` | ブラウザ認証（クッキー発行） |
| GET | `/api/health` | 稼働状況、DB、各ソースの健全性、ヘルパ接続 |
| GET | `/api/events` | SSE（`task`, `work_item`, `follow_up`, `calendar`, `source`, `day_boundary`） |
| GET | `/api/board?from=YYYY-MM-DD&days=7` | 週ボード: 日付ごとの予定・タスク・AIカード要約・容量（予定/計画/空き）・計画の目安・Idle・Expired 件数。今日は YOUR TURN 帯の項目（未処理の自分の番。状態の重さ → 待ちの長い順）と、今日の AI 稼働区間・待ち区間（区分つき） |
| GET | `/api/day/:date` | デイビュー: 予定、時間ブロック、実績、AI 稼働区間、待ち区間（猶予・放置・集計外・期限切れ）、自分の応答区間、リポジトリ別の放置 |
| GET | `/api/inbox` | 日付なしタスク |
| POST | `/api/tasks` | 作成（`{title, date?, estimateMin?, projectId?, notes?, source, external?: {source, id, url?}}`。`raw` を渡すと NL パーサを通す）。`external` があれば `(external.source, external.id)` で冪等: 新規は 201 `{task, created: true}`、既存は 200 `{task, created: false}`（タイトル等は上書きしない）、ユーザーが削除済みなら 200 `{task: null, created: false, skipped: 'deleted'}` |
| GET | `/api/tasks/by-external?source=&id=` | 外部の識別子でタスクを引く（無ければ 404） |
| POST | `/api/tasks/parse` | NL パーサのプレビュー（チップ表示用） |
| PATCH | `/api/tasks/:id` | タイトル、メモ、見積、優先度、プロジェクト、ハイライト |
| POST | `/api/tasks/:id/move` | `{date|null, beforeId?, afterId?}` 日付移動と並べ替え（fractional index を計算） |
| POST | `/api/tasks/:id/complete` / `uncomplete` / `start` | 完了・未完了・開始（ワンタップ実績） |
| DELETE | `/api/tasks/:id` | 論理削除（UI は ⌘Z で `restore`） |
| POST | `/api/tasks/:id/restore` | 削除の取り消し |
| POST | `/api/time-blocks` | 作成（`{taskId?, title?, startAt, endAt}`。Turnlane の中だけ。カレンダーには書かない。D-093） |
| PATCH / DELETE | `/api/time-blocks/:id` | 移動・伸縮・削除 |
| GET | `/api/free-slots?date=&minMinutes=` | 空き枠（予定と時間ブロックを差し引く。`s` キーと MCP で使う） |
| GET | `/api/work-items?date=&days=&status=` | AIカード一覧。`date`（既定は今日）から遡って `days` 日分を、日ごとの AI 時間・Idle・Expired・リポジトリ別の放置と一緒に返す（`turnlane ai` が使う。M1） |
| GET | `/api/work-items/:id` | 詳細（ターン、成果物、時間内訳、フォローアップ、ソース） |
| PATCH | `/api/work-items/:id` | `titleUser`、`hidden`、`manualDone`、`projectId` |
| POST | `/api/work-items/:id/merge` | `{intoId}` 統合（統合元に `merged_into_id` と `deleted_at`、フォローアップと待ち区間を統合先へ付け替え。m2-api 19章） |
| POST | `/api/work-items/:id/check-task` | AI カードを自分レーンへ落としたときの確認タスクと時間ブロック（m2-api 19章） |
| POST | `/api/open` | `{followUpId | workItemId, action?}`。タスクの種類ごとの既定の開き先と他の開き方（D-059）。開く先はサーバーが ID から解決し、任意のパス・URL・コマンドは受け付けない。`GET /api/open/options`、`GET /api/open/apps`。m2-api 13章（旧 `POST /api/work-items/:id/open` を置き換えた） |
| GET | `/api/queue` | 要対応キュー（状態の優先順。YOUR TURN のタスクがあるカードだけ。D-048 (4)、3.3） |
| POST | `/api/work-items/:id/reply-task` | AI カードの `y`: 返答タスクを手で作る（D-066 (2)、3.3）。応答 `{followUp, created, taskId}`。open / snoozed の reply か、開いているタスクが結び付いていれば作らず `created: false`（そのタスクを返す）。ターンが無いカードはトリガのターンなしで作る |
| POST | `/api/follow-ups/:id/engage` / `snooze` / `dismiss` / `complete` / `reopen` | ⏎ / s（スヌーズ）/ e（対応不要）/ Space / 完了の取り消し（D-139 (3)） |
| POST | `/api/follow-ups/bulk-dismiss` | `{ids}`。シャットダウンでの一括の対応不要 |
| GET | `/api/calendars` / PATCH `/api/calendars/:id` | 一覧と役割（source / ignored。D-093 で writeback をやめた） |
| POST / PATCH / DELETE | `/api/calendar-events`、`/api/calendar-events/:id` | 予定の作成・編集（題名・開始・終了・カレンダー）・削除（D-093。m2-api 24章） |
| GET / POST | `/api/calendar/timeblock-events`、`/api/calendar/timeblock-events/cleanup` | M3-3 で書いた時間ブロックの予定の件数・期間と、確認後の削除（D-093） |
| POST | `/api/calendar/sync` | 窓の再取得 |
| GET | `/api/calendar/status` | ヘルパの接続・権限・版、最後の同期、カレンダーの役割ごとの数、祝日カレンダー（自動 / 手動 / なし）と今後の祝日、稼働曜日・今日が稼働日か・次の稼働日（M3 の A） |
| GET / PUT | `/api/config`、`/api/config/:key` | `turnlane config` 用。既知のキーだけ（`packages/core/src/config.ts`）。PUT は `{ value }` を zod で検証して `mutate()` で書く（M3-6） |
| GET | `/api/rituals/morning?date=` | 夜間の変化（前回の閉店以降に AI が動いた WorkItem の事実と、完了したもの）、持ち越し候補、次の稼働日、朝の計画を終えた時刻。今日の容量は `/api/board` の今日の列を使う（m2-api 16章） |
| POST | `/api/rituals/morning/complete` | `{date?}`。`morning_done_at` を記録する（14日カウント）。ハイライト（`highlightTaskId`）は確定デザインに無いので受けない |
| GET | `/api/rituals/shutdown?date=` | 未完了タスク、未完了 AI、日報の下書き |
| POST | `/api/rituals/shutdown/complete` | `{memo}`。日報を確定し、閉店モードにする |
| GET | `/api/reports/daily/:date?format=md` | 日報 Markdown |
| GET / PUT | `/api/daily-notes/:date` | 日報メモ等 |
| POST / PUT | `/api/daily-notes/:date/summary` | 日報の AI 要約の生成（`{lang?}`）と手での修正（`{summary}`）（M4-6） |
| GET | `/api/summary/tools` | 要約に使う `claude` / `codex` の検出結果（M4-6） |
| GET / POST / PATCH | `/api/projects` | プロジェクトとリポジトリの対応付け（`repoPaths`。`GET /api/projects/repos` で候補。m2-api 19章） |
| GET | `/api/sources` / PATCH `/api/sources/:id` | 取り込み元の一覧・オン/オフ・除外ルール |
| POST | `/api/sources/rescan` | 再検出と再走査 |
| GET / PATCH | `/api/settings` | 日付区切り、フォローアップ種別、通知、プライバシーモード、24時間ルール、待ちの猶予（15分）、返答タスクの期限（72時間） |
| GET | `/api/search?q=&limit=` | ⌘K 用（タスク・AIカード・予定。PR 番号・リポジトリ名・ブランチ。m2-api 17章） |
| POST | `/api/usage` | UI の利用イベント（ui_open 等） |
| GET (WS) | `/internal/ek` | カレンダーヘルパの接続口 |
| POST | `/api/admin/backup` / `reingest` / `rederive` | 保守 |

### 3.5 MCP ツール（`turnlane mcp`、stdio）

登録: `turnlane mcp install`（D-145。検出した Claude の各設定ディレクトリのユーザーのスコープと、Codex の `config.toml` の `[mcp_servers.turnlane]`。方式は 3.6.2）。`turnlane mcp` はデーモンの HTTP API を叩くだけで、DB を直接開かない。

| ツール | 入力 | 出力 | 備考 |
|---|---|---|---|
| `add_task` | `title`, `date?`, `estimate_min?`, `project?`, `notes?`, `source?`, `external_id?`, `url?` | `{task, created, skipped?}` | `task.source=mcp`、`source_ref=mcp:<clientInfo.name>:<cwd>`。既定は Inbox。`source` と `external_id` は両方指定か両方省略（片方だけはエラー）。指定時は `task.external_source` / `external_id` / `external_url` に入れ、3.4 の `POST /api/tasks` と同じ規則で冪等にする（同じものを何度呼んでも1件。ユーザーが削除したものは作り直さない）。UI に「<source または client 名> が1件追加しました [元に戻す]」、カードに出所の印（`source` の表示名と外部リンク） |
| `list_tasks` | `date?`（既定は今日）, `include_done?` | タスク一覧 | |
| `get_today` | — | 今日の予定・タスク・時間ブロック・空き時間・要対応件数 | 会話の冒頭で使う想定 |
| `get_day` | `date` | 同上（任意の日） | |
| `get_free_slots` | `date`, `min_minutes` | 空き枠 | |
| `schedule_task` | `task_id`, `date`, `start?`（HH:MM）, `duration_min?` | 更新後のタスク / 時間ブロック | `start` 指定時はタスクの時間ブロックをその時刻に置く（既にあれば動かし、無ければ作る。ブロックはタスクに1つ）。`start` 無しで日付を変えたら、時間に置いたタスクのブロックは同じ時刻のまま日をずらす（ボードのキーの移動と同じ。m2-api 14章） |
| `complete_task` | `task_id`、または `source` + `external_id` | 更新後のタスク | 外部側で完了したものを閉じる用途。見つからなければエラー |
| `list_your_turn` | — | 要対応キュー（WorkItem、種別、経過時間） | |
| `get_ai_work` | `date?` | その日の AIカード（タイトル、状態、AI時間） | 本文は無いので安全 |
| `get_daily_report` | `date?` | 日報 Markdown | |

外部サービスからの取り込み: Turnlane は外部サービスの API を呼びに行かない（ADR 0008）。外部側（そのサービスの CLI・MCP クライアント・利用者のスクリプト）が `add_task` / `turnlane add --source --external-id` / `POST /api/tasks` を呼ぶ。`source` は呼び出し側が名乗る小文字の識別子（`^[a-z0-9._-]{1,64}$`）で、Turnlane 側に登録は要らない。外部側の更新（タイトル変更など）を反映する upsert は Phase0 では作らない（必要になったら `add_task` に `update: true` を足す）。

安全設計: 削除・一括更新のツールは作らない。`log_ai_work`（当初案にあった、AI 作業を手で記録するツール）は自動取り込みと重複するので Phase0 では作らない。

### 3.6 turnlane コマンド

| コマンド | 内容 |
|---|---|
| `turnlane self-install` | バイナリを `~/.local/bin` へ、LaunchAgent（デーモン・ヘルパ）を登録して起動 |
| `turnlane daemon start|stop|restart|status|logs [-f]` | launchctl の薄いラッパ |
| `turnlane open [board|day|queue]` | ブラウザで開く（認証付き URL） |
| `turnlane add <text...> [--date] [--est] [--project] [--note] [--source <s> --external-id <id> [--url <u>]]` | タスク追加。引数全体を NL パーサに通す。`--source` / `--external-id` は MCP `add_task` と同じ冪等規則（終了コード: 作成 0、既存・削除済みでスキップも 0、`--json` で `created` を返す）。デーモン停止中は `spool/cli-*.jsonl` に書き、起動時に取り込む（spool 経由でも冪等） |
| `turnlane today [--json]` | 今日の予定・タスク・要対応 |
| `turnlane ls [--date|--inbox] [--json]` / `turnlane done <id>` | 一覧・完了。一覧の ID は「その一覧の中で一意になる最短の接頭辞（最低8文字、`-` で終わらない）」（UUIDv7 は先頭が時刻なので、近い時刻に作ったタスクは先頭8文字が同じになる）。ID を受けるコマンド（`done` / `edit` / `rm`）は完全な ID か、今日の前後7日と Inbox の中で一意な接頭辞（`-` の有無は問わない）を受け、曖昧なら候補（区別できる接頭辞・題名・日付）を出して終了コード 1 |
| `turnlane edit <id> [--title] [--date YYYY-MM-DD | --inbox] [--est <分> | --no-est] [--project <名前> | --no-project] [--json]` | タスクの編集（`PATCH /api/tasks/:id` と `POST /api/tasks/:id/move`。詳細パネルと同じ API）。プロジェクトは名前で指定し、無ければ作る（`turnlane add` の `#project` と同じ）。MCP には編集のツールを作らない（3.5 の安全設計） |
| `turnlane rm <id>` | タスクの論理削除（`DELETE /api/tasks/:id`。外部の識別子の付いたものは削除後に同じ識別子で送られても作り直さない） |
| 共通 | どのサブコマンドも `--help` / `-h` でそのコマンドの使い方を出して 0（実行しない）。`turnlane help [<command>]` も同じ。未知のオプション・余分な位置引数（例 `turnlane ls inbox`）はエラーにして使い方を出し、終了コード 2。`--` より後は位置引数（`-` で始まる題名）。`turnlane hook` は従来どおり未知の引数を無視する（`--help` だけ使い方） |
| `turnlane ai [--date|--days 7] [--json]` | AIカード一覧（取り込みの確認用。M1 の完了条件に使う） |
| `turnlane ai run <起動 ID>` | 「AI に頼む」が端末に入力する。依頼を1回だけ受け取り、Claude Code / Codex を引数の配列で起動して終了コードを返す（D-107。ADR 0014、m2-api 27章） |
| `turnlane queue [--json]` | 要対応キュー |
| `turnlane report [date] [--copy]` | 日報 Markdown（`--copy` で pbcopy） |
| `turnlane hook --tool <ToolId> [--managed-by turnlane]` | hooks から呼ばれる。`--tool` はアダプタの ToolId をそのまま受ける（Phase0 は `claude_code` / `codex`。ADR 0009）。stdin の JSON から許可リスト（`@turnlane/collectors/hook-allowlist`）のキーだけを取り出し、spool に1行追記して exit 0。デーモンとは通信しない。`--managed-by turnlane` は設定ファイル上の識別用で読み飛ばす（未知の引数も無視して exit 0）。spool には `config_root`（`CLAUDE_CONFIG_DIR` / `CODEX_HOME`、未設定なら既定のディレクトリ）も残す（S5） |
| `turnlane hooks install|uninstall|status [--claude-dir <dir>]... [--codex] [--dry-run]` | 識別子付きで冪等に追加・削除する。方式は 3.6.1（S5）。変更があるときだけ書き換え前に `<実パス>.bak-turnlane-<ts>` を作る。`--dry-run` で差分を表示 |
| `turnlane sources [list|rescan|health]` | 取り込み元と縮退レベル |
| `turnlane calendar authorize|status|calendars|cleanup-timeblocks|holidays|sync|install|uninstall` | ヘルパの権限取得（`open` でダイアログ）、状態（接続・権限・予定の書き先（Calendar.app のデフォルトカレンダー）・Holidays from・次の稼働日）、カレンダー一覧と役割（`--role <id> source|ignored`）、M3-3 で書いた時間ブロックの予定の削除（`cleanup-timeblocks [--dry-run] [--yes]`。件数と期間を出し、確認してから消す。D-093）、祝日カレンダー（`--set <id>...|--none|--auto`）、窓の再取得、ヘルパの配置と LaunchAgent の登録・削除（M3 の A。[手順](../dev/m3-a.md)） |
| `turnlane config [get [<key>] | set <key> <json>]` | 設定の読み書き（既知のキーだけ、値は zod で検証。M3-6） |
| `turnlane mcp` | stdio MCP サーバ（引数なし。登録した Claude Code / Codex が起動する） |
| `turnlane mcp install|uninstall|status [--claude-dir <dir>]... [--codex] [--dry-run] [--bin <path>] [--json]` | Claude Code / Codex のユーザーのスコープに MCP サーバ `turnlane` を登録する・外す・状態（登録済み / 未登録 / 別の turnlane を指す）。対象の選び方・退避・`--dry-run` は hooks と同じ。方式は 3.6.2（D-145） |
| `turnlane export --json [--out]` / `turnlane backup` | エクスポート、即時バックアップ |
| `turnlane reingest [--source]` / `turnlane rederive` | 再取り込み（削除しない）、再判定 |
| `turnlane doctor` | 設定・権限・hooks の受信状況・MCP の登録・DB のプライバシー監査（長文フィールドの検出）・バージョン範囲を点検 |
| `turnlane stats [--days 14]` | 連続利用日数、週あたりのフォローアップ処理数（主要指標）、平均応答時間 |
| `turnlane fixtures capture --tool <t> --session <id>` | 開発用。実データから匿名化フィクスチャを作る（`packages/collectors/scripts/anonymize.ts` を呼ぶ） |

デーモンの稼働確認（`open`・`ai`・`queue`・`report`・`today`・`ls`・`done` など「動いていません」を出すコマンド）: health が 1 回で返らなくても、launchd に `dev.turnlane.daemon` が登録されていれば、起動直後の読み直しなどで応答が遅れているだけのことがあるので、コマンドの始めから最長 5 秒 health を待ってから判定する。登録が無ければすぐに案内を出す。`turnlane hook` はデーモンと通信しないので対象外。

`turnlane hook` の性能目標: 起動から終了まで 50ms 以内（S4 で計測。全コマンド入りの `turnlane` で p50 7.5ms / p95 8.9ms）。spool への書き込みは `O_APPEND` で1回の `write`、1行 4KB 未満に収める（原子性のため。超える場合はキーを落とす）。

- 目標の前提となるビルド条件（ADR 0007、0009）: `turnlane` は `--minify --bytecode --format=esm` でビルドし、エントリは引数を見てからサブコマンドのモジュールを動的 import する。`hook` のモジュールは `node:fs`、`hook/` 内のファイル、`@turnlane/collectors/hook-allowlist`（import を持たない定数モジュール）以外を import しない（Biome のルールで守る）。どちらかを欠くと p95 が 17〜33ms に悪化する。
- 新しいバイナリの初回実行（macOS の Gatekeeper / コード検査で約 1 秒）は目標の対象外とする。`turnlane self-install`・`turnlane hooks install`・更新処理の最後に `turnlane --version` を1回実行して検査を済ませておく。

#### 3.6.1 hooks のインストール方式（S5 の決定。[レポート](../spikes/s5-hooks-coexistence.md)）

**識別**: 設定ファイルに未知キーを足さない（Claude は現バージョンでは許容するが保証が無く、Codex は hooks.json のトップレベルの未知キーでファイル全体を読み捨てる）。`type: "command"` かつ command が語として `--managed-by turnlane` を含むハンドラ（正規表現 `(^|\s)--managed-by\s+turnlane(\s|$)`）を Turnlane のものとみなす。似た文字列（`turnlanex` など）は他ツール扱い。command は `'<dl の絶対パス>' hook --tool <ToolId> --managed-by turnlane`（パスは単一引用符で囲む）。

**置き方**:
- イベントごとに、Turnlane のハンドラを1つだけ入れた自分専用のマッチャーグループ（`matcher` なし）を配列の**末尾**に足す。他ツールのグループの中には入れない（Codex の信頼承認の鍵は位置なので、先頭や途中に入れると他ツールの承認が外れる）。
- 既にある場合は**同じ位置で置き換える**（turnlane のパスやオプションが変わったとき）。重複していたら最初の1つに寄せる。
- 他ツールのグループに混ぜ込まれた Turnlane のハンドラは外す（グループは残す）。対象外になったイベントの Turnlane のエントリは install のときに外す。

| | Claude Code | Codex |
|---|---|---|
| ファイル | 検出した各設定ディレクトリの `settings.json` | `$CODEX_HOME/hooks.json`（既定 `~/.codex`） |
| イベント | SessionStart、UserPromptSubmit、PermissionRequest、Notification、Stop、StopFailure、SessionEnd（7） | SessionStart、UserPromptSubmit、PermissionRequest、Stop、SessionEnd（5） |
| ハンドラ | `{"type":"command","command":…,"timeout":5,"async":true}` | `{"type":"command","command":…,"timeout":2}`（`async` は付けない。Codex 0.147 は `async: true` のハンドラを未対応として読み飛ばす。timeout は全イベント2秒） |
| 有効化後 | 即時に効く（設定ファイルの監視） | ユーザーが `/hooks` で承認するまで動かない（未承認の hook は黙って実行されない） |

PreToolUse / PostToolUse は高頻度なので入れない。許可が出たあとの needs_input の解除は、トランスクリプトの監視で拾う。

**書き込み**:
- 実パス（シンボリックリンクの先）を読み書きし、リンクは壊さない。
- 書式（インデント、末尾改行）を元ファイルから検出して同じ書式で書く。正規形（`JSON.stringify(v, null, indent)` + 改行の有無）のファイルなら install → uninstall でバイト一致に戻る。正規形でなければ意味を保ったまま書式が正規化される（`--dry-run` でその旨を出す）。
- JSON として読めなければ何もしない（コメント付き等）。
- 書く直前に再読込し、読んだ内容から変わっていたら中止する（Claude Code 等が同時に書いた場合）。
- 同じディレクトリの一時ファイルに書いて rename し、パーミッションを引き継ぐ。
- 変更があるときだけ `<実パス>.bak-turnlane-<ts>` を作ってから書く。変更が無ければ書かない。新規作成（ファイルが無い）はバックアップなし。uninstall でファイルは消さない（中身が `{}` になる）。
- Codex の hooks.json を新規に作る場合も、トップレベルは `hooks`（と任意の `description`）だけにする。

**状態の点検（`turnlane hooks status`）**:
- インストール状態: `none` / `installed` / `partial`（一部のイベントだけ）/ `outdated`（パスやオプションが違う）。
- Claude の無効化: ユーザー設定の `disableAllHooks`、管理設定（`/Library/Application Support/ClaudeCode/managed-settings.json`）の `disableAllHooks` / `allowManagedHooksOnly`。プロジェクト単位の `disableAllHooks` は全部は見られないので無音検知で拾う。
- Codex の無効化: config.toml の `[features] hooks = false` / `codex_hooks = false`（行単位の読み取り。TOML パーサは持たない）。0.147 では hooks は既定で有効。
- Codex の承認: Turnlane のハンドラの位置に対応する `[hooks.state."<hooks.json の実パス>:<event>:<グループ番号>:<ハンドラ番号>"]` があるか（hash の一致までは見ない）。最終的な判定は spool に hook が届いたか（`ai_source.hooks_state` の `pending_trust` → `receiving`）で行う。
- 無音検知: インストール済みで、トランスクリプトには活動があるのに hook が24時間届かない設定ディレクトリは `silent` にし、原因候補（プロジェクト単位の `disableAllHooks`、別の設定ディレクトリ、Codex の未承認・`modified`）を出す（ux-mvp 4.9）。

**Codex の再承認の案内（PO 決定 D-030）**: Codex の承認は位置で決まるので、Turnlane の後ろに他ツールが足したあとで Turnlane をアンインストールすると、そのツールの承認が外れる（`modified`）。Turnlane は config.toml の `[hooks.state]` を書き換えない（他ツールの承認状態を操作しない）。代わりに、アンインストール時に「Turnlane より後ろにあるグループ」を数え、1つ以上あれば dry-run とアンインストールの出力で「Codex の `/hooks` で次の hook を承認し直してください」と名前（command の先頭）を挙げて案内する。turnlane のパスが変わったとき（hash が command を含む）と新規インストールの後にも「Codex は `/hooks` で承認してください」と出す。


#### 3.6.2 MCP の登録（D-145）

Claude Code / Codex のセッションから Turnlane にタスクを入れられるように、MCP サーバ `turnlane` をユーザーのスコープに登録する。登録が無いと AI は Turnlane を知らない。

**場所**（Claude Code 2.1 系のバイナリと公式の docs で確かめた）:

| ツール | ファイル | キー |
|---|---|---|
| Claude Code（既定の `~/.claude`） | `~/.claude.json` | `mcpServers.turnlane` |
| Claude Code（`CLAUDE_CONFIG_DIR` のプロファイル。`~/.claude-*` など） | `<設定ディレクトリ>/.claude.json` | `mcpServers.turnlane` |
| Codex | `<CODEX_HOME>/config.toml`（既定 `~/.codex`） | `[mcp_servers.turnlane]` |

Claude Code は全体の設定を `join(CLAUDE_CONFIG_DIR || ホーム, ".claude.json")` に置く（設定ディレクトリに古い名前の `.config.json` があればそちら）。Turnlane も同じ順で選ぶ。対象のプロファイルの見つけ方は hooks と同じ（`~/.claude` と `~/.claude-*` のうち `projects/` か `settings.json` があるもの、`CLAUDE_CONFIG_DIR`。Codex は `~/.codex`（`CODEX_HOME`）があれば）。

**書く内容**: Claude は `claude mcp add --scope user` と同じ形 `{ "type": "stdio", "command": "<turnlane の絶対パス>", "args": ["mcp"], "env": {} }`。Codex は `command = "<絶対パス>"`、`args = ["mcp"]`。パスは `turnlane hooks` と同じく、実行中の turnlane（ビルド済みのとき）か `~/.local/bin/turnlane`（`--bin` で指定できる）。

**書き方**: `claude mcp add` / `codex mcp add` は呼ばない（CLI が無い・別名・複数アカウントの関数のことがある）。設定ファイルを直接書く。

- 触るのは `turnlane` の項目だけ。既にあれば `command` と `args` だけを直し、他の項目（`env` など）は残す。冪等で、変更が無ければ書かない
- 書く前に `<実パス>.bak-turnlane-<ts>` に退避する（パーミッションも同じ）。一時ファイル → rename。読んだ後に他のプロセスが書き換えていたら中止する
- `.claude.json`: JSON として読み、書式（インデント・末尾改行）を保って書く。サインインの情報・プロジェクトの状態も入っているので、出力・ログ・エラーに `turnlane` の項目以外を出さない（JSON の読み取りエラーの文言も出さない）。認証情報のファイル（`.credentials.json` など）は開かない
- `config.toml`: TOML のパーサで書き出さない（コメント・並び順を保つため）。`[mcp_servers.turnlane]` の表（とその下の表）を行単位で扱い、無ければ末尾に空行と表を足す。あれば `command` と `args` の行だけを置き換える。書いた結果を TOML として読み直し、`turnlane` 以外が同じで `turnlane` が期待どおりであることを確かめてから書く。`turnlane` がインラインの表やドット付きのキーで書かれているなど、安全に書き換えられないときは書かない
- `uninstall` は `turnlane` の項目（と Codex の下の表）だけを外す。install → uninstall で元のファイルに戻る（Turnlane が新しく作った `.claude.json` には空の `mcpServers` が残る）

**状態**: `installed`（command が今の turnlane のパスで、args が `["mcp"]`）、`none`、`outdated`（別の turnlane・args が違う・stdio でない）、`unreadable`。`turnlane mcp status`・`turnlane doctor`・設定 > AI の取り込み（取り込み元ごと。`GET /api/sources` の `mcpState`。同意の前は読まない）で出す。デーモンは turnlaned と同じ場所の turnlane を正しいパスとする（開発中で分からなければ command のファイルがあるか）。動いている Claude Code / Codex は起動し直すと読み込む。

**更新**: `turnlane self-install` は、`turnlane` の登録が別のパスを指していれば新しいパス（`~/.local/bin/turnlane`）に直す。登録の無いところには足さない。

**オンボーディング**: hooks の段の次に「AI から Turnlane を使えるようにする」段（`mcp`）を置く。同意した（取り込む）Claude Code / Codex の取り込み元にだけ登録する（`turnlane onboarding mcp [--dry-run]`。onboarding.md 4.5a）。

---

## 4. タスク分解

**見積の扱い（D-042）**: 見積の人日は「人が集中して実装した場合の相対的な大きさ」で、着手の順序と、遅れたときに何を削るか（4.9）の判断に使う。日程の約束には使わない。実装は Claude Code / Codex のエージェントが行うので、人日はそのまま暦日にならない（例: M0 は見積 5.5人日に対し、実作業は1セッション内で終わった）。進捗はマイルストーン（とその段階 A / B）の完了条件を満たしたかで測る。

`→` は依存先。各マイルストーンの完了条件は「自分で使って確認できる状態」で書く。

### 4.0 前提作業（Day 0、ユーザー作業）

- [ ] 各設定ディレクトリの `settings.json` で `cleanupPeriodDays`（既定30日）を延長する（推奨。Turnlane は自動では変更しない）
- [ ] Bun を 1.4 系にする（`mise use bun@1.4`。ADR 0007）
- ~~Google カレンダー（Web）で `Turnlane` カレンダーを作成する~~ 不要になった（D-072。書き戻し先の既定は Calendar.app のデフォルトカレンダー。専用カレンダーに分けたい場合だけ作る）
- [ ] Mac のカレンダーに祝日カレンダーが無ければ追加する（任意。Calendar.app の祝日カレンダーの表示をオンにするか、Google カレンダーの祝日カレンダーを購読する。M3-6 で稼働日の判定に使う。無ければ祝日なしとして扱う）

### 4.1 S: スパイク（3.5日）

| ID | 内容 | 見積 | 依存 | 合格条件 / 決めること |
|---|---|---|---|---|
| S4 | Bun 基盤の確認: `bun build --compile` した小さなバイナリで `bun:sqlite`（WAL）+ Drizzle、`fs.watch` recursive（FSEvents）が `<CLAUDE_CONFIG_DIR>/projects` の追記を取りこぼさないか、Hono の静的配信と WebSocket、`turnlane hook` 相当の起動時間 | 0.5 | — | 起動 50ms 以内、追記イベントが連続書き込みでも欠けない（欠ける場合は再走査の間隔を短くするか、@parcel/watcher を検討）。**完了**: 全項目合格、@parcel/watcher は不採用（[レポート](../spikes/s4-bun-foundation.md)、ADR 0007） |
| S3 | 実データでのターン分割と状態判定: 使い捨てスクリプトで検出した Claude Code の設定ディレクトリと `~/.codex` を読み、過去7日の WorkItem と状態を出す。本文は出力しない | 1 | S4 | 自分の記憶と照合して WorkItem の粒度が妥当、`turn_duration` の有無、your_turn と done の振り分けの誤り率を記録。グルーピング規則の調整点を決める。**完了**: `turn_duration` は Claude のターンの98%、Codex の `duration_ms` は100%。粒度はオーナー確認で分けすぎ・まとめすぎなし。状態の誤り率は個別行の確認が未記入（全体の質問では粒度の誤りなし）。見落としは別アカウントの設定ディレクトリを除外していたことによるもので、検出の規則を直した。調整は 3.1・3.3 に反映（[レポート](../spikes/s3-grouping.md)） |
| S2 | Codex SQLite の読み取り: `state_5.sqlite` と `thread_history_1.sqlite` を Codex 稼働中に `mode=ro` で開けるか。環境によっては sqlite3 CLI から `unable to open database file` で開けない場合がある。起きた場合は原因（`-wal` / `-shm` の不在、権限、サンドボックス）を切り分ける | 0.5 | S4 | 開けない場合の方針を決める: (a) `-shm` を作れる条件で開く、(b) 一時ディレクトリへファイルをコピーして読む、(c) JSONL のみにする。**完了**: (c) を採用。`-wal` が無い普段の状態では読み取り専用の接続で開けず（SQLITE_CANTOPEN）、開けた場合も Codex の `-shm` に書き込む。SQLite の中身は JSONL の写しで遅れがある。将来 SQLite が必要になったら (b)（[レポート](../spikes/s2-codex-sqlite.md)） |
| S1 | EventKit ヘルパ: 最小の Swift アプリ（LSUIElement、Info.plist、Apple Development 署名）を LaunchAgent で起動し、Full Access の許可ダイアログ → 予定の取得 → `Turnlane` カレンダーへの作成・削除 → `EKEventStoreChanged` 受信、までを確認。再ビルド後も許可が残るか | 1 | — | 案 A で TCC が通ること。通らなければ「`open -g -j` で起動する」案か「ヘルパを Login Item として常駐」に切り替える。**途中**: ヘルパと自動の確認（ビルド・Info.plist・署名・`open` での起動・WebSocket の同期）は合格。ダイアログ・システム設定の表示・launchd 配下の読み取り・再ビルド後の許可はオーナーの確認待ち。`Turnlane` への作成・削除は M3-3 で確かめる（[レポート](../spikes/s1-eventkit-tcc.md)） |
| S5 | hooks の共存: Claude の `settings.json` に識別用のキーを足してよいか（未知キーの扱い）。足せない場合は `command` 文字列（`turnlane hook --managed-by turnlane`）で識別する。Codex の hooks.json と信頼承認（`/hooks`）の手順、`disableAllHooks` の検出 | 0.5 | S4 | 冪等なインストール・アンインストールの方式を決める（M1-10 の前までに）。**完了**: 未知キーは使わず command 文字列（`--managed-by turnlane`）で識別し、イベントごとに自分専用のグループを配列の末尾に足す。Claude の設定ディレクトリ3つと Codex の設定ファイルのコピーで install → install → uninstall がバイト一致。Codex は `async` を付けず、承認は位置の鍵と内容の hash で決まる。方式は 3.6.1（[レポート](../spikes/s5-hooks-coexistence.md)） |

### 4.2 M0 土台（5.5日）

| ID | タスク | 見積 | 依存 |
|---|---|---|---|
| M0-1 | リポジトリ雛形: Bun workspaces、tsconfig（project references）、Biome、`bun test` の preload（TZ=Asia/Tokyo 固定・偽の時計）、GitHub Actions（lint / typecheck / test） | 0.5 | S4 |
| M0-2 | core 基礎: UUIDv7、HLC、Clock の差し替え、日付区切り（`toLocalDate(ms, tz, boundary)`）、fractional index。テスト | 0.5 | M0-1 |
| M0-3 | Drizzle スキーマ（2.3 の DDL）、0001 マイグレーション、起動時の適用手順（事前バックアップ、user_version。適用そのものは M0-8）、PRAGMA。スキーマのスナップショットテスト | 1 | M0-2, M0-8 |
| M0-4 | mutate 層（同期カラム付与、change_log）と、直接書き込みを禁止する lint ルール。テスト | 0.5 | M0-3 |
| M0-5 | デーモン骨格: Hono、トークン生成、`/auth`、Host / Origin 検証、`/api/health`、SSE ハブ、メタデータ専用ロガー | 0.5 | M0-3 |
| M0-6 | turnlane 骨格とデーモン管理: `self-install`、LaunchAgent plist 生成、`daemon start/stop/status/logs`、`open`。インストールの最後に `turnlane --version` を1回実行（初回実行のコード検査を済ませる） | 0.5 | M0-5, M0-10 |
| M0-7 | バックアップジョブ（日次 `VACUUM INTO`、14世代）、`turnlane backup`、`turnlane export --json` | 0.5 | M0-4 |
| M0-8 | 埋め込みマイグレーションの適用関数（`packages/core/src/db/migrate.ts`）: drizzle-kit 生成の SQL を `with { type: "text" }` で import、`--> statement-breakpoint` で分割、`__migrations` で適用済みを管理、1トランザクションで適用。compile 後のバイナリで2回起動して再適用されないことのテスト（S4 の C5） | 0.5 | M0-1 |
| M0-9 | Vite 出力の埋め込み: ビルド時に `apps/web/dist/` のファイル一覧から `with { type: "file" }` の import とパス→MIME の対応表を生成するスクリプト、Hono の静的配信と SPA フォールバック。ソースの `dist/` を消しても配信できることのテスト | 0.5 | M0-1 |
| M0-10 | ビルド設定: `turnlaned` / `turnlane` の `bun build --compile --minify --bytecode --format=esm`、`turnlane` のエントリをサブコマンドの動的 import にする、`hook` モジュールの import 制限（Biome `noRestrictedImports`）、`turnlane hook` の起動時間ベンチを CI で回す（p95 50ms 超で失敗）（S4 の C1・C2） | 0.5 | M0-1 |

**M0 完了条件**: `turnlane self-install` の後に Mac を再起動しても `turnlane daemon status` が稼働中を返す。`turnlane open` でブラウザに health 画面が出る。`backups/` にその日のバックアップができている。

### 4.3 M1 取り込み（11.5日）

| ID | タスク | 見積 | 依存 |
|---|---|---|---|
| M1-1 | 許可リストの抽出関数（`allowlist.ts`）と匿名化ツール（`packages/collectors/scripts/anonymize.ts`）。実データから Claude 3セッション（PR あり・質問終了・サブエージェントあり）、Codex 3 rollout と `session_index.jsonl` をフィクスチャ化 | 1 | S3, M0-1 |
| M1-2 | 取り込み基盤: JSONL リーダ（行境界、不完全行、切り詰め、inode 変化）、watch と定期再走査、ストリーム単位のキュー、シンク（upsert + カーソル保存を1トランザクション）、health カウンタ | 1 | M0-4 |
| M1-3 | Claude Code アダプタ: `~/.claude*` の検出（名前に関係なく既定ですべて有効）、トランスクリプトのパース（session_seen / turn / artifact）、ターン終了時点のブランチと cwd、task-notification 起点のターン（`initiator='system'`）、ai-title、pr-link（セッション内の初出だけ）、AskUserQuestion、質問終了と締めの決まり文句の判定（`closing-question.ts`。Codex アダプタも使う）、サブエージェントの親子付け。golden テスト | 1 | M1-1, M1-2 |
| M1-4 | Claude のライブ状態: `sessions/<pid>.json`（`.key` は対象から除外するパターンをハードコード）と pid の生存確認 | 0.5 | M1-3 |
| M1-5 | Codex アダプタ: rollout JSONL（ターン・状態・時間、`session_meta.source` によるサブエージェントとノイズの判定）、`session_index.jsonl`（タイトル）、`archived_sessions/`（アーカイブ）。SQLite は開かない（S2）。golden テスト | 0.75 | M1-1, M1-2 |
| M1-6 | enrich: repo_root（worktree 対応）とブランチの補完、除外ルール、ノイズ判定、local_date | 0.5 | M1-3 |
| M1-7 | WorkItem のグルーピングと状態判定（純粋関数）+ runner + status_log + 60秒 tick。S3 の調整（head ブランチによる PR の帰属と PR 起点のカード作成、消えた cwd の repo の引き継ぎ、既定ブランチでの `git status` 確認、your_turn の期限切れ）を含む。表形式のシナリオテスト | 1.25 | M1-6 |
| M1-8 | フォローアップエンジン: 規則、dedupe、superseded、タスクの自動生成と自動クローズ、snooze / dismiss、実績の推定。返答タスクの閉じ方4種（返答済み・解決済み（推定）・対応不要・期限切れ。3.3.1）、締めの決まり文句では作らない、解決の兆候（`git log`、別セッション、PR の merged）。シナリオテスト | 1.25 | M1-7 |
| M1-9 | 勤務時間と時間計算（3.3.1）: 追加マイグレーション（`ai_turn.closing_question`、`ai_artifact.state_changed_at`、`follow_up.status` の `expired`、`daily_note.work_start_at` / `work_end_at`、`work_day_auto`、`ai_wait_segment`）、`user_op` の記録（HTTP の middleware）、勤務時間（自動・修正・いつもの勤務時間）、待ち区間の再生と区分（猶予・放置・集計外・期限切れ）、日別 Idle・Expired・リポジトリ別の放置、`work_item_daily`、`PUT /api/work-hours/:date`、`turnlane rederive --wait`。5.5 のシナリオテスト | 1.5 | M1-7, M1-8 |
| M1-10 | hooks: `turnlane hook`（許可リスト抽出 → spool。`--managed-by turnlane` と未知の引数は読み飛ばす。`config_root` を残す）、spool アダプタ、hook イベントを状態判定へ反映、`turnlane hooks install/uninstall/status`（検出した Claude の全設定ディレクトリ + Codex、バックアップ、dry-run）。識別・置き方・書き込み・点検は 3.6.1（S5）に従う（Codex は `async` なし・timeout 2秒、Claude は `async: true`・timeout 5秒、イベントは Claude 7 / Codex 5）。テストは S5 の `test/install.test.ts` の20件を移植する | 1 | M1-7, M1-14, S5 |
| M1-14 | hooks の許可リストの移設（ADR 0009）: M0 の `apps/cli/src/hook/allowlist.ts` を `packages/collectors/src/hook-allowlist.ts` へ移し（ToolId をキーにする。`HOOK_TOOLS = ['claude', 'codex']` は `HOOK_TOOL_IDS = ['claude_code', 'codex']` に）、`package.json` の `exports` に `./hook-allowlist` を足す。`turnlane hook` の import と `--tool` の値、`turnlane --help` の表記、テストを更新。Biome: `apps/cli/src/hook/**` の許可に `@turnlane/collectors/hook-allowlist` を足し、`hook-allowlist.ts` 自体は import を一切禁止する。起動時間のベンチ（M0-10）が通ることを確認 | 0.25 | M1-13 |
| M1-11 | PR 状態ポーラ（gh CLI、5分、open な PR のみ）、`headRefName` の取得（`ai_artifact.head_ref`）、タイトル候補への反映 | 0.5 | M1-8 |
| M1-13 | collectors のパッケージ境界（3.1.1）: `package.json` の `exports`（`.` と `./testing`。M1-14 で `./hook-allowlist` を足す）、`index.ts` の公開 IF、`ADAPTER_API_VERSION` と `defineAdapter`、`registry.ts`、`_template` アダプタと `README.md`（日本語でよい。英語化は M6-3）、テストキット（golden / 増分 / 番兵 / ルート外アクセス検出）、依存方向の lint（collectors 配下で `@turnlane/*`・drizzle・hono・zod を禁止）と `dependencies` の許可リスト検査、collectors 単体の `bun test` を CI の別ジョブに。M1-3 / M1-5 のテストはこのキットで書く | 0.5 | M1-2 |
| M1-12 | プライバシーと縮退: 番兵文字列テスト（6.2）、`turnlane doctor` の DB 監査、L0〜L2 の判定と `ai_source.health_level`、`testedVersions` 外の警告。`turnlane ai` / `turnlane queue` / `turnlane sources` | 0.5 | M1-8 |

**M1 完了条件**:
- `turnlane ai --days 7` が過去7日の AI 作業を WorkItem 単位で出し、直近3日分を自分の記憶と照合して大きな取りこぼしや分裂が無い。
- Claude Code で質問で終わるやり取りをすると、hooks ありなら3秒以内、hooks なしでも60秒以内に `turnlane queue` に「返答」が出て、返答すると自動で閉じる。
- Codex でも同様に your_turn が出る。
- 「他に何かありますか？」で終わったやり取りでは返答タスクが出ない。返答タスクのあるブランチでコミットすると「解決済み（推定）」で閉じる。
- `turnlane ai --days 7` の各日に Idle と Expired が出て、夜間・会議中が放置に入っていない（自分の記憶と照合）。
- 番兵テストが CI で通り、`turnlane doctor` の DB 監査で長文フィールドが0件。

### 4.4 M2 ボード UI（24.75日。うち常用開始前 A 11.75日 / 常用中 B 13日）

確定デザイン（[docs/design/](../design/README.md)。画面の正はここ）に合わせて 2026-10-03 に見直した。主な変更: 週ボードが24時間の時間軸と今日の AI レーンを持つ形になった（D-024〜D-026、D-028、D-029）、デイビューを M3 から移した（D-034）、右レールを廃止した（確定デザインに無い。時間ブロックは週ボードの時間軸とデイビューの自分レーンで作る）、i18n（D-023）とテーマ（D-027）を最初から入れる、デザイントークンとアイコンを部品として先に作る。

UI が読む API の形（`/api/board` と `/api/day/:date` の型、`/api/queue` との分担）、SSE のイベント、クライアントのデータ層、配置計算の置き場所、自動生成タスクの題名の返し方（D-046・D-047 (3)）、容量（Free / Planned）の定義（D-047 (1)）は [m2-api.md](m2-api.md) を正とする。同文書 8 章の見積の変更（M2-2 1.25 → 1.5、M2-19 1.5 → 1.75。D-047 (5) で了承）を下の表に反映した。D-046 の保存形式は M1 の Idle 修正（M1-8・M1-9）で実装済みなので M2-2 から外し、代わりに題名の読み取り時の解決と D-048 (4)（YOUR TURN の絞り込み、タスクのない your_turn の72時間）を M2-2 に入れた（D-047 (2)・D-048）。

「段階」列: **A** = 常用開始（14日カウント）の前に要るもの、**B** = 常用しながら入れるもの。並びは着手の順。

デスクトップアプリ（Tauri の薄いシェル。D-055、[ADR 0010](../adr/0010-desktop-shell-in-phase0-as-daemon-client.md)）を段階 B の先頭に入れた（M2-S6・M2-D1〜M2-D10、7.75日）。設計・タスクの詳細・完了条件・削り順は [desktop-shell.md](desktop-shell.md) を正とし、下の表は要約。

| ID | タスク | 見積 | 依存 | 段階 |
|---|---|---|---|---|
| M2-1 | web 雛形: Vite / React / TanStack Router・Query / Tailwind v4、`hc<AppType>`、SSE → invalidate、デーモンへの静的ファイル埋め込み（M0-9 の仕組みを使う）。画面の外枠（サイドバー: Your turn［件数］・Inbox・Week・Today・Daily note・Projects・Sources の健全性・Settings。上部バー: Today・期間・Week / Day の切り替え・検索 ⌘K・状態ごとの件数・Sources の状態）。AI activity と Weekly review は v1 なのでサイドバーに出さない | 0.75 | M0-5, M0-9 | A |
| M2-11 | デザイントークンと基本部品: design-system.md の色・タイポ・余白・角丸を CSS 変数（`:root[data-theme="dark"]` と `:root[data-theme="light"]`）にし、Tailwind v4 の `@theme` から参照する。テーマ設定は Light / Dark / System（既定 System。`prefers-color-scheme` に追従し、`setting` に保存）。フォント（Inter・Noto Sans JP・JetBrains Mono）は @fontsource で同梱し、外部から読まない（OFL。M6-1 の表記対象）。数字は tabular-nums。アイコンは lucide-react（アウトライン 1.5px・16px。C1）、状態アイコン5種だけ自前の塗り SVG（推定は 60%・破線・`~`。running の回転と needs_input の明滅は `prefers-reduced-motion` で止める）。基本部品: 項目5種（予定・自分のタスク・自分の番・AI 項目・外部タスク）、ソースバッジ（`CC` / `CX` / `CD`、複数アカウントは `CC·main`）、mono のメタ行、キー表示、ボタン、ポップオーバー、警告（無彩色の三角＋text-primary。琥珀は needs_input 専用。C3）。開発用の部品一覧（`/dev/components`。両テーマ×英日を並べる）で目視確認する | 1.25 | M2-1 | A |
| M2-12 | i18n 基盤（下の比較表）: 英語の辞書を正にし（`apps/web/src/i18n/en.ts`、`as const` からキーの型を作る）、日本語は同じキーの部分集合（欠けたキーは英語で出し、CI で欠けを一覧にする）。複数形は `Intl.PluralRules`、日付は `Intl.DateTimeFormat`（日付と曜日は UI フォントで描く。C2）。mono のメタ（時間 `1h12m`、時刻、リポジトリ、ブランチ、PR、ソースバッジ、キー表示）はロケールに関係なく ASCII で、共通の整形関数を通す。言語設定（System / English / 日本語）。JSX に直書きした文字列を検出する検査を CI に足す。自動生成タスクの題名（D-046）の辞書は M1 で `packages/core/src/i18n/task-title.ts` に置いた最小のフォーマッタにあるので、キー（`followup.*`）はそのままこの辞書へ移す | 0.25 | M2-1 | A |
| M2-2 | ボード系 API（[m2-api.md](m2-api.md)）: `/api/board?from&to`（日ごとに予定・終日予定・タスク・時間ブロック・勤務時間（自動 / 修正 / いつもの）・日の集計（容量 Free / Planned の定義は m2-api.md 9.1。`plan/capacity.ts`）、今日の AI 区間と待ち区間（週ボード用の2区分）、過去日の AI 稼働リボン用の区間、表示範囲外の AI 件数）、タスク CRUD、`move`（fractional index、`carry` のときだけ持ち越し回数を加算）、`restore`、`/api/inbox`、時間ブロックの CRUD（M3-3 までは書き戻さず `pending` のまま保存）、`/api/queue` の拡張、`packages/core/src/api/` の型と Zod、SSE の送り方の修正（待ち区間の変化、`work_hours`、`rev`、束ね）。自動生成タスクの題名を読み取り時に AI 項目の現在のタイトルで組み立てる（D-047 (3)。m2-api.md 6.1）。YOUR TURN を open なタスクのあるカードに絞り、タスクのない your_turn を72時間で done にする（D-048 (4)。3.3。`deriveStatus` とシナリオ W33〜W35）。needs_input は必ずタスク（approve / reply）を作って YOUR TURN に出す（D-049 (1)。3.3、シナリオ W36・W37）。API テスト（`app.request`）。`/api/day/:date` は M2-19 で作る | 1.5 | M0-4, M1-9 | A |
| M2-13 | 時間軸の共通部品（週ボード・デイビュー・朝の計画 Step 3 で共有）: 24時間（暦どおり 0:00 が起点。D-054 で日付区切り起点から変更）の縦スクロール、目盛り、開いたときに勤務開始付近へスクロールし日中は現在線を見える位置に保つ、現在線（紫 1px と mono の時刻）、勤務時間外の背景（off-hours の塗り＋斜線。D-080）、今日の開始境界の線とラベル `Started 8:42 (auto)` / `(edited)`。重なりの配置計算は純粋関数（`packages/core/src/layout/lanes.ts`、週ボードの自分レーンは `me-lane.ts`）: 重なる短いブロックは横に並べ（D2）、週ボードの自分レーンでは連続した短い完了ブロックをまとめ表示にし、予定と重なるタスクは予定の題名の下に入れるか列を分ける（W4・W5）。最小高さ（AI 20px / 自分 16px、週ボードの自分レーンは 20px）を守りつつ開始位置は実時刻どおり、列の上限（AI 3列）を超えたら `+N`。配置計算は表駆動の単体テスト | 1.25 | M2-11 | A |
| M2-3 | 週ボード（ux-mvp 4.4）: カラム配置（昨日・今日・以降。今日は平日の約2倍で自分 50% / AI 50%、週末は 0.6 倍、幅が足りなければ未来の日数を減らす）、ヘッダ（今日・未来は `Free · Events · Planned · Idle · Expired`、過去は `6/8 done · AI 3h40m · Idle 25m`。値が 0 の項目は出さず、項目単位で折り返さず、あふれたら末尾を省略）、終日の行、Unscheduled 帯（空なら高さ 20px。W3）、時間軸上の予定・タスク・時間ブロック（予定と重なるブロックに無彩色の `Overlap · 45m`）、持ち越しバッジ `↺ 3`、完了の表示、過去カラムの記録モード | 1 | M2-2, M2-13 | A |
| M2-14 | 今日の AI レーン: AI 項目（最小 20px・1行。状態アイコン、タイトル、ソースバッジ、右端に時間。幅が足りないときはバッジと時間を先に置き、残りでタイトルを省略。W2）、並列は3列まで＋`+N`、待ち線2種（放置 = 2px 点線・状態色、10分以上のときだけ無彩色の mono ラベル `idle 11m` / それ以外 = 1px 灰色点線、ラベルなし。D-028）、自分の応答ブロック、前日からの未完了 AI の持ち越し | 0.75 | M2-3, M1-9 | A |
| M2-6 | YOUR TURN 帯と要対応キュー: 行部品（儀式の画面と共有する。状態アイコン、タイトル、mono のリンク行 `repo · branch`、右端の待ち。勤務時間外に始まった待ちは長さでなく `since 22:51`（M1）、期限の24時間前から `expires in 18h`）。帯は needs_input → error → your_turn、同じ状態内は待ちの長い順で最大5行＋`+N more`、閉じた行の表示（返答済みは取り消し線、解決済み（推定）は `~ resolved` と破線のチェック）。キュー画面（S5）は全件。操作: `⏎`（engage + 外部を開く）、`s` スヌーズ（30分 / 1時間 / 明日朝）、`e` 対応不要、`Space` 完了、`x` で選んだ複数件への一括適用。平均応答時間 | 0.75 | M2-14, M1-8 | A |
| M2-4 | タスク操作と Inbox: `c` で追加、NL パーサ（`core/nlp`、日本語・英語の表駆動テスト）、`r` でタイトル編集、完了、`m` で日付を選んで移動・`>` / `<`、削除と ⌘Z、Inbox 画面（S4。経由の印 `CLI` / `MCP via <client>`、7日以上残ったものに `⚑`） | 1.25 | M2-3 | A |
| M2-7 | キーボード基盤: スコープ付きのキーマップ（グローバル / ボード / リスト / 儀式 / パネル。入力欄にフォーカスがあるときは1文字キーを無効）、`g` 始まりの2打鍵、`h` / `j` / `k` / `l`、`t`（今日へジャンプ / 選択中なら今日へ移動）、`x` 複数選択と `⇧j` / `⇧k` の範囲選択（選択中の操作は全件に適用）、`?` の一覧、儀式のフッタのキー表示。キーの定義は1か所にまとめ、`?`・⌘K（M2-15）・フッタが同じ定義を読む | 0.75 | M2-4 | A |
| M2-5 | AI 詳細パネル（S6。画像なし、既存の部品で組む）: 右からスライド、ターン一覧、成果物（PR・コミット）、時間内訳（`AI · You · Idle`、猶予と集計外の内訳、依頼から完了までの壁時計の時間は小さく）、再開導線（resume コマンドのコピー / PR / フォルダ）、修正操作（完了にする・統合・非表示）。本文は出さない | 0.75 | M2-14 | A |
| M2-8 | ブラウザ通知（needs_input / error は即時、your_turn は15分まとめ、同じカードは5分以内に再送しない）、タブタイトルの件数 | 0.5 | M2-6 | A |
| M2-10 | `turnlane add / today / ls / done` と stdio MCP サーバ（3.5 のツール）、Claude 各プロファイルと Codex への登録手順。外部取り込みの冪等性（`source` + `external_id` で2回呼んで1件、削除後に再送しても作られない、片方だけ指定はエラー、spool 経由でも重複しない、同時に2回呼んでも1件）を API テストで確認 | 1 | M2-2 | A |
| M2-S6 | スパイク: Tauri 2 の最小の .app で、デーモンの SPA の読み込みとクッキー認証、リモート URL からの IPC の制限、通知クリックの受け取り（実装の選定）、⌥Space、メモリの実測（desktop-shell.md 10章） | 0.5 | — | B |
| M2-D1 | `apps/desktop` の雛形（Tauri 2、Cargo、Bun のスクリプト、署名付きビルド、CI の clippy / test、main ウインドウ、ナビゲーションの制限、自前のメニュー、Dock の切り替え、single-instance） | 1 | M2-S6 | B |
| M2-D2 | デーモン: 通知の判定と文言を core へ移し `NotifyRunner` で実行、SSE の `notify` / `desktop_open`、`desktopNotifier`、`/api/queue/summary`、`/api/desktop/open` | 1 | — | B |
| M2-D3 | Rust: SSE クライアント、メニューバーの件数と状態（琥珀・オフライン）、メニュー | 0.75 | M2-D1, M2-D2 | B |
| M2-D4 | ネイティブ通知の表示とクリック（該当項目を開く）、許可の案内 | 0.75 | M2-D3 | B |
| M2-D5 | web の WKWebView 対応（ブラウザ通知の停止、クリップボード、外部リンク、IPC のラッパ） | 0.5 | M2-D2 | B |
| M2-D6 | turnlane: `turnlane desktop`、`self-install` / `uninstall` / `open` / `doctor` への統合、LaunchAgent `dev.turnlane.desktop` | 0.75 | M2-D1 | B |
| M2-D7 | メニューバーのポップオーバー（`/tray`: YOUR TURN の一覧、開く・対応不要・明日、週ボードを開く） | 1 | M2-D3, M2-D5 | B |
| M2-D8 | ⌥Space のクイック入力（`/quick-add`、NL パーサ、キーの変更、フォーカスの返却） | 0.75 | M2-D1, M2-D5 | B |
| M2-D9 | デーモン未起動時の boot ページと再接続、版の不一致の表示 | 0.25 | M2-D1 | B |
| M2-D10 | 確認と記録（大きさ・メモリ・スリープ復帰・再起動の確認、`docs/dev/desktop.md`） | 0.5 | M2-D4, M2-D6〜M2-D9 | B |
| M2-15 | ⌘K パレット: M2-7 のキー定義をコマンドとして出す（`Plan the day`・`Close the day` の儀式の入口を含む）、選んでいる項目への操作、`/api/search`（タスク・予定の題名、AI 項目のタイトル・リポジトリ・ブランチ・PR 番号。本文は見ない）、日付と画面への移動、空入力の Your turn 上位・最近使ったもの、`p` の空き枠の候補（ux-mvp 6.1、m2-api 17章）。cmdk は使わず自前の部品にした（非同期の検索結果とカテゴリの絞り込みを自分で並べるため。2026-10-05） | 0.5 | M2-7 | B |
| M2-16 | 週ボードの仕上げ: 過去日の AI 稼働リボン（時間軸の右端 2px）、表示範囲外のヒント `↑ 1 AI run at night`、待ち線の終点と YOUR TURN の行・自分の応答ブロックをつなぐ点線（ホバー時だけ）、勤務開始の境界のドラッグ修正（`PUT /api/work-hours/:date`）、空の Unscheduled のホバーで `+ Add`（W3）。**済み**（2026-10-05 r4。ux-mvp 4.4、docs/dev/r4.md） | 0.5 | M2-14 | B |
| M2-17 | DnD（日付と並び）: dnd-kit。日付移動、Unscheduled 内の並べ替え、Inbox へ（日付を外す）、ドラッグ中にヘッダの容量をドロップ後の値に更新、AI 項目の日付移動は禁止のカーソル、AI 項目どうしで統合の確認。**途中**（2026-10-05）: タスクの日付移動・並べ替え・Inbox へ・ドラッグ中の容量は済み（週ボードの Inbox トレイを含む。ux-mvp 7章）。AI 項目の DnD（禁止のカーソル・統合の確認）と自分の番の DnD も済み（2026-10-05 r4。ux-mvp 7章、m2-api 19章） | 0.5 | M2-4 | B |
| M2-18 | 時間ブロック（右レール M3-4 を置き換える）: 週ボードの時間軸とデイビューの自分レーンへのドロップで作成（高さ = 見積、無ければ 30m。15分スナップ、`⌥` で5分、開始・終了をカーソル横に表示、予定と重なる位置は斜線）、移動・下端の伸縮・`⌫` で解除（タスクは残る）、自分レーンの空白の範囲選択で新規、AI 項目 → 自分レーンで確認タスクとブロック、`p` で空き枠の候補（数字キーで選択）。**途中**（2026-10-05）: 週ボードでの作成・移動・伸縮・`⌫`・範囲選択と ⌘Z は済み。デイビュー（M2-19）の自分レーンへの作成・移動・伸縮・範囲選択も済み（2026-10-05）。AI 項目 → 自分レーン（確認タスク）とデイビューの帯・AI レーンからの DnD も済み（2026-10-05 r4）。`p` は残り | 1 | M2-13, M2-17 | B |
| M2-19 | デイビュー（S3。M3-5 から移した）: `/api/day/:date`（M2-2 から移した。`DayDetail`、待ちの3区分と集計外の理由、自分の応答区間と接続先、Closed today の4種、空き枠。m2-api.md）、3レーン（Events 20% / Me 30% / AI 50%、AI は3列まで）、上部の日の集計 `AI · You · Meetings · Idle · Expired` と `Work 8:42 – now (auto) · Edit`、AI レーンの凡例 `grace · idle · excluded`、AI 項目のメタ `AI 38m · You 8m · Idle 13m`、待ち線3種を各 AI 列にその項目の下端から引く（猶予 = 1px 点線・状態色 50% / 放置 = 太い点線・状態色＋ラベル、背後に幅 12px・状態色 8% の帯（D1）/ 集計外 = 1px 灰色点線、区間ごとに1回だけ `off hours` / `in meeting` / `snoozed`）、自分レーンの実時間のブロック（15分未満は最小 16px・1行、重なりは横に並べる）と常時表示のコネクタ、放置区間のホバー（`Idle 10:30–10:41 · 11m / Working hours · no event / Counts toward Idle`。事実のみ）、AI 区間のポップオーバー（時刻・ツール呼び出し数・編集ファイル数・トークン）、左パネル（YOUR TURN / Closed today: replied・resolved · commit・not needed・expired / Unscheduled と空き枠の文言）、日付区切り前の深夜区間、リポジトリ別の放置（深夜区間は D-054 で暦日の上端に描き、ホバーで前日に計上と出す）。**済み**（2026-10-05。m2-api.md 15章、docs/dev/b3.md）: 開き方は ⌘2・`g d`・上部の `Week | Day`・サイドバーの Today・週ボードの列ヘッダ | 1.75 | M2-13, M2-14, M2-6 | B |
| M2-20 | 日本語の訳と確認: ja の辞書を埋め、両テーマ×英日で全画面の文字長と改行を確認する（部品一覧と実画面）。**済み**（2026-10-05）: ja の欠けを0にし、`apps/web/test/i18n.test.ts` で欠けを失敗にした。確認のスクリーンショットは `docs/dev/screens/r1/`（[r1.md](../dev/r1.md)） | 0.25 | M2-12 | B |
| M2-9 | 設定画面（最小）: 取り込み元（検出、オン・オフ、健全性、除外）、日付区切り、計画上の勤務時間（曜日ごと。学習した「いつも」を提案として出す。D-062。2026-10-05 に先行して入れた）、稼働日（曜日と祝日カレンダー。M3-6。「Holidays from」は CLI と同じく同じ名前をまとめて件数を添える。D-057 (2)）、カレンダーの役割（source / writeback / ignored）、テーマ、言語、プライバシーモード、フォローアップ種別、24時間ルール、日報の AI 要約（オン・オフ、使うツール、送る内容の説明。M4-6）、プロジェクトとリポジトリの対応。常用開始までは `turnlane sources`・`turnlane calendar`・`turnlane config` などの CLI で代用する。**途中**（2026-10-05）: 取り込み元（プロファイルごとのオン・オフ（D-017）、健全性と hooks の状態、除外の glob、再検出）、日付区切り、祝日（自動 / 選ぶ / なし と「Holidays from」のまとめ表示）、カレンダーの役割、自分の番の種類と猶予・期限（24時間ルールを含む）、プライバシーは済み（`routes/SettingsSections.tsx`）。日報の AI 要約（M4-6）は済み（2026-10-05）。プロジェクトとリポジトリの対応（`/api/projects` の POST / PATCH）も済み（2026-10-05 r4。m2-api 19章） | 0.75 | M1-12 | B |

合計 24.75日（A: M2-1 0.75 + M2-11 1.25 + M2-12 0.25 + M2-2 1.5 + M2-13 1.25 + M2-3 1 + M2-14 0.75 + M2-6 0.75 + M2-4 1.25 + M2-7 0.75 + M2-5 0.75 + M2-8 0.5 + M2-10 1 = 11.75。B: M2-S6 0.5 + M2-D1〜M2-D10 7.25 + M2-15 0.5 + M2-16 0.5 + M2-17 0.5 + M2-18 1 + M2-19 1.75 + M2-20 0.25 + M2-9 0.75 = 13）。2026-10-05 の D-055 でデスクトップアプリ（M2-S6・M2-D1〜M2-D10）を段階 B の先頭に入れて +7.75日（[desktop-shell.md](desktop-shell.md) 10章）。2026-10-03 の D-040・D-041 で M2-9 に稼働日・カレンダーの役割・AI 要約の設定を足して +0.25日。同日の m2-api.md（D-047 (5)）で +0.5日: M2-2 は SSE の送り方の修正 +0.25、`/api/day` を M2-19 へ移して -0.25、題名の読み取り時の解決と D-048 (4) +0.25（D-046 の保存形式の +0.25 は M1 の Idle 修正で実装済みのため外した。D-047 (2)）。M2-19 は `/api/day` を受け取って +0.25。

前回（8.5日）からの増分 +7.75日の内訳: デザイントークン・テーマ・フォント・アイコン・基本部品（+1.25。前回は M2-1 の「ライト・ダーク」に含めていた）、i18n（+0.5）、時間軸の共通部品と重なりの配置計算（+1.25。前回は M2-3 の1日に含め「見直す」としていた）、週ボードの今日の AI レーンと仕上げ（+1.25）、デイビュー（+1.5。M3-5 から移動）、時間ブロックの DnD（+1。M3-4 の右レールから移動し、週ボードとデイビューの両方で受ける）、API の時間軸データ（+0.25）、YOUR TURN 帯の行部品と複数選択（+0.25）、Inbox 画面（+0.25）、⌘K の分離と複数選択を含むキーマップ（+0.25）、DnD の分離（+0.5）から、M2-1・M2-5 の縮小（-0.5）を引いた。

i18n の方式:

| 案 | 開発速度 | 型の安全（キーの欠け） | 依存と配布 | 翻訳の受け入れ（公開後） | 評価 |
|---|---|---|---|---|---|
| A. 自前の型付き辞書 + `Intl`（推奨） | 速い（2言語、文言は数百） | `tsc` で英語のキーの欠けを検出、日本語の欠けは CI で一覧 | 依存なし、MIT と衝突しない | 辞書が TS ファイルなので PR で直せる。必要になれば JSON へ書き出して B に移せる | 採用 |
| B. i18next + react-i18next | 普通 | 型付けに追加設定が要る | 依存2つ、実行時の読み込み | 翻訳サービスや JSON の流儀に慣れた人が多い | 公開後に言語が増えたら移行先 |
| C. Lingui（マクロ + 抽出） | 遅い（ビルド設定、抽出の手順） | 抽出で欠けを検出 | Vite プラグインとマクロのビルド依存 | PO ファイルで受けられる | 2言語には重い |

**M2 の A が終わった時点（常用開始の条件の一部。4.9）**: 丸1日、タスク管理を週ボードとキーボードだけで行える（紙・他ツールなし）。Claude / Codex の自分の番が YOUR TURN 帯とキューに出て、対応すると自動で閉じる。Claude Code の会話から `add_task` したタスクが、印付きで Inbox に入る。`source` / `external_id` 付きで同じ項目を2回送っても1件になる。英語 UI で、macOS の外観設定に合わせてダーク・ライトが切り替わる。

**M2 完了条件（B まで）**: タスクを週ボードの時間軸へドラッグして時間ブロックにでき、デイビューで伸縮できる。デイビューで前日の「AI 稼働 / 待ち / 自分」が事実どおりに描かれる（6時間問題が起きない）。日本語 UI に切り替えても全画面で文字が切れない。

### 4.5 M3 カレンダー（3.25日。うち常用開始前 A 2.25日 / 常用中 B 1日）

右レール（M3-4）は確定デザインに無いので廃止し、時間ブロックの作成は M2-18 に移した。デイビュー（M3-5）は M2-19 に移した。M3 はカレンダーとの接続だけを扱う。

2026-10-03 に読み取りと書き戻しを分けた（D-038）。予定が見えない週ボードでは1日の計画が立たず、会議中の待ちが放置に数えられて Idle が狂うので、**読み取り（ヘルパ、予定のキャッシュ、週ボードへの表示、放置計算の「予定中」の判定）は常用開始の前（A）に入れる**。書き戻し（時間ブロック → `Turnlane` カレンダー）は時間ブロックの DnD（M2-18、B）と一緒に常用しながら入れる。あわせて、シャットダウンの自動持ち越し先「次の稼働日」の判定（D-040）を M3-6 として A に入れる。

| ID | タスク | 見積 | 依存 | 段階 |
|---|---|---|---|---|
| M3-1 | カレンダーヘルパ本実装（S1 のコードを整理）: 権限、カレンダー一覧（`type` と `allowsModify` を含む。M3-6 の祝日の候補判定に使う）、窓の取得、変更通知、WS クライアントと再接続、`build-app.sh`、LaunchAgent、`turnlane calendar authorize/status/calendars`。Phase0 の A では `upsertEvent` / `deleteEvent` を実装しなくてよい（M3-3 で足す） | 1 | S1, M0-6 | A |
| M3-2 | デーモン側の同期（読み取り）: `/internal/ek`、`calendar` の役割設定（`PATCH /api/calendars/:id` と `turnlane calendar calendars --role <id> source\|ignored`。設定画面 M2-9 までは CLI で行う）、窓（7日前〜21日後）のスナップショット同期（窓内で返らなかった予定は削除）、`storeChanged` と5分ごとの再取得、SSE `calendar`。週ボード（M2-2 の `/api/board` が `calendar_event` を返す）の予定・終日予定・容量表示に出ることの確認。同期のたびに影響した日付の待ち区間を作り直す（3.3.1 の「カレンダーの同期」による再計算。初回の同期では窓内の過去日も作り直す）ことのシナリオテスト（会議と重なる待ちが `excluded` / `in meeting` になり Idle から外れる）。デイビュー（M2-19、B）は同じ `calendar_event` を読むので追加の作業は無い | 0.75 | M3-1, M2-3, M1-9 | A |
| M3-6 | 稼働日と祝日（D-040。下の方式）: 純粋関数 `packages/core/src/date/workdays.ts`（`isWorkday(localDate, rule)`、`nextWorkday(localDate, rule)`。`rule` = 稼働曜日 + 祝日の日付集合）と表駆動テスト（金曜→月曜、祝日の月曜→火曜、連休、祝日カレンダーなし、稼働曜日の変更、窓の外）。祝日カレンダーの候補判定と自動採用、祝日の日付集合の算出（`calendar_event` の終日予定から。祝日カレンダーは役割が `ignored` でも同期の対象にする）、設定 `workdays.weekdays`・`workdays.holiday_calendars`、`turnlane calendar holidays [--set <id>...\|--none\|--auto]`、設定を CLI で読み書きする `turnlane config get\|set <key> [<json>]`（`setting` を `mutate()` 経由で更新。既知のキーだけ受け付け、値を zod で検証）、`turnlane calendar status` と `turnlane doctor` に「Holidays from: <カレンダー名>」を出す（同じ名前のカレンダーが複数のアカウントから採用されたら1つにまとめて件数を添える。例「日本の祝日（3 アカウント）」/ 英語「Japanese Holidays (3 accounts)」。判定は和集合のまま。表示は `groupHolidaySources`。D-057 (2)） | 0.5 | M3-2 | A |
| M3-3 | **D-093 で置き換え**（2026-10-07。タスクの書き戻しをやめ、予定の作成・編集にした。下の「D-093 の方式」、[手順](../dev/d093.md)。ヘルパ 0.4.0）。以下は当初の内容: 書き戻し: ヘルパの `upsertEvent` / `deleteEvent`、時間ブロックの作成・更新・削除を書き戻し先のカレンダー（既定は Calendar.app のデフォルトカレンダー。D-072）へ反映、`url` の目印、状態遷移（pending → synced / error）、再試行、Calendar.app 側で編集された場合は外部を優先してブロックを更新（conflict は表示のみ）、書き戻し先の選択（`turnlane calendar writeback default\|off\|<id>`、`turnlane calendar calendars --role <id> writeback`）。**済み**（2026-10-05。方式は下の「M3-3 の方式」、[手順](../dev/m3-3.md)）。書き戻し先の既定を Calendar.app のデフォルトカレンダーにした（D-072。ヘルパ 0.3.0）。書き戻しを使い始めたときは、終わりが今より後の時間ブロックだけを書く（過去のブロックをまとめて書かない。D-073）。実カレンダーでの確認（スマホの Google カレンダーに出る）はオーナーの手順 | 1 | M3-2, M2-18 | B |
| ~~M3-4~~ | ~~右レール~~ → 廃止。M2-18 に統合 | — | — | — |
| ~~M3-5~~ | ~~デイビュー~~ → M2-19 に移動 | — | — | — |

合計 3.25日（A: M3-1 1 + M3-2 0.75 + M3-6 0.5 = 2.25。B: M3-3 1）。前回（2.5日）からの増分 +0.75日: 稼働日と祝日（M3-6、+0.5）、同期と待ち区間の再計算の結合テスト（M3-2、+0.25。読み取りを常用開始の前に入れるため、Idle が会議を除いて正しく出ることをここで確かめる）。

**稼働日と祝日の判定方式（D-040）**

稼働日 = 稼働曜日に含まれ、かつ祝日でない日。既定の稼働曜日は月〜金（`workdays.weekdays = [1,2,3,4,5]`、ISO 曜日番号）で、ロケールから推測しない（国によって週末が違うが、推測の誤りより固定の既定と設定変更の方が分かりやすい）。祝日は次の方式で求める。

| 案 | 仕組み | ネットワーク | ロケール依存 | 保守 | 評価 |
|---|---|---|---|---|---|
| **A. Mac のカレンダーにある祝日カレンダーを EventKit で読む（推奨・採用）** | ヘルパが読んでいる `calendar_event` のうち、祝日カレンダーに選んだカレンダーの終日予定の日付を祝日とする | なし（Mac のカレンダーの同期に乗るだけ） | なし（どの国の祝日カレンダーでも、複数でも同じ処理） | 不要（祝日の改定は購読元が更新する） | 採用。M3-1・M3-2 の読み取りをそのまま使え、追加の依存が無い |
| B. 祝日の表を同梱する（npm のライブラリ等） | 国ごとの祝日規則や表をバイナリに入れる | なし | あり（国の選択が要り、対応国が限られる） | 法改正や臨時の祝日のたびに更新とリリースが要る | 不採用。OSS で多くの国に出すと保守が続かない |
| C. 祝日を公開データから取得する（公開 ICS、政府の CSV、祝日 API） | デーモンが定期的に取得する | あり | あり | 取得先の変更に追従 | 不採用。作者のサーバーは無くても「ネットワークに出ない」方針（ADR 0008。例外は GitHub Releases の更新確認のみ）を崩す |
| D. 祝日を扱わない（曜日だけ） | — | なし | なし | 不要 | A のフォールバック。祝日カレンダーが無い・カレンダーの権限が無いときはこれ |

- **祝日カレンダーの選び方**: 設定 `workdays.holiday_calendars` が未設定（`null`）のときは自動で、次をすべて満たすカレンダーを祝日カレンダーとして採用する: (1) 書き込み不可（`allowsModify = false`）で、誕生日カレンダー（`type = birthday`）ではない、(2) 窓内の予定がすべて終日予定で、その9割以上が1日だけの予定、(3) 窓内に1件以上の予定がある。カレンダー名は見ない（言語で変わるため）。macOS の祝日カレンダーと Google の祝日カレンダーの両方が該当したら両方を使う（和集合）。条件に合う共有の休暇カレンダーなどを誤って採用しうるので、採用したカレンダー名を `turnlane calendar status`・`turnlane doctor`・設定画面に出し、`turnlane calendar holidays --set <id>...` で選び直せる（`--none` で祝日なし = `[]`、`--auto` で自動に戻す = `null`）。一度選んだら自動判定はしない。
- **祝日の日付**: 祝日カレンダーの終日予定の `start_date`〜`end_date`（終わりを含まない）の論理日付。時刻付きの予定は無視する。窓（7日前〜21日後）の外は祝日なしとして扱う（持ち越し先と朝の移動候補が見るのは数日先までなので足りる）。
- **使う場所**: シャットダウンの自動持ち越し先（M4-2）、朝の計画 Step 3 の移動候補の「次に空きのある稼働日」（M4-7）。持ち越し先が祝日を飛ばしたときは、日報の Carried over に飛ばした理由を出す（`→ Tue 10/13 (Mon 10/12 is a holiday)`。祝日名は予定のタイトルをそのまま使う）。週ボードの終日の行には、祝日カレンダーの役割が `source` なら他の終日予定と同じく出る（祝日の特別な描き方は Phase0 では作らない）。
- **放置の計算への影響は無い**: 放置は在席で決まり（3.3.1。D-105）、祝日に Mac を使えばその時間は数える。祝日の終日予定は availability が free なので「予定中」にもならない。
- 追加の DDL は無い（`setting` のキーと、既存の `calendar` / `calendar_event` で足りる）。カレンダーの種類（誕生日か）は `calendar` に列が無いので、ヘルパから最後に受け取った一覧をデーモンがメモリに持って自動判定に使う（起動直後でヘルパが未接続の間は候補なし = 祝日なし。M3 の A の実装）。

**M3 の A の実装メモ（2026-10-04）**

- カレンダーの提供元は差し替え可能（`apps/daemon/src/calendar/provider.ts` の `CalendarProvider`）。本番はヘルパ（`HelperBridge`）、テストと `bun run dev:board` は `FakeCalendarProvider`。ヘルパが未接続でも他の機能は動き、週ボードのサイドバーに「Calendar off」、`turnlane calendar status` に「カレンダー未接続」と出る
- `/internal/ek` は Hono を通さず Bun.serve の手前で upgrade する（Host・Bearer・Origin を検査。AppType に WebSocket の型を持ち込まない）
- 同期: 接続時・`storeChanged`（2秒束ねる）・権限の変化・5分ごと・`POST /api/calendar/sync`・役割と祝日の設定の変更。変わった論理日付を SSE `calendar` で送り、runner に再計算を頼む（runner は毎回、窓の7日前から待ち区間を作り直す）。新しく見つかったカレンダーは `source`。Mac から消えたカレンダーは予定を消し、時間ブロックが参照していなければ行も消す
- `PATCH /api/calendars/:id` は段階 A では `source` / `ignored` だけ受け付ける（`writeback` は M3-3 で足した。書き込みできないカレンダーは 400 `not_writable`）
- ヘルパのログ（`~/Library/Logs/turnlane/calendar-helper.log`）はメタデータだけ。署名は `TURNLANE_CODESIGN_IDENTITY`（無ければ ad-hoc）

**D-093 の方式（予定の作成・編集。タスクはカレンダーに書かない。2026-10-07。ADR 0012）**

- タスク（時間ブロック）は Turnlane の中だけ。`time_block` の書き戻しの列（`writeback_*`・`external_*`）は使わない。書き戻しのキュー（旧 `writeback.ts`）・Calendar.app 側の変更のブロックへの取り込み・`calendar.writeback` / `calendar.writeback_started` の設定・役割 `writeback`・`turnlane calendar writeback`・専用カレンダーの作成は外した。マイグレーション 0007 で役割 `writeback` のカレンダーを `ignored` にし、2つの設定を消す
- 予定を作る（`POST /api/calendar-events { title, start, end }`）: ヘルパの `createEvent`（`calendarId` を省く = Calendar.app のデフォルトカレンダー。`url = turnlane://event/<uuid>`、tz は設定の tz）。成功したら結果の予定を `calendar_event` に入れて SSE `calendar` を送る（次の同期を待たずに出る）。その後の Calendar.app 側の変更は従来の同期で取り込む
- 予定を変える（`PATCH /api/calendar-events/:id { title?, start?, end?, calendarId? }`）・消す（`DELETE`）: デーモンが編集できるかを確かめ（下）、ヘルパの `updateEvent` / `removeEvent` を呼ぶ。成功したら `calendar_event` の行を結果で置き換える（`calendar_event.id` は変えない。カレンダーを移しても同じ ID）か消し、SSE `calendar` を送る。書き込みは同期と直列にする（取得の途中の結果で消されないように）
- 編集できる予定: 役割に関係なく、`calendar.is_writable = 1`・`has_attendees = 0`（NULL は不可）・`recurring = 0`・`all_day = 0`・`is_own_timeblock = 0`・`event_id` がある。Turnlane で作った予定（`is_own_event = 1`）も同じ条件（Calendar.app で参加者を足したら読み取り専用）。`CalendarEventView.editable` と `CalendarEventDetail.editable` / `readOnlyReason`（`attendees` / `calendar` / `recurring` / `all_day` / `helper`）で UI に返す。満たさなければ 409 `not_editable`
- 失敗: ヘルパ未接続は 409 `helper_not_connected`、0.4.0 より前は 409 `helper_outdated`、ヘルパのストアの失敗は 409 とそのコード（`no_default_calendar`・`not_writable`・`not_editable`・`save_failed` など）。UI は楽観的に更新し、失敗したら戻して `Couldn't save. Restored.` と、コードに応じた一文をトーストに出す
- これまで書いた時間ブロックの予定の削除: `GET /api/calendar/timeblock-events` がヘルパの `listTimeblockEvents`（今日の365日前〜365日後、全カレンダー）で件数・期間（最初の開始〜最後の終わり）・カレンダーごとの件数を返す。`POST /api/calendar/timeblock-events/cleanup { expected }` は数え直して `expected` と違えば 409 `changed`（画面で数え直してもらう）、同じなら1件ずつ `deleteTimeblockEvent` で消して `{ deleted, failed }` を返し、同期を起こす。自動では消さない。対象の判定はヘルパが `url` の接頭辞で行い、`turnlane://event/` の予定・`url` の無い予定・目印の無い予定には触れない（テストで保証する）
- 読み取り側: `dayline://timeblock/` の予定は削除されるまで従来どおり `is_own_timeblock = 1` で予定のレーン・busy から除く
- 表示: 予定は週ボード・3日ボードの Plan レーンとデイビューの予定のレーンに出る。編集できる予定はドラッグで移動、下端で伸縮、詳細パネルで題名・時刻・カレンダーの編集と削除ができる。読み取り専用の予定は理由（参加者がいる・読み取り専用のカレンダー・繰り返し・終日・ヘルパが古い）と「Calendar.app で開く」（ux-mvp 4.12）。作り分けは ux-mvp 7章

**M3-3 の方式（書き戻し。2026-10-05。D-093 で置き換え。履歴として残す）**

- 書き戻し先（D-072 で見直し）: 次の3つのどれか。状態は `GET /api/calendar/status` の `writeback.mode`
  - **既定（`default`）**: Calendar.app の「新規イベントのデフォルトカレンダー」（EventKit の `defaultCalendarForNewEvents`）。新しい予定を書くたびにヘルパが解決する（`upsertEvent` の `calendarId` を省く）ので、利用者が Calendar.app の設定でデフォルトを変えたら以後の新しい予定はそちらへ書く。**既に書いた予定は元のカレンダーに置いたまま更新する（移さない）**。Calendar.app でデフォルトを変えても既存の予定が動かないのと同じ。デフォルトカレンダーが無い・書き込めないときは `error`（`no_default_calendar` / `not_writable`）にし、設定画面に「Calendar.app の 設定 > 一般 > デフォルトカレンダー で選ぶか、下で書き戻し先を選ぶ」と案内する。ヘルパ 0.3.0 が要る（古ければ書かずに `helper_outdated`。目印付きの予定の削除は古いヘルパでもできる）
  - **特定のカレンダー（`calendar`）**: 役割が `writeback` のカレンダー（1つだけ。`calendar_writeback_uq`。書き込みできるものだけ選べる）。専用の `Turnlane` などを選ぶ。選ぶのは設定画面の「カレンダー」、`turnlane calendar writeback <id>`、`turnlane calendar calendars --role <id> writeback`。別のカレンダーを `writeback` にしたら、前の書き戻し先は `ignored` に戻す。特定のカレンダーへ切り替えたら、終わりが今より後の時間ブロックを `pending` にして新しい方へ書き直す（前の方の予定は消す。利用者が明示的に選び直したので移す。既に終わったものは移さない。D-073）
  - **オフ（`off`）**: 書かない（ブロックは `pending` のまま）
  - 役割が `writeback` のカレンダーがあれば特定のカレンダー。無ければ設定 `calendar.writeback`（`"default"` | `"off"`、既定 `"default"`）。`PUT /api/calendar/writeback { target }` と `turnlane calendar writeback default|off|<id>` で切り替える（`default` / `off` を選ぶと、役割が `writeback` だったカレンダーは `source`（表示する）に戻す。中の Turnlane の予定は目印で除くので二重にならず、ふだん使いのカレンダーを選んでいた場合も他の予定が隠れたままにならない）。既定へ切り替えたときも終わりが今より後のブロックを `pending` にするが、書いた予定は今あるカレンダーのまま更新する（既定では移さない）
  - 既存の利用者（D-072 の前に `writeback` を選んでいた）は特定のカレンダーのまま。新しく使い始める利用者は既定
- 使い始めの時刻（D-073）: 書き戻しを使い始めたときは、**終わりが今より後の時間ブロックだけを書き、それより前に終わったブロックは書かない**（過去のブロックをまとめて実カレンダーに作らない。Calendar.app で操作したのと同じく、過去の予定を後から大量に作らない）
  - 「使い始め」は、書き先（`default`、または特定のカレンダーの `calendar.id`）で実際に書ける状態になった最初の時点。ヘルパが接続していて、書き戻しがオフでなく、特定のカレンダーなら書き込めて、既定ならヘルパが 0.3.0 以上のとき。具体的には (1) 初回の有効化（新しい利用者、既存の利用者がこの版に入れ替えた直後を含む）(2) ヘルパが 0.3.0 になって既定の書き戻しが動き始めたとき (3) 書き先の変更（既定 ⇄ 特定のカレンダー、別のカレンダー、オフから戻す）。デーモンの書き戻しキューがその時点の書き先と時刻を設定 `calendar.writeback_started`（`{ target: "default" \| "calendar:<calendar.id>", at }`、local_only。利用者が直接変える設定ではない）に保存する。書き戻しをオフにしたら消す（次に戻したときが新しい使い始め）
  - 一度も書いていない（`external_event_id` が無い）`pending` / `error` のブロックで、`updated_at` と `end_at` がどちらも使い始めの時刻以前のものは、書かずに `disabled` にする。詳細パネルの「Calendar」は「カレンダーに書いていません（書き戻しを始める前のブロック）」
  - 使い始めの後に作成・移動・伸縮したブロックは、過去の時刻でも従来どおり書く（利用者の操作なので）。`disabled` のブロックも動かせば `pending` になり書く。タスクの題名の変更・削除と復元では `disabled` のブロックを `pending` に戻さない
  - 既に書いた予定（`external_event_id` がある）の更新・削除は従来どおり。書き先を変えたときに `pending` にし直すのは終わりが今より後のブロックだけで、既に終わったブロックの予定は前の書き先に置いたままにする（特定のカレンダーへの切り替えでも過去の予定は移さない）
- 既定のカレンダーには利用者の他の予定が入っている。**Turnlane が更新・削除するのは目印（`url = dayline://timeblock/<id>`）の付いた自分の予定だけ**。ヘルパは目印の無い予定を更新・削除しない（`deleteEvent` は `not_own_event`、`upsertEvent` は触らずに新しく作る）。アカウントの同期で `url` が落ちた自分の予定は、デーモンが書いたときの eventIdentifier でだけ指せるので、それは自分の予定として扱う
- 専用カレンダーが無いとき（特定のカレンダーを使いたい場合）: Google カレンダー（Web）で `Turnlane` を作り（スマホの Google カレンダーにも出る）、Mac のカレンダーに同期されたら設定画面で選ぶ。Google 側に作れない・作りたくない場合の代わりに、EventKit で作れるアカウント（iCloud・この Mac）を選んで作る（`GET /api/calendar/sources`、`POST /api/calendar/turnlane { sourceId }`。ヘルパの `listSources` / `createCalendar`）。この場合 Google カレンダーのアプリには出ない（iCloud ならiPhone のカレンダーには出る）旨を出す
- 書く内容: 題名はタスクの題名（自動生成の題名は UI の言語で組み立てる。タスクの無いブロックは `time_block.title`）、開始・終了、tz、`url = dayline://timeblock/<time_block.id>`。場所・メモ・参加者は書かない（ヘルパは availability を変えない = 既定の busy）
- 状態遷移: 作成・時刻の変更・削除・タスクの題名の変更・タスクの削除と復元で、そのブロックを `pending` にする（削除は `deleted_at` を入れて `pending`。外部を消したら `synced`）。デーモンの書き戻しキュー（`apps/daemon/src/calendar/writeback.ts`）が、ヘルパが接続していて書き戻しがオフでないとき、`pending` と再試行の時期が来た `error` を順に `upsertEvent` / `deleteEvent` で反映する。成功で `synced`（`external_event_id` = EKEvent.eventIdentifier、`external_updated_at` = lastModified、`writeback_calendar_id` = 実際に書いたカレンダー（既定ではヘルパの結果の `calendarId`）、`writeback_attempts = 0`）、失敗で `error`（`writeback_error` に短いコード、`writeback_attempts` を加算）。再試行は 1・2・4・8… 分後（最大 60 分ごと）。書き戻しがオフの間とヘルパ未接続の間は `pending` のまま。窓（7日前〜21日後）より前に終わったブロックは書かない（`pending` のまま）。タスクが削除されたブロックは予定を消す
- 読み取り側: 書き戻し先の予定も窓の同期で取り直す（書き戻しがオフでなければ、窓の中の時間ブロックが書いたカレンダー（`writeback_calendar_id`）は役割が `ignored` でも取得する。外部の変更を取り込むため）。`url` が目印と一致する予定は、どのカレンダーにあっても `is_own_timeblock = 1`・`own_timeblock_id` を入れ、週ボード・デイビュー・busy・空き時間・放置・日報の会議時間に数えない（自分の時間ブロックは時間ブロックとして1回だけ数える）。既定のカレンダーは役割が `source`（表示する）のままなので、この目印による除外が二重計上を防ぐ唯一の仕組みになる。役割が `ignored` のカレンダーの予定は従来どおり表示・busy に数えない
- Calendar.app 側で動かした・伸ばした（`lastModified` が `external_updated_at` より新しく、開始・終了が違う）ときは外部を優先してブロックの時刻を変える（`synced` のまま。こちらにも反映待ちの変更があった場合は外部を優先して `conflict` にし、詳細パネルに「カレンダー側の変更を優先しました」と出すだけ）。Calendar.app 側で消した（そのブロックを書いたカレンダーの窓の中で見つからない）ときはブロックを外す（タスクは残る）。照合はブロックごとに、書いたカレンダー（`writeback_calendar_id`）の予定と比べる。題名の変更は取り込まない（タスクの題名が正）
- ヘルパの版: 0.2.0 で `upsertEvent` / `deleteEvent` / `listSources` / `createCalendar` を足した。0.3.0 で `upsertEvent` の `calendarId` を省略可にし（デフォルトカレンダーの解決）、結果に `calendarId`、`listCalendars` に `isDefault` を足し、更新を目印付きの予定に限った（D-072）。古いヘルパ（method not found、または既定の書き戻しで 0.3.0 より前）なら `error`（`helper_outdated`）にし、`turnlane calendar status` と設定画面に「ヘルパを更新してください」と出す。入れ替えは S1 と同じ署名でビルドし直して `turnlane calendar install`（[手順](../dev/m3-3.md)）
- 表示: タスクの詳細パネルの「時間」の下に書き戻しの状態（`Calendar: synced` / `waiting` / `error · <code>` / `changed in Calendar` / `not written · from before writeback started`（`disabled`。D-073））。設定画面の「カレンダー」に書き戻し先の選択（`Calendar.app default (<名前>)` / 書き込めるカレンダー / `Off`）、今の書き先、反映待ち・エラーの件数、既定のカレンダーが無い・書き込めないときの案内

**M3 の A の完了条件（常用開始の条件の一部。4.9）**: Calendar.app で追加した会議が1分以内に週ボードへ出る。会議中の待ちが放置に入らない（自分の記憶と照合）。`turnlane calendar status` に祝日カレンダー（または「なし」）が出て、金曜や祝日の前日に `nextWorkday` が正しい日を返す。

**D-097 の方式（会議前に聞く集中モード。2026-10-07。m2-api 25章、ux-mvp 4.15、desktop-shell.md 3.5）**

- 対象の予定・聞く時刻・答え・集中中の通知・まとめの通知・手動・閉店モードとの関係は m2-api 25章。純粋な判定（会議リンク、対象の予定、問いの計画、集中中の絞り込み、まとめの件数と文言）は `packages/core/src/focus/` に置き、偽の時計の表駆動テストで確かめる。状態と時刻の進行は `apps/daemon/src/focus/`（FocusService。30秒ごとと `calendar` / `settings` の後に回す）、通知の絞り込みは NotifyRunner
- ヘルパ 0.5.0: `fetchEvents` の各予定に `hasMeetingLink`。デーモンは 0008 の `calendar_event.has_meeting_link` に入れる（0.5.0 より前はデーモンが URL・場所で判定）
- デスクトップアプリ: 通知上のボタン（`UNNotificationAction`）、メニューバーの集中のアイコンとサブメニュー。web: 画面上部の帯、⌘K、キーボードの設定、設定の通知の節

**M3 完了条件（B まで）**: 上に加えて、Turnlane で作った予定がスマホの Google カレンダーにも出る（Calendar.app のデフォルトカレンダーに。D-072・D-093）。Turnlane で動かした・伸ばした・題名を変えた・消した予定が Calendar.app に反映され、Calendar.app 側で変えた予定は次の同期で Turnlane に出る。タスクを時間軸に置いてもカレンダーは変わらない。

### 4.6 M4 儀式 / 日報（5.75日。うち常用開始前 A 3日 / 常用中 B 2.75日）

> **D-192 で廃止（2026-10-14）**: 朝の計画・シャットダウンの画面と閉店モードは無くなり、日報は「記録」（デイビューの右のパネル。ux-mvp 8章）、持ち越しは「残り N 件を今日へ」（ux-mvp 4.4）になった。以下は履歴として残す。

確定デザインに合わせて見直した: シャットダウンは2ステップ（Your turn → Daily note。S1）、朝の計画は3ステップ（Overnight → Carried over → Today's shape）、どちらもサイドバーなし・中央 760px の1カラムで1画面1判断。シャットダウンで未完了タスクを1件ずつ聞くのをやめ、次の稼働日へ自動で持ち越して日報の Carried over に出し、朝の Step 2 で振り分ける。AI の残り（running）は聞かず、日報の What the AI did に状態を書く。

2026-10-03: 持ち越し先の「次の稼働日」は M3-6 の `nextWorkday`（土日・祝日を除く平日が既定。D-040）で決める。日報の AI 要約（M4-6）を保留から Phase0 に入れた（D-041。常用中に入れる B）。

| ID | タスク | 見積 | 依存 | 段階 |
|---|---|---|---|---|
| M4-5 | 儀式の共通レイアウト: サイドバーなし・中央 760px、ステップ表示（`1 Your turn  2 Daily note` / `1 Overnight  2 Carried over  3 Today's shape`、`Step n / N`、`Skip`）、1件ずつ判断する行（M2-6 の行部品の右にボタンとキー表示）、フッタのキー一覧、`⌘⏎` 次へ、`Back`。入口: 朝はその日初めて UI を開いたとき（日付区切り後）の上部の帯「Plan the day ⏎ / Skip」（モーダルにしない）、夕方は ⌘K とサイドバーの Daily note の `Close the day` | 0.5 | M2-6, M2-7 | A |
| M4-3 | 日報: `core/report/daily.ts`（テンプレート、LLM 不要）。内容: 日付、`Time: You 5h10m (meetings 1h30m) · AI 4h05m (7 runs, up to 3 in parallel)`、`Idle 42m · Expired 1` とリポジトリ別の放置、期限切れになった項目の名前（`Expired: Rename env var question`。S3）、What I did（時間付き。AI 由来は `← AI: <AI 項目のタイトル>`）、What the AI did（`[repo] タイトル — 結果 (AI 38m)`。結果は `PR #142 open, your turn` / `PR #138 merged` / `done` / `waiting for your answer, carried over`（質問で止まっている）/ `waiting for approval, carried over`（許可待ち）。D-052 (3)。AI の時間は終わったターンの所要時間の和に、終わっていないターンの始まりから「実行中なら今、待ち中なら待ちの始まり、止まって見えるなら最後の活動」までを足す）、Carried over（`→ Mon 10/5`）、Note。見出しは UI の言語に合わせる（M2-12 の辞書）。Markdown コピー、`daily_note.report_md` に確定保存、日報の画面（サイドバーの Daily note、`g r`。過去日の日報もここで開く。M4-2 の Step 2 と同じ部品）、`turnlane report`、MCP `get_daily_report`。golden テスト（英日） | 0.75 | M1-9, M2-12 | A |
| M4-2 | シャットダウン（2ステップ）: Step 1「Your turn」— 未処理の自分の番を1件ずつ。`⏎` 開く・対応（全行。PR を開く、セッションに移る。S2）、`m` 明日（自分の番のタスクを次の稼働日へ移し、次の稼働日の勤務開始までスヌーズする。今日の帯から消え、放置に数えない。YOUR TURN 帯・キューの `m` も同じ。D-052 (1)）、`e` 対応不要、`s` スヌーズ、`j` / `k`、`⌘⏎` 次へ。許可待ちにだけ琥珀で「This session stays blocked until you approve.」。一覧の下に今日自動で閉じた件数（replied / resolved / not needed / expired）。Step 2「Daily note」— 上部に `Worked 8:42 – 19:40 (auto) · Edit`（その場で修正し `PUT /api/work-hours/:date`、日報を計算し直す）、自動生成した日報の表示と編集、`Copy Markdown`、Note（1行）、右に小さな積み上げ棒（You / Meetings / AI / Idle）、`Close the day ⌘⏎` で `daily_note.report_md` を確定し、閉店時刻をその日の勤務の終わりに固定して（3.3.1。D-079）閉店モード（次の勤務開始まで通知をすべて止める。次の勤務開始は次の稼働日のいつもの開始時刻で、それより前に操作があればその時刻。設定「閉店後も許可待ちを通知する」（`notify.needs_input_after_close`、既定オフ）で needs_input だけ通知できる。D-052 (2)）。今日の未完了タスクは次の稼働日へ持ち越す（`rollover_count` 加算。稼働日は M3-6 の `nextWorkday`。既定は土日・祝日を除く平日で、祝日カレンダーが無ければ土日だけを除く。祝日を飛ばしたら Carried over に理由を出す）。AI 要約の表示は M4-6 で足す。D-079: 閉店後は今日の列（3日ボード・デイビュー）に `Closed · Reopen` を出し、押すと閉店を解除する（勤務時間が再び延び、閉店モードも解ける）。⌘K に「今日を閉じる」「今日を再開する」、メニューバーのポップオーバーに「今日を閉じる」 | 1.25 | M4-3, M4-5, M3-6 | A |
| M4-4 | 日付区切りジョブ（既定 04:00）: SSE で `day_boundary` を流し、UI の「今日」を切り替える（暦の日付が変わったときも流す。表示の「今日」は暦日。D-054）。your_turn → done の24時間ルールの点検 | 0.5 | M1-7 | A |
| M4-1 | 朝の計画 Step 1・2: Step 1「Overnight」— 前日の閉店（無ければ前日の勤務終了）以降の AI の結果のうち、判断が要るもの（自分の番・エラー）だけを1件ずつ。`t` 今日（エラーは `Retry today` で今日のタスクを作る）、`m` 明日、`e` 対応不要、`⏎` 開く、`⌘⏎` 次へ。完了だけのものは「Done overnight N — …」の1行に畳み、判断を求めない。夜間の待ちには `waited off hours` と「Overnight waiting is off hours and never counts as idle.」、勤務時間外に始まった待ちは `since 22:51`（M1）。Phase 0 のエラーは Claude Code / Codex のものだけ（M3）。Step 2「Carried over」（画像なし。M2）— Step 1 と同じ行部品で、`t` 今日（`rollover_count` 加算）、`m` 日を選ぶ、`⌫` やめる（Drop。タスクを canceled にする） | 1 | M4-5, M4-2, M1-8 | B |
| M4-7 | 朝の計画 Step 3「Today's shape」: 左に週ボードの今日カラムと同じ部品（M2-3・M2-13 を幅を絞って使う）、右に `Planned 6h45m / Free 5h15m`、超過の警告（無彩色の三角＋「Over by 1h30m.」）、移動候補（純粋関数 `core/plan/suggest-moves.ts`: 時間ブロックの無い未着手のタスクを、`*` を付けていないもの・並びの下のものから、超過分が収まるまで次に空きのある稼働日へ。表駆動テスト）、候補の間の移動は `↑` / `↓`（Step 3 では `j` / `k` を候補の移動に使わない）、選んだ候補を `⏎` で適用、`k` で Keep as is（D-039）。自動では削らない。`Start the day ⌘⏎` | 0.75 | M4-1, M2-3, M3-6 | B |
| M4-6 | 日報の AI 要約（オプトイン。D-041。下の仕様）: 設定 `report.ai_summary`（既定オフ）と有効化時の説明（送る内容 = 日報の Markdown だけ、送り先 = 選んだツールの提供元）、CLI の検出とフラグの確認、`apps/daemon` の要約ジョブ（子プロセス、stdin、タイムアウト、出力の検証、同時に1件）、追加マイグレーション（`daily_note.ai_summary_md`・`ai_summary_tool`・`ai_summary_at`）、`POST /api/daily-notes/:date/summary` と SSE、シャットダウンの Step 2 と日報の画面の Summary 欄（生成中・失敗の1行・`Retry`・編集）、Markdown コピーと `turnlane report` の先頭に Summary を付ける、要約用の作業ディレクトリを取り込みの除外ルールに登録。テストは偽の `claude` / `codex` スクリプトで（成功・タイムアウト・終了コード非0・空出力・巨大出力・PATH に無い）、stdin に日報以外が入らないことを番兵テストで確認。**済み**（2026-10-05。下の「実装で決めた細部」、docs/dev/r3.md） | 1 | M4-3, M4-2 | B |

合計 5.75日（A: M4-5 0.5 + M4-3 0.75 + M4-2 1.25 + M4-4 0.5 = 3。B: M4-1 1 + M4-7 0.75 + M4-6 1 = 2.75）。2026-10-03 に M4-6 を保留から Phase0 に入れて +1日（前回の仮見積 0.75 から、CLI の検出・フラグの確認・作業ディレクトリの除外・遅れて届く要約の扱いを足して 1 にした）。それ以前の経緯: 前回（3日）からの増分 +1.75日: 儀式の共通レイアウト（+0.5）、日報の内容の追加（実行数と最大並列、期限切れの項目名、AI 由来の印、結果の書き分け、英日。+0.25）、シャットダウンの日報ステップ（勤務時間のその場修正、編集、積み上げ棒。+0.25）、朝の計画の Step 3 の移動候補（+0.75）。

**日報の AI 要約の仕様（M4-6。D-041、ADR 0005 の追記）**

- **何をするか**: 日報のテンプレート出力（`core/report/daily.ts` の Markdown）を、ユーザー自身が入れている `claude` か `codex` の CLI にローカルで渡し、2〜3文の要約（「今日は何だったか」）を返してもらう。Turnlane 自身はネットワークに出ない。要約は選んだツールがユーザーのアカウントで提供元（Anthropic / OpenAI）へ送って作る。
- **渡すもの**: 固定のプロンプト（`packages/core/src/report/summary-prompt.ts`。出力言語は UI の言語、日報に無いことを書かない、2〜3文、Markdown の見出しを付けない）と日報の Markdown だけ。会話本文・プロンプト・ツール入出力は Turnlane がそもそも持っていない（ADR 0005）ので渡しようがないが、組み立て関数の入力型を「日報の Markdown 文字列」だけにして構造で守る。日報に含まれるのはタスク名、AI 項目のタイトル、リポジトリ名、PR 番号、時間、Note。タイトルを保存しないモード（ADR 0005）ではタイトルも入らない。有効にするときの説明にこの一覧と送り先を出す。
- **既定はオフ**。`report.ai_summary = { enabled: false, tool: "claude_code" | "codex", bin: null, claude_config_dir: null, timeout_sec: 90 }`。設定画面（M2-9）が入るまでは `turnlane config set report.ai_summary '{...}'` で有効にする。
- **CLI の検出**: デーモンは LaunchAgent 配下で PATH が最小なので、(1) 設定の `bin`、(2) ログインシェルでの `command -v claude` / `command -v codex`（`$SHELL -lc`、5秒で打ち切り）、(3) 既知の場所（`~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`）の順に探し、見つけた絶対パスを `bin` に保存する。見つからなければ設定画面と `turnlane doctor` に「claude が見つからない」と出し、要約は作らない。検出時に `--help` の出力を見て、下の起動フラグがあるかを確かめる（無いフラグは付けない）。
- **起動の仕方**（引数は配列で渡し、シェルを通さない。cwd は要約専用の空ディレクトリ `<データディレクトリ>/summarize/`）:
  - Claude: `claude -p --output-format text --tools "" --no-session-persistence`。プロンプトと日報は stdin で渡す。Claude の設定ディレクトリが複数あるときは `claude_config_dir` を `CLAUDE_CONFIG_DIR` に入れる（既定は検出した最初のもの）。
  - Codex: `codex exec --ephemeral --skip-git-repo-check --sandbox read-only -C <summarize dir> -o <一時ファイル> -`。プロンプトと日報は stdin で渡し、結果は `-o` のファイルから読む。
  - セッションを保存しないフラグが無い版や、ユーザーの hooks（`turnlane hook` を含む）が動く場合に備え、`summarize/` を取り込みの除外ルール（M1-6 の既存の仕組み。新しい取り込みの処理は作らない）に登録し、要約の実行が AI 作業として数えられないようにする。
- **タイムアウトと失敗**: 既定90秒で SIGTERM、5秒後に SIGKILL。終了コード非0・空出力・2,000文字を超える出力は失敗として扱い、要約なしにする。stdout は 16KB で読み捨てる。失敗の理由（`not found` / `timed out` / `exit 1` など）はメタデータとしてログに残すが、stdout / stderr の中身はログに書かない。**要約の失敗で日報の保存は止めない**。
- **いつ作るか**: シャットダウンの Step 2 を開いたときにバックグラウンドで始め、Summary 欄に「Summarizing…」を出す。`Close the day` の時点で終わっていなくても日報（`report_md`）はそのまま確定し、要約は届いたら `ai_summary_md` に保存して SSE で日報の画面に反映する。失敗したら Summary 欄に1行（`Summary unavailable — claude timed out · Retry`）。勤務時間の `Edit` で日報を計算し直したときは要約を作り直す（実行中のものは取り消す）。過去日の日報の画面からも `Retry` で作れる。
- **保存と出力**: 要約は `report_md` と分けて `daily_note.ai_summary_md` に置き（ユーザーが編集できる）、`ai_summary_tool`（`claude_code` / `codex`）と `ai_summary_at` を記録する。Markdown コピーと `turnlane report` では先頭に `## Summary`（見出しは UI の言語）として付け、末尾に生成したツールを小さく書く（`(summary by claude)`）。MCP `get_daily_report` も同じ。
- 追加マイグレーション 0006 の列（`ai_summary_md`・`ai_summary_tool`・`ai_summary_at`）は 2.3 の DDL に反映した（2026-10-05）。
- **実装で決めた細部**（2026-10-05）:
  - 要約する Markdown はデーモンが組み立てる: 確定済みなら `report_md`、未確定ならその時点の事実から組み立てた日報（Note を含む）。Step 2 で編集中の本文は渡さない（Close the day / Update の後に `Retry` すれば確定した本文で作り直せる）
  - API: `POST /api/daily-notes/:date/summary`（`{lang?}`。実行中のものを取り消して作り直す。オフなら 409 `summary_disabled`）、`PUT /api/daily-notes/:date/summary`（`{summary: string | null}`。手で直した要約を保存し、実行中のものは取り消す）、`GET /api/summary/tools`（`claude` / `codex` の検出結果と使えるフラグ。`?refresh=1` で検出し直す）。`/api/rituals/shutdown` と `/api/reports/daily/:date` は `summary`（`{enabled, md, tool, at, job}`。`job` は実行中か失敗の理由。デーモンのメモリにだけ持ち、再起動で消える）と、`/api/reports/daily/:date` は `exportMarkdown`（先頭に Summary を付けた全文。`?format=md`・`turnlane report`・MCP `get_daily_report` はこれを返す）を足す
  - SSE は `daily_note`（`{dates}`）を足し、UI は儀式と日報のキャッシュだけを取り直す
  - 生成は `Close the day` を待たない。Step 2 を開いたとき、要約が無く実行中でもなければ始める（失敗した後は自動では作り直さず `Retry` を待つ）。勤務時間の `Edit` を保存したら作り直す
  - 子プロセスの環境: `PATH` は見つけた CLI のディレクトリ・`/opt/homebrew/bin`・`/usr/local/bin`・`/usr/bin`・`/bin`（npm で入れた `claude` が同じディレクトリの `node` を使えるように）。Claude の設定ディレクトリが複数検出されていて `claude_config_dir` が未設定なら、最初に検出したものを `CLAUDE_CONFIG_DIR` に入れる
  - 要約の作業ディレクトリ（`<データディレクトリ>/summarize`）の除外は、取り込み元ごとの `exclude_globs_json` には書かず、取り込みの除外判定（`cwdAllowed`）に常に足す組み込みの規則にする（設定画面の除外 glob の一覧に出ず、消せない）
  - 見つけた `bin` の保存は、要約を有効にしたとき（設定画面の On）と要約を始めるときに `bin` が未設定なら行う
  - 子プロセスは自分のプロセスグループで起動し、打ち切り・取り消しはグループごと止める（CLI の子が stdout を握ったまま残っても、時間どおりに要約なしにする）
  - 設定画面: オフからオンにするときは、送る内容と送り先の説明の下の「Turn on」で確かめてから有効にする（オンの間も説明を出したまま）。使うツール、検出した CLI のパスと無い起動フラグ、「Detect again」、Claude の設定ディレクトリが2つ以上なら使うアカウント、時間の上限（秒）
  - `turnlane doctor` に「日報の AI 要約: オン（claude: <パス>）」/「claude が見つかりません」を出す。MCP `get_daily_report` は先頭に Summary を付けた Markdown を返す

**M4 の A の完了条件（常用開始の条件の一部。4.9）**: シャットダウンを1回通して、自分の番の処理、勤務時間の確認、日報の確定、閉店モードまで進める。金曜に閉じると未完了タスクが月曜（月曜が祝日なら火曜）に持ち越される。

**M4 完了条件（B まで）**: 朝の計画とシャットダウンを3日続けて行い、朝は5分以内、夕方は3分以内に終わる。日報をコピーしてそのまま他所（Slack やメモ）に貼れる。AI 要約をオンにした日は、日報に2〜3文の要約が付き、CLI を外した（PATH から消した）状態でも日報は要約なしで保存される。

### 4.7 M5 常用開始（2.5日 + 14日間の運用）

| ID | タスク | 見積 | 依存 |
|---|---|---|---|
| M5-1 | 利用計測: `usage_event` の記録（UI を開いた、儀式完了、フォローアップ処理）、`turnlane stats`（連続利用日数、週あたりの処理数、平均応答）。**常用開始の前に入れる**（14日カウントの初日から記録するため。4.9） | 0.5 | M4-2 |
| M5-2 | 堅牢化: スリープ復帰後の watch 再登録、デーモン異常終了からの復帰（spool から取り戻せるか）、初回バックフィルの性能（30日分を60秒以内、常駐メモリ 200MB 以下）、Playwright スモーク1本 | 1 | M2-19 |
| M5-3 | フィクスチャ更新の手順化（`turnlane fixtures capture` → 匿名化 → snapshot 更新）と、ツール更新時の警告帯 | 0.5 | M1-12 |
| M5-4 | 使いながら出た不具合と UX の修正枠 | 0.5〜 | — |
| M5-A | 勤務時間の撤去と在席による放置（D-105・D-106・D-110、ADR 0013）: デーモンの在席の記録（FFI / ioreg、30 秒ごと、`presence_span`）、待ちの区分の `closed` / `away`（`off_hours` をなくす）、一日を閉じてから翌朝 Mac を使い始めるまで数えない、`idle.presence_since` より前を作り直さない、マイグレーション 0009（`work_day_auto`・`daily_note.work_start_at` / `work_end_at` を消す）、空きを計画の目安から出す（今日は計画の目安 ∩ [今, 終わり]）、勤務の行と編集・勤務時間のパネル・稼働開始の線・日報の勤務時間・勤務日を分ける設定・`PUT /api/work-hours/:date`・SSE `work_hours` を消す（SSE は `plan_guide` に）、設定の「計画の目安と稼働日」と「Mac を使っていたとみなす長さ」。M1-9・M2-2・M2-6・M2-9・M2-13・M2-16・M4-1・M4-2・M4-6 のうち勤務時間に関わる部分はこれで置き換える | 6.5 | — |

**M5 完了条件（Phase0 のゴール）**: `turnlane stats --days 14` で14日連続の利用（UI を開いた日、かつ朝か夕方の儀式を1回以上行った日）が記録され、その間、紙や他のタスク管理ツールを使っていない。週あたりの「AI 起点の自分の番」の処理件数（主要指標）が計測できている。

### 4.8 M6 公開準備（約22日。うちリポジトリと配布の準備 8.5日、アプリ統合とオンボーディング 13.5日（4.8.1）。Phase0 のゴール達成後）

GitHub の個人アカウントで MIT として公開する前の準備（ADR 0008）。Phase0 の14日判定が終わってから着手し、4.9 の合計（Phase0）には含めない。署名・リリースの仕組み（M6-8〜M6-10）は Tauri アプリにもそのまま使う。D-088 で、アプリ統合（配布物を Turnlane.app 1つにする。ADR 0011）とオンボーディング（S12）を公開の範囲に入れた。そのタスクは下の 4.8.1（M6-S8・M6-13〜M6-27）にあり、設計は [onboarding.md](./onboarding.md)。

| ID | タスク | 見積 | 依存 |
|---|---|---|---|
| M6-1 | 依存ライブラリのライセンス確認（`bun pm ls --all` から一覧を作り、GPL 系が無いこと。同梱するもののライセンス表記を `THIRD_PARTY_NOTICES` にまとめるかを決める）。LICENSE（MIT、著作権者は 2026-10-26 から `Rootstack Inc.`）は作成済みで、README の表記も更新済み | 0.25 | — |
| M6-2 | README を英語を主に書き換える（概要と GIF / スクリーンショット、インストール、プライバシー: サーバーなし・本文を保存しない・通信先の一覧（利用者の `gh` による GitHub の参照と、更新確認の GitHub Releases。更新確認の送信内容とオフにする方法を書く）、対応ツールとバージョン、サポート方針、License）。日本語版は `README.ja.md` | 1 | M6-1 |
| M6-3 | `CONTRIBUTING.md`（開発環境、テスト、フィクスチャの匿名化、3.1.1 のアダプタ追加手順、コミットと PR の基準）と `packages/collectors/README.md` の英語化 | 0.5 | M1-13 |
| M6-4 | `CODE_OF_CONDUCT.md`（Contributor Covenant 2.1）と `SECURITY.md`（報告窓口は GitHub の Private vulnerability reporting。対象: localhost API の認証・Host / Origin 検証、本文の混入、hooks 設定の破壊、署名済みバイナリ。対応は best effort で期限を約束しないと明記） | 0.25 | — |
| M6-5 | issue forms（bug: Turnlane・macOS・Claude Code / Codex のバージョン、`turnlane doctor --redact` の出力、再現手順を必須。adapter request: ツール名、ログの場所、本文を含まない構造の説明）、`config.yml` で白紙の issue を無効にして質問を Discussions へ誘導、PR テンプレート（テスト、匿名化、本文を扱っていない、ルート外を読まない）、Discussions のカテゴリ（Q&A / Ideas / Adapters / Show and tell）、ラベル。サポート方針（サポートの約束はしない、質問は Discussions、必須項目が欠けた issue は閉じる）を `SUPPORT.md` と README に書く | 0.5 | M6-2 |
| M6-6 | `turnlane doctor --redact`: issue に貼れる環境情報（各バージョン、検出したソースと health、hooks の状態、DB のスキーマ番号）を、ホームのパス・ユーザー名・リポジトリ名を伏せて出す。実装済み: 項目は許可リストで組み立て（設定ディレクトリは default / profile-N、カレンダーは件数、題名は出さない）、最後にホーム・ユーザー名・ホスト名・リポジトリ名を全体から伏せる。issue に貼るので英語 | 0.5 | M1-12 |
| M6-7 | git 履歴の個人情報監査: gitleaks（秘密）と独自パターン（ホームのパス、ユーザー名、メールアドレス、ホスト名、社名、私的なリポジトリ名）で全ブランチ・全履歴を検査する。`spikes/` の結果ファイル、フィクスチャ、スナップショットを目視確認。コミットの author を noreply アドレスに揃える。**拡張の中身の検査（ADR 0015）**: `bun scripts/audit-public.ts --deny <一覧のファイル>` でツリー（と `--history` で全履歴のパッチとコミットメッセージ）を検査し、拡張の機能名・価格・拡張のリポジトリのパスが本体に無いことを確かめる。一覧のファイルは本体のリポジトリに置かない（拡張のリポジトリが持つ。一覧そのものが拡張の中身を含むため）。**問題が見つかったら履歴は書き換えず、監査を通した現在のツリーから新しいリポジトリを作って公開する**（PO 決定。書き換えの漏れより確実なため）。その場合、元のリポジトリは非公開のまま残し、新しいリポジトリの最初のコミットに元リポジトリのどのコミットから作ったかを書く。手順は `docs/dev/public-history.md`（作業ツリーの1コミットから orphan で作る。過去の履歴は対象外。D-095）。gitleaks の誤検出の除外は `.gitleaks.toml` | 1 | — |
| M6-8 | 署名・公証: Developer ID Application 証明書で `turnlaned`・`turnlane`・`TurnlaneCalendarHelper.app` に署名（hardened runtime、Bun の単一バイナリに要る entitlements の確認）、`notarytool` で公証、配布物（zip / dmg）に staple。Apple Development 署名から変わることで TCC の許可が外れる場合の再許可手順を `turnlane doctor` と README に書く。ビルド側は実装済み（`scripts/signing.ts`・`build:app` の公証と staple・`--dry-run`・doctor の署名の行。手順は `docs/dev/codesign.md` 5 章）。本番の公証の通しは未 | 1.5 | M5-2 |
| M6-9 | Homebrew 配布: 自前の tap（`homebrew-tap` リポジトリ）に cask を置く。`brew install --cask` → `turnlane self-install` の導線、`uninstall`（LaunchAgent の停止と削除）と `zap`（データディレクトリ。既定では残すと README に明記）。公式の homebrew/cask への登録は利用者が増えてから検討 | 1 | M6-8 |
| M6-10 | リリース手順: SemVer（0.x から）、`CHANGELOG.md`（Keep a Changelog）、タグの push で GitHub Actions が build → 署名 → 公証 → GitHub Releases へアップロード（sha256 付き。更新確認用の `latest.json` も添付）→ tap の cask を更新する PR。署名用の証明書と App Store Connect API キーは Actions の secrets。手順と失敗時の手動復旧を `docs/release.md` に書く | 1 | M6-8, M6-9 |
| M6-12 | 更新確認（ADR 0008 の追記）: デーモンが1日1回、GitHub Releases の最新リリースに添付した静的ファイル `latest.json`（`releases/latest/download/latest.json`。版、ダウンロード URL、sha256）を GET し、新しい版があれば UI と `turnlane doctor` に知らせる。Homebrew 版は通知だけで、更新は `brew upgrade --cask` を案内する。送るのは HTTP リクエストだけで、Cookie・端末やユーザーの識別子・利用状況を付けない（User-Agent は `turnlane/<version>`）。GitHub の API（`api.github.com`）は使わない。設定 `update.check`（既定オン）でオフにでき、オフなら接続コードを通らない。README に接続先・送信内容・オフにする方法を書く。テストは偽の HTTP サーバで、オフ時に接続が0回であることを確認する。実装済み（`apps/daemon/src/update/checker.ts`、`GET /api/update`・`POST /api/update/check`、SSE `update`）。確認先 `UPDATE_FEED_URL`（`packages/core/src/update.ts`）は公開リポジトリができる M6-10 で入れ、それまでは確認しない | 0.5 | M6-10 |
| M6-11 | 公開判定: 名称・商標・bundle ID 接頭辞（`dev.turnlane.`。ADR 0016 で確定済み）の反映を確かめる、新しい macOS ユーザーアカウントで cask からインストール → 主要機能のスモーク、英語 README の見直し、リポジトリを public にする（M6-7 で問題が見つかっていれば、新しいリポジトリを public にする） | 0.5 | M6-1〜M6-10, M6-12 |

合計 8.5日（M6-1 0.25 + M6-2 1 + M6-3 0.5 + M6-4 0.25 + M6-5 0.5 + M6-6 0.5 + M6-7 1 + M6-8 1.5 + M6-9 1 + M6-10 1 + M6-11 0.5 + M6-12 0.5）。

この表の M6-8・M6-9・M6-11 は 4.8.1 のアプリ統合の後に行い、対象は `Turnlane.app` 1つになる（`turnlaned`・`turnlane`・ヘルパは中に同梱。M6-8 の署名は M6-13 のビルドが内側から行う。M6-9 の cask は ADR 0011 の決定 6（`binary`、`launchctl` は `zap` にだけ書く、`postflight` なし）。M6-11 の「新しい macOS ユーザーアカウントで cask からインストール」は M6-27 の通しに置き換える）。

#### 4.8.1 アプリ統合とオンボーディング（D-088。+13.5日）

設計は [onboarding.md](./onboarding.md)、決定は [ADR 0011](../adr/0011-single-app-bundle-smappservice.md)。

| ID | タスク | 見積 | 依存 |
|---|---|---|---|
| M6-S8 | スパイク（新しい macOS アカウントで。オーナーの環境に触れない）: Tauri から objc2 で `SMAppService.agent` / `mainApp` を登録できるか、同梱のヘルパのカレンダーと turnlaned のオートメーションの許可がどちらに付くか（onboarding 2.3 の 1〜4）、同じ場所に新しい版を置いたとき登録と許可が残るか、`turnlane hook` が見つからないときの Claude Code / Codex の挙動、Developer ID で内側から署名した .app の公証が通るか（Developer ID が無ければ Apple Development で分かる範囲まで）。結果を ADR 0011 に追記 | 1 | — |
| M6-13 | バンドルの組み立て `bun run build:app`（onboarding 2.1）: turnlaned・turnlane を `Contents/Helpers`、ヘルパを `Contents/Library/LoginItems`、LaunchAgent の plist 2つ、Info.plist の用途の説明、版の書き込み、内側からの署名、Developer ID のときは公証と staple。CI でバンドルの形と署名を検査。実装済み（`scripts/build-app.ts`。`--ext`・`--zip --download-url`。最後に `checkBundle` で形・版・署名を検査。CI での .app の組み立ては未。Developer ID・公証は M6-8 で実装済み） | 1 | M6-S8 |
| M6-14 | アプリの登録（Rust、objc2）: デーモン・ヘルパ・mainApp の `SMAppService`、IPC `desktop_setup`（onboarding 5.5）、`requiresApproval` と App Translocation（B1・B4）の検出、起動のたびの登録の確認、`bin/turnlane` のリンク。Welcome を boot ページに足す。Rust の行数の目安（ADR 0010 の 1,000 行）を見直す。実装済み（`apps/desktop/src-tauri/src/setup.rs`。O1 の B1・B4、起動のたびの再登録、ログイン項目として開かれたらメニューバーだけ、`--setup` の CLI。`bin/turnlane` のリンクはデーモンが起動時に合わせる。メニューの `Uninstall Turnlane…` は未。Rust は約 2,700 行で、目安の見直しは PO の判断） | 1 | M6-13 |
| M6-15 | 配置の方式と turnlane: `install.json`（`app` / `dev`）、`app` のときは `self-install`・`calendar install`・`desktop install` を止めて案内、hooks と MCP のパスを `bin/turnlane` に、`turnlane uninstall --all`（hooks・登録・リンク）、`turnlane link`（`~/.local/bin`）、`turnlane doctor` に登録の状態と署名を足す。`POST /api/hooks/install`。実装済み（`install.json`・`GET /api/install`・`POST /api/install/cli-link`、開発用のコマンドを止める、`turnlane link`・`uninstall --all`、doctor の配置の行。`/api/hooks/install` は作らず O5 の `/api/onboarding/hooks` を使う） | 1 | M6-14 |
| M6-16 | 旧配置からの移行 `turnlane setup migrate` とアプリの移行画面（onboarding 2.7・4.10）。旧 plist は消さずに退避し、失敗したら戻す。オーナーの環境で実行（名称の確定の後）。実装済み（CLI だけ: `turnlane setup migrate [--dry-run] [--rollback]`。移行の画面 4.10 は作らない。手順は docs/dev/app-migration.md） | 0.75 | M6-15 |
| M6-17 | 版を揃える（onboarding 2.5）: デーモンのバンドル版の監視と終了、ヘルパの版の入れ替え、`brew upgrade` 後のアプリの起こし直し、アプリの自己再起動と `Restart to finish update`、更新確認（M6-12）の案内を Homebrew / zip で分ける。一部実装（版は package.json の1か所から、デーモンのバンドルの版の監視と終了、更新確認の Homebrew / zip の案内、ヘルパの版の入れ替え（デーモンが同梱の版との違いを見てアプリの `--setup reregister calendarHelper`）、メニューの `Restart to Finish Update`（アプリが自分のバンドルの入れ替えに気づく）。アプリの自己再起動（ウインドウを閉じているとき）・brew upgrade 後のアプリの起こし直し・アプリの Uninstall メニュー・ボードへの更新の知らせは公開後（D-202） | 0.75 | M6-14 |
| M6-18 | デーモンのオンボーディングの状態と同意のゲート（onboarding 5.1・5.2）: 設定 `onboarding`、既存の DB は `done`、同意前は検出だけ、`/api/onboarding*`、オンボーディング中とバックフィル由来の通知を出さない | 1 | — |
| M6-19 | 検出の API（ファイルを開かずに件数と最終更新）、Claude Desktop の Code タブの扱いの表示、`Choose a folder…`（設定ディレクトリの手動追加） | 0.5 | M6-18 |
| M6-20 | 新しい日からの取り込み順、日ごとの完了の判定、SSE `import_progress`、`/api/onboarding/summary`、計画の目安・カレンダーの決定後の再計算 | 0.75 | M6-18 |
| M6-21 | SPA のオンボーディングの土台: `/onboarding` のルート、段の表示、再開、戻る・スキップ、キー操作、i18n（英・日）、設定 > 一般 の `Run setup again` | 1 | M6-18 |
| M6-22 | O2（取り込み元と同意）と O3（バックフィル。週表示の部品を読み取り専用で、新しい日を左に、埋まっていく表示、要約の1行、O3-sparse） | 1.5 | M6-19, M6-20, M6-21, デザイン |
| M6-23 | O4 カレンダー（ヘルパの登録 → 許可 → 結果、拒否・0件・起動しない）と、設定 > カレンダー の `Connect calendar` | 0.75 | M6-14, M6-21 |
| M6-24 | O5 hooks（設定ディレクトリごと、差分の表示、Codex の `/hooks` の案内と承認の反映、無効化・失敗） | 0.75 | M6-15, M6-21 |
| M6-25 | O6 計画の目安と稼働日（設定の部品を流用。D-105 で「勤務時間」から差し替え）、O7 通知（IPC で許可、確認の通知、拒否） | 0.75 | M6-14, M6-21 |
| M6-26 | O8 はじめる、塞がる状態 B1〜B4、設定の各節の `Not set up` の行、空状態から O2 への導線 | 0.5 | M6-22〜M6-25 |
| M6-27 | 新しい macOS アカウントでの通し（onboarding 8 章の 1〜15）と `docs/dev/onboarding-check.md`。M6-11 の前に行う | 0.5 | M6-8, M6-9, M6-26 |

合計 13.5日（アプリ統合 M6-S8・M6-13〜M6-17 で 5.5、オンボーディング M6-18〜M6-27 で 8.0）。M6-9（cask）の対象が変わる分は M6-9 の 1日の中で扱う。M6 全体は 8.5 → **22日**。デザイン（Claude Design での O3・O2・O1 などの確定）は PO とオーナーの作業で、見積に含めない。

順序（onboarding 9 章）: 14日の常用・振り返りと並行して M6-S8 と名称の確定 → M6-13〜M6-15・M6-17 と M6-18〜M6-20 を並行 → デザインの確定後に M6-21〜M6-26 → 名称の確定後に M6-16（オーナーの移行）→ M6-1〜M6-7、Apple Developer Program 登録（D-087）、M6-8 → M6-9 → M6-10 → M6-12 → M6-27 → M6-11。

削り順（公開を急ぐ場合に後ろへ回すもの。上から）: (1) M6-17 のアプリの自己再起動（メニューの `Restart to finish update` だけにする）(2) O3 の要約の1行（ボードが埋まる表示は残す）(3) `Choose a folder…`（M6-19）(4) 移行の画面（M6-16 は `turnlane setup migrate` の CLI だけにする）。削らないもの: 同意のゲート（M6-18）、O2・O3、SMAppService の登録（M6-14）、新しいアカウントでの通し（M6-27）。

**4.8.1 完了条件**: 新しい macOS アカウントで、cask から入れて Turnlane を開き、ターミナルを使わずに O1〜O8 を通して、過去7日のボードが埋まり、Claude Code の許可待ちが通知される。`brew upgrade` の後に全プロセスが新しい版になり、許可が外れない。オーナーの環境が `turnlane setup migrate` で新しい配置に移り、データが保たれている。

**M6 完了条件**: README だけを読んだ第三者が、Homebrew で入れて Gatekeeper の警告なしに起動し、取り込みまで進める。gitleaks と独自パターンの監査が全履歴で0件。issue を開くとテンプレートが出て、質問は Discussions へ誘導される。タグを1つ打つとリリースと cask の更新が自動で出る。古い版を入れた環境で新しい版の通知が出て、設定でオフにすると GitHub Releases への接続が起きない。

Phase0 の間に前倒しで守ること（M6 の手戻りを減らすため）: コミットの author は noreply アドレス、フィクスチャは匿名化のみ、スパイクの結果ファイルに個人のパスを書かない（CLAUDE.md 原則 5・10）、MIT と両立しない依存を入れない。

### 4.9 順序と削り順

見積の人日は相対的な大きさで、日程の約束ではない（4章の冒頭。D-042）。この節では「何をどの順に作るか」と「遅れたら何を後ろに回すか」を決め、進捗はフェーズとマイルストーンの完了条件で測る。

合計はおよそ **49人日**（S 3.5 + M0 5.5 + M1 11.5 + M2 17 + M3 3.25 + M4 5.75 + M5 2.5）。2026-10-05 の D-055 でデスクトップアプリを M2 段階 B に入れて +7.75人日（M2 24.75、合計 **56.75人日**。[desktop-shell.md](desktop-shell.md)）。下の表はそれ以前の経緯。公開準備の M6（約8.5人日）は Phase0 の後に別に行う。

| マイルストーン | 2026-10-02 | 2026-10-03（確定デザイン） | D-038〜D-041 | 今回（m2-api.md、D-047・D-048） | 差（今回） | 理由 |
|---|---|---|---|---|---|---|
| M2 | 8.5 | 16.25 | 16.5 | 17 | +0.5 | D-038〜D-041: 設定画面に稼働日・カレンダーの役割・AI 要約を足した（M2-9）。今回: SSE の送り方の修正、題名の読み取り時の解決、YOUR TURN の絞り込みとタスクのない your_turn の72時間（M2-2）、`/api/day` を M2-19 へ（4.4） |
| M3 | 5 | 2.5 | 3.25 | 3.25 | 0 | 稼働日と祝日（M3-6）、同期と待ち区間の再計算の結合テスト（M3-2） |
| M4 | 3 | 4.75 | 5.75 | 5.75 | 0 | 日報の AI 要約（M4-6）を保留から Phase0 に入れた |
| 計 | 39.5 | 46.5 | 48.5 | 49 | +0.5 | |

M1 の Idle 修正（M1-8・M1-9 への追加。D-045・D-046）は、M1 の見積（11.5）を変えずに扱った（M1 は完了済みで、見積は順序と削り順の判断に使うため。D-042）。

2026-10-03 の確定デザインへの合わせ込みでは、M2 が週ボードの時間軸と今日の AI レーン、デイビューと時間ブロックの移動、トークン・テーマ・i18n で +7.75、M3 が右レールの廃止とデイビューの移動で -2.5、M4 が儀式の共通レイアウトと日報の内容と朝の Step 3 で +1.75 だった（計 +7。M3 から M2 へ移した 2.5日は差し引き 0）。その前の表記 35.5人日は内訳の和 39.5人日と合っていなかった。

#### 常用開始（14日カウント）に必要な最小範囲

U16 の判定（UI を開き、かつ朝か夕方の儀式を1回以上行った日）を満たすには、儀式が1つと利用の記録が要る。加えて、予定が見えないと週ボードで1日の計画が立たず、会議中の待ちが放置に数えられて Idle（主要な指標の1つ）が狂うので、カレンダーの読み取りも常用開始の前に入れる（D-038）。シャットダウンの自動持ち越しが正しい日に行くよう、稼働日と祝日の判定（M3-6。D-040）も入れる。M1 の後で **17.5人日**。

| 範囲 | タスク | 見積 |
|---|---|---|
| M2 の A | M2-1, M2-11, M2-12, M2-2, M2-13, M2-3, M2-14, M2-6, M2-4, M2-7, M2-5, M2-8, M2-10 | 11.75 |
| M3 の A | M3-1（カレンダーヘルパ）, M3-2（読み取りの同期と待ち区間の再計算）, M3-6（稼働日と祝日） | 2.25 |
| M4 の A | M4-5（儀式の共通レイアウト）, M4-3（日報）, M4-2（シャットダウン）, M4-4（日付区切り） | 3 |
| M5 | M5-1（利用計測。カウントの初日から記録する） | 0.5 |
| 計 | | 17.5 |

儀式は夕方のシャットダウンを先に作る。YOUR TURN の行部品と日報をそのまま使えて、自分の番の処理（主要指標）と Idle の確認がそこで完結するため。朝の計画は M2-3・M2-13 の部品が揃ってから常用中に入れる。

常用開始の時点で無いもの（常用中に入れる）: デイビュー、時間ブロックの DnD とカレンダーへの書き戻し（M3-3）、朝の計画、日報の AI 要約（M4-6）、⌘K、日付移動と並べ替えの DnD（`m`・`>`・`<` で代用）、週ボードの仕上げ（過去日のリボン、範囲外のヒント、ホバーの接続線、開始境界のドラッグ。勤務時間はシャットダウンの日報の `Edit` で直す）、日本語の訳、設定画面（`turnlane calendar`・`turnlane config` などの CLI で代用）。

S1（EventKit ヘルパの TCC）が通らず M3 の A が詰まった場合は、カレンダーなしで常用を始め、その間の Idle は多めに出ることを受け入れる（M3 が入った後に `turnlane rederive --wait --since <date>` で窓内の日は直る）。この判断はオーナーに確認する。

#### 順序（フェーズ）

週ではなく順序で表す。各フェーズは前のフェーズの完了条件を満たしてから次へ進むのが基本で、依存の無いタスクは前のフェーズと並行して進めてよい。Claude Code / Codex に並列で実装させ、自分はレビューと統合に回る前提。

| フェーズ | 内容 | 終わりの目印 |
|---|---|---|
| 1. 土台と検証 | S4 → S3・S2 → S1・S5、M0 | M0 の完了条件、S1 の合格（M3 の A の前提） |
| 2. 取り込みと画面の土台 | M1。並行して M2-1・M2-11・M2-12・M2-13（データに依存しない土台）、M3-1（S1 の後。M1 と独立） | M1 の完了条件 |
| 3. 常用開始の最小範囲 | M2-2（M1-9 の後）・M2-3・M2-14・M2-4・M2-7・M2-10・M2-6・M2-5・M2-8、M3-2・M3-6、M4-3・M4-5・M4-2・M4-4、M5-1 | 上の最小範囲がすべて終わり、M2・M3・M4 の A の完了条件を満たす → **常用開始（14日カウント開始）** |
| 4. 常用しながら（前半） | **先頭にデスクトップアプリ**（M2-S6 → M2-D1〜M2-D10。M2-D4 までで通知とメニューバーが使える。[desktop-shell.md](desktop-shell.md) 10章）、M2-17・M2-18・M2-19、M3-3（M2-18 の後）、M2-15 | M3 の完了条件（書き戻し）、M2 の完了条件の時間ブロックとデイビューの部分 |
| 5. 常用しながら（後半） | M4-1・M4-7、M4-6、M2-16・M2-20・M2-9、M5-2・M5-3 | M2・M4 の完了条件 |
| 6. 14日の完了 | 14日間の運用、M5-4 の修正 | M5 の完了条件（Phase0 のゴール） |

遅れた場合に削る順（後ろに回すもの。上から先に削る）:
1. デイビューの細部（M2-19 のコネクタ、放置区間のホバー、AI 区間のポップオーバー、Closed today）。週ボードの今日カラムで代用する
2. 時間ブロックの伸縮・範囲選択での作成・AI 項目からの作成（M2-18 は作成と移動だけにする）
3. 日報の AI 要約の作り直しと過去日での生成（M4-6 はシャットダウン時の1回だけにし、`Retry` と勤務時間修正後の作り直しを後ろに回す）
4. 朝の計画 Step 3 の移動候補（M4-7 は `Planned / Free` と超過の警告だけにする）
5. ⌘K パレットの検索（M2-15 はコマンド実行だけにする）
6. 週ボードの仕上げ（M2-16）。勤務時間の修正はシャットダウンの `Edit` で行う
7. 祝日カレンダーの自動判定（M3-6 は `turnlane calendar holidays --set` での手動選択だけにする。稼働曜日の判定と持ち越しは削らない）
8. PR 状態ポーラ（review_pr は手動完了にする）
9. claude-desktop アダプタ（初めから任意）
10. ブラウザ通知のまとめ機能（即時通知のみにする）

日報の AI 要約（M4-6）そのものは Phase0 に入れる（D-041）。削るのは上の 3 の範囲まで。

削らないもの: 取り込みの冪等性とプライバシー（M1-2, M1-12）、フォローアップの自動生成と自動クローズ（M1-8）、常用開始の最小範囲（上の表。カレンダーの読み取り M3 の A を含む）、i18n 基盤とデザイントークン（M2-11, M2-12。後から入れると全画面の文字列とスタイルを書き直すことになる）、日報（M4-3）。

---

## 5. テスト戦略

### 5.1 テストの層

| 層 | 対象 | 手法 |
|---|---|---|
| 単体（純粋関数） | 日付区切り、HLC、fractional index、NL パーサ、時間計算、日報テンプレート | 表駆動。TZ と時計を固定する。NL パーサは日本語・英語の入力と期待値を100件程度 |
| パーサ回帰（golden） | 各アダプタの `read()` | 匿名化フィクスチャ → `NormalizedEvent[]` をスナップショットで比較。ツールのバージョンごとにディレクトリを分ける |
| 増分読み込み | JSONL リーダとシンク | フィクスチャを途中のバイト位置（行の途中を含む）で分割して書き足し、全部一度に読んだ場合と DB の内容が一致することを確認する。切り詰め、inode の変更、パーサの版上げ、同じ範囲の二重読みも同様に一致を確認する |
| 判定シナリオ | グルーピング、状態判定、フォローアップ、在席と待ち | 「時刻・イベント列 → 期待する状態とフォローアップ」を表で書く。例: 質問で終了 → reply 生成 → 人間入力で自動クローズ / dismiss 後に同じトリガで再生成しない / 24時間で done / hooks なしで推定フラグが立つ。在席と待ちは 5.5 |
| プライバシー | 取り込み全体 | 6.2 の番兵テスト |
| API | Hono ルート | `app.request()` で認証、Host / Origin 検証、入力検証、主要ユースケースを確認する |
| hooks インストーラ | settings.json / hooks.json の編集 | 他ツールが登録した既存エントリを含む入力に対し、install → install（冪等）→ uninstall で元のファイルとバイト単位で一致すること。シンボリックリンク（実体に書きリンクを保つ）、読み込み後の他プロセスの書き換えによる中止（競合検出）、Codex の位置（末尾に足す・同じ位置で置き換える・後ろのグループの再承認の案内）も確かめる |
| カレンダー | ヘルパとのプロトコル | デーモン側は偽ヘルパ（WS クライアントのモック）で窓同期と書き戻しの状態遷移をテストする。Swift 側は手動確認のチェックリスト（権限、作成、削除、変更通知） |
| UI | 主要コンポーネントと E2E | ロジックの多いフック（DnD の並べ替え計算等）だけ単体テストにする。Playwright のスモーク1本（ボード表示 → タスク追加 → 日付移動 → 完了） |

### 5.5 在席と待ちのシナリオ（M1-8・M1-9。D-105 で勤務時間を在席に置き換え）

`packages/core/test/derive/time.test.ts` に表で書く。「操作 9:00〜18:55」のような行は、その論理日の最初〜最後の操作の間 Mac を使っていた（在席）という入力として読む（テストの `presenceOf`）。在席を直接書く行もある。前提: TZ=Asia/Tokyo、日付区切り 04:00、猶予15分、返答の期限72時間、偽の時計（`Clock` を差し替え）。D-045 (1) により放置はタスクが出ている間だけなので、W1〜W8・W20・W21 の待ちは「質問で終了し、返答タスクが出ている」もの、W17 は approve、W18 は review_pr が出ているものとする（タスクの無い待ちは W27）。各行は「事実の列（人間入力・ターン終了・hook・操作・予定・フォローアップ操作）と now」を入れ、期待する区間（区分・分）と集計値を比べる。同じ事実を「取り込みが数時間遅れた」「デーモンが止まっていた」順で入れても結果が一致することも各行で確かめる（status_log を使わないことの確認）。

| # | 事実（時刻は同じ日の 時:分。D+1 は翌日） | 期待 |
|---|---|---|
| W1 | 操作 9:00。ターン終了（編集あり）10:00、人間入力 10:10 | 猶予 10分、放置 0 |
| W2 | 同上で人間入力 10:40 | 猶予 15分、放置 25分 |
| W3 | ターン終了 10:00、busy な予定 10:20〜10:50、人間入力 11:00 | 猶予 15、放置 5 + 10 = 15、集計外（event）30 |
| W4 | 同上で予定が declined / free / cancelled / 自分の時間ブロック | どれも予定として扱わず、放置 45 |
| W5 | 在席 9:00〜18:55。ターン終了 18:50、D+1 の最初の操作が人間入力 9:30 | D: 猶予 5（18:50〜18:55。不在は猶予にしない。D-058）、集計外（away）は D の残りと D+1 の 9:30 まで。放置 0 |
| W6 | W5 で D+1 に Turnlane の操作 9:00、人間入力 9:30 | D+1: 猶予の残り 10（9:00〜9:10）、放置 20。平均応答時間に入る長さは 5 + 10 + 20 = 35分（D-057） |
| W7 | 今日。操作 9:00、ターン終了 14:00、最後の操作 14:05、now 15:00、入力なし | 放置 45（今日の終了は now に追従。最後の操作 14:05 で切らない）。開いている区間 |
| W8 | ターン終了 03:50（論理日付は前日）、人間入力 07:30 | 区間を論理日付で分け、それぞれの時刻の在席で判定する（前日の在席が 03:55 までなら、前日: 猶予 5・不在 5、D: 不在 210） |
| W8b | 前日 10:00 から 04:30 まで続けて在席、ターン終了 03:50、人間入力 04:30（D-105） | 時刻で論理日付に振り分ける（前日: 猶予 10、D: 猶予 5・放置 25）。D-084 の前日への寄せはしない |
| W9 | 質問で終了 D 10:00、以後入力なし | D 10:15 に返答タスク。D+3 10:00 に期限切れ: follow_up `expired`、タスク `canceled`、カード done。D〜D+3 の Idle にこの待ちは入らない（期限前の時点の now では入っている）。Expired は D+3 に1件 |
| W10 | 質問で終了 10:00、同じ repo・ブランチでコミット 11:00 | 11:00 に「解決済み（推定）」`auto:resolved:commit`。放置 45（10:15〜11:00） |
| W11 | W10 のコミットの代わりに、同じ repo・ブランチで 10:00 より後に始まった別セッションの人間入力 10:50 / head ブランチの PR が 10:40 に merged | それぞれ `auto:resolved:new_session` / `auto:resolved:pr_merged`、放置は兆候の時刻まで。10:00 より前から開いていたセッションへの入力は兆候にしない。問いのセッションのプロセスが生きている間はコミット・別セッションで閉じない（PR の merged では閉じる）。閉じた行は後の判定で開き直さない |
| W12 | W10 で兆候が別ブランチ・別 repo | 兆候にしない |
| W13 | 質問で終了 10:00、`e`（対応不要）10:30 | follow_up `dismissed`、タスク `canceled`、放置 15 |
| W14 | 締めの決まり文句の質問で終了 10:00、編集・PR なし | 返答タスクを作らない、カードは待たずに done、待ち区間なし |
| W15 | 締めの決まり文句の質問で終了、ただし編集あり | your_turn（(b) による）。返答タスクは作らない |
| W16 | 質問で終了 10:00、返答タスクを ⏎ 10:30（engaged）、人間入力 10:45 | 放置 15（10:15〜10:30）、自分の応答 10:30〜10:45 |
| W17 | hooks あり。PermissionRequest 10:00、Stop 10:20 | needs_input の待ち。猶予 15、放置 5 |
| W18 | open な PR の your_turn が D 16:00 から D+1 11:00（merged）まで。在席 D 9:00〜18:00、D+1 9:00〜 | D: 猶予 15、放置 1h45m。D+1: 放置 2h。期限切れにしない |
| W19 | 質問で終了 10:00、返答タスクを 10:20 に1時間スヌーズ、人間入力 12:00 | 猶予 15、放置 5（10:15〜10:20）+ 40（11:20〜12:00）、集計外（snoozed）60。待ち区間は 12:00 まで続く（D-032） |
| W20 | 在席 9:00〜12:00・13:00〜14:00（昼に Mac を離れた）、質問で終了 11:50、人間入力 13:30 | 猶予 10 + 5、不在 60、放置 25（D-105） |
| W21 | 今日の終了を 17:00 に修正、now 18:00 | 17:00 以降は集計外（now に追従しない） |
| W22 | 操作の種類: MCP の `add_task`、`ui_open`、自動クローズによるタスク完了、カレンダーヘルパの同期 | どれも本人の操作にしない。ブラウザでのタスク完了・`turnlane add`・Claude への入力は操作にする |
| W23 | 在席が無い日に AI のスケジュール実行が your_turn で終わる | 待ちはすべて集計外（away。猶予も付かない） |
| W25 | カレンダー窓より古い日の再計算 | 自動の rederive では作り直さない。`turnlane rederive --wait --since` で作り直す |
| W26 | 日別集計 | Idle（和集合）、Expired の件数、`repo_root` 別の放置（git 管理外は「(no repo)」）が区間と一致する |
| W27 | 見えない your_turn（D-045 (1)）: ターン終了（編集ありのみ、PR なし）10:00、人間入力 11:00。check_changes をオンにしてタスクがあっても同じ | 待ち区間は記録する（猶予 15、集計外 `no_task` 45）。放置 0 |
| W28 | 並列の待ちの和集合（D-045 (2)）: カード A（repo-a）・B（repo-b）・C（repo-a）が 10:00 に質問で終了し、どれも返答タスクあり。人間入力は A 11:00、B 11:30、C 10:45 | カードの放置は A 45・B 75・C 30。日別 Idle は 75（和集合。合計の 150 ではない）。repo 別は repo-a 45、repo-b 75 |
| W29 | 在席の時間を超えない: 在席 9:00〜12:00 の日に、10枚のカードが 9:00 から 12:00 まで同時に返答待ち | 日別 Idle は 2h45m（≦ 在席 3h） |
| W30 | バックフィル（D-045 (3)）: now = D+4 12:00 に初めて取り込む。質問で終了 D 10:00、PR の初出 D 9:00（open）、error で終了 D 11:00、許可待ち D 13:00 | どのタスクも作らない。カードと待ち区間は残り、放置 0（`no_task`）。同じ事実を now = D+2 12:00 に見たら作る |
| W30b | 72時間以内の待ちを後から（初回の取り込みで D+1 12:00 に）タスクにした: 質問で終了 D 10:00、以後入力なし、now D+1 13:00 | D の放置 0、D+1 の放置 60（タスクを作った時刻から）。起動中に猶予の終わりで作ったものは trigger_at から数える |
| W31 | エラーの期限切れ（D-045 (3)）: error で終了 D 10:00、以後ターンなし | resume_error を作る（「自分」の先頭）。D+3 10:00 に期限切れ: follow_up `expired`、タスク `canceled`。待ちは期限切れで、D〜D+3 の Idle に入らない。Expired は D+3 に1件 |
| W32 | エラーからの再開: error で終了 10:00、resume_error あり、同じセッションの次のターン 10:40 | 猶予 15、放置 25。resume_error は done |
| W33 | タスクのない your_turn（D-048 (4)。M2-2）: ターン終了（編集ありのみ、PR なし、git 管理下）D 10:00、以後入力なし | D〜D+3 10:00 は your_turn だが `/api/queue` に出ない。D+3 10:00 に done（`no_task_expired`）、待ち区間はそこで終わる（`status_left`）。放置 0、Expired 0 |
| W34 | PR のレビュー後: PR の初出 D 9:00（open）、review_pr を作成、D+1 9:00 に自分のレビューで閉じる。PR は open のまま | D+1 9:00 までキューに出る。以後は出ず、D+4 9:00 に done（起点は review_pr が閉じた時刻）。D+1 9:00 以降の放置 0 |
| W35 | スヌーズと再開: 質問で終了 D 10:00、返答タスクを D 10:20 に明日朝までスヌーズ | スヌーズ中もタスクありとみなし、72時間の規則では done にしない。`/api/queue` には `snoozed` で返るが、スヌーズが明けるまで帯・キュー・件数には出ない |
| W36 | hooks なしの AskUserQuestion（D-049 (1)）: 人間入力 D 9:55、AskUserQuestion で止まる（最後の活動 10:00）、以後入力なし。10:40 に回答してターンが進む | 10:00（待ちの開始。15分待たない）に reply（`<turn>:ask`）を作り、queue に出る。10:40 に `auto:answered` で閉じる。猶予 15、放置 25。答えた後も待ち区間は残る |
| W37 | hooks なしの許可待ち（D-049 (1)）: 最終ターンが未完了、最後の活動 10:00、`sessions/<pid>.json` が idle | 10:00 に approve を作り、queue に出る。ターンが進めば `auto:next_turn_ok` で閉じる。待ち区間は approve の `trigger_at` から閉じた時刻まで |
| W38 | 時間に置いた返答タスク（D-051）: 在席 9:00〜、質問で終了 10:00、返答タスク（10:15）を 10:30 に 15:00〜15:30 の時間ブロックに置く、人間入力 15:20 | 猶予 15、放置 15（10:15〜10:30）+ 20（15:00〜15:20）、集計外（scheduled）4h30m（10:30〜15:00） |
| W39 | W38 で人間入力が無いまま now 16:00 | 15:00 以降は放置（開始を過ぎて手を付けていない）。放置 15 + 60 |
| W40 | W38 でブロックの代わりに「今日」にしただけ（`scheduled_date` のみ）/ ブロックを 12:00 に消した | どちらも従来どおり。放置 15 + 4h50m（消した場合も遡って放置。ブロックの履歴は持たない） |
| W41 | W38 で同じ時刻に返答タスクを 10:30 に 1時間スヌーズ（11:30 まで）もしている | 10:30〜11:30 は `snoozed`（先の区分）、11:30〜15:00 は `scheduled` |
| W42 | D-058（デイビューの主役の場面）: 前日の在席 10:00〜01:40、AI が 02:34 に質問で終了、返答タスクは 02:49 に作る（従来どおり）、D は 8:42 から在席、8:50 に ⏎ | 02:34〜8:42 は集計外（away。前日と D に分かれる）、猶予 8:42〜8:50（8分）、放置 0。平均応答時間に入る長さは 8分 |
| W43 | 会議 10:00〜11:00 の 10:10 に始まった待ち（返答タスク 10:25）、人間入力 11:20 | 集計外（event）50、猶予 11:00〜11:15、放置 5 |
| W44 | 待ち 10:00、猶予の途中で会議 10:05〜10:30、人間入力 10:45 | 猶予 10:00〜10:05 と 10:30〜10:40（合計15。付け直さない）、集計外（event）25、放置 5。会議が猶予の後（10:20〜10:35）なら猶予 15・放置 15（出たところからすぐ放置） |
| W45 | 9:00 から在席の日、7:00 の待ち（返答タスク 7:15）を 7:20 に 10:00 までスヌーズ、人間入力 10:30 | 不在 120、snoozed 60、猶予 10:00〜10:15、放置 15 |
| W46 | 9:00 から在席の日、7:00 の待ち（返答タスク 7:15）を 7:30 に 11:00〜11:30 のブロックへ置く、人間入力 11:20 | 不在 120、scheduled 120、猶予 11:00〜11:15、放置 5 |
| W47 | 在席 9:00〜18:00 の日、22:00 に質問で終了、D+3 22:00 に期限切れ | 猶予は D+1 9:00〜9:15、それ以外はすべて期限切れ |
| W48 | D-105: 最後の操作 17:00（T = 5分）、質問で終了 16:00、now 18:00 | 猶予 15、放置 50（17:05 まで）、不在 55 |
| W49 | D-110 (1): 19:00 に閉店、18:30 の質問に Mac で 22:00 に返答 | 猶予 15、放置 15、閉じた後（closed）180。閉じなければ放置 195 |
| W50 | D-110 (1): 18:30 に閉店、18:00 の待ちが開いたまま、D+1 1:00 まで Mac を使い、D+1 9:00 から再び使う | D: 猶予 15、放置 15、closed は 4:00 まで。D+1: closed 4:00〜9:00、9:00 から放置。日付区切りをまたいで使い続けていれば日付区切りで明ける |
| W51 | 在席のサンプル: 入力 10 秒前・ロック中・別ユーザー・2分以上の空き（スリープ）・起動直後・デーモンの再起動 | 最後の入力から T 分まで（今まで）。ロック中・別ユーザーは足さない。空いた後は前のサンプルより後の入力だけ。再起動は 2 分以内なら続き（`derive.presenceStep`・`derive.expandPresence`。D-139。T を足して保存していた D-139 より前の方式と、どの T でも同じ在席になる） |
| W51 | D-084: D 10:00 から1時間ごとに D+1 14:00 まで操作（徹夜） | D は 10:00〜D+1 9:00（開始から24時間未満）、D+1 は 10:00〜14:00 |
| W52 | D-084: D+1 4:20 に質問で終了、4:40 まで操作、10:30 に返答 | D: 猶予 15・放置 5、D+1: 時間外 350 |

自動生成タスクの題名（D-046）は `packages/core/test/i18n/task-title.test.ts` で、種類ごとに英語・日本語の組み立てと、AI のタイトルが無いときの代わり（`{repo}#{branch}` →「AI work」）を確かめる。runner のテストで、タスクの `title` が ''、`title_key` と `title_params` が入ることを確かめる。

締めの決まり文句と質問の判定（`closing-question.ts`）は別に表駆動テストを持つ（日本語・英語各30件程度。D-066 で答え・判断を求める言い回しの表（日英）と、誤検出・見逃しを確かめる表を足した。「他に何かありますか？」「何か他にお手伝いできることはありますか？」「Anything else?」「Let me know if you'd like any changes.」は true、「どちらの案にしますか？」「Should I proceed with the migration?」は false）。

### 5.2 匿名化フィクスチャの作り方

`packages/collectors/scripts/anonymize.ts`（コミュニティのアダプタ作者も使うので collectors パッケージ内に置く）:
1. 入力ファイルを1行ずつ読み、`allowlist.ts` に宣言されたキー以外を**落とす**。本文系（`message.content` のテキスト、`prompt`、`text`、`last_agent_message`、`initialMessage` 等）は、パーサの判定に必要な性質だけを合成値に置き換える（例: 質問で終わるかどうかを保ったダミー文 `"…ですか？"` / `"done."`）。
2. `cwd` と `repo_root` は `/fixture/repo-a` のような値に一貫して写像する。ブランチ名・セッション ID・PR 番号・リポジトリ名も一貫した写像で置き換える（同じ入力は同じ出力にして、関係を保つ）。
3. タイムスタンプは一定量ずらす（相対的な間隔は保つ）。
4. ツール名・`type`・`subtype`・`stop_reason`・バージョン番号はそのまま残す（パーサの分岐に必要なため）。
5. 出力後、元データに含まれていた cwd・ユーザー名・メールアドレス・ホスト名の文字列が出力に含まれないことを、スクリプト自身が検査して失敗させる。
6. 出力先は `packages/collectors/test/fixtures/<tool>/<version>/`。コミット前に目視で確認する。

フィクスチャのセット（最低限）: Claude（PR を作ったセッション / 質問で終わったセッション / AskUserQuestion / サブエージェント / ブランチ切り替え / 書き込み途中の末尾行）、Codex（CLI 起動で git 情報あり / Desktop 起動で git 情報なし / turn_aborted / guardian サブエージェント）、hooks spool（各イベント）。

### 5.3 番兵（プライバシー）テスト

フィクスチャの本文系フィールドに `SENTINEL_BODY_<uuid>` を埋め込んだ版を作り、全アダプタで取り込んだ後に、(1) SQLite ファイル（`-wal` を含む）のバイト列、(2) デーモンのログファイル、(3) `turnlane export --json` の出力、のいずれにも番兵が含まれないことを検査する。CI で常に回す。

### 5.4 実データでの定期確認（自分用）

- `turnlane doctor --audit`: DB 内の TEXT 列で 300 文字を超える値（`notes_md` 等のユーザー入力列を除く）を数える。0 でなければ警告する。
- Claude Code / Codex の更新後は `turnlane fixtures capture` で新しいフィクスチャを1本作り、golden テストを回す（M5-3 で手順化）。

---

## 6. リスクと先に潰す技術検証

| リスク | 影響 | 対策 | 検証 |
|---|---|---|---|
| EventKit の TCC が launchd 配下のヘルパで通らない | M3 全体が止まる。M3 の A を常用開始の範囲に入れたので、常用開始も遅れる（D-038） | 案 A の構成。ダメなら `open` 起動や Login Item で代替。それでも詰まったらカレンダーなしで常用を始めるかをオーナーに確認する（4.9） | **S1** |
| ターン分割と状態判定の精度が低い（your_turn と done の誤判定、WorkItem の分裂） | コア体験（自分の番）の信頼が崩れる | 実データで規則を調整、修正操作（統合・完了・非表示）を M2 に入れる。S3 で規則を調整済み（3.3）。状態の誤り率は個別の確認が未記入なので、常用中に修正操作の記録で見る | S3（完了）、常用 |
| ~~Codex の SQLite を読めない（`thread_history_1.sqlite` 等）~~ | — | **S2 で解消**（SQLite を開かず、rollout JSONL を主経路にした）。残るリスクは rollout JSONL の形式変更で、ai-session-ingestion 3.4 の縮退とフィクスチャ回帰テストで扱う | S2（完了） |
| `fs.watch` がスリープ復帰後に止まる（連続書き込みでの取りこぼしは S4 で欠損 0 を確認済み） | 取り込みの遅延 | 60秒の再走査（mtime 比較）を安全網として常に併用（コストが小さいので残す）。復帰時は watch を張り直す。常用中に `turnlane sources health` で確認 | M5-2 |
| ~~Bun の単一バイナリ化と Drizzle / MCP SDK の相性~~ | — | **S4 で解消済み**（compile 後のバイナリで Drizzle・MCP SDK とも動作。制約はマイグレーションの埋め込みとビルド条件で、M0-8・M0-10 で対応）。撤退路（Node 22 + better-sqlite3、Drizzle がドライバ差を吸収）は記録として残す | S4（完了） |
| hooks の共存（他ツールの設定を壊す、Claude 設定の未知キー） | ユーザー環境の破壊 | 識別子付きで冪等に編集、バックアップ、バイト一致のテスト | S5, M1-10 |
| 会話本文の混入 | プライバシー事故 | 許可リスト、hook 側での破棄、番兵テスト、doctor 監査 | M1-12 |
| `Turnlane` カレンダーを EventKit から Google 側に作れない | スマホに時間ブロックが出ない | 既定の書き戻し先を Calendar.app のデフォルトカレンダーにして、専用カレンダーを不要にした（D-072）。専用カレンダーに分けたい場合は Web で手動作成する | S1 |
| 初回バックフィルが重い（数百MB 規模のトランスクリプト） | 起動直後に固まる | 512KB 単位の分割読み、優先度順、イベントループを譲る（derive runner も区切りごとに譲る。3.2） | M5-2 |
| 工数超過（49人日） | 14日の常用開始が遅れる | 常用開始の最小範囲（4.9。M2・M3・M4 の A と M5-1）で常用を始める、4.9 の削り順。進捗はフェーズとマイルストーンの完了で測る（D-042） | — |
| 祝日カレンダーの自動判定の誤り（共有の休暇カレンダーなどを祝日として採用する） | 未完了タスクが休暇の翌日まで持ち越される | 採用したカレンダー名を `turnlane calendar status`・`turnlane doctor`・設定画面に出す、持ち越し先が祝日を飛ばしたら理由を日報に出す、`turnlane calendar holidays --set` で選び直せる | M3-6、常用 |
| 日報の AI 要約で、利用者の CLI の版によってフラグが無い・挙動が変わる（セッションが保存される、hooks が動く、出力形式が変わる） | 要約の実行が AI 作業として取り込まれる、要約が出ない | 検出時に `--help` でフラグを確かめる、要約用の作業ディレクトリを除外ルールに登録、失敗は要約なしで日報を保存。送る内容は日報の Markdown だけ（ADR 0005 の追記） | M4-6 |
| 公開時に個人の環境情報（パス、ユーザー名、私的なリポジトリ名）が履歴・フィクスチャ・スパイク結果に残っている | 公開後は消しきれない | 匿名化ツールの自己検査、CLAUDE.md の原則、公開前の全履歴監査 | M6-7 |
| 公開後に issue と質問の対応が作者の負担になる | 開発が止まる | サポートの約束をしない方針の明記、Discussions への誘導、必須項目付きの issue forms、`turnlane doctor --redact`、アダプタはコミュニティ PR で受ける | M6-5, M6-6 |

**最初に着手するスパイクの順序**: S4（半日、ほかのすべての土台）→ S3（1日、コア価値の検証）と S2（半日）→ S1（1日、構成の検証）→ S5（半日、M1-10 の前まで）。

---

## 7. 前提にした未確定事項

| # | 事項 | この計画での仮置き | 確定させる場所 |
|---|---|---|---|
| U1 | ヘルパ `.app` を LaunchAgent で起動したときの TCC の帰属 | ヘルパの bundle ID に付く | S1 |
| U2 | EventKit から Google アカウント配下にカレンダーを作れるか | 作れない前提。Web で手動作成 | S1 |
| U3 | Codex の `thread_history_1.sqlite` を読み取り専用で開けるか | Phase0 は SQLite を開かず、rollout JSONL・`session_index.jsonl`・`archived_sessions/` を主経路にする。Codex のピン留めとゴールは表示しない（必要になったら SQLite を一時コピーして読む方式で追加） | 決定（S2 / PO, 2026-10-02） |
| U4 | Claude の `settings.json` に識別用の未知キーを置けるか | 未知キーは使わず、command 文字列（`--managed-by turnlane`）で識別する。Claude 2.1.287 は未知キーを許容したが保証が無く、Codex は hooks.json のトップレベルの未知キーでファイル全体を読み捨てる（3.6.1） | 決定（S5） |
| U5 | Claude hooks の入力フィールド（`notification_type` 等）の正確な名前と、Codex の信頼承認の挙動 | 入力フィールドは公式ドキュメントで確認済み（`prompt_id` は v2.1.196 以降、`notification_type`。Stop の `last_assistant_message` は hook 側で捨てる）。StopFailure のエラーの種類は `error`（当時 `error_type` と書いたのは誤り。2026-10-23 に公式の StopFailure の節で確かめ直し、`error` を残すようにした。`error_type` は古い spool の行のために読む）。Codex の承認は `config.toml` の `[hooks.state."<hooks.json の実パス>:<event>:<グループ>:<ハンドラ>"]` の `trusted_hash`（鍵が位置、hash が内容）で、ユーザーが `/hooks` で行う。非対話で承認する公式手段は無い（3.6.1、ai-session-ingestion 2.3） | 決定（S5） |
| U6 | `promptId` が無い古いバージョンのトランスクリプトでのターンキー | 人間入力レコードの `uuid` で代用 | S3 |
| U7 | 自分の番の「自分の時間」の推定式 | `engaged_at` からクローズまで（上限30分）、無ければ3分 | M1-8 実装後、1週間使って調整 |
| U8 | your_turn → done の自動遷移時間と reply の猶予 | your_turn の条件が無ければ待たずに done、git 管理外の編集は24時間、質問は72時間（reply タスクも同時に期限切れで閉じる。D-020）、reply は15分人間入力が無ければ生成（すべて設定可。S3） | 常用中に調整 |
| U9 | 「質問で終わった」判定の精度（末尾の `?` / `？`、日本語の疑問の終止形） | 簡易な規則 | S3 では質問で終わった your_turn が2件だけで、誤り率は出せなかった。常用中に見る |
| U10 | MCP の `add_task` を呼んだセッションを特定する方法 | `clientInfo.name` と `turnlane mcp` プロセスの cwd | M2-10（環境変数でセッション ID が渡るか確認） |
| U11 | Claude Desktop・Codex アプリのディープリンク | 解決（D-059、[s7-open-from-task.md](../spikes/s7-open-from-task.md)）: Claude Code の `claude-cli://` はセッションを再開できないので使わない。Codex app で始めたセッションは `codex://threads/<id>` で開く。それ以外はターミナルに resume コマンドを入力済みにする（Ghostty）か、開いてコピー | 済み |
| U12 | ターミナルのタブ前面化 | やらない。cwd を `open` するかクリップボードへ（PO 決定） | v1 |
| U13 | 予定の日付と日付区切りのずれ（深夜1時の予定） | 表示はすべて暦どおり 0:00 区切り、集計と儀式は日付区切り（ux-mvp 4.4.1） | 決定（D-054, 2026-10-05） |
| U14 | PR 状態の取得を Phase0 で `gh` CLI に頼ってよいか | `gh` があれば使う、無ければ手動完了 | 決定（PO, 2026-10-02） |
| U15 | Cowork（定期実行）と Claude Desktop のメタデータ | Phase0 対象外（Desktop の Code タブは `~/.claude` のトランスクリプトで取れる） | v1 |
| U16 | 「14日連続で使う」の判定基準 | UI を開き、かつ朝か夕方の儀式を1回以上行った日 | 決定（PO, 2026-10-02） |
| U17 | ポート番号 | 7317（設定可） | M0-5 |
| U18 | ヘルパの署名 | Apple Development 証明書（個人チーム）。公開版は Developer ID（M6-8） | S1 |
| U19 | LICENSE の著作権者の表記 | 当初は個人名。LICENSE 作成済み。2026-10-26 に `Copyright (c) 2026 Rootstack Inc.` に変えた（ADR 0008 追記の末尾） | 決定（PO, 2026-10-02） |
| U20 | collectors を単体で npm 等に公開するか、公開する場合のパッケージ名 | 保留。Phase0 は公開しない（`private: true`）。境界だけ保つ | 公開後に需要を見て判断（PO, 2026-10-02） |
| U21 | 外部取り込みで外部側の更新（タイトル変更・削除）を反映するか | 反映しない。作成の冪等性と `complete_task` による完了のみ | 常用中に需要を見て |
| U22 | 待ち時間の定義 | **決定**（3.3.1）。勤務時間は D-105 でなくし、在席（Mac を使っていた時間）で数える。待ちは猶予（15分）/ 放置（在席かつ busy な予定と重ならない）/ 集計外 / 期限切れ（件数のみ）に分け、事実の時刻から再生して求める（status_log は使わない）。返答タスクの閉じ方は返答済み・解決済み（推定）・対応不要・期限切れの4種。締めの決まり文句の質問では作らない | 決定（PO, 2026-10-02。D-018〜D-022） |
| U23 | Claude Desktop 経路（`local_*.json` と `cliSessionId` による結合）が実データで正しく動くか | ai-session-ingestion 1.2 の記載どおり | S3 では期間内のデータが無く未検証。M1 の claude-desktop アダプタ（任意）で確認 |
| U24 | 祝日の判定方法 | **決定**（4.5）。Mac のカレンダーにある祝日カレンダーを EventKit で読み、終日予定の日付を祝日とする。ネットワークに出ない・祝日の表を同梱しない・カレンダー名を見ない。自動判定（書き込み不可・誕生日でない・窓内の予定がすべて終日で9割以上が1日）で採用し、`turnlane calendar holidays` で選び直せる。無ければ祝日なし | 決定（D-040）。自動判定の精度は常用中に見る |
| U25 | 日報の AI 要約に使う CLI の起動フラグ（`claude -p --tools "" --no-session-persistence`、`codex exec --ephemeral --skip-git-repo-check --sandbox read-only`） | 2026-10 時点の `--help` で存在を確認した。版によって無い場合は付けず、作業ディレクトリの除外で補う | M4-6 の実装時に、手元の版で要約の実行が取り込まれないことを確認 |
