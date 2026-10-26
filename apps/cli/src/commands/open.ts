/**
 * turnlane open [board|day|queue] [--browser]（phase0-plan 3.4、3.6、desktop-shell.md 4.3）。
 * 1. ~/Applications/Turnlane.app があり、アプリがデーモンにつながっていれば POST /api/desktop/open で画面を移す
 * 2. アプリはあるが起動していなければ、アプリを起動する（--path /<view>）
 * 3. アプリが無い、または --browser なら、認証付きの URL（GET /auth?t=<token>&next=/<view>）をブラウザで開く
 */
import { existsSync } from "node:fs";
import { baseUrl, readToken } from "@turnlane/core";
import { callApi, daemonHealth } from "../client.ts";
import type { CliEnv } from "../env.ts";
import { notRunning, tr } from "../lang.ts";
import { desktopAppPath } from "./desktop.ts";

const VIEWS = ["board", "day", "queue"] as const;

export function authUrl(port: number, token: string, view?: string): string {
  const next = view ? `/${view}` : "/";
  return `${baseUrl(port)}/auth?t=${token}&next=${encodeURIComponent(next)}`;
}

export async function openCommand(
  env: CliEnv,
  view: string | undefined,
  opts: { print?: boolean; browser?: boolean } = {},
): Promise<number> {
  if (view && !(VIEWS as readonly string[]).includes(view)) {
    env.err(
      tr(
        `Unknown view: ${view} (${VIEWS.join(" / ")})`,
        `不明な画面: ${view}（${VIEWS.join(" / ")}）`,
      ),
    );
    return 2;
  }
  const h = await daemonHealth(env);
  if (!h) {
    env.err(notRunning());
    return 1;
  }
  const app = desktopAppPath(env);
  if (!opts.print && !opts.browser && existsSync(app)) {
    const path = view ? `/${view}` : "/board";
    const r = await callApi<{ delivered: boolean }>(env.paths, "POST", "/api/desktop/open", {
      path,
    });
    if (r.ok && r.data.delivered) return 0;
    const p = Bun.spawnSync(["/usr/bin/open", "-a", app, "--args", "--path", path], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if (p.exitCode === 0) return 0;
    env.err(
      tr(
        `Could not launch the app (opening in the browser): ${p.stderr.toString().trim()}`,
        `アプリを起動できませんでした（ブラウザで開きます）: ${p.stderr.toString().trim()}`,
      ),
    );
  }
  const url = authUrl(env.paths.port, readToken(env.paths.tokenPath), view);
  if (opts.print) {
    env.out(url);
    return 0;
  }
  const p = Bun.spawnSync(["/usr/bin/open", url], { stdout: "ignore", stderr: "pipe" });
  if (p.exitCode !== 0) {
    env.err(
      tr(
        `Could not open the browser: ${p.stderr.toString().trim()}`,
        `ブラウザを開けませんでした: ${p.stderr.toString().trim()}`,
      ),
    );
    return 1;
  }
  return 0;
}
