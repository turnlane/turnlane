# ADR 0017: 拡張点の版（EXT_API_VERSION）は、足すときは上げず、変える・消すときに上げる

- ステータス: Accepted（PO の確認）
- 日付: 2026-10-08
- 関係: Amends [ADR 0015](./0015-extension-points-and-separately-licensed-additions.md)（Consequences の「拡張点の型は公開の API になるので、変えるときは `EXT_API_VERSION` を上げる」を具体にする）

## Context

- ADR 0015 は、拡張点の型を変えるときは `EXT_API_VERSION` を上げ、版の合わない拡張は組み込まない、と決めた。何が「変える」に当たるかは決めていない。
- 拡張点は、使う拡張ができたときに足していく（使う側が無い拡張点は形を誤りやすい）。足すたびに版を上げると、既存の拡張は中身が何も壊れていなくても組み込まれなくなる。
- 版の検査は完全一致（`ext.apiVersion !== EXT_API_VERSION` なら読み飛ばす）。

## Decision

1. **上げない（互換の追加）**: 既存の拡張がそのまま型検査を通り、同じ動作をする変更。
   - `ExtDeps`・`WebExtension`・`DaemonExtension` に、任意のフィールド・新しい部品・新しいメソッドを足す（例: `calendar.events`、`timelineMarks`）
   - 既存のメソッドに、任意の引数を足す・オーバーロードを足す（既存の呼び方の型と戻り値は変えない。例: `launcher.launch` の `{ unattended: true }`）
   - 拡張に渡す型（引数の型）に任意のフィールドを足す、`@turnlane/ext-host` に部品を足す（例: `LaunchRow`）
   - 既存の欄に、省略したときは今と同じになる選択肢を足す（例: `ExtLaunchField.layout` の既定は `row`）
2. **上げる（互換でない変更）**: 既存の拡張の型検査か動作が変わりうる変更。
   - フィールド・メソッド・`@turnlane/ext-host` の部品を消す、名前を変える
   - 型を変える（任意を必須にする、引数の型を狭める、既存の呼び方の戻り値の型を広げる、文字列の値の集まりから値を消す）
   - 既存の拡張点の意味を変える（呼ぶ時期・順番・描く場所、認証、テーブルの接頭辞の規則など）
3. 上げるときは、同じ変更でテスト用の拡張（`test/ext-fixture/`）の版も上げ、変更の中身を `docs/spec/m2-api.md` の 28 章に書く。
4. 迷ったら上げる側に倒す（版の合わない拡張は組み込まれないだけで、データは壊れない）。

## Consequences

- 拡張点を足すだけなら、既存の拡張を作り直さずに組み込める。
- 互換の追加でも、新しい部品を使う拡張は古い本体では型検査が通らない。拡張は本体の特定の版（タグ）に合わせてビルドするので、これは版の検査ではなくビルドで分かる。
- 戻り値を広げたいときは、既存の呼び方を変えずに新しい呼び方（任意の引数・オーバーロード）を足す。

## 追記（2026-10-11）: 一日を閉じるの手順・サイドバー・ポップオーバーの行・電源の状態・利用枠・エラーの種類は版を上げない

次の追加は、決定 1 の「任意のフィールド・新しい部品・新しいメソッドを足す」に当たるので `EXT_API_VERSION` は 1 のまま（テスト用の拡張の版も 1 のまま）。中身は [m2-api.md](../spec/m2-api.md) 28 章。

- `WebExtension` の任意のフィールド `shutdownSteps`・`sidebarItems`・`trayItems`、`@turnlane/ext-host` の部品 `SidebarNotice`・`TrayRow`
- `ExtDeps.power.state()`、`ExtDeps.limits.claude(account?)`（新しい部品とメソッド）
- `TaskAiView.errorKind?`（拡張に渡す型の任意のフィールド）
- 本体が起動する Claude Code に `--settings` で statusLine の受け口を渡すのは本体の起動の中身の変更で、拡張点の型・意味は変えない（`launcher.launch` の呼び方と戻り値は同じ）
