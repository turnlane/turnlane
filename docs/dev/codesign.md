# turnlaned / turnlane の署名（D-060）

`turnlaned` が Ghostty などを AppleScript で操作するには、macOS のオートメーションの許可（TCC）が要る（[open.md](open.md) 3章の 3）。
TCC は許可を「どのプログラムか」で覚える。`bun build --compile` が付ける署名はリンカの ad-hoc 署名（識別子 `a.out`）で、
指定要件（designated requirement）が cdhash そのものになり、ビルドのたびに変わる。そのため、入れ替えのたびに許可を聞き直される見込みが高い。

`TURNLANE_CODESIGN_IDENTITY` があるとき、`bun run build`（`scripts/build.ts`）は `out/turnlaned` と `out/turnlane` を
カレンダーヘルパ・Turnlane.app と同じ証明書で署名し直す。

## 1. build が行うこと

| 項目 | 内容 |
|---|---|
| コマンド | `codesign --force --options runtime --timestamp=none --entitlements scripts/bun-binary.entitlements --identifier dev.turnlane.<名前> -s "$TURNLANE_CODESIGN_IDENTITY" out/<名前>`（Developer ID のときは `--timestamp=none` の代わりに `--timestamp`。5 章） |
| 識別子 | `dev.turnlane.turnlaned` / `dev.turnlane.turnlane`（固定。TCC の指定要件に入る） |
| entitlements | `com.apple.security.cs.allow-jit` だけ。hardened runtime では JIT が切られ、計算の重い処理が数倍遅くなる（実測: 同じループで 1.0s → 7.8s）。Bun のドキュメントが挙げる他の項目（unsigned executable memory、library validation の無効化など）は、FFI もサードパーティの dylib も使わないので付けない |
| 署名後の確認 | `codesign --verify --strict`、識別子と runtime フラグ、`<バイナリ> --version` での起動。どれかが失敗したら build が失敗する |
| 未設定のとき | 今までどおり（署名し直さない）。警告を1行出す |
| `TURNLANE_CODESIGN_IDENTITY=-` | ad-hoc で同じ手順を通す（テスト・確認用。cdhash がビルドごとに変わるので常用には向かない） |

`turnlane self-install` はバイナリをそのままコピーする（`~/.local/bin/` に一時ファイルを書いてから rename）。署名はバイナリに埋め込まれているので、コピーしても変わらない。

## 2. 許可が保たれる前提（オーナーの確認項目）

証明書で署名すると、指定要件は次の形になる（`codesign -dr - ~/.local/bin/turnlaned` で見られる）。

```
designated => identifier "dev.turnlane.turnlaned" and anchor apple generic and certificate leaf[subject.CN] = "Apple Development: …" and certificate 1[field.1.2.840.113635.100.6.2.1] /* exists */
```

識別子と証明書の名前だけで決まり、cdhash を含まないので、同じ証明書で作り直したバイナリを同じパスに置けば、TCC は同じプログラムとみなして許可を残す、というのが前提。
カレンダーヘルパで同じ証明書を使う理由（S1 の手順 5）と同じ考え方だが、`turnlaned` は `.app` ではない裸のバイナリで、
TCC はパスと指定要件で覚える。この点は実機でまだ確かめていない。次の手順で確かめて、結果を PO に返す。

| # | 操作 | 期待 |
|---|---|---|
| 1 | 証明書付きで初めて入れ替える（[m0-install.md](m0-install.md) 4章の「新しいビルドに入れ替える」） | `bun run build` の出力に `signed: Apple Development: … (hardened runtime, verified)` が出る。`codesign -dr - ~/.local/bin/turnlaned` に `identifier "dev.turnlane.turnlaned"` と証明書の名前が出る |
| 2 | 閉じたセッションのタスクで ⏎（[open.md](open.md) 3章の 2） | ad-hoc からの切り替えなので、オートメーションの許可をもう一度聞かれることがある。**OK** を押す |
| 3 | コードを変えなくてよいので、もう一度 build して `out/turnlane self-install` | — |
| 4 | もう一度 2 と同じ操作 | **許可を聞かれず**、resume コマンドが入力済みになる（これで前提どおり） |

4 で聞き直された場合は、`codesign -dr - ~/.local/bin/turnlaned` の出力（証明書の名前は伏せてよい）と、
システム設定 → プライバシーとセキュリティ → オートメーションでの `turnlaned` の表示を PO に返す。

- Apple Development 証明書は1年で切れる。更新して名前（CN）が同じなら指定要件は変わらない見込み。名前が変わったら一度だけ聞き直される
- 公開配布（Developer ID・公証）では `--timestamp=none` を外し、セキュアタイムスタンプを付ける（5 章）

## 3. Turnlane.app の entitlements（hardened runtime と TCC）

hardened runtime で署名したアプリ（配布版の Turnlane.app は ad-hoc でも `--options runtime` を付ける）は、TCC の許可を要する操作ごとに対応する entitlement が要り、無いと TCC はダイアログを出さずに断る（システム設定にも行が出ない）。同梱のヘルパのカレンダーの要求と、turnlaned の osascript（「開く」「答える」）のオートメーションは、責任のあるアプリとして Turnlane.app に帰属するため、`bun run build:app` は外側を `scripts/app.entitlements`（`com.apple.security.personal-information.calendars` と `com.apple.security.automation.apple-events`）付きで署名し、`checkBundle` で 2 つが入っていることを確かめる（2026-10-21 の Neo: カレンダーの許可のダイアログが出ずに「未決定」のままだった）。どちらも hardened runtime の resource access の entitlement で、プロビジョニングプロファイルが要らず、Developer ID の公証（M6-8）でも許される。用途の説明（`NSCalendarsFullAccessUsageDescription`・`NSAppleEventsUsageDescription`）は外側の Info.plist に入れる（`build-app.ts` の `USAGE`）。同梱のヘルパ（TurnlaneCalendarHelper.app）も hardened runtime で署名し、カレンダーの entitlement（`native/calendar-helper/Resources/CalendarHelper.entitlements`。`com.apple.security.personal-information.calendars` だけ）を付ける（`native/calendar-helper/scripts/build-app.sh`）。`checkBundle` は部品ごと（Helpers の 2 つ・ヘルパ・外側）に hardened runtime と entitlements を見て、公証で拒まれるもの（`get-task-allow`）と hardened runtime の保護を外すもの（library validation の無効化、unsigned executable memory など。`scripts/signing.ts` の `FORBIDDEN_ENTITLEMENTS`）が入っていないことを確かめる。

## 4. ad-hoc の配布物は SMAppService の常駐が起動を拒まれる

ad-hoc 署名（`TURNLANE_CODESIGN_IDENTITY` が無い、または `-`）は Team ID が無く、同一性が cdhash だけになる（ビルドのたびに変わる）。SMAppService で登録した常駐（デーモン・カレンダーヘルパ）の登録（BTM）は、アプリを消しても `rm -rf ~/Library/Application Support/turnlane` しても OS 側に残る。そのため、zip の入れ替え・Downloads で開いてから Applications へ移す、などで「登録したときのバンドル」と「今のバンドル」の cdhash が食い違うと、launchd が起動の直後に常駐を殺す（`EXC_CRASH SIGKILL (Code Signature Invalid)`、termination namespace CODESIGNING、indicator `Launch Constraint Violation`。2026-10-21 の Neo で `turnlaned` と `TurnlaneCalendarHelper` の両方）。常駐が上がらないので、アプリは起動ページのまま待つ。

- **お試しの配布でも Apple Development 以上の証明書で署名する**（`TURNLANE_CODESIGN_IDENTITY`）。`bun run build:app` は ad-hoc のときに警告を出す。公開配布は Developer ID と公証（M6-8）
- 保険（Turnlane.app）: 起動のたびにバンドルの目印（`TurnlaneBuild` と cdhash）を前回の起動と比べ（`~/Library/Application Support/dev.turnlane.desktop/registered-bundle.txt`）、違えば有効な登録（デーモン・カレンダーヘルパ）を解除して登録し直す。登録が有効なのに常駐が 5 秒答えないときも登録し直し、それでも 10 秒答えなければ起動ページの B2 に「macOS is blocking Turnlane's background process」を出す。Copy diagnostics には `launchctl print gui/<uid>/<label>` の状態の行（`state`・`runs`・`last exit code`・`last terminating signal`）が載る
- 手で確かめる: `launchctl print gui/$(id -u)/dev.turnlane.daemon | grep -E 'state =|runs =|last'`、`ls ~/Library/Logs/DiagnosticReports/ | grep -E 'turnlaned|TurnlaneCalendarHelper'`

## 5. 公開配布（Developer ID・公証）

`TURNLANE_CODESIGN_IDENTITY` が `Developer ID Application:` で始まるとき、`bun run build:app` は配布用として扱う（判定は `scripts/signing.ts` の 1 か所。SHA-1 で指定したときは種別が分からないので配布用とみなさない。名前で指定する）。

| 種別 | タイムスタンプ | 公証と staple | 最後の確認 |
|---|---|---|---|
| Developer ID（配布用） | 全部の署名に `--timestamp`（turnlaned・turnlane・ヘルパ・Turnlane.app） | `TURNLANE_NOTARY_PROFILE` があれば行う。無ければ警告 1 行（失敗にはしない） | `spctl` と `stapler validate` の結果を出す |
| Apple Development | `--timestamp=none` | 省く（オーナーの移行と確認用） | なし |
| ad-hoc（`-`・未設定） | `--timestamp=none` | 省く。ad-hoc の警告（4 章） | なし |

### 5.1 必要な環境変数

| 変数 | 値 |
|---|---|
| `TURNLANE_CODESIGN_IDENTITY` | `Developer ID Application: <名前> (<Team ID>)`（キーチェーンにある証明書の名前そのまま） |
| `TURNLANE_NOTARY_PROFILE` | `xcrun notarytool store-credentials` で作ったキーチェーンのプロファイル名（例 `turnlane-notary`）。Apple ID やパスワードそのものではない |

Tauri が自分で公証する環境変数（`APPLE_ID`・`APPLE_PASSWORD`・`APPLE_TEAM_ID`・`APPLE_API_KEY` など）は、`build:app` がシェルのビルドに渡さない（公証は外側の .app で 1 回だけ行う）。

### 5.2 資格情報を作る（1 回だけ）

```sh
xcrun notarytool store-credentials <profile> --apple-id <Apple ID のメール> --team-id <Team ID>
# パスワードを聞かれたら、appleid.apple.com で作った App 用パスワードを入れる
```

資格情報はログインキーチェーンに入る。値をリポジトリ・シェルの履歴・CI のログに残さない。公式ビルドは CI ではなくオーナーの Mac で作るので、証明書も公証の資格情報も CI に置かない（M6-10）。

### 5.3 ビルドの手順

```sh
export TURNLANE_CODESIGN_IDENTITY="Developer ID Application: <名前> (<Team ID>)"
export TURNLANE_NOTARY_PROFILE="<profile>"
bun run build:app --dry-run --zip --download-url <zip の URL>   # 実行せずにコマンド列を確かめる
bun run build:app --zip --download-url <zip の URL>
```

`build:app` が行うこと（`scripts/build-app.ts`）:

1. 内側から署名する（turnlaned・turnlane → ヘルパの .app → Turnlane.app）。どれも hardened runtime と `--timestamp`
2. `checkBundle` で形・版・署名を確かめる。配布用では部品ごとに Developer ID の証明書とセキュアタイムスタンプがあることも見る
3. `ditto -c -k --keepParent` で一時の zip を作り、`xcrun notarytool submit <zip> --keychain-profile <profile> --wait` で送る（数分かかる）
4. Accepted なら `xcrun stapler staple Turnlane.app` → `xcrun stapler validate`
5. `--zip` の `Turnlane-<版>.zip` と `latest.json` は staple 後の .app から作る
6. `spctl -a -vv -t exec` と `stapler validate` の結果を出す

`--skip-notarize` を付けると、Developer ID でも公証せず、警告も出さない（署名だけ確かめたいとき）。

リリースの一本道（検査・ビルド・添付ファイル・cask・公開のコマンド）は `bun run release` で、手順と失敗時の復旧は [docs/release.md](../release.md)。

### 5.4 失敗したときの見方

| 症状 | 見ること |
|---|---|
| `codesign could not get a secure timestamp from Apple` | `--timestamp` は Apple のタイムスタンプサーバーに接続する。ネットにつながっているか確かめて、もう一度ビルドする |
| `notarytool submit failed` | プロファイルの名前と資格情報。`xcrun notarytool history --keychain-profile <profile>` が通るか |
| `notarization Invalid (submission <id>)` | ビルドの出力に `xcrun notarytool log <id>` の JSON が載る（`issues` の `path` と `message`）。後から見るときは `xcrun notarytool log <id> --keychain-profile <profile>` |
| `bundle check failed: … no secure timestamp` / `not signed with a Developer ID Application certificate` | その部品だけ別の証明書・`--timestamp=none` で署名されている。`codesign -dv --verbose=2 <部品>` の `Authority=` と `Timestamp=` を見る |
| `entitlement not allowed: com.apple.security.get-task-allow` | 公証が拒む。entitlements のファイルから外す |

### 5.5 確かめる

```sh
spctl -a -vv -t exec out/app/Turnlane.app     # accepted / source=Notarized Developer ID
xcrun stapler validate out/app/Turnlane.app   # The validate action worked!
codesign --verify --deep --strict --verbose=2 out/app/Turnlane.app
```

- 未公証の Developer ID は `source=Unnotarized Developer ID` で rejected になる。ad-hoc は `rejected`（source の行が無い）になるのが正常
- 初めて開くとき: zip をブラウザで落として展開し、Applications に移して開く。macOS が「“Turnlane”はインターネットからダウンロードされたアプリです。開いてもよろしいですか?」と確認し、「Apple は悪意のあるソフトウェアがないか確認済みで、検出されませんでした」（公証済み）の表示が出ること（文言は macOS の版と言語で少し違う）。「開発元を検証できません」「マルウェアが含まれていないことを検証できませんでした」が出たら公証か staple が抜けている
- staple しているので、ネットにつながっていない Mac でも初回の確認が通る

### 5.6 Apple Development から Developer ID に変わるときの再許可

TCC は許可を指定要件（識別子と証明書）で覚える。Developer ID の指定要件は Apple Development と違う（証明書の種類と Team ID で決まる）ので、Apple Development で署名した Turnlane.app から入れ替えると、許可が外れることがある。

| 許可 | 外れたときの症状 | 再許可 |
|---|---|---|
| カレンダー | 予定が出ない。`turnlane doctor` のカレンダーの行が許可されていない | Turnlane の設定画面のカレンダーの行から許可を求める。ダイアログが出ないときは、システム設定 → プライバシーとセキュリティ → カレンダーで Turnlane をオンにする。古い行が残ってオンにしても効かないときは、行を消してから Turnlane を開き直す（または `tccutil reset Calendar dev.turnlane.desktop` の後に開き直す） |
| オートメーション | 「開く」「答える」でターミナルが動かない | 次に「開く」を押したときに出る確認で OK を押す。出ないときはシステム設定 → プライバシーとセキュリティ → オートメーションの Turnlane の下の項目をオンにする（または `tccutil reset AppleEvents dev.turnlane.desktop`） |
| 通知 | 通知が出ない | システム設定 → 通知 → Turnlane。通知の許可はバンドル ID で覚えるので、多くの場合は残る |

`turnlane doctor` は Turnlane.app の署名の種別（ad-hoc / Apple Development / Developer ID）と公証の有無（staple の有無）を 1 行出し、Developer ID のときは、許可が外れたらここを見るよう案内する。
