# 2026-10-07 の溜まっていた修正の確認手順

CLI の ID・ヘルプ・編集、題名の末尾の欠け、デイビューの待ちの線の重なり。仕様は phase0-plan 3.6（CLI の表）、ux-mvp 4.5（待ちの線）。

## 変わったこと

- **CLI の ID**: `turnlane ls` / `turnlane today` / `turnlane add` は、その一覧の中で一意になる最短の接頭辞（最低8文字、`-` で終わらない）を出す。近い時刻に作ったタスクは `01a111e6-aa62-74` のように長くなる。`turnlane done` / `turnlane edit` / `turnlane rm` に曖昧な接頭辞を渡すと、候補（区別できる接頭辞・題名・日付）を出して終了コード 1。`-` の有無は問わない
- **ヘルプと未知の引数**: どのサブコマンドも `--help` / `-h` で使い方を出す（実行しない）。`turnlane help <command>` も同じ。未知のオプション・余分な位置引数（`turnlane ls inbox`）はエラーにして使い方を出す（終了コード 2）。`-` で始まる語を題名にするときは `turnlane add -- -foo`
- **`turnlane edit <id>`**: `--title`、`--date YYYY-MM-DD` / `--inbox`、`--est <分>`（`--estimate` も可）/ `--no-est`、`--project <名前>` / `--no-project`。プロジェクトは無ければ作る（`turnlane add` の `#project` と同じ）。**`turnlane rm <id>`**: 論理削除
- **題名の末尾の欠け**: 詳細パネルの題名を変換中のまま離れ、確定の文字が後から届くと、離れた時点の値（末尾の1文字が無い）で保存していた。変換中に離れたときは確定を待って欄の値を読む。`r` の題名の変更も ⏎ の時点の欄の値を読む
- **デイビューの待ちの線**: 同じ AI 列で別々の待ちの線が上下に重なるとき、後から始まる待ちの線を 6px ずつ右へずらす（帯・終わりの点・ラベルも一緒に）。同じ高さの集計外のラベル（`会議中` が2つ）は1つだけ書く

## 自動で確かめているもの

- `bun run check`: `apps/cli/test/tasks-command.test.ts`（接頭辞、曖昧なときの候補、edit / rm）、`apps/cli/test/run-args.test.ts`（全サブコマンドの `--help` / `-h`、`turnlane ls inbox`、未知のオプション）、`apps/web/test/ime.test.ts`（readAfterComposition）、`apps/web/test/labels.test.ts`（待ちの線の段）
- `bun run e2e` の ime: 詳細パネルの題名・`r` の題名で、変換確定の直後の ⏎ / 欄を離れる / 確定が後から届く場合に保存された題名の末尾が欠けない（Chromium と WebKit）

## ダミーデータで見る

```sh
bun run build:web
bun scripts/dev-board.ts --dense --lang ja --theme light   # --open /day でデイビュー
```

デイビューの 15:00〜17:00 の AI 列: `放置 1h` / `放置 45m` と `放置 55m` ×2 の線が2本に分かれ、ラベルがそれぞれの線の右に段違いで並ぶ。

## オーナーの入れ替え手順

```sh
cd ~/source/dayline
bun install
bun run check
bun run build
bun run smoke
out/turnlane self-install    # デーモンと turnlane を入れ替える（マイグレーションは無し）
```

デーモンの入れ替えと開いているウインドウの再読み込み（⌘R）で反映される。デスクトップアプリとカレンダーヘルパは入れ替え不要。

## 入れ替え後に実データで見る（結果を PO に返す）

1. `turnlane ls --inbox` で ID が区別できるか。表示された ID で `turnlane done` / `turnlane edit` が通るか。`turnlane done 01a111e6` のように短すぎる ID で候補が出るか
2. `turnlane ls --help`、`turnlane ls inbox` の出力
3. Inbox の「Turnlane: turnlane.dev のドメインを取得す」を `turnlane edit <id> --title "…取得する"` で直せるか。以後、詳細パネルで題名を直したときに末尾が欠けないか
4. デイビューで、同じ AI 列の待ちの線がどの項目のものか見分けられるか
