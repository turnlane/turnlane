# @turnlane/collectors

Adapters that read the local files of AI coding agents and turn them into tool-independent `NormalizedEvent`s (phase0-plan 3.1 and 3.1.1). The package depends on nothing: no other `@turnlane/*` package, no database, no HTTP. It is kept this way so that a new agent can be supported with a pull request that touches only this directory.

## Public interface

Only what is exported from `src/index.ts`, `src/testing/index.ts`, and `src/hook-allowlist.ts` is public. Everything else is internal.

| Export | What |
|---|---|
| Types | `SourceAdapter`, `NormalizedEvent`, `SessionRef`, `EndedWith`, `DetectedRoot`, `StreamSpec`, `WatchSpec`, `Cursor`, `ReadContext`, `ReadResult`, `AdapterCapabilities`, `AdapterTiming`, `HookSpec`, `ToolId`, `MetaOnlyLogger`, and others |
| `ADAPTER_API_VERSION` | Compatibility version. When it is raised, every bundled adapter is updated with it |
| `defineAdapter(a)` | Validates the `ToolId` format, `apiVersion`, and that the allowlist contains no body-like keys, then returns the adapter |
| `builtinAdapters` | The bundled adapters (`claude_code`, `codex`, `hook_spool`) |
| `readJsonlIncremental()` | JSONL reader that handles line boundaries, partial last lines, truncation, and inode changes. Adapters use this instead of reading files directly |
| `pickAllowed(record, keys)` | Keeps only the allowlisted keys. Adapters call it immediately after parsing JSON |
| `textTraits(text)` | Whether the last message ends with a question or a closing phrase. Returns booleans only |
| `@turnlane/collectors/hook-allowlist` | Keys kept in the hooks spool (`HOOK_ALLOWLIST`, `HOOK_TOOL_IDS`). A constants-only module with no imports ([ADR 0009](../../docs/adr/0009-hook-allowlist-zero-dependency-module.md)) |
| `@turnlane/collectors/testing` | `runGoldenSuite`, `runIncrementalSuite`, `runSentinelSuite`, `withRootJail`, `readAll`, `reduceEvents` |

## Rules

- **Zero external dependencies.** `package.json` must have no `dependencies` (a test checks this). `@turnlane/*`, drizzle, hono, zod, and `bun:sqlite` cannot be imported (Biome checks this).
- **Adapters never start processes, never go on the network, never write, and never read outside the root they detected.** Files are read through `io` from `src/io.ts`; the test kit's `withRootJail` makes reads outside the root fail.
- **No conversation text is emitted** ([ADR 0005](../../docs/adr/0005-no-ai-session-body-storage-or-transmission.md)). The keys an adapter reads are declared in its `allowlist`, and every parsed record goes through `pickAllowed` right away. Where a property of the text is needed (does the last message end with a question?), reduce it to a boolean on the spot and drop the text.
- **Never open credentials.** `auth.json`, `*.key`, `Cookies*`, `*token*`, and similar are refused by `isForbiddenFile`.
- **Events carry cumulative values; sinks only assign.** Re-reading the same file any number of times must produce the same result.
- **Not the adapter's job:** filling in `repo_root` and branch from git, assigning sessions to projects, and deriving state. The daemon's enrich step and `core/derive` do that.

## Adding an adapter

1. Share the agent's name, where it keeps its logs, and the structure of the format (field names, not content) in the *Adapters* Discussion category or an adapter request issue.
2. Copy `src/adapters/_template/` to `src/adapters/<tool>/` and choose a `ToolId` (`^[a-z][a-z0-9_]{1,31}$`, not already taken).
3. Implement `detect`, `watch`, `listStreams`, `streamFor`, and `read`; declare `allowlist`, `testedVersions`, `capabilities`, and `timing`. Read with `readJsonlIncremental`. Do not open another tool's SQLite database in place; if the agent only has a database, copy a snapshot first or request a change on the agent's side.
4. Build fixtures from your own data with
   `bun run --cwd packages/collectors anonymize -- --tool <tool> --root <detected root> --out test/fixtures/<tool>/<version>/<case> [--max-turns N] [--partial-tail] <files...>`
   and check by eye that nothing personal is left. The script drops message bodies, replaces paths, branches, session IDs, and titles with consistent synthetic values, shifts timestamps, and fails if anything identifying remains. At minimum three cases: a normal single turn, a session that ends with a question to the user, and a file whose last line is still being written.
5. Add `test/<tool>.test.ts` calling `runGoldenSuite`, `runIncrementalSuite`, and `runSentinelSuite`.
6. Register the adapter in `builtinAdapters` in `src/registry.ts`. No migration, `core`, or daemon change is needed.
7. If the agent has hooks, add an entry for the `ToolId` to `src/hook-allowlist.ts` and implement `HookSpec`. The installer lives in `apps/cli/src/hooks-install/` and can be a separate PR.
8. Add a row to the source list in `docs/spec/ai-session-ingestion.md`.

## Bundled adapters

| ToolId | Tested versions | Reads |
|---|---|---|
| `claude_code` | Claude Code 2.1.x | `<config dir>/projects/**/<sid>.jsonl`, `subagents/agent-*.jsonl` (parent linkage only), `sessions/<pid>.json` |
| `codex` | Codex CLI 0.147–0.159 | `sessions/**/rollout-*.jsonl`, `archived_sessions/rollout-*.jsonl`, `session_index.jsonl` (the SQLite database is never opened) |
| `hook_spool` | — | Turnlane's own `spool/hooks-YYYYMMDD.jsonl`, written by `turnlane hook` |

`testedVersions` is a semver range declared by each adapter; `turnlane doctor` reports agents whose installed version falls outside it.
