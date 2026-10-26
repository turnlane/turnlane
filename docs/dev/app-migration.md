# 開発時の配置から Turnlane.app の配置へ移す手順（M6-16）

`turnlane self-install` で入れた開発時の配置（`~/.local/bin/turnlane`・`turnlaned`、LaunchAgent `dev.turnlane.daemon` /
`.calendar-helper` / `.desktop`、`~/Applications/Turnlane.app`・`TurnlaneCalendarHelper.app`）を、配布版の配置
（`Turnlane.app` の中のバイナリ、`SMAppService` の登録。[ADR 0011](../adr/0011-single-app-bundle-smappservice.md)）に移す。
移行そのものは同梱の `turnlane setup migrate` が行う。自動で確かめられる部分は `bun test apps/cli/test/setup.test.ts`
（一時 HOME に開発時の配置の形を作る。launchd・SMAppService には触れない）。

データ（`~/Library/Application Support/turnlane/`）・トークン・設定はそのまま使う。オンボーディングは出ない。

## 1. 組み立てる

```sh
cd ~/source/turnlane/turnlane
bun install
bun run check && bun run check:desktop
export TURNLANE_CODESIGN_IDENTITY="Apple Development: <名前> (<ID>)"   # いつもの証明書（キーチェーンの確認が出たら「常に許可」）
bun run build:app                      # out/app/Turnlane.app（数分）
# 拡張を組み込むときは、拡張のリポジトリの scripts/build.sh --app（中で build-app.ts --ext を呼ぶ）
```

`build:app` は最後に形・版・署名を確かめる（`Contents/Helpers/turnlaned --version` と Info.plist の `TurnlaneBuild` が同じ）。

## 2. 置いて、何をするかを見る（何も変えない）

```sh
ditto out/app/Turnlane.app /Applications/Turnlane.app
/Applications/Turnlane.app/Contents/Helpers/turnlane setup migrate --dry-run
```

`--dry-run` の出力に、次の 1〜9 がこの Mac の実際のパスで出る。止まる条件（下）に当たれば、ここで理由が出る。

## 3. 移す（立ち会いで）

```sh
/Applications/Turnlane.app/Contents/Helpers/turnlane setup migrate
hash -r
```

行うこと（どの段も今の状態を見て、済んでいなければ行う。途中で失敗しても同じコマンドで続きから）:

| # | 処理 | 退避先 |
|---|---|---|
| 1 | LaunchAgent `dev.turnlane.desktop` → `.calendar-helper` → `.daemon` を bootout し、plist を退避 | `~/Library/Application Support/turnlane/legacy/<時刻>/LaunchAgents/` |
| 2 | 7317 番で旧のデーモンが応答しなくなるのを待つ | — |
| 3 | hooks・MCP が書く固定の場所 `…/turnlane/bin/turnlane` を、アプリの中の turnlane へのリンクに | — |
| 4 | `~/.local/bin/turnlane`・`turnlaned` を退避し、`~/.local/bin/turnlane` をアプリの中の turnlane へのリンクに | `legacy/<時刻>/bin/` |
| 5 | Claude の各設定ディレクトリの `settings.json` と Codex の `hooks.json` のうち、Turnlane のエントリがあるものだけを、同じ位置で固定の場所に書き換える | `<ファイル>.bak-turnlane-<時刻>` |
| 6 | MCP の `turnlane` の登録が古いパスを指していれば固定の場所に（登録の無いところには足さない） | `<ファイル>.bak-turnlane-<時刻>` |
| 7 | `~/Applications/Turnlane.app`・`TurnlaneCalendarHelper.app` をゴミ箱へ | `~/.Trash/<名前>-<時刻>.app` |
| 8 | `install.json` を `app` に。アプリのプロセスで常駐を登録（`Turnlane.app/Contents/MacOS/turnlane --setup register daemon` / `mainApp` / カレンダーを使っていれば `calendarHelper`）し、デーモンの応答を待つ | — |
| 9 | 案内（許可の入れ直し、Codex の `/hooks`、`hash -r`、戻し方） | — |

何をしたかは `legacy/<時刻>/manifest.json` に残る。

止まる場合（何も変えずに止まる）:

- `turnlaned` の入った `Turnlane.app` から実行していない（`--app <path>` でも指定できる）
- アプリがダウンロードフォルダ・ディスクイメージの中にある
- 開発時の LaunchAgent かシェルが `TURNLANE_DATA_DIR` / `TURNLANE_LOG_DIR` / `TURNLANE_PORT` で場所を変えている（配布版は既定の場所しか使えない）
- 旧のデーモンを止めた後も 7317 番で何かが応答している

## 4. 移した後

```sh
open /Applications/Turnlane.app
turnlane doctor          # install: app · hooks path ok · background: daemon enabled, …
```

- macOS の通知「Turnlane がバックグラウンドで実行できる項目を追加しました」が出る。システム設定 › 一般 › ログイン項目 に Turnlane が 1 行
- 8 で登録できなかったと出たら、`Turnlane.app` を開けばアプリが登録する（一度始めた環境なので Welcome は出ない）。オフになっていればログイン項目でオンにする
- カレンダー: 予定が出なければ 設定 › カレンダー の「カレンダーをつなぐ」（同梱のヘルパを登録して許可のダイアログを出す）
- 通知・オートメーション: 聞かれたら許可する（同じ証明書・同じ bundle ID なら残る見込み。M6-S8 で確かめる項目）
- Codex: hooks のコマンドが変わったので、次に起動したら `/hooks` で Turnlane の hook を承認し直す

## 5. 戻す

```sh
/Applications/Turnlane.app/Contents/Helpers/turnlane setup migrate --rollback --dry-run   # 見る
/Applications/Turnlane.app/Contents/Helpers/turnlane setup migrate --rollback
```

アプリの登録を外し（`--setup unregister-all`）、退避したバイナリ・アプリ・plist を戻して読み込み、hooks と MCP を
`~/.local/bin/turnlane` に書き換え、`install.json` を `dev` に戻す。外せなかったと出たら、ログイン項目で Turnlane を
オフにする。最後に `/Applications/Turnlane.app` を消す。
