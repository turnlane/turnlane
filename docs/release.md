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

The app's automatic update downloads `url` only when it is on `https://github.com/` (redirects are followed only to `*.githubusercontent.com`; a loopback feed set with `TURNLANE_UPDATE_FEED_URL` may also serve the zip from its own origin, for testing). It refuses to install unless the zip matches `sha256`, contains only `Turnlane.app`, passes `codesign --verify --deep --strict`, has the same TeamIdentifier as the running app, has `CFBundleShortVersionString` equal to `version`, and passes `spctl --assess --type execute`. So every release zip must be the notarized, stapled build signed with the same Developer ID team as the previous release; a release signed by another team cannot reach existing users through the automatic update (they get the manual instructions instead).

The automatic update can only be tested end to end with a real release: the first full run is updating from 0.7.1 to 0.7.2. Keep 0.7.2 small so that the run is the point of it. Before that, a candidate build can be checked on a spare Mac with a loopback feed (`TURNLANE_UPDATE_FEED_URL=http://127.0.0.1:<port>/latest.json` in the daemon's environment) pointing at a notarized zip of a higher version.

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
   **Continue from an app that is already notarized and stapled** (`--from-app`). When stapling kept failing and you stapled the kept work folder's app by hand, do not rebuild:

   ```sh
   bun run release --dry-run --from-app "out/release/.stage-<id>/Turnlane.app"
   bun run release --from-app "out/release/.stage-<id>/Turnlane.app"            # or add --publish
   ```

   It runs the same preconditions, skips `bun run check` and the build, and checks the app before using it: it is a directory named `Turnlane.app`, `codesign --verify --deep --strict` passes, it is signed by `TURNLANE_CODESIGN_IDENTITY` (same Team ID), its version is the release version, it has no extensions (Info.plist `TurnlaneExtensions`; apps built before this key only get a warning), `xcrun stapler validate` passes, and `spctl` accepts it. Then it copies the app to `out/release/Turnlane.app`, makes the zip and `latest.json` the same way the build does, and continues with the files, the tap commit, and publishing as below. `--from-app` refuses `--skip-notarize` and `--allow-adhoc`.
4. Publish. `bun run release` prints the commands and runs none of them:

   ```sh
   git tag -a v<version> -m "Turnlane <version>" <build commit>
   git push origin main v<version>
   gh release create v<version> dist/release/v<version>/Turnlane-<version>.zip \
     dist/release/v<version>/Turnlane.zip \
     dist/release/v<version>/latest.json dist/release/v<version>/Turnlane-<version>.zip.sha256 \
     --verify-tag --title "Turnlane <version>" --notes-file dist/release/v<version>/notes.md
   git -C ../homebrew-tap push origin HEAD
   ```

   The tap is pushed last because the cask points at the release asset. `bun run release --publish` runs the same commands in order and asks before each push or release (answer `y` or `yes`; `--yes` skips the questions). The tag is created only after the push question is answered, so answering anything else leaves no local tag behind. `--publish` refuses `--dry-run` and `--allow-adhoc`.

   **`--publish` does not rebuild.** When `dist/release/v<version>/` from step 3 is there, `bun run release --publish` verifies it and publishes it as it is: all six files present, `Turnlane-<version>.zip` and `Turnlane.zip` identical, their sha256 equal to `latest.json`, the `.sha256` file and the cask, `latest.json`'s version and URL right, `notes.md` equal to the current CHANGELOG section, and the app inside the zip checked like `--from-app` (signature, identity and Team ID, version, stapled, `spctl`, extensions). It prints `using dist/release/v<version> built at <time>`, commits the cask in the tap only if it differs (and pushes a tap commit left unpushed by step 3), and runs the publish commands. If the set fails a check, it says why and only then builds. `--rebuild` forces a new build. Plain `bun run release` refuses to overwrite an existing set unless `--rebuild` is given (a rebuild notarizes again and changes the zip's sha256). `bun run release --dry-run` with an existing set runs the same checks and prints what `--publish` would do.

   The tag goes on the commit the app was built from (`TurnlaneBuild` in the app's Info.plist, `<version>+<sha>`), not on `HEAD`, and the script prints which commit it tags. If that commit is not an ancestor of `main` (the build is not from this history), it refuses.
5. Check:
   - The release page lists the four assets, `curl -sIL https://github.com/turnlane/turnlane/releases/latest/download/Turnlane.zip` ends in `200`, and `curl -sL https://github.com/turnlane/turnlane/releases/latest/download/latest.json` returns the new version.
   - On a clean macOS account: `brew install --cask turnlane/tap/turnlane`, open Turnlane, and confirm the Gatekeeper dialog says Apple checked it ([docs/dev/codesign.md](dev/codesign.md) 5.5).
   - `brew audit --cask --online turnlane/tap/turnlane` and `brew livecheck --cask turnlane/tap/turnlane`.
     Homebrew 6+ refuses to load a cask from an untrusted tap for these commands, so on the maintainer's Mac run `brew trust turnlane/tap` once (`brew untrust turnlane/tap` undoes it). Users do not need this: a fully qualified `brew install --cask turnlane/tap/turnlane` trusts that cask by itself ([Tap Trust](https://docs.brew.sh/Tap-Trust)).

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
- `auto_updates true`: the app updates itself from the same GitHub Releases (ADR 0008, addendum 4), so a plain `brew upgrade` skips it unless `--greedy` is given; `brew upgrade --cask turnlane` still works. When the app replaces `/Applications/Turnlane.app` itself, the `binary` link (it points into the bundle), `uninstall quit`, and `zap` stay valid.

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
| `stapler staple failed` (Error 73 / 65) | Notarization was Accepted, but the ticket is not on Apple's servers yet. The script waits and retries for up to 30 minutes (the 0.7.1 and 0.7.2 releases needed longer). If it still fails, the error prints the submission ID and the work folder (`out/release/.stage-*`, kept). Do not run the release again (it rebuilds, notarizes again and usually hits the same wait). Instead, wait a few minutes, staple by hand (`xcrun stapler staple "<stage>/Turnlane.app"`, then `xcrun stapler validate "<stage>/Turnlane.app"`), and continue from that app: `bun run release --from-app "<stage>/Turnlane.app" --tap-dir <tap>` (add `--dry-run` first to check it, or `--publish` to publish). Then `rm -rf "<stage>"`. Other stapler errors stop at once. |
| `notarytool submit failed` | Check the profile: `xcrun notarytool history --keychain-profile "$TURNLANE_NOTARY_PROFILE"`. |
| After the tap commit, before publishing | Run `bun run release --publish`: it reuses `dist/release/v<version>/` after checking it (no rebuild) and pushes the tap commit. Only if you really need a new build: undo the local tap commit (`git -C ../homebrew-tap reset --hard HEAD~1`, only if it was not pushed) and run with `--rebuild`. A rebuild notarizes again and changes the zip's sha256, so the cask is regenerated. |
| `--publish` says the set `cannot be reused` | It lists what did not match (a missing file, different hashes, an old `notes.md`, the app's signature or staple) and then builds a new set. To avoid the rebuild, fix the cause (for example restore the files from step 3) and run `--publish` again. |
| `--publish` says the build commit `is not an ancestor of main` / `is not in this repository` | The set was built from another history (a branch, or a commit that was rewritten). Check out the `main` it was built from, or build a new set with `--rebuild`. |
| `git tag` done, push failed | Run `bun run release --publish` again: a tag that exists only locally (not on origin) and points at the build commit is reused (`tag v<version> already exists locally on <sha> (not pushed), continuing`) and the `git tag` step is skipped. If the local tag points at another commit, the script refuses and prints `git tag -d v<version>`; run it and try again. If the tag is already on origin, the release was published or half-published: see the rows below. |
| Tag pushed, `gh release create` failed | Run the printed `gh release create` again. To start over: `gh release delete v<version> --yes` (if a partial or draft release exists), `git push origin :refs/tags/v<version>`, `git tag -d v<version>`. |
| Release published with a bad asset | Do not replace the zip in place (brew caches the sha256). Delete the release and the tag as above, bump the patch version, and release again. If the cask was pushed, push a cask for the new version. |
| Draft release left behind | `gh release list` shows drafts; `gh release delete v<version> --yes`. |
| Tap push failed | Fix the remote and run `git -C ../homebrew-tap push origin HEAD` again. The release itself is fine. |

## Reading a desktop app crash report

The shipped `Turnlane.app/Contents/MacOS/turnlane` is stripped, so a crash report (`.ips`) shows only offsets. The release build keeps the symbols separately (the Cargo release profile writes `turnlane.dSYM` with line tables only; the shipped binary is the same size as before). `build:app` copies it to `out/release/symbols/turnlane.dSYM`, and `bun run release` copies that to `dist/release/v<version>/symbols/`. It is not a release asset and is not inside the app. Keep the folder for every published version (copy it somewhere outside `dist/` before the next release).

1. Check that the dSYM belongs to the crashed build: in the `.ips`, `usedImages` has the app image's `uuid` and `base`. Compare the uuid with `dwarfdump --uuid dist/release/v<version>/symbols/turnlane.dSYM`.
2. For each frame of the faulting thread with that image index, the address is `base + imageOffset`. Look it up:

   ```sh
   atos -o dist/release/v<version>/symbols/turnlane.dSYM/Contents/Resources/DWARF/turnlane-* \
     -arch arm64 -l <base> <base+imageOffset> ...
   ```

   (The DWARF file inside the dSYM is named after Cargo's build of the binary, `turnlane-<hash>`; there is one file.)
3. A Rust panic in the app also writes `~/Library/Logs/turnlane/desktop-panic.log` on the user's Mac (the message, the source location, a backtrace of addresses, and the app's recent connection log; no conversation text). An uncaught Objective-C exception writes its name, reason and call stack to the same file. Ask for that file first: the location line is usually enough.

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
