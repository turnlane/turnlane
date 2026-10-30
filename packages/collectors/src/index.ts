// @turnlane/collectors の公開 IF の入口（phase0-plan 3.1.1）。
// ここから export したものだけが公開 IF。それ以外のファイルは内部扱い。
// このパッケージは他の @turnlane/* / Drizzle / Hono / zod / DB を import しない（biome.json で検査）。

export { REPORT_RATE_PER_MIN, REPORT_TOOL } from "./adapters/report/index.ts";
export { pickAllowed } from "./allowlist.ts";
export { asksBack } from "./asks-back.ts";
export {
  endsWithQuestion,
  isClosingQuestion,
  questionExcerpt,
  textTraits,
} from "./closing-question.ts";
export { BODY_KEYS, defineAdapter, satisfiesRange, TOOL_ID_RE, toolId } from "./define.ts";
export {
  type ClaudeGlanceHints,
  claudeGlanceHints,
  claudeLastText,
  claudeToolResultIds,
  claudeToolUse,
  claudeUserText,
  findClaudeTranscript,
  type GlanceReadFail,
  MAX_LINE_BYTES,
  readJsonLineAt,
  readTailRecords,
} from "./glance.ts";
export {
  CODEX_SCRATCH_DIR,
  trimClaudeProjectDir,
  trimClaudeProjectPath,
  trimCodexScratchCwd,
} from "./hook-allowlist.ts";
export { isForbiddenFile } from "./io.ts";
export {
  claudeLastReply,
  claudeTurnEnd,
  codexLastReply,
  codexTurnEnd,
  lastPromptMark,
} from "./last-reply.ts";
export {
  errorFields,
  type LogFields,
  type LogLevel,
  type LogValue,
  META_MAX_LENGTH,
  type MetaOnlyLogger,
  type MetaString,
  meta,
  nullLogger,
  safeEventName,
} from "./logger.ts";
export { PROMPT_SUBJECT_MAX, promptSubject, promptText, promptTraits } from "./prompt-traits.ts";
export { type JsonlChunk, type JsonlLine, readJsonlIncremental } from "./readers/jsonl.ts";
export { type ReducedState, reduceEvents } from "./reduce.ts";
export { adapterFor, builtinAdapters } from "./registry.ts";
export {
  fromReportSpoolLine,
  isOpenableReportUrl,
  parseReport,
  REPORT_ENTRYPOINT,
  REPORT_LIMITS,
  REPORT_SOURCE_RE,
  REPORT_STATES,
  RESERVED_REPORT_SOURCES,
  type ReportInput,
  type ReportParse,
  type ReportSpoolLine,
  type ReportState,
  reportSpoolName,
  reportSpoolText,
  reportText,
  toReportSpoolLine,
} from "./report.ts";
export { cleanSubjectLine, cleanTitle, stripPastedBlocks, TITLE_ACKS, TITLE_MAX } from "./title.ts";
export {
  ADAPTER_API_VERSION,
  type AdapterCapabilities,
  type AdapterTiming,
  type ArtifactEvent,
  type ClaudeLimitsEvent,
  type ClaudeLimitWindowFact,
  type Cursor,
  type DetectEnv,
  type DetectedRoot,
  type EndedWith,
  type HookEvent,
  type HookSpec,
  type Initiator,
  type LiveProbe,
  type LiveStatusEvent,
  type NormalizedEvent,
  type ReadContext,
  type ReadResult,
  type ReadStats,
  type ReportWait,
  type SessionRef,
  type SessionSeenEvent,
  type SourceAdapter,
  type StreamSpec,
  type ToolId,
  type TurnEvent,
  type TurnStatus,
  type WatchSpec,
} from "./types.ts";
