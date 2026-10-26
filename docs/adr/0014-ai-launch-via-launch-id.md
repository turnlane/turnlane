# ADR 0014: タスクから AI に頼むときは、端末に起動 ID だけを渡し、worktree は dayline が作ったものだけを片付ける

- ステータス: Accepted
- 日付: 2026-10-08
- 関係: PO 決定 D-107・D-109・D-110。設計の詳細は [m2-api.md](../spec/m2-api.md) 27章、[ux-mvp.md](../spec/ux-mvp.md) 4.16、[phase0-plan.md](../spec/phase0-plan.md) 2.3 の DDL（`ai_launch`・`ai_template`）。会話本文を持たない方針は [ADR 0005](./0005-no-ai-session-body-storage-or-transmission.md)（2026-10-08 の追記）、外部へ送らない方針は [ADR 0008](./0008-mit-no-server-open-source.md)、「タスクから開く」は D-059

## Context

- タスクから Claude Code / Codex に「今すぐ頼む」（D-107）。利用者のいつもの端末の新しいタブで、対話モードで起動し、許可や質問には利用者が端末で答える（裏で黙って動かさない。許可の自動承認はしない。D-109）。
- 題名・メモ・指示には改行や引用符が入る。AppleScript → 端末 → ログインシェルの3段の解釈を通して安全に渡すのは難しい（今の再開のコマンドも制御文字を含むと拒否している）。
- 起動したセッションを、取り込み（ADR 0004）が後から見つけたセッションと確実に結び付けたい（待てば自分の番、終われば「AI 完了 · 確認」）。
- 並行して頼むと同じ作業ツリーで衝突する。worktree を既定にしたい（D-110 (5)）が、利用者のリポジトリを壊したり、取り込まれていない変更を消したりしてはいけない。

## Decision

1. **端末には起動 ID だけを渡す**: デーモンは依頼ごとにランダム 128bit の起動 ID（16進）を作り、端末に `'<dl の絶対パス>' ai run <起動 ID>` だけを入力して実行させる。`dl ai run` はデーモンから起動 ID で1回だけ（2分以内）cwd と起動の引数を受け取り、ツールを**引数の配列で**起動する。題名・メモ・指示はシェルを通らない。受け取りは Bearer（CLI）だけで、ブラウザのクッキーからは受け取れない。
2. **プロンプトは保存しない**: 依頼の型（`{title}` `{notes}` `{repo}` `{branch}`）に差し込んだプロンプトと指示は、受け取りまでデーモンのメモリにだけ置き、DB・ログには書かない。`ai_launch` に残すのはタスク・ツール・リポジトリ・worktree・ブランチ・依頼の型・状態・紐づいたセッション・テストの成否と時刻だけ。
3. **端末の開き方**: Ghostty は AppleScript の `new tab`（ウインドウが無ければ `new window`）で `initial input` の末尾に改行を付けて実行する。iTerm2 は `create tab` と `write text`、Terminal は `do script`（新しいウインドウ）。それ以外の端末は cwd で開いてコマンドをコピーする。オートメーションの許可を拒否されたら開いてコピー、それも無理ならコピーだけ。
4. **紐づけ**: Claude Code は dayline が作った UUID を `--session-id` で渡し、取り込んだセッションの ID と照合する（hooks 不要）。Codex は先に ID を決められないので、cwd（worktree なら依頼ごとに一意）と受け取りの時刻（10秒前〜3分後）で探す。worktree を使わず候補が複数なら紐づけを保留し（unlinked）、詳細パネルで利用者に選ばせる。受け取りから5分見つからなくても unlinked。子プロセスには環境変数 `DAYLINE_LAUNCH_ID` を渡す（hooks での紐づけは将来の段。今は使わない）。
5. **worktree**: git のリポジトリでは既定で `git worktree add <repo の親>/<repo>-wt/<tl/題名の slug-4桁 の / を -> -b <ブランチ> <origin/HEAD の先（無ければ HEAD）>` を作る（置き場所の親は設定 `ai.worktree_dir` で変えられる）。追跡外のファイルはプロジェクトの設定に書いた glob だけをコピーする。
6. **片付け**: 頼んだタスクを完了にしたとき、dayline が作った（`ai_launch` に記録のある）worktree のうち、作業ツリーが clean で、ブランチが base に含まれる・base からのコミットが無い・PR がマージ／クローズ済みのどれかを満たすものだけ `git worktree remove` と `git branch -d` で消す。満たさないものは消さずに残し、詳細パネルで確認してから強制（`--force`・`-D`）で消す。git の書き込みはこの2つ（add と remove / branch）だけ。
7. **確認支援**（D-109 の無料）: 差分の量は git（worktree は作業ツリーまで、そうでなければブランチの先端まで）、CI は利用者の `gh`（checks の名前と状態だけ。ログは読まない）、テストはプロジェクトに書いたコマンドを**利用者が押したときだけ**ログインシェルで実行する（10分で止める。出力の最後の50行はメモリにだけ持ち、DB には成否と時刻だけ）。AI の出力からコマンドを決めない。

## Consequences

- 端末のオートメーションの許可が一度だけ出る。拒否されても依頼はコピーで続けられる。
- `dl` の絶対パスに依存する。デーモンは自分と同じ場所（`~/.local/bin`）の `dl` を使い、無ければ PATH の `dl`。
- Codex の紐づけは、worktree を使わずに同じフォルダで同時に起動すると曖昧になる。保留して選ばせる。
- テストのコマンドは利用者の書いた文字列をシェルで実行する。ボタンを押したときだけで、自動では走らせない（自動での実行は D-110 (10) の別の段）。
- 実装計画の確認（S-B1・S-B2）のうち、実際の端末を開く確認と、Codex の hooks が親の環境変数を引き継ぐかは、オーナーの画面とアカウントを使うので実装の段では行っていない（AppleScript は `osacompile` で構文と辞書の解決だけを確かめた）。入れ替えの後にオーナーが確かめる。

## 追記（2026-10-08、D-122）: Claude のアカウントと Orca

- **Claude のアカウント**: 利用者は Claude Code の設定ディレクトリ（`CLAUDE_CONFIG_DIR`）を切り替えて複数のアカウントを使い分けることがあり、`~/.claude` がログインしていないこともある。依頼のときに、取り込み（ADR 0004）が見つけた `claude_code` の設定ディレクトリ（`~/.claude`・`~/.claude-*`・`$CLAUDE_CONFIG_DIR`。取り込みを止めたものを除く）から1つを選ぶ。選択肢が2つ以上のときだけ選ばせる。名前・選択肢から外す・プロジェクトごとの既定は端末ごとの設定（`ai.claude_accounts`・`ai.claude_account_by_project`）に置き、DB のスキーマは変えない
- **渡し方**: 端末に入力するのは今までどおり `dl ai run <起動 ID>` だけ。選んだ設定ディレクトリは受け取り（claim）の `env` の `CLAUDE_CONFIG_DIR` で `dl ai run` に渡し、`dl ai run` がそれを足した環境でツールを起動する（既存のセッションを開くときの resume コマンドと同じく、`~/.claude` には付けない）。`~/.claude` を選んだときは、端末のシェルの `CLAUDE_CONFIG_DIR` を消して既定に戻す（`unsetEnv`。選択肢が1つだけなら環境に触れない）。シェルのエイリアスや対話シェル（`zsh -ic`）は使わない
- **紐づけと取り込み**: Claude Code は `CLAUDE_CONFIG_DIR/projects/` にトランスクリプトを書くので、選んだアカウントの取り込み元で見つかり、`--session-id` で今までどおり紐づく（取り込み元をまたいで `external_id` で探す）
- **ログイン状態は判定しない**: 確かめるには認証のファイルを読む必要があるので読まない（ADR 0005・CLAUDE.md の原則 4）。ログインしていないアカウントを選べば、端末の claude がログインを求める
- **Codex**（`CODEX_HOME`）は対象外（今までどおり）
- **Orca**: AppleScript の辞書を持たないので、アプリに同梱の CLI を `ELECTRON_RUN_AS_NODE=1 <Orca.app>/Contents/MacOS/Orca <Orca.app>/Contents/Resources/app.asar.unpacked/out/cli/index.js` で直接起動する（`/usr/local/bin/orca` のシンボリックリンクを読めない環境があり、PATH にも依存しないため）。`orca open --json`（起動して待つ。起動していれば前面に出すだけ）の後に `orca terminal create --worktree path:<作業フォルダ> --command "<dl> ai run <起動 ID>" --title <タスクの題名> --focus --json`。引数の配列で渡し、シェルを通さない
- **Orca の登録**: `--worktree path:` は Orca に登録したリポジトリの worktree のルートだけを解決する（Orca の外で作った `git worktree` も、そのリポジトリが登録されていれば解決する。登録していないリポジトリ・サブディレクトリは selector_not_found）。失敗したら `orca repo add --path <リポジトリ> --json` で登録してから作り直す（利用者が Orca を端末に選んで頼んだときだけ。Orca のサイドバーにリポジトリが増える）。worktree は dayline が作り、Orca の worktree 作成は使わない。それも失敗したら Orca を前面に出してコマンドをコピー（フォルダは渡さない）、最後はコピーだけ
- **Orca で既存のセッションを開く**（D-059）: Orca の CLI は入力済みで止める手段が無いので、Ghostty と違い `cd <cwd> && <resume コマンド>` を実行まで進める
- 実際の Orca に端末を作る確認と、実際のアカウントで claude を起動する確認は、オーナーの画面とアカウントを使うので実装の段では行っていない（引数の組み立てはテストで、`CLAUDE_CONFIG_DIR` の受け渡しは偽の claude で確かめた）。入れ替えの後にオーナーが確かめる

## 追記（2026-10-17、D-214 (4)）: 動いているセッションを開くときはそのタブに着地する

- 「開く」で動いているセッションを前に出すとき（D-060）、アプリを前に出すだけでなく、そのセッションの端末のタブ（ペイン）を選ぶ。**探す順は tty → tmux のペイン → cwd → アプリ**。セッションの PID から `ps` で tty と祖先の `.app` をたどり、tmux の中なら `tmux list-panes -a` で tty の一致するペインと、表示しているクライアントの端末を引く（詳細は [desktop-shell.md](../spec/desktop-shell.md) 4.4）
- iTerm2・Terminal は AppleScript の tty（`tty of session` / `tty of tab`）で選ぶ。Ghostty は辞書に tty が無いので、tty に OSC 7 で一時フォルダの目印を書いて `working directory` で探し、すぐセッションの cwd に戻す（cctop の方法。MIT）。tmux は `select-window` / `select-pane` の後にクライアントの端末を選ぶ。Orca・Warp などはアプリを前に出すだけ
- 利用者の tty に書くのは Ghostty の目印の OSC 7（画面に出ない制御列）だけで、端末の作業フォルダの報告を一瞬だけ差し替えて戻す。戻す先はセッションの cwd（元の報告の値は読めない）。cwd の一致は、同じ cwd のタブが複数あると1つ目になるので、そのときは知らせでそう言う
- 結果は `OpenResult.landing` と `message` で返し、知らせと行の「対応中」の後ろに出す
- 実際の iTerm2・Terminal・Ghostty・Orca での確認は、オーナーの画面と端末の許可を使うので実装の段では行っていない（組み立ては偽の `ps`・tmux の出力でテストし、tmux の手順は別のソケットの tmux サーバで、AppleScript は `osacompile` で Ghostty・Terminal の辞書の解決を確かめた。iTerm2 は入っていないので未確認）
