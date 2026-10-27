// turnlaned のエントリ（開発時は `bun apps/daemon/src/bin.ts`）。
// 単一バイナリでは scripts/build.ts が生成するエントリから runDaemon() を呼び、埋め込んだ Web 資産を渡す。

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorFields } from "@turnlane/collectors";
import {
  BUNDLE_LOGIN_ITEMS,
  CALENDAR_HELPER_APP,
  detectInstall,
  isUpdateFeedOverridden,
  resolvePaths,
  resolveUpdateFeed,
  VERSION,
} from "@turnlane/core";
import { cliCalendarConnect, openSystemSettings } from "./calendar/connect.ts";
import { systemPower } from "./ext/power.ts";
import type { DaemonExtensionFactory } from "./ext/types.ts";
import { SystemGh } from "./github/pr-poller.ts";
import { assetsFromDir, type StaticAssets } from "./http/static.ts";
import { runAppSetup } from "./install/index.ts";
import { openDesktopInBackground } from "./install/relaunch.ts";
import { FileLogger } from "./log.ts";
import { startDaemon } from "./main.ts";
import { SYSTEM_SETTINGS_URL } from "./onboarding/service.ts";
import { SystemPresenceReader } from "./presence/reader.ts";

function cliBesideDaemon(): string {
  const p = join(dirname(process.execPath), "turnlane");
  return existsSync(p) ? p : "turnlane";
}

/**
 * extensions は組み込む拡張（ADR 0015）。単一バイナリでは scripts/build.ts の生成するエントリが .build/extensions.gen.ts の
 * 一覧を渡す（公開のビルドでは空）。bun で直接動かすとき（開発中）は拡張なし
 */
export async function runDaemon(
  argv: string[],
  embedded?: StaticAssets,
  extensions: readonly DaemonExtensionFactory[] = [],
): Promise<void> {
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(`turnlaned ${VERSION}`);
    return;
  }
  const paths = resolvePaths();
  const logger = new FileLogger({
    path: paths.logPath,
    echo: argv.includes("--foreground") || process.stderr.isTTY === true,
  });
  // 配置の方式（M6-15）: Turnlane.app/Contents/Helpers/turnlaned として動いていれば app
  const install = detectInstall(process.execPath);
  const bundledHelper = install.appPath
    ? join(install.appPath, BUNDLE_LOGIN_ITEMS, CALENDAR_HELPER_APP)
    : null;
  let assets = embedded;
  if (!assets) {
    const dev = join(import.meta.dir, "../../web/dist");
    if (existsSync(dev)) assets = await assetsFromDir(dev);
  }
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    daemon = await startDaemon({
      paths,
      logger,
      assets,
      ingest: { vars: process.env, gh: new SystemGh() },
      presence: { reader: new SystemPresenceReader() },
      // 端末に入力する turnlane: turnlaned と同じ場所（~/.local/bin か Turnlane.app/Contents/Helpers）の turnlane。開発中（bun 実行）は PATH の turnlane
      launch: { cliPath: cliBesideDaemon() },
      // オンボーディング O4: 同梱の turnlane で calendar install → authorize（M6-14 の desktop_setup までの経路）
      calendar: {
        connect: cliCalendarConnect({
          cli: cliBesideDaemon(),
          logger,
          bundledHelper,
          // 許可の後に常駐のヘルパがフルアクセスでつながったか（daemon は下で決まる）
          helperReady: () => {
            const s = daemon?.calendar?.service.status();
            return s?.connected === true && s.authorization === "fullAccess";
          },
          // 配布版: アプリの --setup reregister calendarHelper（解除で launchd が古いほうを止め、登録で起こす）
          restartHelper: install.appPath
            ? () => runAppSetup(install.appPath as string, ["reregister", "calendarHelper"])
            : undefined,
        }),
      },
      openSettings: (pane) => openSystemSettings(SYSTEM_SETTINGS_URL[pane]),
      extensions,
      power: systemPower,
      // 更新確認（M6-12）: ビルドの確認先。TURNLANE_UPDATE_FEED_URL はループバックだけ（スモーク）
      update: {
        feedUrl: resolveUpdateFeed(process.env),
        feedOverridden: isUpdateFeedOverridden(process.env),
      },
      // 更新の後のアプリの起こし直し（M6-17）は配布版（mode が app）だけ InstallService が行う
      install: { ...install, pathVar: process.env.PATH, openDesktop: openDesktopInBackground },
    });
  } catch (e) {
    logger.error("daemon.start_failed", errorFields(e, { includeMessage: true }));
    process.exit(1);
  }
  const shutdown = async (signal: string) => {
    logger.info("daemon.signal", { signal: signal === "SIGTERM" ? 15 : 2 });
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

if (import.meta.main) {
  await runDaemon(process.argv.slice(2));
}
