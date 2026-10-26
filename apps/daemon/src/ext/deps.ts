/**
 * 拡張に渡す部品（ExtDeps。ADR 0015）の組み立て。本体の各部品の薄い包み
 */
import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { MetaOnlyLogger } from "@turnlane/collectors";
import {
  type Clock,
  type ExtraConfigSchemas,
  getSetting,
  isWorkday,
  type MutateCtx,
  putSetting,
  readSettings,
  validateConfig,
  type WorkdayRule,
} from "@turnlane/core";
import type { Interval, QueueItem } from "@turnlane/core/api";
import type { AiSystem } from "../ai.ts";
import { OpError } from "../derive/ops.ts";
import type { SseHub } from "../http/sse.ts";
import type { LaunchService } from "../launch/service.ts";
import type { ClaudeLimitsStore } from "../limits/claude.ts";
import type { NotifyHolds } from "../notify/runner.ts";
import { busyIntervals } from "../planner/day.ts";
import type { TaskService } from "../planner/tasks.ts";
import { lastPresentBefore, presenceIn } from "../presence/service.ts";
import { childEnv, runSummaryCli } from "../summary/cli.ts";
import type { SummaryService } from "../summary/service.ts";
import { extCalendarEvents } from "./calendar.ts";
import { extDataDir } from "./host.ts";
import type { KeepAwake, PowerState } from "./power.ts";
import type { ExtDeps } from "./types.ts";

export interface ExtParts {
  sqlite: Database;
  mutate: MutateCtx;
  clock: Clock;
  logger: MetaOnlyLogger;
  dataDir: string;
  /** 日報の要約と同じ作業ディレクトリ（取り込みから除外済み） */
  oneShotDir: string;
  extConfig: ExtraConfigSchemas;
  hub: SseHub;
  tasks: TaskService;
  day: (date: string) => { freeSlots: Interval[] };
  /** 稼働曜日と祝日（カレンダーが無ければ設定の稼働曜日だけ） */
  workdays: () => WorkdayRule;
  ai: AiSystem | null;
  launch: LaunchService | null;
  summary: SummaryService | null;
  holds: NotifyHolds;
  power: KeepAwake;
  /** 電源とふたの状態を読む */
  powerState: () => Promise<PowerState>;
  /** Claude の利用枠（statusLine の受け口が送った値） */
  limits: ClaudeLimitsStore;
  /** 利用者のホーム（limits.claude の既定のアカウント `~/.claude`） */
  home: string;
}

const ONE_SHOT_TIMEOUT_MS = 90_000;

export function createExtDeps(p: ExtParts, id: string): ExtDeps {
  const own = `ext.${id}.`;
  // 消したもの・無いものは null（拡張に OpError を投げない）
  const live = <T>(f: () => T): T | null => {
    try {
      return f();
    } catch (e) {
      if (e instanceof OpError && e.status === 404) return null;
      throw e;
    }
  };
  const liveBlock = (blockId: string) =>
    p.sqlite
      .query<{ id: string }, [string]>(
        "SELECT id FROM time_block WHERE id = ? AND deleted_at IS NULL",
      )
      .get(blockId) !== null;
  const launch = () => {
    if (!p.launch) throw new OpError(409, "launch_unavailable");
    return p.launch;
  };
  return {
    id,
    sqlite: p.sqlite,
    mutate: p.mutate,
    clock: p.clock,
    logger: p.logger,
    dataDir: extDataDir(p.dataDir, id),
    settings: {
      get: <T>(key: string) => getSetting<T>(p.mutate.db, key),
      set(key, value) {
        if (!key.startsWith(own) || !Object.hasOwn(p.extConfig, key))
          throw new OpError(404, "unknown_key");
        const v = validateConfig(key, value, p.extConfig);
        if (!v.ok) throw new OpError(400, `invalid_value: ${v.error}`);
        putSetting(p.mutate, key, v.value);
        p.hub.publish("settings", {});
        return v.value;
      },
      core: () => readSettings(p.mutate.db),
    },
    events: {
      publish: () => p.hub.publish("ext", { exts: [id] }),
      subscribe: (l) => p.hub.subscribe((m) => l(m.type)),
    },
    tasks: {
      create: (input) => p.tasks.create(input).task,
      get: (taskId) => {
        try {
          return p.tasks.detail(taskId).task;
        } catch {
          return null;
        }
      },
      byExternal: (source, externalId) => p.tasks.byExternal(source, externalId),
      complete: (taskId) => {
        p.tasks.complete(taskId);
      },
      reopen: (taskId, o) =>
        live(() => {
          const t = p.tasks.detail(taskId).task;
          if (t.status !== "done") return t;
          return (
            p.tasks.uncomplete(taskId, {
              ...(o?.followUps?.length ? { reopenFollowUps: [...o.followUps] } : {}),
            }).task ?? null
          );
        }),
      update: (taskId, patch) =>
        live(() => {
          const { date, ...rest } = patch;
          let task = p.tasks.detail(taskId).task;
          if (Object.keys(rest).length > 0) task = p.tasks.patch(taskId, rest).task ?? task;
          if (date !== undefined && date !== task.scheduledDate)
            task = p.tasks.move(taskId, { date }).task ?? task;
          return task;
        }),
      remove: (taskId) => {
        live(() => p.tasks.remove(taskId));
      },
      blocks: (taskId) => live(() => p.tasks.detail(taskId).blocks) ?? [],
    },
    timeBlocks: {
      create: (b) => {
        const r = p.tasks.createTimeBlock(b).timeBlock;
        if (!r) throw new OpError(404, "not_found");
        return r;
      },
      update: (blockId, b) =>
        liveBlock(blockId) ? (p.tasks.patchTimeBlock(blockId, b).timeBlock ?? null) : null,
      remove: (blockId) => {
        if (liveBlock(blockId)) p.tasks.deleteTimeBlock(blockId);
      },
    },
    queue: (): QueueItem[] => p.ai?.deps.queue() ?? [],
    launcher: {
      available: () => p.launch !== null,
      options: (taskId) => launch().options(taskId),
      launch: ((input, trigger, o) =>
        o?.unattended
          ? launch().launchUnattended(input, trigger)
          : launch().launch(input, trigger)) as ExtDeps["launcher"]["launch"],
      waitsWhileLocked: () => p.launch?.unattendedWaitsWhileLocked() ?? true,
      folderTrust: (o) => p.launch?.folderTrust(o) ?? "unknown",
      openForTrust: (o) => launch().openForTrust(o),
      discard: (launchId) => launch().cleanup(launchId, true),
    },
    presence: {
      // 在席（D-139）: 保存は入力のあった区間。T（presence.tail_min）は今の設定で足して渡す
      spans: (from, to) =>
        presenceIn(p.sqlite, from, to, readSettings(p.mutate.db).presenceTailMs).map(([s, e]) => ({
          start: s,
          end: e,
        })),
      lastActiveAt: () =>
        lastPresentBefore(
          p.sqlite,
          Number.POSITIVE_INFINITY,
          readSettings(p.mutate.db).presenceTailMs,
        ),
    },
    calendar: {
      busy: (from, to) => busyIntervals(p.sqlite, from, to),
      freeSlots: (date) => p.day(date).freeSlots,
      isWorkday: (date) => isWorkday(date, p.workdays()),
      events: (from, to) => extCalendarEvents(p.sqlite, from, to),
    },
    notify: { hold: (filter, onHeld) => p.holds.add(filter, onHeld) },
    review: {
      check: (launchId) => launch().check({ launchId }),
      runTests: (launchId) => {
        launch().runTest(launchId);
      },
      diff: (launchId, o) => launch().diff(launchId, o),
    },
    ai: {
      async runOneShot(o) {
        if (!p.summary) return { ok: false, failure: { kind: "not_found" } };
        const d = await p.summary.detect(o.tool);
        if (!d.bin) return { ok: false, failure: { kind: "not_found" } };
        mkdirSync(p.oneShotDir, { recursive: true, mode: 0o700 });
        const env = childEnv(d.bin, {});
        // Claude のアカウント: ~/.claude 以外は CLAUDE_CONFIG_DIR、~/.claude ならデーモンの環境の値を消す（起動と同じ）
        if (o.tool === "claude_code" && o.claudeAccount?.startsWith("/")) {
          const main = `${p.home.replace(/\/+$/, "")}/.claude`;
          if (o.claudeAccount.replace(/\/+$/, "") === main) delete env.CLAUDE_CONFIG_DIR;
          else env.CLAUDE_CONFIG_DIR = o.claudeAccount;
        }
        return runSummaryCli({
          tool: o.tool,
          bin: d.bin,
          flags: d.flags,
          workDir: p.oneShotDir,
          input: o.input,
          timeoutMs: o.timeoutMs ?? ONE_SHOT_TIMEOUT_MS,
          env,
          ...(o.schema ? { schema: o.schema } : {}),
        });
      },
    },
    power: {
      keepAwake: (reason) => p.power.keepAwake(`${id}:${reason}`),
      state: () => p.powerState(),
    },
    limits: {
      claude: (account) => p.limits.get(account ?? `${p.home.replace(/\/+$/, "")}/.claude`),
    },
  };
}
