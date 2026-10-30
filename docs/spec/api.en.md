# Turnlane HTTP API (English overview)

This is an English map of the daemon's HTTP API for contributors and for people who script against their own Turnlane. The full specification, with every field and edge case, is [m2-api.md](m2-api.md) (Japanese); the chapter numbers below point into it. The types are the source of truth in code: `packages/core/src/api/*.ts` (responses) and the Zod schemas next to them (inputs). The web app and the CLI use a typed client generated from the routes (`hc<AppType>`).

## Basics

- The daemon (`turnlaned`) listens on `http://127.0.0.1:7317` only (`TURNLANE_PORT` changes the port). There is no remote access and no account.
- **Authentication.** Scripts and the CLI send `Authorization: Bearer <token>`, where the token is the contents of `~/Library/Application Support/turnlane/token` (under `TURNLANE_DATA_DIR` if set). The browser gets an `HttpOnly; SameSite=Strict` cookie from `GET /auth?t=<token>` (`turnlane open` does this). Requests that change state from a browser must also come from the same origin.
- **Reads** return `ReadMeta` (`today`, `displayToday`, `now`, `rev`, `tz`, `dayBoundary`) alongside the data. `rev` increases with every write; clients use it with server-sent events to refetch.
- **Live updates.** `GET /api/events` is a server-sent events stream (`task`, `work_item`, `follow_up`, `calendar`, `source`, `day_boundary`, and a few more). Events carry IDs and kinds, never conversation text.
- **Errors** are JSON: `{ "error": "<code>" }` with 400 for invalid input, 404 for unknown IDs, 409 when the action does not apply to the current state.
- **Privacy.** No endpoint returns conversation text that is not stored. The few that read it from the local session log at request time (glance, wait, last reply) send `Cache-Control: no-store` and do not log it ([ADR 0005](../adr/0005-no-ai-session-body-storage-or-transmission.md), [ADR 0018](../adr/0018-bounded-local-storage-of-wait-details.md)).

## Screens (aggregated reads)

| Method | Path | Returns | m2-api |
|---|---|---|---|
| GET | `/api/board?from=YYYY-MM-DD&to=YYYY-MM-DD` (or `?around=YYYY-MM-DD`) | Week or 3-day board: events, tasks, AI lane items and their run and wait spans, capacity per day | 2 |
| GET | `/api/day/:date` | Day view: the same day in detail, with free slots and the record | 2, 15 |
| GET | `/api/inbox` | Undated tasks | 2 |
| GET | `/api/queue` | Your turn: open items, Later (snoozed, tomorrow, scheduled, usage limit), items in their grace period, closed today | 2, 32 |
| GET | `/api/queue/summary` | The count for the menu bar and the tab title | 2 |
| GET | `/api/ai/live` | The AI screen: items that are running or whose process is alive | 33 |
| GET | `/api/search?q=` | ⌘K search over task, AI item, and event titles (never conversation text) | 17 |
| GET | `/api/away` | The "while you were away" summary | — |

## Tasks, time blocks, projects

| Method | Path | What | m2-api |
|---|---|---|---|
| POST | `/api/tasks` | Create a task (`title` or natural-language `raw`, `date`, `estimateMin`, `projectId`/`projectName`, `notes`, `external: { source, id, url? }` for idempotent imports) | 2 |
| GET / PATCH / DELETE | `/api/tasks/:id` | Read, edit, delete (soft) | 2 |
| POST | `/api/tasks/:id/move`, `/complete`, `/uncomplete`, `/start`, `/restore` | Move to a date and order, complete, reopen, start tracking, undo a delete | 2 |
| POST / PATCH / DELETE | `/api/time-blocks`, `/api/time-blocks/:id` | Place a task on the timeline (Turnlane only; never written to the calendar) | 2, 24 |
| GET / POST / PATCH | `/api/projects`, `/api/projects/:id`, `/api/projects/repos` | Projects and the repositories they map to | 19 |
| POST | `/api/days/:date/carry`, `/api/days/carry/undo` | Carry the day's leftovers to today, and undo it | — |
| PUT / POST | `/api/daily-notes/:date`, `/api/daily-notes/:date/summary` | The day's memo and the optional AI summary | 11 |

## AI work and Your turn

| Method | Path | What | m2-api |
|---|---|---|---|
| GET | `/api/work-items/:id` | AI detail: the item, its runs, artifacts (PRs), follow-ups, wait spans, time breakdown | 2 |
| PATCH | `/api/work-items/:id` | Rename, mark done, hide | 2 |
| GET | `/api/work-items/:id/glance` | What the item is waiting on, read at request time (`no-store`) | — |
| GET | `/api/work-items/:id/wait`, POST `/answer` | Answer from Turnlane: the open wait and where an answer would go; type the answer into the session's terminal tab | 31 |
| GET | `/api/work-items/:id/last-reply`, POST `/instruct` | The AI's last reply, and sending a next instruction | 34, 35 |
| POST | `/api/work-items/:id/reply-task`, `/back-to-turn`, `/dismiss-limit`, `/merge`, `/check-task` | Make a reply task, put a closed item back on Your turn, dismiss a usage-limit wait, merge two items, drop an item onto your lane as a check task | 2, 32, 36 |
| POST | `/api/follow-ups/:id/snooze` (`{ preset }` or `{ until }`), `/defer`, `/wake`, `/dismiss`, `/complete`, `/reopen`, `/engage`; `/api/follow-ups/bulk-dismiss` | Act on a Your turn item | 2, 32 |
| GET / POST | `/api/open/options`, `/api/open`, `/api/open/apps` | Open the item where it lives (terminal tab, editor, PR, reported link) | 13 |
| POST / GET | `/api/ai/reports`, `/api/ai/reports/sources` | Reports from your own scripts and agents | 37 |
| GET / POST | `/api/ai/launches`, `/api/ai/templates`, `/api/ai/claude-accounts` | Ask AI from a task | 27 |

## Sources, settings, and the rest

| Method | Path | What | m2-api |
|---|---|---|---|
| GET / PATCH / POST | `/api/sources`, `/api/sources/:id`, `/api/sources/rescan` | Ingestion sources: turn one off, exclude folders, rescan | 2 |
| GET / PUT | `/api/config`, `/api/config/:key` | Settings (`turnlane config` uses the same keys) | — |
| GET / PUT | `/api/settings/ui` | Display preferences | — |
| GET / PATCH | `/api/calendars`, `/api/calendars/:id` | Calendars and their role, color, and visibility | 24, 29 |
| POST / GET / PATCH / DELETE | `/api/calendar-events`, `/api/calendar-events/:id` | Create and edit events in Calendar.app | 24 |
| GET / POST | `/api/focus`, `/api/focus/start`, `/api/focus/end` | Focus mode | 25 |
| GET / DELETE | `/api/stored-detail` | Counts of stored wait details, and deleting them | — |
| GET / POST | `/api/onboarding/*`, `/api/update/*`, `/api/install` | First run, updates, install state (used by the app) | — |
| GET | `/api/health` | Daemon state, database, source health | 2 |

## MCP and CLI

The stdio MCP server (`turnlane mcp`) and the `turnlane` CLI call this same API with the Bearer token; neither opens the database directly. Their tools and commands are listed in [phase0-plan.md](phase0-plan.md) 3.5 and 3.6 and in the README.
