# Turnlane — Design System (v2)

> 画面生成（Claude Design）用のブリーフとして書かれたもの。トークンと規則は実装の正としても使う。
>
> **作り直し（D-099〜D-104、2026-10-08）で次を置き換えた**（詳細は README.md の「作り直し」）: 紫は使わない。your_turn はティール
> （dark `#2DD4BF` / light `#0D9488`）で自分の番の意味だけに使い、主ボタン・選択・フォーカス・現在線は無彩色（text-primary）。
> 予定は左線をやめてカレンダー色 30% の塗りだけ（時刻も text-primary）。AI の作業はカードではなく状態色の 3px の縦線と右のラベル。
> 角丸はチップ 4 / 操作 6 / カード 8 / パネル・ポップオーバー 12。下の v2 の記述のうち、これと食い違うところは古い。

You are a senior product designer who has shipped Linear, Things, Sunsama, Raycast and Notion Calendar-class productivity tools. Produce high-fidelity, static UI mockups for a macOS desktop app. Treat every value below as a hard constraint unless a screen prompt overrides it.

## Product
Turnlane is a free, open-source (MIT) daily planner for the AI-agent era. It lays out "my day" and "my AI's day" on the same date columns. Calendar events, my own tasks, and the work done by coding agents (Claude Code, Codex) appear together. AI work is recorded automatically with zero input. When an AI is waiting on me (permission request, question, PR review, error), that moment becomes an item in my "Your turn" list.
Everything runs locally on the Mac. There are no accounts, no sign-in, no sync, no pricing, no upgrade prompts anywhere in the UI.

Core idea: separate AI running time, the time an AI waited on me, and my own time — so "asked the AI at 2am, reviewed at 8am" is never counted as 6 hours of work or as 6 hours of neglect.

## Audience
Developers, engineers and PMs on a Mac who run 2–5 Claude Code / Codex sessions in parallel every day, often across several Claude accounts. Keyboard-first. They distrust anything cute or "AI-magical".

## Tone: "a quiet instrument panel"
- Calm by default. In the normal state the screen is almost monochrome. Color appears only when something needs attention.
- Color is allowed ONLY for: the five status colors, small project dots (6px), and calendar events (a faint tint of the calendar color as the surface plus a 3px left line in the calendar color; D-086). No other filled backgrounds, gradients, glow, glassmorphism, illustrations, or emoji.
- Do NOT personify the AI. No mascots, robot or sparkle icons, avatars, or phrases like "AI is working hard for you". The AI is shown as a tool log: monospace metadata, source badges, timestamps and durations.
- Metrics are factual totals, never scores or judgments. "Idle 42m" is stated, not scolded.
- Copy is short and factual. No exclamation marks.
- Density: between Linear (dense) and Things (calm). Boards are dense.

## Language
- **English is the canonical UI language.** All mockups are in English unless a prompt asks for a Japanese localization check.
- The app ships with i18n from day one. Japanese frames exist only to check text length and line breaks; layouts must survive both.
- Monospace metadata stays ASCII in every locale: repository names, branch names, PR numbers, durations (12m, 1h12m), times (13:20), source badges, keyboard hints.

## Typography
- UI text: "Inter" (Latin) + "Noto Sans JP" (Japanese localization). No serif fonts anywhere.
- Monospace: "JetBrains Mono" for repo/branch/PR, durations, times, keyboard hints.
- Sizes: 13px body, 12px secondary/meta, 11px micro labels (no all-caps except band labels like "YOUR TURN"), 15px section titles, 20px screen titles. Weights 400 / 500 / 600 only. Tabular figures everywhere.

## Layout & spacing
- 4px base grid; spacing 4, 8, 12, 16, 24, 32.
- Standard density: list rows 28px, cards max 2 lines. Compact variant: 22px rows.
- Radius: 6px cards/panels, 4px chips/badges, 10px popovers/modals.
- 1px hairline borders. Shadows only on popovers/modals.
- Icons: one outline family (Lucide style, 1.5px stroke, 16px). Only status icons are filled.

## Color tokens
Both themes ship. The app follows the macOS appearance setting by default (Light / Dark / System in settings). Design structure in dark first, then verify every screen in light; both must meet the same contrast and hierarchy.

Dark theme:
- bg #0E0F11, sidebar #0B0C0E, surface-raised #18191C (popovers, panels), surface-sunken #141518 (menus, report panels; AI items until D-078), border #26282C, text-primary #E8E9EB, text-secondary #9A9DA3, text-tertiary #686C73 (D-082: was #5F636A; raised so it keeps 3:1 on the working-hours panel and the gray event surface)
- my tasks (D-074): task surface #202227, task border #34373D (cards and done blocks), planned outline #60656E, task shadow none
- AI card (D-078): surface #13161A (a faint blue over the old sunken #141518), 1px line #2C313A; hover keeps the surface and raises the line to #3D4450; selected = 1px accent outline
- time grid (D-105, replaces the D-082 working-hours panel): one flat ground #16171A (`--dl-lane`), hour lines #1E2023 (`--dl-lane-grid`). No panel, no off-hours ground
- calendar event (D-086, replaces the D-082 gray surface): an opaque surface = the calendar color mixed 14% into the ground color #16171A (hover 20%) + 3px left line in the calendar color, no border; the time is text-secondary on it (text-tertiary falls below 3:1 on some tints). The outlined off-hours variant was removed (D-105)
Light theme (D-075: one step more contrast than v2; text-tertiary ≥ 3:1 and text-secondary ≥ 4.5:1 on every surface, sunken clearly darker than bg):
- bg #FBFBFA, sidebar #F0F0ED, surface-raised #FFFFFF, surface-sunken #E6E6E1 (menus, report panels; AI items until D-078), border #D6D6D0, text-primary #161719, text-secondary #4D5058, text-tertiary #72757C
- my tasks (D-074, D-075): task surface #FFFFFF, task border #C4C4BC, planned outline #84857F, task shadow 0 1px 2px rgb(0 0 0 / 0.08)
- AI card (D-078): surface #EEF2F7 (faint blue-gray, far lighter than running blue), 1px line #C9D2DE; hover surface #E6ECF4 and line #AFBCCD; selected = 1px accent outline
- time grid (D-105): one flat ground #FFFFFF (`--dl-lane`), hour lines #F1F1EF (`--dl-lane-grid`)
- calendar event (D-086): an opaque surface = the calendar color mixed 18% into the ground color #FFFFFF (hover 24%) + 3px left line in the calendar color, no border; time in text-tertiary. D-082 had a neutral gray surface, which looked like the off-hours ground
Calendar color palette (D-125; Turnlane-only, never written back to the calendar app). Twelve keys, one value per theme (`--dl-cal-<key>`); the event surface is still the color mixed 30% (hover 36%) into the ground with text-primary on it (R2). Values and checks: README R52, `apps/web/test/event-surface-tokens.test.ts`.
Status colors (dark / light). Each status ALWAYS has color + distinct icon shape + text label:
- error: red #F2555A / #D93036 — filled triangle with "!"
- needs_input (AI blocked on me, highest urgency): amber #F5A524 / #B25E09 — filled circle with pause glyph; may gently pulse. Amber is reserved for this status only.
- running: blue #4C8DFF / #2563EB — open rotating arc
- your_turn (AI finished, ball in my court): violet #9B7BFF / #6D4AE0 — filled circle with right arrow
- done: gray #6B6F76 / #7A7E85 — check mark; never green (light was #8A8E95 before D-075)
- estimated (no hooks; inferred): same icon, same color and shape (D-114 dropped the 60% opacity, dashed outline and small "~"; the icon label and tooltip say "estimated")
- Violet is also the single UI accent (focus ring, selection, primary button, current-time line). Never use green.

## Item kinds (must be distinguishable in grayscale)
1. **Calendar event**: a block with a faint tint of the calendar color (mixed into the ground color) and a 3px left line in the calendar color, no border (D-086; D-082 briefly used a neutral gray surface), title in text-primary, time in mono text-tertiary (text-secondary in dark). Not a card (no checkbox).
2. **My task**: a surface brighter than the background with a border (task surface + task border), round checkbox, title text-primary 13/500. Planned (time placed but not done) = outline only, drawn with the stronger planned outline; done = filled task surface with the task border, checked, strikethrough, tertiary text (D-074: same rule, higher contrast). Optional mono estimate "45m", project tag "#blog", carry-over badge "↺ 3".
3. **Your-turn item** (generated from AI): same shape as my task plus a 2px left edge in the status color and a mono link line "api-gateway · fix/auth-refresh". Lives only in the Today column's YOUR TURN band (see below), never on the time grid while open.
4. **AI work**: NO checkbox. The AI card surface (a faint blue-gray) with a 1px AI card line (D-078; was the sunken surface), the 2px left status line where the lane draws one, status icon, title, mono meta "Turnlane · feat/day-view  PR #142", source badge.
5. **External task** (imported from another tool via MCP): a normal task with a tiny mono source chip, e.g. "github", "linear".
Rule: a checkbox means "something I do". AI items never have checkboxes.
Rule (D-078, D-082): the three card kinds are told apart by surface and line (task = task surface + border, AI = faint blue-gray + 1px line, event = calendar-color tint + 3px colored left line, no border; the AI card's status line is 2px). They sit on one flat ground (D-105; the D-082 working-hours panel was removed).

## Source badges
Mono outlined chips: "CC" (Claude Code), "CX" (Codex), "CD" (Claude Desktop). When the user has more than one Claude account, append the account label: "CC·main", "CC·work". Never show more than one badge row.

## How Your-turn items close
- Replied / done → checked, strikethrough.
- Resolved (inferred): the user moved on (commit, new session, PR merged) → small "~ resolved" label, dashed check.
- Dismissed with `x` ("Not needed") → disappears from the band; counted only in the evening shutdown.
- Expired after 72h → disappears from the band; shown only as a count "Expired 1" in the Today header. Items within 24h of expiry show "expires in 18h" in tertiary mono.

## Time on the grid
- The week board and day view use a full 24-hour vertical axis that scrolls, like Google Calendar's week view. Nothing is collapsed.
- On open, scroll so that today's work start (or the planned start) is near the top; during the day keep the current-time line visible.
- **No working hours** (D-105): there is no working-hours panel, start boundary or "Worked" line. The grid ground is one flat color with faint hour lines; hour labels in the gutter are text-secondary inside the plan guide (per weekday, default 10:00–19:00, used only for free time and "tomorrow morning") and text-tertiary outside. Idle counts only while you are using your Mac (last keyboard or mouse input within 5 minutes); this is not drawn as a band.
- If AI activity exists outside the visible scroll area, show a tiny mono hint at the top/bottom edge: "↑ 1 AI run at night".
- AI running = solid bar. AI waiting on me, three kinds:
  - grace (first 15 minutes) = thin dotted line, status color 50%
  - **idle** (beyond 15m, inside working hours, not during a calendar event) = thicker dotted line in the status color with a mono label "idle 42m"
  - excluded (outside working hours or during a meeting) = gray dotted line 30%, never labeled as idle
- Only open waits (waiting now, idle now) use the styles above. A closed wait is drawn like an excluded one (1px gray dotted) with a small 5px dot in text-tertiary at its end; hovering the dot or the line says "replied 13:40 · 3m", clicking opens the reply task. My response is not drawn as a block in my lane, and there is no `↩` mark (D-074, D-075).
- Current time = 1px violet horizontal line with mono label "13:20".
- Durations: 12m / 1h12m / <1m.

## Do not
- No marketing hero sections, fake browser chrome, stock photos, device mockups.
- No account, login, sync, pricing, trial, or upgrade UI in the core app. (ADR 0015: an extension built into an official release may add its own settings section with a one-line description and a link; it never shows prices, lock icons or repeated prompts.)
- No pie charts or productivity scores.
- No color-filled column headers or colored card backgrounds (calendar events are the one exception: a faint tint of the calendar color plus the left line, no border. D-086).
Let whitespace, hairlines, type weight and the sunken/raised surface difference carry the hierarchy.

## Frame
Unless stated otherwise: one macOS window, 1440×900, native traffic lights, shown flat. Static high-fidelity mockup.
