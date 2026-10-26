     1	# 小さな残件（ラベルの重なり、週表示の YOUR TURN 帯、閉じ直しの Carried over）の確認手順
     2	
     3	仕様は ux-mvp.md 4.4（待ちの線・YOUR TURN 帯）・4.5（デイビューの待ちの線）・8章（閉店は勤務の終わり）、m2-api.md 22章。見た目の変更点は docs/design/README.md の「残件」（L1・L2）。
     4	
     5	- **放置のラベル（L1）**: 3日ボードで前日から持ち越した AI ブロック（`draft pricing`）の題名に `放置 5h20m` が重なっていたのを、ブロックの下へずらす。デイビューで近接する放置の区間のラベル（`放置 1h` と `放置 45m`）が重なっていたのを、下へずらして並べる。置けないものは短い区間のラベルを省いてホバーに任せる（`apps/web/src/board/labels.ts`）
     6	- **週表示の YOUR TURN 帯（L2）**: 狭い列では repo 名・待ち時間を省き（行のホバーに出す）、状態アイコン＋題名を2行まで
     7	- **閉じ直しの Carried over**: 再開後にもう一度 Close the day したとき、Carried over には最初の閉店で実際に移したタスクだけを出す（再開後に残った未完了を「→ 次の稼働日」と出さない）。最初の閉店で移したタスクを `usage_event(kind='ritual_carry', ref='<日付>:<task id>')` に残し、閉じ直しの日報と再開中のシャットダウン Step 2 はそれを使う
     8	
     9	自動で確かめているもの（`bun run check`）: `apps/web/test/labels.test.ts`（下へずらす、長い区間が先・短い方を省く、別の列とは衝突しない、デイビューで同じ列の2本の放置のラベルが重ならずブロックにも重ならない、TurnRow の狭い行の規則）、`apps/daemon/test/rituals-api.test.ts` の「閉じ直しの Carried over には、最初の閉店で実際に移したタスクだけを出す」。
    10	
    11	## ダミーデータで見る
    12	
    13	```sh
    14	bun run build:web
    15	bun scripts/dev-board.ts --dense --lang ja --theme light   # w で週表示、--open /day でデイビュー
    16	```
    17	
    18	| ファイル（`docs/dev/screens/leftovers/`） | 見るところ |
    19	|---|---|
    20	| `three-day-ja-light` / `-ja-dark` | 今日の AI レーンの `draft pricing`（持ち越し）の題名の下に `放置 5h20m`（D-078 の画像では重なっていた） |
    21	| `week-ja-light` / `-ja-dark` | 今日の列の YOUR TURN 帯。状態アイコン＋題名を2行まで（D-074 の画像では `許..` `返...` で切れていた） |
    22	| `day-view-ja-light` / `-ja-dark` | 15:00 付近の `放置 1h` と `放置 45m` が上下に並ぶ（D-078 の画像では重なっていた）。17:00 付近の `放置 55m` も2本の待ちの分が並ぶ（以前は同じ位置に重なって1つに見えていた） |
    23	
    24	ヘッドレスの Chrome（CDP、1440×900、2倍）で撮影。
    25	
    26	## オーナーの入れ替え手順
    27	
    28	```sh
    29	cd ~/source/dayline
    30	git pull               # main
    31	bun install
    32	bun run check
    33	bun run build
    34	bun run smoke
    35	out/turnlane self-install    # デーモンと turnlane を入れ替える（マイグレーションは無し）
    36	```
    37	
    38	デーモンの入れ替えと開いているウインドウの再読み込み（⌘R）で反映される。デスクトップアプリとカレンダーヘルパは入れ替え不要。
    39	
    40	閉じ直しの Carried over は、入れ替え後に最初に閉じた日から効く（それより前に閉じて再開した日は、移したタスクの記録が無いので閉じ直しの Carried over は空になる）。
    41	
    42	## 入れ替え後に実データで見る（結果を PO に返す）
    43	
    44	1. 3日ボード・デイビューで、放置のラベルが題名や別のラベルに重なっていないか。ずれた位置のラベルがどの待ちのものか分かるか
    45	2. 週表示（`w`）の今日の列の YOUR TURN 帯で題名が読めるか。repo 名と待ちが行のホバーで見えるか
    46	3. Close the day → 再開 → もう一度 Close the day。日報の Carried over が最初の閉店で移したものだけか
