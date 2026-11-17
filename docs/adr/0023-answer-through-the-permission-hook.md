# ADR 0023: hook で答える: 許可と選択肢の問いは Claude Code の PermissionRequest の hook で返す

- ステータス: Accepted（D-364。2026-11-17）
- 日付: 2026-11-17
- Amends: [ADR 0019](0019-answer-from-turnlane.md) の Decision 1（届け方）と Decision 7（確認が取れないときに前に出す）。Claude Code の許可待ちと AskUserQuestion に限る

## Context

- Turnlane から答える（ADR 0019）は、答えを端末のタブに文字として打つ。Claude Agent SDK の上のアプリ（T3 Code など）は端末を持たないので、許可も選択肢の問いも Turnlane から答えられなかった。文字を送る口の無い端末（Warp・Kitty など。tmux の外）も同じ。
- Claude Code の hooks には、許可の確認が出るときに動く `PermissionRequest` がある。hook が標準出力に判断（`hookSpecificOutput.decision`）を出すと、Claude Code はそれを使う。次のことを Claude Code 2.1.323・2.1.326（対話の CLI）と Agent SDK 0.3.326 で確かめた:
  - PermissionRequest の hook は、本体の確認（端末のダイアログ、SDK のアプリの `canUseTool`）と**並んで**動く。hook が待っている間も本体の確認は出ていて使え、先に答えた方が採用される。何も出さずに終われば本体の確認はそのまま残る。端末には「hook が動いている」行も、ダイアログが出るまでの遅れも見えなかった。
  - AskUserQuestion のダイアログにも PermissionRequest が出る。`allow` と `updatedInput`（元の `questions` に `answers: { "<問いの文>": "<選んだ名前>" }` を足したもの）を返すと、その答えが採用される。問いが 2 つ以上・複数選択（名前をカンマと空白でつなぐ）・選択肢に無い自由な文も、この形で採用された（CLI 2.1.326）。
  - PreToolUse の hook は使えない: 終わるまで本体の確認が出ない（CLI）・`canUseTool` が呼ばれない（SDK）。Turnlane を見ていない人が止まる。
  - 負けた hook には知らせが来ず、動き続ける。遅れて出した判断は無視される。人が端末で「いいえ」・Esc を選んだとき、Claude Code が終わったとき、hook の `timeout` が来たときは SIGTERM を受ける。`timeout`（8 秒で試した）が来ても本体の確認は残り、そのまま答えられた。`timeout: 86400` も受け付けた。
  - hook の入力に tool_use の ID は無い（`session_id`・`agent_id`・`tool_name`・`tool_input`・`permission_mode` など）。同じセッションの同じエージェントの確認は 1 つずつ出る（前が閉じてから次の hook が動く）。並んだサブエージェントの確認は同時に開く（`agent_id` が違う）。
  - hook のプロセスの親は Claude Code のプロセス。環境変数 `CLAUDE_CODE_ENTRYPOINT` が届く。
- SDK のアプリで hook が動くには、そのアプリがユーザー設定（`settingSources` に `user`）を読み込んでいる必要がある。T3 Code の実機では確かめていない。

## Decision

1. **PermissionRequest に 2 つ目のハンドラを入れる**: `turnlane hooks install` は Claude Code の PermissionRequest の Turnlane のグループに、今までの spool のハンドラ（async）に続けて `turnlane hook --tool claude_code --answer --managed-by turnlane`（async にしない。`timeout` は 86,400 秒）を入れる。ほかのイベントと Codex は変えない。`turnlane uninstall`（`hooks uninstall`・`uninstall --all`）はグループごと外す。入れた後に足したハンドラが無い設定は `turnlane hooks status` で `outdated`、設定の取り込み元の行に「hooks の更新があります（turnlane hooks install）」と出す（入れ直しは人が行う。自動では書き換えない）。
2. **hook はデーモンに待つかを聞き、待つなら答えを long-poll で受け取る**（`POST /api/hook-waits`・`GET /api/hook-waits/:id/result`。m2-api 42 章）。次のときは何も出さずにすぐ終わり、本体の確認を遅らせも変えもしない: PermissionRequest でない、委任の子・プログラム経由（`CLAUDE_CODE_ENTRYPOINT` が `sdk-*`、取り込んだセッションが core の `isProgramSession`）、デーモンに届かない・トークンが無い、設定「Turnlane から答える」（`turn.answer`）がオフ、`bypassPermissions` の `AskUserQuestion` 以外のツール（許可の確認が出ない。`AskUserQuestion` はどのモードでも人に聞き、Claude Code はこのモードでも PermissionRequest を出すので待つ。実際に動いた `AskUserQuestion` の PermissionRequest はいつも答えられる。2026-11-17 に直した）。
3. **待ちを閉じたら hook も終わる**: デーモンは hook の待ちをメモリにだけ持ち、次のときに取り下げる（hook は何も出さずに終わる）: 同じセッション・同じエージェントの次の待ちが開いた、そのセッションの SessionEnd、本体の待ちの後の UserPromptSubmit・Stop・StopFailure、カードに一度見えた待ちが閉じた（記録が進んだ・許可のタスクが閉じた）、開いて 60 秒たってもカードに一度も現れない、hook から 90 秒聞かれない。hook は親（Claude Code）が居なくなった（親が変わった・`kill(pid, 0)` が失敗）・シグナルを受けた・デーモンに 60 秒届かないときに、取り消して終わる。取り下げは「答えない」向きにしか働かない（本体の確認は残る）ので、迷ったら取り下げる。
4. **送るのは押したものだけ**（ADR 0019 の Decision 2 のまま）: 許可待ちの「許可する」は、その 1 回だけの `allow`（`updatedInput` も今後の許可も付けない）。拒否は Turnlane から送らない（「開いて決める」のまま）。AskUserQuestion は問いごとに選択肢を選び（単一選択は 1 つ、複数選択は 1 つ以上）、選択肢に無い答えは「自分で書く」に書いて、「送る」を押したときだけ返す。選んだだけでは何も送らない。
5. **届け先の決め方**: カードの待ち（`derive.openWaitOf` が許可待ち・回答待ち）と同じセッション（と、許可待ちなら PermissionRequest のツールの名前）の hook が**ちょうど 1 つ**待っていれば、端末に関係なく hook に返す（`via: "hook"`、届け先の言葉は `Claude Code · hook`）。決まらない（待っていない・並んだサブエージェントで同じツールの待ちが 2 つ）ときは、今までどおり端末に打つ・送れない理由を言う。hook は受け取った答えを自分の入力と照らし（ツールの種類、問いの数、番号の範囲、単一選択に 1 つ）、合わなければ何も出さない。
6. **確認と前に出す**: hook に渡した後は端末のときと同じく 3 秒以内に記録が進んだかを見る。確かめられなくても前に出さない（届け先は端末のタブではなく、SDK のアプリでは前に出す先が無い。同じメッセージの 2 つ目のツールの許可が残っていると、記録の上では待ちが開いたままに見える）。ADR 0019 の Decision 7 は端末に打ったときだけに限る。
7. **保存しない**（ADR 0005・0018・0019 の Decision 4 のまま）: hook がデーモンに送るのは `session_id`・`agent_id`・ツールの名前・権限のモード・`CLAUDE_CODE_ENTRYPOINT` だけで、ツールの入力（コマンド・問いの文）は送らない。デーモンは選択肢の番号（と自由な文）を返し、hook が自分の入力から名前に直す。待ちと答えはデーモンのメモリにだけあり、答えは hook に渡したら捨てる。DB・spool・ログ・SSE に入れない（ログは `hook_wait.closed` の理由と、`answer.sent` の届け先の種類・許可か・問いの数だけ）。問いの形（文・複数選択か・選択肢の名前）は「答える」を開いた瞬間に記録から読む（ADR 0019 の Decision 4 と同じ。設定「行に中身を出す」がオフなら読まないので、選べない）。番兵のテストがこの経路も通る。
8. **やらない**: Codex（hooks の形が違う）、PreToolUse、今後も許可・拒否、自動で答えること、hook の入力から問いを読むこと（記録に問いが無いときは今までどおり「開いて答える」）。

## Consequences

- T3 Code など Agent SDK のアプリのセッションでも、hooks を入れていてアプリがユーザー設定を読み込んでいれば、許可と選択肢の問いに Turnlane から答えられる。自由な文の返答待ち（AI の問い）と「開く」は今までどおり届かない。T3 Code の実機は確かめていない。
- 端末のセッションでも、hook が待っていれば端末に打たずに返す（端末の種類・tmux によらない）。打った文字が端末のどこに入るかを気にしなくてよい。
- 今までの利用者は `turnlane hooks install` で入れ直すまで、今までどおり端末に打つだけ。
- hook の `timeout`（24 時間）を過ぎた確認は、Turnlane からは答えられない（本体の確認で答える）。デーモンを再起動すると待っていた hook は終わり、それより前に開いた確認は Turnlane からは答えられない。
- hook のプロセスは確認 1 つにつき 1 つ、答えが出るか取り下げられるまで残る（多くても `HOOK_WAIT_MAX` = 64 個。超えたら古いものから取り下げる）。spool のハンドラの起動時間の目標（50ms。ADR 0007・0009）はこのハンドラには当てない（待つのが仕事）。すぐ終わる経路はトークンを読み、ローカルに 1 回聞くだけ。
- 「先に答えた方が勝つ」「PreToolUse の間は確認が出ない」は Claude Code 2.1.3xx で見たふるまいで、公式の文書は SDK の側にしか無い。版が上がって変わったら、この決定を見直す。
