# Changelog

All notable changes to Turnlane are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Release script: `--publish` accepts `y` or `yes` at its questions, creates the tag only after the push is confirmed, and continues when an unpushed local tag already points at the build commit (instead of refusing until it is deleted by hand).

## [0.7.3] - 2026-10-29

### Fixed

- Automatic update: the previous version's bundle is no longer deleted while the previous app and daemon are still shutting down, which could make the old app crash during 'Restart to update'. Updating from 0.7.2 still shows that crash dialog once (the old daemon does the deletion); from 0.7.3 on it is gone.

### Changed

- Release script: `--publish` reuses the finished set in `dist/release/` instead of rebuilding, `--from-app` continues from a stapled app when stapling lagged, and the tag goes on the commit the build came from.

## [0.7.2] - 2026-10-29

### Added

- AI detail: a *Last reply* section shows the agent's latest message (or its question), read from the session log on your Mac when you open the panel and never stored. It and the full question in *Answer* are shown with Markdown formatting (HTML is not interpreted; only http(s) links).
- Answer and the Your turn rows now show the question for Codex sessions too, read from the Codex session log when shown and never stored (Codex permission requests are unchanged).
- AI detail: a *Next instruction* box under the last reply sends your next instruction to the session's terminal tab, like Answer. It only sends while the agent is still running there with its turn finished and nothing waiting on you; otherwise it says why (ended, working, waiting on you). The text is not stored.
- Markdown in the AI detail panel renders tables (GitHub-style pipe tables).
- Sessions driven through the Claude Agent SDK (another program is at the terminal, not you) show a small *via SDK* badge on the row and in the panel.

### Changed

- Your turn: sessions driven through the SDK no longer become Your turn for a question, leftover edits or a plain stop, and no reply / check / approve tasks are created for them. An open PR still is Your turn.
- After *Tomorrow*, *Snooze* or *Pick a time* on an AI item, the lane label and the detail panel show when it comes back (same wording as the Later section) and the status icon is a clock until then; the arrow returns when the item wakes.

### Fixed

- Next instruction said the agent was working when the session was idle after Claude Code compacted its context: the compaction summary record was taken for a new instruction.
- Your turn: a reply that waits on a future event ("once the graph is available, please send a screenshot") was treated as a question to answer now. Requests that wait on you ("if you paste it, I will decide") still count.
- Your turn: a turn whose changes had already been checked or committed came back as *changes to check* whenever another session made the same repository dirty again.

## [0.7.1] - 2026-10-28

### Added

- When a new version is available, the board shows "Turnlane x.y.z is available" at the top and the menu bar menu gets the same item: copy `brew upgrade --cask turnlane` (Homebrew) or open the Releases page (zip).
- Automatic updates: Turnlane downloads the new version from GitHub Releases, checks Apple's signature and notarization, and installs it when you choose "Restart to update" (or while the app isn't running). If a check fails, nothing is installed and you get the manual instructions. Turn it off with Settings › General or `turnlane config set update.download false`.
- After `brew upgrade --cask turnlane`, Turnlane reopens itself in the menu bar (no window) if it was running before the upgrade.

### Changed

- CI: the startup health test now allows up to two responses over 100 ms (none over 1000 ms), so a single runner hiccup no longer fails the build.
- CI: `actions/checkout` updated from v4 to v5 (Node.js 20 deprecation).
- Release script: after notarization, stapling is retried for up to 30 minutes instead of 5 while Apple publishes the ticket.

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

[Unreleased]: https://github.com/turnlane/turnlane/compare/v0.7.3...HEAD
[0.7.3]: https://github.com/turnlane/turnlane/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/turnlane/turnlane/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/turnlane/turnlane/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/turnlane/turnlane/releases/tag/v0.7.0
