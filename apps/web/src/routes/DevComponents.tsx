/**
 * 開発用の部品一覧（/dev/components。M2-11）: 両テーマ × 英日を並べて目視確認する。データは画面内の固定値（ダミー）。
 */
import type {
  AiLaneItem,
  CalendarEventView,
  ClosedTodayRow,
  QueueItem,
  TaskView,
  WorkItemStatus,
} from "@turnlane/core/web";
import type { ReactNode } from "react";
import { AiRunBlock, EventBlock, TaskCard } from "../components/items.tsx";
import { StatusIcon } from "../components/StatusIcon.tsx";
import { ClosedTurnRow, TurnRow } from "../components/TurnRow.tsx";
import { Button, Chip, Kbd, Meta, SourceBadges, Warning } from "../components/ui.tsx";
import { I18nProvider, type Locale, useT } from "../i18n/index.tsx";

const NOW = Date.UTC(2026, 9, 2, 4, 20);
const TZ = "Asia/Tokyo";
const H = 3_600_000;

const task = (p: Partial<TaskView>): TaskView => ({
  id: "t1",
  title: { t: "text", text: "Write article outline" },
  status: "todo",
  scheduledDate: "2026-10-02",
  laneOrder: "a0",
  estimateMin: 45,
  projectId: null,
  rolloverCount: 0,
  isHighlight: false,
  completedAt: null,
  autoCompleted: false,
  origin: { source: "manual", client: null, externalSource: null, externalUrl: null },
  followUpId: null,
  workItemId: null,
  createdAt: NOW,
  deletedAt: null,
  ...p,
});

const turn = (status: WorkItemStatus, p: Partial<QueueItem> = {}): QueueItem => ({
  workItemId: status,
  title: "auth token refresh",
  status,
  reason: null,
  estimated: false,
  repoRoot: "/w/api-gateway",
  branch: "fix/auth-refresh",
  prRef: null,
  sources: [{ tool: "claude_code", profile: "work" }],
  waitingSince: NOW - 7 * 60_000,
  waitStartedAway: false,
  followUps: [
    {
      id: `f-${status}`,
      kind: status === "needs_input" ? "approve" : status === "error" ? "resume_error" : "reply",
      status: "open",
      title: {
        t: "auto",
        key:
          status === "needs_input"
            ? "followup.approve"
            : status === "error"
              ? "followup.resume_error"
              : "followup.reply",
        params: {
          title: "auth token refresh",
          repo: "api-gateway",
          branch: "fix/auth-refresh",
          pr: null,
          prTitle: null,
        },
      },
      triggerAt: NOW - 7 * 60_000,
      snoozeUntil: null,
      engagedAt: null,
      expiresAt: null,
      taskId: null,
      taskDate: null,
      task: null,
    },
  ],
  ...p,
});

const event: CalendarEventView = {
  id: "e1",
  title: "Weekly sync",
  start: NOW - 3 * H,
  end: NOW - 2 * H,
  allDay: false,
  startDate: null,
  endDate: null,
  editable: false,
  calendarColor: "#6b8cc7",
  calendarColorKey: null,
  calendarId: "cal-1",
  busy: true,
};

const closed: ClosedTodayRow = {
  followUpId: "c1",
  workItemId: "w9",
  title: { t: "text", text: "Reply: pricing page question" },
  kind: "resolved",
  signal: "commit",
  closedAt: NOW,
  repoRoot: "/w/blog",
  branch: "main",
};

const ai: Pick<AiLaneItem, "title" | "sources"> = {
  title: "Auth token refresh handler retry and backoff",
  sources: [{ tool: "claude_code", profile: "work" }],
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-mono text-micro text-fg3">{title}</h3>
      {children}
    </section>
  );
}

function Gallery() {
  const t = useT();
  const statuses: WorkItemStatus[] = ["error", "needs_input", "running", "your_turn", "done"];
  return (
    <div className="flex w-[420px] flex-col gap-5 bg-bg p-5 text-fg">
      <Section title="status">
        <div className="flex flex-wrap items-center gap-3">
          {statuses.map((s) => (
            <span key={s} className="flex items-center gap-1 text-meta">
              <StatusIcon status={s} size={16} /> {t(`status.${s}`)}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {statuses.map((s) => (
            <StatusIcon key={s} status={s} estimated size={16} />
          ))}
        </div>
      </Section>
      <Section title="badges / meta / keys">
        <div className="flex items-center gap-2">
          <SourceBadges
            sources={[
              { tool: "claude_code", profile: null },
              { tool: "codex", profile: null },
            ]}
          />
          <SourceBadges sources={[{ tool: "claude_code", profile: "main" }]} />
          <Chip>github</Chip>
          <Kbd>⌘K</Kbd>
          <Kbd>⏎</Kbd>
        </div>
        <Meta parts={["turnlane", "feat/day-view", "#142"]} />
        <Warning>
          {t("board.overlap")} · <span className="font-mono">45m</span>
        </Warning>
        <div className="flex gap-2">
          <Button variant="primary">{t("action.save")}</Button>
          <Button>{t("action.cancel")}</Button>
          <Button variant="ghost">{t("action.snooze")}</Button>
        </div>
      </Section>
      <Section title="your turn">
        <TurnRow item={turn("needs_input")} now={NOW} tz={TZ} />
        <TurnRow item={turn("error")} now={NOW} tz={TZ} />
        <TurnRow
          item={turn("your_turn", { waitingSince: NOW - 26 * H, repoRoot: "/w/blog" })}
          now={NOW}
          tz={TZ}
        />
        <TurnRow item={turn("your_turn", { waitStartedAway: true })} now={NOW} tz={TZ} />
        <ClosedTurnRow row={closed} />
      </Section>
      <Section title="tasks">
        <TaskCard task={task({ rolloverCount: 3 })} />
        <TaskCard
          task={task({
            origin: {
              source: "mcp",
              client: "claude-code",
              externalSource: null,
              externalUrl: null,
            },
          })}
        />
        <TaskCard
          task={task({
            origin: { source: "manual", client: null, externalSource: "github", externalUrl: null },
          })}
        />
        <div className="relative h-24">
          <TaskCard
            task={task({})}
            variant="planned"
            overlapMs={45 * 60_000}
            style={{ top: 0, left: 0, right: 0, height: 40 }}
          />
          <TaskCard
            task={task({
              status: "done",
              title: { t: "text", text: "Send invoice" },
              estimateMin: 30,
            })}
            variant="done"
            style={{ top: 48, left: 0, right: 0, height: 20 }}
          />
        </div>
      </Section>
      <Section title="event / ai">
        <div className="relative h-28">
          <EventBlock e={event} tz={TZ} style={{ top: 0, left: 0, right: 0, height: 40 }} />
          <AiRunBlock
            title={ai.title}
            status="needs_input"
            estimated={false}
            sources={ai.sources}
            right="7m"
            style={{ top: 48, left: 0, width: 200, height: 20 }}
          />
          <AiRunBlock
            title="PR #142"
            status="running"
            estimated={false}
            sources={[{ tool: "claude_code", profile: "main" }]}
            right="4m"
            style={{ top: 72, left: 0, width: 200, height: 20 }}
          />
        </div>
      </Section>
    </div>
  );
}

export function DevComponents() {
  const locales: Locale[] = ["en", "ja"];
  return (
    <div className="flex h-full flex-wrap gap-4 overflow-auto p-4">
      {(["dark", "light"] as const).map((theme) =>
        locales.map((l) => (
          <div key={`${theme}-${l}`} data-theme={theme} className="rounded-pop border border-line">
            <I18nProvider locale={l}>
              <Gallery />
            </I18nProvider>
          </div>
        )),
      )}
    </div>
  );
}
