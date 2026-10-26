# スパイク S5: hooks の共存

- 日付: 2026-10-03
- ブランチ: `spike/s5-hooks-coexistence`（変更提案 1〜13 を phase0-plan・ai-session-ingestion・CLAUDE.md に反映したうえで M1 のブランチに取り込んだ。コードは `spikes/` 配下のまま）
- コード: `spikes/s5-hooks-coexistence/`（本番コードではない。`src/` がインストーラの原型、`test/` がその単体テスト、`experiments/` が実機での確認）
- 生データ: `spikes/s5-hooks-coexistence/results/`（本文・個人のパスを含まない）

## 結論

**識別は command 文字列で行い、設定ファイルに未知キーを足さない。dayline のエントリは「イベントごとに自分専用のマッチャーグループを1つ、配列の末尾に足す」。** この方式で、Claude Code の settings.json と Codex の hooks.json の両方に、他ツールのエントリを壊さず冪等にインストール・アンインストールできることを確かめた。

| # | 確かめたこと | 結果 |
|---|---|---|
| 1 | Claude settings.json の未知キー | 2.1.287 では、トップレベル・マッチャーグループ・ハンドラのどこに未知キーを足しても hooks は動き、警告も出ない。ただし公式の記述は「スキーマが拒否する値は Settings Error（ファイル全体を読み飛ばす）」で、未知キーを許すとは書いていない。**頼らない** |
| 2 | Codex hooks.json の未知キー | **トップレベルの未知キーで hooks.json 全体が読み捨てられる**（`deny_unknown_fields`。他ツールの hook も全部止まる）。グループ・ハンドラの未知キーは黙って無視される |
| 3 | command 文字列での識別 | `'<dl のパス>' hook --tool <ToolId> --managed-by dayline` で識別できる。Claude・Codex とも command はそのままシェルに渡り、`--managed-by dayline` は `dl hook` が読み飛ばせばよい |
| 4 | 冪等なインストール / アンインストール | 実際の設定ファイル4つ（Claude の設定ディレクトリ3つの settings.json、Codex の hooks.json）の**コピー**で install → install → uninstall がバイト単位で一致。2回目の install は書き込みもバックアップもしない |
| 5 | 他ツールの hook との並存 | Claude: 他ツールの hook と dayline の hook が同じイベントで両方実行される（一時 `CLAUDE_CONFIG_DIR` で確認）。Codex: 末尾に足せば他ツールの承認は外れない。**先頭や途中に足すと他ツールの承認が外れる**（下記） |
| 6 | `disableAllHooks` の検出 | Claude: ユーザー設定と管理設定（`managed-settings.json` の `disableAllHooks` / `allowManagedHooksOnly`）は読み取りで検出できる。プロジェクト単位の設定は全部は見られないので、無音検知で拾う。Codex: `[features] hooks = false`（旧名 `codex_hooks`）を config.toml の行単位の読み取りで検出できる。`codex features list` でも分かる |
| 7 | Codex の信頼承認 | 承認は `config.toml` の `[hooks.state."<hooks.json の実パス>:<event>:<グループ番号>:<ハンドラ番号>"] trusted_hash = "sha256:..."`。**鍵が位置**、hash は内容（イベント名・matcher・ハンドラの設定）。未承認の hook は `codex exec` では黙って実行されない。承認はユーザーが TUI の `/hooks` で行う。非対話で承認する公式手段は無い |
| 8 | Codex の `async` | **Codex 0.147 は `async: true` のハンドラを「未対応」として読み飛ばす**（警告のみ）。Codex には `async` を付けない |
| 9 | 複数の Claude 設定ディレクトリ | `~/.claude` と `~/.claude-*`（`projects/` か `settings.json` があるもの）と `CLAUDE_CONFIG_DIR` を検出し、それぞれの settings.json に同じ手順で入れられる。各ディレクトリは独立していて、同じハンドラを入れても干渉しない |

## 環境

| 項目 | 値 |
|---|---|
| OS | macOS 26.6.2（arm64） |
| Bun | 1.4.2 |
| Claude Code | 2.1.287 |
| Codex CLI | 0.147.0（hooks の機能フラグは既定で有効。`stable`） |

実ユーザーの設定ファイル（各 Claude 設定ディレクトリの settings.json、`~/.codex/hooks.json`、`~/.codex/config.toml`）は読み取りだけ。往復の確認は一時ディレクトリへのコピーで行い、終わったら消した。Claude / Codex を実際に起動する確認は、一時 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` とダミーの API キーで行い、認証ファイルは開いていない（モデルの呼び出しは失敗させている）。

## 確認の詳細

### 1. Claude Code（`experiments/claude-unknown-keys.ts`、`results/claude-unknown-keys.json`）

一時 `CLAUDE_CONFIG_DIR` に、SessionStart / UserPromptSubmit / Stop / StopFailure / SessionEnd の hook（受け取った `hook_event_name` だけを記録）を置き、`claude -p` を実行した。

| 変種 | 結果 |
|---|---|
| 基準 | SessionStart・UserPromptSubmit・SessionEnd が発火（API はダミーキーで失敗させているので Stop は来ない） |
| トップレベルに `"x-dayline": {...}` | 基準と同じ。警告なし |
| ハンドラに `"managedBy": "dayline"` | 追加したハンドラも発火 |
| グループに `"managedBy": "dayline"` | 同上 |
| `disableAllHooks: true` | 1つも発火しない |
| command の末尾に識別の語、`async: true` | 発火 |
| 未知のイベント名 | 他は動く（公式の記述どおり Settings Warning の扱い） |
| `statusMessage` | 発火 |

どの変種でも Claude Code は settings.json を書き換えなかった。

公式ドキュメント（Hooks reference、Settings）で確認した点:

- ハンドラに `id` や `name` のような識別用のフィールドは無い。同じハンドラが複数の設定ファイルにあると、内容の比較で1回だけ実行される。
- `disableAllHooks` はユーザー・プロジェクト・ローカルの hooks をすべて止める。管理設定の hooks は止めない。プロジェクトで `false` にするとユーザー設定の `true` より優先される。
- 設定ファイルの変更はファイル監視で即時に反映され、承認の手順は無い（`/hooks` は閲覧用）。
- 設定ファイルは厳密な JSON（コメント・末尾カンマは Settings Error）。

結論: 未知キーは現バージョンでは許容されるが、スキーマの厳格化や Claude Code 自身の書き戻し（`/permissions` などで settings.json を書くとき）で失われる・拒否される可能性があり、頼る理由が無い。識別は command 文字列で行う。

### 2. Codex（`experiments/codex-trust.ts`、`results/codex-trust.json`）

一時 `CODEX_HOME` で `codex app-server` を起動し、`hooks/list`（stdio の JSON-RPC）で各 hook の鍵・hash・承認状態・読み込み警告を取った。「ユーザーが承認した」状態は、返ってきた hash を一時ディレクトリの config.toml に書いて再現した。

| 手順 | 結果 |
|---|---|
| 他ツールの hook だけ | `untrusted`、鍵は `<home>/hooks.json:stop:0:0` |
| 他ツールを承認 | `trusted` |
| dayline を `async: true` で末尾に | 警告「skipping async hook ... async hooks are not supported yet」で dayline は一覧から消える |
| dayline（async なし）を末尾に | 他ツールは `trusted` のまま、dayline は `untrusted`（鍵 `stop:1:0`） |
| dayline を先頭に | **他ツールが `untrusted` に、dayline は `modified`**（位置 0 の承認が他ツールの hash だったため） |
| 他ツール → dayline → 第三のツール（全部承認）から dayline を削除 | **第三のツールが `modified`**（位置 2 → 1 にずれた） |
| トップレベルに `"x-dayline"` | 「unknown field `x-dayline`, expected `description` or `hooks`」で **hooks.json 全体が読み込まれず、hook が0件** |
| グループ・ハンドラに未知キー | 黙って無視。hash は変わらず承認も外れない |
| `[features] hooks = false` | hook が0件。`codex features list` の `hooks` 行が `false` |
| JSON が壊れている | 警告を出して hook が0件 |

`codex exec` で、未承認の hook は実行されず（警告も出ない）、`--dangerously-bypass-hook-trust` を付けると実行されることも確かめた。

Codex のソース（`codex-rs/hooks/src/engine/discovery.rs`、`codex-rs/config/src/hook_config.rs`）で、承認の鍵が `hook_key(path, event, group_index, handler_index)`、hash が「イベント名・matcher・正規化したハンドラ」を TOML にしたものの版（`sha256:`）であること、`HooksFile` が `deny_unknown_fields` であることを確認した。config.toml の `[[hooks.<Event>]]` にも hooks を書けるが、同じ層で hooks.json と両方にあると警告が出る。

### 3. 往復と並存（`experiments/roundtrip-and-e2e.ts`、`results/roundtrip-and-e2e.json`、`test/install.test.ts`）

- 実ファイルのコピー4つ（他ツールの hook を最大14グループ含む）で、install → install → uninstall がバイト一致。4つとも `JSON.stringify(v, null, 2)` + 改行の正規形だった。
- 単体テスト20件（`bun test`、全件合格）: 正規形の往復、インデント4・末尾改行なし、`hooks` キーが無いファイル、Codex の hooks.json、ファイルが無い場合、dl のパス変更時の同じ位置での置き換え、重複の解消、他ツールのグループに混ぜ込まれた dayline のハンドラの除去、対象外になったイベントからの除去、似た文字列の誤認なし、status の4状態、壊れた JSON で止まる、読み込み後の他プロセスの書き換えで中止、シンボリックリンク（dotfiles 管理）とパーミッションの保持、dry-run、複数の設定ディレクトリ、`disableAllHooks` と管理設定、Codex の機能フラグと承認エントリの検出。
- 一時 `CLAUDE_CONFIG_DIR` に「他ツールの hook」と「dayline の hook（偽の dl。引数とイベント名だけを記録）」をインストーラで入れて `claude -p` を実行し、両方が発火した。偽の dl には `hook --tool claude_code --managed-by dayline` が渡った。

## 決めた方式

### 識別

- `type: "command"` かつ command が語として `--managed-by dayline` を含むハンドラを dayline のものとみなす（正規表現 `(^|\s)--managed-by\s+dayline(\s|$)`）。似た文字列（`daylinex` など）は他ツール扱い。
- command は `'<dl の絶対パス>' hook --tool <ToolId> --managed-by dayline`。パスは単一引用符で囲む。`--tool` はアダプタの ToolId（ADR 0009）。
- 設定ファイルに未知キーを足さない。

### 置き方

- イベントごとに、dayline のハンドラを1つだけ入れた自分専用のマッチャーグループ（`matcher` なし）を配列の**末尾**に足す。他ツールのグループの中には入れない。
- 既にある場合は**同じ位置で置き換える**（dl のパスやオプションが変わったとき）。重複していたら最初の1つに寄せる。
- 他ツールのグループに混ぜ込まれた dayline のハンドラは外す（グループは残す）。
- 対象外になったイベント（版上げで外したもの）の dayline のエントリは install のときに外す。

| | Claude Code | Codex |
|---|---|---|
| ファイル | 各設定ディレクトリの `settings.json` | `$CODEX_HOME/hooks.json`（既定 `~/.codex`） |
| イベント | SessionStart、UserPromptSubmit、PermissionRequest、Notification、Stop、StopFailure、SessionEnd | SessionStart、UserPromptSubmit、PermissionRequest、Stop、SessionEnd |
| ハンドラ | `{"type":"command","command":...,"timeout":5,"async":true}` | `{"type":"command","command":...,"timeout":2}`（async は付けない。SessionEnd の timeout は Codex が最大3秒に丸める） |
| 有効化後 | 即時に効く（ファイル監視） | ユーザーが `/hooks` で承認するまで動かない |

PreToolUse / PostToolUse は高頻度なので入れない（ai-session-ingestion 2.4）。許可が出たあとの needs_input の解除は、トランスクリプトの監視（1秒前後）で拾う。

### 書き込み

- 実パス（シンボリックリンクの先）を読み書きする。リンクは壊さない。
- 書式（インデント、末尾改行）を元ファイルから検出し、同じ書式で書く。正規形のファイルならバイト一致で戻る。正規形でないファイルは意味を保ったまま書式が正規化される（`--dry-run` でその旨を出す）。
- JSON として読めなければ何もしない（コメント付き等。Claude の設定ファイルはそもそも厳密な JSON）。
- 書く直前に再読込し、読んだ内容から変わっていたら中止する（Claude Code 等が同時に書いた場合）。
- 同じディレクトリの一時ファイルに書いて rename する。パーミッションを引き継ぐ。
- 変更があるときだけ `<実パス>.bak-dayline-<ts>` を作ってから書く。変更が無ければ書かない。
- 新規作成（ファイルが無い）はバックアップなし。uninstall でファイルは消さない（中身が `{}` になる）。

### 状態の点検（`dl hooks status`）

- インストール状態: `none` / `installed` / `partial`（一部のイベントだけ）/ `outdated`（パスやオプションが違う）。
- Claude の無効化: ユーザー設定の `disableAllHooks`、管理設定（`/Library/Application Support/ClaudeCode/managed-settings.json`）の `disableAllHooks` / `allowManagedHooksOnly`。
- Codex の無効化: config.toml の `[features] hooks = false` / `codex_hooks = false`（行単位の読み取り。TOML パーサは持たない）。
- Codex の承認: dayline のハンドラの位置に対応する `[hooks.state."<鍵>"]` があるか（hash の一致までは見ない）。最終的な判定は、spool に hook が届いたか（`ai_source.hooks_state` の `pending_trust` → `receiving`）で行う。
- 無音検知: インストール済みで、トランスクリプトには活動があるのに hook が24時間届かない設定ディレクトリは `silent` にし、原因候補（プロジェクト単位の `disableAllHooks`、別の設定ディレクトリ、Codex の未承認・`modified`）を出す（ux-mvp 4.9）。

## 判明した制約と注意点

1. **Codex の承認は位置で決まる。** dayline が末尾に足す限り他ツールの承認は外れないが、dayline の後ろに他ツールが足したあとで dayline をアンインストールすると、そのツールの承認が外れる（`modified`）。config.toml の `[hooks.state]` を書き換えて鍵をずらせば防げるが、他ツールの承認状態を dayline が書き換えることになるので**やらない**。アンインストール時に「dayline より後ろにあるグループ」を数え、1つ以上あれば dry-run とアンインストールの出力で「Codex の `/hooks` で次の hook を承認し直してください」と名前を挙げて案内する。
2. **dl のパスが変わると Codex の再承認が要る**（hash が command を含むため）。Homebrew 版（M6-9）で `dl` の場所が変わる場合も同じ。インストール・更新の最後に「Codex は `/hooks` で承認してください」と出す。
3. Codex には非対話で承認する公式手段が無い。`--dangerously-bypass-hook-trust` は1回の起動だけで、常用の経路にはできない。
4. Claude の `disableAllHooks` はプロジェクト単位でも設定でき、dayline からは全部は見えない。無音検知で拾う。
5. Codex の hooks.json を新規に作る場合も、トップレベルは `hooks`（と任意の `description`）だけにする。

## phase0-plan への変更提案

**反映済み**（M1 の着手時。phase0-plan 3.6・3.6.1・4.1・4.3（M1-10）・5.1・7（U4・U5）、ai-session-ingestion 2.1・2.3、CLAUDE.md 原則 6）。

### M1-10 への変更

1. **識別と置き方を本レポートの「決めた方式」に固定する。** `dl hook` は `--managed-by dayline` を受けて無視する（ADR 0009 の `--tool <ToolId>` と合わせて、未知の引数は無視して exit 0）。
2. **Codex のハンドラに `async` を付けない。** timeout は全イベント2秒。Claude は `async: true`、timeout 5秒。
3. **イベントの一覧を表のとおりにする**（Claude 7イベント、Codex 5イベント。Pre/PostToolUse は入れない）。
4. **書き込みの規則を足す**: 実パスへの書き込み（シンボリックリンク対応）、書式の保持、書く直前の再読込による競合検出、一時ファイル + rename、変更があるときだけバックアップ、壊れた JSON では何もしない。
5. **`dl hooks status` の点検項目を足す**: 4状態、Claude の `disableAllHooks`（ユーザー・管理設定）と `allowManagedHooksOnly`、Codex の `[features] hooks = false` と位置に対応する承認エントリ、無音検知。Codex のアンインストールで後ろのグループがずれる場合の再承認の案内。
6. **`dl hook` が spool に `config_root` を残す。** hook のプロセスは親の環境変数を引き継ぐので、`CLAUDE_CONFIG_DIR` / `CODEX_HOME` が設定されていればその値を `config_root` に入れる（未設定なら既定のディレクトリ）。`hook_event.config_root` を埋める手段がこれまで決まっていなかった。値はパスで本文ではない。`hook-allowlist.ts` に `config_root` を足す（環境変数から取るのでキーの抽出ではないが、spool の形式として明記する）。
7. **テスト**: 本スパイクの `test/install.test.ts` の20件を移植する。5.1 の「hooks インストーラ」の行に、シンボリックリンク、競合検出、Codex の位置（末尾に足す・同じ位置で置き換える）を足す。
8. **見積**: 1日のままでよい（本スパイクの `src/` と `test/` をほぼそのまま使える）。

### その他の文書

9. ai-session-ingestion 2.3: 「hooks: `[features] hooks = true` が必要」を「0.147 では既定で有効（`stable`）。ユーザーが `hooks = false` にしている場合がある」に直す。承認は位置の鍵と内容の hash で行うこと、未承認の hook は黙って実行されないこと、`async` が未対応であることを足す。
10. ai-session-ingestion 2.1: 「ハンドラに識別用のフィールドは無い。同じハンドラは内容の比較で1回だけ実行される」「設定の変更はファイル監視で即時に反映」を足す。
11. phase0-plan 7 の U4（未知キー）と U5（hooks の入力フィールドと Codex の信頼承認）を「決定（S5）」にする。U4: 未知キーは使わず command 文字列で識別。U5: 入力フィールドは公式ドキュメントで確認済み（`prompt_id` は v2.1.196 以降、`notification_type`、`error_type`、Stop の `last_assistant_message` は hook 側で捨てる）。Codex の承認は上記。
12. phase0-plan 4.1 の S5 の行に「完了」と本レポートへのリンクを足す。
13. CLAUDE.md の原則 6（他ツールの hooks 設定ファイル）に「未知キーを足さない、末尾に足す」を一言足す。

## オーナー判断が要る点

**決定**（PO 決定 D-030）: 推奨どおり、他ツールの承認状態は書き換えず、再承認を案内する（phase0-plan 3.6.1）。

- Codex で dayline をアンインストールしたとき、後ろにある他ツールの hook の承認が外れうる。本レポートでは「承認状態は書き換えず、再承認を案内する」を推奨した。dayline が config.toml の `[hooks.state]` の鍵をずらして承認を保つ案（便利だが他ツールの承認を dayline が書き換える）は採らない前提でよいか。
