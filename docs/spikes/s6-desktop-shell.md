# S6: デスクトップシェル（Tauri 2）の技術検証

- 状態: **(1) クッキー認証・(2) IPC の制限・(4) ホットキーの登録は合格。(3) 通知の実装は objc2 直接に決めた。通知のクリックの受け取りと画面が描かれた状態でのメモリ・クイック入力の表示時間は、オーナーの確認待ち**（検証した時間帯は画面がロックされていて、通知の許可ダイアログに答えられず、ウインドウも描画されなかった）
- 関連: [ADR 0010](../adr/0010-desktop-shell-in-phase0-as-daemon-client.md)、[desktop-shell.md](../spec/desktop-shell.md) 10章（M2-S6）、D-055・D-056
- 日付: 2026-10-05（macOS 26.6、Apple Silicon、Rust 1.92.0、Tauri 2.12.1）

## 結論

| # | 確かめたこと | 結果 |
|---|---|---|
| 1 | `127.0.0.1` の SPA を読み込み、`/auth?t=` のクッキー認証が通る | **合格**。main・tray・quick-add の3つのウインドウが `/auth?t=…&next=…` から SPA を読み込み、web の SSE（クッキー認証の `/api/events`）がつながった（デーモンの `sseClients` が Rust の購読と合わせて増えた）。Host / Origin の検証は変えていない |
| 2 | リモート URL からの IPC を capability で絞れる | **合格**。下の表 |
| 3 | 通知のクリックで識別子を受け取れる（実装の選定） | **objc2 で `UNUserNotificationCenter` を直接呼ぶ（案 b）に決めた**。クリックの受け取りは実機の操作が要るのでオーナーの確認待ち（[docs/dev/desktop.md](../dev/desktop.md) 3章） |
| 4 | ⌥⇧Space の登録 | **登録できた**。ただし、他のアプリとの衝突は検出できない（下） |
| 5 | メモリ | 画面ロック中の参考値で、常駐（main を閉じた状態）**約 81MB**（phys_footprint の合計）。目標 200MB 以下。画面を使っている状態での再計測はオーナーの確認待ち |

`.app` の大きさは **4.5MB**（arm64、release、LTO、strip。目安 10〜15MB より小さい）。

## 1. 作ったもの

スパイクは捨てずに `apps/desktop`（M2-D1 の雛形）として作り、そのまま本実装にした。確認用の一時的なコード（下の IPC の試験）は消してある。

- ダミーデータのデーモン: `bun scripts/dev-board.ts --port 27317 --demo-notify 40`（一時 HOME。オーナーのデーモン・データには触れない）
- アプリ: `DAYLINE_PORT=27317 DAYLINE_DATA_DIR=<一時 HOME>/data DAYLINE_DESKTOP_TRACE=1 out/Dayline.app/Contents/MacOS/dayline`

## 2. IPC の制限

リモート URL（`http://127.0.0.1:27317`）のページから、各コマンドを呼んだ結果（tray ウインドウで実行。結果は `desktop_open` の引数に入れて Rust のトレースで読んだ）:

| 呼んだもの | 結果 |
|---|---|
| `desktop_hide` | 通る |
| `desktop_open` | 通る |
| `boot_state`（boot ページ用。capability `boot` は `local: true`） | `Command boot_state not allowed by ACL` |
| `plugin:opener\|open_url` | `not allowed by ACL` |
| `plugin:global-shortcut\|unregister_all` | `not allowed by ACL` |
| `plugin:window\|close` | `not allowed by ACL` |

リモート URL の capability はポートが起動時に決まるので、`tauri.conf.json` ではなく `setup` で `CapabilityBuilder` から足している（`main.rs`）。

## 3. 通知の実装の選定

| 案 | 内容 | 評価 |
|---|---|---|
| a. コミュニティの `tauri-plugin-notifications` 0.5.0-rc.14 | Swift のパッケージを swift-bridge でつなぐ。AppDelegate を差し替え、プッシュ通知の転送も持つ | **採らない**。RC で `rust-version = 1.93`（今の 1.92 では入らない）、ビルドに Swift と swift-bridge が要る、AppDelegate の差し替え（swizzling）が Tauri 本体の処理と重なる。設計時に見つけていた macOS のクリック判定の issue も未解決のまま |
| **b. `objc2-user-notifications` で直接（採用）** | `notify.rs` 約220行（テストと非 macOS の代替を含む）。delegate を `define_class!` で定義 | 依存は objc2 系だけ（Zlib / Apache-2.0 / MIT）。クリックは `UNNotificationDefaultActionIdentifier` だけを扱い、カテゴリに `CustomDismissAction` を付けないので、消しただけの操作は delegate に届かない。開く画面は `targetContentIdentifier` に入れる（アプリを再起動した後に残った通知をクリックしても開ける） |

分かったこと:

- `UNUserNotificationCenter` はバンドル（`.app`）から起動したときだけ使える。`tauri dev` の素のバイナリでは使わない（`Permission::Unsupported` にして何もしない）。
- 許可を求めた結果は、コールバックの `granted` ではなく `getNotificationSettings` の `authorizationStatus` を読み直して決める（下の拒否の件）。
- **検証中に `dev.dayline.desktop` の通知の許可が「拒否」になった**。画面ロック中に初回の許可を求めたため（`UNErrorDomain` 1 = notificationsNotAllowed、`authorizationStatus = denied`）。オーナーはシステム設定 > 通知 > dayline で許可をオンにする必要がある。アプリはこの状態を検出して、メニューバーのメニューに `Notifications are off · Open System Settings` を出す（設計どおりの扱い）。

## 4. ホットキー

- `Alt+Shift+Space`（⌥⇧Space）は登録できた。
- **他のアプリとの衝突は検出できない**: 確かめのため、Claude・ChatGPT・Raycast が動いている状態で `Alt+Space` と `Cmd+Space`（Spotlight）も登録してみたところ、どちらも「成功」した。macOS の Carbon のホットキー（`RegisterEventHotKey`）は、他のプロセスが同じキーを持っていても失敗を返さない。OS が失敗を返すのは、書式の誤りなどに限られる。
  - D-056 (2) の「登録失敗は表示」は、OS が返す失敗についてだけ実装した（メニューの `… is in use · Change`、設定画面、`dl desktop status`）。衝突していればキーを押しても開かないので、設定画面の説明文で「開かないときは他のアプリが使っている可能性がある。別のキーに」と案内する。
  - 試したキーはすぐに `Alt+Shift+Space` に戻した。

## 5. メモリ（参考値）

`footprint`（phys_footprint）で計測。**画面ロック中で WKWebView が描画していない状態**なので、描画中より小さく出ている。

| 状態 | dayline（Rust） | WebContent | GPU | Networking | 合計 |
|---|---|---|---|---|---|
| 常駐（main を閉じた。tray と quick-add を隠して保持） | 17MB | 21MB × 2 | 12MB | 10MB | **約 81MB** |
| main を開いた | 19MB | 21MB × 2 + 14MB | 12MB | 10MB | 約 96MB |

RSS の単純な和は常駐で約 189MB（共有ページを重ねて数えるので過大）。8章の目標（常駐 200MB 以下）はどちらの数え方でも満たす。画面を使っている状態での再計測は [docs/dev/desktop.md](../dev/desktop.md) 4章の手順でオーナーに依頼する。

## 6. クイック入力の表示時間

隠しておいたウインドウを出すだけにしている（8章）。`DAYLINE_DESKTOP_TRACE=1` で、ホットキーを受けてから `show` と `set_focus` が終わるまでの時間を `quick-add shown in <ms>` として標準エラーに出す。画面ロック中はホットキーを押せないため未計測。オーナーの確認手順に入れた。

## 7. 実装に反映したこと

- 通知は objc2 直接（`notify.rs`）。`tauri-plugin-notification` / `tauri-plugin-notifications` は使わない
- リモート URL の capability は実行時に足す（ポートが可変のため）
- ホットキーの衝突は検出できないことを、設定画面の説明文と desktop-shell.md 5章に書いた
- Apple Development 証明書での署名（`codesign`）は、初回にキーチェーンへのアクセスの確認ダイアログが出る。検証中は応答できずに止まったので ad-hoc で署名して確かめた。オーナーの手順に「常に許可」を選ぶことを書いた
