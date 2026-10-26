# タスクから開く（D-059）の入れ替えと確認の手順

- 仕様: [ux-mvp.md](../spec/ux-mvp.md) 4.11、[m2-api.md](../spec/m2-api.md) 13章、[desktop-shell.md](../spec/desktop-shell.md) 3.3
- 調査: [s7-open-from-task.md](../spikes/s7-open-from-task.md)
- DB のマイグレーションは無い。デーモン（開く処理）・web・デスクトップアプリ（通知のクリック）が変わる

## 1. 入れ替え

[m0-install.md](m0-install.md) 4章の「新しいビルドに入れ替える」と同じ（デーモン・turnlane・Turnlane.app を同じ証明書で署名して入れ替える）。

```sh
cd ~/source/dayline
git pull && bun install
bun run check && bun run check:desktop
export TURNLANE_CODESIGN_IDENTITY="Apple Development: <名前> (<ID>)"
bun run build && bun run smoke
bun run build:desktop
out/turnlane self-install
```

通知のクリックを使わないなら、アプリはそのままでもよい（`out/turnlane self-install --no-desktop`）。そのときは、通知のクリックは今までどおりキューを開く。

## 2. 開くアプリの設定

既定はエディタ Zed、ターミナル Ghostty、差分ツール GitHub Desktop。設定画面の Open with か `turnlane config` で変える。

```sh
turnlane config set open.editor cursor        # zed / cursor / vscode / sublime
turnlane config set open.terminal warp        # ghostty / warp / iterm / terminal
turnlane config set open.diff fork            # github_desktop / fork / tower
turnlane config get open.editor               # 未設定なら null（= 既定）
```

設定したアプリが入っていなければ、同じ種類で次に見つかったものを使う（エディタ → Finder、ターミナル → Terminal、差分ツール → エディタ）。

## 3. 確認（1回ずつ。オーナーの作業を止めない時間に）

| # | 操作 | 期待 |
|---|---|---|
| 1 | 返答・許可のタスク（セッションが動いているもの）で ⏎ | 新しいウインドウは開かず、そのセッションのあるアプリが前面に出る。Ghostty なら、その cwd の端末にフォーカスする |
| 2 | 返答・エラーのタスク（セッションを閉じたもの）で ⏎ | Ghostty の新しいウインドウがリポジトリの cwd で開き、`claude --resume <id>` が入力済み（実行はされていない）。トースト `Resume command typed in Ghostty — press Return.` |
| 3 | 2 を初めて行ったとき | macOS の「“turnlaned”が“Ghostty”を制御しようとしています」に **OK**。答えるまでの間（5秒で打ち切る）はコピーに落ちる（トースト `Opened Ghostty — resume command copied.`）。OK の後はもう一度 ⏎ で入力済みになる。ダイアログが出ずにいつもコピーになる場合は、下の「許可を取り消す・確かめる」を見て結果を PO に返す |
| 4 | Codex app で始めたセッションのタスクで ⏎ | Codex app がそのスレッドを開く |
| 5 | PR のレビューで ⏎ / `o` → 2 | PR のページ / Files changed が既定のブラウザで開く |
| 6 | 変更の確認（`turnlane config set followup.kinds '{"check_changes":true}'` で有効にしたとき）で ⏎ | GitHub Desktop がそのリポジトリを開く（初めてのリポジトリなら追加の確認が出る） |
| 7 | 行にマウスを載せる | 右端にアイコン（PR は外部リンク、変更の確認は差分、返答などはターミナル）。クリックで ⏎ と同じ |
| 8 | `o` | 他の開き方のメニュー。数字キーで選ぶ。アプリの名前は実際に開くもの（`Open in Zed`） |
| 9 | AI 詳細パネル | 先頭（紫）が既定の開き先、その後に開けるものが並ぶ |
| 10 | アプリの通知（許可待ち・エラー）をクリック | main を開かずに、そのタスクの既定の開き先が開く。開けなかったら main でキューのその行を開く |

### 許可を取り消す・確かめる

システム設定 → プライバシーとセキュリティ → オートメーション → `turnlaned` の下の Ghostty。オフにすると、2 は「開いてコピー」になる。`TURNLANE_CODESIGN_IDENTITY` を設定して build した `turnlaned` は証明書で署名され、入れ替え（`turnlane self-install`）の後も許可が残る見込み。
設定せずに build した（ad-hoc 署名の）ときは、入れ替えのたびに聞き直されることがある。前提と確認手順は [codesign.md](codesign.md)。
