# デスクトップアプリ（Turnlane.app）のビルド・入れ替え・確認の手順

デスクトップシェル（Tauri 2。[ADR 0010](../adr/0010-desktop-shell-in-phase0-as-daemon-client.md)、[desktop-shell.md](../spec/desktop-shell.md)）を
ビルドして常用の環境に入れ、通知・メニューバー・クイック入力を確かめる手順。自動で確かめられる部分は
`bun run check`（デーモンの通知の判定・API・CLI）と `bun run check:desktop`（Rust の clippy と test）が行う。

- 入っているもの: メインウインドウ（今の Web UI）、メニューバーの件数とポップオーバー、ネイティブ通知（クリックで該当の項目を開く）、
  ⌥⇧Space のクイック入力、`turnlane desktop install|uninstall|status`、`turnlane self-install` での自動起動の登録、`turnlane open` のアプリ優先
- オーナーの判断（D-056）: 閉じたら Dock と ⌘Tab から消える、クイック入力は ⌥⇧Space（変更可）、通知音は needs_input だけ、
  `turnlane self-install` でログイン時に起動、カレンダーヘルパは別のまま
- まだ無いもの: 会議中の通知の保留（v1）、通知上のボタン、フルスクリーンのアプリの上のクイック入力、自動更新（M6）

## 0. 入れ替える前に（任意）: ダミーデータで見る

一時 HOME・別ポート（27317）のデーモンに、ビルドした `.app` をつなげて動かせる。オーナーのデーモン・データには触れない。
ただし `.app` は同じ bundle ID（`dev.turnlane.desktop`）なので、**入れ替え後のアプリが動いている間は動かさない**（二重起動の防止で
動いている方が前面に出るだけになる）。

```sh
cd ~/source/turnlane/turnlane
bun install
bun run build:web
bun run build:desktop        # out/Turnlane.app（署名は 1 章）
bun scripts/dev-board.ts --port 27317 --lang en --theme dark --demo-notify 30
# 表示された TURNLANE_DATA_DIR=... TURNLANE_PORT=27317 を使って、別のターミナルで:
TURNLANE_PORT=27317 TURNLANE_DATA_DIR="<表示されたパス>" TURNLANE_DESKTOP_TRACE=1 out/Turnlane.app/Contents/MacOS/turnlane
```

`--demo-notify 30` は起動の30秒後に許可待ち（needs_input）を1件足す。通知が出て、メニューバーが琥珀になる。
スクリーンショット（このダミーデータ。ヘッドレスのブラウザでウインドウと同じ大きさに描いたもの）は `docs/dev/screens/desktop/` にある。

| ファイル | 内容 |
|---|---|
| `main-window-board-en-dark.png` | メインウインドウ（週ボード。1280×800） |
| `tray-popover-en-dark.png` | メニューバーのポップオーバー（/tray。360×480） |
| `quick-add-en-dark.png` | クイック入力（/quick-add。640×168。入力中のチップ） |

メニューバーのアイコンと通知のバナーは、実機の画面で 3 章の手順で確かめる（検証時は画面がロックされていて撮れなかった）。

## 1. ビルドと入れ替え

```sh
cd ~/source/turnlane/turnlane
git pull               # main
bun install
bun run check          # biome / tsc -b / bun test
bun run check:desktop  # cargo clippy / cargo test（Rust 1.92.0。mise の .mise.toml）

# 署名: カレンダーヘルパと同じ Apple Development 証明書。名前は次で確かめる
security find-identity -v -p codesigning
export TURNLANE_CODESIGN_IDENTITY="Apple Development: <名前> (<ID>)"
bun run build          # out/turnlaned と out/turnlane（同じ証明書で署名。codesign.md）
bun run smoke
bun run build:desktop  # out/Turnlane.app（数分かかる）
```

- 初回の署名で「codesign がキーチェーンの鍵 "Apple Development: …" にアクセスしようとしています」というダイアログが出たら、
  ログインのパスワードを入れて **常に許可** を選ぶ（選ばないとビルドが止まったままになる）
- `TURNLANE_CODESIGN_IDENTITY` が無いと ad-hoc 署名になり、再ビルドのたびに通知の許可（アプリ）やオートメーションの許可（turnlaned）が外れることがある（警告が出る）

```sh
out/turnlane self-install    # デーモンと turnlane を入れ替え、Turnlane.app を ~/Applications に置いてログイン時の起動を登録し、起動する
turnlane desktop status
```

- `turnlane self-install` は `out/` に `Turnlane.app` があれば一緒に置く。アプリを入れたくないときは `--no-desktop`
- アプリだけを入れ替えるときは `turnlane desktop install --app out/Turnlane.app`
- DB のマイグレーションは増えない
- 入れ替えた後、メニューバーに日の出の形のアイコンと自分の番の件数が出る（ログイン時はウインドウを開かずにメニューバーだけで起動する）

## 2. 通知の許可

検証中（画面ロック中）に初回の許可を求めたため、**この Mac では `turnlane` の通知が「拒否」として記録されている**。

1. システム設定 > 通知 > **Turnlane** を開き、「通知を許可」をオンにする。通知のスタイルは「バナー」、「サウンド」もオン
   （メニューバーのアイコンを右クリックして `Notifications are off · Open System Settings` からも開ける）
2. `turnlane desktop status` の「通知: 許可」を確かめる（アプリはメニューを開くたびに状態を読み直す）

## 3. 動作の確認（desktop-shell.md 10章の完了条件）

| # | 操作 | 期待すること |
|---|---|---|
| 1 | `turnlane open` | メインウインドウが開き、週ボードが出る。Dock と ⌘Tab に出る |
| 2 | メインウインドウを ⌘W で閉じる | Dock と ⌘Tab から消え、メニューバーに残る |
| 3 | メニューバーのアイコンを左クリック | ポップオーバーに YOUR TURN の一覧。件数がサイドバーの件数と同じ。needs_input があるとアイコンが琥珀 |
| 4 | ポップオーバーで `↓` `e`（対応不要）・`m`（明日）・`⏎`（開く） | 行が消える・明日へ移る・PR が開くか再開コマンドがコピーされる |
| 5 | 他のアプリを前面にして ⌥⇧Space | クイック入力が画面の上 1/3 に出る。`Write outline tomorrow 30m` で日付・見積のチップ、`⏎` で `Added to Sat 10/…` を出して閉じ、元のアプリにフォーカスが戻る。日本語（`記事の構成 明日 30m`）でも同じ |
| 6 | Claude Code で許可待ち（権限の確認）を起こす | メインウインドウを閉じたままでも、音付きのバナー通知が即時に出る |
| 7 | その通知のバナーをクリック | メインウインドウが開き、要対応キューでその行が選ばれている。**通知を消しただけ（×・スワイプ）では何も開かない** |
| 8 | ブラウザで `turnlane open --browser` のタブも開いたまま 6 を繰り返す | 通知はアプリの1つだけ（ブラウザ通知は出ない） |
| 9 | 夕方に Close the day をした後に許可待ちを起こす | 通知が出ない（件数は出る）。設定の「Approval requests outside working hours（日本語「勤務時間外の許可待ち」。D-080 で改名）」をオンにすると needs_input だけ出る |
| 10 | `turnlane daemon stop` | メニューバーが斜線のアイコンと `–` になり、右クリックのメニューに `Turnlane isn't running in the background` と `Start Turnlane`（日本語の設定では `Turnlane がバックグラウンドで動いていません` と `Turnlane を起動`） |
| 11 | `turnlane daemon start` | 30秒以内にメニューバーが戻る |
| 12 | ⌘Q でアプリを終了 → `turnlane open` | アプリが起動して週ボードが出る |
| 13 | スリープから復帰 | メニューバーの件数と通知が戻る（45秒以内につなぎ直す） |

うまくいかないとき: `turnlane desktop status`、`turnlane doctor`（署名・LaunchAgent・接続）、`~/Library/Logs/turnlane/desktop.stderr.log`。

## 4. 計測（S6 の残り。結果を PO に返してください）

画面を使っている状態で計る（検証時は画面ロック中の参考値しか取れなかった）。

```sh
# 常駐（メインウインドウを閉じた状態）と、開いた状態でそれぞれ
APP_PID="$(pgrep -f 'Turnlane.app/Contents/MacOS/turnlane')"
echo "${APP_PID}"
# WebKit のプロセスは親が launchd なので、アプリの起動時刻の直後に始まったものを選ぶ
ps -axo pid,lstart,comm | grep -E 'WebKit|MacOS/turnlane'
footprint -p "${APP_PID}" -p <WebContent の pid> -p <GPU の pid> -p <Networking の pid> | grep -E 'Footprint:'
```

クイック入力の表示時間（ホットキーを受けてから表示とフォーカスが終わるまで）:

```sh
turnlane desktop uninstall                     # いったん外す（launchd から起動したものを止める）
TURNLANE_DESKTOP_TRACE=1 out/Turnlane.app/Contents/MacOS/turnlane --background
# 他のアプリを前面にして ⌥⇧Space を数回押す → 標準エラーに "quick-add shown in 12.3ms" のように出る
# Ctrl-C で止め、turnlane desktop install --app out/Turnlane.app で戻す
```

目安（desktop-shell.md 8章）: 常駐の合計 200MB 以下、開いた状態 350MB 以下、クイック入力 150ms 以内。

## 5. 元に戻す

```sh
turnlane desktop uninstall   # アプリと LaunchAgent を消す。デーモン・ヘルパ・データはそのまま。ブラウザ通知に戻る
```
