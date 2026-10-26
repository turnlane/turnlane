# M3 段階 A の確認手順（カレンダーの読み取り・稼働日と祝日）

M3 の段階 A（phase0-plan 4.5。常用開始の前に要る範囲）を入れ替えて、カレンダーの予定が週ボードに出ること、
会議中の待ちが Idle に入らないこと、祝日と次の稼働日を確かめる手順。自動で確かめられる部分は
`bun run check`・`bun run smoke`（一時 HOME）・`bun run check:helper`（ヘルパ。EventKit に触れない）が行う。

- 段階 A に入っているもの: カレンダーヘルパ（M3-1。読み取りだけ）、ヘルパとデーモンの接続（`/internal/ek`）、
  予定のキャッシュ（窓 = 7日前〜21日後）、週ボードの予定・終日予定・Events / Free、busy な予定と重なる待ちの集計外（`in meeting`）、
  SSE `calendar`、稼働日と祝日（M3-6）、`turnlane calendar`、`turnlane config`、`turnlane doctor` の「Holidays from」
- まだ無いもの（段階 B）: 時間ブロックの `Turnlane` カレンダーへの書き戻し（M3-3）、設定画面でのカレンダーの役割・稼働日の変更（CLI で代用）
- ヘルパが無くても（S1 の前・S1 が失敗した場合も）他の機能はすべて動く。サイドバーの Sources に「Calendar off」
  （日本語は「カレンダー未接続」）と出て、予定が出ないだけ（D-044 (1)）

## 0. 入れ替える前に（任意）: ダミーデータで画面を見る

```sh
cd ~/source/dayline
bun install
bun run dev:board      # 表示された http://127.0.0.1:27317/auth?t=... をブラウザで開く
```

予定は偽のカレンダー（Work と祝日カレンダー）からデーモンが同期したもの。火曜（10/6）が祝日カレンダーの日なので、
終日の行に「Example Holiday」が出て、Free が出ない（稼働日でない）。`bun run build:web && bun scripts/dev-board.ts --calendar-off`
でヘルパ未接続の状態（サイドバーに「Calendar off」、予定なし、今日の Idle が会議ぶん増える）を見られる。

スクリーンショットは `docs/dev/screens/m3-a/`（`week-board-en-dark.png`、`week-board-ja-dark.png`、
`week-board-en-dark-calendar-off.png`）。

## 1. ビルドと入れ替え

```sh
cd ~/source/dayline
git pull               # main
bun install
bun run check          # biome / tsc -b / bun test
bun run build          # out/turnlaned と out/turnlane
bun run smoke          # 一時 HOME で M0〜M3 の確認
out/turnlane self-install    # ~/.local/bin を入れ替え、デーモンを再起動する
turnlane daemon status
turnlane calendar status     # 「Helper: 未接続（カレンダー未接続 …）」と出る（ヘルパを入れるまで）
```

- DB のマイグレーションは無い（`calendar` / `calendar_event` / `setting` は M0 からある）
- `turnlane self-install` はヘルパを登録しない。ヘルパは S1 の確認の後で下の 3 で入れる

## 2. S1 を確かめる（カレンダーの権限がヘルパに付くか）

[docs/spikes/s1-eventkit-tcc.md](../spikes/s1-eventkit-tcc.md) の「オーナーが実行する S1 の確認手順」の 0〜5 を行う
（証明書の用意、ビルド、`open … --authorize` でダイアログ、システム設定の表示、launchd から `--probe`、再ビルド後の許可）。
結果を PO に返す。失敗したら 3 は行わず、カレンダーなしで常用を始める（D-044 (1)）。

## 3. ヘルパを常駐させる（S1 が合格したら）

```sh
TURNLANE_CODESIGN_IDENTITY="Apple Development: <名前> (<ID>)" bun run build:helper   # S1 と同じ署名で
turnlane calendar install --app out/TurnlaneCalendarHelper.app
turnlane calendar status
```

- `turnlane calendar install` は `.app` を `~/Applications/TurnlaneCalendarHelper.app` に写し（`ditto`）、
  `~/Library/LaunchAgents/dev.turnlane.calendar-helper.plist`（`KeepAlive`、ログインセッションだけ）を書いて登録する。
  2回目以降は登録済みのヘルパを止めて入れ替える。`--dry-run` で書く内容だけを表示する
- `turnlane calendar status` が「Helper: 接続中 0.1.0 · 権限: フルアクセス」になり、`Calendars: N（source N、…）` と
  `Holidays from: …` が出る
- 権限が「未決定」なら `turnlane calendar authorize`（ダイアログを出す）。「拒否」ならシステム設定 > プライバシーとセキュリティ > カレンダー で
  TurnlaneCalendarHelper をオンにする
- ヘルパのログは `~/Library/Logs/turnlane/calendar-helper.log`（題名は出ない）、デーモン側は `turnlane daemon logs`（`calendar.synced` の件数）

外すとき: `turnlane calendar uninstall`（LaunchAgent と `~/Applications` の `.app` を消す。権限の項目はシステム設定に残る）。

## 4. 予定とカレンダーの役割

```sh
turnlane calendar calendars                       # 一覧（ID・名前・アカウント・役割・祝日・件数）
turnlane calendar calendars --role <id> ignored   # 週ボードにも放置の計算にも使わない（ID は末尾の8文字ほどでよい）
turnlane calendar calendars --role <id> source    # 戻す
turnlane calendar sync                            # すぐ取り直す（普段は変更通知・5分ごとに自動）
```

- 新しく見つかったカレンダーはすべて `source`（週ボードに出て、busy な予定は放置から外れる）。共有の他人のカレンダーなど、
  自分の予定でないものは `ignored` にする
- 週ボードに出るのは役割が `source` の予定。自分が辞退した予定・取り消された予定は出るが busy にならない（会議中にしない）
- 書き戻し先（`writeback`）は段階 B（M3-3）で選べるようになる

## 5. 稼働日と祝日

```sh
turnlane calendar status                          # Holidays from: <名前>（自動）と今後の祝日、Next workday
turnlane calendar holidays                        # 祝日カレンダーと窓の中の祝日
turnlane calendar holidays --set <id> [<id>...]   # 手で選ぶ（以後は自動判定しない）
turnlane calendar holidays --none                 # 祝日なし（曜日だけ）
turnlane calendar holidays --auto                 # 自動判定に戻す
turnlane config get workdays.weekdays             # 稼働曜日（ISO: 月=1 … 日=7。既定 [1,2,3,4,5]）
turnlane config set workdays.weekdays '[1,2,3,4,5,6]'
turnlane doctor                                   # 最後に「カレンダー: …」「Holidays from: …」
```

- 祝日カレンダーの自動判定: 書き込み不可で誕生日カレンダーでない・窓内の予定がすべて終日で9割以上が1日だけ・1件以上ある
  カレンダー（名前は見ない）。共有の休暇カレンダーなどを誤って採ったら `--set` で選び直す
- 祝日カレンダーを `ignored` にしても祝日の判定には使う（週ボードの終日の行には出なくなる）
- 稼働日でない未来日（土日・祝日）は週ボードのヘッダに Free を出さない（D-049 (2)）。持ち越し先の判定（M4-2）も同じ規則を使う
- `turnlane config` で変えられるのは既知のキーだけ（`turnlane config get` で一覧）。値は JSON で検証され、不正なら変えない

## 6. 段階 A の完了条件を確かめる（phase0-plan 4.5）

| 条件 | 確かめ方 |
|---|---|
| Calendar.app で追加した会議が1分以内に週ボードへ出る | 週ボードを開いたまま Calendar.app で今日に予定を足す → 数秒で出る（ヘルパの変更通知 → 2秒束ねて同期 → SSE）。出なければ `turnlane calendar status` の Last sync と `turnlane calendar sync` |
| 会議中の待ちが放置に入らない（自分の記憶と照合） | 会議の前に AI に質問させて放置にし、会議の後で返答する → 週ボードの Idle と AI 詳細パネルの内訳で、会議の時間が `in meeting`（集計外）になり Idle に入っていない。会議を `ignored` のカレンダーに移すと Idle に戻る |
| `turnlane calendar status` に祝日カレンダー（または「なし」）が出る | `Holidays from: <名前>（自動）` か `none`。今後の祝日の日付と名前が出る |
| 金曜や祝日の前日に `nextWorkday` が正しい日を返す | 金曜・祝日の前日に `turnlane calendar status` の `Next workday` を見る（金曜 → 月曜、祝日の前日 → 祝日の翌稼働日） |

## 7. うまくいかないとき

```sh
turnlane calendar status                 # 接続・権限・最後の同期とエラー
turnlane daemon logs | grep calendar     # calendar.helper_connected / calendar.synced / calendar.sync_failed
tail ~/Library/Logs/turnlane/calendar-helper.log   # bridge.connected / bridge.connect_failed / authorization.changed
launchctl print gui/$(id -u)/dev.turnlane.calendar-helper | head -20
```

- 「カレンダー未接続」のまま: ヘルパが動いていない（`launchctl print` の state）、またはデーモンのポート・トークンが違う
  （`TURNLANE_PORT` / `TURNLANE_DATA_DIR` を使っているなら `turnlane calendar install` を同じ環境変数で実行し直す）。
  ヘルパは 1 秒 → 30 秒の間隔で接続し直すので、デーモンの再起動の後も自動で戻る
- 「権限なし」: `turnlane calendar authorize`。ad-hoc 署名でヘルパを作り直した後は許可が外れることがある（S1 の手順 5）
- 予定が古い: `turnlane calendar sync`。Mac のカレンダー自体の同期（Google などのアカウント）が遅れている場合は Calendar.app の更新を待つ
