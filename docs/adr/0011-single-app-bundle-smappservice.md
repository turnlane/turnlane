# ADR 0011: 配布物を Dayline.app 1つにまとめ、常駐プロセスを SMAppService で登録する

- ステータス: Proposed（PO の確認待ち。スパイク M6-S8 の結果で 3・4 の細部を確定する） / Amends [ADR 0001](./0001-local-daemon-spa-tauri.md)、[ADR 0003](./0003-calendar-eventkit-phase0-google-api-phase1.md)、[ADR 0010](./0010-desktop-shell-in-phase0-as-daemon-client.md)。Amended by [ADR 0016](./0016-rename-to-turnlane.md)（名前と移行。本文の旧名は 0016 の対応表で読み替える）
- 日付: 2026-10-06
- 関係: ADR 0001 の「dl がデーモンを launchd 管理する（`dl self-install`）」を、配布版では Dayline.app による登録に置き換える（開発時の `dl self-install` は残す）。ADR 0003 の「ヘルパは独立した LaunchAgent」を、Dayline.app に同梱した LaunchAgent に置き換える（ヘルパが Swift の別プロセスで EventKit の権限を持つことは変えない）。ADR 0010 の決定 4（起動は dl が書く LaunchAgent `dev.dayline.desktop`）と決定 5（ヘルパは当面別のまま）を置き換える。設計の詳細は [onboarding.md](../spec/onboarding.md) の 2 章、タスクは [phase0-plan.md](../spec/phase0-plan.md) 4.8 の M6-S8・M6-13〜M6-17

## Context

- 今の配置は開発者向け: `bun run build` → `dl self-install` が `~/.local/bin` に `dl` / `daylined` を置き、`~/Library/LaunchAgents` に `dev.dayline.daemon` と `dev.dayline.desktop` を書く。カレンダーヘルパは `dl calendar install` が `~/Applications/DaylineCalendarHelper.app` と `dev.dayline.calendar-helper` を置く。利用者から見えるアプリが2つあり、ターミナルの操作が前提になっている。
- 公開時は、見知らぬ人が Homebrew cask（Developer ID 署名・公証済み）で入れ、ターミナルを開かずに使い始められる必要がある。利用者から見えるアプリを1つにするのは必須（D-056 (5)、D-088 (4)）。
- macOS 13 以降の `SMAppService` は、アプリの中に置いた LaunchAgent の plist（`Contents/Library/LaunchAgents/`）を、アプリ自身の登録として launchd に載せられる。plist の `BundleProgram` はバンドルからの相対パスで、アプリの場所が変わっても書き直さなくてよい。システム設定の「ログイン項目」にはアプリの名前で1行にまとまって出て、アプリをゴミ箱に入れると動かなくなる。
- TCC は許可を「どのプログラムか（bundle ID と署名の指定要件）」で覚える。`SMAppService` で登録したエージェントは、許可が親のアプリに付く場合がある（他のアプリでの報告あり）。カレンダー（ヘルパ）、通知（アプリ）、オートメーション（デーモンが `osascript` で端末を操作。D-060）の3つが関わる。
- Homebrew の cask は、`brew upgrade` のときに古い版の `uninstall` の段（`quit`、`launchctl` など）を実行する。`uninstall launchctl:` に書くと、更新のたびにエージェントが外れる。
- Bun の単一バイナリ（`daylined` / `dl`）は `.app` ではない裸の実行ファイルで、hardened runtime と `allow-jit` で署名している（docs/dev/codesign.md）。

## Decision

1. **配布物は `Dayline.app` 1つ**。中身（bundle ID の接頭辞 `dev.dayline.` は仮置きのまま。名称の確定で変える）:

   ```
   Dayline.app/Contents/
     MacOS/dayline                       # Tauri のシェル（dev.dayline.desktop）
     Helpers/daylined                    # デーモン（識別子 dev.dayline.daylined）
     Helpers/dl                          # CLI（識別子 dev.dayline.dl）
     Library/LoginItems/DaylineCalendarHelper.app   # カレンダーヘルパ（bundle ID dev.dayline.calendar-helper のまま）
     Library/LaunchAgents/dev.dayline.daemon.plist           # BundleProgram = Contents/Helpers/daylined, KeepAlive
     Library/LaunchAgents/dev.dayline.calendar-helper.plist  # BundleProgram = Contents/Library/LoginItems/…/DaylineCalendarHelper, KeepAlive
     Info.plist                          # 通知・カレンダー・オートメーションの用途の説明を含める
   ```

   署名は内側から順に Developer ID Application（hardened runtime、セキュアタイムスタンプ）で行い、`Dayline.app` 全体を公証して staple する。`daylined` / `dl` の entitlements は今と同じ `allow-jit` だけにし、オートメーションに要る場合だけ `com.apple.security.automation.apple-events` を足す（M6-S8 で確かめる）。

2. **常駐の登録は Dayline.app が `SMAppService` で行う**（Rust から objc2 で呼ぶ。`dl` は Bun なので呼べない。`SMAppService` は呼び出したプロセスのバンドルを基準にする）。
   - `SMAppService.agent(plistName: "dev.dayline.daemon.plist")`: 初回起動の Welcome で `Get started` を押したとき登録する。押す前は何も常駐させない。
   - `SMAppService.agent(plistName: "dev.dayline.calendar-helper.plist")`: オンボーディングか設定でカレンダーを使うと決めたときだけ登録する（使わない人の Mac で常駐させない）。
   - `SMAppService.mainApp`: 「ログイン時に Dayline を開く」。既定オン（D-056 (4) を引き継ぐ）。設定 > デスクトップアプリで切り替えられる。`dev.dayline.desktop` の LaunchAgent は配布版では使わない。
   - `status` が `requiresApproval`（利用者がログイン項目でオフにした）のときは、アプリが「システム設定 > 一般 > ログイン項目 で Dayline をオンにしてください」と `SMAppService.openSystemSettingsLoginItems()` のボタンを出す。
   - アプリと SPA の間の IPC は1つ足す（`desktop_setup`。操作は列挙で、登録・状態・通知の許可の要求・システム設定を開く・dl のリンク作成だけ。データを読み書きしない）。

3. **TCC の帰属**（M6-S8 で実機確認し、結果をこの ADR に追記する）:

   | 許可 | 求めるプロセス | 想定する帰属先 | 備え |
   |---|---|---|---|
   | カレンダー（フルアクセス） | DaylineCalendarHelper（launchd から起動） | ヘルパ（`dev.dayline.calendar-helper`）。親の Dayline に付く場合もある | 両方の Info.plist に `NSCalendarsFullAccessUsageDescription`。どちらに付いても動くようにし、表示名は「Dayline」に揃える |
   | 通知 | Dayline（Tauri） | `dev.dayline.desktop` | 変更なし |
   | オートメーション（端末・エディタの操作。D-060） | daylined が起動する `osascript` | daylined か親の Dayline | Dayline の Info.plist に `NSAppleEventsUsageDescription` |
   | フルディスクアクセス | — | 要らない（`~/.claude*`・`~/.codex` は保護の対象外） | 取り込み元が `~/Library/Containers/` にある場合の「他のアプリのデータ」の確認は M6-S8 で調べる |

4. **CLI のパス**:
   - hooks と MCP に書く `dl` のパスは、dayline が持つ固定の場所 **`~/Library/Application Support/dayline/bin/dl`**（アプリ内の `Contents/Helpers/dl` へのシンボリックリンク）にする。アプリは起動のたびにリンク先を自分の場所に合わせる。アプリを移動・更新しても hooks の command（と Codex の承認の hash）が変わらない。
   - 利用者がシェルで打つ `dl` は、Homebrew では cask の `binary` で `$(brew --prefix)/bin/dl` に置く。Homebrew 以外（Releases の zip）では、設定 > 一般 の `Install command line tool` が `~/.local/bin/dl` にリンクを作り、PATH に無ければ追記の方法を出す（管理者権限は求めない）。
   - `install.json`（データディレクトリ）に配置の方式（`app` / `dev`）・アプリのパス・版を記録し、`dl` はこれを見て `self-install` などの開発用コマンドを止める（方式が混ざると同じラベルのエージェントが2つになる）。

5. **版を揃える**: 配布物が1つなので、デーモン・ヘルパ・CLI・アプリは常に同じ版で入れ替わる。入れ替わった後に古いプロセスが残らないように:
   - **デーモン**は自分が入っているバンドルの `Info.plist` の版を1分ごとに確かめ、起動時と違えば正常終了する。launchd（KeepAlive）が新しいバイナリで起こし直す。
   - **ヘルパ**は `status` で版を返す。デーモンはアプリの版と違えば `shutdown` を送り、launchd が新しいヘルパで起こし直す。
   - **アプリ**は `brew upgrade` で終了される（cask の既定）。デーモンは、更新の前にデスクトップのクライアントがつながっていた場合に限り、新しい版で起きた後に `open -g -b dev.dayline.desktop` でアプリを起こし直す。Homebrew 以外で入れ替えた場合（アプリが動いたまま）は、アプリが自分のバンドルの版の変化に気づき、ウインドウを閉じているときは自分で再起動し、開いているときはメニューに `Restart to finish update` を出す。
   - `SMAppService` の登録は同じ場所・同じ Team ID のアプリに置き換わっても残る前提（M6-S8 で確かめる）。アプリは起動のたびに登録を確かめ、外れていれば登録し直す（冪等）。
   - 更新確認（M6-12）は今のまま通知だけ。Homebrew 版は `brew upgrade --cask dayline` を案内し、それ以外は Releases のページを開く。Tauri の updater も Sparkle も使わない。

6. **Homebrew cask**: `app "Dayline.app"`、`binary "#{appdir}/Dayline.app/Contents/Helpers/dl"`、`depends_on macos: ">= :sonoma"`、`uninstall quit: "dev.dayline.desktop"`。**`launchctl` は `uninstall` に書かず `zap` に書く**（`uninstall` は更新のたびに走るため）。`zap` はデータディレクトリ・ログ・`launchctl` のラベルを対象にする。`postflight` は使わない。hooks・MCP の登録の削除は Homebrew からはできないので、アプリのメニュー `Uninstall Dayline…` と `dl uninstall --all` で行い、cask の `caveats` と README に「brew uninstall の前に」と書く。

7. **開発時の配置は残す**: `bun run build` → `out/dl self-install` は開発者向けとして残す（`install.json` の方式 `dev`）。配布版の構成は `bun run build:app`（新設）で作る。

8. **今の配置からの移行**（オーナーの環境。`dl setup migrate`。アプリが初回起動で旧配置を見つけたときに呼ぶ）: 旧エージェント3つを `bootout` して plist を消す → `SMAppService` で登録 → hooks を新しいパスで入れ直す（Codex は `/hooks` での再承認を案内。D-030）→ MCP の登録のパスを案内 → `~/.local/bin/dl` を新しい `dl` へのリンクに置き換える → 旧 `DaylineCalendarHelper.app` と旧 `Dayline.app` をゴミ箱へ移す。データディレクトリはそのまま使う。

## 検討した案

### 常駐の登録

| 案 | 内容 | 利用者の見え方 | アプリの移動・更新 | アンインストール | 評価 |
|---|---|---|---|---|---|
| **A. SMAppService.agent（アプリ内の plist）（採用）** | Dayline.app が登録。plist は署名されたバンドルの中 | ログイン項目に「Dayline」1行 | `BundleProgram` が相対なので書き直し不要 | ゴミ箱に入れれば動かなくなる | Rust に objc2 の呼び出し（〜150行）が増える。M6-S8 で TCC の帰属と更新時の挙動を確かめる |
| B. dl が `~/Library/LaunchAgents` に plist を書く（今の方式） | `ProgramArguments` にアプリ内の絶対パス | ログイン項目に dayline の各プログラムが別々に出る（`AssociatedBundleIdentifiers` で寄せられる） | アプリを動かすと壊れる。書き直しが要る | plist が残る。cask の `launchctl` で消すと更新のたびに外れる | 実装は今のまま。D-056 (5) の「SMAppService で登録」に合わない |
| C. デーモンをアプリの子プロセスにする | アプリが起動したときだけ動く | 何も常駐しない | 問題なし | 問題なし | ⌘Q で取り込みと hooks の受け取りが止まる。ADR 0001 の「UI と取り込みを分ける」に反する |

### ヘルパの起動

| 案 | 内容 | 評価 |
|---|---|---|
| **A. SMAppService.agent（KeepAlive）（採用）** | デーモンと同じ仕組み。落ちたら launchd が起こし直す | S1 の構成（launchd 直下で起動）に最も近い |
| B. SMAppService.loginItem(identifier:) | `Contents/Library/LoginItems` のヘルパをログイン項目として起動 | 落ちたときの起こし直しが保証されない。ログイン時にしか起動しない |
| C. EventKit を Tauri アプリへ移す | ADR 0010 の案 B | アプリを ⌘Q で止めると予定の同期が止まる。Rust が増える |

### dl を PATH に置く方法

| 案 | 管理者権限 | Homebrew 以外 | 更新・移動 | 評価 |
|---|---|---|---|---|
| **A. cask の `binary` ＋（Homebrew 以外は）`~/.local/bin` へのリンクを設定から（採用）** | 不要 | 設定のボタン | brew が張り直す / アプリが張り直す | 標準的。PATH に無い場合だけ案内が要る |
| B. 初回起動で `/usr/local/bin/dl` にリンク | 要る（Apple Silicon では `/usr/local/bin` が無いこともある） | 自動 | 同左 | 初回にパスワードを求めるのは離脱の原因 |
| C. 置かない（アプリ内のパスを案内） | 不要 | 長いパスを打つ | — | `dl add` の体験が悪い |

hooks と MCP は PATH を使わず、固定の場所（決定 4）を絶対パスで書く。

## Consequences

- 利用者は Homebrew で入れて Dayline を開くだけで使い始められる。ターミナルの操作はいらない（`dl` は任意）。
- ログイン項目に Dayline が1行で出る。アプリを消せば常駐も止まる。
- Rust に `SMAppService` の呼び出しと `desktop_setup` の IPC（合わせて 200 行ほど）が増える。今の Rust は 1,730 行で、ADR 0010 の目安（1,000 行）を既に超えている。目安を 2,000 行に改めるか、`windows.rs` を減らすかを M6-14 で決める。
- 配布版ではデーモンのポートやデータディレクトリを環境変数で変えられない（plist が署名されたバンドルの中にあるため）。変えたい場合は開発時の配置を使う。
- 証明書が Apple Development から Developer ID に変わると、カレンダー・通知・オートメーションの許可は一度外れる見込みが高い（オーナーの環境だけの話。新しい利用者には関係ない）。bundle ID の接頭辞を変える場合も同じなので、名称の確定を移行より先に済ませる。
- `brew uninstall`（zap なし）だけでは hooks の設定に dayline のエントリが残り、`dl` のリンクが切れる。`dl hook` が見つからないときの Claude Code / Codex の挙動を M6-S8 で確かめ、README と `caveats` に手順を書く。
- 開発時（`dev`）と配布版（`app`）の2つの配置を `install.json` で区別し続ける必要がある。
