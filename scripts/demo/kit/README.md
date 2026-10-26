# デモ動画の撮影キット（場面 (3) と通知のバナー）

デモ動画（M6-30）のうち、実機で撮る 2 つの素材をテスト用の macOS ユーザーで撮るための手順。場面 (1)(2) は録画済み（Playwright）。

- 撮るもの: **場面 (3)**（「開いて対応」で Ghostty のタブ 3 が前に出る）と、**通知のバナー**（場面 (2) の右上に重ねる）。日本語版と英語版で 1 回ずつ
- 中身はすべてダミー（dev-board の一時 HOME・偽の時計 10/2 15:20・架空のリポジトリ名）。本物の Claude Code は動かさない。Ghostty のタブの中身はダミーの台本 `tab.sh` が出す文
- 撮った素材はこのキットの `captures/ja/`・`captures/en/` に入る。組み立て（切り出し・字幕・書き出し）は product-engineer が行う

キットの中身（`/Users/Shared/turnlane-demo/`）

| ファイル | 役目 |
|---|---|
| `board.sh` | dev-board（ダミーのデーモン。ポート 27317）を起動する |
| `app.sh` | 開発ビルドの `Turnlane.app` を dev-board に向けて起動する |
| `tab.sh` | Ghostty のタブに出すダミーの画面（タブの題名もここで付く） |
| `record.sh` | 画面を録る（`screencapture -v`） |
| `cleanup.sh` | 撮り終えた後、テスト用ユーザーの中に作ったものを消す |
| `ghostty.config` | テスト用ユーザーの Ghostty の設定（配色・位置） |
| `dev-board.js`・`web/`・`Turnlane.app` | dev-board の本体（1 ファイルにまとめたもの）・画面・デスクトップアプリ（開発ビルド） |

## 0. 先に知っておくこと

- **Retina の画面で撮る**。動画は画面の一部を 1.4〜2.5 倍に拡大して使うので、1 倍の画面（外付けの非 Retina の画面など）で撮ると文字がにじむ。MacBook の内蔵の画面だけで撮るのがよい（外付けをつなぐなら、内蔵の画面をメインの画面＝メニューバーのある方にする。録るのはメインの画面）
- 内蔵の画面の「解像度」は、**幅 1440 以上・高さ 970 以上**に見える設定にする（14 インチの既定 1512×982 で足りる）。Turnlane のウインドウの中身を 1440×900 pt にするため
- デスクトップアプリは開発ビルド（ad-hoc 署名）。`app.sh` は `TURNLANE_PORT`・`TURNLANE_DATA_DIR` を dev-board に向けて起動するので、常駐の登録（SMAppService・LaunchAgents・ログイン項目）には触れない。D-253 の launch constraint は常駐の登録をしたときの話なので、この起動のしかたには関係しない
- dev-board と `app.sh` は **ターミナル.app** で動かす（Ghostty はタブ 3 つだけにする）。「開いて対応」が Ghostty を操作するとき、macOS は「ターミナルが Ghostty を制御しようとしています」と聞く（3 章で一度だけ許可する）
- Turnlane の画面で押してよいのは「開いて対応」だけ。「答える」を押すと、ダミーの台本のタブに文字が入る（害は無いが撮り直しになる）
- 止め方: dev-board は Ctrl-C（一時 HOME を消す）、アプリは ⌘Q、`tab.sh` は Ctrl-C

## 1. 準備（テスト用ユーザーで 1 回だけ）

1. テスト用のユーザー（例 `demo`）でログインする
2. システム設定 > 一般 > 言語と地域 で、優先する言語の先頭を **日本語** にする（英語版を撮るときは 6 章で English にする。通知のバナーの「今」/「now」がこの言語で出る）
3. コントロールセンターの「集中モード」をオフにする（おやすみモードも）
4. ほかのアプリにはサインインしない。デスクトップに置いたファイルや開いたウインドウを片付ける
5. ターミナル.app を開く
6. bun があるか確かめる: `/opt/homebrew/bin/bun --version`（`1.4.` で始まればよい）
   - 「No such file」と出たら、bun をこのユーザーに入れる: `curl -fsSL https://bun.sh/install | bash`
   - 入れたら、以降のターミナルで先に `export BUN_BIN="${HOME}/.bun/bin/bun"` を実行する
7. Ghostty の設定を写す: `mkdir -p ~/.config/ghostty && cp /Users/Shared/turnlane-demo/ghostty.config ~/.config/ghostty/config`
8. シェルのプロンプトを短くする（ユーザー名・ホスト名を写さない）: `echo "PS1='%~ %# '" >> ~/.zshrc`
9. ターミナル.app を一度閉じて開き直す（8 を効かせる）
10. Ghostty が 1.3 以上か確かめる: Ghostty のメニュー Ghostty > About Ghostty（1.3.1 なら足りる）

## 2. 起動のしかた（3 章・4 章・5 章で毎回使う）

言語は `ja` か `en`。ここでは `ja` で書く。

1. Ghostty を起動する（ウインドウが 1 つ開く。これがタブ 1）
2. タブ 1 で `bash /Users/Shared/turnlane-demo/tab.sh web-app ja` を実行する（画面に `~/w/web-app  feat/board-width` が出て止まる。タブの題名は `web-app`）
3. ⌘T でタブ 2 を開く
4. タブ 2 で `bash /Users/Shared/turnlane-demo/tab.sh docs-site ja` を実行する
5. ⌘T でタブ 3 を開く
6. タブ 3 で `bash /Users/Shared/turnlane-demo/tab.sh api-gateway ja` を実行する（`Allow this command?  1. Yes  2. No` まで出て止まる）
7. ターミナル.app のウインドウで `bash /Users/Shared/turnlane-demo/board.sh ja rehearse` を実行する（4 章では `scene3`、5 章では `banner`。`TURNLANE_DATA_DIR=... TURNLANE_PORT=27317` の行が出たら起動済み）
8. ターミナル.app で ⌘T を押して新しいタブを開く
9. そのタブで `bash /Users/Shared/turnlane-demo/app.sh` を実行する（Turnlane のウインドウが開き、3日ボードが出る）
10. 初めてのときは「“Turnlane”からの通知」の許可を聞かれるので **許可** を押す
11. Turnlane のウインドウが画面の左上（中身 1440×900）にあることを確かめる（`app.sh` が起動のたびに位置と大きさを書く。ずれていたら 9 章の「ウインドウの大きさ」）

## 3. オートメーションの許可を先に済ませる（1 回だけ）

2 章の 1〜11 を `rehearse` で済ませた状態から。

1. Turnlane の今日の列の上にある「自分の番」の行（`リフレッシュトークンの 401 を直して`）にマウスを載せる
2. 行の右に出たボタンのうち、先頭の「開いて対応」を押す
3. 「“ターミナル”から“Ghostty”を制御するアクセスを要求しています」に **OK** を押す（5 秒以上待たせない）
4. Ghostty が前に出てタブ 3（`api-gateway`）が選ばれ、Turnlane の画面下に「Ghostty のタブ 3 を前に出しました。」が出ることを確かめる（出なければ 9 章）
5. Turnlane を ⌘Q で終える
6. ターミナル.app の dev-board のタブで Ctrl-C を押す（状態が戻る）

## 4. 場面 (3) を撮る

Ghostty のタブ 1〜3 は動かしたままでよい（タブ 3 の `tab.sh` を止めたら、2 章の 6 でもう一度動かす）。

1. Ghostty で ⌘1 を押してタブ 1 を選ぶ
2. Ghostty のウインドウが、Turnlane の中身の右下寄り（中身の座標で x 760〜1400、y 300〜700 あたり。画面ではおおよそ左から 760、上から 370 の位置に 640×400）にあることを確かめる（ずれていればタイトルバーをつかんで動かす）
3. ターミナル.app の dev-board のタブで `bash /Users/Shared/turnlane-demo/board.sh ja scene3` を実行する
4. app のタブで `bash /Users/Shared/turnlane-demo/app.sh` を実行する
5. ターミナル.app のどちらかのタブで、録画のコマンドを打っておく（まだ Enter は押さない）: `bash /Users/Shared/turnlane-demo/record.sh ja scene3`
6. Enter を押す（3 秒後に録り始め、35 秒で止まる）
7. すぐに Turnlane のウインドウの何も無いところ（左の列の下のほう）を 1 回押して前に出す。Ghostty が Turnlane の後ろに隠れていることを確かめる
8. マウスを画面の右下に置いて、2 秒止める
9. マウスをゆっくり（1 秒くらいかけて）「自分の番」の行の上へ動かす
10. 0.7 秒ほど止める（行の右にボタンが出る）
11. マウスを先頭のボタン「開いて対応」へ動かし、ツールチップ「開いて対応」が出るまで止める（0.6 秒ほど）
12. 押す（押した後はマウスを動かさない）
13. Ghostty が前に出て、画面下に「Ghostty のタブ 3 を前に出しました。」が出る。そのまま録画が止まるまで（「保存しました」が出るまで）何もしない
14. 撮り直すときは: Turnlane を ⌘Q → dev-board のタブで Ctrl-C → この章の 1 から（前の録画は `scene3-<時刻>.mov` に名前を変えて残る）

うまく撮れたかは QuickTime Player で `captures/ja/scene3.mov` を開いて見る（帯の行・ツールチップ・Ghostty のタブ 3・知らせが写っていればよい）。

## 5. 通知のバナーを撮る

1. Turnlane を ⌘Q で終える
2. dev-board のタブで Ctrl-C を押す
3. dev-board のタブで `bash /Users/Shared/turnlane-demo/board.sh ja banner` を実行する（45 秒後に許可待ちが 1 件増え、通知が出る）
4. app のタブで `bash /Users/Shared/turnlane-demo/app.sh` を実行する
5. 続けてすぐ `bash /Users/Shared/turnlane-demo/record.sh ja banner` を実行する（70 秒録る）
6. マウスに触れずに待つ。画面の右上に通知のバナー（件名 `リフレッシュトークンの 401 を直して`、`許可待ち · api-gateway`、`fix/auth-refresh`）が入ってきて、数秒で消える
7. 「保存しました」が出たら終わり。バナーが出なかったら 9 章

## 6. 英語版を撮る

1. Turnlane を ⌘Q、dev-board を Ctrl-C、Ghostty の 3 つのタブで Ctrl-C を押す
2. システム設定 > 一般 > 言語と地域 で、優先する言語の先頭を **English** にする
3. ログアウトしてログインし直す（言語を効かせる）
4. 2 章〜5 章を、`ja` を `en` に替えてもう一度行う（3 章の許可は済んでいれば飛ばしてよい。素材は `captures/en/` に入る）

## 7. 後片付け

1. Turnlane を ⌘Q、dev-board を Ctrl-C、Ghostty の 3 つのタブで Ctrl-C を押す
2. ターミナル.app で `bash /Users/Shared/turnlane-demo/cleanup.sh` を実行する（`~/w` のダミーのフォルダ、dev-board の一時 HOME の残り、アプリの設定・キャッシュを消す。`captures/` は残る）
3. 必要なら システム設定 で、このユーザーの通知（Turnlane）・オートメーション（ターミナル → Ghostty）・画面収録（ターミナル）の許可を外す
4. 元のユーザーに戻り、PO に「`/Users/Shared/turnlane-demo/captures/` に撮った」と伝える

## 8. 写ってはいけないもの（撮る前に見る）

- ユーザー名・ホスト名（プロンプトは `PS1='%~ %# '`。`tab.sh` はパスを `~/w/...` で出す）
- ほかのアプリの通知・ウインドウ、デスクトップのファイル
- 本物のリポジトリ名・会話（このキットはダミーしか出さない。Ghostty のタブはこのキットの 3 つだけにする）

画面の上のメニューバーと下の Dock は、組み立てで Turnlane のウインドウの中身だけを切り出すので入らない（バナーは右上だけを切り出す）。

## 9. 困ったとき

| 症状 | 見るところ |
|---|---|
| `board.sh` が「タブ 3 の台本が動いていません」 | Ghostty のタブ 3 で `tab.sh api-gateway <言語>` を動かし直してから、もう一度 |
| `app.sh` が「dev-board がまだ起動していません」 | dev-board のタブに `TURNLANE_DATA_DIR=` の行が出るまで待つ |
| Turnlane が「デーモンにつながらない」の画面 | dev-board が止まっている。Turnlane を ⌘Q → `board.sh` → `app.sh` の順で起動し直す |
| 「開いて対応」で Ghostty が前に出るが、知らせが「Ghostty を前に出しました」でタブ 3 にならない | タブ 3 の `tab.sh` を止めて動かし直し、`board.sh` も起動し直す（pid が変わるため） |
| 「開いて対応」で何も起きない・「許可が無い」の知らせ | システム設定 > プライバシーとセキュリティ > オートメーション > ターミナル の Ghostty をオンにする |
| 録画が「画面収録の許可」で止まる | システム設定 > プライバシーとセキュリティ > 画面収録 で ターミナル をオンにし、ターミナルを開き直す |
| 通知のバナーが出ない | 集中モードがオフか、システム設定 > 通知 > Turnlane が「バナー」で許可されているか |
| ウインドウの大きさ・位置 | `app.sh` は起動のたびに位置（左上 x 0・y 40）と中身の大きさ 1440×900 を書く。画面が狭いと macOS が縮める（0 章の解像度）。位置を変えるなら Turnlane を ⌘Q してから `WIN_X=0 WIN_Y=60 bash /Users/Shared/turnlane-demo/app.sh` |
