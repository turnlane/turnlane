# S7: タスクから「開く」— AI のセッションへ戻る方法の調査

- 状態: **Claude Code の URL スキーム（`claude-cli://`）では特定のセッションを再開できない**。Codex app（`codex://threads/<id>`）はスレッドを ID で開ける。ターミナルは Ghostty なら AppleScript で「cwd を指定して新しいウインドウを開き、コマンドを入力済みにする（実行しない）」ができる。実装は [ux-mvp.md](../spec/ux-mvp.md) 4.11、[m2-api.md](../spec/m2-api.md) 13章
- 関連: PO 決定 D-059、phase0-plan の未決 U11（Claude Desktop・Codex アプリのディープリンク）
- 日付: 2026-10-05（macOS 26.6、Claude Code 2.1.288、Codex CLI 0.147.0、Ghostty 1.3.1）
- 方法: 公式ドキュメント、各アプリの `Info.plist` の `CFBundleURLTypes`、AppleScript 辞書（`.sdef`）、`--help` を読んだ。実際のセッションは開いていない

## 結論

| # | 確かめたこと | 結果 |
|---|---|---|
| 1 | Claude Code の URL スキームでセッションを再開できるか | **できない**。`claude-cli://open` が受け付けるのは `q`（入力欄に入れる文）・`cwd`・`repo` の3つだけで、セッション ID を受け取るものが無い。新しいセッションを新しいターミナルで開く |
| 2 | 代わりに `q=/resume <id>` を入れておく方法 | 形式上は通る（`q` の検証は長さと制御文字だけで、`/` で始まる文を拒まない）が、採らない。理由は下の 1.3 |
| 3 | Codex app のディープリンク | **`codex://threads/<thread-id>` で既存のスレッドを開ける**（公式）。Codex app で始めたセッション（`originator = Codex Desktop`）の ID はスレッド ID と同じなので、そのまま開ける。CLI で始めたセッションがアプリに出るかは未確認 |
| 4 | ターミナルで resume コマンドを入力済みにする | **Ghostty: できる**（1.3 の AppleScript の `new window with configuration {initial working directory, initial input}`）。改行を付けなければ実行されない。**Warp・Terminal.app: できない**（開いてクリップボードにコピーする） |
| 5 | 実行中のセッション | 許可待ち・質問への返答の多くは、セッションがまだ元のターミナルで動いている。新しく再開すると同じセッションを2か所で開くことになるので、**動いているセッションは、そのプロセスを持つアプリを前面に出す**（Ghostty なら cwd が一致する端末にフォーカス） |

## 1. Claude Code

### 1.1 URL スキームの登録

`~/Applications/Claude Code URL Handler.app` の `Info.plist`:

- `CFBundleIdentifier`: `com.anthropic.claude-code-url-handler`、`LSBackgroundOnly`: true
- `CFBundleURLTypes`: `Claude Code Deep Link` / スキーム `claude-cli`
- 実行ファイルは `claude` 本体へのシンボリックリンク。対話セッションで最初にプロンプトを送ったときに自動で登録される（設定 `disableDeepLinkRegistration: "disable"` で止められる）

### 1.2 受け付けるもの（公式ドキュメント「Launch sessions from links」と本体の検証処理）

| 形 | 内容 |
|---|---|
| `claude-cli://open` | 新しいターミナルのウインドウで Claude Code を起動する |
| `?q=<文>` | 入力欄に入れる（送らない。5,000 文字まで。入力欄の下に `Prompt from an external link` の警告が出る） |
| `?cwd=<絶対パス>` | 作業ディレクトリ（`..`・UNC・制御文字は拒否） |
| `?repo=<owner/name>` | 過去に `claude` を起動したことのあるクローンへ解決する |
| `claude-cli://install-plugin?...` | プラグインのインストール（今回は関係ない） |

`--resume` や session ID に当たる引数は無い。開くターミナルは「最後に対話セッションを使ったターミナル」（iTerm2・Ghostty・kitty・Alacritty・WezTerm・Terminal.app。Warp は対象外）で、dayline の設定では選べない。

### 1.3 `q=/resume <id>` を採らない理由

- 余分な `claude` を1つ起動してから中で切り替えることになり、入力欄の下に「外部リンクからのプロンプト」の警告が出る。⏎ が要る点は 4 の Ghostty と同じで、得るものが無い
- 既定以外の設定ディレクトリ（`CLAUDE_CONFIG_DIR`）のセッションは、URL から起動した `claude` から見えない
- 開くターミナルを dayline の設定（既定 Ghostty）で選べない

### 1.4 Claude Desktop

`/Applications/Claude.app` は `claude://` を登録しているが、Code のセッションを ID で開く形は公開されていない。`entrypoint = claude-desktop` のセッションも `~/.claude/projects` に記録され、`claude --resume <id>` で再開できるので、CLI と同じ扱いにする。

## 2. Codex

- Codex app は `codex://` を登録している（この Mac では `/Applications/ChatGPT.app`、`CFBundleIdentifier = com.openai.codex`。公式の「Commands」のページ）
- `codex://threads/<thread-id>`: 既存のローカルのスレッドを開く。`codex://threads/new`・`codex://new?prompt=&path=` は新しいスレッド
- セッションの `originator`（dayline の `ai_session.entrypoint`）が `Codex Desktop` のものはアプリで始めたスレッドなので、`codex://threads/<external_id>` で開く。アプリが無い・`open` が失敗したら CLI と同じ道（ターミナルで `codex resume <id>`）へ落とす
- CLI（`codex-tui`）で始めたセッションは、`codex resume <id>` をターミナルで入力済みにする。アプリで開けるかは未確認なので、既定にも `o` のメニューにも出さない

## 3. ターミナルで resume コマンドを入力済みにする

| ターミナル | 方法 | 入力済みにできるか |
|---|---|---|
| Ghostty 1.3 | AppleScript: `new surface configuration` に `initial working directory` と `initial input` を入れて `new window with configuration`（`Ghostty.sdef`）。設定 `input` と同じく、改行を付けなければ実行しない | できる |
| Ghostty（AppleScript が使えないとき） | `open -a Ghostty <dir>` で新しいウインドウ。`open -na Ghostty --args --working-directory= --input=` は別のプロセス（Dock のアイコンが2つ）になるので採らない | できない（コピー） |
| Warp | `open -a Warp <dir>`。URL スキームとローンチ設定は「実行する」ものだけで、入力済みにする方法が無い | できない（コピー） |
| iTerm2 | AppleScript の `write text … newline NO` で可能だが、この Mac に無く確かめられないので Phase 0 では `open -a` とコピー | （コピー） |
| Terminal.app | `do script` は実行してしまう | できない（コピー） |

- AppleScript は「オートメーション」の許可（TCC）が要る。デーモン（`daylined`）が初めて Ghostty を操作するときに macOS の確認ダイアログが出る。確認の間、Apple Event は待たされる（この調査でも、許可の無い端末から送った Apple Event は約2分でタイムアウトした: `-1712`）。デーモンは **5秒で打ち切って** `open -a Ghostty <dir>` とコピーへ落とし、許可された後は入力済みになる
- 入力するコマンドには改行・制御文字を入れない（入れると実行されてしまう）。引数は `osascript` の `argv` で渡し、スクリプトの文字列に埋め込まない

## 4. 動いているセッションへ戻る

- Claude Code はセッションごとに `~/.claude/sessions/<pid>.json` を書き、dayline は5秒ごとに `ai_session.live_status`（busy / idle / gone）と `live_pid` を更新している（M1）
- live なら、`ps -o ppid=,comm=` で親プロセスをたどり、最初に見つかった `.app`（入れ子の Helper ではなく外側の `.app`）を前面に出す（`open -a <その .app>`）。この Mac の例: `claude` → `zsh` → `login` → `…/<ターミナルのアプリ>.app/Contents/Frameworks/<…> Helper.app/…` → 外側の `.app`
- それが Ghostty なら、AppleScript で `working directory` がセッションの cwd と一致する端末を探して `focus` する（見つからなければアプリを前面に出すだけ）
- `.app` が見つからない（tmux の中など）ときは、設定のターミナルを前面に出すだけにし、新しく再開しない
- PID の再利用に備え、`live_checked_at` が2分以内で、そのプロセスの `comm` が `claude` を含むときだけ live とみなす

## 5. 差分ツール・エディタ

| アプリ | 開き方 |
|---|---|
| GitHub Desktop | 同梱の CLI（`github`）と同じく `open -n <GitHub Desktop.app> --args --cli-open=<dir>`（Electron の単一インスタンスが既存のウインドウへ渡す） |
| Fork・Tower | `open -a <app> <dir>` |
| Zed・Cursor・VS Code・Sublime Text | `open -a <app> <dir>` |

実機で開いて確かめたのは Ghostty の AppleScript（上の許可の挙動）だけ。その他はオーナーの作業を邪魔しないよう起動していない（[docs/dev/open.md](../dev/open.md) の確認手順で、オーナーが1回ずつ確かめる）。
