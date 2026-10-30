// バイナリに埋め込むマイグレーションの一覧（M0-8）。新しい SQL を生成したらここに1行足す。
// 順序は連番どおり。適用は ../migrate.ts。
import type { Migration } from "../migrate.ts";
import m0000 from "./0000_init.sql" with { type: "text" };
import m0001 from "./0001_work_item_daily_view.sql" with { type: "text" };
import m0002 from "./0002_m1_ingestion.sql" with { type: "text" };
import m0003 from "./0003_d045_idle_titles.sql" with { type: "text" };
import m0004 from "./0004_d051_scheduled_wait.sql" with { type: "text" };
import m0005 from "./0005_m3_3_own_timeblock.sql" with { type: "text" };
import m0006 from "./0006_m4_6_ai_summary.sql" with { type: "text" };
import m0007 from "./0007_d093_events.sql" with { type: "text" };
import m0008 from "./0008_d097_meeting_link.sql" with { type: "text" };
import m0009 from "./0009_d105_presence.sql" with { type: "text" };
import m0010 from "./0010_d107_ai_launch.sql" with { type: "text" };
import m0011 from "./0011_d125_calendar_color.sql" with { type: "text" };
import m0012 from "./0012_d135_scratch.sql" with { type: "text" };
import m0013 from "./0013_d136_claude_scratch_paths.sql" with { type: "text" };
import m0014 from "./0014_d139_presence_raw.sql" with { type: "text" };
import m0015 from "./0015_claude_limit.sql" with { type: "text" };
import m0016 from "./0016_launch_exit.sql" with { type: "text" };
import m0017 from "./0017_d218_stored_detail.sql" with { type: "text" };
import m0018 from "./0018_d238_term_handle.sql" with { type: "text" };
import m0019 from "./0019_subagent_hook.sql" with { type: "text" };
import m0020 from "./0020_quota_horizon.sql" with { type: "text" };
import m0021 from "./0021_returned_follow_up.sql" with { type: "text" };

export const migrations: readonly Migration[] = [
  { id: "0000_init", sql: m0000 },
  { id: "0001_work_item_daily_view", sql: m0001 },
  { id: "0002_m1_ingestion", sql: m0002 },
  { id: "0003_d045_idle_titles", sql: m0003 },
  { id: "0004_d051_scheduled_wait", sql: m0004 },
  { id: "0005_m3_3_own_timeblock", sql: m0005 },
  { id: "0006_m4_6_ai_summary", sql: m0006 },
  { id: "0007_d093_events", sql: m0007 },
  { id: "0008_d097_meeting_link", sql: m0008 },
  { id: "0009_d105_presence", sql: m0009 },
  { id: "0010_d107_ai_launch", sql: m0010 },
  { id: "0011_d125_calendar_color", sql: m0011 },
  { id: "0012_d135_scratch", sql: m0012 },
  { id: "0013_d136_claude_scratch_paths", sql: m0013 },
  { id: "0014_d139_presence_raw", sql: m0014 },
  { id: "0015_claude_limit", sql: m0015 },
  { id: "0016_launch_exit", sql: m0016 },
  { id: "0017_d218_stored_detail", sql: m0017 },
  { id: "0018_d238_term_handle", sql: m0018 },
  { id: "0019_subagent_hook", sql: m0019 },
  { id: "0020_quota_horizon", sql: m0020 },
  { id: "0021_returned_follow_up", sql: m0021 },
];

/** 現在のビルドのスキーマ番号（PRAGMA user_version に入る値）。エクスポートのヘッダにも使う */
export const SCHEMA_VERSION = migrations.length;
