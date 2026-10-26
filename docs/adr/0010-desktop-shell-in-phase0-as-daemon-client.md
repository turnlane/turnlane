# ADR 0010: デスクトップシェル（Tauri 2）を Phase0 の常用中に入れ、デーモンのクライアントとして作る

- ステータス: Accepted / Amends [ADR 0001](./0001-local-daemon-spa-tauri.md)、[ADR 0003](./0003-calendar-eventkit-phase0-google-api-phase1.md) / Amended by [ADR 0011](./0011-single-app-bundle-smappservice.md)（Proposed。決定 4 の起動の LaunchAgent と決定 5 のヘルパの扱いを、配布版では Dayline.app への同梱と SMAppService での登録に置き換える）
- 日付: 2026-10-05
- 関係: ADR 0001 の「Phase1 で Tauri 2 の薄いシェル」の時期と役割を、下の決定 1〜4 に置き換える。ADR 0003 の「Phase1 で Tauri シェルを導入したら、ヘルパの役割は Tauri 側へ移す」を決定 5 に置き換える。両 ADR の他の決定はそのまま有効。設計の詳細は [desktop-shell.md](../spec/desktop-shell.md)

## Context

- Phase0 の通知はブラウザ通知（M2-8）で、タブを開いている間しか届かない。「AI が自分を待っている瞬間を知らせる」はプロダクトの芯で、常用の14日間でこれを検証したい。
- ADR 0001 は Tauri シェルを Phase1（公開後）に置いていた。役割は「メニューバー常駐、自動起動、グローバルショートカット、署名・公証済み配布、自動更新、EventKit 権限の主体」。
- S1 で、独立した LaunchAgent のカレンダーヘルパ（Swift、`DaylineCalendarHelper.app`）が EventKit の権限を持てることを確認した（ADR 0003 の構成で確定）。
- Tauri 2 の公式の通知プラグイン（`tauri-plugin-notification`）は、デスクトップでは通知のクリックやアクションを受け取れない（Actions API はモバイルのみ。2026-10 時点の公式ドキュメント）。

## Decision

1. **時期**: Tauri 2 の薄いシェルを Phase0 の常用開始の直後、M2 段階 B の先頭で作る。範囲は (1) 今の Web UI を表示するウインドウ、(2) メニューバーの件数とポップオーバー、(3) macOS のネイティブ通知、(4) ⌥Space のクイック入力に限る。署名は Apple Development 証明書（`DAYLINE_CODESIGN_IDENTITY`）。Developer ID 署名・公証・自動更新・Homebrew 配布は M6 以降のまま。
2. **アプリはデーモンのクライアントにする**。データ、判定、通知の要否はデーモンが持ち、アプリは表示と OS との接点だけを持つ。
   - ウインドウはデーモンが配信する SPA（`http://127.0.0.1:<port>/`）をそのまま読み込む。SPA をアプリに同梱しない。Origin がブラウザと同じになるので、ADR 0001 の Host / Origin 検証は変えない。認証はブラウザと同じ `GET /auth?t=<token>` のクッキー。
   - Rust 側は Bearer トークンで `/api/events`（SSE）を購読し、メニューバーの件数と通知を出す。メインウインドウが閉じていても動く。
   - 通知を出すかどうかの判定（即時 / まとめ / 再送間隔 / 閉店モード）は、web にある純粋関数を core へ移してデーモンで実行し、SSE の `notify` イベントで送る。Rust 側に判定を書かない。
   - デスクトップのクライアントがつながっている間は、ブラウザ通知を止める。
3. **Rust 側は最小にする**。目安は 1,000 行以内。使う Tauri の機能: `tray-icon`（コア）、`tauri-plugin-single-instance`、`tauri-plugin-global-shortcut`、`tauri-plugin-positioner`、`tauri-plugin-opener`。通知はクリックを受け取れる実装（コミュニティの `tauri-plugin-notifications` か、`UNUserNotificationCenter` を objc2 で直接呼ぶ小さなモジュール）をスパイク（S6）で選ぶ。`tauri-plugin-autostart`・`tauri-plugin-updater`・`tauri-plugin-deep-link` は使わない。
4. **起動は dl が管理する LaunchAgent** `dev.dayline.desktop`（`RunAtLoad`、`KeepAlive=false`）。`dl self-install` がデーモンと一緒に配置・登録し、`dl open` はアプリがあればアプリを前面に出す。
5. **カレンダーヘルパは当面別のまま**にする。EventKit の権限の主体を Tauri アプリへ移すのは、公開配布（M6）で配布物を1つにまとめる必要が出たときに改めて決める。
6. **ツールチェーン**: `apps/desktop` に限って Rust（stable、mise で版を固定）と Cargo を入れる。JS 側は Bun workspaces の1パッケージとして `@tauri-apps/cli` を Bun で動かす。ADR 0006 / 0007 の他の決定は変えない。

## 検討した案

### ウインドウが何を読み込むか

| 案 | 内容 | Host / Origin 検証 | トークン | 版のずれ | 評価 |
|---|---|---|---|---|---|
| **A. デーモンの URL を読み込む（採用）** | `http://127.0.0.1:7317/auth?t=…` → SPA | 変更なし | HttpOnly クッキー（JS から見えない） | 起きない（SPA はデーモンと同じ版） | Tauri の IPC をリモート URL に開く設定（capability の `remote.urls`）が要る。開くコマンドは2つだけ |
| B. SPA をアプリに同梱（`tauri://localhost`） | アプリ内の SPA がデーモンへ fetch | `tauri://localhost` を許可し、CORS を足す | JS が Bearer トークンを持つ | アプリとデーモンを別々に更新すると API がずれる | 薄いシェルの目的に反する |
| C. Rust のカスタムプロトコルでデーモンへ中継 | `dayline://` 経由で Rust が転送 | 変更なし | Rust が持つ | 起きない | SSE の中継など Rust のコードが増える |

### SSE の購読と通知の判定をどこに置くか

| 案 | 内容 | ウインドウを閉じても動く | 判定の重複 | Rust の量 | 評価 |
|---|---|---|---|---|---|
| A. Web 側（隠したウインドウで今の useNotifications を動かす） | 判定は今のまま、表示だけ IPC で Rust へ | △ 見えない WKWebView はタイマーが間引かれ、App Nap で止まりうる | なし | 少 | 常駐の確実さに欠ける |
| B. Rust 側で SSE と判定 | `/api/queue` を読み、判定を Rust で書き直す | ○ | TS と Rust の2か所 | 多 | 規則（D-052 等）が変わるたびに2か所を直す |
| **C. デーモンが判定し、Rust は SSE を受けて表示（採用）** | `planNotifications` を core へ移し、デーモンが `notify` を送る | ○ | なし（core の1か所） | 少 | デーモンに数十行の runner が増える |

### カレンダーヘルパとの関係

| 案 | 内容 | 評価 |
|---|---|---|
| **A. 別のまま（採用）** | ヘルパは LaunchAgent のまま常駐 | S1 で合格した構成をそのまま使える。アプリを ⌘Q で終了しても予定の同期が止まらない。TCC の再許可が起きない |
| B. EventKit を Tauri アプリへ移す | Rust（objc2）か Swift のプラグインで EventKit を呼ぶ | 権限の主体が変わり再許可が要る。アプリを常に起動しておく必要がある。Rust が増える。配布物を1つにできるのは公開時の利点 |
| C. シェルを Swift で書き、ヘルパと1つにする | SwiftUI + WKWebView | D-055 と ADR 0001 の Tauri の判断を覆す。メニューバーやホットキーを自前で書く |

### ログイン時の起動

| 案 | 内容 | 評価 |
|---|---|---|
| **A. dl が LaunchAgent を書く（採用）** | `dev.dayline.desktop.plist`。`dl self-install` / `dl desktop install` / `dl uninstall` で管理 | デーモン・ヘルパと同じ管理方法。アンインストールで残らない |
| B. `tauri-plugin-autostart` | プラグインが LaunchAgent か AppleScript のログイン項目を作る | 管理がアプリと dl の2か所に分かれる |
| C. `SMAppService`（macOS 13 以降のログイン項目） | システム設定の「ログイン項目」に正しく出る | 公開配布では望ましい。Rust から objc2 で呼ぶ必要がある。M6 で再検討 |

## Consequences

- 常用の14日間で、ネイティブ通知とメニューバーによる「AI が待っている」の伝わり方を検証できる。
- 見積が M2 に +7.75人日増える（phase0-plan 4.4 の M2-D1〜M2-D10、M2-S6）。
- Rust のツールチェーンと Cargo の依存が増え、CI に `cargo clippy` / `cargo test` のジョブが要る。Tauri の依存は MIT / Apache-2.0 で、ADR 0008 と両立する。
- アプリが接続するのは `127.0.0.1` のデーモンだけ。ADR 0008（作者のサーバーに接続しない）に変更はない。外部リンクは WKWebView の中で開かず、既定のブラウザへ渡す。
- 通知・ホットキー・メニューバーの権限は `dev.dayline.desktop` に付く。ad-hoc 署名だと再ビルドで通知の許可が外れることがあるため、ヘルパと同じく Apple Development 証明書で署名する。
- M6 の署名・公証（M6-8）と Homebrew（M6-9）の対象に `Dayline.app` が加わる。自動更新（ADR 0008 の更新確認）は Tauri の updater を使わず、M6-12 の通知だけの方式を保つ。
- ux-mvp の S13（メニューバー / OS 通知）と S15（グローバルクイック入力）は v1 から Phase0 に前倒しになる。会議中の通知保留は v1 のまま。
