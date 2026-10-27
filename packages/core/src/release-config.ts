/**
 * 公開の名前（GitHub の持ち主・リポジトリ・tap）を 1 か所に（M6-9・M6-10・M6-12、docs/release.md の
 * 「名前を変えるときに直す場所」）。Releases の zip・latest.json・cask の url と homepage・brew install の文字列は
 * ここから組み立てる。README など手で書く文は docs/release.md の一覧で直す
 */

/** GitHub の持ち主（個人か組織） */
export const GITHUB_OWNER = "turnlane";
/** 本体のリポジトリ名 */
export const GITHUB_REPO = "turnlane";
/** tap のリポジトリ名（`homebrew-` で始める。brew tap の短い名前は接頭辞を外したもの） */
export const TAP_REPO = "homebrew-tap";
/** cask の名前（token） */
export const CASK_TOKEN = "turnlane";

/** 本体のリポジトリ（cask の homepage） */
export const RELEASE_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
/** tap のリポジトリ */
export const TAP_REPO_URL = `https://github.com/${GITHUB_OWNER}/${TAP_REPO}`;
/** Releases の添付ファイルの置き場（この後に `v<版>/<ファイル>`） */
export const RELEASES_DOWNLOAD_URL = `${RELEASE_REPO_URL}/releases/download`;
/** Releases のページ */
export const RELEASES_PAGE_URL = `${RELEASE_REPO_URL}/releases`;
/** 最新リリースのページ（更新の知らせの「リリースを開く」。zip で入れた人向け。GitHub が最新リリースへ転送する） */
export const RELEASES_LATEST_PAGE_URL = `${RELEASES_PAGE_URL}/latest`;
/** 更新確認の確認先（最新リリースに添付した latest.json。GitHub が最新リリースの添付へ転送する） */
export const LATEST_JSON_URL = `${RELEASE_REPO_URL}/releases/latest/download/latest.json`;
/**
 * 版の付かない zip の名前。各リリースに `Turnlane-<版>.zip` と同じ中身で添付し、サイトの Download ボタンは
 * LATEST_ZIP_URL を指す。更新確認と cask は版つきの releaseZipUrl を使う
 */
export const LATEST_ZIP_NAME = "Turnlane.zip";
/** 最新リリース（プレリリースを除く）の版の付かない zip（GitHub が最新リリースの添付へ転送する） */
export const LATEST_ZIP_URL = `${RELEASE_REPO_URL}/releases/latest/download/${LATEST_ZIP_NAME}`;

/** tap の短い名前（`<持ち主>/<homebrew- を外した名前>`） */
export const TAP_NAME = `${GITHUB_OWNER}/${TAP_REPO.replace(/^homebrew-/, "")}`;
/** インストールのコマンド */
export const HOMEBREW_INSTALL_COMMAND = `brew install --cask ${TAP_NAME}/${CASK_TOKEN}`;
/** 更新のコマンド（tap を入れた後は token だけで通る） */
export const HOMEBREW_UPGRADE_COMMAND = `brew upgrade --cask ${CASK_TOKEN}`;

/** Releases に添付する zip のファイル名 */
export function releaseZipName(version: string): string {
  return `Turnlane-${version}.zip`;
}

/** Releases に添付する zip の URL（cask の url と latest.json の url） */
export function releaseZipUrl(version: string): string {
  return `${RELEASES_DOWNLOAD_URL}/v${version}/${releaseZipName(version)}`;
}
