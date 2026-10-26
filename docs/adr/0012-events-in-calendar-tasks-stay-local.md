# ADR 0012: タスクと予定を分ける。予定は dayline から Calendar.app へ書き、タスクの時間ブロックはカレンダーへ書かない

- ステータス: Accepted / Amends [ADR 0003](./0003-calendar-eventkit-phase0-google-api-phase1.md)（2026-10-05 の2つの追記（時間ブロックの書き戻し先の既定、使い始めに過去のブロックを書かない）と、Decision の「時間ブロックをカレンダーへ書き戻す」「目印は `dayline://timeblock/<id>`」を置き換える。EventKit・ヘルパ・署名の決定は有効）。Amended by [ADR 0016](./0016-rename-to-turnlane.md)（予定の目印は turnlane://event/。旧名の目印も読む）
- 日付: 2026-10-07
- 関係: PO 決定 D-093。D-072・D-073・M3-3 の「タスクの時間ブロックの書き戻し」をやめる。設計の詳細は [phase0-plan.md](../spec/phase0-plan.md) 1.5 のプロトコルと 4.5 の「D-093 の方式」、[ux-mvp.md](../spec/ux-mvp.md) 4.5・4.12・4.13・7章、[m2-api.md](../spec/m2-api.md) 24章

## Context

- M3-3 では、タスクを時間軸に置くとその時間ブロックを Calendar.app のデフォルトカレンダーへ予定として書いていた（D-072）。オーナーにとってタスクと予定は別の概念で、タスクの時間ブロックがカレンダー（同僚にも見える予定）に出る必要は無い。
- 一方で、dayline から予定そのものを作れない。デイビューの「予定」のレーンでドラッグしても何も起きず、予定を作るには Calendar.app を開く必要があった。
- 既定のカレンダーには利用者の他の予定（参加者のいる会議を含む）が入っている。dayline から既存の予定を動かすと、参加者に変更の通知が飛ぶ・繰り返しの予定の一部だけが切り離される、といった事故が起こりうる。
- これまでに書いた時間ブロックの予定（`url = dayline://timeblock/<id>`）が利用者のカレンダーに残っている。

## Decision

1. **タスク（時間ブロックを含む）は dayline の中だけ**。カレンダーには書かない。書き戻しのキュー・状態（`pending` / `synced` / `error` / `disabled`）・Calendar.app 側の変更の取り込み（ブロックへの反映）はやめる。`time_block` の書き戻しの列は残すが使わない（DDL は変えない）。
2. **予定の正は Mac のカレンダー**。dayline から予定を作る・動かす・伸ばす・消す・題名を変える・カレンダーを変えると、ヘルパが EventKit で書く。
   - 作る先は Calendar.app の「新規イベントのデフォルトカレンダー」（D-072 の解決の仕組み。書くたびにヘルパが解決する）。作った予定の目印は `url = dayline://event/<uuid>`。
   - 書き込みは同期の RPC（キューに積まない）。UI は楽観的に更新し、失敗したら戻してトーストを出す。Calendar.app 側の変更は従来の同期（変更通知と5分ごと）で取り込む。
3. **dayline から編集できる予定**は、次のすべてを満たすものだけ: 書き込めるカレンダー（`allowsContentModifications`）、参加者がいない（`attendees` が空）、繰り返しでない、終日でない、時間ブロックの目印（`dayline://timeblock/`）が付いていない。dayline で作った予定もこの条件で判定する（Calendar.app で参加者を足したら読み取り専用になる）。それ以外は従来どおり読み取り専用で「Calendar.app で開く」。ヘルパも同じ条件を確かめ、満たさない予定は更新・削除しない（`not_editable`）。
4. **これまで書いた時間ブロックの予定の削除**は、利用者が確認して実行する（自動では消さない）。対象は `url` が `dayline://timeblock/` で始まる予定だけで、ヘルパの専用の RPC（`listTimeblockEvents` / `deleteTimeblockEvent`）がその条件を確かめてから消す。`url` が落ちた予定・`dayline://event/` の予定・目印の無い予定は対象にしない。件数と期間を先に出し、確認の後に消す（`dl calendar cleanup-timeblocks [--dry-run]`、設定の「カレンダー」節のボタン）。
5. 読み取り側は、時間ブロックの予定（`dayline://timeblock/`）を従来どおり予定のレーン・空き時間・放置・日報の会議時間に数えない（削除するまでの間、二重に見えないように）。
6. 書き戻し先の選択（役割 `writeback`、設定 `calendar.writeback`、`dl calendar writeback`、専用の `Dayline` カレンダーの作成）はやめる。役割が `writeback` だったカレンダーは `ignored` にする（中身は時間ブロックの予定だけの想定）。
7. ヘルパの版は **0.4.0**。`fetchEvents` に `hasAttendees` と `recurring`、予定の `createEvent` / `updateEvent` / `removeEvent`、時間ブロックの予定の `listTimeblockEvents` / `deleteTimeblockEvent` を足し、`upsertEvent` / `deleteEvent` / `listSources` / `createCalendar` を外す。

## Consequences

- タスクを時間に置いても利用者のカレンダー（同僚から見える予定）は変わらない。予定とタスクを作るときに、どちらを作るかを選ぶ操作が増える（デイビューはレーン、3日ボード・週表示は入力欄の切り替え）。
- 予定を dayline から作れる。参加者のいる会議・繰り返しの予定を dayline から誤って動かす事故は、デーモンとヘルパの両方の条件で防ぐ。
- 予定の書き込みはヘルパの接続と 0.4.0 が前提になる。古いヘルパでは予定はすべて読み取り専用になり、作成は `helper_outdated` で失敗する（他の機能は動く）。
- 時間ブロックの予定は、利用者が削除を実行するまでカレンダーに残る。
