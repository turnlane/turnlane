/**
 * NormalizedEvent の列を「シンクが DB に反映した結果」と同じ規則で畳み込む（テストキットと検証用）。
 * シンクの規則（phase0-plan 3.2）: 自然キーで代入（upsert）。session_seen の at は started_at = min、
 * last_activity_at = max。artifact の at は first_seen_at = min。hook は (spool.file, spool.offset) で一意。
 */
import type { NormalizedEvent, SessionSeenEvent } from "./types.ts";

export interface ReducedState {
  sessions: Record<
    string,
    Omit<SessionSeenEvent, "kind" | "at"> & { firstAt: number; lastAt: number }
  >;
  turns: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  live: Record<string, unknown>;
  hooks: Record<string, unknown>;
  limits: Record<string, unknown>;
}

const sref = (r: { tool: string; externalId: string }) => `${r.tool}:${r.externalId}`;

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function reduceEvents(events: readonly NormalizedEvent[]): ReducedState {
  const st: ReducedState = {
    sessions: {},
    turns: {},
    artifacts: {},
    live: {},
    hooks: {},
    limits: {},
  };
  for (const e of events) {
    switch (e.kind) {
      case "session_seen": {
        const k = sref(e.ref);
        const prev = st.sessions[k];
        const { kind: _k, at, startedAt, ...rest } = e;
        const first = Math.min(prev?.firstAt ?? Number.POSITIVE_INFINITY, startedAt ?? at, at);
        st.sessions[k] = {
          ...(prev ?? {}),
          ...defined(rest),
          ref: e.ref,
          firstAt: first,
          lastAt: Math.max(prev?.lastAt ?? 0, at),
        } as ReducedState["sessions"][string];
        break;
      }
      case "turn": {
        const { kind: _k, ...rest } = e;
        st.turns[`${sref(e.ref)}#${e.turnKey}`] = rest;
        break;
      }
      case "artifact": {
        const key =
          e.artifact.kind === "pr"
            ? `pr:${e.artifact.repo}#${e.artifact.number}`
            : `commit:${e.artifact.sha}`;
        const prev = st.artifacts[key] as { at: number } | undefined;
        st.artifacts[key] = { ...e, at: Math.min(prev?.at ?? e.at, e.at) };
        break;
      }
      case "live_status": {
        const { kind: _k, ...rest } = e;
        st.live[sref(e.ref)] = rest;
        break;
      }
      case "hook": {
        const { kind: _k, ...rest } = e;
        st.hooks[`${e.spool.file}:${e.spool.offset}`] = rest;
        break;
      }
      case "claude_limits": {
        const { kind: _k, ...rest } = e;
        st.limits[e.account] = rest;
        break;
      }
    }
  }
  return st;
}
