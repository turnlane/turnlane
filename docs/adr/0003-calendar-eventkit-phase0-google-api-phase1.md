# ADR 0003: カレンダーは Phase0 で EventKit、Phase1 で Google Calendar API を追加

- ステータス: Accepted / Amended by [ADR 0008](./0008-mit-no-server-open-source.md)（「Phase1 で Google Calendar API 直結を追加」は Superseded。Google API 直結はやらず、カレンダーは EventKit のみ。EventKit に関する決定は有効）/ Amended by [ADR 0010](./0010-desktop-shell-in-phase0-as-daemon-client.md)（「Tauri シェルを導入したらヘルパの役割を Tauri 側へ移す」は取り消し。ヘルパは当面別のまま、統合は M6 で再検討）/ Amended by [ADR 0011](./0011-single-app-bundle-smappservice.md)（Proposed。配布版ではヘルパを Dayline.app に同梱し、SMAppService の LaunchAgent として登録する）/ 2026-10-05 追記あり（末尾。書き戻し先の既定を Calendar.app の新規イベントのデフォルトカレンダーにする。Decision の「書き戻し先は専用カレンダー `Dayline` だけ」を補正） / Amended by [ADR 0012](./0012-events-in-calendar-tasks-stay-local.md)（2026-10-07。時間ブロックの書き戻しをやめ、2026-10-05 の2つの追記を置き換える。予定は dayline から作成・編集してデフォルトカレンダーへ書く。EventKit・ヘルパ・署名の決定は有効）
- 日付: 2026-10-02

## Context

- 週ボード・デイビューにカレンダーの予定を表示し、時間ブロックをカレンダーへ書き戻したい。書き戻した予定はスマホのカレンダーにも出てほしい。
- Google Calendar API は OAuth の同意画面と、公開時には sensitive scope の審査が必要になる。トークン管理と変更通知の更新ジョブも要る。
- macOS の EventKit なら、Mac のカレンダーに登録済みの全アカウント（Google, iCloud, Exchange 等）を OAuth なしで読める。書き込んだ予定はアカウント側へ同期される。
- EventKit のカレンダー権限（TCC）は要求したプロセスの bundle ID に帰属する。Bun のデーモンや、その子プロセスから要求すると権限の帰属先が署名の無い bun になり、更新のたびに失われる恐れがある。

検討経緯は非公開の戦略ドキュメントにある。

## Decision

- **Phase0 は EventKit** で読み書きする。
  - EventKit へのアクセスは小さな Swift アプリ **`DaylineCalendarHelper.app`**（LSUIElement、bundle ID `dev.dayline.calendar-helper`）に置く。独立した LaunchAgent として常駐させ、デーモンへ WebSocket クライアントとして接続し、JSON-RPC で要求に応える。
  - 書き戻し先は専用カレンダー **`Dayline`** だけにする。既存の予定は書き換えない。Google アカウント配下のカレンダーは EventKit から作れない可能性が高いため、Phase0 ではユーザーが Web で一度だけ作成し、設定画面で選ぶ。
  - dayline が書いた予定の目印は `url = dayline://timeblock/<id>` とする。
  - 署名は Apple Development 証明書を使う（ad-hoc 署名は再ビルドで TCC の許可が外れることがある）。
- **Phase1 で Google Calendar API 直結**を追加する。スコープは読み取りに `calendar.events.readonly`（+ `calendar.calendarlist.readonly`）、書き込みに `calendar.app.created` を使い、アプリが作ったカレンダーだけを操作する。Mac 版では EventKit と Google API をユーザーが選べるようにし、Web / モバイル版は Google API のみとする。
- Phase1 で Tauri シェルを導入したら、ヘルパの役割は Tauri 側へ移す。

## Consequences

- Phase0 は OAuth・審査なしで今日から使える。会社用など複数アカウントの予定もまとめて見える。
- Phase0 は Mac 専用になり、予定の鮮度は Mac のカレンダー同期間隔に依存する。
- Swift のヘルパと LaunchAgent が増え、TCC の挙動（launchd 配下での帰属、再ビルド後の許可の維持）を先に検証する必要がある（phase0-plan の S1）。
- 書き込み先を専用カレンダーに限定するので、既存の予定を誤って壊す事故を構造的に防げる。
- Phase1 で Google API を足す際、`calendar` テーブルの `provider` で両方を扱える形にしておく。

## 追記（2026-10-05）: 書き戻し先の既定は Calendar.app のデフォルトカレンダー（Amended。2026-10-07 に ADR 0012 で置き換え）

### Context

専用の `Dayline` カレンダーを Google カレンダー（Web）で作って選ぶ準備が、使い始めの障害になった。利用者が期待するのは「Mac のカレンダーアプリで予定を作ったときと同じ挙動」で、どのアカウントに同期されるかも Calendar.app の設定に従ってほしい。

### Decision（Decision の「書き戻し先は専用カレンダー `Dayline` だけ」を次のとおり補正する）

- 書き戻し先の**既定は Calendar.app の「新規イベントのデフォルトカレンダー」**（EventKit の `defaultCalendarForNewEvents`）とする。準備なしで書き戻しが動く。
  - 既定のときは、ヘルパが**書き込むたびに**デフォルトカレンダーを解決する。利用者が Calendar.app の設定でデフォルトを変えたら、以後の新しい予定はそちらへ書く。
  - デフォルトカレンダーが無い・書き込めないときは書かずにエラー（`no_default_calendar` / `not_writable`）にし、設定画面に案内を出す。
  - デフォルトカレンダーが途中で変わっても、**既に書いた予定は元のカレンダーに置いたまま更新する（移さない）**。Calendar.app でデフォルトを変えても既存の予定のカレンダーが変わらないのと同じ。
- 設定で特定のカレンダー（専用の `Dayline` など）を選ぶこともできる（従来の役割 `writeback`）。書き戻しをオフにもできる。
- 既定のカレンダーには利用者の他の予定が入っている。**dayline が触るのは目印（`url = dayline://timeblock/<id>`）の付いた自分の予定だけ**とし、ヘルパは目印の無い予定の更新・削除を拒む。読み取り側では目印で自分の予定と見分け、予定の表示・空き時間・放置の計算で二重に数えない。
- ヘルパの版は 0.3.0（`upsertEvent` の `calendarId` を省略可、`listCalendars` に `isDefault`）。

### この追記の Consequences

- 利用者は書き戻しのために何も用意しなくてよい。スマホに出るかは Calendar.app のデフォルトカレンダーのアカウント次第になる（Google のカレンダーなら Google カレンダーのアプリにも出る）。
- 「専用カレンダーに限定して既存の予定を誤って壊す事故を構造的に防ぐ」は、既定では成り立たなくなる。代わりに、ヘルパ側の目印の確認（目印の無い予定は更新・削除しない）で守る。

## 追記（2026-10-05）: 書き戻しを使い始めたとき、過去の時間ブロックは書かない（Amended。2026-10-07 に ADR 0012 で置き換え）

### Context

上の追記の実装では、書き戻しを新しく使い始めると「7日前より後に終わる時間ブロック」をまとめて書いていた。既定の書き先は Calendar.app のデフォルトカレンダーで、それが仕事用の Google カレンダーなら、過去のブロックが同僚にも見える予定として一度に大量に作られる。Calendar.app で操作したのと同じなら、過去の予定を後から大量に作ることはない（D-073）。

### Decision

- 書き戻しを**使い始めたとき**（初回の有効化、ヘルパが 0.3.0 になって既定の書き戻しが動き始めたとき、書き先の変更、オフから戻したとき）は、**終わりがその時点より後の時間ブロックだけ**を書く。それより前に終わっていて一度も書いていないブロックは書かず、状態を `disabled`（「書き戻しを始める前のブロック」）にする。
- 使い始めの書き先と時刻はデーモンが保存する（設定 `calendar.writeback_started`）。書き先が変わる・オフにすると、次に書ける状態になった時点が新しい使い始めになる。
- 使い始めの後に利用者が作成・移動したブロックは、過去の時刻でも従来どおり書く（利用者の操作なので）。
- 既に書いた予定の更新・削除は従来どおり。書き先を変えたときに書き直すのは終わりが今より後のブロックだけで、既に終わったブロックの予定は前の書き先に置いたままにする。

### この追記の Consequences

- 入れ替えや書き先の変更のたびに、利用者が先に書き戻しをオフにする回避策は要らない。
- 書き戻しを始める前の過去のブロックは実カレンダーに出ない。詳細パネルにその旨を出す。必要なら利用者がブロックを動かせば書かれる。
