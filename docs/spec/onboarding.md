# オンボーディングとアプリ統合（公開版）設計と実装計画

- 作成: 2026-10-06 / 状態: 設計案（PO の確認待ち。オーナー判断は 10 章）
- 決定: [ADR 0011](../adr/0011-single-app-bundle-smappservice.md)（配布物を Turnlane.app 1つにし、SMAppService で登録する。ADR 0001・0003・0010 を補正）
- PO 決定: D-056 (5)（ヘルパを Turnlane.app に同梱）、D-087（署名・公証）、D-088（オンボーディングとアプリ統合を公開の範囲に入れる）
- 関連: [ux-mvp.md](./ux-mvp.md) 2 章の S12・4.14（設定の節）、[desktop-shell.md](./desktop-shell.md) 6 章・9 章、[phase0-plan.md](./phase0-plan.md) 3.6（turnlane コマンド）・3.6.1（hooks）・4.8（M6）、[ai-session-ingestion.md](./ai-session-ingestion.md) 6.1（パス検出）
- 画面のデザイン: O1〜O3 は確定（[docs/design/onboarding-v1/](../design/onboarding-v1/) と [docs/design/README.md](../design/README.md) の調整点）。O4〜O8 は画像を作らず、O1〜O3 の確定した部品と語彙で実装した（M6-23〜M6-26。README の OB14〜OB22）。この文書の ASCII ワイヤーは構成の目安で、実装の細部は各節の「実装」の項

---

## 0. 結論（先に読む）

1. **配布物は Turnlane.app 1つ**。中に `turnlaned`・`turnlane`・`TurnlaneCalendarHelper.app` と、2つの LaunchAgent の plist を入れる。常駐の登録はアプリが `SMAppService` で行う（デーモンは Welcome の `Get started` で、ヘルパはカレンダーを使うと決めたときだけ）。ログイン時の起動は `SMAppService.mainApp`。turnlane を PATH に置くのは Homebrew の `binary`（Homebrew 以外は設定から `~/.local/bin` にリンク）。hooks と MCP には固定の場所 `~/Library/Application Support/turnlane/bin/turnlane` を書く（ADR 0011）。
2. **版は1つのバンドルで揃う**。更新後はデーモンが自分のバンドルの版の変化に気づいて終了し、launchd が新しい版で起こす。ヘルパはデーモンが入れ替えさせる。`brew upgrade` で終了したアプリはデーモンが起こし直す。cask の `launchctl` は `zap` にだけ書く（`uninstall` は更新のたびに走るため）。
3. **オンボーディングは9画面**: Welcome → 取り込み元と同意 → **過去7日のバックフィル（aha）** → カレンダー（任意）→ hooks（任意）→ AI から Turnlane を使えるようにする（任意。MCP の登録。D-145）→ 計画の目安と稼働日 → 通知 → はじめる（ボードへ。朝の計画は廃止。D-192）。同意の前は、デーモンは取り込み元の検出（ファイルの有無と件数）しかしない。
4. **取り込むのは直近7日だけ**（D-181。それより前は今も後からも読まない）。**新しい日から**埋める。画面には読み取り専用の7日のボードが日ごとに埋まっていく様子と、計算済みの事実だけ（AI の稼働時間、カード数、AI が待った回数）を出す。Idle などカレンダーと在席（Mac を使っていた時間。D-105）に依存する数字は、それらが揃った後に再計算するので、この画面には出さない。演出の待ち時間は入れない。
5. **どの段も後から設定でやり直せる**。スキップした段は設定の該当の節に「未設定」として残り、設定 > 一般 の `Run setup again` で全体をもう一度通せる。
6. **見積は +13.5人日**（アプリ統合 5.5、オンボーディング 8.0）。M6 は 8.5 → 22人日。順序は「スパイク（新しい macOS アカウントで）→ バンドルと登録 → デーモンの同意ゲートと API → 画面（デザイン確定後）→ オーナーの環境の移行 → Developer ID・cask・リリース → 新しいアカウントでの通し確認 → 公開判定」（9 章、phase0-plan 4.8）。

---

## 1. 範囲と前提

| 項目 | 内容 |
|---|---|
| 対象 | 公開版を Homebrew cask（または Releases の zip）で入れた、Turnlane を初めて使う人 |
| 前提 | macOS 14 以降（EventKit のフルアクセスと SMAppService）、Apple Silicon（10 章のオーナー判断）、Claude Code か Codex を使ったことがある |
| 範囲 | アプリ統合（ADR 0011）、初回起動からボードまでの流れ、失敗・スキップ・やり直し、設定からの再実行、旧配置からの移行 |
| 範囲外 | Claude Desktop の `local_*.json` アダプタ（Code タブのセッションは Claude Code の設定ディレクトリから取り込まれる。Cowork は対象外）、週次レビュー、チュートリアル的なツアー |
| 既存の利用者 | DB に取り込みのカーソルがある環境（オーナー）は、マイグレーションでオンボーディングを `done` にして出さない（5.1） |
| 文言 | 英語が正（D-023）。この文書の日本語は意味の説明 |
| 原則 | 祝わない・擬人化しない（デザインシステム）。許可は急かさず、すべて後回しにできる。会話の本文を保存も送信もしないことを、同意の画面で具体的に示す（ADR 0005）。「読まない」とは書かない（記録のファイルは読むため） |

---

## 2. アプリ統合（ADR 0011 の詳細）

### 2.1 バンドルの構成とビルド

```
Turnlane.app/Contents/
  Info.plist                  CFBundleIdentifier=dev.turnlane.desktop, LSMinimumSystemVersion=14.0,
                              NSCalendarsFullAccessUsageDescription, NSAppleEventsUsageDescription
  MacOS/turnlane               Tauri
  Helpers/turnlaned            bun build --compile（識別子 dev.turnlane.turnlaned）
  Helpers/turnlane                  同上（dev.turnlane.turnlane）
  Library/LoginItems/TurnlaneCalendarHelper.app   Swift（dev.turnlane.calendar-helper）
  Library/LaunchAgents/dev.turnlane.daemon.plist
  Library/LaunchAgents/dev.turnlane.calendar-helper.plist
  Resources/…                 Tauri の boot ページ（Welcome を含む）・アイコン
```

LaunchAgent の plist（例: デーモン）:

```xml
<key>Label</key><string>dev.turnlane.daemon</string>
<key>BundleProgram</key><string>Contents/Helpers/turnlaned</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>AssociatedBundleIdentifiers</key><array><string>dev.turnlane.desktop</string></array>
```

- ビルド: `bun run build:app`（新設、`scripts/build-app.ts`）が `bun run build`（turnlaned・turnlane・web）→ `build:helper` → `build:desktop` を順に呼び、上の形に組み立てる。署名は内側から（Helpers の2つ → ヘルパの .app → Turnlane.app）。`TURNLANE_CODESIGN_IDENTITY` が Developer ID なら `--timestamp` を付け、`notarytool submit --wait` → `stapler staple` まで行う（M6-8）。Apple Development なら公証を省く（オーナーの移行と確認用）。
- 版: ルートの `package.json` の `version` を正とし、Tauri の `version`・ヘルパの `CFBundleShortVersionString`・`turnlaned --version` に同じ値を入れる（ビルド時に書き込む）。

### 2.2 初回起動と登録の順序

```
Turnlane.app を開く
  │  boot ページ（同梱の HTML）に Welcome（4.1）を出す。まだ何も常駐していない
  ▼ [Get started]
SMAppService.agent(daemon).register()
  │  macOS の通知「Turnlane がバックグラウンドで実行できる項目を追加しました」が出る（OS の仕様）
  │  status が .requiresApproval → 4.9 の B1（ログイン項目でオンにする案内）
  ▼ デーモンが起動（health が返るまで 1s → 30s で再試行。15秒返らなければ 4.9 の B2）
SMAppService.mainApp.register()（ログイン時に開く。既定オン）
  ▼
ウインドウが http://127.0.0.1:7317/auth?t=…&next=/onboarding を読み込む（以降は SPA）
```

- デーモンは起動時に `install.json`（データディレクトリ、600）に `{ mode: "app", appPath, version }` を書く。アプリは起動のたびに `~/Library/Application Support/turnlane/bin/turnlane` のリンク先を `<appPath>/Contents/Helpers/turnlane` に合わせる。
- 2回目以降の起動では Welcome を出さず、登録を確かめる（外れていれば登録し直す）だけ。

### 2.3 TCC の帰属

ADR 0011 の決定 3 の表のとおり。実機で確かめること（M6-S8）:

1. 同梱のヘルパを `SMAppService.agent` で起動したとき、カレンダーの許可がヘルパと Turnlane のどちらに付くか（システム設定 > プライバシーとセキュリティ > カレンダー の表示名）。
2. `turnlaned` が起動する `osascript` のオートメーションの許可がどちらに付くか。hardened runtime の `turnlaned` に `com.apple.security.automation.apple-events` が要るか。
3. アプリを同じ場所で新しい版に置き換えたとき（`brew upgrade` 相当）、許可と `SMAppService` の登録が残るか。
4. 許可の要求ダイアログを、ヘルパが前面に出ずに（LSUIElement のまま）出せるか。出せなければ今の `open --args --authorize` 方式を使う。

どちらに付いても動くように、許可の状態はヘルパがデーモンに `status` で返す今の仕組みを使い、画面は「Turnlane」の名前で案内する。

2026-10-21 の Neo（初めての Mac、配布用の zip、ad-hoc 署名）で分かったこと: `open -n -W <同梱のヘルパ> --args --authorize` で起動したヘルパの `requestFullAccessToEvents` が、ダイアログを出さずに戻り、権限は「未決定」のまま、システム設定のカレンダーにも行が出なかった（ターミナルから実行しても、隔離の印を消しても同じ）。配布版の Turnlane.app は hardened runtime（ad-hoc でも付く）で entitlements が無く、ヘルパ（hardened runtime ではない）の要求が責任のあるアプリの Turnlane.app に帰属すると、`com.apple.security.personal-information.calendars` が無いために TCC が黙って断る、という説明が症状と合う。`build:app` は外側の Turnlane.app を `scripts/app.entitlements`（この entitlement）付きで署名し、`checkBundle` で有無を確かめる。実機での確定は tccd のログ（`log stream --predicate 'subsystem == "com.apple.TCC"'`）で行う。ヘルパを hardened runtime にするとき（M6-8）はヘルパにも同じ entitlement を付ける。

### 2.4 turnlane と hooks・MCP のパス

| 用途 | パス | 誰が置くか |
|---|---|---|
| hooks の command、MCP の登録 | `~/Library/Application Support/turnlane/bin/turnlane`（リンク） | アプリ（起動のたび） |
| シェルの `turnlane`（Homebrew） | `$(brew --prefix)/bin/turnlane` | cask の `binary` |
| シェルの `turnlane`（Homebrew 以外） | `~/.local/bin/turnlane`（リンク） | 設定 > 一般 `Install command line tool`（任意） |

hooks の command は今の形（phase0-plan 3.6.1）のまま、パスだけが変わる: `'<HOME>/Library/Application Support/turnlane/bin/turnlane' hook --tool claude_code --managed-by turnlane`。パスは単一引用符で囲んでいるので空白を含んでよい。

### 2.5 更新と版の揃え方

| 場面 | 起きること | Turnlane の動き |
|---|---|---|
| `brew upgrade --cask turnlane` | 旧版の `uninstall`（`quit` でアプリを終了）→ 新しい .app に置き換え | デーモン: 1分以内にバンドルの版の変化に気づき終了 → launchd が新版で起動 → 更新前にデスクトップがつながっていれば（終わる時につながっているか、切れてから 5 分以内）、古いデーモンが `<データ>/relaunch-desktop` に印を残し、新しいデーモンが起動時に印を消して、10 分以内の印なら `open -g -b dev.turnlane.desktop --args --background` でアプリをメニューバーだけで起こす（配布版だけ。open の失敗はログに残して続ける。`apps/daemon/src/install/relaunch.ts`）。ヘルパ: デーモンが、接続しているヘルパの版と同梱のヘルパの版の違いを見て、アプリの `--setup reregister calendarHelper` で登録をし直す（解除で launchd が古いほうを止め、登録で新しいバンドルから起こす。古いヘルパに止める口が無くても入れ替わる。同じ組み合わせは1回だけ） |
| Releases の zip で手で置き換え | アプリは動いたまま | 上のデーモン・ヘルパの動きに加え（版が同じでもビルドが違えば、デーモンがヘルパの登録を 1 回し直す。ad-hoc 署名では cdhash が変わり、登録のままだと launchd が起こせないため）、アプリが自分の版の変化に気づく: ウインドウを閉じていれば自分で再起動、開いていればメニューに `Restart to finish update` |
| 更新確認（M6-12） | 新しい版がある（自動更新がオフ・検証に落ちたときもこの手動の案内。次の行） | ボードの上部とメニューに `Turnlane 0.4.0 is available`（日本語は「Turnlane 0.4.0 に更新できます」）。Homebrew 版は `brew upgrade --cask turnlane` をコピーするボタン（メニューは押すとクリップボードへ写し、メニューバーに短く `Copied`）、zip の版は最新リリースのページ（`releases/latest`）を開くボタン。開発時の配置では出さない。ボードの × で閉じた版は次のデーモンの起動まで出さない（デーモンのプロセスの中だけ覚える。`POST /api/update/dismiss`）。メニューは `Restart to Finish Update` があればそちらを出す。SSE `update` で確認の直後に出る。実装済み（`apps/web/src/components/UpdateBar.tsx`、`/api/queue/summary` の `update`、`apps/desktop/src-tauri/src/tray.rs`） |
| 自動更新（ADR 0008 の追記 4） | 新しい版があり、配布版（`install.json` の mode が `app`）で `update.download`（既定オン）がオン | 確認の後に、デーモンが `latest.json` の `url`（GitHub のみ）の zip を `<データ>/updates/<version>/` に背景で取得（上限 500 MB。他の版のフォルダは消す）→ sha256 の照合 → `ditto -x -k` で展開（中身が `Turnlane.app` 1 つだけ）→ 検証（`codesign --verify --deep --strict`、TeamIdentifier が動いている自分のバンドルと同じ、`Info.plist` の版が latest と同じで今より新しい、`spctl --assess --type execute`）。取得・検証の間はボードとメニューに `Turnlane 0.7.2 is available · Downloading…`、通ったら `Turnlane 0.7.2 is ready` と `Restart to update`（日本語は「Turnlane 0.7.2 の準備ができました」「再起動して更新」）。押すと `POST /api/update/install` で配置先の隣に `.Turnlane.app.new` として写し、今のものを `.Turnlane.app.old` に、新を本名に rename する（失敗したら old を戻す。old はここでは消さず、新しい版のデーモンが再起動の後に消す: アプリがつながるか 60 秒が過ぎ、古い版のカレンダーヘルパが動いていないとき。古い版のプロセスがまだ終わる途中で、実行ファイルを消すと落ちるため）→ SSE `update` の `installed` でアプリが自分を開き直す → デーモンはバンドルの変化で終わり、launchd が新版で起こし、起こし直しの印でアプリを背景で起こす（二重には開かない）。押さなくても、アプリが切れて 60 秒つながらず、アプリのプロセスも無ければ入れる（このときはアプリを起こさない。次に開くと新しい版）。検証に落ちた・書けない（`not_writable`）ときは `… · Could not verify the download`（書けないときは `Could not install the update`）と手動の案内（Homebrew 版はコピー、zip の版はリリースのページ）。失敗は次の確認でやり直し、同じ版で 3 回失敗したらその版は手動の案内だけ。設定 › 一般の `Check for updates`（`update.check`）と `Download updates automatically`（`update.download`）。`turnlane doctor` に 1 行。実装は `apps/daemon/src/update/`（`downloader.ts`・`verify.ts`・`install.ts`・`auto.ts`） |
| デーモンとアプリの版がずれたまま | 再起動の失敗など | 今の `Version mismatch` の表示（desktop-shell 6.1）を残す。文言は `Restart Turnlane` に改める |

DB のマイグレーションは今のまま、新しいデーモンの起動時に前進のみで行う（適用前に `VACUUM INTO` のバックアップ）。

### 2.6 アンインストール

| 方法 | 消えるもの | 残るもの |
|---|---|---|
| アプリのメニュー `Uninstall Turnlane…`（確認ダイアログ）/ `turnlane uninstall --all` | hooks の Turnlane のエントリ（Codex は再承認の案内。D-030）、`SMAppService` の登録（3つ）、turnlane のリンク、`install.json` | データ（DB・バックアップ）とログ。最後に「アプリをゴミ箱に入れてください」と、データを消すコマンドを出す |
| `brew uninstall --cask turnlane` | アプリ（と `binary` のリンク） | hooks のエントリ（`turnlane` が無いので失敗する）、データ。`caveats` で「先に Uninstall Turnlane… を」と案内 |
| `brew uninstall --zap --cask turnlane` | 上に加え、データディレクトリ・ログ・`launchctl` のラベル | hooks のエントリ |

### 2.7 旧配置からの移行（オーナーの環境）

旧配置: `~/.local/bin/{turnlane,turnlaned}`、`~/Applications/TurnlaneCalendarHelper.app`、`~/Applications/Turnlane.app`、`~/Library/LaunchAgents/dev.turnlane.{daemon,calendar-helper,desktop}.plist`、hooks と MCP が `~/.local/bin/turnlane` を指す。

新しい Turnlane.app を `/Applications` に置いて開くと、アプリは `~/Library/LaunchAgents/dev.turnlane.daemon.plist` を見つけて Welcome の代わりに移行の画面（4.10）を出す。`Migrate` で同梱の `turnlane setup migrate --json` を実行する（処理は TS 側。Rust は結果を表示するだけ）。

| # | 処理 | 失敗したとき |
|---|---|---|
| 1 | 旧エージェント3つを `bootout` し、plist を `~/Library/Application Support/turnlane/legacy/` へ移す（消さない） | 中止。旧配置のまま動く |
| 2 | アプリが `SMAppService` でデーモン・ヘルパ（旧配置でカレンダーを使っていれば）・mainApp を登録 | 1 の plist を戻して `bootstrap` し直す |
| 3 | `turnlane hooks install`（新しいパス、検出した全設定ディレクトリと Codex）。Codex は hash が変わるので `/hooks` での再承認を案内 | 失敗した設定ディレクトリを一覧し、設定から再実行 |
| 4 | MCP の登録（`turnlane` の項目）が旧パスを指していれば、新しいパスに直す（`turnlane self-install` と同じ。登録の無いところには足さない。D-145、phase0-plan 3.6.2） | 失敗した設定を一覧し、`turnlane mcp install` を案内 |
| 5 | `~/.local/bin/turnlane` を新しい `turnlane` へのリンクに置き換え、`~/.local/bin/turnlaned` を消す | 警告だけ |
| 6 | 旧 `TurnlaneCalendarHelper.app`・旧 `Turnlane.app` をゴミ箱へ | 警告だけ |
| 7 | 許可の確認: カレンダー・通知・オートメーションを確かめ、外れていれば各画面（4.4・4.7）と同じ部品で案内 | — |

データディレクトリ、DB、トークン、設定はそのまま使う。オンボーディングは `done` のまま。

**移行の回数を減らすため**: bundle ID の接頭辞（`dev.turnlane.`。ADR 0016 で確定）と、証明書（Apple Development → Developer ID）が変わるたびに許可は外れる。名称を先に確定させ、オーナーの移行は「確定した bundle ID・Apple Development 署名」で1回、Developer ID への切り替えで許可の再要求がもう1回、を想定する（10 章）。

---

## 3. オンボーディングの流れ

```
O1 Welcome ──Get started──▶ O2 取り込み元と同意 ──Import──▶ O3 直近7日の取り込み（aha）
 (boot ページ)                │ 取り込み元が0件 → O2-empty           │ 失敗した元 → 行に ⚠、続行可
                              │ Not now → 同意なしで O4 へ           ▼
                              │   （AI の取り込みは止まったまま）     O4 カレンダー（任意）
                              ▼                                     ▼
                                                                  O5 hooks（任意）
                                                                    ▼
                                                                  O5a AI から使う（任意。MCP）
                                                                    ▼
                                                                  O6 計画の目安と稼働日
                                                                    ▼
                                                                  O7 通知
                                                                    ▼
                                                                  O8 はじめる ─▶ ボード（D-192）
```

- 上部に段の表示: `Sources · Import · Calendar · Hooks · AI tools · Hours · Notifications · Start`（O1 と O8 は出さない）。済んだ段・飛ばした段・今の段を区別する（飛ばした段は消さずにダッシュで残す。960px の窓でも全部の名前を出す）。戻る（`←` / `Back`）は O3 以降でいつでもできる（O2 には出さない。O1 は常駐の登録の画面で、戻る先が無い。D-184）。
- 途中でウインドウを閉じる・アプリを終了したら、次に開いたときに同じ段から再開する（5.1 の `step`）。O3 の取り込みはデーモンで続いている。
- 各段の `Skip` / `Not now` は主ボタンと同じ大きさにする（急かさない。デザインの (9) の意図）。
- キーボード: `⏎` で主ボタン、`Esc` で `Not now`（O3 では `Skip the rest`）、`⌘[` で戻る（O3 以降）。足のキーの帯には、その画面で効くキーだけを出す。
- 画面を出さずに飛ばす段: O2 で同意しなかった（`Not now`）なら O3・O5・O5a、同意したが取り込み元が 0 件（O2-empty の `Continue`）なら O3 と、対象の無い O5・O5a。戻るはこれらの段を飛ばす（`Not now` の後の O4 から戻ると O2）。
- `Not now` で飛ばせる段は、ボタンの上の1文に「飛ばすとどうなるか・後でどこで直せるか」を出す（例: 「Not now keeps the board without events. Connect later in Settings › Calendar.」）。

---

## 4. 画面（ASCII ワイヤー）

ウインドウは既定のメインウインドウ（1280×800 程度）で、中央 760px の1カラム（儀式と同じ）。O3 だけは幅いっぱいにボードを出す。

### 4.1 O1 Welcome（boot ページ。デーモンはまだ動いていない）

確定画像: `onb-O1-welcome-*.png`・`onb-O1-states.png`（[docs/design/onboarding-v1/](../design/onboarding-v1/)）。

```
┌──────────────────────────────────────────────────────────────┐
│   Turnlane                                                   │
│   Your day and your AI agents' work, on one timeline.        │
│                                                              │
│   [file]  Reads Claude Code and Codex session logs on this Mac.
│           Conversation text is never saved or sent.          │
│   [clock] Runs a small background process.                   │
│           So nothing is missed while the window is closed.   │
│   [laptop] No account.                                       │
│           Everything stays on this Mac.                      │
│                                          [ Get started ⏎ ]   │
│   macOS will tell you Turnlane added a background item. That's this process.
└──────────────────────────────────────────────────────────────┘
```

- 「サーバーなし」とは書かない（更新確認は外に接続するため）。2つ目のボタンは無い（窓を閉じるのが出口）。
- 状態: 通常 / 起動中（ボタンにスピナーと `Starting…`。幅は変えない）/ B1・B2・B4（4.9。どれも3行の下を差し替える）。
- 起動中はボタンの下に段と経過の秒を出す: `Starting the background process… 4s`（デーモンが答えるまで）→ `Loading Turnlane…`（つながって SPA へ移るまで。つながった後は B2 を出さない）。最初の画面はアプリがウインドウを作るときに渡す初めの状態（`window.__turnlaneBootSeed`）で IPC を待たずに描く。SPA の `index.html` も React が描く前から背景を塗り、0.4 秒たっても描けなければ `Loading Turnlane…` を出す（黒い・白いままの窓を出さない）。

### 4.2 O2 取り込み元と同意

確定画像: `onb-O2-sources-*.png`・`onb-O2-states.png`（Claude Desktop の行の Cowork の文は外す。D-186）。

```
 Sources · Import · Calendar · Hooks · AI tools · Hours · Notifications · Start      1 / 8

 We found these on this Mac
 Choose what Turnlane may read. You can change this later in Settings › AI import.
 [✓] Claude Code  Default  ~/.claude        84 sessions in 7 days · last used today
 [✓] Claude Code  acme     ~/.claude-acme   12 sessions in 7 days · last used 3 days ago
 [✓] Codex                 ~/.codex         18 sessions in 7 days · last used yesterday
 Claude Desktop: sessions from its Code tab are already in Default (~/.claude).
 Missing a folder? Choose a folder…

 ┌ Kept ──────────────────────────┬ Never kept or sent ───────────┐
 │ session titles, repository and │ conversation text, prompts,   │
 │ branch names, times, PR numbers, counts │ code, file contents  │
 └────────────────────────────────┴───────────────────────────────┘
 Everything stays on this Mac. See everything Turnlane keeps

        Only the last 7 days are read now. New sessions are added as they happen.
                              [ Not now ]   [ Import the last 7 days ⏎ ]
```

- 件数は**ファイルの数と更新時刻だけ**で数える（中身を開かない。5.2）。数えるのは直近7日（6日前の論理日の始まり以降に更新されたもの）で、取り込む範囲と同じ。プロファイルはどの名前のものも既定でチェックを入れる（ai-session-ingestion 6.1 の PO 決定）。
- 主ボタンで同意（`consentedAt` と、チェックした取り込み元を記録）→ O3。チェックを外した元は `enabled=0`。全部外したら主ボタンは押せず、ボタンの上に「Nothing selected. Not now skips import; you can start it later in Settings.」を出す（D-184）。
- `Not now`: 同意しないまま O4 へ進む。ボードは空で、AI の空状態が「Start importing →」で O2 に戻す。
- O2 には `Back` を出さない（D-184）。
- 「See everything Turnlane keeps」は外部のページではなくポップオーバー（保存するもの・保存も送信もしないものと、題名の保存を止める設定の1文）。

状態: 検出中（スケルトン）/ 検出あり / 片方だけ（「Codex wasn't found. If you start using it, Turnlane picks it up automatically.」）/ **O2-empty**（0件: 題名「No Claude Code or Codex sessions yet」、`Choose a folder…`（`CLAUDE_CONFIG_DIR` を別の場所にしている人向け）、主ボタンは `Continue`。`Continue` は空の一覧で同意を記録し、見つかったときから読む。`Not now` は何も読まない。D-181）/ 一部の元が読めない（行に ⚠ と理由、チェック不可）/ フォルダの選び間違い（赤の1行と `Choose another…`）。

### 4.3 O3 直近7日の取り込み（aha）

確定画像: `onb-O3-*.png`。

```
 Sources ✓ · Import · Calendar · Hooks · AI tools · Hours · Notifications · Start      2 / 8

 Laying out your last 7 days                                        5 of 7 days
 Newest days first. This usually takes under a minute.
 (要約の行の高さ。完了までは空)
 ┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
 │ Fri 10/2 │ Thu 10/1 │ Wed 9/30 │ Tue 9/29 │ Mon 9/28 │ Sun 9/27 │ Sat 9/26 │
 │ AI 1h05m │ AI 5h40m │ AI 6h02m │ AI 3h48m │ AI 5h55m │ ░░░░░░░░ │ ░░░░░░░░ │
 │ | Fix fl…│ | Add C… │ ...      │ ...      │ ...      │Importing…│ Waiting  │
 │ acme-web · fix/… 1h40m                                                    │
 └──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
 Claude Code · Default 84 ✓ · Claude Code · acme 12 ✓ · Codex 18 ⟳
 Conversation text is never saved or sent.

 ← Back                                    [ Skip the rest ]   [ Continue ⏎ ]
```

- 列は**新しい日を左**に置き、左から埋まる（取り込みを新しい順に行うため。5.3）。AI の作業が無い日は、日付が入る最小の幅に畳み「No AI work」。
- 列の中は AI の作業のラベル（3日ボードの R3 を読み取り専用で。灰の縦線・題名・`repo · branch`・PR 番号・長さ）を積む。入りきらなければ `+N more`。クリック・ドラッグは効かず、ホバーで全文の題名・`repo · branch`・時刻・AI 時間のツールチップだけ。
- 日の状態は API のまま: `pending` → スケルトン（光らない）と `Waiting`、`importing` → スケルトン（静かに光る）と `Importing…`、`done` → 見出しに `AI 5h40m`。
- 要約の1行は**全部の日が終わってから**出す（途中の数字は出さない）: 「Last 7 days: your AI agents worked 23h10m on 41 items and waited for you 38 times.」。数は AI の稼働時間、AI の作業（ボードのラベルと同じ数え方）、AI が人を待った回数。Idle・放置・自分の応答時間はカレンダーと在席で変わるので出さない（D-110 (3)）。行の高さは取り込み中から確保し、完了で列が動かないようにする。完了したら副題は「Newest days first.」だけにする。
- 7日分が終わったら `Continue` が押せる。それより前の日は取り込まない（D-181）。
- `Skip the rest`: 7日分の終わりを待たずに進む（7日のうち残りの日の取り込みは裏で続き、段の表示の Import は「済んだ」）。完了したら押せない見た目にする（幅と位置は保つ）。

状態: 取り込み中（日ごとのスケルトン）/ 完了 / **O3-sparse**（7日で AI の作業が3件未満: 要約の代わりに「Not much recent AI work yet. New sessions appear on the board automatically.」）/ 一部のファイルが読めない（元の行に赤で「⚠ 2 files skipped」、続行可）/ デーモンが落ちた（4.9 の B3）。

### 4.4 O4 カレンダー（任意）

```
 Calendar (optional)
 See meetings next to your AI's work, and put planned tasks on your calendar.
 turnlane uses the calendars already in the macOS Calendar app
 (Google, iCloud, Exchange). No sign-in.

 · Meetings don't count as time you left an AI waiting.
 · Time blocks you plan are written to your default calendar
   (you can change or turn this off in Settings › Calendar).

                       [ Not now ]   [ Allow calendar access ]
```

- 主ボタン: `desktop_setup` でヘルパのエージェントを登録 → ヘルパが許可を求める（OS のダイアログ）→ 結果をデーモン経由で受け取る。
- 許可後: 「12 calendars found · Work · Example is your default」と、祝日カレンダーの自動判定の結果を1行ずつ出し、O3 の過去7日を再計算（`rederive`）する。
- 状態: 説明 / 許可待ち（OS のダイアログ表示中）/ 許可済み（カレンダー数）/ **拒否**（「システム設定 > プライバシーとセキュリティ > カレンダー で Turnlane をオンにしてください」＋ `Open System Settings`。オンにしたら自動で進む）/ カレンダーが0件（Calendar.app にアカウントが無い: 「Calendar.app にアカウントを追加すると予定が出ます」）/ ダイアログを出せない・ヘルパが起動しない（理由と `Try again`・`Open System Settings`・`Not now`。下）。
- 実装（M6-23）: 主ボタンは `POST /api/onboarding/calendar/connect`。`desktop_setup`（M6-14）ができるまでは、デーモンが同梱の turnlane で `calendar install` → `calendar authorize` を順に起動する（`apps/daemon/src/calendar/connect.ts`。手段を渡していない起動では `unavailable` と返り、画面は「ターミナルで turnlane calendar install」の案内と `Continue`）。結果は待たず、画面が `GET /api/calendar/status` を 1 秒ごとに読む: 接続済み＋フルアクセスで同期が済めば許可済み（0 件なら「カレンダーはまだありません」）、拒否・書き込みのみなら拒否（読み続け、オンになれば許可済みに進む）、決まらないまま上限を過ぎれば失敗（下の「ダイアログを出せない」）。許可済みの後は `Not now` を出さず `Continue` だけ（`PUT step calendar done` で過去7日を数え直す）。拒否のまま `Continue` は `skipped`。`Open System Settings` は `POST /api/onboarding/open-settings { pane: "calendars" }`（デーモンが `/usr/bin/open` で `x-apple.systempreferences:` を開く）。
- **ダイアログを出せない**（2026-10-21 の Neo: 初めての Mac で `turnlane calendar authorize` が 1 で終わり、画面が「macOS の応答を待っています」のまま止まった）: 接続（`turnlane calendar authorize`）が 0 以外で終わった・起動できなかった・決まらないまま上限を過ぎた（authorize が動いている間は OS のダイアログを人が読んでいることがあるので押してから 120 秒、authorize が 0 で終わってからは 30 秒、接続の結果が分からなければ押してから 30 秒）、のどれかで待ちを打ち切り、「Couldn't show the macOS permission dialog」と理由を出す。理由は turnlane の stderr の要約（英語が正。日本語の画面でも英語のまま）か、画面の文言（30 秒応答なし / ヘルパが起動しない / ヘルパを起動できない）。ボタンは `Try again`（主。⏎）・`Not now`（Esc。`skipped`）と、理由の箱の中の `Open System Settings`（プライバシーとセキュリティ › カレンダー。「Turnlane が一覧にあればそこでオンに」と添える）。失敗を出した後も `/api/calendar/status` を読み続け、許可・拒否になればその表示に進む。デーモンは最後に始めた接続の結果を覚え、画面は `GET /api/onboarding/calendar/connect` で読む（`{ attempt: { id, state: running|ok|failed, code, detail } }`。detail はログに書かない）。段階の決め方は `apps/web/src/onboarding/calendar-connect.ts`（O4 と 設定 › カレンダー で共通）。
- **許可の後のヘルパのつながり直し**（2026-10-21 の Neo、2 回目: ダイアログで許可した直後に「カレンダーのヘルパが起動しません」になった。許可で常駐のヘルパが起こし直され、つながっていない数秒に「押してから 30 秒」を過ぎていた）: authorize は許可・拒否のどちらでも常駐のヘルパを起こし直す（D-130。拒否のときも、常駐のヘルパが古い「未決定」を返し続けないように）。デーモンは authorize が 0 で終わった後、常駐のヘルパがフルアクセスでつながるまで 20 秒待ち、つながらなければアプリの `--setup reregister calendarHelper` で起こし直してもう 20 秒待つ。それでもつながらなければ失敗（理由「Access was allowed, but the calendar helper did not reconnect. Quit and reopen Turnlane」）。画面の「ヘルパがつながっていない」の文言も「Turnlane を終了して開き直す」「それでもだめなら入れ直す」を次の一手として添える。
- **常駐が署名の不一致で殺される**（2026-10-21 の Neo、3 回目: ad-hoc 署名のアプリを同じ版のまま zip で置き換えた後、SMAppService の常駐（デーモン・ヘルパ）が `SIGKILL (Code Signature Invalid)`・Launch Constraint Violation で起動直後に殺され続けた。`open -n` で起こした authorize のインスタンスは動く）: `turnlane doctor` に launchd から見た状態（state・runs・最後の終わり方）の行を出し、署名の不一致なら「入れ直す」を案内する。デーモンはアプリのビルド（TurnlaneBuild）が前回の起動と違えば、ヘルパの登録を 1 回し直す（`<データ>/helper-build`。2.5）。デーモン自身の登録のし直しはアプリの側（起動ページ）で行う。

### 4.5 O5 hooks（任意）

```
 Know the moment an AI is waiting for you (optional)
 Without hooks, turnlane notices within about a minute by watching log files.
 With hooks, it's immediate.

 [✓] Claude Code  ~/.claude        adds 7 entries to settings.json
 [✓] Claude Code  ~/.claude-acme   adds 7 entries to settings.json
 [✓] Codex        ~/.codex         adds 5 entries to hooks.json
     ↳ Codex runs new hooks only after you approve them:
       open Codex and run /hooks, then approve the "turnlane" entries.

 Only turnlane's own entries are added, at the end. A backup is saved
 next to each file. Show changes ▸

                       [ Not now ]   [ Install hooks ]
```

- `Show changes ▸` で `turnlane hooks install --dry-run` の差分を出す。
- インストール後、Claude Code は即時に `installed`。Codex は `pending_trust` で、「Codex で `/hooks` を開いて承認してください」と、承認が届いたら（`receiving`）行が ● に変わることを示す。O5 では承認を待たずに進める。
- 状態: 説明 / インストール中 / 完了（行ごとに ● installed / ◐ waiting for approval）/ 一部失敗（JSON として読めない・書く直前に変わった: 行に ⚠ と理由、`Retry`）/ hooks が無効化されている（`disableAllHooks` 等: 「この設定ディレクトリでは hooks が無効です」）/ 該当なし（O2 で取り込み元が0件なら O5 を出さない）。
- 実装（M6-24）: 開いたら `POST /api/onboarding/hooks { dryRun: true }` で差分を取り、行に「adds 7 entries to settings.json」（既に入っていれば「already installed」）。`Show changes ▸` はイベント名・command・退避の名前（ファイルの他の部分は出さない）。主ボタンで `dryRun: false`（段は進めない）。結果の行は ● installed / ◐ waiting for /hooks approval（Codex）/ ⚠ と理由。失敗があれば `Not now` の代わりに `Retry`、主ボタンは `Continue`（失敗が残っていれば段は `failed`）。対象が 0 件なら画面を出さずに `skipped`。

### 4.5a O5a AI から Turnlane を使えるようにする（任意。D-145）

```
 Let your AI add tasks to Turnlane (optional)
 Register Turnlane's MCP server so Claude Code / Codex can add tasks,
 read today's plan, and see your turn.

 [✓] Claude Code  ~/.claude        adds "turnlane" to ~/.claude.json
 [✓] Claude Code  ~/.claude-acme   adds "turnlane" to ~/.claude-acme/.claude.json
 [✓] Codex        ~/.codex         adds [mcp_servers.turnlane] to config.toml

 Only the "turnlane" entry is added. A backup is saved next to each file.
 Running sessions pick it up after a restart. Show changes ▸

                       [ Not now ]   [ Register ]
```

- 対象は O2 で同意した（取り込む）Claude Code / Codex の取り込み元だけ。O2 で取り込み元が0件、または同意しなかったら O5a を出さない。
- `Show changes ▸` で `turnlane mcp install --dry-run` と同じ内容（書く `turnlane` の項目と退避の名前）を出す。
- 状態: 説明 / 登録中 / 完了（行ごとに ● registered）/ 一部失敗（読めない・書く直前に変わった・config.toml を安全に書き換えられない: 行に ⚠ と理由、`Retry`）/ 既に登録済み（● のまま進める）/ 別の turnlane を指している（`Register` で直す）。
- 実装は画面より先に CLI と API で入れた: `turnlane onboarding mcp [--dry-run]`（同意した取り込み元に登録し、段 `mcp` を `done`、失敗があれば `failed` にする）、状態は `GET /api/sources` の `mcpState`（取り込み元ごと）。画面（M6-24）は O5 と同じ部品（`ConfigStep`）で、`POST /api/onboarding/mcp { dryRun }` を使う。行は「adds turnlane to .claude.json」「fixes turnlane in config.toml（別の turnlane を指す）」「already registered」。

### 4.6 O6 計画の目安と稼働日（D-105 で「勤務時間」から差し替え）

```
 When do you usually plan your day around?
 Used for free time and "tomorrow morning". Idle only counts while you are using your Mac.

 Working days   [Mon][Tue][Wed][Thu][Fri][ Sat ][ Sun ]
 Plan guide     10:00 – 19:00     Different hours per day ▸
 Holidays       Japan holidays (from your calendar)  ▾
 Day starts at  04:00  (after midnight still counts toward the previous day)

                                      [ Continue ]
```

- 初期値は今の設定の初期値（平日 10:00〜19:00、D-062・D-106）。設定 > 計画の目安と稼働日 と同じ部品を使う。画面に「勤務」「working hours」の言葉は出さない。
- 祝日はカレンダーを許可していれば自動判定の結果、していなければ `None`（後から設定で選べる）。
- `Continue` で保存する。計画の目安は Idle に影響しないので、過去7日の再計算は要らない（空き時間だけが変わる）。この段は飛ばせない（初期値のままでも `Continue` で進めるので、実質の負担は無い）。
- 実装（M6-25）: 値は設定と同じ API（`work_hours.planned`・`workdays.weekdays`・`day_boundary`）で、変えたらすぐ保存する（設定画面と同じ）。稼働日は曜日の札、計画の目安は稼働日が全部同じなら 1 組の入力（`Different hours per day ▸` で曜日ごと。曜日ごとに違う値があれば最初から曜日ごと）、祝日は読むだけ（自動判定の結果か `None`）、一日の始まりは HH:MM。主ボタンだけ（`Not now` は無い）。

### 4.7 O7 通知

```
 Get notified when an AI needs you
 · Approval requests and errors: right away
 · Finished work waiting for review: bundled every 15 minutes
 · Paused while you focus on a meeting

                       [ Not now ]   [ Turn on notifications ]
```

- 主ボタン: `desktop_setup` で `UNUserNotificationCenter` の許可を求める。許可後、確認用の通知を1通出す（`Notifications are on`）。
- 状態: 説明 / 許可済み / 拒否（`Open System Settings`）/ ブラウザで開いている（アプリが無い。ブラウザ通知の許可に切り替える）。
- 実装（M6-25）: アプリがつながっていれば（`GET /api/desktop/status`）`POST /api/desktop/notifications { action: "request" }` で求め、アプリが知らせる状態（`desktop_status`）を 30 秒まで 1 秒ごとに読み直す。許可済みは `Continue` だけ（`done`）、拒否は `Open System Settings`（`open_settings`）と `Continue`（`skipped`）。つながっていなければブラウザの `Notification.requestPermission()`。通知の無い環境は案内だけ。確認用の通知（「Notifications are on」）はアプリ側の処理で、まだ出さない。

### 4.8 O8 はじめる

```
 You're set.
 ● AI import  3 sources        ● Calendar  12 calendars
 ◐ Hooks      Codex waiting for /hooks approval
 ○ Notifications  off — turn on in Settings › Notifications

 Menu bar: turnlane lives in the menu bar when the window is closed.
 Quick add: ⌥⇧Space from anywhere.   Command line: turnlane add "…" (Install ▸)

                                        [ Open the board ]
```

- 各行はスキップ・失敗した段を ○ / ◐ / ⚠ で示し、クリックで設定の該当の節を開く。
- 主ボタンは常に `Open the board`（朝の計画は廃止。D-192）。2つ目のボタンは無い。
- `Install ▸` は turnlane を PATH に置く操作（Homebrew 版では既に置かれているので出さない）。アプリの IPC（`installCliLink`。M6-15）ができるまで出さない。
- 実装（M6-26）: 行は `startRows()`（`apps/web/src/onboarding/steps.ts`）で決める: AI import（取り込む元の数。7日分が終わっていなければ ◐「finishing the last 7 days in the background」。同意なしは ○）、Calendar（カレンダー数。拒否は ⚠、未接続は ○）、Hooks（全部 ● なら installed、Codex の承認待ちがあれば ◐、届かない（silent）があれば ⚠、無ければ ○）、AI tools（全部登録済みなら ●）、Notifications（● on / ○ off）。同意なし・取り込み元なしなら Hooks と AI tools の行は出さない。メニューバーとクイック入力の案内はアプリの中（かアプリがつながっている）だけ。「AI に頼む」の端末のオートメーションの許可は段にせず、最初に頼んだときに案内する（今の作りのまま。M6-26 で確認）。

### 4.9 塞がる状態（どの段でも出うる）

| ID | 状態 | 表示 | 出口 |
|---|---|---|---|
| B1 | バックグラウンドの登録が承認待ち（ログイン項目でオフ） | 「Turnlane のバックグラウンド項目がオフになっています」 | `Open Login Items`（`openSystemSettingsLoginItems`）。オンになったら自動で進む |
| B2 | デーモンが15秒応答しない | 「バックグラウンドのプロセスが起動しません」 | `Retry`、`Copy diagnostics`（`turnlane doctor --redact` の出力） |
| B3 | 取り込み中にデーモンが落ちた | 「取り込みが中断しました。再開します…」（launchd が起こし直す。カーソルで続きから） | 自動。30秒戻らなければ B2 |
| B4 | アプリを `/Applications` 以外（ダウンロードフォルダ・dmg の中）から開いた | 「Turnlane を Applications フォルダに移してから開いてください」（App Translocation で `SMAppService` が動かないため） | `Move to Applications`（移して開き直す） |
| B5 | カレンダーの許可のダイアログを出せない（O4・設定 › カレンダー） | 「Couldn't show the macOS permission dialog」と理由（turnlane の stderr の要約、または 30 秒応答なし） | `Try again`、`Open System Settings`（カレンダー）、`Not now`（O4 のみ）。許可されれば自動で進む（4.4） |

### 4.10 移行（旧配置がある場合。オーナーの環境）

```
 Turnlane is now one app
 We found an earlier developer install. Move it to the new layout?
 · Stops the old background processes and starts the ones inside Turnlane.app
 · Updates hooks to the new path (Codex: approve again with /hooks)
 · Moves the old TurnlaneCalendarHelper.app and Turnlane.app to the Trash
 Your data stays as it is.
 macOS may ask for calendar, notification and automation access again.

                       [ Not now ]   [ Migrate ]
```

状態: 説明 / 実行中（2.7 の手順の行ごとに ✓）/ 完了（許可の再要求があればその案内）/ 失敗（どの手順で止まり、旧配置に戻したか）。

---

## 5. デーモン側の設計

### 5.1 オンボーディングの状態

設定キー `onboarding`（`setting` テーブル、`mutate()` で書く。`packages/core/src/config.ts` に追加）:

```ts
type Onboarding = {
  state: "pending" | "consented" | "done";
  step: "sources" | "import" | "calendar" | "hooks" | "mcp" | "hours" | "notifications" | "start";
  consentedAt: number | null;            // epoch ms。null なら取り込みを始めない
  steps: Record<Step, "pending" | "done" | "skipped" | "failed">;
  version: 1;                            // 流れを変えたときに出し直す判断用
};
```

- マイグレーション: `ingest_cursor` に行がある DB は `{ state: "done", consentedAt: <最初のカーソルの updated_at> }` にする（オーナーの環境ではオンボーディングを出さない）。
- 新しい DB は `{ state: "pending", consentedAt: null }`。

### 5.2 同意の前の取り込みのゲート

- `consentedAt` が null の間、`Supervisor.start()` は `detect()` だけを行い、`scanAll()`・監視・spool の取り込みをしない。
- 検出の件数は `listStreams()` の結果（パスと mtime）だけで数える。ファイルを開かない（7日の件数、最終の更新時刻）。
- 取り込む範囲（D-181）: 最初の同意のときに「直近7日の始まり」（6日前の論理日の始まり）を `importSince` に記録する。まだ読んでいないストリームのうち、更新時刻がそれより前のものは、今も後からも読まない。既存の利用者（5.1 の移行）は `importSince` が null で、制限は無い。
- 同意（`POST /api/onboarding/consent`）で `consentedAt` を書き、`enabled` を反映し、`scanAll()` と監視を始める。
- `Not now` のまま進んだ場合も取り込みは止まったまま。設定 > AI の取り込み と空状態から同意し直せる。
- 同意を取り消す操作（全取り込み元をオフ）は今の設定のまま。取り込み済みのデータを消す操作は今回は作らない（10 章）。

### 5.3 新しい日から取り込む順序と進捗

- `scanAll()` の並べ順を「priority → mtime の新しい順」にする（今は priority だけ）。
- 日 D（論理日）が「完了」した条件: mtime が D の始まり以降のストリームがすべて処理済み（ストリームは後の日にも書き足されるので、新しい順に処理すれば今日 → 7日前の順に完了する）。
- SSE `import_progress`: `{ days: [{ date, state: "pending" | "importing" | "done" }], sources: [{ id, state, skipped }] , doneAt: number | null }`。日の状態が変わったときだけ送る。
- 7日分の完了後の要約は `GET /api/onboarding/summary?days=7`（AI 時間・カード数・待ち区間の数。在席に依存しない値だけ）。
- 通知: `onboarding.state` が `done` になるまで `notify` を送らない。`done` の後も、取り込み時点で既に過去の出来事（終わってから5分を超えたもの）からは通知しない（バックフィルで大量に鳴らさない）。今の判定がこれを満たしているかを M6-20 で確かめる。

### 5.4 API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/onboarding` | 5.1 の状態と、各段の現在値（検出結果の件数、カレンダーの許可、hooks の状態、通知の許可、計画の目安） |
| PUT | `/api/onboarding/step` | `{ step, status }`（段の完了・スキップ。`start` の完了で `state=done`） |
| GET | `/api/onboarding/detect` | 検出のやり直しと結果（`{ sources: [{ id, tool, label, rootPath, sessions7d, lastActivityAt, readable, reason, manual }] , claudeDesktop: { present, viaSourceId } }`） |
| POST | `/api/onboarding/consent` | `{ enabledSourceIds }`。同意と取り込みの開始 |
| GET | `/api/onboarding/summary?days=7` | O3 の1行 |
| POST | `/api/onboarding/restart` | `Run setup again`（`state=consented` か `pending` に戻し、`step` を先頭に。取り込み済みのデータは消さない） |
| POST | `/api/onboarding/hooks` | `{ dryRun }`。同意した取り込み元の設定ディレクトリごとに hooks を入れる（`turnlane hooks install` と同じ関数。O5）。対象ごとの結果（足した・直したイベント名、退避、エラー、Codex の承認待ち）。段は進めない |
| POST | `/api/onboarding/mcp` | `{ dryRun }`。同意した取り込み元に MCP を登録する（`turnlane mcp install` と同じ関数。O5a）。段は進めない |
| POST | `/api/onboarding/calendar/connect` | O4 の主ボタン。ヘルパの常駐と許可のダイアログを始める（結果は `/api/calendar/status`）。`{ started, reason: "unavailable" \| "failed" \| null }` |
| GET | `/api/onboarding/calendar/connect` | 最後に始めた接続の結果 `{ attempt: { id, state, startedAt, finishedAt, code, detail } \| null }`（4.4 のダイアログを出せない） |
| POST | `/api/onboarding/open-settings` | `{ pane: "calendars" \| "notifications" }`。システム設定の画面を開く |
| SSE | `import_progress` | 5.3 |

カレンダー・計画の目安・通知の各段は、上に加えて今の API（`/api/sources`、`/api/calendar/status`、`/api/config/:key`、`/api/desktop/status`、`/api/desktop/notifications`）を使う。

### 5.5 アプリ（Rust）の IPC

`desktop_setup`（capability の `remote.urls` は今と同じ `127.0.0.1` だけ）:

| action | 内容 |
|---|---|
| `status` | 3つの登録の状態（`enabled` / `requiresApproval` / `notRegistered` / `notFound`）、通知の許可、アプリの場所（B4 の判定） |
| `registerCalendarHelper` / `unregisterCalendarHelper` | ヘルパのエージェント |
| `setOpenAtLogin` | `{ on }`（mainApp） |
| `requestNotifications` | 通知の許可を求め、結果を返す |
| `openSettings` | `{ pane: "loginItems" | "calendars" | "notifications" | "automation" }`（URL は Rust 側の固定の表から選ぶ） |
| `installCliLink` | `~/.local/bin/turnlane` のリンク（Homebrew 版では何もしない） |
| `uninstall` | 2.6（hooks の削除は同梱の `turnlane uninstall --all --json` を実行） |

### 5.6 実装メモ（M6-18〜M6-20。画面より先にデーモン・API・CLI を入れた）

- 設定 `onboarding` は `turnlane config` の一覧に入れない内部の設定（local_only）。同意は `POST /api/onboarding/consent` か `turnlane onboarding consent` でだけ記録する。取り込みのゲートは `state` ではなく `consentedAt` で決める（`Not now` のまま O8 まで進めた人は `done` で同意なし）。
- 移行は起動時に行う（SQL のマイグレーションは無い）: 設定が無く `ingest_cursor` に行があれば `done`・`consentedAt` は最初のカーソルの `updated_at`。テスト・dev-board・E2E は `startDaemon({ onboarding: { assumeDone: true } })`。
- 同意の前は、検出（`ai_source` の登録）だけ。セッションのファイル・spool・`sessions/<pid>.json` の probe・他ツールの設定ファイル（hooks の状態）を読まない。`turnlane reingest` も何もしない。
- 通知の停止（5.3）: `state` が `done` になるまでと、まとめての取り込み（カーソルの無い・`live` でないストリームの読み込み。同意の後・新しい取り込み元・reingest）の間は、判定だけ回して通知しない。まとめての取り込みが終わったら判定を1回回し、そのフォローアップを見たことにする（後から過去の出来事を通知しない）。
- 検出の件数は、セッションのストリーム（Codex の `session_index.jsonl` と Claude のサブエージェントを除く）の更新時刻で数える。`Choose a folder…` は `POST /api/onboarding/sources { path }`（`projects/` のあるディレクトリだけ）で、内部の設定 `ingest.extra_roots` に入れ、Claude Code のアダプタの検出の候補に足す（`DetectEnv.extraRoots`）。名前はディレクトリ名。
- 進捗は `GET /api/onboarding/progress` と SSE `import_progress`（日・元の状態が変わったときだけ、束ねずに送る）。済んだ日は戻らない。7日分が終わったら判定を1回回してから `doneAt` を知らせる。
- 要約の「AI が待った回数」は待ち区間の行ではなく、判定の実行で見つけた待ちの始まりから数える（在席の記録を始める前の日は待ち区間の行を作らないため。D-110 (3)）。
- O4 で `PUT /api/onboarding/step { step: "calendar", status: "done" }` を受けたら、過去7日の待ちを作り直す（`rederive --wait --since` と同じ。在席の記録を始める前の日は作り直さない）。
- O4〜O5a（M6-23・M6-24）: hooks と MCP のインストールは `OnboardingService.installHooks / installMcp`（CLI と同じ core の関数。書く turnlane のパスは `launch.cliPath`、無ければ `~/.local/bin/turnlane`）。hooks を書いた後は取り込みの検出（`reconcile`）を回して `hooks_state` を読み直す。カレンダーの接続は `startDaemon({ calendar: { connect } })` で渡す手段（bin.ts は `cliCalendarConnect`、テスト・開発は偽のヘルパを接続する関数）。すぐ失敗したもの（1.5 秒以内の例外）だけ `failed` と返す。システム設定は `startDaemon({ openSettings })`（bin.ts は `/usr/bin/open`。テスト・開発は開かない）。

---

## 6. 失敗・スキップ・やり直し

| 段 | スキップしたとき | 後からやる場所 | 失敗の扱い |
|---|---|---|---|
| O2 同意 | 取り込みしない。ボードの AI に空状態「取り込みを始める →」 | 設定 > AI の取り込み の `Start importing`（O2 と同じ画面を出す） | 読めない元は ⚠ で続行 |
| O3 直近7日の取り込み | 7日のうち残りの日は裏で続く | — | 失敗したファイルは設定 > AI の取り込み の元ごとの健全性（ux-mvp 4.9） |
| O4 カレンダー | ヘルパを登録しない。予定のセクションに「カレンダーをつなぐ →」 | 設定 > カレンダー の `Allow calendar access`（フルアクセスでつながっていなければ節の先頭に出す。O4 と同じ段階と失敗の箱。`Not now` は無い） | 拒否は System Settings の案内。ダイアログを出せない（4.4・B5）は理由と `Try again`・`Open System Settings` |
| O5 hooks | ファイル監視だけ | 設定 > AI の取り込み の hooks の行（`Install`） | 行ごとの ⚠ と `Retry` |
| O5a AI から使う（MCP） | AI から Turnlane にタスクを入れられない | 設定 > AI の取り込み の取り込み元ごとの MCP の状態と `turnlane mcp install` の案内 | 行ごとの ⚠ と `Retry` |
| O6 計画の目安 | 飛ばせない（初期値で進める） | 設定 > 計画の目安と稼働日 | — |
| O7 通知 | 通知なし。メニューバーの件数は出る | 設定 > 通知 | 拒否は System Settings の案内 |
| 全体 | — | 設定 > 一般 `Run setup again`（データは消さず、各段に今の値を入れて最初から通す。同意済みなら O2 は確認だけ） | — |

設定の各節の先頭に、オンボーディングで飛ばした項目を `Not set up` の行として出す（例: カレンダー「Not connected · Connect」）。

---

## 7. デザインで詰める画面と状態（Claude Design 用）

O1〜O3（と塞がる状態 B1〜B4、共通の部品）は確定した（[docs/design/onboarding-v1/](../design/onboarding-v1/)）。O4〜O8 は画像を作らず、確定した部品で実装して動くもので確認した（M6-23〜M6-26。画像は `bun scripts/screens-onboarding.ts --only O4,O5,O5a,O6,O7,O8`）。下は当初の優先順（記録）。

| 優先 | 画面 | 作る状態 | 確認したいこと |
|---|---|---|---|
| 1 | O3 バックフィル | 取り込み中（5/7）・完了（要約の1行あり）・O3-sparse | 埋まっていく瞬間の驚き。数字が事実だけに見えるか |
| 2 | O2 取り込み元と同意 | 検出あり（複数プロファイル）・O2-empty・読めない元あり | 読む / 読まないの安心。プロファイルを外せると分かるか |
| 3 | O1 Welcome | 通常 | 1画面で「何をする・何をしない」が伝わるか |
| 4 | O5 hooks | 説明・完了（Codex 承認待ち） | 任意に見えるか。Codex の `/hooks` の案内が分かるか |
| 5 | O4 カレンダー | 説明・許可済み・拒否 | 任意に見えるか |
| 6 | O8 はじめる | 全部済み・一部スキップ | 次の一歩が1つに見えるか |
| 7 | O6 / O7 | 通常 | 設定の部品の流用で足りるか（画像なしで実装してよい候補） |
| 8 | 塞がる状態 B1〜B4、移行 4.10 | 各1枚 | 画像なしで実装してよい候補 |

共通部品: 上部の段の表示、`Not now` と主ボタンの対、状態のドット（● ◐ ○ ⚠）。ライト・ダーク両方。

---

## 8. 確認手順（新しい macOS アカウントでの通し）

オーナーの環境に触れずに確かめるため、**新しい標準ユーザー**（例: `turnlane-test`）を作って行う。スパイク M6-S8 も同じアカウントで行う。

準備（テスト用アカウントで）:
1. Claude Code と Codex を入れて、それぞれ数日分のセッションを作る（数件でよい。私的なリポジトリは使わない）。2つ目の設定ディレクトリ（`CLAUDE_CONFIG_DIR=~/.claude-b`）でも1件作る。
2. Calendar.app に予定の入ったカレンダーを1つ用意する（ローカルのカレンダーでよい）。

| # | 操作 | 期待 |
|---|---|---|
| 1 | `brew install --cask <tap>/turnlane`（公開前はテスト用の tap か、Releases の zip） | Gatekeeper の警告が出ない。`turnlane --version` が通る |
| 2 | Turnlane を開く | O1。この時点でログイン項目に Turnlane が無い |
| 3 | `Get started` | 「バックグラウンド項目を追加」の通知。ログイン項目に Turnlane が1行。O2 に2つの Claude Code と Codex が出る |
| 4 | O2 で `~/.claude-b` を外して `Import the last 7 days` | O3 が新しい日から埋まる。`~/.claude-b` の作業は出ない。DB に本文が無い（`turnlane doctor` のプライバシー監査が 0 件） |
| 5 | O4 `Allow calendar access` | OS のダイアログに Turnlane（またはヘルパ）の名前。許可後カレンダー数が出る。システム設定 > カレンダー の表示名を記録 |
| 6 | O5 `Install hooks` | Claude の settings.json の末尾に Turnlane のエントリ、`.bak-turnlane-*` ができる。Codex で `/hooks` を承認 → 行が ● |
| 7 | O6・O7 | 確認用の通知が出る |
| 8 | O8 `Open the board` | ボードが開く（朝の計画は無い。D-192） |
| 9 | Claude Code で許可待ちを起こす | 数秒以内に通知（音あり）とメニューバーの件数 |
| 10 | アプリを ⌘Q → ログアウト → ログイン | アプリが起動し、オンボーディングは出ない |
| 11 | 古い版を入れた状態から `brew upgrade --cask turnlane` | 1分以内にデーモン・ヘルパが新しい版（`turnlane doctor`）。アプリが起こし直される。許可は外れない |
| 12 | 設定 > 一般 `Run setup again` | O2 から通せる。データは残る |
| 13 | メニュー `Uninstall Turnlane…` → `brew uninstall --zap --cask turnlane` | hooks のエントリが消え（Codex の再承認案内）、ログイン項目から消え、データディレクトリが無い |
| 14 | 途中で止める: 3 の後にログイン項目で Turnlane をオフにしてから開く | B1 が出て、オンにすると進む |
| 15 | ダウンロードフォルダの zip から直接開く | B4 |

結果は `docs/dev/onboarding-check.md`（M6-27 で作る）に残す。スクリーンショットはテスト用アカウントのダミーデータのものだけにする（D-085）。

---

## 9. タスクと見積

phase0-plan 4.8 の M6 に追記した（M6-S8・M6-13〜M6-27、+13.5人日）。順序:

| 段 | 内容 | 前提 |
|---|---|---|
| 1 | 14日の常用と振り返り（D-088 (1)）と並行: M6-S8（スパイク、新しい macOS アカウント）、名称・bundle ID の接頭辞の確定（market-researcher） | — |
| 2 | アプリ統合: M6-13 → M6-14 → M6-15・M6-17。並行してデーモン側: M6-18 → M6-19・M6-20 | M6-S8 |
| 3 | 画面: M6-21 → M6-22（O2・O3）→ M6-23〜M6-26 | Claude Design で O3・O2・O1 が決まっている |
| 4 | オーナーの環境の移行: M6-16（Apple Development 署名のアプリで常用を続ける） | 2、名称の確定 |
| 5 | 公開準備の残り: M6-1〜M6-7、Apple Developer Program 登録（D-087）→ M6-8 → M6-9 → M6-10 → M6-12 | 4 |
| 6 | M6-27（新しいアカウントで 8 章の通し）→ M6-11（公開判定） | 5 |

---

## 10. オーナー判断が必要な点

| # | 論点 | 推奨 | 理由 |
|---|---|---|---|
| 1 | 名称と bundle ID の接頭辞の確定を、オーナーの移行（M6-16）より前に済ませるか | 済ませる | 接頭辞が変わるたびに TCC の許可と SMAppService の登録が外れ、移行が2回になる |
| 2 | 配布の経路 | Homebrew cask（自前の tap）を主、Releases の zip も置く | zip はリリースの副産物で追加の手間が小さい。Homebrew を使わない人の入口になる |
| 3 | 対応する Mac | Apple Silicon のみ（macOS 14 以降） | Bun の単一バイナリと Tauri を2系統ビルド・署名・確認する手間に見合う利用者が少ない |
| 4 | 取り込む過去の範囲 | **直近7日だけ（D-181 で決定）**。裏で残り（最大30日）を取り込む当初の案はやめた | 初めて開いた人が見たいのは最近の自分。読む量が少ないほうが初回の処理とプライバシーの点でよく、説明も1文で済む |
| 5 | バックグラウンドの登録のタイミング | Welcome の `Get started` を押してから | 何も押していないのに「バックグラウンド項目を追加」の通知が出るのは不信感につながる |
| 6 | MCP の登録をオンボーディングに入れるか | **入れる（D-145 で決定）**。hooks の次に O5a。同意した取り込み元にだけ登録する | 登録が無いと AI のセッションが Turnlane を知らず、タスクを入れられない（新しい利用者は全員これに当たる）。当初の推奨（入れない）は D-145 で変えた |
| 7 | 取り込み済みデータの削除（同意の取り消し）をオンボーディングと同時に作るか | 今回は作らない。`zap` と README の手順で代える | 公開の範囲を広げない。需要が出たら設定 > データ に足す |
| 8 | アンインストールの導線 | アプリのメニュー `Uninstall Turnlane…` ＋ cask の `caveats` で案内 | Homebrew からは他ツールの hooks の設定を戻せない |
