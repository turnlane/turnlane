# スパイク S4: Bun 基盤の確認

- 日付: 2026-10-02
- ブランチ: `spike/s4-bun-foundation`（PO 承認により、変更提案 1〜6 を反映して main にマージ済み）
- コード: `spikes/s4-bun-foundation/`（本番コードではない。依存はこのディレクトリの `package.json` に閉じている）
- 生データ: `spikes/s4-bun-foundation/results/`

## 結論

**Bun のまま進めてよい。Node 22 + better-sqlite3 への切り替えは不要。** phase0-plan の S4 合格条件はすべて満たした。

| # | 項目 | 合否 | 主な数値 |
|---|---|---|---|
| 1 | `bun build --compile` + `bun:sqlite`（WAL）+ Drizzle | 合格 | WAL 有効、1万行 insert ≈100ms、別プロセスの readonly 読み取りと並走してエラー 0 |
| 2 | `fs.watch` recursive（FSEvents）の取りこぼし | 合格 | 7シナリオ×5回で欠損 0（イベント駆動のみ、再走査なし）。書き込み終了から追いつくまで最大 87ms |
| 3 | Hono の静的配信 + WebSocket（単一バイナリ） | 合格 | ソースの静的ファイルを消しても配信できる。WS の hello / echo / broadcast が届く。待機時 RSS 約 23MB |
| 4 | `dl hook` 相当の起動〜終了時間（目標 50ms） | 合格 | 全コマンド入りの `dl`（bytecode 版）で p50 7.5ms / p95 8.9ms。`sh -c` 経由でも p95 14.5ms |
| 5 | MCP SDK（stdio）の compile | 合格 | initialize / tools/list / tools/call が通る。initialize 往復 p50 15ms |

ただし、計画に反映すべき制約が4つある（詳細は「判明した制約と回避策」）。

1. `dl` は **`--bytecode --format=esm` でビルドし、サブコマンドは動的 import で読む**。どちらかを欠くと `dl hook` が 20〜30ms に悪化する。
2. **@parcel/watcher はそのままでは compile できない**（ネイティブモジュールの解決に失敗する）。回避策はあるが、`fs.watch` で足りるため採用しない。
3. **新しいバイナリの初回実行に約 1 秒かかる**（macOS のコード検査）。インストール・更新の直後の最初の hook だけが遅い。
4. Drizzle の `migrate()` はディスク上のフォルダを読むため、**マイグレーション SQL はバイナリに埋め込み、自前で適用する**。

## 環境

| 項目 | 値 |
|---|---|
| マシン | Apple M3 Pro（arm64） |
| OS | macOS 26.6.2（25G83） |
| Bun | 1.4.2（`744846f84`）。計画は 1.3 系前提 |
| SQLite（`bun:sqlite` が macOS で使うシステム版） | 3.51.0 |
| drizzle-orm | 0.45.3 |
| hono | 4.13.12 |
| @modelcontextprotocol/sdk | 1.31.0（zod 4.6.5） |
| @parcel/watcher | 2.6.0（比較用） |
| hyperfine | 未インストール。`bench/hook-bench.ts` で自前計測（`Bun.spawnSync` の spawn〜exit の壁時計時間） |

### 1.3 系前提との差分

- Bun 1.4.2 で計画どおりのことはすべてできた。1.4 系固有の問題は見つからなかった。
- `--bytecode` の既定の出力形式は CJS で、トップレベル `await` を含む ESM エントリはビルドエラーになる（`"await" can only be used inside an "async" function`）。**`--format=esm` を付ければ ESM のまま bytecode 化できる**。1.3 系でも同じ扱いと思われるが、ビルドスクリプトにはこのフラグを明記する。
- 手元の Homebrew では Cellar のディレクトリ名が `1.1.42` のまま中身が 1.4.2 になっていた（`bun upgrade` の自己更新と思われる）。ADR 0006 のとおり `.mise.toml` と `packageManager` でバージョンを固定する方がよい。

## 構成

```
spikes/s4-bun-foundation/
  src/dl.ts          全サブコマンド入りの dl。サブコマンドは動的 import
  src/dl-static.ts   比較用。全サブコマンドを静的 import
  src/hook-main.ts   比較用。hook だけのバイナリ
  src/mcp-main.ts    比較用。MCP だけのバイナリ（サイズ比較）
  src/hook.ts        dl hook 相当
  src/db.ts          bun:sqlite + Drizzle、埋め込みマイグレーション、WAL の複数プロセス確認
  src/server.ts      Hono の静的配信（埋め込み）+ WebSocket
  src/watch.ts       fs.watch / @parcel/watcher による JSONL の追従（イベント駆動のみ）
  src/mcp.ts         MCP stdio サーバ
  bench/writer.ts    模擬 JSONL の書き込み（スクラッチディレクトリ専用。パスに dayline-s4- を含まないと拒否）
  bench/watch-bench.ts / bench/hook-bench.ts   計測ドライバ
  build.sh           out/ に各バイナリを作る
```

実データのディレクトリ（`~/.claude*`、`~/.codex`、`~/Library/Application Support/Claude`）は読み書きしていない。書き込みはすべてセッション用のスクラッチディレクトリで行った。

## 1. bun:sqlite（WAL）+ Drizzle（合格）

### 手順

```
./build.sh
out/dl db <scratch>/a.db embedded        # 埋め込みマイグレーション → 1万行 insert → 集計 → upsert
out/dl db <scratch>/a.db embedded        # 2回目は適用済みでスキップされること
out/dl db <scratch>/b.db folder:./drizzle  # Drizzle の migrate()（フォルダをディスクから読む）
out/dl db-writer m.db 3 & out/dl db-reader m.db 2.5 & out/dl db-reader m.db 2.5   # 別プロセスの WAL 並走
```

### 結果

- `journal_mode` は `wal`。`synchronous=NORMAL`、`busy_timeout=5000`、`strict: true` が使える。
- Drizzle の `insert … onConflictDoUpdate`、`transaction`、`select count(*)` が compile 後のバイナリで動いた。1万行の insert（1トランザクション）は 96〜109ms。
- マイグレーション SQL を `import sql from "./0000_init.sql" with { type: "text" }` で埋め込み、`--> statement-breakpoint` で分割して適用する方式は動く。2回目の起動では適用済みとして飛ばされる。
- Drizzle 標準の `migrate(db, { migrationsFolder })` も動くが、フォルダ（`meta/_journal.json` と SQL）をディスクから読む。単一バイナリで配るなら使えない。
- 書き込み1プロセス（3秒で 71,500 行、50行ごとにコミット）と readonly の読み取り2プロセス（各 997 回）を並走させて、`SQLITE_BUSY` などのエラーは 0、件数の逆行もなかった。CLI がデーモンの DB を読む構成に問題はない。
- `bun:sqlite` は macOS ではシステムの SQLite（3.51.0）を使う。拡張のロードはできない前提で設計する（現計画は拡張を使っていない）。

## 2. fs.watch recursive の取りこぼし（合格）

### 手順

watcher を compile 済み `dl-bc watch <root> fs|parcel` として、writer を別プロセスとして起動する。watcher は**イベントを受けたときだけ**ファイルを読み、カーソル（オフセット）から末尾までの完全な行を数える。定期的な再走査はしない。取りこぼしがあれば行数の不足として現れる。カーソルのキーは `(dev, ino)` にした（リネームしても同じカーソルを使い続け、同じパスに作り直したファイルは 0 から読む）。

| シナリオ | 内容 | 期待行数 |
|---|---|---|
| burst | 1ファイルに 5,000 行。1行ごとに open/append/close | 5,000 |
| burst-fd | 1ファイルに 20,000 行。1つの fd で全速の write | 20,000 |
| parallel | 8プロセスが別々のプロジェクトディレクトリに 2,000 行ずつ同時に書く | 16,000 |
| newfiles | 新しい入れ子ディレクトリ（`subagents/` を含む）に 50 ファイルを作り、100 行ずつ書く | 5,000 |
| rotate | 1,000 行 → リネーム → 同じパスに作り直して 1,000 行 → 旧ファイルに 500 行追記 → 再リネーム → 300 行 | 2,800 |
| biglines | 約 64KB の行を 200 行。1行を3回の write に分けて、途中までの行を作る | 200 |
| trickle | 10ms 間隔で 300 行（通常のセッションの速さ。遅延の計測用） | 300 |

### 結果（各5回、`results/watch-fs-vs-parcel.jsonl`）

| シナリオ | fs.watch 欠損 | fs.watch 追いつき最大 | fs.watch 遅延 p95 | parcel 欠損 | parcel 追いつき最大 | parcel 遅延 p95 | 受信イベント数（fs） |
|---|---|---|---|---|---|---|---|
| burst | 0/5 | 55ms | 2〜19ms | 0/5 | 97ms | 53〜65ms | 5〜6 |
| burst-fd | 0/5 | 55ms | 13〜33ms | 0/5 | 109ms | 65〜70ms | 4 |
| parallel | 0/5 | 54ms | 25〜34ms | 0/5 | 108ms | 65〜69ms | 20〜21 |
| newfiles | 0/5 | 87ms | 48〜51ms | 0/5 | 120ms | 75〜96ms | 151 |
| rotate | 0/5 | 65ms | 2〜55ms | 0/5 | 119ms | 4〜63ms | 9〜11 |
| biglines | 0/5 | 87ms | —（行が長いため計測対象外） | 0/5 | 108ms | — | 3〜4 |
| trickle | 0/5 | 53ms | 10〜11ms（最大 21ms） | 0/5 | 97ms | 64〜68ms | 68〜70 |

「追いつき」は writer の終了から watcher の行数が期待値に達するまでの時間（watcher の状態出力が 50ms 間隔なので、最大 50ms ほど上乗せされている）。「遅延」は行に書いた時刻から読み取りまでの時間。

- **FSEvents はイベントを合体させる**（5,000 回の書き込みで 5〜6 イベント、trickle の 300 回で約 70 イベント）。それでも最後の書き込みの後に必ず1回はイベントが届くので、「イベントを受けたらカーソルから末尾まで読む」方式なら欠損しない。**書き込み1回ごとのイベントを前提にした設計にはしないこと。**
- 新規ディレクトリ・新規ファイル（watch 開始後に作られたもの）も拾える。
- `(dev, ino)` をキーにしたカーソルで、リネームによるローテーションも重複・欠損なく追える。
- 途中までの行（改行が来ていない部分）は、改行が来るまでカーソルを進めない方式で正しく扱える。
- **JS スレッドが詰まっても落ちない**: watcher のイベントループを 300ms ごとに 1 秒ふさいだ状態（長いトランザクションやバックフィルを模擬、`DL_BLOCK_MS=1000`）で 5 シナリオ×3回×2方式を回し、欠損 0。イベントはキューに溜まり、ふさがりが解けた後に処理される（遅延は最大約 1 秒になる）。
- watch のルートがシンボリックリンクでも、リンク経由・実体経由の両方の書き込みを拾えた（`~/.claude` を dotfiles からリンクしている環境を想定）。
- ルートが存在しないと `fs.watch` は同期的に `ENOENT` を投げる。`<CLAUDE_CONFIG_DIR>/projects` がまだ無い場合は、親を見張るか、再走査のときに再試行する。
- @parcel/watcher も欠損 0 だが、内部のまとめ処理のため遅延が約 65ms 増える。fs.watch より優れた点は今回の計測では見つからなかった。

### 検証できなかったこと

- **スリープからの復帰後に watch が止まるかどうか**は自動では試せなかった。計画どおり 60 秒の再走査（mtime 比較）を併用し、復帰時に watch を張り直す（M5-2）。常用期間中に `dl sources health` で確認する。
- 実データの量（数百 MB のトランスクリプト）でのバックフィル性能は S3 で見る。

## 3. Hono の静的配信 + WebSocket（合格）

### 手順

- `public/index.html` と `public/assets/app.js` を `import p from "../public/index.html" with { type: "file" }` で埋め込み、Hono の `app.get("*")` から `new Response(Bun.file(p))` で返す。存在しないパスは `index.html` を返す（SPA のフォールバック）。
- WebSocket は `hono/bun` の `upgradeWebSocket` と `websocket` を `Bun.serve({ fetch: app.fetch, websocket })` に渡す。
- 確認: `curl` で `/`、`/assets/app.js`、`/some/spa/route`、`/api/health`。Bun の WebSocket クライアントで接続し、hello → echo → `POST /api/broadcast` の invalidate 通知の3つを受信。
- `public/` を一時的にリネームして消した状態でも配信できることを確認した（バイナリへの埋め込みが効いている）。別の cwd から起動しても同じ。

### 結果

- すべて期待どおり。`Bun.embeddedFiles` に2件入っている。
- 起動後の待機時 RSS は約 23MB。
- 本番では Vite の `dist/` を丸ごと埋め込むため、ビルド時に `dist/` のファイル一覧から `with { type: "file" }` の import とパス→MIME のマップを生成するスクリプト（または `bun build --compile` に `dist/**` を追加エントリとして渡して `Bun.embeddedFiles` を引く方式）が要る。M0 で決める。

## 4. dl hook 相当の起動時間（合格）

### 手順

`src/hook.ts`: stdin の JSON を読み、許可リストのキーだけを残し、`openSync(path, "a")` + `writeSync` 1回で spool に1行追記し、`exit 0`。例外はすべて握りつぶす。入力には 24KB の `prompt` と `tool_input` を含め、番兵文字列が spool に出ないことも確認した。

計測は `bun bench/hook-bench.ts <scratch> 300`（ウォームアップ 10 回 + 300 回）。

### 結果（`results/hook-bench.jsonl`、単位 ms）

| ケース | p50 | p95 | p99 | max |
|---|---|---|---|---|
| 基準: `/usr/bin/true` | 1.1 | 1.3 | 1.3 | 1.6 |
| hook だけのバイナリ | 6.7 | 7.9 | 9.2 | 17.4 |
| hook だけ + minify + bytecode | 5.6 | 7.4 | 9.8 | 36.6 |
| **`dl hook`（全コマンド入り、動的 import、bytecode）** | **7.5** | **8.9** | **11.4** | 20.4 |
| `dl hook`（動的 import、bytecode なし） | 19.9 | 24.1 | 31.2 | 71.5 |
| `dl hook`（静的 import、bytecode） | 14.7 | 16.7 | 19.5 | 65.6 |
| `dl hook`（静的 import、bytecode なし） | 30.3 | 33.4 | 38.0 | 44.2 |
| `sh -c 'dl hook'`（hooks の呼ばれ方に近い。動的 import + bytecode） | 11.3 | 14.5 | 24.3 | 32.8 |
| 参考: `bun run src/hook-main.ts`（compile なし） | 6.8 | 9.3 | 13.2 | 15.2 |
| **新しくコピーしたバイナリの初回実行** | — | — | — | **約 970〜1,180** |

- すべての構成で、spool の行数は実行回数と一致し、本文の番兵は漏れていない。
- 50 並列 × 8 回、1行約 1.9KB の hook を同時に実行して、spool の 400 行がすべて正しい JSON だった（`O_APPEND` の1回の write で行が混ざらない）。
- bytecode なしの `dl` が遅いのは、動的 import でも1つのバンドル全体をパースするため。bytecode 化するとパースが省かれる。
- 初回実行の約 1 秒は、macOS が新しい実行ファイルを最初に起動するときのコード検査（ad-hoc 署名、66MB）によるもの。2回目からは 10〜20ms に戻る。

## 5. MCP SDK（stdio）とバイナリサイズ（合格）

- `McpServer` + `StdioServerTransport` + zod 4 のスキーマで、`initialize` → `tools/list` → `tools/call` が compile 後のバイナリ（bytecode あり・なしの両方）で動いた。stdin の EOF で正常終了する。
- initialize の往復時間（30回）: `dl-bc mcp` p50 14.8ms / p95 20.4ms、MCP だけのバイナリ p50 17.3ms、bytecode なしの `dl` p50 33.7ms。

| バイナリ | サイズ |
|---|---|
| hook だけ | 62.2MB |
| hook だけ（bytecode） | 63.7MB |
| MCP だけ（bytecode） | 63.9MB |
| `dl`（全部入り） | 63.6MB |
| `dl`（全部入り、bytecode、@parcel/watcher のネイティブ込み） | 66.5MB |

サイズの大半は Bun ランタイム本体（約 62MB）で、アプリのコードと依存は合わせて 1〜4MB。配布するときは `dl` と `daylined` を同じバイナリにする（argv[0] かサブコマンドで切り替え）と、ディスク上の重複を避けられる。

## 判明した制約と回避策

| # | 制約 | 影響 | 回避策 |
|---|---|---|---|
| C1 | bytecode なし、または静的 import だと `dl hook` が p95 17〜33ms になる | 目標内だが余裕が減る。依存が増えると悪化する | `--minify --bytecode --format=esm` でビルドする。`dl` のエントリは引数を見てからサブコマンドのモジュールを動的 import する。`hook` のモジュールは `node:fs` 以外を import しない（Biome の `noRestrictedImports` 等で守る） |
| C2 | `--bytecode` は既定で CJS 出力になり、トップレベル `await` があるとビルドエラーになる | ビルドが通らない | `--format=esm` を付ける |
| C3 | @parcel/watcher は `require(\`@parcel/watcher-${platform}-${arch}\`)` の形でネイティブモジュールを解決するため、compile 後に `Cannot require module ./build/Release/watcher.node` で落ちる | parcel を使う場合だけ問題になる | `@parcel/watcher/wrapper` の `createWrapper` に `require("@parcel/watcher-darwin-arm64/watcher.node")` を静的に渡せば動く（確認済み）。ただし fs.watch で欠損がなかったので採用しない |
| C4 | 新しいバイナリの初回実行に約 1 秒 | インストール・更新の直後、最初の hook だけが遅い（hooks のタイムアウトには十分収まる） | `dl hooks install` やアップデータの最後に `dl --version` を1回実行して検査を済ませておく。将来の公開配布では Developer ID 署名と notarization が別途必要（Gatekeeper の quarantine 対策） |
| C5 | Drizzle の `migrate()` はディスク上のマイグレーションフォルダを読む | 単一バイナリでは使えない | drizzle-kit で生成した SQL を `with { type: "text" }` で埋め込み、`__migrations` テーブルで適用済みを管理する小さな適用関数を `packages/core/src/db/` に置く |
| C6 | FSEvents はイベントを合体させる（書き込み数千回に数イベント） | 書き込み1回ごとのイベントを前提にすると壊れる | 「イベントを受けたらカーソルから末尾まで読む」。ファイルの同一性は `(dev, inode)` で判定する（`ingest_cursor` に列は既にある） |
| C7 | 存在しないルートの `fs.watch` は `ENOENT` を投げる | 初回起動時に `projects/` が無いとデーモンが落ちうる | 親ディレクトリを見張る、または再走査のときに張り直す |
| C8 | `bun:sqlite` は macOS のシステム SQLite を使う | 拡張のロード不可。SQLite のバージョンは OS に依存する | 現計画は拡張を使わないので影響なし。`dl doctor` で `sqlite_version()` を表示する |

## phase0-plan / ADR への変更提案

**反映済み（PO 承認、2026-10-02）**: 1 は ADR 0007、2〜4 は phase0-plan（1.2、2.5、3.2、3.6、4.2、6）、5 は ai-session-ingestion 3.5、6 は ADR 0007 と phase0-plan 1.2 に反映した。

1. **CLAUDE.md / ADR 0006 / phase0-plan 4.0 の Bun バージョン**: 「1.3 系」を「1.3 系以上（S4 は 1.4.2 で確認）」にするか、1.4 系で固定するかを決める。S4 の範囲では 1.4.2 に問題はなかった。推奨は **1.4 系で固定**（検証したバージョンと開発で使うバージョンを揃えるため）。ADR 0006 の Decision を変えることになるので、新しい ADR（例: 0007）で記録する。
2. **phase0-plan 3 章の `dl hook` 性能目標の注記**に次を追記する: 「`dl` は `--minify --bytecode --format=esm` でビルドし、サブコマンドは動的 import で読み込む。hook のモジュールは `node:fs` 以外に依存しない。新しいバイナリの初回実行（約 1 秒の OS の検査）は目標の対象外とし、インストール時に1回実行して済ませておく」。
3. **phase0-plan 6 章のリスク表**: 「Bun の単一バイナリ化と Drizzle / MCP SDK の相性」は S4 で解消済みとし、撤退路（Node 22 + better-sqlite3）は記録として残す。「`fs.watch` の取りこぼし」は、連続書き込みでの欠損は無かったので「スリープ復帰後の停止」に絞る。60 秒の再走査はそのまま残す（安全網としてコストが小さい）。
4. **M0 のタスク**に次を含める: (a) 埋め込みマイグレーションの適用関数（C5）、(b) Vite の `dist/` を埋め込むためのマニフェスト生成（項目3の最後）、(c) `build.sh` 相当のビルド設定（C1、C2）。
5. **取り込み（M1 / M5-2）の設計**: `ingest_cursor` は既に `dev` / `inode` を持っているので DDL の変更は不要。アダプタの規則として次を仕様に足す: (a) 同じ `stream_key` で `(dev, inode)` が変わったら新しいファイルとして 0 から読む、(b) 別の `stream_key` に同じ `(dev, inode)` の既存カーソルがあればリネームとみなしてオフセットを引き継ぐ。Claude Code / Codex のファイルはローテーションしないので (b) は優先度が低く、冪等な upsert（ADR 0004）があるので再読しても壊れない。ルートが無い場合の扱い（C7）も仕様に書く。
6. **@parcel/watcher は使わない**。`fs.watch` で十分で、遅延も約 65ms 小さい。

## 次のスパイクへの引き継ぎ

### S3（実データでのターン分割と状態判定）

- 使い捨てスクリプトは compile せず `bun run` で十分（compile なしでも起動は 7ms 程度）。
- ファイルの追従は `spikes/s4-bun-foundation/src/watch.ts` の読み方（カーソルから末尾まで、完全な行だけ、`(dev, ino)` キー）をそのまま流用できる。バックフィルでは 4MB 単位で読む同じループが使える。
- 実データのトランスクリプトには 64KB を超える行がありうる。行の長さで処理を変えない（本文を読まずに許可リストのキーだけを取り出す）。
- `~/.claude` がシンボリックリンクでも watch は効く。

### S2（Codex SQLite の読み取り）

- `bun:sqlite` の `new Database(path, { readonly: true })` で、別プロセスが書き込み中の WAL の DB を読めることは確認した（自前の DB で）。Codex の DB で `-shm` が無い・作れない場合は、`file:...?mode=ro&immutable=1` の URI か、一時ディレクトリへのコピーで切り分ける。
- `bun:sqlite` が使うのは macOS のシステム SQLite 3.51.0。sqlite3 CLI（同じシステム版か Homebrew 版か）と挙動が違う場合は、どちらのライブラリかを先に確認する。

## 再現手順

```
cd spikes/s4-bun-foundation
bun install
./build.sh
bun bench/hook-bench.ts <scratchDir> 300
bun bench/watch-bench.ts <scratchDir> 5 bin fs,parcel
DL_BLOCK_MS=1000 bun bench/watch-bench.ts <scratchDir> 3 bin fs,parcel burst,parallel,newfiles,rotate,trickle
```

`<scratchDir>` には一時ディレクトリを渡す。writer はパスに `dayline-s4-` を含まないディレクトリへの書き込みを拒否する（watch-bench はその名前でサブディレクトリを作る）。
