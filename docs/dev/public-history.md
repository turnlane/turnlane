# 公開リポジトリの新しい履歴の作り方（M6-7）

開発中のリポジトリの履歴は公開しない（D-095・D-085。過去のコミットに、実データを含む画像や環境に依存した記述が残っているため）。
監査を通した作業ツリーの**1つのコミット**から、親を持たない（orphan）コミットを1つ作り、それを公開リポジトリの最初の履歴にする。

この文書は手順だけを書く。**公開リポジトリへの push は、オーナーが中身を目視して決めてから、オーナーが行う。**

## 0. 前提

- 公開リポジトリ（空）は確保済み。push 先の URL はオーナーが確かめる
- 公開する元は `main` の1つのコミット（`SRC`）。作業ツリーに未コミットの変更が無いこと
- 監査の一覧（拒否リスト）は本体に置かない:
  - 拡張の中身の一覧: 拡張のリポジトリの `audit/public-deny.txt`
  - オーナー個人の環境の一覧（名前・メール・設定フォルダ・手元のリポジトリ名・実データの予定名）: 本体の外の非公開の場所
- gitleaks は Homebrew で入れない。公式のリリースのバイナリを一時の場所に置いて使う（下）

## 1. 元のコミットを監査する

```sh
cd <開発中のリポジトリ>
test -z "$(git status --porcelain)" || { echo "未コミットの変更がある"; exit 1; }
SRC=$(git rev-parse main)

# 1-1. 拡張の中身・価格・個人の環境の文字列（テキストは中身、画像はパスだけ）
bun scripts/audit-public.ts --deny <拡張のリポジトリ>/audit/public-deny.txt
bun scripts/audit-public.ts --deny <個人の一覧>

# 1-2. 旧名の残り（ADR 0016）
bun scripts/check-names.ts

# 1-3. 秘密（gitleaks。追跡しているファイルだけを一時の場所に写して走査する）
TMP=$(mktemp -d)
V=8.30.1   # https://github.com/gitleaks/gitleaks/releases の最新に合わせる
curl -sL -o "${TMP}/gl.tgz" "https://github.com/gitleaks/gitleaks/releases/download/v${V}/gitleaks_${V}_darwin_arm64.tar.gz"
tar -xzf "${TMP}/gl.tgz" -C "${TMP}" gitleaks
git ls-files -z | rsync -a --from0 --files-from=- . "${TMP}/tree/"
"${TMP}/gitleaks" dir "${TMP}/tree" -c .gitleaks.toml --redact --no-banner
```

- どれも 0 件になるまで直してからコミットし、`SRC` を取り直す。`.gitleaks.toml` の除外は、確かめた誤検出だけに限る
- `spikes/` の結果ファイル、フィクスチャ（`packages/collectors/test/fixtures/`）、スナップショット（`__snapshots__/`）は目でも見る
- 画像（`docs/design/`・`docs/dev/screens/`・`docs/assets/`）は、実データ・実名・拡張の画面が写っていないかを目で全部見る。
  文字列の検査は画像の中を見ない
- 見つかったものを報告・コミットに書くときは、ファイルと行と種類だけにする（中身を書き写さない）

## 2. 公開前に済ませておくこと

- 旧名の読み替えのコード（ADR 0016 の Consequences）: 決着済み。名前の移行のコードは外し、カレンダーの旧名の目印の読み取りだけを残した
- 手元のリポジトリのディレクトリの名前: 済み（D-211）
- README・LICENSE・SECURITY などの公開の文書の値: 決着済み。リポジトリの URL は `https://github.com/turnlane/turnlane`、LICENSE の著作権者は 2026-10-26 に Rootstack Inc. に変えた（ADR 0008 追記の末尾）

## 3. orphan のコミットを作る（ローカルだけ）

開発中のリポジトリでは作らない。別の場所に複製して、その中で作る。

```sh
WORK=$(mktemp -d)/turnlane-public
git clone --no-local --no-hardlinks <開発中のリポジトリ> "${WORK}"
cd "${WORK}"
git checkout --orphan public "${SRC}"     # 中身は SRC と同じ、親は無い
git remote remove origin                  # 開発中のリポジトリを指す remote を残さない

# コミットの作者は公開する名前とメール（GitHub の noreply。オーナー決定 2026-10-15）。
# `git config user.name` / `user.email` に設定済みの公開用の値を使う。値はこの文書に書かない
git commit -m "Initial public release" -m "Created from ${SRC}"   # 元のどのコミットから作ったか（phase0-plan M6-7）

# 複製についてきたブランチ（main など）を消す。push するのは public だけだが、手元にも残さない
git for-each-ref --format='%(refname:short)' refs/heads | grep -vx public | xargs -n1 git branch -D
```

確かめる:

```sh
git rev-list --count public                  # 1
git diff --stat "${SRC}" public              # 何も出ない（中身が SRC と同じ）
git log --format='%an <%ae>%n%cn <%ce>%n%B' public   # 作者・本文に個人の情報が無い
git branch -a                                # public だけ（ほかのブランチを持ち込まない）
git tag                                      # 何も無い
```

## 4. 新しい履歴を監査し直す

```sh
bun install
bun run check && bun run build && bun run smoke
bun scripts/audit-public.ts --deny <拡張のリポジトリ>/audit/public-deny.txt --history
bun scripts/audit-public.ts --deny <個人の一覧> --history
"${TMP}/gitleaks" git . -c .gitleaks.toml --redact --no-banner
```

`--history` は全ブランチのパッチとコミットメッセージを見る。ここでは1コミットだけなので、ツリーとメッセージの確認になる。

## 5. オーナーの目視と push（オーナーが行う）

1. `git show --stat public` でファイルの一覧を見る（`out/`・`node_modules/`・個人の設定・一時のファイルが無いこと）
2. 画像のフォルダを Finder か `qlmanage -p` で一通り見る
3. 問題がなければ、オーナーが公開リポジトリを remote に足して push する:

```sh
git remote add public <公開リポジトリの URL>
git push public public:main
```

push の後の作業（このリポジトリでの開発を公開リポジトリに移すか、ディレクトリの名前、拡張のリポジトリの `core` の参照先）は
公開の後に決める。
