# Changelog

All notable changes to Turnlane are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/turnlane/turnlane/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/turnlane/turnlane/releases/tag/v0.7.0
