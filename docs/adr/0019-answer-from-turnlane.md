# ADR 0019: Turnlane から答える: 答えは端末に文字として届ける。自動では送らない

- ステータス: Accepted（D-238。2026-10-20）
- 日付: 2026-10-20

## Context

- 自分の番の待ち（AI の問い・許可）は、Turnlane で「何を待っているか」まで分かるようになった（glance、D-207〜D-208、ADR 0005 の追記 2、ADR 0018）。答えるには「開く」（D-217）で端末のタブに移り、そこで打つ必要があった。
- 1 キーで答えられる問いは少ない。問いには文章で答える。端末を Turnlane に内蔵すると、端末の機能（スクロール・選択・設定）を作り直すことになり、セッションの持ち主も Turnlane になる。
- 端末のタブに文字を届ける口は端末ごとに違う。tmux（`send-keys`）・iTerm2（AppleScript の `write text`）・Orca（同梱の CLI の `terminal send`）にはあり、Ghostty・Warp・Kitty・Terminal には安全な口が無い（Terminal の `do script` はコマンドの実行）。

## Decision

1. **答えは端末に文字として届ける**: 答えはそのセッションの端末のタブ（ペイン）に、人が打ったのと同じ文字として送り、最後に Enter を 1 回送る。届け先は「開く」と同じ居場所（tty → tmux のペイン → 端末のアプリ）から決める。送った後、記録が進んだと確かめられたら Turnlane に留まり（知らせに「開く」を付ける）、確かめられなければそのタブを前に出す（「開く」と同じ経路。D-241）。端末は内蔵しない。
2. **自動では送らない**: 送るのは人が「送る」「許可する」を押したときだけ。Turnlane が答えを考えたり、待ちを見て勝手に送ったりはしない。許可待ちの「今後も許可」（Claude Code の 2）は Turnlane からは送らない（範囲が広がる判断は端末で人がする）。
3. **送れるかを確かめてから送る**: 送る前に、待ちがまだ開いているかを記録の末尾で確かめ、閉じていれば送らない（`409 wait_closed`）。送った後 3 秒以内に記録が進んだか（新しい自分の指示・許可の結果）を見て、確かめられなければそう言う。
4. **ADR 0005 / 0018 との関係**:
   - 問いの全文（2,000 字まで）は、「答える」の節を開いた瞬間に記録から読み、応答に入れるだけで保存しない（ADR 0005 の追記 2 と同じ。`Cache-Control: no-store`。ログ・SSE・MCP・通知に出さない）。ADR 0018 で保存するのは今までどおり問いの 2 文まで。
   - 答えの文は保存しない（DB・ログ・SSE に入れない。ログは `answer.sent` の文字数と届け先の種類だけ）。送った答えは記録に自分の指示として現れ、次の取り込みで ADR 0018 の規則（指示の 1 行目）で保存される。これで「Turnlane が答えを別に持つ」ことが無く、一貫する。
   - 外には送らない（ADR 0018 の 1）は変わらない。届け先は手元の端末だけ。
5. **Orca の端末を選ぶ材料**: `turnlane hook` は、hook のプロセスが受け継いだ環境変数 `ORCA_TERMINAL_HANDLE`（Orca が端末ごとに渡す不透明な ID）を、形を確かめて spool の `term` に残す（`hook_event.term_handle`）。会話の中身ではない。無ければ `orca terminal list` の worktree が cwd を含む端末が 1 つだけのときに限る（複数なら選ばない。別のタブに送らない）。list の画面の中身（preview）・題名は読まずに捨てる。
6. **答える対象は待ちそのもの**（D-240 の追記。2026-10-20）: 対象は「開いているフォローアップ（approve → resume_error → reply）→ 無ければセッションの待ち（needs_input の許可待ち・AskUserQuestion、your_turn で理由に問いを含むセッションの最後のターン）」の順で決める（core の `derive.openWaitOf` / `derive.sessionWaitOf`。状態とフォローアップの判定と同じ `sessionStatus`・`yourTurnCandidates` を使う）。返答タスクは在席中の問いでは猶予（`reply.delay_minutes`、既定 15 分。D-214 (3)）の後にしかできないので、フォローアップだけを見ると一番答えたい場面（端末の前にいる間）に口が無かった。猶予は「タスクに積んで知らせるか」の話のままで（返答タスクの行・通知・放置の数え方は変えない）、答える口は待ちが分かった瞬間に開く。web の「答える」・`a`・右クリック、wait・answer の API、送る直前の「まだ開いているか」の確かめは同じ判定を使う。フォローアップの無い待ちは、届け先・前に出すをカードで決め、対応中の印（フォローアップに付く）は付けない。PR の確認・マージは今までどおり対象にしない。
7. **確認が取れたら留まる**（D-241 の追記。2026-10-20）: 実機の初回（Orca）で、送った直後にタブを前に出したため Turnlane の知らせが後ろに回って見えなかった。Turnlane から答えるのは端末に行かないためなので、確かめられた（`confirmed`）ときはタブを前に出さない（`focus: null`。対応中の印も付かない）。見たければ知らせの「開く」。確かめられないときは端末そのものが証拠なので、今までどおり前に出す。送った後は、その待ちが閉じるまで節に「10:25 に送りました · 確認済み」（確かめられなければ「確認できません」）の 1 行を残す（web の状態だけ。保存しない）。

8. **ターミナル.app にも送る**（D-243 の追記。2026-10-20）: Context では Terminal を「安全な口が無い（`do script` はコマンドの実行）」として送れない端末にしていたが、これを改める。`do script "<文>" in <タブ>` は、タブを指定すると新しいシェルを開かずに、文と Return をそのタブに入れる（人が打ったのと同じ。動いているプログラムがあれば、そのプログラムの入力に入る）。Claude Code・Codex が動いているタブなら、その入力欄に入る。iTerm2 の `write text` と同じ扱いにする。理由: macOS 標準のターミナル.app を使い tmux を入れていない人には、手で始めたセッションにも「AI に頼む」のセッションにも「答える」が一度も効かなかった。
   - 届け先: 居場所の端末がターミナル.app なら、tty の一致するタブ（`tty of tab`）に送る（`via: "terminal"`）。見つからなければ `not_found`。文は AppleScript の引数（`item 2 of argv`）で渡し、スクリプトに埋め込まない（引用符・バックスラッシュのエスケープが要らない）。制御文字は除き、改行は 1 行に畳む（`do script` は改行ごとに Return になる）。許可する（`1`）も同じ経路。送る直前の「まだ待っているか」の確かめは他の端末と同じ。
   - 前に出す: 「開く」と同じく、tty の一致するタブを選びウインドウを前に出す（着地は `ターミナル · タブ`。日本語では macOS の表示名に合わせて「ターミナル」と書く）。
   - tmux の包み: `launch.tmux_wrap` の対象からターミナル.app を外す（tmux の無い Mac でも答えられる）。Ghostty・Warp・Kitty は今までどおり包む。
   - 初回は macOS がターミナル.app の操作（オートメーション）の許可を 1 回求める。
   - 実機の確認: ターミナル.app はオーナーの実機で確かめる。iTerm2 の送り方（`write text`）は実機では未検証（開発機に iTerm2 が無い）。

9. **Ghostty（1.3 以降）にも送る**（D-244 の追記。2026-10-20）: Context と Decision 8 では Ghostty を「入力を外から入れる口が無い」としていたが、それは 1.2 以前の話だった。Ghostty 1.3 の AppleScript（公式の文書 `ghostty.org/docs/features/applescript`、`.app` の `Ghostty.sdef`）には `input text "<文>" to <terminal>`（貼り付けと同じ扱い）と `send key "enter" to <terminal>` があり、動いているプログラムの入力に入る。Claude Code の利用者に Ghostty が多く、公開の見出しが「答える」なので、tmux 無しで送れるようにする。
   - 届け先: 居場所の端末が Ghostty（tmux の外）なら `via: "ghostty"`。Ghostty の terminal は `id` と `working directory` を持つが tty を持たないので、「開く」の着地と同じ目印で選ぶ（tty に OSC 7 で一時的な目印のフォルダを書き、`working directory` がその目印の端末を選んでから元の cwd に戻す。判定は `open/focus.ts` の `GHOSTTY_MARKED` を両方のスクリプトで使い、複製しない）。目印の端末が 1 つに決まらなければ（0 個・複数）送らない（`409 undeliverable`）。cwd の一致には落とさない（同じフォルダに複数のタブがあるとき、別のセッションへ送らないため）。tty・cwd が分からなければ `not_found`。
   - 送り方: 目印と文は AppleScript の引数で渡し、スクリプトに埋め込まない。`input text` の後に `send key "enter"`。改行・制御文字は残さず（貼り付けの外に出る ESC などを除く）、1 行に畳む。許可する（`1`）も同じ経路。送る直前の「まだ待っているか」の確かめは他の端末と同じ。
   - 使えない Ghostty: 設定 `macos-applescript = false` で AppleScript を切っている、または 1.3 より古いと分かれば `unsupported`（送れない端末）。判定は Apple Event を送らずに行う（`.app` の Info.plist の版と、同梱の CLI の `ghostty +show-config` の `macos-applescript` の行だけ。ほかの行は読み捨てる。1 分覚える。`open/ghostty.ts`）。判定できなければ送ってみて、応答しなければ（`-1743` の拒否・打ち切り以外の失敗）しばらく `unsupported` として扱う。
   - tmux の包み: `launch.tmux_wrap` の対象から Ghostty を外す。ただし AppleScript を切っている・1.3 より古いと分かったとき、また判定できない（版・設定が読めない）ときは包む（読めて 1.3 以上かつ AppleScript が有効なときだけ包まない）。Warp・Kitty は今までどおり包む。
   - 前に出す・表示: 「開く」と同じ（目印でタブを選ぶ）。届け先は `Ghostty · タブ`（行の短い形も、タブの番号が分からなければ `Ghostty · タブ`）。
   - 初回は macOS が Ghostty の操作（オートメーション）の許可を 1 回求める（「開く」の着地で許可済みならそのまま）。
   - 実機の確認: オーナーの実機（Ghostty 1.3.1）で確かめる。`input text` は貼り付けと同じ扱いなので、Claude Code の許可のダイアログで `1` が番号のキーとして効くかは実機で見る。

10. **最後の返答も同じ口で読む。保存しない**（Issue #8 の追記。2026-10-28）: AI の詳細パネルに「最後の返答」の節を足す。出すのは、選んだ AI 項目の最後のセッションの AI の最後の発言（完了・idle は最後の発言、動作中はその時点での最新の発言、自分の番は問いの文）。
   - 読み方は Decision 4 の問いの全文と同じ: パネルを開いた瞬間にデーモンがそのセッションの記録（Claude Code のトランスクリプト・Codex の rollout）の末尾を読み、応答に入れるだけ（`GET /api/work-items/:id/last-reply`、`Cache-Control: no-store`）。DB・ログ・SSE・MCP・通知に出さない。伏せ字は保存する行と同じ規則（ADR 0005 の 2026-10-16 の追記）を切る前に通し、2,000 字で切る（`truncated`。画面は「続きは端末で」と「開く」）。設定「行に中身を出す」（`turn.show_detail`）がオフなら記録を読まない。
   - 「最後」の境界: 取り込みのパーサと同じターン（Claude Code は人の指示・task-notification の user レコード、Codex は `task_started`）の中で、最後のツール呼び出しより後の文のまとまり。ツールの結果を待っている間（文がツール呼び出しの前にしか無い）はその前の文のまとまり。まとまりの中の文（Claude Code は 1 つのメッセージの text を別々のレコードに書く）は改行 2 つでつなぐ。thinking・Reasoning・ツールの入出力は含めない。ターンに文がまだ無ければ出さない（前のターンの文は出さない）。判定は collectors の `claudeLastReply` / `codexLastReply`、伏せ字と切り詰めは core の `lastReplyOf`。
   - 記録が無い・消えている（Claude Code は既定 30 日で消す）ときは `gone`（「記録が消えていて読めません」）。保存しないので、消えた後は読めない。ADR 0018 の保存の範囲は広げない（AI の発言の本文は保存しないもののまま）。
   - ボードの行・自分の番の帯・MCP（`get_ai_work` など）・通知には出さない。
   - Codex: 問いの全文・待ちの中身（Decision 4、ADR 0018 の Consequences）は今までどおり読まないが、最後の返答は Codex の rollout も読む（`item_completed` の AgentMessage、無ければ `response_item` の assistant の message、それも無ければ `task_complete` の `last_agent_message`）。
   - 文は Markdown として出す（web の小さな描画器。HTML のタグは解釈せず文字のまま、リンクは http(s) だけ、画像は読み込まない）。「答える」の問いの全文も同じ描画器で出す。

- 送れる端末: tmux の中（外側の端末に関係なく）・iTerm2・Terminal（ターミナル.app。Decision 8）・Ghostty（1.3 以降。Decision 9）・Orca。送れない端末（Warp・Kitty、AppleScript を切っている・古い Ghostty など）は「この端末には送れません」と「開く」だけ。Turnlane が起動するセッション（AI に頼む・時刻起動）は、送れない端末では tmux の新しいセッションの中で起動する（設定 `launch.tmux_wrap`、既定オン。tmux があるときだけ）。
- 複数行の答え: tmux の Claude Code は改行を LF（Ctrl+J。Claude Code の文書にある改行の入れ方）のまま送る。ほかは 1 行に畳む（改行を空白に）。改行を Enter にしない。
- Claude Code・Codex の TUI の細部（許可のダイアログの番号キー、AskUserQuestion の番号、Codex の承認の画面）は公式の文書に書かれていない部分があり、実機で確かめる。Codex の許可待ちには「許可する」を出さない。
- 設定「Turnlane から答える」（`turn.answer`、既定オン）でオフにでき、オフなら「答える」を出さず API も断る。
