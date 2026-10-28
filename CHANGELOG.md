# Changelog

All notable changes to Turnlane are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.1] - 2026-10-28

### Added

- When a new version is available, the board shows "Turnlane x.y.z is available" at the top and the menu bar menu gets the same item: copy `brew upgrade --cask turnlane` (Homebrew) or open the Releases page (zip).
- Automatic updates: Turnlane downloads the new version from GitHub Releases, checks Apple's signature and notarization, and installs it when you choose "Restart to update" (or while the app isn't running). If a check fails, nothing is installed and you get the manual instructions. Turn it off with Settings › General or `turnlane config set update.download false`.
- After `brew upgrade --cask turnlane`, Turnlane reopens itself in the menu bar (no window) if it was running before the upgrade.

### Changed

- CI: the startup health test now allows up to two responses over 100 ms (none over 1000 ms), so a single runner hiccup no longer fails the build.
- CI: `actions/checkout` updated from v4 to v5 (Node.js 20 deprecation).

### Fixed

- Your turn missed replies that wait on you to paste or send something ("if you paste …, I'll …").

## [0.7.0] - 2026-10-26

First public release.

### Added

- Three-day board (previous workday, today, next workday) with your calendar events, your tasks, and Claude Code / Codex work on one time axis, grouped by repository and branch.
- *Your turn*: a queue of the moments an agent is waiting on you (permission, question, review, error), created and closed automatically from the agents' local files and optional hooks. Snooze until a set time, or keep items under *Later*.
- Answer an agent's question or allow a permission from Turnlane; the answer is typed into that session's own terminal tab and is never stored.
- *Ask AI* on any task starts Claude Code or Codex in your terminal in a fresh git worktree, and the run shows up as that task's AI work.
- AI screen and AI detail panel: what is running, waiting, or finished, with PR, CI, change size, and a timeline of running, waiting, idle, and in-meeting stretches.
- Daily note kept automatically, available as Markdown from the day view, `turnlane report`, and the stdio MCP server (`turnlane mcp`), which also lets agents add tasks and read your day.
- `Turnlane.app` with a menu bar item, notifications, quick add, and a first-run setup; signed with Developer ID and notarized. Install with Homebrew (`brew install --cask turnlane/tap/turnlane`) or from the zip on GitHub Releases.
- Daily update check against a static `latest.json` on GitHub Releases (no identifiers sent; `turnlane config set update.check false` turns it off).
- `turnlane doctor` and `turnlane doctor --redact` for diagnostics you can paste into an issue.

[Unreleased]: https://github.com/turnlane/turnlane/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/turnlane/turnlane/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/turnlane/turnlane/releases/tag/v0.7.0
