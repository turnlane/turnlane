# デスクトップシェル（Tauri 2）設計と実装計画

- 作成: 2026-10-05 / 状態: 実装仕様（正）。オーナー判断は D-056 で確定（11章）。M2-S6・M2-D1〜M2-D10 を実装済み（2026-10-05。スパイクの結果は [s6-desktop-shell.md](../spikes/s6-desktop-shell.md)、確認手順は [docs/dev/desktop.md](../dev/desktop.md)）
- 決定: [ADR 0010](../adr/0010-desktop-shell-in-phase0-as-daemon-client.md)（ADR 0001・0003 を補正）
- 関連: [phase0-plan.md](./phase0-plan.md) 3.4（HTTP API とセキュリティ）・3.6（turnlane コマンド）・4.4（M2 のタスク。M2-S6・M2-D1〜M2-D10）、[m2-api.md](./m2-api.md)（`/api/queue`、SSE）、[ux-mvp.md](./ux-mvp.md) 4.7（通知の規則）

---

## 0. 結論（先に読む）

1. **アプリはデーモンのクライアント**。`apps/desktop`（Tauri 2）は、デーモンが配信する SPA を WKWebView で表示し、メニューバー・ネイティブ通知・グローバルホットキーという OS との接点だけを持つ。データも判定もデーモンに置く。
2. **ウインドウは `http://127.0.0.1:<port>/` をそのまま読み込む**。認証はブラウザと同じ `/auth?t=<token>` のクッキーなので、Host / Origin の検証は変えない。
3. **メニューバーと通知は Rust 側の SSE 購読で動かす**（メインウインドウを閉じていても動く）。通知を出すかの判定は web の `planNotifications` を core へ移してデーモンで行い、SSE の `notify` イベントで Rust に渡す。Rust は表示するだけ。デスクトップのクライアントがつながっている間、ブラウザ通知は止める。
4. **ポップオーバーとクイック入力（⌥⇧Space）も SPA の画面**（`/tray`、`/quick-add`）を小さなウインドウで出す。YOUR TURN の行部品・i18n・キー操作をそのまま使う。
5. **カレンダーヘルパは別のまま**（S1 合格の構成を維持）。
6. **起動は turnlane が管理する LaunchAgent `dev.turnlane.desktop`**。`turnlane self-install` が `Turnlane.app` も配置・登録し、`turnlane open` はアプリがあればアプリで開く。
7. **見積 7.75人日**（スパイク 0.5 を含む）。M2 段階 B の先頭に入れる。通知とメニューバーの件数（M2-D1〜M2-D4）が最初の価値で、そこまで 4.0人日。

---

## 1. 範囲

| # | 機能 | Phase0（今回） | 範囲外（理由） |
|---|---|---|---|
| 1 | メインウインドウ | 今の Web UI を表示。開いている間は Dock と ⌘Tab に出る。閉じたら Dock と ⌘Tab から消え、メニューバーに常駐する（D-056 (1)） | 複数ウインドウ、タブ |
| 2 | メニューバー | 自分の番の件数（needs_input があれば琥珀）。クリックでポップオーバー（YOUR TURN の一覧、開く・対応不要・明日、週ボードを開く） | ポップオーバーでの返信入力 |
| 3 | ネイティブ通知 | needs_input / error は即時、your_turn は15分まとめ、同じカードは5分以内に再送しない（閉店モードは D-192 で廃止）。音は needs_input だけ（D-056 (3)）。クリックで該当項目を開く。ブラウザ通知は止める | 会議中の保留は D-097 の集中モードで前倒し（3.5）。通知上のボタンは集中モードの問い（集中する / しない）だけ前倒し（Dismiss / Tomorrow は v1）。Time Sensitive（entitlement とプロビジョニングが要る）は範囲外 |
| 4 | クイック入力 | ⌥⇧Space（D-056 (2)。変更可）で小窓。自然言語でタスク追加（既存の NL パーサと `POST /api/tasks`） | フルスクリーンのアプリの上に出すこと（NSPanel が要る。2.6） |
| — | 配布 | 自分用。Apple Development 証明書で署名、`~/Applications/Turnlane.app` | Developer ID・公証・Homebrew・自動更新（M6） |

名称（`dev.turnlane.` はドメイン turnlane.dev に合わせる。D-091。旧名からの変更は ADR 0016）:

| 対象 | 名前 |
|---|---|
| アプリ | `Turnlane.app`（表示名 `Turnlane`） |
| bundle ID | `dev.turnlane.desktop` |
| LaunchAgent | `dev.turnlane.desktop` |
| 置き場所 | `~/Applications/Turnlane.app`（ヘルパと同じ） |
| ソース | `apps/desktop/`（Rust は `apps/desktop/src-tauri/`） |

---

## 2. 構成

### 2.1 プロセスと接続

```
┌──────────── Turnlane.app（Tauri 2, Rust）──────────────┐
│  main window ──┐                                      │
│  tray popover ─┼─ WKWebView → http://127.0.0.1:7317/  │  クッキー認証（/auth?t=）
│  quick add ────┘     （SPA: /board, /tray, /quick-add）│
│                                                       │
│  Rust: SSE 購読 /api/events?client=desktop ───────────┼─▶ turnlaned（LaunchAgent dev.turnlane.daemon）
│        GET /api/queue/summary（メニューバーの件数）     │    Bearer トークン
│        通知の表示とクリック、⌥⇧Space、tray            │
└───────────────────────────────────────────────────────┘
TurnlaneCalendarHelper.app（LaunchAgent）──WS /internal/ek──▶ turnlaned   ← 変更なし
```

- アプリが接続するのは `127.0.0.1:<port>` のデーモンだけ（ADR 0008）。
- ポートは `TURNLANE_PORT`（既定 7317）。LaunchAgent の plist に引き継ぐ（デーモンと同じ `PASS_THROUGH`）。トークンは `~/Library/Application Support/turnlane/token`（`TURNLANE_DATA_DIR` で変更可）を Rust が読む。

### 2.2 `apps/desktop` のディレクトリ

```
apps/desktop/
├─ package.json            # @turnlane/desktop。devDependencies: @tauri-apps/cli。scripts: dev / build
├─ boot/index.html         # 同梱する唯一のページ。デーモン未起動時の画面（依存なしの HTML と数行の JS）
├─ scripts/build.sh        # TURNLANE_CODESIGN_IDENTITY → APPLE_SIGNING_IDENTITY、tauri build --bundles app、out/ へコピー
└─ src-tauri/
   ├─ Cargo.toml / Cargo.lock
   ├─ tauri.conf.json      # identifier dev.turnlane.desktop、frontendDist ../boot、macOSPrivateApi なし
   ├─ capabilities/
   │  ├─ boot.json         # boot ページ用（health の再試行、デーモンの起動）
   │  └─ remote.json       # remote.urls: http://127.0.0.1:<port>/*。許可するのは desktop_hide / desktop_open / desktop_quick_add の3つだけ
   ├─ icons/               # アプリアイコン、tray 用（template の黒、琥珀、オフライン）
   └─ src/
      ├─ main.rs           # Builder、プラグイン登録、RunEvent（Reopen で main を開く）
      ├─ daemon.rs         # トークンとポート、health、SSE クライアント（再接続）、queue/summary
      ├─ tray.rs           # 件数・状態・メニュー・ポップオーバーの位置
      ├─ notify.rs         # 通知の表示とクリック（S6 で選んだ実装を包む）
      ├─ windows.rs        # main / tray / quick-add の生成・表示・隠す、ナビゲーションの制限、Dock の切り替え
      └─ shortcut.rs       # ⌥⇧Space の登録と失敗時の扱い
```

Rust 側は 1,000 行以内を目安にする。判定・文言・データの整形を Rust に書かない（デーモンから受け取った文字列をそのまま出す）。

### 2.3 Tauri のプラグインと機能

| 機能 | 使うもの | 備考 |
|---|---|---|
| メニューバー | コアの `tray-icon` 機能 | macOS は `set_title` で件数を文字で出せる。`icon_as_template` で白黒を外観に合わせる |
| ポップオーバーの位置 | `tauri-plugin-positioner`（`tray-icon` 機能） | `TrayBottomCenter` に置く |
| 通知 | **`objc2-user-notifications` で `UNUserNotificationCenter` を直接呼ぶ**（`notify.rs`。S6 の結論） | 公式の `tauri-plugin-notification` はデスクトップでクリックを受け取れないので使わない。コミュニティの `tauri-plugin-notifications` は RC で Rust 1.93 以上・swift-bridge・AppDelegate の差し替えが要るので採らなかった（[s6-desktop-shell.md](../spikes/s6-desktop-shell.md)） |
| グローバルホットキー | `tauri-plugin-global-shortcut` | macOS は Carbon のホットキーで、アクセシビリティの許可は要らない |
| 二重起動の防止 | `tauri-plugin-single-instance` | launchd とダブルクリックの両方から起動されても1つにする |
| 外部リンク | `tauri-plugin-opener` | WKWebView の外へ出るナビゲーションは既定のブラウザで開く |
| 使わない | `tauri-plugin-autostart`（turnlane の LaunchAgent で行う）、`tauri-plugin-updater`（M6-12 の方式を保つ）、`tauri-plugin-deep-link`（2.8）、`tauri-plugin-notification`（上記） | |

### 2.4 Bun workspaces との統合とビルド

- `apps/desktop` は workspaces（`apps/*`）の1パッケージ。TS のコードは持たないので `tsconfig` の参照には入れない。Biome は `apps/desktop/src-tauri/target` を除外する。
- Rust は `.mise.toml` に `rust`（stable。版は M2-D1 で決めて固定）を足す。Cargo のワークスペースは `apps/desktop/src-tauri` で閉じる（リポジトリ直下に Cargo を置かない）。`.gitignore` に `target/`。
- ルートの `package.json` に足すスクリプト:
  - `dev:desktop`: `bun run --cwd apps/desktop dev`（`tauri dev`。開発中のデーモンにつなぐ。通知とホットキーは .app でないと確かめられないので、それらは `build:desktop` で確認する）
  - `build:desktop`: `apps/desktop/scripts/build.sh`。`tauri build --bundles app --target aarch64-apple-darwin` → `out/Turnlane.app`
  - `bun run build`（`scripts/build.ts`）は今のまま。デスクトップは別のコマンドにする（Rust のビルドは数分かかるため）。`turnlane self-install` は `out/Turnlane.app` をそのまま写すので、`apps/desktop` を変えた後は `build:desktop` を先に走らせる。`bun run build` は `out/Turnlane.app` が `apps/desktop` の最後のコミットより古ければ警告を出す（集中モードの問いのボタンの調査で、10/8 のアプリが入れ直しの後も動き続けていたため）
- 署名: `TURNLANE_CODESIGN_IDENTITY` を `APPLE_SIGNING_IDENTITY` に写して Tauri に署名させる（hardened runtime。entitlements は不要）。未設定なら ad-hoc で署名し、「通知の許可が再ビルドで外れることがある」と警告する（ヘルパの `build-app.sh` と同じ扱い）。
- CI: macOS のジョブに `cargo clippy --locked -- -D warnings` と `cargo test --locked` を足す。`.app` のビルドと署名は CI でしない（M6-10 で扱う）。
- 依存のライセンス: Tauri と上記プラグインは MIT / Apache-2.0。M6-1 の一覧に `cargo about` などで Rust 側を加える。

### 2.5 ウインドウ

| ウインドウ | 読み込む URL | 大きさ・見た目 | 生成 | 閉じたとき |
|---|---|---|---|---|
| main | `/auth?t=<token>&next=<最後の画面>` | 1280×800 から。最小は 1024×600（狭い幅の規則の前提。D-193 B-1。旧 960×600）。ウインドウの位置と大きさは Rust で保存（小さな JSON） | 起動時と再表示時 | **webview ごと破棄**し、最後の画面のパスを覚える（常駐メモリを下げる）。Dock から消す（2.7） |
| tray | `/tray` | 360×480、枠なし、影あり、常に手前、メニューバーの下 | 起動時に作って隠しておく（すぐ開くため） | フォーカスを失ったら隠す |
| quick-add | `/quick-add` | 640×(入力 1 行 + チップ + 候補)、枠なし、画面上部 1/3 の中央、すべての Space に出す | 起動時に作って隠しておく | Esc・追加後・フォーカスを失ったら隠し、`AppHandle::hide()` で直前のアプリにフォーカスを返す |

- 各ウインドウの `userAgent` の末尾に `TurnlaneDesktop/<version>` を付ける。web はこれを見てブラウザ通知を出さない（`Notification` は WKWebView では無いが、明示的に止める）。
- ナビゲーションの制限: `on_navigation` で `http://127.0.0.1:<port>/` と `localhost` 以外を拒否し、`tauri-plugin-opener` で既定のブラウザに渡す。`target=_blank` も同じ。
- IPC: リモート URL に開くコマンドは `desktop_hide`（呼んだウインドウを隠す）、`desktop_open { path }`（main を出して指定の画面へ）、`desktop_quick_add`（メニューバーの「タスクを追加」。ポップオーバーを隠してクイック入力を開く。D-113）の3つだけ。web からは `window.__TAURI_INTERNALS__` があるときだけ呼ぶ小さなラッパ（`apps/web/src/lib/desktop.ts`）を通す。`@tauri-apps/api` は web に入れない。
- アプリのメニュー: 既定のメニューを使わず自前で組む。Edit の Undo（⌘Z）/ Redo（⇧⌘Z）は既定の項目にせず自前の項目にし、main ウインドウ（クイック入力・メニューバーの窓が前ならそちら）の SPA の `window.__turnlaneEdit("undo" | "redo")` を呼ぶ。SPA は文字を入れる欄（入力中は ⌘K・⌘1〜3・⌘\ と Esc のほかの画面のキーを受けない。ux-mvp 6章）にフォーカスがあれば欄の文字の取り消し・やり直し（`document.execCommand`）、無ければ ⌘Z / ⇧⌘Z のキーを画面に渡す（タスク削除などの取り消し。`apps/web/src/lib/editable.ts`）。既定の項目だと欄の外の ⌘Z までネイティブの取り消しになり、項目が無いと欄の中の ⌘Z がどこにも届かない（2026-10 の不具合）。Cut / Copy / Paste / Select All は既定の項目。⌘W はウインドウを閉じる、⌘Q は終了、⌘R は再読み込み、⌘, は `/settings`。表示（View）メニューに `3 Days ⌘1` / `Week ⌘2` / `Day ⌘3`（D-075。ux-mvp 6章。キーは設定 `ui.keybindings` の `viewThree` / `viewWeek` / `viewDay` に合わせて接続時と SSE `settings` で付け直す。⌘ の付いた1打鍵が無ければキーを出さない。D-077、m2-api 21章）を置き、main ウインドウの SPA の `window.__turnlaneView("three" | "week" | "day")` を呼ぶ（無ければ `/board` か `/day` を開く）。WKWebView ではメニューのキーが web の keydown より先に取るので、メニューに載せないと ⌘1〜3 が web に届かない
- `dragDropEnabled: false`（OS のファイルのドロップを Tauri が奪わないようにする。dnd-kit はポインタイベントなので影響しない）。

### 2.6 WKWebView で既存 UI を動かす上での注意

| 項目 | 内容 | 対応 |
|---|---|---|
| フォント | Inter・Noto Sans JP・JetBrains Mono は @fontsource でデーモンが配信している | そのまま動く。外部から読まないので変更なし |
| 通知 API | WKWebView には `Notification` が無い（`typeof Notification === "undefined"` で今のコードは何もしない） | ネイティブ通知へ置き換え（3章）。web は UA または `desktopNotifier`（4.2）を見て通知の処理を止める |
| クリップボード | WebKit は `navigator.clipboard.writeText` をユーザー操作の中でしか許さない。resume コマンドのコピー（`data/mutations.ts`）は fetch の後に書くので失敗する。Safari でも同じ | `ClipboardItem` に Promise を渡す形（`navigator.clipboard.write([new ClipboardItem({ "text/plain": promise })])`）にして、クリックの中で呼ぶ。Safari も直る。Tauri の clipboard プラグインは使わない |
| ⌘Z | 既定の Edit メニューの Undo が先に動く。Undo を外すと入力欄の中の ⌘Z がどこにも届かない | 自前の Undo / Redo の項目から web に渡す（2.5） |
| ⌥⇧Space | WKWebView にフォーカスがあるとき、グローバルホットキーが先に取る | quick-add を開く動作で問題ない。web 側で ⌥⇧Space を使わない |
| localStorage / クッキー | WKWebView の既定のデータストアに残る（アプリ単位、ブラウザとは別） | テーマ・言語の先読み（`turnlane.ui`）はアプリ側で初回に一度ちらつく程度。問題なし |
| SSE | web の SSE は今のまま（スリープ復帰の再接続も今の ping で動く） | 変更なし |
| 外観 | `prefers-color-scheme` は macOS の外観に追従する | 変更なし。タイトルバーは標準（`titleBarStyle` は変えない） |
| 拡大 | WKWebView は ⌘+ / ⌘- を持たない | 対応しない（Phase0） |
| 開発者ツール | リリースビルドでは無効 | 調べるときは `dev:desktop` か Safari の Web インスペクタ（`devtools` 機能を debug ビルドだけ有効） |
| フルスクリーンのアプリ上のクイック入力 | 通常のウインドウはフルスクリーンの Space の上に出ない | Phase0 は範囲外。必要なら `tauri-nspanel` で NSPanel にする（v1） |

### 2.7 Dock と ⌘Tab

- main を開いている間は通常のアプリ（`ActivationPolicy::Regular`。Dock と ⌘Tab に出る）。
- main を閉じたら `ActivationPolicy::Accessory` に切り替え、Dock と ⌘Tab から消してメニューバーだけに残す（D-056 (1) で確定）。
- ログイン時（LaunchAgent。`--background` を付けて起動）は main を開かず、メニューバーだけで始める（実装時の判断。12章）。
- Dock のアイコンのクリック（`RunEvent::Reopen`）、メニューバーのメニュー、通知のクリック、`turnlane open` で main を開き直す。
- ⌘Q でアプリは終了する（デーモンとヘルパは動き続ける）。終了したアプリは次のログインか `turnlane open` で起動する。

### 2.8 `turnlane://` の URL スキーム

Phase0 では登録しない。macOS の Tauri の deep link は `/Applications` にインストールした .app でしか確実に動かず（Tauri のドキュメント）、`~/Applications` に置く方針と合わない。`turnlane open` からアプリへの指示は、デーモン経由（4.3）で行う。カレンダーの時間ブロックの `dayline://timeblock/<id>` から開く導線は M6 で .app の置き場所と合わせて決める。

---

## 3. 通知

### 3.1 データの流れ

1. デーモンの `NotifyRunner`（新規）が、キューが変わったとき（`follow_up` / `work_item` の SSE を出す直前の derive の後）と1分ごとに、`queue()` の結果に `visibleQueue`・`planNotifications`・`filterPaused` を適用する（今の web と同じ順）。
2. 出すべき通知があれば SSE の `notify` イベントを送る。
3. Rust が受けて通知を出す。クリックされたら main を開いて `path` へ移る。

判定の関数は今の `apps/web/src/notify/plan.ts`（と `data/queries.ts` の `visibleQueue`）を `packages/core/src/notify/plan.ts` へ移す（純粋関数でテストもそのまま移る）。規則（ux-mvp 4.7、D-052 (2)）は変えない:

| 状態 | 通知 | 閉店モード中 |
|---|---|---|
| needs_input | 即時 | 止める。設定 `notify.needs_input_after_close` がオンなら即時 |
| error | 即時 | 止める |
| your_turn | 15分ごとにまとめる | 止める |

- 同じカードは5分以内に再送しない。デーモンの起動直後の1回目は通知せず、見たことにする（今の `initialized` と同じ。再起動のたびに通知が重複しない）。
- 閉店モードは D-192 で廃止した（通知を止めるのは集中モードだけ）。
- 会議中の保留は集中モード（D-097。3.5）。

### 3.2 `notify` イベント

```ts
// packages/core/src/api/events.ts の SseEventType に "notify" と "desktop_open" を足す
interface NotifyPayload {
  notices: Array<{
    id: string;              // 通知の識別子。即時は `wi:<workItemId>`、まとめは `turn`（同じ id は OS 側で置き換わる）
    kind: "immediate" | "batch";
    status: "needs_input" | "error" | "your_turn";
    title: string;           // 例 "Approve rm -rf build"（本文は "Blocked · repo · branch"）。ロケールはデーモンで解決済み
    body: string;            // 例 "turnlane · feat/tray"（repo · branch）
    path: string;            // クリックで開く画面。即時は `/queue?item=<workItemId>`、まとめは `/queue`
    sound: boolean;          // needs_input だけ true（D-056 (3)）
  }>;
}
```

- 文言: web の辞書にある `notify.needs` / `notify.error` / `notify.turn` / `notify.where` を core の i18n（`packages/core/src/i18n/notify.ts`）へ移し、web と daemon が同じものを使う。題名は `formatTaskTitle`（D-046）で組み立てる。会話本文は入らない（ADR 0005）。
- ロケール: 設定 `ui.language` が `system` のときは、デスクトップのクライアントが購読時に渡す `lang`（`/api/events?client=desktop&lang=ja-JP`。macOS の優先言語）で解決する。
- `notify` は全購読者に送るが、web は無視する（ブラウザ通知は web 側の今の処理で出す。3.4）。

### 3.3 表示とクリック

- 通知の許可は初回起動時に要求する。拒否されていたら、メニューバーのメニューに「Notifications are off · Open System Settings」を出す。
- 設定画面の通知の節の「デスクトップの通知」（D-080。D-083 で節分け。旧デスクトップアプリの行）: 許可の状態を生の値でなく「通知: オン」「通知: オフ — システム設定で Turnlane の通知を許可してください」＋「システム設定を開く」、「通知: 未設定」＋「許可を求める」で出す（`turnlane desktop status` も同じ言い方）。ボタンは `POST /api/desktop/notifications { action: "request" | "open_settings" }` → SSE の `desktop_notifications` でアプリに渡し、アプリが固定の処理（`requestAuthorization`、`x-apple.systempreferences:com.apple.Notifications-Settings.extension` を開く）を行う。URL や値は渡さない。アプリがつながっていなければ `{ delivered: false }` で、設定画面は届かなかった旨を出す
- 許可の状態は `unknown`（まだ確かめていない）/ `granted` / `denied` / `not_determined`（未決定。D-080 で `unknown` から分けた）/ `unsupported`（.app でない）。アプリは main が前面に来たとき（システム設定から戻ったとき）と、メニューバーの右クリックで読み直し、変わったら `POST /api/desktop/status` で知らせる。デーモンは変化したら SSE の `desktop_status` を送り、設定画面が取り直す
- クリック（本体のタップ）だけを扱い、通知を消しただけの操作では何もしない。通知上のボタンは集中モードの問いだけ（3.5。D-097）。Dismiss / Tomorrow は v1。
- 即時の通知（needs_input / error）のクリックは、タスクの既定の開き先を開く（D-059、ux-mvp 4.11）。`path` の `open=<followUpId>` を見て `POST /api/open { followUpId }` を呼び（開く先の解決と起動はデーモン。対応中の印も付く）、main は開かない。`open` が無い（まとめの通知）か、呼び出しが失敗したら、従来どおり main で `path` を開く。
- ロック画面での表示（題名・リポジトリ名が見える）は macOS の「プレビューを表示」の設定に従う。README のプライバシーの節に書く（M6-2）。
- 集中モード（Focus）は OS がそのまま適用する。Time Sensitive は使わない。

### 3.4 ブラウザ通知との切り替え

- デーモンは `client=desktop` の SSE 購読者が1つ以上いる間 `desktopNotifier = true` とし、`QueueResponse` に載せる（変化したら `follow_up` と同じく `["queue"]` を invalidate させる SSE を送る）。
- web の `useNotifications` は、`desktopNotifier` が true のとき、または自分が Tauri の中（UA の `TurnlaneDesktop/`）にいるとき、ブラウザ通知を出さない。タブタイトルの件数は今のまま。
- デスクトップアプリを終了すると、開いているブラウザのタブが通知を引き継ぐ。

---

### 3.5 集中モード（D-097。m2-api 25章、ux-mvp 4.15）

- 問いの通知: `notify` の notice に `kind: "focus_prompt"` と `actions: [{ id, title }]`（`focus` / `skip`。文言はデーモンが解決）が付く。Rust は `UNNotificationCategory`（識別子 `focus_prompt`）に `UNNotificationAction` を2つ（`focus` は前面に出さない、`skip` も同じ）登録して（題名はその notice の文言で登録し直す）から、`categoryIdentifier` を付けて出す。押されたボタン（`actionIdentifier` が `focus` / `skip`）は `path` の `focus=<key>`（英数字・`-`・`_`・`:` だけ、64文字以内）と一緒に `POST /api/focus/prompt { key, answer }` へ送る。本体のクリックは従来どおり main で `path` を開く。消しただけの操作は何もしない（答えなし）
- SSE の `focus` で `prompt: false` かつ `late: false` になったら、出した問いの通知（`focus-prompt`）を `removeDeliveredNotificationsWithIdentifiers` で取り下げる（帯で答えた・予定が終わった）。`late: true`（答えないまま開始の時刻を過ぎたが予定は続く。m2-api 25章の「閉じた問い」）の間は通知を残し、ボタンの答えは同じ `POST /api/focus/prompt` へ送る（デーモンが予定の終わりまでの集中にする）
- 応答の `path` は通知の `userInfo` の `path`（出すときに `targetContentIdentifier` と両方に入れる）→ `targetContentIdentifier` の順に読む。カテゴリは通知を出す直前に `setNotificationCategories` で登録し、同じ接続で続けて `addNotificationRequest` する（OS は順に処理する。アプリを起動し直した後に残った問いの通知はボタンが出ないことがあり、そのときは本体のクリックで `/board?focus=<key>` の帯の問いを開く）。`POST /api/focus/prompt` が失敗したら（つながらない・401・409 など）main で `path`（帯の問い）を開く
- 答えの経路と記録（効かないときにどこで止まったかを切り分ける。題名・本文・key は書かない）:

  | 段 | 記録する場所 | 行 |
  |---|---|---|
  | 1. デーモンが問いを開いた | `turnlaned.log` | `focus.prompted`（`lead_min`、`channel`: `desktop` なら通知を送った / `band` なら帯だけ） |
  | 2. アプリが SSE `notify` で受け取った | `desktop.stderr.log` | `turnlane: notification received: id=focus-prompt actions=focus,skip permission=granted` |
  | 3. OS に出した | `desktop.stderr.log` | `turnlane: notification posted: id=focus-prompt category=focus_prompt actions=2`（失敗は `notification post failed: … error=<domain> <code>`） |
  | 4. ボタンが押され、OS がアプリに渡した | `desktop.stderr.log` | `turnlane: notification response: id=focus-prompt action=focus path=user_info`（扱わないときは続けて `notification response ignored: <理由>`） |
  | 5. デーモンへ送った・結果 | `desktop.stderr.log` | `turnlane: focus prompt answer focus sending` → `… accepted` / `… failed: <http 409 stale など>; opening the board` |
  | 6. デーモンが受けた | `turnlaned.log` | `focus.answered`（`answer`、`late`）/ `focus.answer_stale` / `focus.rejected` |

  OS 側で押されたかは `log show --predicate 'process == "usernoted" AND eventMessage CONTAINS "dev.turnlane.desktop"'` の `Received response … actIdent: focus` で分かる（4 が無く、これがあれば OS からアプリに届いていない）。stderr はアプリを LaunchAgent（`dev.turnlane.desktop`）から起動したときだけ `desktop.stderr.log` に入る
- まとめの通知（`kind: "focus_summary"`）は従来の通知と同じに出す
- メニューバー: `/api/queue/summary` の `focus` があればアイコンを集中のアイコン（template の月。`icons/tray-focus.png`）にする（needs_input の琥珀は集中中も優先する）。ツールチップは `focus.label`。右クリックのメニューに `focusMenu.title` のサブメニュー（`m30` / `h1` / `event` / `end`。`end` は集中中だけ有効）を置き、選んだら `POST /api/focus/start { minutes }` / `{ until: "event_end" }` / `POST /api/focus/end`。文言は summary の `focusMenu`（ロケールはデーモン）
- ポップオーバー（`/tray`）の上に集中の表示（`集中 · 16:00まで`、`終了`）と、開いている問い（`集中する` / `しない`）を出す

## 4. メニューバーとポップオーバー

### 4.1 アイコンと件数

| 状態 | アイコン | 文字（`set_title`） |
|---|---|---|
| 自分の番が 0 件 | template の黒（外観に追従） | なし |
| your_turn / error がある | template の黒 | 件数（例 `3`） |
| needs_input がある | **琥珀**のアイコン（template でない画像。琥珀は needs_input 専用。D-037） | 件数 |
| デーモンにつながらない | template の黒に斜線 | `–` |

- 件数はサイドバー・タブタイトルと同じ数（`/api/queue` のうち open なタスクがあるカード。web の `visibleQueue` で、スヌーズ中だけのカードは数えない。D-048 (4)）。`visibleQueue` を core へ移し、web とデーモンで同じ関数を使う。
- データ源: 新設の `GET /api/queue/summary` → `{ count, needsInput, error, yourTurn, rev }`。Rust は SSE の `hello` と、`follow_up` / `work_item` / `day_boundary` / `settings` を受けたときに取り直す（250ms 束ねる）。キュー全体を Rust で解釈しない。

### 4.2 ポップオーバー（`/tray`）

- 左クリックでポップオーバー、右クリックでメニュー（Open Turnlane、Quick Add ⌥⇧Space、Notifications の状態、Quit）。メニューバーの右クリックとアプリのメニューの文言は、集中モードの項目と同じくデーモンが解決して `/api/queue/summary` の `nativeMenu` で返す（英語は macOS の慣習どおり Title Case）。アプリは最後に受け取った文言を使い続け、一度もつながっていない間だけ macOS の優先言語で選ぶ代わりの文言を使う
- 中身は SPA の新しい画面 `/tray`（M2-6 の YOUR TURN の行部品を使う）:
  - 上部: `YOUR TURN · 3`、状態ごとの件数。デーモンの `desktop_notifications` の action は `request` / `open_settings` / `open_automation_settings`（システム設定のオートメーションの画面。端末に入力できなかったときの知らせのボタン。D-193 B-5）
  - 一覧: needs_input → error → your_turn、待ちの長い順で最大8行＋`+N more`（`/queue` へ）
  - 行の操作: `⏎` / クリック = 開く（タスクの既定の開き先。`POST /api/open`。D-059、ux-mvp 4.11。終わったらポップオーバーを隠す）、`o` = 他の開き方、`e` = 対応不要（`dismiss`）、`m` = 明日（`/follow-ups/:id/defer`。次の稼働日の勤務開始までスヌーズ。D-052 (1)）、`→` / `⌘⏎` = 詳細（main ウインドウを `?panel=<workItemId>` 付きで出し、AI 詳細パネルを開く。D-067）。`↑` / `↓` で選択
  - マウス（UX 監査 A2。ux-mvp 6.3）: 行の左にチェックボックス（完了）、ホバーで `開いて対応`・`明日へ`・`スヌーズ`（30分 / 1時間 / 明日朝）・`対応不要`・`…`、右クリックで同じ操作のメニュー（右にキー）。詳細は main ウインドウのパネル
  - 下部: 先頭に拡張の行（`trayItems`）、`集中する ▸`（30分 / 1時間 / 次の予定の終わりまで。集中中は `集中 · 16:00まで` と `終了`。D-130、ux-mvp 4.15）、`Quick add ⌥⇧Space`（キーの表示。開くのはホットキーかメニューバーのメニュー）、設定。`Close the day` の行は D-192 で消した
  - 0件のとき: `Nothing is waiting on you` と週ボードへのリンク
- 表示のたびに `["queue"]` を取り直す（隠している間に SSE が切れていても古いまま出さない）。

### 4.3 `turnlane open` と画面の指示

- 新設の `POST /api/desktop/open { path }`: デスクトップのクライアントがつながっていれば SSE の `desktop_open` を送り 200 `{ delivered: true }`、いなければ `{ delivered: false }`。
- `turnlane open [board|day|queue]`:
  1. `~/Applications/Turnlane.app` があり、`/api/desktop/open` が `delivered: true` → 終わり（アプリが前面に出て画面を移る）
  2. アプリはあるが起動していない → `open -b dev.turnlane.desktop --args --path /<view>` で起動
  3. アプリが無い、または `--browser` → 今のとおりブラウザで開く

### 4.4 開く: 動いているセッションのタブに着地する（D-214 (4)）

メニューバー・通知・行から「開く」（`POST /api/open`）で、AI のセッションがまだ動いている（Claude Code の live）ときは、新しく再開せずに**そのセッションの端末のタブ（ペイン）**を前に出す。実装は `apps/daemon/src/open/locate.ts`（居場所を調べる）と `focus.ts`（試す順の組み立て。純粋な関数）。

**居場所の調べ方**（読むのはプロセスの親子・tty・実行ファイルのパスと tmux の一覧だけ。画面の中身は読まない）:

1. セッションのプロセスの tty（`ps -o ppid=,tty=,comm=`。`/dev/ttysNNN` だけを受け付ける）
2. 祖先をたどり、最初の `.app`（端末のアプリ）か tmux のサーバ
3. tmux なら、サーバの引数のソケットの指定（`-L` / `-S`）で `tmux list-panes -a` を読み、tty が一致するペイン（`%ID` と `セッション:ウインドウ.ペイン`）を探す。`tmux list-clients` からそのセッションを見ている最後のクライアント（無ければ最後に使ったクライアント。`switch-client` で切り替える）を選び、その tty とプロセスの祖先から端末のアプリをたどる

**探す順**: tty → tmux のペイン → cwd → アプリ。

| 端末 | タブの選び方 | 見つからないとき |
|---|---|---|
| iTerm2 | AppleScript で `tty of session` が一致するセッションのタブとウインドウを選ぶ | アプリを前に出す |
| Terminal | AppleScript で `tty of tab` が一致するタブを選び、ウインドウを前に出す | アプリを前に出す |
| Ghostty | AppleScript の辞書に tty が無い（1.3）。tty に OSC 7（作業フォルダの報告）で一時フォルダの目印を書き、`working directory` が目印の端末を選んでから、OSC 7 でセッションの cwd に戻す（成功しても失敗しても戻す。目印のフォルダは消す。cctop の方法）。だめなら cwd の一致。同じ cwd が複数なら1つ目を前に出し、そう言う | アプリを前に出す |
| tmux の中 | `select-window` と `select-pane`（必要なら `switch-client`）の後、クライアントの tty で上の端末のタブを選ぶ。tmux の中では cwd の一致は使わない（端末の cwd はセッションの cwd と限らない） | ペインだけ選んでアプリを前に出す |
| Orca | 同梱の CLI の `orca terminal switch --terminal=<ハンドル>` でそのタブに切り替え、アプリを前に出す（D-238 で改めた）。ハンドルは hooks が記録した `ORCA_TERMINAL_HANDLE`（`hook_event.term_handle`）が今も `orca terminal list` にあればそれ、無ければ worktree がセッションの cwd を含む端末（一番深い worktree）が 1 つだけのとき。list の画面の中身（preview）・題名は読まずに捨てる（`parseOrcaTerminals`。ADR 0005）。着地の言葉は `Orca · タブ`（タブの題名は Claude Code が会話から付けることがあるので出さない） | アプリを前に出す |
| Warp・それ以外 | アプリを前に出すだけ | — |
| Zellij・Kitty | 今は対象外（ペインの ID を外から引くには環境変数か、Kitty の遠隔操作の設定が要る）。アプリを前に出す | — |

- AppleScript には tty・目印のパスを引数（argv）で渡し、文字列に埋め込まない。どれも 5 秒で打ち切る（オートメーションの許可の確認で待たされるため。初めて操作する端末ごとに OS が許可を聞く。オンボーディングでは求めない）
- **答える（D-238。ADR 0019）**: 同じ居場所から、答えを届ける先を決める（tmux のペイン・iTerm2 の tty・Orca のハンドル）。送り方は m2-api 31 章
- **着地の返し方**: `OpenResult.landing`（`level` tab / app、`by` tty / cwd / handle（Orca）、`tab` タブの番号、`pane` tmux のペイン、`miss` not_found / unsupported / ambiguous、`candidates`）と、デーモンの言語で言葉にした `message`（core の `openLandingText`）。web は自分の言語で同じ関数を使って知らせを出し（「iTerm2 のタブ 3 を前に出しました。」「Ghostty を前に出しました。タブは見つかりませんでした。」「Orca を前に出しました。Orca ではタブまでは選べません。」）、行の「対応中」の後ろに短い形（「対応中 · iTerm2 · タブ 3」。`openLandingShort`）を残す。ポップオーバーは開くとすぐ隠れるので、次に出したときに行で読める。行の着地は端末ごとにブラウザに保存する（12 時間、50 件まで）。通知のクリックから開いたときは行に残らない（web を通らないため）

---

## 5. クイック入力（⌥⇧Space）

- `tauri-plugin-global-shortcut` で ⌥⇧Space を登録する（D-056 (2)。⌥Space はランチャーや AI アプリと衝突するため避けた）。キーは設定 `desktop.quick_add_shortcut`（既定 `Alt+Shift+Space`）で変えられる。設定画面のキーボードの節（D-077。ux-mvp 6.2。キーを押して記録）か `turnlane config set desktop.quick_add_shortcut <key>`。
- 登録に失敗したら、メニューバーのメニューに `⌥⇧Space is in use · Change`（設定画面のキーボードの節 `/settings#keyboard` を開く。D-083）を、設定画面にその旨を出す。メニューからもクイック入力を開ける。
  - **注意（S6）**: macOS の Carbon のホットキーは、他のアプリが同じキーを登録していても登録に成功する（⌥Space・⌘Space でも成功した）。OS が失敗を返すのは書式の誤りなどに限られ、他のアプリとの衝突は検出できない。衝突していればキーを押しても開かないので、そのときは設定でキーを変える（設定画面の説明文に書く）。
- 画面 `/quick-add`（SPA の新しい画面）:
  - 1行の入力。入力に合わせてチップ（日付・時刻・見積・プロジェクト）を出す。パーサは web の `c` と同じ `parseTask`（core の純粋関数。サーバーも同じ関数で解釈する）をブラウザ側で呼ぶ（`/api/tasks/parse` は作らない）
  - `⏎` で `POST /api/tasks { raw, source: "desktop" }`。作成したら `Added to Today` などを 0.8 秒出して隠す。`⌘⏎` で追加して main で開く
  - `Esc` で隠す。入力中の文字は次に開いたとき残す（誤って閉じた場合のため。追加したら消す）
  - 日付の無いものは今のパーサの規則どおり Inbox に入る
- API の `source: "desktop"`。DB の `task.source` の CHECK を変えないため、DB には `source = manual`・`source_ref = desktop:quick_add` で保存し、読み取り時に `origin.source = "desktop"` にする（マイグレーションなし）。Inbox の経由の印は `Quick add`。

---

## 6. 起動と常駐

### 6.1 起動の仕組み

| 物 | LaunchAgent | KeepAlive | 役割 |
|---|---|---|---|
| turnlaned | `dev.turnlane.daemon` | true | 変更なし |
| カレンダーヘルパ | `dev.turnlane.calendar-helper` | true | 変更なし |
| **Turnlane.app** | `dev.turnlane.desktop` | **false**（⌘Q で終了したら次のログインまで起こさない） | `RunAtLoad=true`、`LimitLoadToSessionType=Aqua`、`ProgramArguments` は `.app/Contents/MacOS/turnlane`。`TURNLANE_PORT` / `TURNLANE_DATA_DIR` を引き継ぐ |

- 起動順はそろえない。アプリはデーモンが応答するまで boot ページ（同梱の HTML）を出し、メニューバーをオフラインの状態にして、health を 1s → 30s の指数バックオフで再試行する。
- boot ページには「Turnlane isn't running in the background」と `Start Turnlane`（macOS の優先言語が日本語なら日本語。Rust が `launchctl kickstart gui/<uid>/dev.turnlane.daemon` を実行）、`Retry`、`turnlane doctor` の案内を出す。
- デーモンが再起動したら（SSE が切れて `hello` の `bootId` が変わる）、Rust は summary を取り直し、main は今の web の再接続で戻る。401 が返ったらトークンを読み直して `/auth` からやり直す（再インストールでトークンが変わった場合）。
- 版の確認: `/api/health` の `version` とアプリの版の major.minor が違えば、メニューに `App needs an update · run turnlane self-install` を出す（表示だけ。動作は止めない）。
- 更新の後（配布版。onboarding.md 2.5、M6-17）: アプリは起動時の自分のバンドルの識別（Info.plist の `TurnlaneBuild`）を覚えて 1 分ごとに見る。変わっていれば（動いている間に入れ替わった）、メニューに `Restart to Finish Update`（日本語は「再起動して更新を終える」）を出し、上の版の表示の代わりにする。押すと、このプロセスの終了を待って同じ場所のバンドルを開く小さなシェルを残して終わる（単一インスタンスなので先に開かない）。

### 6.2 turnlane コマンド

| コマンド | 内容 |
|---|---|
| `turnlane self-install` | 今の手順に加え、コピー元に `Turnlane.app` があれば `~/Applications/Turnlane.app` へ置き（一時名 → rename）、`dev.turnlane.desktop` を登録して起動する（ログイン時の自動起動を既定で登録。D-056 (4)）。`--no-desktop` で省く |
| `turnlane desktop install|uninstall|status` | アプリだけの配置・削除・状態（LaunchAgent、起動中か、SSE 接続、通知の許可、ホットキーの登録）。`turnlane calendar install` と同じ形。通知の許可とホットキーはアプリが `POST /api/desktop/status` で知らせ、`GET /api/desktop/status` で読む（12章） |
| `turnlane uninstall` | アプリの LaunchAgent と `.app` も消す（データは残す） |
| `turnlane open` | 4.3 |
| `turnlane doctor` | アプリの有無、署名（Apple Development か ad-hoc か）、LaunchAgent、接続を点検に足す |

---

## 7. セキュリティ

- Host / Origin の検証（phase0-plan 3.4）は変えない。ウインドウの Origin は `http://127.0.0.1:<port>` で、ブラウザと同じ。Rust のリクエストは Bearer で Origin を付けない（今の CLI と同じ扱い）。
- トークンは Rust だけが読み、JS には渡さない（`/auth` のクッキーは HttpOnly）。`/auth?t=` は 302 で移るので履歴に残らない。
- リモート URL に開く IPC は `desktop_hide` / `desktop_open` / `desktop_quick_add` の3つに限る（capability の `remote.urls` は `http://127.0.0.1:<port>/*` と `http://localhost:<port>/*` だけ）。どちらもデータを読み書きしない。
- WKWebView 内で外部のサイトを開かない（2.5 のナビゲーションの制限）。外部のページから IPC を呼ばれる経路を作らない。
- 通知の文言に会話本文を入れない（題名・リポジトリ・ブランチだけ。ADR 0005）。例外は即時の通知の題名の直近の指示の 1 行目（D-211）: `notify` の notice の `promptTitle: true` を見て、Rust が出す直前に `GET /api/work-items/<id>/glance` を読み、`prompt.text` を題名にする。読んだ中身は覚えず、ログに書かない。読めなければデーモンの題名のまま。
- タスクから開く（D-059）のは Rust ではなくデーモン（m2-api 13章）。Rust が送るのはフォローアップの ID だけで、パス・URL・コマンドを渡さない。Rust にシェルや `open` を実行する経路を足さない。

---

## 8. 大きさの目安

| 項目 | 目安 | 確認 |
|---|---|---|
| `Turnlane.app` の大きさ | 10〜15MB（arm64 のみ。WebView は OS のものを使う） | M2-D10 で計測 |
| Rust のプロセス | 30〜60MB | 同上 |
| WKWebView（WebContent プロセス） | 1つあたり 60〜150MB。main を閉じると tray と quick-add の2つ（隠した状態） | 同上 |
| 合計（main を閉じた常駐時） | **200MB 以下**を目標 | 超えたら tray と quick-add を隠すのではなく都度生成にする（開くのに約 0.3 秒） |
| 合計（main を開いた状態） | 350MB 以下 | |
| クイック入力が出るまで | 150ms 以内 | 隠しておいたウインドウを出すだけにする |

デーモンの目標（常駐 200MB 以下。M5-2）とは別に数える。

---

## 9. カレンダーヘルパとの関係

**当面は別のまま**（ADR 0010 の決定 5）。

- S1 で合格した構成（launchd 直下の Swift アプリが自分の名前で EventKit の権限を持つ）を変えると、権限の再許可と再検証が要る。
- アプリを ⌘Q で終了しても、予定の同期と待ち区間の再計算（M3-2）が止まらない。
- Tauri アプリに EventKit を入れると、Rust（objc2）か Swift のプラグインが増え、「Rust を最小にする」に反する。

**M6（公開準備）で同梱するのは必須**（D-056 (5)。利用者から見えるアプリを1つにする）。ヘルパを `Turnlane.app/Contents/Library/LoginItems/` に同梱し、`SMAppService` で登録する（ヘルパは Swift のまま、bundle ID も変えない）。構成・登録の順序・更新・移行の詳細は [ADR 0011](../adr/0011-single-app-bundle-smappservice.md) と [onboarding.md](onboarding.md) 2 章。

---

## 10. タスクと見積

人日は相対的な大きさ（D-042）。M2 段階 B の先頭に入れる（phase0-plan 4.4）。

| ID | タスク | 見積 | 依存 |
|---|---|---|---|
| M2-S6 | スパイク: Tauri 2 の最小の .app（Apple Development 署名）で、(1) `127.0.0.1` の SPA を読み込みクッキー認証が通る、(2) リモート URL からの IPC が capability で絞れる、(3) 通知のクリックで識別子を受け取れる（コミュニティのプラグインと objc2 直接の比較。消しただけの操作でクリックにならないこと）、(4) ⌥⇧Space の登録、(5) メモリの実測。結果を `docs/spikes/s6-desktop-shell.md` に書き、通知の実装を決める | 0.5 | — |
| M2-D1 | `apps/desktop` の雛形: Tauri 2、Cargo、Bun のスクリプト、mise の rust、`build.sh`（署名）、CI の clippy / test、boot ページ、main ウインドウ（`/auth` → 最後の画面、位置と大きさの保存、閉じたら破棄）、ナビゲーションの制限と opener、自前のメニュー、Dock の切り替え、single-instance、CLAUDE.md の名称表 | 1 | M2-S6 |
| M2-D2 | デーモン: `planNotifications`・`filterPaused`・`visibleQueue` と通知の文言を core へ移す、`NotifyRunner`、SSE の `notify` / `desktop_open`、`client=desktop` と `lang`、`QueueResponse.desktopNotifier`、`GET /api/queue/summary`、`POST /api/desktop/open`。既存の通知のテストを core に移し、runner の表駆動テスト（起動直後は出さない、閉店モード、まとめ） | 1 | — |
| M2-D3 | Rust: SSE クライアント（再接続、`bootId` の変化、401 でトークン再読込）、メニューバーの件数と状態（琥珀・オフライン）、右クリックのメニュー | 0.75 | M2-D1, M2-D2 |
| M2-D4 | Rust: 通知の表示とクリック（S6 で選んだ実装）、許可の要求と拒否時の案内。web: `/queue?item=<id>` で該当の行を選んで表示 | 0.75 | M2-D3 |
| M2-D5 | web の WKWebView 対応: ブラウザ通知の停止（UA と `desktopNotifier`）、クリップボードを `ClipboardItem` に、`desktop.ts` のラッパ、外部リンク、`dragDropEnabled` | 0.5 | M2-D2 |
| M2-D6 | turnlane: `turnlane desktop install|uninstall|status`、`self-install` での配置と登録（`--no-desktop`）、`uninstall`、`turnlane open` のアプリ優先、`turnlane doctor` の点検、LaunchAgent の plist（`desktopPlist`） | 0.75 | M2-D1 |
| M2-D7 | ポップオーバー: web の `/tray`（行部品、`e` / `m` / `⏎`、0件の表示）、positioner、フォーカスを失ったら隠す、`desktop_open` | 1 | M2-D3, M2-D5 |
| M2-D8 | クイック入力: ⌥⇧Space の登録と失敗時の案内、設定 `desktop.quick_add_shortcut`、web の `/quick-add`（パーサのチップ、`⏎` / `⌘⏎` / `Esc`、入力の保持）、直前のアプリへのフォーカスの返却、`source=desktop` の経由の印 | 0.75 | M2-D1, M2-D5 |
| M2-D9 | boot ページとデーモン未起動時の扱い（`Start turnlaned`、バックオフ、版の不一致の表示） | 0.25 | M2-D1 |
| M2-D10 | 確認と記録: 大きさとメモリの実測（8章）、スリープ復帰、デーモンの再起動、⌘Q → `turnlane open` での再起動、ブラウザとの通知の切り替え、`docs/dev/desktop.md`（ビルド・署名・インストール・権限の手順） | 0.5 | M2-D4, M2-D6〜M2-D9 |

合計 **7.75人日**（M2-S6 0.5 + D1 1 + D2 1 + D3 0.75 + D4 0.75 + D5 0.5 + D6 0.75 + D7 1 + D8 0.75 + D9 0.25 + D10 0.5）。

**順序**: M2-S6 → M2-D1・M2-D2（並行できる）→ M2-D3 → M2-D4・M2-D5 → M2-D6 → M2-D7 → M2-D8 → M2-D9 → M2-D10。M2-D4 まで（4.0人日）で「ウインドウを閉じても AI の待ちがネイティブ通知とメニューバーで分かる」状態になる。ここを最初の到達点にし、常用中に使い始める。

**削り順**（遅れたら後ろに回す。上から先に削る）:
1. ポップオーバーを NSMenu（tray のメニューに YOUR TURN の行を並べ、サブメニューで Open / Dismiss / Tomorrow）にする（M2-D7 を 0.5 に）
2. クイック入力のチップのプレビューと `⌘⏎`（M2-D8 を 0.5 に）
3. 版の不一致の表示、`Start turnlaned` のボタン（M2-D9 は案内の文だけ）
4. ウインドウの位置と大きさの保存

削らないもの: 通知のクリックで該当項目を開くこと、ブラウザ通知との二重通知の防止、閉店モードの停止（D-052）、Apple Development 署名。

**完了条件**: `turnlane self-install` で `Turnlane.app` が入りログイン時に起動する。main を閉じた状態で、AI が許可待ちになると即時のネイティブ通知が出て、クリックで main がその項目を開く。メニューバーの件数がサイドバーの件数と一致し、needs_input があると琥珀になる。ポップオーバーから対応不要・明日ができる。⌥⇧Space から日本語・英語でタスクを追加でき、直前のアプリにフォーカスが戻る。ブラウザのタブを開いていても通知が二重に出ない。閉店後は通知が止まる。デーモンを止めるとメニューバーがオフラインになり、起動し直すと自動で戻る。常駐時の合計メモリが 8章の目安に収まる。

---

## 11. オーナー判断（D-056 で確定）

1. ウインドウを閉じたら Dock と ⌘Tab から消し、メニューバーに常駐する（2.7）
2. クイック入力の既定は ⌥⇧Space（Raycast・ChatGPT・Claude の ⌥Space との衝突を避ける）。設定で変更でき、登録の失敗は画面に出す（5章。他のアプリとの衝突は OS が知らせないので検出できない。S6）
3. 通知音は needs_input だけ（3.2）
4. `turnlane self-install` でログイン時の自動起動を既定で登録する（6.2）
5. カレンダーヘルパは当面別のまま。公開準備（M6）で `Turnlane.app` に同梱し `SMAppService` で登録して、利用者から見えるアプリを1つにする（必須。9章）
6. +7.75人日を了承。M2-D4（ウインドウを閉じていても通知とメニューバーで分かる）までを最初の到達点にする
7. ux-mvp.md の S13・S15 は Phase0 に直した（2026-10-05）

## 12. 実装時の判断（仮置き。PO の確認待ち）

| # | 内容 | 理由 |
|---|---|---|
| 1 | ログイン時（LaunchAgent の `--background`）は main を開かずメニューバーだけで始める。`turnlane open`・Dock・ダブルクリックでは main を開く | ログインのたびに大きなウインドウが出ると邪魔。D-056 (1) の「閉じたらメニューバーに常駐」と同じ状態から始める |
| 2 | `POST /api/desktop/status`・`GET /api/desktop/status` を足した（通知の許可・ホットキーの登録・版）。D-080 で `POST /api/desktop/notifications`（許可を求める・システム設定を開く）と SSE の `desktop_notifications` / `desktop_status` | `turnlane desktop status` と設定画面に出すため。読み書きするのは表示用の状態だけ |
| 3 | `task.source` は DB では `manual` + `source_ref = desktop:quick_add`（5章） | 稼働中の DB のテーブルを作り直すマイグレーションを避ける |
| 4 | クイック入力のチップはブラウザ側の `parseTask`（5章） | web の `c` と同じ。API を増やさない |
| 5 | メニューバーのメニューとアプリのメニューの文言は英語だけ | UI は英語が正（D-023）。Rust に辞書を持たない |
| 6 | クイック入力を閉じるとき、Turnlane 自身が前面だった場合は `AppHandle::hide()` を呼ばない | main を開いて作業中にクイック入力を使ったとき、main まで隠れないように |
| 7 | 設定画面にデスクトップアプリの行（通知の許可、クイック入力のキー）を足した（アプリがつながっているときだけ） | メニューの `is in use · Change` から移れる先が要る（M2-9 の設定画面の一部を先に作った） |
| 8 | `dev:board` に `--demo-notify <秒>`（起動後に許可待ちを1件足す） | 一時 HOME のダミーデータで通知とメニューバーを確かめるため |
