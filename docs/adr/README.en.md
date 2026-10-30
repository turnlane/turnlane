# Architecture Decision Records (English index)

The records themselves are in Japanese ([README.md](README.md) is the Japanese index). This page summarizes each decision in English so you can find the one that matters before reading it. When an ADR is changed, a new ADR is added: it either supersedes the old one or amends part of it, and both point at each other.

| # | Decision | Status |
|---|---|---|
| [0001](./0001-local-daemon-spa-tauri.md) | A local daemon plus a React single-page app; a thin Tauri 2 shell for the desktop | Accepted (amended by 0010) |
| [0002](./0002-local-sqlite-source-of-truth-hlc-lww-sync-later.md) | Local SQLite is the source of truth; any future sync is added later with hybrid logical clocks and last-writer-wins | Accepted (amended by 0008: no sync server) |
| [0003](./0003-calendar-eventkit-phase0-google-api-phase1.md) | Calendars come from macOS EventKit | Accepted (amended by 0008, 0010, 0012; the Google Calendar API part is superseded) |
| [0004](./0004-ingestion-file-watch-primary-hooks-opt-in.md) | Agent sessions are read from their local files; hooks are an optional fast path | Accepted |
| [0005](./0005-no-ai-session-body-storage-or-transmission.md) | Conversation text from agent sessions is neither stored nor sent anywhere | Accepted (amended by 0018) |
| [0006](./0006-bun-workspaces-toolchain.md) | One toolchain: Bun workspaces | Accepted (amended by 0007) |
| [0007](./0007-bun-1-4-pin-and-build-conditions.md) | Bun is pinned to 1.4 and the single-binary build conditions are fixed | Accepted (amends 0006; amended by 0009) |
| [0008](./0008-mit-no-server-open-source.md) | MIT-licensed open source with no server run by the author (the only network use is the update check and download from GitHub Releases) | Accepted (amends 0002, 0003; amended by 0015) |
| [0009](./0009-hook-allowlist-zero-dependency-module.md) | The hooks allowlist lives in a dependency-free module so the hook command stays fast | Accepted (amends 0007) |
| [0010](./0010-desktop-shell-in-phase0-as-daemon-client.md) | The desktop shell is a client of the daemon, not a second backend | Accepted (amends 0001, 0003) |
| [0011](./0011-single-app-bundle-smappservice.md) | One app bundle; background processes are registered with SMAppService | Proposed (amended by 0016) |
| [0012](./0012-events-in-calendar-tasks-stay-local.md) | Events are written to Calendar.app; tasks and their time blocks stay in Turnlane | Accepted (amends 0003; amended by 0016) |
| [0013](./0013-presence-from-input-idle-only.md) | Presence is recorded only as "time since the last input"; idle time counts only while you were at the Mac | Accepted |
| [0014](./0014-ai-launch-via-launch-id.md) | Ask AI hands the terminal only a launch ID; Turnlane cleans up only the worktrees it created | Accepted |
| [0015](./0015-extension-points-and-separately-licensed-additions.md) | The app has extension points; an official build may include a separately licensed extension | Accepted (amends 0008; amended by 0017) |
| [0016](./0016-rename-to-turnlane.md) | The product is named Turnlane | Accepted (amends 0011, 0012) |
| [0017](./0017-extension-api-version-rule.md) | The extension API version is raised only when something is changed or removed, not when something is added | Accepted (amends 0015) |
| [0018](./0018-bounded-local-storage-of-wait-details.md) | Conversation text never leaves the Mac; only bounded, masked wait details are stored locally (first line of your instruction, the question, the permission command, the error kind) | Accepted (amends 0005) |
| [0019](./0019-answer-from-turnlane.md) | Answer from Turnlane: the answer is typed into the session's terminal tab, never sent automatically, and not stored (Codex sessions use the process their hooks report) | Accepted |
| [0020](./0020-asked-back-and-back-to-turn.md) | A question answered with a question stays open until the AI answers; a closed item can be put back on Your turn by hand | Accepted |
| [0021](./0021-report-from-own-scripts-and-agents.md) | Reports from your own scripts and agents are one more ingestion source (a spool file and the `report` adapter), with one type for the CLI, MCP, and HTTP | Accepted |
