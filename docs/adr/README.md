# Architecture Decision Records

| # | タイトル | ステータス |
|---|---|---|
| [0001](./0001-local-daemon-spa-tauri.md) | ローカル常駐デーモン + React SPA、配布は Phase1 から Tauri 2 シェル | Accepted（Amended by 0010: Tauri シェルは Phase0 の常用中に入れ、デーモンのクライアントとして作る） |
| [0002](./0002-local-sqlite-source-of-truth-hlc-lww-sync-later.md) | ローカル SQLite を正とし、同期は HLC + LWW で後付けする | Accepted（Amended by 0008: 同期サーバーは作らない） |
| [0003](./0003-calendar-eventkit-phase0-google-api-phase1.md) | カレンダーは Phase0 で EventKit、Phase1 で Google Calendar API を追加 | Accepted（Amended by 0008: Google API 直結の部分は Superseded。EventKit のみ。Amended by 0010: ヘルパは Tauri へ移さず当面別のまま。2026-10-05 追記: 書き戻し先の既定は Calendar.app のデフォルトカレンダー、使い始めに過去のブロックを書かない。Amended by 0012: 時間ブロックの書き戻しをやめ、予定を dayline から作成・編集する） |
| [0004](./0004-ingestion-file-watch-primary-hooks-opt-in.md) | AI セッション取り込みはファイル監視を正とし、hooks は opt-in の速報層にする | Accepted |
| [0005](./0005-no-ai-session-body-storage-or-transmission.md) | AI セッションの会話本文は保存も送信もしない | Accepted（2026-10-03 追記: 日報の AI 要約はユーザー自身の Claude / Codex CLI で、日報の Markdown だけを渡す。Amended by 0018: 保存は限定した待ちの中身だけ許す） |
| [0006](./0006-bun-workspaces-toolchain.md) | ツールチェーンを Bun workspaces に揃える | Accepted（Amended by 0007） |
| [0007](./0007-bun-1-4-pin-and-build-conditions.md) | Bun を 1.4 系に固定し、単一バイナリのビルド条件を定める | Accepted（Amends 0006。Amended by 0009: hook の import 制限） |
| [0008](./0008-mit-no-server-open-source.md) | MIT ライセンスのオープンソースとして配布し、作者が運用するサーバーを持たない | Accepted（Amends 0002, 0003。更新確認の例外と LICENSE の確定を追記。追記 4: 同じ GitHub Releases からの取得・検証・置き換え。Amended by 0015: 拡張点と別ライセンスの拡張） |
| [0009](./0009-hook-allowlist-zero-dependency-module.md) | hooks の許可リストを collectors の依存ゼロのモジュールに置き、dl hook の import 制限を緩める | Accepted（Amends 0007） |
| [0010](./0010-desktop-shell-in-phase0-as-daemon-client.md) | デスクトップシェル（Tauri 2）を Phase0 の常用中に入れ、デーモンのクライアントとして作る | Accepted（Amends 0001, 0003。Amended by 0011 を提案中: 起動の登録とヘルパの同梱） |
| [0011](./0011-single-app-bundle-smappservice.md) | 配布物を Dayline.app 1つにまとめ、常駐プロセスを SMAppService で登録する | Proposed（Amends 0001, 0003, 0010。Amended by 0016: 名前） |
| [0012](./0012-events-in-calendar-tasks-stay-local.md) | タスクと予定を分ける。予定は dayline から Calendar.app へ書き、タスクの時間ブロックはカレンダーへ書かない | Accepted（Amends 0003。D-093。Amended by 0016: 予定の目印の URL） |
| [0013](./0013-presence-from-input-idle-only.md) | 在席は「最後の入力からの経過」だけで記録し、放置は在席の間だけ数える | Accepted（D-105・D-106・D-110。勤務時間を置き換える。2026-10-09 追記: 在席は入力のあった区間で保存する。D-139） |
| [0014](./0014-ai-launch-via-launch-id.md) | タスクから AI に頼むときは、端末に起動 ID だけを渡し、worktree は dayline が作ったものだけを片付ける | Accepted（D-107・D-109・D-110） |
| [0015](./0015-extension-points-and-separately-licensed-additions.md) | 本体に拡張点を持たせ、公式の配布物には別ライセンスの追加（拡張）を組み込めるようにする | Accepted（Amends 0008。D-108・D-110。Amended by 0017: 版の上げ方） |
| [0016](./0016-rename-to-turnlane.md) | 名前を Turnlane に変え、旧名（dayline）の導入を self-install で移す | Accepted（Amends 0011, 0012。D-089・D-091・D-124・D-127。移行のコードは公開前に外した: D-203） |
| [0017](./0017-extension-api-version-rule.md) | 拡張点の版（EXT_API_VERSION）は、足すときは上げず、変える・消すときに上げる | Accepted（Amends 0015） |
| [0018](./0018-bounded-local-storage-of-wait-details.md) | 会話の文は Mac の外に出さない。手元には限定した待ちの中身（指示の 1 行目・問い・許可のコマンド・エラーの種類）だけを保存する | Accepted（Amends 0005。D-218） |
| [0019](./0019-answer-from-turnlane.md) | Turnlane から答える: 答えは端末のタブに文字として届ける。自動では送らない（問いの全文は表示の瞬間に読み、答えは保存しない） | Accepted（D-238） |
| [0021](./0021-report-from-own-scripts-and-agents.md) | 自分のスクリプト・エージェントの報告を、もう 1 つの取り込み元（spool と report アダプタ）として扱う。口は CLI・MCP・HTTP の 3 つで型は 1 つ | Accepted |
| [0020](./0020-asked-back-and-back-to-turn.md) | 問い返しは閉じずに待つ（保存した指示の 1 行目で判定。パーサの版は上げない）。閉じた行は手で自分の番に戻せる | Accepted（Issue #3） |

形式: Context / Decision / Consequences。決定を変えるときは既存の ADR を書き換えず、新しい ADR を追加して旧 ADR のステータスを `Superseded by NNNN` にする。決定の一部だけを補正する場合は、新しい ADR に `Amends NNNN`、旧 ADR に `Amended by NNNN` と書いて相互にリンクし、旧 ADR の残りの決定は有効のままとする。
