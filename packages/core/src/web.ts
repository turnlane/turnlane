/**
 * web（ブラウザ）から使ってよいものだけを集めた入口（@turnlane/core/web）。
 * DB・bun:sqlite・Bun の API に依存するモジュールはここから export しない（Vite のビルドが壊れるため）。
 */

export {
  ANSWER_MAX,
  answerLanding,
  answerSentText,
  answerWhere,
  numberedOptions,
  prepareAnswer,
  WAIT_QUESTION_MAX,
} from "./answer.ts";
export type * from "./api/index.ts";
export {
  addTaskToBoard,
  addTaskToInbox,
  deferFollowUpInQueue,
  findBlock,
  findTask,
  markEngagedInQueue,
  moveTaskInBoard,
  patchBlockInBoard,
  patchTaskInBoard,
  placeTaskInBoard,
  removeBlockFromBoard,
  removeFollowUpFromQueue,
  removeLimitWaitFromQueue,
  removeTaskFromBoard,
  removeTaskFromInbox,
  snoozeFollowUpInQueue,
  wakeFollowUpInQueue,
} from "./api/optimistic.ts";
export {
  CALENDAR_COLOR_KEYS,
  type CalendarColorKey,
  isCalendarColorKey,
} from "./calendar/colors.ts";
export { groupHolidaySources } from "./calendar/holidays.ts";
export {
  addDays,
  dayEndMs,
  dayStartMs,
  isLocalDate,
  toLocalDate,
  wallClock,
  wallToEpoch,
} from "./dates.ts";
export { NATIVE_MENU, type NativeMenuText } from "./desktop/menu-text.ts";
export { EXT_API_VERSION } from "./ext.ts";
export { hasMeetingLink, isMeetingHost, MEETING_HOSTS } from "./focus/meeting-link.ts";
export {
  addHeld,
  answerPrompt,
  cancelReservation,
  DEFAULT_FOCUS_SETTINGS,
  endFocus,
  FOCUS_MAX_MS,
  FOCUS_MENU,
  type FocusActive,
  type FocusEventFact,
  type FocusPrompt,
  type FocusReservation,
  type FocusSettings,
  type FocusSource,
  type FocusState,
  type FocusStep,
  type FocusTarget,
  filterFocus,
  focusLabel,
  focusSummary,
  initialFocusState,
  isFocusTarget,
  nextEventEnd,
  promptActions,
  promptKey,
  promptMessage,
  promptText,
  reserveEvent,
  startManual,
  stepFocus,
} from "./focus/plan.ts";
export { fmtClock, fmtClock2, fmtDuration, fmtWait, prLabel, repoName } from "./format.ts";
export {
  aiItemSubject,
  type ReasonParts,
  reasonParts,
  turnSubject,
  withSubject,
} from "./glance/reason.ts";
export { MASK, redact, redactText } from "./glance/redact.ts";
export {
  formatTaskSubject,
  formatTaskTitle,
  type Locale,
  TASK_TITLE_KEYS,
  type TaskTitleKey,
  type TaskTitleParams,
} from "./i18n/task-title.ts";
// 型だけ（install.ts は node:fs を使うので値は export しない）
export type { InstallMode, InstallStatus } from "./install.ts";
export {
  AI_SHORT_SPAN_MS,
  AI_SPAN_GAP_MS,
  type AiLaneBox,
  type AiSpan,
  layoutAiLane,
  spansOf,
} from "./layout/ai-lane.ts";
export { clip, type LaneInput, type Overflow, type Placed, placeLanes } from "./layout/lanes.ts";
export { layoutMeLane, type MeLaneBox, type MeLaneItem } from "./layout/me-lane.ts";
export {
  clampPanelWidth,
  PANEL_MAIN_MIN,
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_LIMIT,
  PANEL_WIDTH_MIN,
  PANEL_WIDTH_STEP,
  panelWidthMax,
} from "./layout/panel-width.ts";
export {
  cleanupKind,
  isLimitStop,
  isStale,
  type LiveSections,
  liveSections,
  needsCleanup,
  processLive,
  runningKind,
  STALE_AFTER_MS,
  stoppedKind,
  UNKNOWN_PROCESS_MS,
} from "./live.ts";
export {
  type ParsedTask,
  parseDateInput,
  parseSnoozeTime,
  parseTask,
  type SnoozeTimeResult,
} from "./nlp/index.ts";
export {
  BATCH_MS,
  countedTurns,
  followUpSubject,
  initialNotifyState,
  isGrace,
  isLater,
  type LaterKind,
  laterBackAt,
  laterFollowUp,
  laterKind,
  laterRows,
  type Notice,
  type NoticeMessage,
  type NotifyContent,
  type NotifyState,
  noticeMessage,
  noticeWhere,
  planNotifications,
  primaryFollowUp,
  type QueueSummary,
  queueSummary,
  RESEND_MS,
  turnRows,
  visibleQueue,
  WHY_TEXT,
  type WhyKind,
  whyOf,
} from "./notify/plan.ts";
export { ONBOARDING_STEPS, type OnboardingStep, type OnboardingStepStatus } from "./onboarding.ts";
export {
  defaultOpenAction,
  OPEN_ACTIONS,
  OPEN_APP_DEFAULTS,
  OPEN_APP_IDS,
  openLandingShort,
  openLandingText,
  openMenu,
} from "./open.ts";
export { orderKeyAfter, orderKeyBefore, orderKeyBetween } from "./order.ts";
export {
  type CapacityInput,
  capacity,
  freeSlots,
  planWindow,
  UNESTIMATED_MS,
} from "./plan/capacity.ts";
export {
  blockDurationMs,
  busyOverlapMs,
  countsAsPlanned,
  DEFAULT_BLOCK_MIN,
  dayDiff,
  dropRange,
  FINE_SNAP_MIN,
  neighborsFor,
  plannedWith,
  resizeEnd,
  SNAP_MIN,
  selectRange,
  shiftByDays,
  snapMs,
} from "./plan/dnd.ts";
export { PLACE_MAX, placeCandidates } from "./plan/place-candidates.ts";
export {
  DEFAULT_PLANNED_SPAN,
  defaultPlannedHours,
  formatPlannedTime,
  type PlannedHours,
  type PlannedSpan,
  parsePlannedTime,
  plannedHoursValue,
  plannedOn,
  readPlannedHours,
  WEEKDAY_KEYS,
  type WeekdayKey,
} from "./plan/planned-hours.ts";
export {
  type DayRoom,
  type MoveSuggestion,
  type MoveTaskInput,
  suggestMoves,
} from "./plan/suggest-moves.ts";
export {
  renderDailyReport,
  renderDailyReportBody,
  reportAiName,
  reportAiResultText,
  reportAiWhere,
  reportCarryText,
  reportDateLabel,
  reportDidText,
  reportExpiredLine,
  reportHeadings,
  reportIdleByRepoLine,
  reportIdleLine,
  reportShortDate,
  reportTimeLine,
  reportTitle,
} from "./report/daily.ts";
export {
  renderSummarySection,
  type SummaryFailure,
  type SummaryTool,
  summaryCredit,
  summaryHeading,
  summaryToolCommand,
  withSummary,
} from "./report/summary.ts";
export { nextWeekday } from "./report/workday.ts";
export { matchesAll, matchRanges, matchScore, searchTokens } from "./search/match.ts";
export { uuidv7 } from "./uuid7.ts";
