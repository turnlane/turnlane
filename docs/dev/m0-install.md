# M0 の確認手順（自分の Mac に常駐させる）

M0 の完了条件（phase0-plan 4.2）のうち、実機の launchd と再起動が要るものを確かめる手順。
自動で確かめられる部分は `bun run smoke` が一時 HOME で行う（launchd には触れない）。

- 対象: macOS 14 以降 / Apple Silicon、Bun 1.4.2
- 書き込む場所: `~/.local/bin/{turnlane,turnlaned}`、`~/Library/LaunchAgents/dev.turnlane.daemon.plist`、
  `~/Library/Application Support/turnlane/`、`~/Library/Logs/turnlane/`
- M0 は AI セッションの取り込みをしない（`~/.claude*` や `~/.codex` は読まない）

## 1. ビルドと自動チェック

```sh
cd ~/source/dayline
bun install
bun run check          # biome / tsc -b / bun test
security find-identity -v -p codesigning                            # 証明書の名前を確かめる
export TURNLANE_CODESIGN_IDENTITY="Apple Development: <名前> (<ID>)"  # build の前に
bun run build          # out/turnlaned と out/turnlane（上の証明書で署名し、検証と起動を確かめる）
bun run bench:hook     # turnlane hook の起動時間（p95 50ms 以内）
bun run smoke          # 一時 HOME でバイナリを動かす確認
```

`TURNLANE_CODESIGN_IDENTITY` を設定してから build する。無いと ad-hoc 署名のままになり、入れ替えのたびに
macOS のオートメーションの許可（Ghostty の操作など）を聞き直される（[codesign.md](codesign.md)。警告が出る）。
初回の署名で「codesign がキーチェーンの鍵にアクセスしようとしています」と出たら、ログインのパスワードを入れて **常に許可** を選ぶ。

`.mise.toml` を使う場合は、初回に `mise trust` が要る（信頼されていないと mise のシム経由の node が失敗する）。

## 2. インストールして常駐させる

先に何が起きるかを見る（何も書かない）:

```sh
out/turnlane self-install --dry-run
```

インストール:

```sh
out/turnlane self-install
```

- `~/.local/bin` に `turnlane` と `turnlaned` をコピーし、LaunchAgent を登録して起動する
- 最後に `turnlane --version` と `turnlaned --version` を1回ずつ実行する（新しいバイナリの初回のコード検査、約1秒を済ませる）
- `~/.local/bin` が PATH に無ければ注意が出る。シェルの設定に `export PATH="$HOME/.local/bin:$PATH"` を足す

確認:

```sh
turnlane daemon status       # 「turnlaned: 稼働中」「launchd: 登録済み」なら OK（終了コード 0）
turnlane open                # ブラウザで health 画面が開く
ls ~/Library/Application\ Support/turnlane/backups/   # turnlane-YYYYMMDD.db がある
```

## 3. 再起動後も動いていることを確かめる（M0 完了条件）

1. Mac を再起動してログインする
2. ターミナルで `turnlane daemon status` を実行し、「稼働中」と出ることを確認する
3. `turnlane open` で health 画面が出ることを確認する
4. `ls ~/Library/Application\ Support/turnlane/backups/` で、その日（午前4時区切り）のバックアップがあることを確認する

うまくいかないとき:

```sh
turnlane daemon logs -n 100                       # デーモンのログ（JSON Lines）
cat ~/Library/Logs/turnlane/turnlaned.stderr.log
launchctl print gui/$(id -u)/dev.turnlane.daemon | head -40
```

### `launchctl bootstrap failed (5): Bootstrap failed: 5: Input/output error`

稼働中のデーモンを入れ替えるとき（`turnlane self-install`、`turnlane calendar install` の2回目以降）や `turnlane daemon stop` の直後の `turnlane daemon start` で起きる。
`launchctl bootout` は launchd がサービスを解体し終える前に戻ることがあり、その間に `bootstrap` すると error 5（または 37）で失敗する。

`turnlane` は bootout の後に `launchctl print` で登録が外れたことを確かめてから（100ms 間隔、最大 5 秒）bootstrap し、
error 5 / 37 なら間隔を空けて最大 5 回（合計約 5 秒）再試行する。それでも失敗したときは「launchd への登録に失敗しました」と次の手順を表示する。
その時点でバイナリと plist は配置済みなので、入れ直しは不要:

```sh
launchctl print gui/$(id -u)/dev.turnlane.daemon | head -5   # "Could not find service" なら未登録
turnlane daemon start                                             # 数秒待ってから登録・起動し直す
turnlane daemon status                                            # 「稼働中」「登録済み」を確認
```

`turnlane daemon start` も失敗し、`launchctl print` で登録済みと出る場合は、`turnlane daemon stop` → 数秒待って `turnlane daemon start`。
カレンダーヘルパ（`dev.turnlane.calendar-helper`）で起きたときは `turnlane calendar install` を実行し直す。

## 4. 日常の操作

| 操作 | コマンド |
|---|---|
| 状態 | `turnlane daemon status`（`--json` も可） |
| 止める / 起動 / 再起動 | `turnlane daemon stop` / `turnlane daemon start` / `turnlane daemon restart` |
| ログを追う | `turnlane daemon logs -f` |
| 今すぐバックアップ | `turnlane backup` |
| 全データの書き出し | `turnlane export --json --out ~/turnlane-export.jsonl` |
| 新しいビルドに入れ替える | 下の手順（登録済みなら止めて入れ替える） |

`turnlane daemon stop` は launchd から外すだけで、次回ログイン時には自動で起動する。

### 新しいビルドに入れ替える

デーモン・`turnlane`・Turnlane.app を同じ証明書で署名して入れ替える。カレンダーヘルパは変更があるときだけ（[m3-a.md](m3-a.md) 3章）。

```sh
cd ~/source/dayline
git pull && bun install
bun run check && bun run check:desktop
export TURNLANE_CODESIGN_IDENTITY="Apple Development: <名前> (<ID>)"
bun run build && bun run smoke
bun run build:desktop
out/turnlane self-install
```

- `bun run build` の出力に `signed: Apple Development: … (hardened runtime, verified)` が出ることを確かめる
- 署名の前提と、許可が保たれるかの確認は [codesign.md](codesign.md) 2章

## 5. アンインストール

```sh
turnlane uninstall --dry-run
turnlane uninstall
```

LaunchAgent とバイナリを消す。データ（`~/Library/Application Support/turnlane/`）とログは残す。完全に消す場合は手で削除する。

## 開発時に実データの場所を使わない

環境変数で場所とポートを差し替えられる。

| 変数 | 既定 |
|---|---|
| `TURNLANE_DATA_DIR` | `~/Library/Application Support/turnlane` |
| `TURNLANE_LOG_DIR` | `~/Library/Logs/turnlane` |
| `TURNLANE_PORT` | `7317` |
| `TURNLANE_NO_LAUNCHD=1` | launchd を操作しない（`turnlane daemon status` は launchd を未登録として扱う） |

例: `TURNLANE_DATA_DIR=/tmp/dl-dev TURNLANE_PORT=17317 bun run dev:daemon` と `TURNLANE_PORT=17317 bun run dev:web`（Vite が `/api` と `/auth` をデーモンへプロキシする。ブラウザで `http://localhost:5173/auth?t=<token>` を一度開く）。

launchd の `gui/<uid>` ドメインは HOME を変えても共有される。HOME を一時ディレクトリにしても、`TURNLANE_NO_LAUNCHD=1` を付けずに `turnlane self-install` / `turnlane uninstall` / `turnlane daemon stop` を実行すると、本物の `dev.turnlane.daemon` を操作する。
