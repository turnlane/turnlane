# ADR 0007: Bun を 1.4 系に固定し、単一バイナリのビルド条件を定める

- ステータス: Accepted / Amends [ADR 0006](./0006-bun-workspaces-toolchain.md) / Amended by [ADR 0009](./0009-hook-allowlist-zero-dependency-module.md)（決定 3 の hook の import 制限）
- 日付: 2026-10-02
- 関係: ADR 0006 のうち Bun のバージョン（1.3 系）を置き換え、ビルド条件を追加する。0006 の他の決定はそのまま有効

## Context

- ADR 0006 は Bun を「1.3 系」で固定するとしていた。
- スパイク S4（[docs/spikes/s4-bun-foundation.md](../spikes/s4-bun-foundation.md)）は Bun 1.4.2 で行い、`bun build --compile` + `bun:sqlite`（WAL）+ Drizzle、`fs.watch` recursive、Hono の静的配信と WebSocket、MCP SDK（stdio）、`dl hook` の起動時間のすべてが合格した。1.4 系固有の問題は見つからなかった。
- 検証したバージョンと開発・配布で使うバージョンを揃えたい。
- S4 で、`dl hook` の起動時間はビルド条件に強く依存することが分かった（bytecode なし、または全サブコマンドの静的 import だと p95 が 17〜33ms に悪化。条件を満たすと p95 8.9ms）。
- Drizzle の `migrate()` はディスク上のマイグレーションフォルダを読むため、単一バイナリでは使えない。
- @parcel/watcher は compile 後にネイティブモジュールの解決で落ちる。`fs.watch` は S4 の全シナリオで欠損 0 で、遅延も parcel より約 65ms 小さかった。

## Decision

1. **Bun は 1.4 系に固定する**（`.mise.toml` と `package.json#packageManager`）。ADR 0006 の「1.3 系」をこれで置き換える。マイナーを上げるときは S4 のベンチ（`spikes/s4-bun-foundation` 相当）を再実行してから上げる。
2. **`dl` / `daylined` は `bun build --compile --minify --bytecode --format=esm --target=bun-darwin-arm64` でビルドする**。`--format=esm` は必須（`--bytecode` の既定は CJS で、トップレベル `await` があるとビルドできない）。
3. **`dl` のエントリは引数を見てからサブコマンドのモジュールを動的 import する**。`hook` のモジュールは `node:fs` 以外を import しない（Biome のルールで守る）。
4. **マイグレーションは drizzle-kit で生成した SQL をバイナリに埋め込み（`with { type: "text" }`）、自前の適用関数で適用する**。Drizzle の `migrate()` は使わない。
5. **Web UI の `dist/` はビルド時に生成するファイル一覧（import と MIME の対応）でデーモンに埋め込む**。
6. **ファイル監視は `fs.watch`（recursive、FSEvents）を使い、@parcel/watcher は使わない**。イベントは合体するので「イベントを受けたらカーソルから末尾まで読む」方式にし、60 秒の再走査（mtime 比較）を安全網として併用する。

## Consequences

- 1.3 系での動作は保証しない。CI と開発環境は同じ 1.4 系のバージョンを使う。
- ビルド条件を外すと `dl hook` の性能目標（50ms）の余裕が減るので、ビルドスクリプトに固定し、M0 のタスクとして扱う。
- 新しいバイナリの初回実行は macOS のコード検査で約 1 秒かかる。性能目標の対象外とし、インストール・更新の最後に `dl --version` を1回実行して済ませる。将来の公開配布では Developer ID 署名と notarization が別途要る。
- 撤退路（Node 22 + better-sqlite3）は ADR 0006 の記録として残すが、S4 の結果により現時点で使う予定はない。
