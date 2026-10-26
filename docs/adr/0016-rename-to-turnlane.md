# ADR 0016: 名前を Turnlane に変え、旧名（dayline）の導入を self-install で移す

- ステータス: Accepted
- 日付: 2026-10-08
- 関係: Amends [ADR 0011](./0011-single-app-bundle-smappservice.md)（配布物・LaunchAgent・CLI・データの場所の名前と、決定 8 の移行）、[ADR 0012](./0012-events-in-calendar-tasks-stay-local.md)（予定の目印の URL）。PO 決定 D-089・D-091・D-124・D-127。既存の ADR の本文の旧名（dayline、`dl`、`dev.dayline.*`）は書き換えず、この ADR の対応表で読み替える

## Context

- 公開名を Turnlane に決めた（D-089）。CLI は短縮形を作らず `turnlane`（`dl` は多くの人がシェルのエイリアスに使っている）。bundle ID の接頭辞は取得したドメイン turnlane.dev に合わせて `dev.turnlane.`（D-091）。
- 公開の前（D-095）で、利用者は作者だけ。ただし作者の環境には旧名の導入（LaunchAgent・`~/.local/bin` のバイナリ・アプリ・カレンダーヘルパ・データ・hooks の設定）があり、データ（タスク・取り込み・日報）を失えない。
- macOS の許可（カレンダー・通知・オートメーション）は bundle ID と署名の識別子で覚えるので、名前を変えると入れ直しになる（ADR 0011 の Consequences）。
- カレンダーには旧名の目印（`dayline://event/`、M3-3 の `dayline://timeblock/`）の付いた予定が残っている。hooks の設定には旧名の目印（`--managed-by dayline`）のエントリが残っている。

## Decision

1. **名前の対応**（既存の ADR・スパイクの記録はこの表で読み替える）:

   | 対象 | 旧 | 新 |
   |---|---|---|
   | 製品名（画面・通知・メニューバー・アプリ名） | dayline | Turnlane |
   | CLI | `dl` | `turnlane`（`dl` の別名は残さない） |
   | 常駐デーモン | `daylined` | `turnlaned` |
   | デスクトップアプリ | `Dayline.app`（`dev.dayline.desktop`） | `Turnlane.app`（`dev.turnlane.desktop`） |
   | カレンダーヘルパ | `DaylineCalendarHelper.app`（`dev.dayline.calendar-helper`） | `TurnlaneCalendarHelper.app`（`dev.turnlane.calendar-helper`、版 0.6.0） |
   | LaunchAgent | `dev.dayline.daemon` / `.calendar-helper` / `.desktop` | `dev.turnlane.daemon` / `.calendar-helper` / `.desktop` |
   | バイナリの署名の識別子 | `dev.dayline.daylined` / `dev.dayline.dl` | `dev.turnlane.turnlaned` / `dev.turnlane.turnlane` |
   | データの場所 | `~/Library/Application Support/dayline/`（`dayline.db`） | `~/Library/Application Support/turnlane/`（`turnlane.db`） |
   | ログの場所 | `~/Library/Logs/dayline/` | `~/Library/Logs/turnlane/` |
   | 日次バックアップ | `backups/dayline-YYYYMMDD.db` | `backups/turnlane-YYYYMMDD.db` |
   | 環境変数 | `DAYLINE_*`（`DAYLINE_CODESIGN_IDENTITY` を含む） | `TURNLANE_*`（旧の変数は読まない。残っていれば名前の変更を知らせる） |
   | パッケージ | `@dayline/*`（Vite の alias `@dayline/ext-*`） | `@turnlane/*`（`@turnlane/ext-*`） |
   | URL スキーム（予定の目印） | `dayline://event/` | `turnlane://event/` |
   | hooks の目印 | `--managed-by dayline` | `--managed-by turnlane` |
   | MCP サーバ名 | `dayline` | `turnlane` |
   | ブラウザの保存のキー | `dayline.*` | `turnlane.*` |
   | ADR 0011 の CLI の固定の場所 | `~/Library/Application Support/dayline/bin/dl` | `~/Library/Application Support/turnlane/bin/turnlane` |

   データの場所は今までの規約（小文字の製品名）に合わせて小文字の `turnlane` にする。

2. **旧名で残ったものを読み続ける**（書かない）:
   - 予定: `dayline://event/` の予定も Turnlane が作った予定として扱う（編集できる・作った印）。新しく作る予定は `turnlane://event/`。M3-3 の時間ブロックの予定は旧名の版だけが書いたので、目印は `dayline://timeblock/` のまま判定・削除する。
   - hooks: `--managed-by dayline` のエントリも自分のものとみなす。`turnlane hooks install` は同じ位置で新しいコマンドに置き換え（Codex の他ツールの承認の位置を動かさない）、`uninstall` は外す。
   - 取り込み: 旧の要約の作業ディレクトリ（`…/dayline/summarize`）のセッションも取り込まない。
   - ブラウザの保存: 起動時に `dayline.*` を `turnlane.*` へ写して消す（新しいキーに値があれば上書きしない）。
   - 旧名の文字列は `packages/core/src/legacy.ts`・`apps/cli/src/commands/migrate.ts` などの決まった場所に集め、`scripts/check-names.ts`（テストから実行）が他の場所の旧名を検出する。

3. **移行は `turnlane self-install` が行う**（ADR 0011 の決定 8 の `dl setup migrate` は作らない。配布版の移行は M6 で改めて決める）。旧の導入を見つけたら、新しいバイナリを置いた後、新しいデーモンを起こす前に:
   1. 点検（何も変えない）: 旧と新の両方に DB があれば止める。旧の LaunchAgent が `DAYLINE_DATA_DIR` / `DAYLINE_LOG_DIR` で場所を変えていれば止める。`TURNLANE_DATA_DIR` / `TURNLANE_LOG_DIR` で新しい場所を変えていれば止める
   2. 旧の LaunchAgent 3つを bootout して外れるまで待ち、plist を消す。旧のアプリが動いていれば終わらせる
   3. ポートで旧のデーモンが応答しないことを確かめ、移行前のバックアップ `backups/pre-rename-<時刻>.db` を取り（VACUUM INTO）、DB を新しい場所の `turnlane.db` へ VACUUM INTO で写してから旧の DB を消す（rename ではなく写すのは、WAL の中身を含めた一貫した写しにするため）
   4. 残りのデータ・ログを項目ごとに rename で移す。新しい場所に同じ名前があれば上書きしない（spool は追記してまとめ、他は `<名前>.from-dayline` で残す）
   5. hooks の設定のうち旧の目印のエントリだけを、hooks install と同じ流儀（書き換え前のバックアップ `.bak-turnlane-<時刻>`、読み込み後の変更の検出、未知キーを足さない）で置き換える
   6. 旧の CLI・デーモン（`--version` で旧のものと確かめてから）、旧のアプリとヘルパ（bundle ID で確かめてから）を消す
   7. 旧のヘルパを入れていれば新しいヘルパを入れ直し、許可（カレンダー・通知・オートメーション）の入れ直し、Codex の `/hooks` の承認、MCP の登録のし直しを案内する

   どの段も今の状態を見て済んでいなければ行うので、途中で失敗しても同じコマンドで続きから進む。旧の CLI を消すのは最後。`--dry-run` は何をするかを表示するだけ。

4. **変えないもの**: 既存の ADR の本文、スパイクの記録（`spikes/`・`docs/spikes/`）、適用済みのマイグレーションの SQL、過去の画面の画像、手元のリポジトリのディレクトリ（`~/source/dayline`。D-127。公開の新しい履歴を作る M6-7 で変える）、CSS の設計トークンの接頭辞 `--dl-`（コマンドではない内部の名前）。利用者のデータの中の名前（プロジェクト名など）には触れない。

## 検討した案

| 案 | 内容 | 評価 |
|---|---|---|
| **A. self-install が旧の導入を見つけて移す（採用）** | 入れ替えと同じコマンドで移行まで終わる | 開発時の配置（ADR 0011 の `dev`）の入れ替えの手順が変わらない。一時 HOME で全体をテストできる |
| B. 別のコマンド（`turnlane migrate`）にする | 移行だけを明示的に実行 | 入れ替えの前に打ち忘れると、新しいデーモンが空の DB を作り、旧と新の両方に DB ができる |
| C. データの場所は旧名のまま使う | ADR 0011 の決定 8 と同じ | 公開後の利用者に旧名の場所が見え続ける。公開前の今しか変えられない |
| D. `dl` を `turnlane` の別名として残す | 打ち慣れた名前が使える | D-089 で短縮形を作らないと決めた（`dl` は多くの人のエイリアスとぶつかる） |

## Consequences

- 作者の環境では、`turnlane self-install` の1回でデータと hooks が移る。カレンダー・通知・オートメーションの許可は入れ直しになる（新しい bundle ID・識別子のため）。
- 旧のヘルパ（0.5.0 以前）は新しい目印の予定を作れないので、予定の作成・編集に要るヘルパの版を 0.6.0 に上げた。
- 旧名の文字列は決まった場所にだけ残る。公開前の監査（M6-7）では、旧名の読み替えの部分（予定・hooks の目印、移行）を残すかを決める（公開版の利用者には旧の導入が無い）。
- ブラウザのクッキーの名前も変わるので、ブラウザで開いている画面は `turnlane open` で開き直す。
- **決着（2026-10-15、D-203）**: 公開版の利用者には旧の導入が無く、作者の環境の移行も済んだ（旧のデータの場所・旧の LaunchAgent・hooks の旧の目印が残っていないことを確かめた）ので、名前の移行のコードを公開前に外した。外したのは決定 3 の `turnlane self-install` の移行（`apps/cli/src/commands/migrate.ts` とテスト）、`legacy.ts` の旧の配置の定義、決定 2 の hooks の旧の目印（`--managed-by dayline`）の扱い、旧の要約の作業ディレクトリの除外、ブラウザの保存の旧のキーの写し、旧の環境変数（`DAYLINE_*`）の名前の変更の案内、旧名の導入からの入れ替えの手順（`docs/dev/rename-turnlane.md`）。残したのは決定 2 の予定の読み取りだけで、旧名で作った予定を編集できるように `dayline://event/` を Turnlane が作った予定として扱い、`dayline://timeblock/` の時間ブロックの予定を判定・削除する（`packages/core/src/legacy.ts`。`scripts/check-names.ts` の許可もこの2つの目印に絞った）。開発時の配置からアプリの配置への移行（`turnlane setup migrate`、M6-16）は名前の移行とは別のもので、残している。
