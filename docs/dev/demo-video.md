# デモ動画（M6-30）の作り方

README の先頭（GIF）・公開日の X（mp4）・お試しの説明（mp4）に使う 31 秒・音なしの動画。日本語 UI + 日本語字幕の版と、
英語 UI + 英語字幕の版を同じ台本から出す。場面 (1)(2) は dev-board と Playwright で録り、場面 (3) と通知のバナーだけを実機
（テスト用の macOS ユーザー）で撮る。実データは映さない。

| 区間 | 場面 | 構図 | 素材 |
|---|---|---|---|
| 0.0–6.5 | (1) AI のレーンで 3 本が実行中 | F1 全体 | Playwright |
| 6.5–17.5 | (2) 1 本が許可待ちで止まり、自分の番の帯に出る。7.6–12.6 に通知のバナー | F2 | Playwright ＋ 実機のバナー |
| 17.5–28.0 | (3) 「開いて対応」で Ghostty のタブ 3 が前に出る | F2 → F3 → F4 → F3 | 実機 |
| 28.0–31.0 | 締めの字幕（場面 (3) の最後の絵の止め絵） | F3 | 実機 |

構図・カット・字幕の秒と文は `scripts/demo/plan.ts` が正（録画と組み立てが同じ表を読む）。舞台は 1440×900 pt、原本は 2 倍
（2880×1800）。字幕は舞台の下の帯（1440×100。地 `#0E0F11`、文字 `#E8E9EB`、Noto Sans JP / Inter の 500、28px、0.15 秒のフェード）。
締めの字幕の 2 行目のリポジトリの URL は英語版だけに出す。

## 1. dev-board の場面（`--design demo`）

```sh
bun run build:web
bun scripts/dev-board.ts --design demo --lang ja --theme dark [--demo-notify 15] [--demo-waiting]
```

- 今は 2026-10-02（金）15:20。予定・タスクは `--design` に共通のもの（朝会・デザインレビュー・1on1・プロダクト定例、請求書CSVのレビュー など）。
  ただし 12:30〜13:40 の完了したタスクは「申し込みページの文言 / Signup page copy」（他の `--design` の「価格ページの文言」。価格の語をダミーから外す）
- AI は 3 本が実行中（hooks あり）。件名（最初の指示）と ai-title は同じ文

| | リポジトリ · ブランチ | 取り込み元 | 件名 | 始まり |
|---|---|---|---|---|
| A | `web-app` · `feat/board-width` | main | 3日ボードの列幅を直して / Fix the three-day board column widths | 13:20 |
| B | `docs-site` · `docs/deploy` | sandbox | デプロイの手順を整理して / Tidy up the deploy guide | 14:05 |
| C | `api-gateway` · `fix/auth-refresh` | main | リフレッシュトークンの 401 を直して / Fix the 401 on token refresh | 14:50 |

- 始まりは絵コンテ（14:35・14:50・15:02）より前にずらした。実行の時間が短いと AI のレーンのラベルが重なって「+1」に畳まれ、3 本の題名が読めないため
- `--demo-notify <秒>`: 起動の <秒> 後に、C に Bash の toolUse（`bun test src/auth`、説明「認証のテストを走らせる」）と `PermissionRequest` を書く。
  新しいセッションは足さない。時計は 15:20 のまま（止まった時刻は 15:19:58。在席の区間の外に置くと待ちが「15:20 から」の形になる）。
  標準出力の合図の行 `demo: added a new approval request (needs_input)` は今までと同じ
- `--demo-waiting`: 起動の時点で C を許可待ちにする（15:19:40 に止まった。実機の場面 (3) 用）
- 実機用 `--real-open --demo-pid <pid> --demo-root <dir>`: 「開く」に本物の OpenSystem を使う（`osascript`・`ps`・tty への OSC 7）。
  C を動いている扱いにする（main の `sessions/<pid>.json`。`--design answer` と同じ形）。pid は Ghostty のタブ 3 で動いているダミーの
  台本（`scripts/demo/tab.sh`）。リポジトリの場所 `/w/<repo>` を `<dir>/<repo>`（実在するダミーのフォルダ）に替える。
  Playwright の録画では使わない
- E2E: `bun e2e/run.ts --suite demo`（3 本が実行中 → 合図の後に C だけが許可待ち、帯にツールとコマンド、待ち `<1m`）

## 2. 場面 (1)(2) の録画

```sh
bun run build:web
bun scripts/demo-record.ts --lang ja [--out <dir>] [--notify 15] [--fps 12]
```

- dev-board を `--design demo --theme dark --demo-notify 15` で起動し、Chromium（1440×900・2 倍・ダーク）で 3日ボードを開く。
  AI のブロックが 3 つ出るのを待ち、時間軸をいちばん下までスクロールする（0:00〜24:00 の 1200px なので上端は 10:20 ごろ）
- Playwright の `recordVideo`（VP8）は文字が甘いので、`page.screenshot`（2880×1800 の PNG）を 12fps ほどで撮って並べる。
  回る弧と一度だけの変化しか動かないので、この fps で足りる
- 合図の行を受け取った時刻から 7.5 秒前を 0.0 とし、各フレームに時刻を付ける。出力は `out/demo/rec/<lang>/`（`frames/`・`timeline.json`）
- カーソルは出さない（`page.mouse` を使わない）

## 3. 組み立て

```sh
bun scripts/demo-assemble.ts --lang ja [--captures <dir>] [--out <dir>] [--gif]
```

- 場面 (1)(2) のフレームを時刻どおりに並べ（ffconcat）、構図ごとに切り出して 2880×1800 に拡大、字幕の帯（HTML を Playwright で PNG に）を
  下に付けて `master.mov`（2880×2000）にする。そこから
  - `demo-<lang>.mp4`: 1440×1000、30fps、H.264（high、CRF 18）、yuv420p、音声なし、`+faststart`
  - `--gif` で `demo-<lang>.gif`: 960 幅、12fps、128 色（`palettegen` の `stats_mode=diff`、`paletteuse` の `diff_mode=rectangle`）。
    16MB を超えたら 10fps → 800 幅の順に下げる
  - 代表フレーム `frame-<lang>-*.png`（0 秒・7.9 秒・12.6 秒、場面 (3) があれば 21.5・24.0・29.0 秒）
- ffmpeg は `/opt/homebrew/bin/ffmpeg`（無ければ PATH の ffmpeg）。gifsicle は使わない
- 実機の素材が無い間は場面 (1)(2) だけの 17.5 秒を出す。素材が来たら `--captures` のフォルダに `edit.json` を置いて同じコマンドで 31 秒にする:

```json
{
  "scene3": { "file": "scene3.mov", "stage": [0, 136, 2880, 1800], "t0": 6.2 },
  "banner": { "file": "banner.mov", "crop": [2290, 70, 700, 190], "t0": 45.3 }
}
```

| キー | 意味 | 決め方 |
|---|---|---|
| `scene3.stage` | 録画の中の Turnlane のウインドウの中身（舞台）の画素の範囲 [x, y, 幅, 高さ] | 録画の 1 枚（`ffmpeg -ss 1 -i scene3.mov -frames:v 1 a.png`）で、タイトルバーの下から 2880×1800 |
| `scene3.t0` | 動画の 17.5 秒にあたる録画の秒 | 押した瞬間が 20.0 秒になるように（押した秒 − 2.5） |
| `banner.crop` | 録画の中の通知のバナーの範囲 | バナーが出きった 1 枚で、影を少し含めて |
| `banner.t0` | バナーが入り始める録画の秒 | 動画の 7.6 秒に重ねる。5 秒使う |

バナーは F2 の右上に重なるので、7.6〜12.6 秒の間は帯の行の右側（理由の後ろと待ち）が隠れる。12.6 秒からの 5 秒で読める。

- 置き場: 最終の `demo-en.gif`・`demo-en.mp4`・`demo-ja.mp4` だけを `docs/assets/` に入れる（D-231・D-258）。撮った原本・録画・
  `master.mov` はリポジトリに入れない（テスト用ユーザーの画面の端が写るため）。入れる前に通しで見て、ダミー以外の名前が写っていないかを確かめる

## 4. 実機（場面 (3) と通知のバナー）

オーナーがテスト用の macOS ユーザーで撮る（D-259）。開発者の Mac のアプリ・Ghostty・通知には触れない。

```sh
bun run build:web
bun run build:app            # out/app/Turnlane.app（TURNLANE_CODESIGN_IDENTITY が無ければ ad-hoc）
bun scripts/demo-kit.ts      # /Users/Shared/turnlane-demo/ に撮影キットを作る（captures/ は残す）
```

キットはリポジトリを読めないユーザーでも動く形にしてある: dev-board を `bun build` で 1 ファイルにした `dev-board.js`
（node_modules は要らない。bun だけ要る）、`web/`、`Turnlane.app`、`tab.sh`、手順書 `README.md`（`scripts/demo/kit/README.md`）と
`board.sh`・`app.sh`・`record.sh`・`cleanup.sh`・`ghostty.config`。手順の要約:

1. 準備: システムの言語を撮る版に、集中モードを切る、Ghostty の設定（配色・位置）、プロンプトを `PS1='%~ %# '` に
2. Ghostty を 1 ウインドウ 3 タブで開き、各タブで `tab.sh <web-app|docs-site|api-gateway> <lang>`（OSC 2 でタブの題名、
   OSC 7 で `~/w/<repo>` を作業フォルダに、pid を `run/<repo>.pid` に書いて止まる）
3. ターミナル.app で `board.sh <lang> scene3`（`--real-open --demo-waiting --demo-pid <タブ 3 の pid> --demo-root ~/w`）と
   `app.sh`（`TURNLANE_PORT`・`TURNLANE_DATA_DIR` を dev-board に向けて起動。常駐の登録には触れない。中身 1440×900 の位置と大きさを
   アプリの `window.json` に書く）
4. 一度「開いて対応」を押してオートメーションの許可（ターミナル → Ghostty）を済ませ、dev-board を起動し直す
5. `record.sh <lang> scene3`（`screencapture -v -C`、35 秒）を始め、絵コンテ §3 の秒のとおりにカーソルを動かして押す
6. `board.sh <lang> banner`（`--demo-notify 45`）・`app.sh`・`record.sh <lang> banner`（70 秒）で通知のバナーを録る
7. 英語版は言語を English にしてログインし直し、同じ手順。最後に `cleanup.sh`

Retina の画面（MacBook の内蔵の画面）で撮る。1 倍の外付けの画面だと、F2〜F4 で拡大したときに文字がにじむ。
