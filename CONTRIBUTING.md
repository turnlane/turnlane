# Contributing to Turnlane

Thanks for taking a look. Turnlane is a one-person side project, so the most useful contributions are small, self-contained, and come with tests. The single most valuable thing you can add is an adapter for another coding agent; see [Adding an adapter](#adding-an-adapter).

Before spending time on a larger change, open a Discussion or an issue so we can agree on the shape. Pull requests that widen the scope of the product (new screens, new integrations, anything that talks to a server) are unlikely to be merged without that conversation; the project's direction is set in the ADRs under [docs/adr/](docs/adr/).

## Ground rules

These are non-negotiable because they are what makes Turnlane safe to run on a machine full of other people's code.

1. **No conversation text.** Nothing from an agent session other than timestamps, repository, branch, state, and the optional title may reach the database, logs, spool, exports, test output, or fixtures. Each adapter declares the keys it reads in an `allowlist`, and extraction goes through `pickAllowed`. [ADR 0005](docs/adr/0005-no-ai-session-body-storage-or-transmission.md).
2. **No real data in the repository.** Fixtures are produced with `packages/collectors/scripts/anonymize.ts` and checked by eye before they are committed. No home paths, user names, host names, repository names, calendar names, or anything that identifies you or a client, in code, comments, tests, commit messages, or screenshots. Screenshots are taken from `scripts/dev-board.ts` (synthetic data only).
3. **No server, no network.** Code in this repository must not connect to any host run by the author or to third-party APIs. The only exceptions are commands the user runs themselves (`gh`, `claude`, `codex`) and the once-a-day update check against GitHub Releases ([ADR 0008](docs/adr/0008-mit-no-server-open-source.md), [ADR 0015](docs/adr/0015-extension-points-and-separately-licensed-additions.md)). No telemetry, no accounts, no license checks in this codebase.
4. **Do not break the user's setup.** Other tools' config files (`settings.json` for Claude Code, `hooks.json` for Codex) are edited idempotently, only for entries tagged `--managed-by turnlane`, with a backup written first, and without adding unknown keys.
5. **MIT-compatible dependencies only.** No GPL-family dependencies. Runtime dependencies are listed in `THIRD_PARTY_NOTICES.md`; regenerate it with `bun scripts/third-party-notices.ts` when you add or bump one.
6. **English is the source language** for UI strings, CLI output, and new documentation. Japanese strings exist for layout checks; keep both in sync when you touch `apps/web/src/i18n/`.

## Development setup

Requirements: macOS 14 or later on Apple Silicon, [Bun](https://bun.sh) 1.4.x (the exact version is pinned in `package.json`), Xcode command line tools. Rust (see `.mise.toml`) is only needed for the desktop shell.

```sh
bun install
bun run check                     # biome lint + tsc -b + bun test
bunx playwright install webkit    # once, for the E2E suite
bun run e2e                       # UI tests against dev-board in WebKit
bun run build                     # out/turnlaned and out/turnlane (single binaries)
bun run smoke                     # runs the binaries in a temporary HOME
bun run dev:board                 # the UI with synthetic data at http://127.0.0.1:27317
```

`bun run dev:board` is the fastest way to look at the UI. It runs the daemon in a temporary HOME with fake clock, fake git, fake calendar, and synthetic sessions; it never reads `~/.claude*`, `~/.codex`, or your real Turnlane data. See the header of `scripts/dev-board.ts` for the scenarios (`--morning`, `--dense`, `--design board`, and so on).

To run a development build against your own data, follow [docs/dev/m0-install.md](docs/dev/m0-install.md) (`turnlane self-install`). Sign the binaries with a development certificate (`TURNLANE_CODESIGN_IDENTITY`) or macOS will keep asking for automation permissions after each rebuild.

### Repository layout

| Path | What |
|---|---|
| `apps/daemon` | `turnlaned`: ingestion, derivation, HTTP API (Hono), SQLite (Drizzle), serves the web UI |
| `apps/cli` | `turnlane`: tasks, hooks endpoint, stdio MCP server, install/uninstall, doctor |
| `apps/web` | React SPA (Vite, TanStack Router/Query, Tailwind v4) |
| `apps/desktop` | Tauri 2 shell (Rust): window, menu bar, notifications, quick add. Display and OS glue only |
| `packages/core` | Schema, migrations, pure derivation logic (`src/derive/`), settings, paths |
| `packages/collectors` | Agent adapters. Zero dependencies; must not import the rest of the workspace |
| `native/calendar-helper` | Swift helper for EventKit |
| `docs/spec`, `docs/adr`, `docs/design` | Specifications (currently in Japanese), decision records, final designs |
| `e2e`, `test` | Playwright suites and cross-package tests |

Specs win over code. If you find them disagreeing, either fix the code or propose a spec change in the PR; do not quietly change behaviour. Decisions are changed by adding a new ADR, not by editing an old one.

## Adding an adapter

An adapter turns one agent's local files into tool-independent `NormalizedEvent`s. It lives in `packages/collectors/src/adapters/<tool>/`, has no dependencies, never starts processes, never writes, never goes on the network, and never reads outside the root it detected. The full guide, including the public interface and the test kit, is in [packages/collectors/README.md](packages/collectors/README.md).

In short:

1. Open an [adapter request](https://github.com/turnlane/turnlane/issues/new?template=adapter_request.yml) or a Discussion in the *Adapters* category describing where the agent keeps its logs and what the structure looks like (field names, not content).
2. Copy `src/adapters/_template/` to `src/adapters/<tool>/`, pick a `ToolId` (`^[a-z][a-z0-9_]{1,31}$`), and implement `detect`, `watch`, `listStreams`, `streamFor`, and `read` with `readJsonlIncremental`. Declare `allowlist`, `testedVersions`, `capabilities`, and `timing`.
3. Create fixtures from your own data with `bun run --cwd packages/collectors anonymize -- --tool <tool> --root <detected root> --out test/fixtures/<tool>/<version>/<case> <files...>` and check them by eye. At minimum: a normal turn, a session that ends with a question to the user, and a file whose last line is still being written.
4. Add `test/<tool>.test.ts` calling `runGoldenSuite`, `runIncrementalSuite`, and `runSentinelSuite`, and register the adapter in `src/registry.ts`.
5. If the agent has hooks, add its `ToolId` to `src/hook-allowlist.ts` and implement `HookSpec`; the installer in `apps/cli/src/hooks-install/` can come in a separate PR.
6. Add a row to the source list in `docs/spec/ai-session-ingestion.md`.

No changes to the database, `core`, or the daemon are needed for a new adapter.

## Pull requests

- One topic per PR. Keep refactors separate from behaviour changes.
- `bun run check` must pass; add or update tests for what you changed. UI changes that touch the time axis should also pass `bun run e2e`.
- Describe what changed and why, and link the issue or Discussion. Screenshots from `dev-board` are welcome for UI changes.
- Commit messages: a short summary line, then the reasoning if it is not obvious.
- By submitting a contribution you agree that it is licensed under the project's [MIT License](LICENSE).

CI runs on macOS: lint, typecheck, unit tests, the collectors package in isolation, a binary build with the hook start-up benchmark, the E2E suite in WebKit, the Swift helper build, and `cargo clippy` for the desktop shell.

## Reporting bugs and asking questions

- Bugs: use the [bug report form](https://github.com/turnlane/turnlane/issues/new?template=bug_report.yml) and paste the output of `turnlane doctor --redact`. It contains versions, state codes, and counts only; paths, user names, repository names, and titles are removed.
- Questions and ideas: [GitHub Discussions](https://github.com/turnlane/turnlane/discussions). See [SUPPORT.md](SUPPORT.md).
- Security: see [SECURITY.md](SECURITY.md). Please do not file vulnerabilities as public issues.

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
