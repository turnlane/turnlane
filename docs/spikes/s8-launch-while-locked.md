# S8: 画面のロック中に、時刻に合わせた起動で端末を開けるか

- 状態: **一部実施**（2026-10-11。画面のロックの Orca（raw・unattended）と Ghostty（raw）。スクリーンセーバー・ディスプレイのスリープと Terminal.app は未実施）。利用者の画面に端末のタブ・ウインドウが開くので、利用者が立ち会って流す。結果は下の「結果」の表に書く
- 関連: ADR 0014（起動 ID）、ADR 0015（拡張点）、[m2-api.md](../spec/m2-api.md) 28章（`launcher.launch` の `unattended`）
- 目的: 拡張が時刻・条件で AI を起動する（`ExtDeps.launcher.launch(input, trigger, { unattended: true })`）とき、人が Mac の前にいない状態（画面のロック・スクリーンセーバー・ディスプレイのスリープ）で、いつもの端末に新しいタブ・ウインドウが開き、`turnlane ai run <起動 ID>` が受け取り、Claude Code に `--session-id` が渡るかを確かめる。開けない端末があれば、その端末では「ロックが外れてから起動する」に倒す

## 結果を待たずに入れたもの（安全側）

- `launcher.launch(…, { unattended: true })` は、起動の前に画面のロック（`ioreg -n Root -d1 -a` の `CGSSessionScreenIsLocked`）を見て、ロック中なら worktree も起動の行も作らずに `{ outcome: "locked", reason: "screen_locked" }` を返す。呼び出し側はロックが外れてから同じ呼び出しをやり直す
- 端末を開けなかった（osascript・Orca の CLI が失敗した）ときは、コピーに落とさず、作った worktree・ブランチ・起動の行を片付けて `{ outcome: "locked", reason: "not_opened" }` を返す（人がいないので、コピーしても貼る人がいない）
- Orca は `--focus` を付けない（人のいないときに前面に出さない）
- Orca の `--worktree path:` と `repo add --path` には、シンボリックリンクを解いた実体のパスを渡す。Orca は git の返す実体のパスで worktree を持ち、`path:` を文字列で比べるので、一時ディレクトリ（`/var/folders/…` の実体は `/private/var/folders/…`）のダミーのリポジトリが selector_not_found になり、ロックと関係なく not_opened になっていた
- スクリーンセーバー・ディスプレイのスリープは、ロックになっていなければ止めない（下の結果で開けないと分かったら、検出を足す）

## 確かめる組み合わせ

| | 画面のロック（⌃⌘Q） | スクリーンセーバー | ディスプレイのスリープ |
|---|---|---|---|
| Orca（`--focus` なし） | raw・unattended | raw | raw |
| Ghostty | raw・unattended | raw | raw |
| Terminal.app | raw・unattended | raw | raw |

- raw: ロックの検査を飛ばして、その状態で端末を開いてみる（「ロック中に開けるか」そのもの）
- unattended: 本体の動きのまま。ロック中は開かずに待ち、30 秒ごとにやり直し、ロックを外したら開く（「ロックが外れたら起動」が動くか）

## 手順

前提: 本体のリポジトリで `bun install` 済み。利用者の常駐デーモン（7317）・データ・hooks には触れない（一時ディレクトリに別のデーモンを 27495 番で立てる）。実際の claude は動かさない（偽の claude が引数を記録して5秒で終わる）。依頼の型は読み取りのみ（調べてまとめる）、worktree は作らない。

0. 手順の確かめ（端末を開かない）

   ```sh
   bun scripts/spike-s8-launch-locked.ts --terminal ghostty --case lock --dry-run --delay 3
   ```

   `"sessionIdPassed": true` が出れば準備はできている

1. 端末ごとに、場合ごとに1回ずつ流す。コマンドを入れたら、表示に従ってロック・待つ（`--delay` 秒の後に起動し、最大3分待つ）

   ```sh
   # 画面のロック: 起動したら ⌃⌘Q でロックし、1分ほど待ってから外す
   bun scripts/spike-s8-launch-locked.ts --terminal ghostty  --case lock --mode raw
   bun scripts/spike-s8-launch-locked.ts --terminal orca     --case lock --mode raw
   bun scripts/spike-s8-launch-locked.ts --terminal terminal --case lock --mode raw
   # スクリーンセーバー: スクリプトが3秒後に始める。マウス・キーに触れずに待つ
   bun scripts/spike-s8-launch-locked.ts --terminal ghostty  --case screensaver
   bun scripts/spike-s8-launch-locked.ts --terminal orca     --case screensaver
   bun scripts/spike-s8-launch-locked.ts --terminal terminal --case screensaver
   # ディスプレイのスリープ: スクリプトが3秒後に pmset displaysleepnow。マウス・キーに触れずに待つ
   bun scripts/spike-s8-launch-locked.ts --terminal ghostty  --case display-sleep
   bun scripts/spike-s8-launch-locked.ts --terminal orca     --case display-sleep
   bun scripts/spike-s8-launch-locked.ts --terminal terminal --case display-sleep
   ```

2. 「ロックが外れたら起動」の確かめ（ロック中は開かず、外したら30秒以内に開く）

   ```sh
   # 起動したらロックし、2分ほど待ってから外す。外してから30秒以内に端末が開けばよい
   bun scripts/spike-s8-launch-locked.ts --terminal ghostty  --case lock --mode unattended --delay 30
   bun scripts/spike-s8-launch-locked.ts --terminal orca     --case lock --mode unattended --delay 30
   bun scripts/spike-s8-launch-locked.ts --terminal terminal --case lock --mode unattended --delay 30
   ```

3. 後片付け
   - Orca を使ったら、Orca のリポジトリの一覧から `s8-dummy-repo` を外す（一時ディレクトリは消えている）
   - 開いた端末のタブ・ウインドウを閉じる（偽の claude は5秒で終わっている）
   - 初めて Ghostty・Terminal を操作するときに macOS の「オートメーション」の許可を聞かれたら、そのときの答えを記録に書く（許可は「システム設定 > プライバシーとセキュリティ > オートメーション」でいつでも外せる）

## 結果の記録

- 1回ごとに `out/s8-results.jsonl`（git に入らない）に1行足す。中身は macOS の版・端末・場合・方式・起動したときにロックしていたか（`lockedAtLaunch`）・スクリーンセーバーが動いていたか・起動の試み（`attempts`）・開けたか（`opened`）・受け取りまでの秒（`claimedWithinSec`）・偽の claude に `--session-id` が渡ったか（`sessionIdPassed`）。パス・ユーザー名は書かない
- 開けなかった起動（`reason: "not_opened"`）には、端末を開く各 step の `steps`（`cmd`: Orca のサブコマンドなど、`code`: 終了コード、`timedOut`、`stderr` の要約、`error`: Orca の JSON のエラーの code と message）を付ける。一時ディレクトリは `<tmp>`、ホームは `~` に置き換える
- Orca のダミーのリポジトリを外す案内は、`repo add` が成功したときだけ出す
- 見た目で分かること（ロックを外したときにタブが開いていたか、前面に出ていたか、ロック画面の上に出たか）は下の表の「メモ」に書く
- 結果を下の表に写し、この文書の「状態」を「実施済み」にする。駄目な端末があれば、その端末の扱い（ロックが外れてから起動、または端末を使わず裏で起動）を PO に上げる

## 結果

macOS 26.6.2、Orca 1.4.222、Ghostty 1.3.1。空欄は未実施（Terminal.app は測らないことにした）。

| 端末 | 場合 | 方式 | ロック中だったか | 開けたか | 受け取り | --session-id | メモ |
|---|---|---|---|---|---|---|---|
| Orca | ロックなし | raw | いいえ | 開けた | 2秒 | 渡った | |
| Orca | ロック | raw | はい | 開けた | 2秒 | 渡った | ロック中に Orca のタブが開き、偽の claude が受け取った |
| Orca | スクリーンセーバー | raw | | | | | |
| Orca | ディスプレイのスリープ | raw | | | | | |
| Orca | ロック | unattended | はい | 開けた（解除の直後） | 解除の直後 | 渡った | ロック中は screen_locked で30秒ごとに待ち、外した直後に開いた |
| Ghostty | ロックなし | raw | いいえ | 開けた | | | |
| Ghostty | ロック | raw | はい | 使えない | 123秒（解除の前後） | 渡らなかった | ウインドウは出るが「The terminal failed to initialize」で端末が立たない |
| Ghostty | スクリーンセーバー | raw | | | | | |
| Ghostty | ディスプレイのスリープ | raw | | | | | |
| Ghostty | ロック | unattended | | | | | |
| Terminal.app | ロック | raw | | | | | |
| Terminal.app | スクリーンセーバー | raw | | | | | |
| Terminal.app | ディスプレイのスリープ | raw | | | | | |
| Terminal.app | ロック | unattended | | | | | |

### 結果から決めたこと

- 人のいないときの起動（`launcher.launch` の `unattended`）は、端末が **Orca のときはロック中でも待たずに起動**する。Ghostty・Terminal.app・それ以外は今のまま、ロック中は `screen_locked` で待ち、外れたら起動する（`apps/daemon/src/launch/terminal.ts` の `unattendedWaitsWhileLocked`）
- 拡張は `launcher.waitsWhileLocked()` で、いまの端末でロック中に待つかを読める（説明の文言を変えるため）
- ロックは `CGSSessionScreenIsLocked` だけで見るので、パスワードを求めるスクリーンセーバーはロックと同じ扱い（Orca は待たない、ほかは待つ）。ロックしていないスクリーンセーバー・ディスプレイのスリープは、測っていないが今までどおりどの端末でも待たない。開けないと分かったら検出を足す

## 手順の確かめ（実施済み）

- `--dry-run` で Ghostty・Orca・Terminal.app の3つの端末について、起動 → `turnlane ai run` の受け取り（1秒）→ 偽の claude に `--session-id <起動の UUID>` と起動の ID が渡る、を確かめた（`LANG=C` でも同じ）。端末は開いていない
- ロックの検出（`ioreg`）は、ロックしていない状態で `CGSSessionScreenIsLocked` が無いこと（false）だけを確かめた。ロック中に true になるかは上の手順の `lockedAtLaunch` で分かる
