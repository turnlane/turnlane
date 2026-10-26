/** 合成のトランスクリプト（本文は合成値。Claude Code 2.1 の形） */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ClaudeWriter {
  path: string;
  /** origin "task-notification" はバックグラウンドのタスク通知で始まるターン（initiator='system'） */
  human(
    at: number,
    opts?: { promptId?: string; origin?: "human" | "task-notification"; text?: string },
  ): string;
  /** ツール生成のタイトル（ai-title） */
  aiTitle(at: number, title: string): void;
  assistantEnd(at: number, text: string, opts?: { edits?: number; durationMs?: number }): void;
  prLink(at: number, repo: string, n: number): void;
  /** API エラーで終わったターン（isApiErrorMessage。error はエラーの種類） */
  apiError(at: number, error: string, opts?: { durationMs?: number }): void;
  /** AskUserQuestion の tool_use（未回答のまま止まる）。questions は入力（ダミー） */
  ask(at: number, questions?: { question: string; options: string[] }[]): string;
  /** ツールの呼び出し（結果はまだ無い。許可待ちの途中）。input はツールの引数（ダミー） */
  toolUse(at: number, name: string, input: Record<string, unknown>): string;
  /** ツールの結果（tool_result） */
  toolResult(at: number, toolUseId: string): void;
  /** AskUserQuestion への回答（tool_result。ターンは続く） */
  answer(at: number, toolUseId: string): void;
}

let uid = 0;

export function claudeTranscript(
  root: string,
  opts: { sid: string; cwd: string; branch: string; enc?: string },
): ClaudeWriter {
  const path = `${root}/projects/${opts.enc ?? opts.cwd.replaceAll(/[/.]/g, "-")}/${opts.sid}.jsonl`;
  mkdirSync(dirname(path), { recursive: true });
  const common = (at: number) => ({
    sessionId: opts.sid,
    uuid: `u-${++uid}`,
    timestamp: new Date(at).toISOString(),
    isSidechain: false,
    cwd: opts.cwd,
    gitBranch: opts.branch,
    version: "2.1.287",
    entrypoint: "cli",
  });
  const write = (o: object) => appendFileSync(path, `${JSON.stringify(o)}\n`);
  let prompt = "";
  return {
    path,
    human(at, o = {}) {
      prompt = o.promptId ?? `p-${++uid}`;
      write({
        ...common(at),
        type: "user",
        promptId: prompt,
        origin: { kind: o.origin ?? "human" },
        promptSource: "typed",
        message: { role: "user", content: o.text ?? "(prompt)" },
      });
      return prompt;
    },
    assistantEnd(at, text, o = {}) {
      for (let i = 0; i < (o.edits ?? 0); i++) {
        write({
          ...common(at - 1000),
          type: "assistant",
          message: {
            id: `m-${++uid}`,
            model: "claude-x",
            stop_reason: "tool_use",
            usage: { input_tokens: 1, output_tokens: 1 },
            content: [{ type: "tool_use", id: `tu-${uid}`, name: "Edit" }],
          },
        });
      }
      write({
        ...common(at),
        type: "assistant",
        message: {
          id: `m-${++uid}`,
          model: "claude-x",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "text", text }],
        },
      });
      write({
        ...common(at + 100),
        type: "system",
        subtype: "turn_duration",
        durationMs: o.durationMs ?? 60_000,
        isMeta: false,
        promptId: prompt,
      });
    },
    apiError(at, error, o = {}) {
      write({
        ...common(at),
        type: "assistant",
        isApiErrorMessage: true,
        error,
        message: {
          id: `m-${++uid}`,
          model: "<synthetic>",
          stop_reason: "stop_sequence",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: "text", text: "API Error" }],
        },
      });
      write({
        ...common(at + 100),
        type: "system",
        subtype: "turn_duration",
        durationMs: o.durationMs ?? 60_000,
        isMeta: false,
        promptId: prompt,
      });
    },
    ask(at, questions) {
      const id = `tu-ask-${++uid}`;
      const input = questions
        ? {
            questions: questions.map((q) => ({
              question: q.question,
              header: "Q",
              multiSelect: false,
              options: q.options.map((label) => ({ label, description: "(description)" })),
            })),
          }
        : undefined;
      write({
        ...common(at),
        type: "assistant",
        message: {
          id: `m-${++uid}`,
          model: "claude-x",
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "tool_use", id, name: "AskUserQuestion", ...(input ? { input } : {}) }],
        },
      });
      return id;
    },
    toolUse(at, name, input) {
      const id = `tu-${++uid}`;
      write({
        ...common(at),
        type: "assistant",
        message: {
          id: `m-${++uid}`,
          model: "claude-x",
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "tool_use", id, name, input }],
        },
      });
      return id;
    },
    toolResult(at, toolUseId) {
      write({
        ...common(at),
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUseId, content: "(result)" }],
        },
      });
    },
    answer(at, toolUseId) {
      write({
        ...common(at),
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId }] },
      });
    },
    aiTitle(_at, title) {
      write({ type: "ai-title", sessionId: opts.sid, aiTitle: title });
    },
    prLink(at, repo, n) {
      write({
        type: "pr-link",
        sessionId: opts.sid,
        timestamp: new Date(at).toISOString(),
        prNumber: n,
        prRepository: repo,
        prUrl: `https://github.com/${repo}/pull/${n}`,
      });
    },
  };
}

export interface SubagentWriter {
  path: string;
  /** サブエージェントの活動（ツールの呼び出し。結果はまだ無い） */
  activity(at: number): void;
  /** 最後の応答（stop_reason == "end_turn"）。サブエージェントが終わる */
  end(at: number): void;
}

/**
 * 合成のサブエージェントのトランスクリプト（`<親>/subagents/agent-<id>.jsonl` と `.meta.json`）。parent は親の
 * claudeTranscript の path。最初の行（親からの依頼）を start に書く
 */
export function claudeSubagent(
  parent: string,
  opts: { sid: string; agentId: string; cwd: string; branch: string; start: number },
): SubagentWriter {
  const dir = `${parent.replace(/\.jsonl$/, "")}/subagents`;
  const path = `${dir}/agent-${opts.agentId}.jsonl`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}/agent-${opts.agentId}.meta.json`,
    JSON.stringify({
      agentType: "general-purpose",
      description: "(task)",
      toolUseId: "tu-x",
      spawnDepth: 1,
    }),
  );
  const common = (at: number) => ({
    sessionId: opts.sid,
    uuid: `u-${++uid}`,
    timestamp: new Date(at).toISOString(),
    isSidechain: true,
    cwd: opts.cwd,
    gitBranch: opts.branch,
    version: "2.1.287",
    entrypoint: "cli",
  });
  const write = (o: object) => appendFileSync(path, `${JSON.stringify(o)}\n`);
  write({ ...common(opts.start), type: "user", message: { role: "user", content: "(task)" } });
  const assistant = (at: number, stop: string) =>
    write({
      ...common(at),
      type: "assistant",
      message: {
        id: `m-${++uid}`,
        model: "claude-x",
        stop_reason: stop,
        usage: { input_tokens: 1, output_tokens: 1 },
        content:
          stop === "end_turn"
            ? [{ type: "text", text: "(done)" }]
            : [{ type: "tool_use", id: `tu-${uid}`, name: "Bash", input: { command: "(cmd)" } }],
      },
    });
  return {
    path,
    activity: (at) => assistant(at, "tool_use"),
    end: (at) => assistant(at, "end_turn"),
  };
}

export interface CodexWriter {
  path: string;
  /** 1ターン（人の入力 → AI の応答）。text が「?」で終われば質問で終わったターン */
  turn(start: number, end: number, text: string): void;
  /** ターンの始まりだけを書く（終わりは返した関数で後から書く。取り込みが遅れて終わりが後から来る場合） */
  begin(start: number): (end: number, text: string) => void;
  /** ツールが付けた会話の題名（session_index.jsonl の thread_name） */
  threadName(at: number, name: string): void;
}

/** 合成の Codex の rollout（本文は合成値。0.15x の形）。root は ~/.codex */
export function codexRollout(
  root: string,
  opts: { sid: string; cwd: string; at: number; originator?: string },
): CodexWriter {
  const d = new Date(opts.at);
  const ymd = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()].map((n) =>
    String(n).padStart(2, "0"),
  );
  const path = `${root}/sessions/${ymd.join("/")}/rollout-${ymd.join("-")}T00-00-00-${opts.sid}.jsonl`;
  mkdirSync(dirname(path), { recursive: true });
  const iso = (t: number) => new Date(t).toISOString();
  const write = (o: object) => appendFileSync(path, `${JSON.stringify(o)}\n`);
  write({
    type: "session_meta",
    timestamp: iso(opts.at),
    payload: {
      id: opts.sid,
      timestamp: iso(opts.at),
      cwd: opts.cwd,
      originator: opts.originator ?? "Codex Desktop",
      cli_version: "0.153.4",
      source: "vscode",
    },
  });
  return {
    path,
    turn(start, end, text) {
      this.begin(start)(end, text);
    },
    begin(start) {
      const turn_id = `t-${++uid}`;
      write({
        type: "event_msg",
        timestamp: iso(start),
        payload: { type: "task_started", turn_id, started_at: Math.floor(start / 1000) },
      });
      write({ type: "turn_context", timestamp: iso(start), payload: { turn_id, cwd: opts.cwd } });
      write({
        type: "event_msg",
        timestamp: iso(start + 100),
        payload: { type: "item_completed", turn_id, item: { type: "UserMessage" } },
      });
      return (end, text) =>
        write({
          type: "event_msg",
          timestamp: iso(end),
          payload: {
            type: "task_complete",
            turn_id,
            started_at: Math.floor(start / 1000),
            completed_at: Math.floor(end / 1000),
            duration_ms: end - start,
            last_agent_message: text,
          },
        });
    },
    threadName(at, name) {
      appendFileSync(
        `${root}/session_index.jsonl`,
        `${JSON.stringify({ id: opts.sid, thread_name: name, updated_at: iso(at) })}\n`,
      );
    },
  };
}
