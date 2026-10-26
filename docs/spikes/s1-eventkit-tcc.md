# S1: EventKit ヘルパの TCC の帰属（launchd 配下で権限が通るか）

- 状態: **自動で確かめられる部分は合格。権限のダイアログと launchd 配下の読み取りはオーナーの確認待ち**（下の「オーナーが実行する確認手順」）
- 関連: [ADR 0003](../adr/0003-calendar-eventkit-phase0-google-api-phase1.md)、phase0-plan 1.5・4.1（S1）・4.5（M3-1）
- 日付: 2026-10-04

## 確かめたいこと

カレンダーの権限（TCC）は、権限を求めたプロセスではなく「責任のあるプロセス（responsible process）」に付く。
Bun のデーモンや、その子プロセスから EventKit を呼ぶと、権限の帰属先が署名の無い bun や Terminal になり、
更新のたびに外れる恐れがある（ADR 0003）。そこで EventKit を小さな Swift の `.app` に置き、
LaunchAgent として launchd から直接起動して、**ヘルパ自身（`dev.dayline.calendar-helper`）の名前で**フルアクセスを得られるかを確かめる。

合格条件（phase0-plan 4.1 の S1 から、書き戻しの部分を除いたもの）:

1. 権限のダイアログにヘルパの名前（DaylineCalendarHelper）が出る
2. システム設定 > プライバシーとセキュリティ > カレンダー に **DaylineCalendarHelper** が出る（Terminal や bun ではない）
3. **launchd から起動したヘルパが**、ダイアログ無しで予定を読める（`authorization: fullAccess`、予定の件数が出る）
4. `EKEventStoreChanged` を受け取れる（Calendar.app で予定を変えると通知が来る）
5. 同じ証明書で再ビルドしても許可が残る（Apple Development 署名の場合。ad-hoc 署名では外れうる）

`Dayline` カレンダーへの作成・削除（書き戻し）は段階 B（M3-3）で確かめる。段階 A のヘルパは読み取りだけを持つ。

## 作ったもの

- `native/calendar-helper/`（SwiftPM。macOS 14 以降）
  - `Resources/Info.plist`: `CFBundleIdentifier = dev.dayline.calendar-helper`、`LSUIElement = true`、
    `NSCalendarsFullAccessUsageDescription`（macOS 14 以降の Full Access の文言）
  - `Sources/CalendarHelper/`: `main.swift`（起動の振り分け）、`EventStore.swift`（EventKit と、EventKit を使わない偽物）、
    `Bridge.swift`（デーモンへの WebSocket クライアント。JSON-RPC 2.0、再接続 1s → 30s）、`Config.swift`、`Log.swift`
  - 起動のしかた: 常駐（引数なし）/ `--authorize`（ダイアログを出して終了）/ `--probe [--watch N]`（権限と件数を記録して終了）/
    `--self-test`（EventKit に触れずにバンドル情報だけを記録）/ `--fake-store`（EventKit の代わりに固定のダミー）
  - ログ（`~/Library/Logs/dayline/calendar-helper.log`）はメタデータだけ。予定の題名・場所・参加者は書かない
- `native/calendar-helper/scripts/build-app.sh`: `swift build` → `.app` の組み立て → `codesign`。
  `DAYLINE_CODESIGN_IDENTITY` があればその証明書、無ければ ad-hoc で署名する（出力は `out/DaylineCalendarHelper.app`）
- `native/calendar-helper/scripts/s1-launchd-probe.sh`: S1 の手順 3・4 用。一時的な LaunchAgent
  （`dev.dayline.calendar-helper.s1`）で `--probe --watch` を launchd から起動し、終わったら外す
- `scripts/check-calendar-helper.ts`（`bun run check:helper`）: 下の自動確認

## 自動の確認の結果（2026-10-04、macOS 26.6、Swift 6.2）

`bun run check:helper` の結果。EventKit・TCC・launchd には触れていない（オーナーのカレンダー権限は変えていない）。

| 確認 | 結果 |
|---|---|
| `build-app.sh` で `.app` ができる | ok |
| `CFBundleIdentifier = dev.dayline.calendar-helper` | ok |
| `LSUIElement = true` | ok |
| `NSCalendarsFullAccessUsageDescription` がある | ok |
| `plutil -lint` | ok |
| コード署名の識別子が `dev.dayline.calendar-helper`、`codesign --verify --strict` が通る | ok（ad-hoc。この Mac には署名用の証明書が無い: `security find-identity -v -p codesigning` が 0 件） |
| `open`（LaunchServices）で `.app` として起動できる（`--self-test`。親プロセスは launchd、`activation_policy = accessory` で Dock に出ない） | ok |
| `--fake-store` のヘルパが一時 HOME のデーモン（空いているポート）に WebSocket で接続し、デーモンがカレンダー2件・予定を同期する。祝日カレンダーの自動判定も通る | ok |
| ヘルパのログに予定の題名が出ない | ok |

ad-hoc 署名の指定要件（designated requirement）は `cdhash H"..."` で、ビルドのたびに変わる。TCC は許可をこの要件で覚えるので、
**ad-hoc のままだと再ビルド（dayline の更新）のたびに許可が外れる見込みが高い**。常用には Apple Development 証明書での署名を勧める
（無料の個人チームで作れる。下の手順 0）。

## オーナーが実行する S1 の確認手順

所要 10 分ほど。デーモン（7317）と常駐のヘルパの LaunchAgent には触れない。

### 0. （推奨）署名用の証明書を用意する

1. Xcode > Settings > Accounts で Apple ID を追加し、Manage Certificates で **Apple Development** を作る
2. `security find-identity -v -p codesigning` で名前を確かめる（`"Apple Development: <名前> (<ID>)"`）

証明書を作らない場合は ad-hoc で進める（手順 4 で許可が外れることを確かめる意味がある）。

### 1. ビルドして置く

```sh
cd ~/source/dayline
git pull && bun install
bun run check:helper                       # 自動の確認（全部 ok になること）
DAYLINE_CODESIGN_IDENTITY="Apple Development: <名前> (<ID>)" bun run build:helper   # 証明書がある場合
mkdir -p ~/Applications
ditto out/DaylineCalendarHelper.app ~/Applications/DaylineCalendarHelper.app
```

### 2. 権限のダイアログを出して許可する（一時的に前面で起動）

Terminal から実行ファイルを直接起動すると権限が Terminal に付いてしまうので、必ず `open` で起動する。

```sh
open -n -W ~/Applications/DaylineCalendarHelper.app --args --authorize
tail -n 3 ~/Library/Logs/dayline/calendar-helper.log
```

- ダイアログに「“DaylineCalendarHelper”がカレンダーへのフルアクセスを求めています」と出る → **フルアクセスを許可**
- ログの最後に `"event":"authorize.result","granted":true,"authorization":"fullAccess"` が出る

### 3. システム設定で帰属先を確かめる

システム設定 > プライバシーとセキュリティ > カレンダー に **DaylineCalendarHelper** が「フルアクセス」で出ていること。
Terminal・bun・daylined が増えていないこと。

### 4. launchd から起動して予定を読めるか

```sh
native/calendar-helper/scripts/s1-launchd-probe.sh 60
```

60 秒のあいだに Calendar.app で予定を1件足すか動かす。終わると次が出る:

- `probe.result` に `"authorization":"fullAccess"` と `calendars` / `events_window`（窓 = 7日前〜21日後の件数。題名は出ない）
- `helper.started` の `parent_pid` が 1（launchd から起動された）
- `probe.store_changed`（EKEventStoreChanged を受け取った）
- 最後に「S1: launchd 配下でフルアクセスの権限が効いています」「EKEventStoreChanged を受け取りました」

ダイアログは出ないはず（手順 2 の許可がヘルパに付いているため）。

### 5. 再ビルド後も許可が残るか

```sh
DAYLINE_CODESIGN_IDENTITY="..." bun run build:helper     # 手順 1 と同じ署名で
ditto out/DaylineCalendarHelper.app ~/Applications/DaylineCalendarHelper.app
native/calendar-helper/scripts/s1-launchd-probe.sh 10
```

- Apple Development 署名: `fullAccess` のまま（合格）
- ad-hoc 署名: `notDetermined` か `denied` に戻る見込み。その場合は常用前に証明書を用意する（S1 の判定は「証明書があれば合格」）

### 6. 後片付け

S1 だけで終える場合（常駐させない場合）:

```sh
rm -rf ~/Applications/DaylineCalendarHelper.app
rm -f ~/Library/Logs/dayline/calendar-helper-s1*.log
tccutil reset Calendar dev.dayline.calendar-helper    # 許可を取り消す（任意）
```

一時的な LaunchAgent（`dev.dayline.calendar-helper.s1`）はスクリプトが終わるときに外し、plist も消している。
続けて常用する場合は、片付けずに `docs/dev/m3-a.md` の「ヘルパを常駐させる」へ進む。

### 結果の記録

手順 2〜5 の結果（ダイアログの文言、システム設定の表示、`probe.result` の行、再ビルド後の `authorization`）を PO に返す。
予定の題名はログに出ないので、そのまま貼ってよい。

## S1 が失敗した場合

**常用はカレンダーなしで始める（D-044 (1)）**。ヘルパが未接続でも、デーモン・週ボード・YOUR TURN・Idle は動く
（週ボードのサイドバーに「Calendar off / カレンダー未接続」、`dl calendar status` に「カレンダー未接続」と出るだけ）。
会議中の待ちは放置に数えられるので、その間の Idle は多めに出る。後で接続できたら、同期のたびに窓の7日前から待ち区間を作り直すので、
**直近7日の Idle は自動で直る**。それより古い日は予定を取得していないので直らない（「仮置きした判断」を参照）。

失敗のしかたと代わりの案:

| 失敗のしかた | 代わりの案 | 手間 | 評価 |
|---|---|---|---|
| 手順 4 で launchd 配下だけ `notDetermined` / `denied`（`open` からは読める） | (a) LaunchAgent の `ProgramArguments` を `/usr/bin/open -g -j -W <app>` にして LaunchServices 経由で起動する（phase0-plan 4.1 の切り替え案） | plist の変更だけ | 第一候補。KeepAlive は `open -W` の終了で効く |
| (a) でも通らない | (b) ヘルパをログイン項目（`SMAppService.mainApp` かシステム設定 > 一般 > ログイン項目）にして LaunchServices に起動させる | Swift に数行 + 登録手順 | 第二候補。launchd の KeepAlive が無くなるので、落ちたときの再起動はヘルパ自身で行う |
| 手順 2 のダイアログが Terminal / bun の名前で出る | (c) `dl` / `daylined` を署名付きの `.app`（例 `Dayline.app`）に入れ、EventKit をその中で呼ぶ | ビルドと配置の作り直し（1〜2日） | 構成が大きく変わる。M6 の配布形態（署名・公証）と一緒に考える |
| 再ビルドのたびに許可が外れる | Apple Development 証明書で署名する（手順 0）。公開時は Developer ID（M6-8） | 証明書の作成だけ | 証明書があれば解消する見込み |
| 上のどれでも通らない | (d) Phase 1 の Tauri シェルを前倒しし、シェル（署名付きの `.app`）が EventKit の権限を持つ（ADR 0003 の「Phase1 でヘルパの役割を Tauri に移す」） | 大（Phase 1 の作業） | 最後の手段。それまでは D-044 (1) のとおりカレンダーなしで使う |
