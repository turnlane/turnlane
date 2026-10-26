# Releasing Turnlane

Official builds are made on the maintainer's Mac with `bun run release`, not in GitHub Actions: the Developer ID certificate and the notarization credentials stay in the local keychain. CI (`.github/workflows/ci.yml`) only runs the tests.

The published build contains only this repository (no extensions). Versions follow [SemVer](https://semver.org/) starting from 0.x; changes are listed in [CHANGELOG.md](../CHANGELOG.md) ([Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)).

## What gets published

| Where | What |
|---|---|
| GitHub Releases, tag `v<version>` | `Turnlane-<version>.zip` (the notarized, stapled `Turnlane.app`), `Turnlane.zip` (the same file under a fixed name), `latest.json`, `Turnlane-<version>.zip.sha256` |
| The tap (`homebrew-tap`) | `Casks/turnlane.rb` pointing at the zip, with its sha256 |

The update check in the daemon reads `https://github.com/turnlane/turnlane/releases/latest/download/latest.json` once a day (GitHub redirects that URL to the file attached to the latest non-prerelease release). Builds that include an extension and development installs (`install.json` mode `dev`) never check.

`Turnlane.zip` is a copy of `Turnlane-<version>.zip` with no version in its name, so `https://github.com/turnlane/turnlane/releases/latest/download/Turnlane.zip` always points at the latest zip (`LATEST_ZIP_URL`). The Download button on the website links there. Like `latest.json`, it skips prereleases. The update check and the cask keep using the versioned URL.

### `latest.json`

```json
{
  "version": "0.7.0",
  "url": "https://github.com/turnlane/turnlane/releases/download/v0.7.0/Turnlane-0.7.0.zip",
  "sha256": "<64 lowercase hex characters, the sha256 of the zip>"
}
```

`url` must be an `https://github.com/` URL (or the same origin as the feed); otherwise the daemon ignores the file (`parseLatest` in `packages/core/src/update.ts`). `scripts/build-app.ts` writes it, and `bun run release` checks that it matches the zip.

## Requirements

- macOS on Apple Silicon, Bun 1.4.x, Xcode command line tools, Rust (see `.mise.toml`), `gh` signed in to the account that owns the repository.
- The Developer ID Application certificate in the login keychain and a notarytool keychain profile ([docs/dev/codesign.md](dev/codesign.md) 5.1–5.2).
- A local clone of the tap next to this repository, at `../homebrew-tap` (or pass `--tap-dir`).

| Variable | Value |
|---|---|
| `TURNLANE_CODESIGN_IDENTITY` | The certificate name, `Developer ID Application: <name> (<team id>)` |
| `TURNLANE_NOTARY_PROFILE` | The keychain profile created with `xcrun notarytool store-credentials` |

Do not write these values into the repository, a script, or a commit.

## Steps

1. On `main` with a clean tree, set `version` in `package.json` and move the `## [Unreleased]` entries into `## [<version>] - <YYYY-MM-DD>` in `CHANGELOG.md` (update the compare links at the bottom). Commit.
2. Check without building:

   ```sh
   bun run release --dry-run
   ```

   It checks that you are on `main`, the tree is clean, `package.json` and the top CHANGELOG heading agree, the tag `v<version>` does not exist yet, the identity is Developer ID, and the notary profile is set. Then it prints what it would do.
3. Build:

   ```sh
   bun run release
   ```

   This runs `bun run check`, then `build:app --zip --download-url <the Releases zip URL>` without extensions (signing from the inside out, notarization, staple; output in `out/release/`), and writes to `dist/release/v<version>/`:

   | File | Use |
   |---|---|
   | `Turnlane-<version>.zip` | Release asset |
   | `Turnlane.zip` | Release asset (a copy of the zip under a fixed name; the website's Download button) |
   | `latest.json` | Release asset (update check) |
   | `Turnlane-<version>.zip.sha256` | Release asset (`shasum -a 256 -c` format; one line for each of the two zip names, same hash) |
   | `turnlane.rb` | The cask for this version |
   | `notes.md` | The CHANGELOG section, used as the release notes |

   If the tap clone exists, it also writes `Casks/turnlane.rb` there and commits it (no push). If the tap has no `LICENSE` or `README.md` yet, the same commit adds them (`LICENSE` copied from this repository, and a short `README.md` with the install command). Without a tap clone, copy `turnlane.rb` into the tap by hand.
4. Publish. `bun run release` prints the commands and runs none of them:

   ```sh
   git tag -a v<version> -m "Turnlane <version>"
   git push origin main v<version>
   gh release create v<version> dist/release/v<version>/Turnlane-<version>.zip \
     dist/release/v<version>/Turnlane.zip \
     dist/release/v<version>/latest.json dist/release/v<version>/Turnlane-<version>.zip.sha256 \
     --verify-tag --title "Turnlane <version>" --notes-file dist/release/v<version>/notes.md
   git -C ../homebrew-tap push origin HEAD
   ```

   The tap is pushed last because the cask points at the release asset. `bun run release --publish` runs the same commands in order and asks before each push or release (`--yes` skips the questions). `--publish` refuses `--dry-run` and `--allow-adhoc`.
5. Check:
   - The release page lists the four assets, `curl -sIL https://github.com/turnlane/turnlane/releases/latest/download/Turnlane.zip` ends in `200`, and `curl -sL https://github.com/turnlane/turnlane/releases/latest/download/latest.json` returns the new version.
   - On a clean macOS account: `brew install --cask turnlane/tap/turnlane`, open Turnlane, and confirm the Gatekeeper dialog says Apple checked it ([docs/dev/codesign.md](dev/codesign.md) 5.5).
   - `brew audit --cask --online turnlane/tap/turnlane` and `brew livecheck --cask turnlane/tap/turnlane`.

### Development check (no Developer ID)

```sh
TURNLANE_CODESIGN_IDENTITY=- bun run release --allow-adhoc --skip-check --skip-notarize --tap-dir <a scratch git repo>
```

`--allow-adhoc` turns the branch, certificate, and notarization checks into warnings so the whole path (build, assets, cask, tap commit) can be tried with an ad-hoc signature. The result must not be handed to anyone (ad-hoc builds are rejected by Gatekeeper and their background items are killed after a move; [docs/dev/codesign.md](dev/codesign.md) 4). It cannot be published.

## The cask

The template is `scripts/release/turnlane.rb.tmpl`; `scripts/release/cask.ts` fills in the version, the sha256, and the names from `packages/core/src/release-config.ts`. Its shape follows ADR 0011 decision 6:

- `app "Turnlane.app"` and `binary` for `Contents/Helpers/turnlane` (the CLI on the PATH).
- `depends_on arch: :arm64` and `depends_on macos: :sonoma` (macOS 14 or later).
- `uninstall quit: "dev.turnlane.desktop"` only. `launchctl` belongs in `zap`, because `uninstall` also runs on every `brew upgrade`.
- `zap` removes the background items (`dev.turnlane.daemon`, `dev.turnlane.calendar-helper`), the data directory, the logs, and the app's caches and preferences. Without `--zap`, the data stays.
- No `postflight`. `caveats` says that hooks and MCP entries are not removed by `brew uninstall` and to run `turnlane uninstall --all` first.
- `livecheck` uses the latest GitHub release.

To check a changed template without publishing, render it into a temporary tap:

```sh
bun -e 'import {renderCaskFile} from "./scripts/release/cask.ts"; process.stdout.write(renderCaskFile({version: "0.7.0", sha256: "0".repeat(64)}))' > /tmp/turnlane.rb
brew tap-new --no-git turnlane-check/tmp
cp /tmp/turnlane.rb "$(brew --repository)/Library/Taps/turnlane-check/homebrew-tmp/Casks/turnlane.rb"
brew style --cask turnlane-check/tmp/turnlane
brew audit --cask --strict turnlane-check/tmp/turnlane
brew untap turnlane-check/tmp
```

## When something fails

| Where it stopped | What to do |
|---|---|
| A precondition | Fix what the error names and run again. Nothing was built or written. |
| `bun run check` | Fix the failure on a branch, merge to `main`, run again. |
| Notarization (`notarization Invalid (submission <id>)`) | The build prints the notarytool log. Later: `xcrun notarytool log <id> --keychain-profile "$TURNLANE_NOTARY_PROFILE"`. Fix the reported `path`/`message` (usually a signature or an entitlement), commit, run again. See [docs/dev/codesign.md](dev/codesign.md) 5.4. |
| `notarytool submit failed` | Check the profile: `xcrun notarytool history --keychain-profile "$TURNLANE_NOTARY_PROFILE"`. |
| After the tap commit, before publishing | Undo the local tap commit if you will rebuild: `git -C ../homebrew-tap reset --hard HEAD~1` (only if it was not pushed). A rebuild changes the zip's sha256, so the cask must be regenerated. |
| `git tag` done, push failed | Delete the local tag: `git tag -d v<version>`. |
| Tag pushed, `gh release create` failed | Run the printed `gh release create` again. To start over: `gh release delete v<version> --yes` (if a partial or draft release exists), `git push origin :refs/tags/v<version>`, `git tag -d v<version>`. |
| Release published with a bad asset | Do not replace the zip in place (brew caches the sha256). Delete the release and the tag as above, bump the patch version, and release again. If the cask was pushed, push a cask for the new version. |
| Draft release left behind | `gh release list` shows drafts; `gh release delete v<version> --yes`. |
| Tap push failed | Fix the remote and run `git -C ../homebrew-tap push origin HEAD` again. The release itself is fine. |

## Renaming the owner, the repository, or the tap

The names live in one place, `packages/core/src/release-config.ts` (`GITHUB_OWNER`, `GITHUB_REPO`, `TAP_REPO`, `CASK_TOKEN`). The update feed (`UPDATE_FEED_URL`), the zip URL, the fixed latest zip URL (`LATEST_ZIP_URL`), the cask's `url` and `homepage`, the `brew install` / `brew upgrade` strings, the Caskroom paths, and the release script all derive from it. Tests that pin the current URLs fail on purpose after a change; update their expected values.

Text that has to be edited by hand:

| File | What |
|---|---|
| `packages/core/src/release-config.ts` | The constants |
| `README.md` | Install (`brew install --cask …`, Releases link), clone URL in *From source*, Privacy (the update-check URL), adapter request link |
| `CHANGELOG.md` | Compare and release links at the bottom, and the `brew install` line in 0.7.0 (future entries only) |
| `docs/release.md` | This file (URLs, tap clone path, `brew` commands) |
| `CONTRIBUTING.md`, `SUPPORT.md`, `.github/ISSUE_TEMPLATE/config.yml` | Links to the repository, issues, Discussions, and security advisories |
| The website (`turnlane.dev`) | The Download button and the install section link to `LATEST_ZIP_URL`; its link check allows that URL. Changing `LATEST_ZIP_NAME` or the repository breaks those links |
| `scripts/demo/plan.ts` (and `scripts/demo/plan.test.ts`) | The repository address shown at the end of the demo video |
| Tests pinning URLs | `apps/daemon/test/update.test.ts`, `apps/cli/test/doctor-update.test.ts`, `test/release-cask.test.ts`, `test/release-plan.test.ts` |
| Local clone of the tap | `--tap-dir`, or rename the clone next to this repository to `../<TAP_REPO>` |

A build already installed keeps checking the old feed URL until it is updated. GitHub redirects a renamed or transferred repository, so the old URL keeps working as long as nothing new is created under the old name; publish the first release after a rename before deleting anything.
