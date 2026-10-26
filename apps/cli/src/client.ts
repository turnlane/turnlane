import { baseUrl, DAEMON_LABEL, readToken, type TurnlanePaths } from "@turnlane/core";
import type { AppType, HealthReport } from "@turnlane/daemon";
import { hc } from "hono/client";
import type { Launchctl } from "./launchctl.ts";

/** デーモンへの型付きクライアント（hc<AppType>、Bearer トークン） */
export function daemonClient(paths: TurnlanePaths, token = readToken(paths.tokenPath)) {
  return hc<AppType>(baseUrl(paths.port), {
    // x-turnlane-client: cli は本人の「操作」として数える（phase0-plan 3.3.1。MCP は数えない）
    headers: { authorization: `Bearer ${token}`, "x-turnlane-client": "cli" },
  });
}

/** health を取る。デーモンが動いていない・トークンが無いときは null */
export async function fetchHealth(
  paths: TurnlanePaths,
  timeoutMs = 1500,
): Promise<HealthReport | null> {
  try {
    const client = daemonClient(paths);
    const res = await client.api.health.$get(undefined, {
      init: { signal: AbortSignal.timeout(timeoutMs) },
    });
    if (!res.ok) return null;
    return (await res.json()) as HealthReport;
  } catch {
    return null;
  }
}

export async function waitForHealth(
  paths: TurnlanePaths,
  timeoutMs = 10_000,
): Promise<HealthReport | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const h = await fetchHealth(paths, 1000);
    if (h) return h;
    await Bun.sleep(200);
  }
  return null;
}

/** 「動いていません」と言う前に待つ長さ（launchd に登録されているとき） */
export const REGISTERED_WAIT_MS = 5_000;

/**
 * デーモンの health を取る（命令の前の稼働確認）。1 回で返らず、launchd に dev.turnlane.daemon が登録されていれば、
 * 起動の直後（取り込みの読み直しなど）で応答が遅れているだけのことがあるので、命令の始めから最長 waitMs まで待つ。
 * 登録が無ければすぐ null（動いていない）。turnlane hook はこれを使わない（起動の時間を保つ）
 */
export async function daemonHealth(
  env: { paths: TurnlanePaths; launchctl: Launchctl },
  waitMs = REGISTERED_WAIT_MS,
): Promise<HealthReport | null> {
  const until = Date.now() + waitMs;
  const h = await fetchHealth(env.paths);
  if (h) return h;
  let registered = false;
  try {
    registered = env.launchctl.print(DAEMON_LABEL).loaded;
  } catch {}
  if (!registered) return null;
  const rest = until - Date.now();
  return rest > 0 ? waitForHealth(env.paths, rest) : null;
}

/** 型付きクライアントでは扱いにくい呼び出し（JSON の body・クエリ）用。Bearer と x-turnlane-client: cli を付ける */
export async function callApi<T>(
  paths: TurnlanePaths,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(`${baseUrl(paths.port)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${readToken(paths.tokenPath)}`,
      "x-turnlane-client": "cli",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: res.ok, status: res.status, data: data as T };
}
