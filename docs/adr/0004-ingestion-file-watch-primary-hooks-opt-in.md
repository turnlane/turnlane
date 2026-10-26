# ADR 0004: AI セッション取り込みはファイル監視を正とし、hooks は opt-in の速報層にする

- ステータス: Accepted
- 日付: 2026-10-02

## Context

- Claude Code / Codex はセッションをローカルファイル（JSONL、SQLite）に保存するが、形式は非公式で無告知に変わる。
- 公式の hooks を使えば「許可待ち」「ターン終了」「失敗」を即時に知れるが、設定ディレクトリごとの導入、Codex の信頼承認が必要で、過去分は取れない。導入していないユーザーもいる。
- hooks の設定ファイルは他のツールと共有されうる。Codex の `notify` は1コマンドしか設定できない。
- Claude Code のトランスクリプトは `cleanupPeriodDays`（既定30日）で自動削除される。

詳細は [ai-session-ingestion.md](../spec/ai-session-ingestion.md)。検討経緯は非公開の戦略ドキュメントにある。

## Decision

- **ファイル監視を正（必須）**とする。FSEvents による監視と定期再走査（mtime 比較）で差分パースし、過去分のバックフィルも同じ経路で行う。Codex の SQLite は `mode=ro` で読み、開けなければ rollout JSONL に切り替える。
- **hooks は opt-in の速報層**とする。hook コマンド（`dl hook`）は許可リストのキーだけを spool JSONL に1行追記して exit 0 で終わる。デーモンとは通信しない。
- hooks が無くても全機能が「数十秒遅れ・精度やや低（推定表示）」で動くことを必須要件にする。
- hooks のインストールは識別子付きで冪等に追加・削除し、書き換え前にバックアップを取る。他ツールのエントリには触らない。Codex の `notify` は使わない。
- 取り込みは冪等にする: カーソル（inode + 行境界のバイト位置 + パーサの継続状態）をイベント反映と同じトランザクションで保存し、イベントは累積値を運び、シンクは代入（upsert）のみを行う。
- パーサはバージョン範囲と必須キーを宣言し、壊れたら段階的に縮退する（L0〜L3）。
- 取り込んだメタデータは取り込み時点で確定保存し、元ファイルが消えても削除しない。

## Consequences

- 何も設定しなくても過去7日分を含めて動く。hooks を入れると状態遷移が即時になる。
- 非公式形式への依存が残るため、匿名化フィクスチャによる回帰テストと、ツール更新時のフィクスチャ更新が継続的に必要になる。
- hooks の導入状態（未導入 / 承認待ち / 受信中 / 無音）を UI で見せる必要がある。
- 設定ディレクトリを複数検出し、それぞれに対して取り込みと hooks の状態を管理する必要がある。

## 注記（2026-10-02）

Decision の「Codex の SQLite は `mode=ro` で読み、開けなければ rollout JSONL に切り替える」は、S2 の結果で実装の詳細を変えた。Phase0 は Codex の SQLite を開かず、rollout JSONL・`session_index.jsonl`・`archived_sessions/` だけを読む（`mode=ro` は `-wal` が無い普段の状態で開けず、開けた場合も Codex の `-shm` に書き込むため）。ファイル監視を正とし hooks を opt-in の速報層にする決定は変わらない。詳細は [ai-session-ingestion 1.4](../spec/ai-session-ingestion.md) と [S2 レポート](../spikes/s2-codex-sqlite.md)。
