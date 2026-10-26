# CLAUDE.md

このリポジトリで作業する実装エージェント向けの指示。

## プロダクト概要

Turnlane は、自分の予定・タスクと AI エージェント（Claude Code / Codex）の作業を同じ日付レーンに並べる、macOS 向けのローカルファーストなデイリープランナー。ローカル常駐デーモン `turnlaned` が AI セッションのローカルファイルと hooks を取り込み、リポジトリ×ブランチ単位の「AI の作業」と、AI が人間を待っている「自分の番」を導出する。UI は React SPA で、デーモンが localhost で配信する。Phase 0 はデスクトップアプリ（Tauri 2 の薄いシェル `apps/desktop`。SPA を表示し、メニューバー・ネイティブ通知・グローバルクイック入力を持つ。ADR 0010、`docs/spec/desktop-shell.md`）かブラウザで開く。CLI は `turnlane`。

現在は pre-alpha / Phase 0。

## ドキュメントの場所

- `docs/spec/phase0-plan.md`: 実装計画。リポジトリ構成、DDL、アダプタ IF、HTTP API、MCP ツール、CLI コマンド、タスク分解（S/M 番号）、テスト戦略
- `docs/spec/ai-session-ingestion.md`: 取り込み仕様。各ツールのファイル形式、状態判定、フォローアップ、プライバシー
- `docs/spec/ux-mvp.md`: MVP の画面、状態の表示規則、ショートカット、ドラッグ操作
- `docs/design/`: 確定したデザイン。画面画像（`screens/`）、デザインシステム（`design-system.md`）、実装時に詰める調整点（`README.md`）。UI を実装するときは画像と調整点を両方見る
- `docs/adr/`: アーキテクチャ決定記録

## 原則

1. **仕様の正は `docs/spec/` と `docs/adr/`**。コードと仕様が食い違ったら仕様に合わせるか、仕様の変更を提案する。DDL・IF の正は phase0-plan.md。
2. **仕様の変更・スコープの追加は PO に確認する**。PO は別の（非公開の）リポジトリで判断している。勝手に仕様を広げない。ADR の決定を変える場合は既存 ADR を書き換えず、新しい ADR を提案する。
3. **会話本文を扱わない**。AI セッションの本文（`message.content`、`prompt`、`text`、`last_assistant_message`、`tool_input` 等）を DB・ログ・spool・エクスポート・テスト出力に入れない。読むキーは各アダプタの `allowlist` で宣言し、抽出は `packages/collectors/src/allowlist.ts` の関数で行う。詳細は ADR 0005。例外は ADR 0018 の限定した保存だけ（伏せ字の後の 自分の指示の 1 行目・AI の問いと選択肢・許可のツールとコマンドの 1 行目・エラーの種類を `ai_instruction`・`wait_detail` に。設定 `turn.store_detail` でオフにできる）。どの文も Mac の外（LLM・サーバー・SSE の notify・AI 要約）には出さない。
4. **認証情報を扱わない**。`auth.json`、`*.key`、`Cookies*`、`*token*` などは開かない。開発中の調査でも実データの本文や秘密を出力しない（構造確認は ai-session-ingestion.md の付録のような本文を出さないコマンドで行う）。
5. **実データをコミットしない**。テスト用フィクスチャは必ず `packages/collectors/scripts/anonymize.ts` で匿名化してから `packages/collectors/test/fixtures/` に置く。個人のパス・ユーザー名・リポジトリ名を含めない。
6. **ユーザー環境を壊さない**。他ツールの hooks 設定ファイル（Claude の `settings.json`、Codex の `hooks.json`）は識別子付きで Turnlane のエントリだけを冪等に追加・削除し、書き換え前にバックアップを取る。設定ファイルに未知キーを足さず（識別は command 文字列の `--managed-by turnlane`）、Turnlane のグループは配列の末尾に足す（phase0-plan 3.6.1）。`cleanupPeriodDays` など他ツールの設定を勝手に変えない。
7. **同期対象テーブルへの書き込みは `mutate()` 経由**（ADR 0002）。取り込み系テーブルの行は削除しない（元ファイルが30日で消えるため）。
8. **取り込みは冪等に**。カーソルはイベント反映と同じトランザクションで保存し、シンクは代入（upsert）のみ（ADR 0004）。
9. 判定ロジック（グルーピング、状態、フォローアップ）は `packages/core/src/derive/` の純粋関数に置き、時計を差し替えた表駆動テストで検証する。
10. **MIT ライセンスで公開する前提で書く**（ADR 0008）。コード・コメント・コミット・フィクスチャ・スパイクの結果に個人の環境固有の情報（ホームのパス、ユーザー名、メールアドレス、社名、私的なリポジトリ名）を残さない。MIT と両立しないライセンス（GPL 系など）の依存を同梱しない。
11. **作者が運用するサーバーを持たない**（ADR 0008・ADR 0015）。このリポジトリのコードから作者の管理するホストや第三者の API へ接続するコードを書かない（クラウド同期、アカウント、ライセンス確認、テレメトリ、Google Calendar API 直結は作らない）。「拡張が使えるか」の判定も本体に置かない。ネットワークに出てよいのは、利用者自身の外部コマンド経由（`gh` など）と、公開後の更新確認で GitHub Releases の静的ファイルを取得する場合だけ（更新確認は識別子や利用状況を送らず、設定でオフにでき、README に明記する。ADR 0008 の追記、phase0-plan M6-12）。外部サービスとの連携は、外部側からローカルの MCP / CLI を呼んでもらう形（`add_task` の `source` / `external_id`）で受ける。本体はビルドのときに組み込む「拡張」の拡張点（`apps/daemon/src/ext/`、`apps/web/src/ext/`。ADR 0015）を持つが、拡張の中身・機能名・価格はこのリポジトリのコード・コメント・コミット・ドキュメントに書かない（「拡張（extension）」とだけ書く。拡張点の確かめは `test/ext-fixture/` のテスト用の拡張で行う）。これらに反する機能が必要になったら、実装せずに PO に確認する。
12. **取り込みアダプタは `packages/collectors` の公開境界を守る**（phase0-plan 3.1）。collectors から `@turnlane/*` の他パッケージ、DB、HTTP を import しない。新しいアダプタは `src/adapters/<tool>/` に置き、匿名化フィクスチャとテストキットのテストを付ける。

## 技術スタック

- ランタイム / パッケージ管理 / テスト: **Bun**（1.4 系、ADR 0007。単一バイナリは `--minify --bytecode --format=esm` でビルド）、**Bun workspaces**（`apps/*`, `packages/*`、内部パッケージは `@turnlane/*`）
- HTTP: **Hono**（`hc<AppType>` で web / cli に型付きクライアント、`@hono/zod-validator`）
- DB: **SQLite**（`bun:sqlite`、WAL）+ **Drizzle ORM**（スキーマは `packages/core/src/db/schema.ts` が正）
- UI: **Vite** + React 19 + TanStack Router / Query + Tailwind v4 + dnd-kit + cmdk
- E2E: **Playwright**（devDependency。D-092）。`e2e/` のスイートを dev-board（ダミーデータ・偽の時計・偽のカレンダー）に対して WebKit（殻の WKWebView と同じエンジン）で走らせる（`bun run e2e`、初回は `bunx playwright install webkit`。Chromium は `bun e2e/run.ts --engine chromium` の指定時だけ。D-196）。時間軸の見た目を変えたら必ず通す
- lint / format: **Biome**（ESLint / Prettier は使わない）。型検査は `tsc -b`（strict）
- ネイティブ: **Swift**（SwiftPM）の EventKit ヘルパ `native/calendar-helper`
- デスクトップ: **Tauri 2**（Rust。`apps/desktop/src-tauri` に閉じた Cargo。Rust の版は `.mise.toml`）。Rust は表示と OS との接点だけ（1,000 行以内を目安）、判定・文言はデーモン（ADR 0010）
- CI: GitHub Actions（macOS）で biome check / typecheck / bun test / E2E（Playwright）/ swift build / cargo clippy・test（デスクトップ）

## 名称

| 対象 | 名前 |
|---|---|
| デーモン | `turnlaned` |
| CLI | `turnlane` |
| カレンダーヘルパ | `TurnlaneCalendarHelper.app`（bundle ID `dev.turnlane.calendar-helper`） |
| デスクトップアプリ | `Turnlane.app`（表示名 `Turnlane`、bundle ID `dev.turnlane.desktop`、置き場所 `~/Applications`） |
| LaunchAgent | `dev.turnlane.daemon`、`dev.turnlane.calendar-helper`、`dev.turnlane.desktop` |
| データディレクトリ | `~/Library/Application Support/turnlane/`（DB は `turnlane.db`） |
| URL スキーム | `turnlane://` |
| 予定の書き先 | Turnlane で作る予定は Calendar.app の新規イベントのデフォルトカレンダー（D-072・D-093）。タスクの時間ブロックはカレンダーに書かない |
| MCP サーバ名 | `turnlane` |
| ローカル UI | `http://127.0.0.1:7317/` |
| 環境変数 | `TURNLANE_*`（`TURNLANE_DATA_DIR`・`TURNLANE_PORT`・`TURNLANE_CODESIGN_IDENTITY` など） |

`dev.turnlane.` の接頭辞はドメイン turnlane.dev に合わせる（D-091）。旧名からの名前の変更（対応表）は ADR 0016（旧名の導入の移行のコードは公開前に外した。Consequences）。旧名の文字列はカレンダーの旧名の目印（`packages/core/src/legacy.ts`）などの決まった場所にだけ置く（`scripts/check-names.ts` がテストで検出する）。手元のリポジトリのディレクトリは `~/source/turnlane/turnlane`、worktree の置き場は `~/source/turnlane/wt/`（D-211。D-127 で M6-7 まで旧名のままにしていたのを前倒しした。のちに tap の clone `~/source/turnlane/homebrew-tap` と並べるため 1 段下げた。過去の手順書の `cd` の行は当時の記録として旧名のまま）。
