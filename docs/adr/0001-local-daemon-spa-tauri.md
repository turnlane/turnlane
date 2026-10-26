# ADR 0001: ローカル常駐デーモン + React SPA、配布は Phase1 から Tauri 2 シェル

- ステータス: Accepted / Amended by [ADR 0010](./0010-desktop-shell-in-phase0-as-daemon-client.md)（Tauri シェルの時期を Phase0 の常用中に前倒しし、範囲をウインドウ・メニューバー・通知・クイック入力に絞る。EventKit 権限の主体はヘルパのまま、署名・公証済み配布と自動更新は M6 以降。他の決定は有効）/ Amended by [ADR 0011](./0011-single-app-bundle-smappservice.md)（Proposed。配布版ではデーモンの launchd の登録を dl ではなく Dayline.app が SMAppService で行う）
- 日付: 2026-10-02

## Context

dayline は Claude Code / Codex などのローカルに保存されたセッションファイルを常時監視し、hooks のイベントも受け取る必要がある。

- ブラウザ単体では不可能（File System Access API はユーザー操作ごとの許可が要り、常時監視もできない）。
- UI を閉じていても hooks のイベントや取り込みを取りこぼしてはいけない。UI とコレクタを分離する必要がある。
- `~/.claude*` や `~/.codex` を読むため App Sandbox に入れられず、Mac App Store では配布できない。
- UI は将来 Web / PWA としても配信したい。TypeScript の資産を UI とサーバで共有したい。

検討経緯は非公開の戦略ドキュメントにある。

## Decision

- 中核は **ローカル常駐デーモン `daylined`**（Bun + Hono + SQLite）とする。取り込み、ローカル HTTP API、SSE、カレンダー同期、ジョブを持ち、launchd の LaunchAgent として常駐する。
- UI は **React SPA** とし、Phase0 ではデーモンが `http://127.0.0.1:<port>`（既定 7317）で配信し、ブラウザで開く。
- CLI **`dl`** を1本用意し、hooks の受け口、stdio MCP サーバ、タスク追加、デーモン管理を同居させる。
- **Phase1 で Tauri 2 の薄いシェル**に同じ SPA を載せる。シェルの役割はメニューバー常駐、自動起動、グローバルショートカット、署名・公証済み配布、自動更新、EventKit 権限の主体に限る。
- 配布は Developer ID 署名 + 公証の直接配布とし、Mac App Store には出さない。
- localhost API は `127.0.0.1` のみにバインドし、ランダムトークン認証、`Host` / `Origin` 検証を必須にする。

## Consequences

- Phase0 は Tauri を入れずに毎日使い始められる。
- UI 非起動時も取り込みが継続する。hooks はデーモン停止中でも spool に溜まる（ADR 0004）。
- Electron に比べて常駐メモリとサイズが小さい。ネイティブ専用 UI（SwiftUI 等）に比べて Web / 他 OS への再利用がしやすい。
- デーモン、SPA、CLI、Swift ヘルパ（ADR 0003）、将来の Tauri シェルとプロセスが複数になり、配布・起動管理の手間が増える。
- localhost API を他サイトの JS から悪用されないよう、認証と Host / Origin 検証を常に保つ必要がある。
