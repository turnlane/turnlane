/**
 * 別のプロセスでデーモンを起動する（startup-health.test.ts）。health の応答の速さを、デーモンと同じイベントループに
 * 居ないクライアントから測るため。引数は一時 HOME。起動したら {url, token} を 1 行で出し、SIGTERM で止まる
 */
import { nullLogger } from "@turnlane/collectors";
import { resolvePaths } from "@turnlane/core";
import { startDaemon } from "../../src/main.ts";

const home = process.argv[2];
if (!home) throw new Error("usage: serve-daemon.ts <home>");
const d = await startDaemon({
  paths: resolvePaths({ HOME: home }, home),
  logger: nullLogger,
  port: 0,
  onboarding: { assumeDone: true },
  ingest: { noWatch: true },
  calendar: false,
  summary: false,
});
process.stdout.write(`${JSON.stringify({ url: d.url, token: d.token })}\n`);
process.on("SIGTERM", () => {
  void d.stop().then(() => process.exit(0));
});
