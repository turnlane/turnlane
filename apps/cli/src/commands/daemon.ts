/**
 * turnlane daemon start|stop|restart|status|logs [-f]（phase0-plan 3.6）。launchctl の薄いラッパ。
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { DAEMON_LABEL } from "@turnlane/core";
import { fetchHealth, waitForHealth } from "../client.ts";
import { type CliEnv, plistPath } from "../env.ts";
import { lang, tr } from "../lang.ts";
import { bootoutAndWait, bootstrapWithRetry } from "../launchctl.ts";

function requireInstalled(env: CliEnv): boolean {
  if (existsSync(plistPath(env.paths))) return true;
  env.err(
    tr(
      "Turnlane's background service (turnlaned) isn't set up. Run turnlane self-install first.",
      "Turnlane のバックグラウンド（turnlaned）が登録されていません。先に turnlane self-install を実行してください。",
    ),
  );
  return false;
}

function formatUptime(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const ja = lang() === "ja";
  if (m < 60) return ja ? `${m}分` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return ja ? `${h}時間${m % 60}分` : `${h}h ${m % 60}m`;
  return ja ? `${Math.floor(h / 24)}日${h % 24}時間` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

// stop 直後の start は launchd の解体待ちで bootstrap が error 5 になることがある（再試行で吸収する）
const START_RETRY = { retryHint: "turnlane daemon start" };

export async function daemonStart(env: CliEnv, waitMs = 10_000): Promise<number> {
  if (!requireInstalled(env)) return 1;
  if (env.launchctl.print(DAEMON_LABEL).loaded) env.launchctl.kickstart(DAEMON_LABEL);
  else bootstrapWithRetry(env.launchctl, plistPath(env.paths), DAEMON_LABEL, START_RETRY);
  const h = await waitForHealth(env.paths, waitMs);
  if (!h) {
    env.err(
      tr(
        "Started, but it isn't responding. Check turnlane daemon logs.",
        "起動しましたが応答がありません。turnlane daemon logs を確認してください。",
      ),
    );
    return 1;
  }
  env.out(
    tr(
      `turnlaned: running (pid ${h.pid}, http://127.0.0.1:${h.port}/)`,
      `turnlaned: 稼働中（pid ${h.pid}、http://127.0.0.1:${h.port}/）`,
    ),
  );
  return 0;
}

export function daemonStop(env: CliEnv): number {
  if (!env.launchctl.print(DAEMON_LABEL).loaded) {
    env.out(tr("turnlaned: stopped", "turnlaned: 停止中"));
    return 0;
  }
  // 直後の turnlane daemon start が launchd の解体待ちで失敗しないよう、登録が外れるまで待つ
  bootoutAndWait(env.launchctl, DAEMON_LABEL);
  env.out(
    tr(
      "turnlaned: stopped (it starts again at your next login; to start it now, run turnlane daemon start)",
      "turnlaned: 停止しました（次回ログイン時に自動で起動します。今すぐ起動するには turnlane daemon start）",
    ),
  );
  return 0;
}

export async function daemonRestart(env: CliEnv, waitMs = 10_000): Promise<number> {
  if (!requireInstalled(env)) return 1;
  if (env.launchctl.print(DAEMON_LABEL).loaded)
    env.launchctl.kickstart(DAEMON_LABEL, { kill: true });
  else bootstrapWithRetry(env.launchctl, plistPath(env.paths), DAEMON_LABEL, START_RETRY);
  const h = await waitForHealth(env.paths, waitMs);
  if (!h) {
    env.err(
      tr(
        "Restarted, but it isn't responding. Check turnlane daemon logs.",
        "再起動しましたが応答がありません。turnlane daemon logs を確認してください。",
      ),
    );
    return 1;
  }
  env.out(
    tr(
      `turnlaned: running (pid ${h.pid}, http://127.0.0.1:${h.port}/)`,
      `turnlaned: 稼働中（pid ${h.pid}、http://127.0.0.1:${h.port}/）`,
    ),
  );
  return 0;
}

/** 稼働中なら 0、停止・応答なしなら 3 を返す */
export async function daemonStatus(env: CliEnv, json = false): Promise<number> {
  const svc = env.launchctl.print(DAEMON_LABEL);
  const installed = existsSync(plistPath(env.paths));
  const h = await fetchHealth(env.paths);
  if (json) {
    env.out(JSON.stringify({ running: h !== null, launchd: { installed, ...svc }, health: h }));
    return h ? 0 : 3;
  }
  if (h) {
    env.out(
      tr(
        `turnlaned: running (pid ${h.pid}, http://127.0.0.1:${h.port}/, ${h.version}, up ${formatUptime(h.uptimeMs)})`,
        `turnlaned: 稼働中（pid ${h.pid}、http://127.0.0.1:${h.port}/、${h.version}、稼働 ${formatUptime(h.uptimeMs)}）`,
      ),
    );
    env.out(
      tr(
        `DB: schema ${h.db.userVersion}/${h.db.schemaVersion}, latest backup ${h.backup.lastDate ?? "none"}`,
        `DB: スキーマ ${h.db.userVersion}/${h.db.schemaVersion}、最新のバックアップ ${h.backup.lastDate ?? "なし"}`,
      ),
    );
  } else {
    env.out(tr("turnlaned: stopped (no response)", "turnlaned: 停止中（応答なし）"));
  }
  if (!installed)
    env.out(
      tr(
        "launchd: not registered (register with turnlane self-install)",
        "launchd: 未登録（turnlane self-install で登録）",
      ),
    );
  else if (!svc.loaded)
    env.out(
      tr(
        `launchd: unloaded (${DAEMON_LABEL}; start with turnlane daemon start)`,
        `launchd: 登録解除中（${DAEMON_LABEL}。turnlane daemon start で起動）`,
      ),
    );
  else {
    const exit =
      svc.lastExitCode !== undefined
        ? tr(`, last exit code ${svc.lastExitCode}`, `、前回の終了コード ${svc.lastExitCode}`)
        : "";
    env.out(
      tr(
        `launchd: registered (${DAEMON_LABEL}, ${svc.state ?? "unknown"}${exit})`,
        `launchd: 登録済み（${DAEMON_LABEL}、${svc.state ?? "unknown"}${exit}）`,
      ),
    );
  }
  return h ? 0 : 3;
}

function tailLines(path: string, n: number): string[] {
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-n);
}

export async function daemonLogs(
  env: CliEnv,
  opts: { follow?: boolean; lines?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const path = env.paths.logPath;
  if (!existsSync(path)) {
    env.err(tr(`No log yet: ${path}`, `ログがまだありません: ${path}`));
    return opts.follow ? 0 : 1;
  }
  for (const l of tailLines(path, opts.lines ?? 50)) env.out(l);
  if (!opts.follow) return 0;
  let pos = statSync(path).size;
  let rest = "";
  while (!opts.signal?.aborted) {
    await Bun.sleep(500);
    if (!existsSync(path)) continue;
    const size = statSync(path).size;
    if (size < pos) pos = 0; // 回転した
    if (size === pos) continue;
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(size - pos);
    readSync(fd, buf, 0, buf.length, pos);
    closeSync(fd);
    pos = size;
    const text = rest + buf.toString("utf8");
    const parts = text.split("\n");
    rest = parts.pop() ?? "";
    for (const l of parts) env.out(l);
  }
  return 0;
}
