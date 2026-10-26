// S4 spike: `dl hook` equivalent. Read hook JSON from stdin, keep allowlisted
// keys only, append one line to the spool with a single O_APPEND write, exit 0.
// Must never fail the calling tool: all errors are swallowed.
// Not production code.
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";

const ALLOW = [
  "hook_event_name",
  "session_id",
  "cwd",
  "transcript_path",
  "permission_mode",
  "notification_type",
  "stop_hook_active",
] as const;
const MAX_LINE = 4000; // < 4KB for atomic append

export async function runHook(args: string[]) {
  try {
    const toolIdx = args.indexOf("--tool");
    const tool = toolIdx >= 0 ? args[toolIdx + 1] : "claude";
    const dir = process.env.DL_SPOOL_DIR ?? "./spool";
    const raw = await Bun.stdin.text();
    const input = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, unknown> = { v: 1, tool, recv_at: Date.now() };
    for (const k of ALLOW) {
      const v = input[k];
      if (v !== undefined && (typeof v !== "string" || v.length < 1024)) out[k] = v;
    }
    let line = `${JSON.stringify(out)}\n`;
    if (Buffer.byteLength(line) > MAX_LINE) {
      line = `${JSON.stringify({ v: 1, tool, recv_at: out.recv_at, hook_event_name: out.hook_event_name, truncated: true })}\n`;
    }
    let fd: number;
    try {
      fd = openSync(`${dir}/hooks.jsonl`, "a", 0o600);
    } catch {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      fd = openSync(`${dir}/hooks.jsonl`, "a", 0o600);
    }
    writeSync(fd, line);
    closeSync(fd);
  } catch {
    // swallow: hooks must not break the host tool
  }
  process.exit(0);
}

