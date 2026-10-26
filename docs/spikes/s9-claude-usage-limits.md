# S9: Claude の利用枠を statusLine の受け口で読めるか

- 状態: **実施済み**（2026-10-12、Claude Code 2.1.296）。受け口で `rate_limits` を読め、statusLine の無い利用者でも画面は変わらなかった
- 関連: [m2-api.md](../spec/m2-api.md) 28 章（`limits.claude(account)`・28.1 利用枠の受け口）、ADR 0005（会話の本文を扱わない）、ADR 0015（拡張点）
- 目的: 本体が起動する Claude Code のセッションにだけ `--settings` で statusLine の受け口（`turnlane statusline`）を渡し、`rate_limits`（5時間・7日の使用率とリセットの時刻）を読む作りが、本物の Claude Code で動くかを確かめる

## 結果を待たずに入れたもの（仮置き）

- 受け口・デーモンの記録・`limits.claude(account)` は入れた。値が届かないとき（Pro・Max の契約でない、最初の応答の前、`--settings` が効かない）は `limits.claude` が null を返し、拡張は自分の予備の扱い（「止まったら一定時間待つ」）に落とす
- 利用者の statusLine の探し方は、公式ドキュメントの設定の優先順（組織の管理 > コマンドライン > プロジェクトのローカル > プロジェクト > 利用者）から、コマンドラインより下の3つを順に見る。組織の管理の設定に statusLine があれば受け口は呼ばれない（値は届かない）
- 利用者が statusLine を設定していないとき、受け口は何も出さない。このとき Claude Code の画面の下が変わるか（空の行・キーのヒントが消える）は下の (e) で確かめる

## 確かめること

| | 内容 | 方法 |
|---|---|---|
| (a) | `--settings` の statusLine が利用者の設定より優先され、アカウント（`CLAUDE_CONFIG_DIR`）ごとに `rate_limits` が届くか | スクリプト（受け口の呼ばれた回数、届いた枠、デーモンが記録した値） |
| (b) | 利用者の statusLine のコマンドに入力を渡して、その出力を返せるか（表示が変わらないか） | スクリプト（利用者のコマンドの終了コード・時間）と、利用者の目視 |
| (c) | 利用枠に当たったときの StopFailure の `error_type` | 公式ドキュメント（下）。当たるまで待てないので、実際の値は夜の記録で確かめ直す |
| (d) | CLI に、利用枠のリセット後に自分で続ける機能があるか | 公式ドキュメント（下）と `claude --help` のオプションの名前 |
| (e) | statusLine を設定していない利用者で、受け口を付けると画面が変わるか | 利用者の目視（statusLine の無いアカウントがあれば） |

## 手順

前提: 本体のリポジトリ（または作業用の worktree）で `bun install` 済み。利用者の常駐デーモン（7317）・データ・`settings.json` には書き込まない（一時ディレクトリに別のデーモンを 27496 番で立てる）。トークン・認証のファイルは読まない。会話の中身は記録しない。

0. 手順の確かめ（Claude Code を起動しない）

   ```sh
   bun scripts/spike-s9-claude-usage-limits.ts --dry-run
   ```

   最後の JSON に `"sentOk": 1` と `"recorded": { … }` が出れば準備はできている（`out/s9-results.jsonl` に dryRun の行が足される）

1. アカウントごとに1回ずつ流す（既定の `~/.claude` と、ほかに使っている設定ディレクトリがあればそれも）

   ```sh
   bun scripts/spike-s9-claude-usage-limits.ts                              # 既定（~/.claude。CLAUDE_CONFIG_DIR を設定していればそれ）
   bun scripts/spike-s9-claude-usage-limits.ts --account ~/.claude-<名前>    # ほかのアカウント
   ```

   - この端末で Claude Code が対話のまま開き、読み取りのみ（`--permission-mode plan`）の短い指示「OK とだけ返して」を1つ送る
   - 応答が出たら、画面の下の statusLine がいつもどおりか見る。10 秒ほど待ってから `/exit` で閉じる
   - 閉じると2つ聞かれる（いつもどおりだったか、ほかに気づいたこと）。会話の中身は書かない
   - 初めてのフォルダなら Claude Code の「このフォルダを信頼するか」が出る（リポジトリのフォルダなので信頼してよい）
   - Turnlane の hooks を入れていれば、常駐の Turnlane にこの短いセッションが出る（題名は送った指示から。気になれば消してよい）

2. 結果の JSON（画面の最後と `out/s9-results.jsonl`）を PO に渡す。中身は版・アカウントのディレクトリ名・受け口の回数・届いた枠の有無・リセットまでの時間（時間単位）・受け口の時間・`--help` のオプション名・目視の答えだけで、使用率・パス・会話は入らない

## 見る点

- `calls` が 1 以上: `--settings` の statusLine が効いて受け口が呼ばれた（a の前半）。0 なら組織の管理の設定か、`--settings` が効いていない
- `callsWithFiveHour`・`callsWithSevenDay` が 1 以上、`recorded` に時間が入る: `rate_limits` が届き、アカウントごとに記録された（a の後半）。0 なら契約（Pro・Max でない・API キー）か、版の違い
- `userStatusLine: true` で `ownerSaw: "y"`、`userExitCodes` が普段の終了コード: 利用者の statusLine をそのまま返せた（b）
- `wrapperMsMedian`・`wrapperMsMax`: 受け口にかかった時間（利用者のコマンドの時間を含む）。Claude Code は 300ms ごとにまとめて呼び、前の呼び出しが終わっていなければ止める
- `autoResumeInHelp` と `resumeOptions`: (d)

## 公式ドキュメントで分かること（2026-10-11 に確認）

- statusLine（code.claude.com/docs/en/statusline）: 入力の `rate_limits.five_hour` / `seven_day` に `used_percentage`（0〜100）と `resets_at`（Unix 秒）。claude.ai の Pro・Max の契約か、利用上限のあるゲートウェイの下でだけ、セッションの最初の応答の後に届く。枠ごとに無いこともあり、`resets_at` を過ぎた枠は Claude Code が落とす。更新は 300ms でまとめ、実行中に次の更新が来たら実行中のスクリプトを止める。`refreshInterval` で一定間隔の更新も足せる。statusLine を設定すると、画面の下のキーのヒントの多くが出なくなる（e に関係）
- (c) StopFailure（code.claude.com/docs/en/hooks）: API のエラーでターンが終わったときに出る。`error_type` は `rate_limit`・`overloaded`・`authentication_failed`・`oauth_org_not_allowed`・`account_on_hold`・`billing_error`・`invalid_request`・`model_not_found`・`server_error`・`max_output_tokens`・`cloud_credential_error`・`unknown`。利用枠に当たったときは `rate_limit`（本体の `errorKindOf` はこれを `rate_limit` に、`*auth*` を `authentication`、`*billing*` を `billing`、`server_error` を `server_error`、ほかを `other` に丸める。`oauth_org_not_allowed`・`account_on_hold` は `other`）
- (d) 利用枠のリセット後に自分で続ける機能は、デスクトップアプリの Code タブにだけある（2026-08 の更新「Auto-continue when limits reset」。5時間の枠だけで、週の枠には出ない）。CLI のドキュメントには無い。CLI の `--continue`・`--resume` は人が前のセッションを開き直すもので、自動では続けない

## 結果

| アカウント | Claude Code | 受け口の回数 | 5時間 | 7日 | 記録 | 利用者の statusLine | 表示 | 受け口の時間（中央・最大） | メモ |
|---|---|---|---|---|---|---|---|---|---|
| A（statusLine なし） | 2.1.296 | 3 | 2 回届いた | 2 回届いた | 5時間・7日とも記録 | なし | いつもどおり | 4ms・16ms | |
| B（statusLine なし） | 2.1.296 | 2 | 1 回届いた | 1 回届いた | 5時間・7日とも記録 | なし | いつもどおり | 14ms・14ms | |
| 予行（dry-run、statusLine あり） | 2.1.296 | 1 | 1 | 1 | 記録 | あり（終了コード 0） | — | 17ms・17ms | Claude Code は起動しない |

- (c): 公式ドキュメントのとおり `rate_limit`（実際の値は夜の記録で確かめ直す）
- (d): CLI には無い（デスクトップアプリだけ）。`--help` の結果: `--resume`・`--continue`・`--from-pr`・`--print`・`--teleport`。自動で続けるオプションは無い（利用枠の戻りを待って続けるのは呼び出し側。拡張は `limits.claude` の `resetsAt` を見る）
- (e): statusLine を設定していない2つのアカウントで、受け口を付けても画面の下はいつもどおり（利用者の目視）。受け口は今のまま、本体が起動する Claude Code のセッションすべてに付ける
