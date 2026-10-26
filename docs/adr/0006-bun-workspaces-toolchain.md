# ADR 0006: ツールチェーンを Bun workspaces に揃える

- ステータス: Accepted / Amended by [ADR 0007](./0007-bun-1-4-pin-and-build-conditions.md)（Bun のバージョンを 1.4 系に変更し、単一バイナリのビルド条件を追加。それ以外の決定は有効）
- 日付: 2026-10-02

## Context

- デーモンと CLI の実行環境に Bun を使う（ADR 0001）。`bun:sqlite` が内蔵され、`bun build --compile` で静的ファイルを埋め込んだ単一バイナリを作れる。
- 当初案はパッケージ管理に pnpm workspaces を使う想定だった。
- Phase0 のモノレポは小さく、キャッシュ付きのタスクランナーは不要。

検討経緯は非公開の戦略ドキュメントにある。

## Decision

- 実行・パッケージ管理・テスト・単一バイナリ化をすべて **Bun**（1.3 系、`.mise.toml` と `packageManager` で固定）に揃える。
- モノレポは **Bun workspaces**（`apps/*`, `packages/*`）。内部パッケージ名は `@dayline/*`。
- lint / format は **Biome**、型検査は `tsc -b`（strict）、UI ビルドは **Vite**。
- HTTP は **Hono**（`hc<AppType>` で web / cli に型付きクライアントを渡す）、DB は **SQLite + Drizzle**。
- EventKit ヘルパは **Swift**（SwiftPM）で `native/calendar-helper` に置く。
- Bun の単一バイナリ化と Drizzle / MCP SDK の相性に問題が出た場合の撤退路は Node 22 + better-sqlite3 とする（Drizzle がドライバ差を吸収する）。

## Consequences

- コマンド体系が1つになり、セットアップと CI が単純になる。
- Bun 固有 API（`bun:sqlite`、`Bun.randomUUIDv7()` 等）への依存が増える。撤退時は置き換えが要る。
- Phase0 の最初のスパイク（S4）で、単一バイナリ化、`fs.watch` recursive、Hono の静的配信と WebSocket、CLI の起動時間を確認する。
