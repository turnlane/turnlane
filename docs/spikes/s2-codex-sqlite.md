# スパイク S2: Codex SQLite の読み取り

- 日付: 2026-10-02
- ブランチ: `spike/s2-codex-sqlite`（変更提案を仕様へ反映したうえで main にマージした。コードは `spikes/` 配下のまま）
- コード: `spikes/s2-codex-sqlite/`（本番コードではない。依存なし）
- 生データ: `spikes/s2-codex-sqlite/results/`（スキーマ・件数・型・NULL 率・開けたかどうかだけ。値やパスは入れていない）

## 結論

**推奨は (c)。Phase 0 の Codex 取り込みは rollout JSONL と `session_index.jsonl` だけにし、Codex の SQLite は開かない。** 将来 SQLite が必要になったら、方式は (b) の一時コピーにする。(a) は採らない。

| 案 | 判定 | 理由 |
|---|---|---|
| (a) `-shm` を作れる条件で `mode=ro` で開く | **不採用** | `-wal` が無いときは、書き込めるディレクトリでも `unable to open database file`（SQLITE_CANTOPEN, 14）で開けない。読み取り専用の接続は `-wal` を作れないため。開けた場合も Codex の `-shm` に書き込む（中身が変わる） |
| (b) 一時ディレクトリへコピーして読む | 方式としては使える | どの状態でも開け、元ファイルに一切書かない。コピー前後で stat を比べれば、書き込み中に取った壊れたコピーを捨てられる（模擬で 4,491 回中、壊れたものを採用した回数 0）。1.5MB で 10ms 程度 |
| (c) JSONL のみ | **推奨** | SQLite の中身は JSONL から作られた写しで、JSONL の方が新しい。SQLite にしか無い情報は Phase 0 で使わない |

(c) を推す理由:

1. **`thread_history_1.thread_turns` は rollout JSONL の写し**。列に `rollout_byte_offset` / `rollout_end_byte_offset` / `rollout_ordinal` があり、`thread_history_projection_state(next_rollout_byte_offset)` で取り込み位置を管理している。計測時点で JSONL のターン終了は 70 件（`task_complete` 68 + `turn_aborted` 2）、`thread_turns` は 69 件（`completed` 67 + `interrupted` 2）で、SQLite の方が遅れていた。
2. **`state_5.threads` にしか無い列は Phase 0 で要らない**。タイトルは `session_index.jsonl` の `thread_name`、アーカイブは `archived_sessions/` への移動、サブエージェントは rollout の `session_meta.source` で分かる。`git_branch` は SQLite でも 18 件中 17 件が NULL で、JSONL と同じく `git rev-parse` で補う必要がある。`is_pinned`・`thread_goals`（0 件）・`thread_spawn_edges`（0 件）は Phase 0 の画面で使っていない。
3. **SQLite のスキーマは変わりやすい**。Codex は sqlx のマイグレーションで管理しており、`state_5` は 57 本、`thread_history_1` は 7 本適用済み。`PRAGMA user_version` は 0 のままなので、スキーマ判定には `_sqlx_migrations` を見る必要がある。追う形式を1つ減らせる。
4. 他ツールの DB を開かないので、「ユーザー環境を壊さない」原則に対して説明が要らない。

## 環境

| 項目 | 値 |
|---|---|
| マシン / OS | Apple M3 Pro / macOS 26.6.2 |
| Bun / bun:sqlite | 1.4.2 / システムの SQLite 3.51.0 |
| sqlite3 CLI | `/usr/bin/sqlite3` 3.51.0（bun:sqlite と同じシステム版） |
| Codex | Desktop アプリ（ChatGPT.app 内の Codex Framework 154.0.8037.57）が稼働中。`codex app-server` が常駐。CLI は codex-cli 0.147.0 |

## 開けない原因の切り分け

### ファイルの状態

| ファイル | サイズ | `-wal` / `-shm` | ヘッダ（offset 18-19） | 常時開いているプロセス |
|---|---|---|---|---|
| `state_5.sqlite` | 446KB | 計測開始時は**どちらも無し**。途中（Codex の書き込み後）から両方あり | 2/2（WAL） | なし |
| `thread_history_1.sqlite` | 1.5MB | 無し（計測中ずっと） | 2/2（WAL） | なし |
| `goals_1.sqlite` | 32KB | 両方あり | 2/2（WAL） | なし |
| `queue_1.sqlite` | 40KB | 両方あり | 2/2（WAL） | `codex app-server` が常時開いている |

- 権限は `-rw-r--r--`、所有者は本人、BSD ファイルフラグなし。拡張属性は `com.apple.provenance` だけで、読み取りには影響しない。権限・所有者・フラグ・xattr は原因ではない。
- `state_5` と `thread_history_1` は Codex が**書くときだけ開いて閉じる**。最後の接続が閉じると `-wal` / `-shm` が消えるので、普段は本体ファイルだけが残る。ただし `-wal` が残ったままのこともある（計測中、Codex の書き込みの後に `state_5` の `-wal`（2ページ分）と `-shm` が残り、どのプロセスも開いていなかった）。両方の状態に対応する必要がある。

### 原因

**`-wal` が無い WAL モードの DB は、読み取り専用の接続では開けない。** SQLite は WAL の DB を開くときに `-wal` を開こうとし、無ければ作ろうとする。読み取り専用の接続は作れないので SQLITE_CANTOPEN になる。ディレクトリが書き込めるかどうかは関係ない。phase0-plan に書いた「sqlite3 CLI から `unable to open database file`」はこれで再現した（`state_5` のコピーに `sqlite3 -readonly` → `Error: in prepare, unable to open database file (14)`）。

サンドボックス（`sandbox-exec` で書き込み禁止）や読み取り専用ディレクトリは、`-wal` はあるが `-shm` が無い場合にだけ追加で効く（`-shm` を作れずに失敗する）。

### 方式 × 状態の結果（コピー上、`results/lab-copies.jsonl`）

対象 3 DB（`state_5` / `thread_history_1` / `goals_1`）のコピーで、状態3種 × ディレクトリ3種 × 開き方4種を試した。

- 状態: **absent** = 本体だけ（`state_5` と `thread_history_1` の普段の状態）、**residual** = 書き手が異常終了して `-wal` / `-shm` が残っている（`-wal` に未チェックポイントの目印テーブルがある）、**live** = 別プロセスが書き込み接続を開いたまま
- ディレクトリ: **rw** = 通常、**ro_dir** = `chmod 555`、**sandbox** = `sandbox-exec` で配下への書き込みを禁止

| 状態 | 開き方 | rw | ro_dir | sandbox | 最新（WAL）が見えるか | 書き込み |
|---|---|---|---|---|---|---|
| absent | `readonly: true` / `file:?mode=ro` | ×（`goals_1` だけ ○。`-wal` があるため） | × | × | — | `goals_1` で `-shm` を**新規作成** |
| absent | `mode=ro&readonly_shm=1` | × | × | × | — | なし |
| absent | `mode=ro&immutable=1` | ○ | ○ | ○ | （WAL が無いので常に最新） | なし |
| residual / live | `readonly: true` / `file:?mode=ro` | ○ | ○ | ○ | ○ | rw / ro_dir で **`-shm` の中身を書き換える** |
| residual / live | `mode=ro&readonly_shm=1` | ○ | ○ | ○ | ○ | なし |
| residual / live | `mode=ro&immutable=1` | ○ | ○ | ○ | **×（WAL を無視して古い内容）** | なし |

`readonly: true` と `file:...?mode=ro` は同じ結果だった（bun:sqlite は `file:` で始まる名前を URI として扱う）。

### 元ファイルに対する確認（`results/probe-originals-*.jsonl`）

書き込みが起きない方式だけを元ファイルに使った。`readonly: true` / `mode=ro`（`readonly_shm` なし）は、`-shm` を作る・書き換えるので元ファイルには使っていない。

- `immutable=1`（常時）、`readonly_shm=1`（`-wal` と `-shm` が両方あるときだけ）、コピー（本体 + `-wal`。`-shm` はコピーしない）の3つを、2秒間隔で30回 × 3 DB 実施。すべて成功。
- 各回の前後で、本体・`-wal`・`-shm`・`-journal` の有無、サイズ、mtime、inode を比べ、**差分は 0 件**。コピー方式の所要時間は最大 10.7ms（1.5MB）、`immutable=1` は最大 4.3ms。
- この30回の間、Codex は書き込みをしていなかった（`*-idle.jsonl`）。その後 Codex の書き込みで `state_5` に `-wal` / `-shm` が残った状態でも3回確認し、`readonly_shm=1` とコピーで開け、差分は 0 件（`*-with-sidecars.jsonl`）。
- 計測の前後で、3 DB 本体の mtime とサイズは変わっていない。計測中に `state_5` の `-wal` / `-shm` ができたのは 22:22:32 で、同じ秒に `goals_1-wal` も伸びている。このとき dayline のスクリプトは `~/.codex` に触れていなかった（合成 DB の競合試験中）ので、Codex の書き込みによるもの。

### 書き込み中に読んだ場合（合成 DB、`results/race.json`）

Codex と同じく「開く → 50 行書く → 閉じる（`-wal` / `-shm` を消す）」を繰り返す書き手と並走させ、5,000 回読んだ。

| 方式 | 採用 | 棄却（stat が変化） | 採用したのに `quick_check` が失敗 |
|---|---|---|---|
| `immutable=1`（確認なし） | 5,000 | — | **65（1.3%）** |
| `immutable=1` + 前後の stat 確認（`-wal` が前後とも無く、本体の size / mtime / inode が不変） | 3,749 | 1,251 | 0 |
| コピー + 前後の stat 確認 | 4,491 | 488（ほかにコピー中の消失 21） | 0 |

`immutable=1` を確認なしで使うと、書き込み中に壊れた内容を読むことがある。どの方式でも「前後の stat 確認と再試行」が必須。

## 統計（`results/stats.json`、計測時点）

| DB | テーブル（行数 > 0） | 主なテーブル |
|---|---|---|
| `state_5` | `_sqlx_migrations` 57、`threads` 18、`backfill_state` 1、`rollout_migration_state` 1、`thread_sections` 1、`external_agent_config_imports` 2 | `threads` は 42 列 |
| `thread_history_1` | `_sqlx_migrations` 7、`thread_turns` 69、`thread_items` 357、`thread_history_projection_state` 18 | |
| `goals_1` | `_sqlx_migrations` 2（`thread_goals` は 0 行） | |

- `threads` の NULL 率: `git_branch` / `git_sha` / `git_origin_url` 0.944、`name` 0.167、`archived_at` 0.722、`originator` 0.722、`agent_nickname` / `agent_role` / `agent_path` / `project_id` / `thread_section_id` 1.0。時刻は `*_ms` 列がミリ秒。
- `thread_turns` の `status` は `completed` 67、`interrupted` 2。`error_json` は全件 NULL。`duration_ms` / `started_at` / `completed_at` は NULL なし。
- `threads` 18 件のうち `thread_turns` に行があるのは 17 件。
- rollout JSONL は 18 本。`session_meta.git` があるのは 1 本、`source` がサブエージェントのものは 1 本。`session_index.jsonl` は 14 件で全件に `thread_name` がある（`threads.name` の非 NULL は 15 件）。

スキーマは ai-session-ingestion 1.4 の記載とほぼ一致した（`threads` の主要列、`thread_turns` の列）。記載に無い列として `thread_turns` に `rollout_byte_offset` / `rollout_end_byte_offset` / `first_user_item_id` / `final_agent_item_id` がある。

## phase0-plan / 取り込み仕様への変更提案

**反映済み**（2026-10-02、PO 承認）: 1〜7 を phase0-plan と ai-session-ingestion に反映した。8 のとおり DDL は変えていない（`ingest_cursor.kind` の `'sqlite'` は将来用に残した）。

1. **Codex の主経路を JSONL にする**（ai-session-ingestion 3.1・3.2、phase0-plan 3.1 の Codex アダプタ）: 「SQLite 直読が主経路、rollout JSONL がフォールバック」を「rollout JSONL（ターン・状態・時間）+ `session_index.jsonl`（タイトル）+ `archived_sessions/`（アーカイブ）が主経路。SQLite は Phase 0 では開かない」に変える。
2. **M1-5 の範囲を縮める**: `state_5.threads`・`thread_history_1.thread_turns` の読み取りと「スキーマ判定と JSONL への切り替え」を外す。見積 1 → 0.75 日。M1-1 の「Codex SQLite は列構成だけ写した合成 DB を作る」も外す。S2 への依存は解消。
3. **phase0-plan 3.2 の堅牢性の表**: 「SQLite が開けない / ロック中 → 指数バックオフで3回リトライし、失敗したら JSONL 経路」の行を削除する（Phase 0 では開かない）。
4. **ai-session-ingestion 1.4 の誤りを直す**: 「`file:...?mode=ro` で開き、ロック競合に備えてリトライする。`immutable=1` は使わない」は誤り。`mode=ro` は `-wal` が無い普段の状態で必ず失敗し、開けたときは Codex の `-shm` に書き込む。S2 の結果（上の表）に差し替え、将来 SQLite を読む場合の規則として次を書く:
   - 元ファイルを `readonly` / `mode=ro` で開かない。
   - 本体と `-wal` を dayline の一時ディレクトリへコピーし（`-shm` はコピーしない）、コピー前後で本体と `-wal` の有無・サイズ・mtime・inode が変わっていなければ採用、変わっていれば再試行する。読むのはコピーだけ。
   - 変更の検出は本体と `-wal` の mtime / サイズで行い、変わったときだけコピーする。
   - スキーマ判定は `PRAGMA user_version`（常に 0）ではなく `_sqlx_migrations` を見る。
5. **ai-session-ingestion の付録のコマンドを直す**: `sqlite3 -readonly ~/.codex/state_5.sqlite ...` は普段の状態では失敗し、`-wal` だけがある状態では `-shm` を作る。`sqlite3 "file:$HOME/.codex/state_5.sqlite?mode=ro&immutable=1" ".schema threads"` に替える（スキーマ確認だけなら書き込み中でも害がない）。
6. **phase0-plan 6 章のリスク表**: 「Codex の SQLite を読めない」は S2 で解消（JSONL を主経路にしたため）。残るリスクは rollout JSONL の形式変更で、既存の縮退（3.4）とフィクスチャ回帰で扱う。
7. **phase0-plan 7 章 U3** を「決定（S2）: Phase 0 は SQLite を開かず JSONL を主経路にする」に更新する。
8. DDL の変更は不要（`ingest_cursor.kind` の `'sqlite'` は将来用に残してよい）。

PO の回答: Codex のピン留めとゴールは表示しない。必要になったら (b) の方式で SQLite の読み取りを後から追加する。

## 再現手順

```
cd spikes/s2-codex-sqlite
bun src/lab-copies.ts <scratchDir>              # コピー上で 状態 × ディレクトリ × 開き方 を試す
bun src/probe-originals.ts <scratchDir> 30 2000  # 元ファイルに書き込まない方式だけで確認（前後の stat を記録）
bun src/race.ts <scratchDir> 5000               # 合成 DB で書き込みと並走
bun src/stats.ts <scratchDir>                   # 検証済みコピーでスキーマと統計
```

`<scratchDir>` には一時ディレクトリを渡す。コピーは各スクリプトの終了時に削除する。`probe-originals.ts` の出力は `results/probe-originals.jsonl`（コミットしたものは、Codex が書き込んでいなかった回を `-idle`、`state_5` に `-wal` が残っていた回を `-with-sidecars` に改名した）。
